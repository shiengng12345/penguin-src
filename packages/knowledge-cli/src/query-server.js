import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { CAPABILITIES, capabilityHash } from "@penguin/knowledge-contracts";
import { getSourceHit, compactIndexStatus, buildStatusPanel, SCHEMA_VERSION } from "@penguin/knowledge-core";
import { runCli } from "./index.js";
import { dispatchQueryFrame, encodeFrame, parseFrame, queryHello } from "./query-protocol.js";
function queryRuntimeError(code, message) {
    return Object.assign(new Error(message), { code });
}
/**
 * Bounded pool for synchronous SQLite search work. Each worker owns an
 * independent read connection, so a stuck sqlite3_step cannot block the
 * resident protocol/event loop. Timeout/cancel terminates that worker, which
 * is SQLite's reliable cross-thread interrupt boundary for better-sqlite3.
 */
export class QueryWorkerPool {
    options;
    slots;
    queue = [];
    retiringWorkers = new Set();
    maxQueue;
    defaultTimeoutMs;
    closing = false;
    logSlowOrStopped(job, outcome, result) {
        const elapsedMs = performance.now() - job.startedAt;
        const slowThresholdMs = boundedInteger(process.env.PENGUIN_QUERY_SLOW_MS, 1_000, 1, 120_000);
        if (elapsedMs < slowThresholdMs && outcome === "ok")
            return;
        const cpu = process.cpuUsage(job.startedCpu);
        const response = result && typeof result === "object" ? result : undefined;
        process.stderr.write(`${JSON.stringify({
            event: "penguin_slow_query",
            queryId: job.id,
            capabilityId: job.capabilityId,
            outcome,
            elapsedMs: Math.round(elapsedMs * 1000) / 1000,
            cpuMs: Math.round((cpu.user + cpu.system) / 1000),
            resolvedRepoCount: response?.diagnostics?.resolvedScopes?.length ?? null,
            candidateCount: response?.diagnostics?.candidateCount ?? null,
        })}\n`);
    }
    constructor(options) {
        this.options = options;
        const configuredSize = Number(options.size);
        const configuredQueue = Number(options.maxQueue);
        const configuredTimeout = Number(options.timeoutMs);
        const size = Number.isFinite(configuredSize)
            ? Math.max(1, Math.min(4, Math.floor(configuredSize)))
            : 2;
        this.maxQueue = Number.isFinite(configuredQueue)
            ? Math.max(0, Math.min(128, Math.floor(configuredQueue)))
            : 16;
        this.defaultTimeoutMs = Number.isFinite(configuredTimeout)
            ? Math.max(1, Math.floor(configuredTimeout))
            : 15_000;
        this.slots = Array.from({ length: size }, () => ({ worker: this.createWorker() }));
        for (const slot of this.slots)
            this.attach(slot);
    }
    createWorker() {
        const worker = new Worker(this.options.workerUrl ?? new URL("./query-worker.js", import.meta.url), {
            workerData: { dbPath: this.options.dbPath, ledgerPath: this.options.ledgerPath },
        });
        worker.unref();
        return worker;
    }
    attach(slot) {
        const worker = slot.worker;
        worker.on("message", (message) => {
            if (slot.worker !== worker || message.type !== "result")
                return;
            const job = slot.current;
            if (!job || job.id !== message.id)
                return;
            slot.current = undefined;
            if (message.ok) {
                this.logSlowOrStopped(job, "ok", message.result);
                this.settle(job, true, message.result);
            }
            else {
                this.logSlowOrStopped(job, message.error?.code ?? "error");
                this.settle(job, false, queryRuntimeError(message.error?.code ?? "INTERNAL", message.error?.message ?? "query worker failed"));
            }
            this.drain();
        });
        worker.on("error", (error) => {
            if (slot.worker !== worker || this.closing)
                return;
            const job = slot.current;
            slot.current = undefined;
            if (job)
                this.settle(job, false, queryRuntimeError("QUERY_WORKER_CRASH", error.message));
            this.replace(slot);
            this.drain();
        });
        worker.on("exit", (code) => {
            if (slot.worker !== worker || this.closing)
                return;
            const job = slot.current;
            slot.current = undefined;
            if (job)
                this.settle(job, false, queryRuntimeError("QUERY_WORKER_CRASH", `query worker exited with code ${code}`));
            this.replace(slot);
            this.drain();
        });
    }
    replace(slot) {
        const previous = slot.worker;
        const replacement = this.createWorker();
        slot.worker = replacement;
        slot.current = undefined;
        this.attach(slot);
        this.retire(previous);
    }
    retire(worker) {
        let tracked;
        tracked = worker.terminate()
            // Termination is cleanup; a failed termination must not become an
            // unhandled rejection, while close() still waits for it to settle.
            .catch(() => -1)
            .finally(() => this.retiringWorkers.delete(tracked));
        this.retiringWorkers.add(tracked);
        return tracked;
    }
    settle(job, ok, value) {
        if (job.settled)
            return;
        job.settled = true;
        clearTimeout(job.timer);
        if (job.signal && job.abortListener) {
            job.signal.removeEventListener("abort", job.abortListener);
        }
        if (ok)
            job.resolve(value);
        else
            job.reject(value);
    }
    stop(job, code) {
        if (job.settled)
            return;
        const queued = this.queue.indexOf(job);
        if (queued >= 0)
            this.queue.splice(queued, 1);
        const activeSlot = this.slots.find((slot) => slot.current === job);
        if (activeSlot)
            this.replace(activeSlot);
        this.logSlowOrStopped(job, code);
        this.settle(job, false, queryRuntimeError(code, code === "CANCELLED" ? "query was cancelled" : "query exceeded the hard timeout"));
        this.drain();
    }
    drain() {
        if (this.closing)
            return;
        for (const slot of this.slots) {
            if (slot.current)
                continue;
            const job = this.queue.shift();
            if (!job)
                break;
            if (job.settled)
                continue;
            slot.current = job;
            slot.worker.postMessage({
                type: "run",
                id: job.id,
                capabilityId: job.capabilityId,
                input: job.input,
            });
        }
    }
    run(capabilityId, input, signal, timeoutMs = this.defaultTimeoutMs) {
        if (this.closing)
            return Promise.reject(queryRuntimeError("QUERY_RUNTIME_CLOSED", "query worker pool is closed"));
        if (signal?.aborted)
            return Promise.reject(queryRuntimeError("CANCELLED", "query was cancelled"));
        const hasIdle = this.slots.some((slot) => !slot.current);
        if (!hasIdle && this.queue.length >= this.maxQueue) {
            return Promise.reject(queryRuntimeError("QUERY_BUSY", "query worker queue is full"));
        }
        return new Promise((resolve, reject) => {
            const job = {
                id: `query_${randomUUID()}`,
                capabilityId,
                input,
                resolve,
                reject,
                timer: undefined,
                signal,
                settled: false,
                startedAt: performance.now(),
                startedCpu: process.cpuUsage(),
            };
            job.timer = setTimeout(() => this.stop(job, "QUERY_TIMEOUT"), Math.max(1, timeoutMs));
            if (signal) {
                job.abortListener = () => this.stop(job, "CANCELLED");
                signal.addEventListener("abort", job.abortListener, { once: true });
            }
            this.queue.push(job);
            this.drain();
        });
    }
    async close() {
        if (this.closing)
            return;
        this.closing = true;
        for (const job of this.queue.splice(0)) {
            this.settle(job, false, queryRuntimeError("QUERY_RUNTIME_CLOSED", "query worker pool is closed"));
        }
        for (const slot of this.slots) {
            if (slot.current) {
                this.settle(slot.current, false, queryRuntimeError("QUERY_RUNTIME_CLOSED", "query worker pool is closed"));
                slot.current = undefined;
            }
        }
        const terminating = [
            ...this.retiringWorkers,
            ...this.slots.map((slot) => this.retire(slot.worker)),
        ];
        await Promise.all(terminating);
    }
}
function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
/** Reads may overlap; mutations are chained in manifest order. */
export class QueryExecutionQueue {
    mutationTail = Promise.resolve();
    run(mutating, task) {
        if (!mutating)
            return task();
        const next = this.mutationTail.then(task);
        this.mutationTail = next.then(() => undefined, () => undefined);
        return next;
    }
}
/** Resident-only caches. The capability registry is immutable for the process;
 * prepared statements and FTS rows live until an explicit mutation invalidates
 * them, so idle runtime does not poll SQLite just to detect drift. */
export class QueryServerCaches {
    store;
    capabilityRegistry = Object.freeze(CAPABILITIES.map((capability) => ({ ...capability })));
    prepared = new Map();
    invalidationEpoch = 0;
    constructor(store) {
        this.store = store;
    }
    prepare(sql) { const cached = this.prepared.get(sql); if (cached)
        return cached; const statement = this.store.db.prepare(sql); this.prepared.set(sql, statement); return statement; }
    invalidate() { this.invalidationEpoch += 1; this.store.invalidateQueryCaches(); }
    stats() { return { preparedStatements: this.prepared.size, invalidationEpoch: this.invalidationEpoch, fts: this.store.db && typeof this.store.db === "object" && typeof this.store.queryCacheStats === "function" ? this.store.queryCacheStats() : { entries: 0, hits: 0, misses: 0 } }; }
}
export async function runQueryServer(deps, input = process.stdin, output = process.stdout) {
    if (!deps.storeExists()) {
        output.write(encodeFrame({ type: "hello", protocolVersion: 1, capabilityHash: capabilityHash(CAPABILITIES), schemaVersion: SCHEMA_VERSION }));
        return 3;
    }
    // The resident query-server is long-lived: opening it with default
    // (mutation-allowed) semantics meant merely launching the app/MCP silently
    // ran DDL/migrations against the on-disk DB the instant this process
    // started, even though every other read path (CLI READ_VERBS,
    // command-dispatch.ts) refuses to migrate (Phase 1A). Gate it the same way
    // here: allowSchemaMutation:false only blocks the DDL/migration branch in
    // openDatabase() (schema.ts) -- reads AND writes on an already-current
    // schema still work unmodified, so this doesn't take away any capability
    // the resident server actually needs; it only refuses to silently upgrade
    // a stale on-disk schema out from under a caller that never asked for a
    // migration. A SCHEMA_OUTDATED open failure can't use the normal
    // request/response frame (nothing has subscribed to a request id yet --
    // the process hasn't even sent its hello), so it's reported via a
    // hello-shaped error frame the Rust bridge's handshake validator
    // (src-tauri/src/knowledge.rs's validate_runtime_hello) recognizes and
    // forwards distinguishably instead of a generic capability-mismatch error.
    let store;
    try {
        store = deps.openStore({ allowSchemaMutation: false });
    }
    catch (error) {
        if (error instanceof Error && error.code === "SCHEMA_OUTDATED") {
            output.write(encodeFrame({ type: "hello", error: { code: "SCHEMA_OUTDATED", message: error.message } }));
            return 3;
        }
        throw error;
    }
    const cancelled = new Set();
    const active = new Map();
    const executionQueue = new QueryExecutionQueue();
    const caches = new QueryServerCaches(store);
    const queryWorkers = new QueryWorkerPool({
        dbPath: store.db.name,
        ledgerPath: store.ledgerPath,
        size: boundedInteger(process.env.PENGUIN_QUERY_WORKERS, 2, 1, 4),
        maxQueue: boundedInteger(process.env.PENGUIN_QUERY_MAX_QUEUE, 16, 0, 128),
        timeoutMs: boundedInteger(process.env.PENGUIN_QUERY_TIMEOUT_MS, 15_000, 1, 120_000),
    });
    caches.prepare("SELECT 1");
    output.write(encodeFrame(queryHello(SCHEMA_VERSION)));
    const rl = createInterface({ input });
    const tasks = [];
    let framingErrors = 0;
    let framingCorruption = false;
    const invoke = async (capabilityId, value, signal) => {
        if (capabilityId === "knowledge.capabilities")
            return { schemaVersion: "1", capabilityHash: capabilityHash(CAPABILITIES), capabilities: caches.capabilityRegistry };
        if (capabilityId === "knowledge.index_status")
            return compactIndexStatus(store);
        if (capabilityId === "knowledge.status_panel")
            return buildStatusPanel(store);
        if (capabilityId === "knowledge.get_hit") {
            const request = value;
            if (!request.snapshotId || !request.filePath)
                throw Object.assign(new Error("HIT_LOCATOR_REQUIRED"), { code: "HIT_LOCATOR_REQUIRED" });
            return getSourceHit(store, { snapshotId: request.snapshotId, filePath: request.filePath, ...(request.repoId ? { repoId: request.repoId } : {}), ...(Number.isInteger(request.startLine) ? { startLine: request.startLine } : {}), ...(Number.isInteger(request.endLine) ? { endLine: request.endLine } : {}), ...(Number.isInteger(request.startByte) ? { startByte: request.startByte } : {}), ...(Number.isInteger(request.contextLines) ? { contextLines: request.contextLines } : {}) });
        }
        if (capabilityId === "knowledge.search") {
            return queryWorkers.run("knowledge.search", value, signal);
        }
        // Compatibility bridge for the existing Tauri query surface. It keeps the
        // CLI parser/core implementation as the semantic authority while avoiding
        // a new Node process for every callers/context/graph/note request. The
        // client-side migration to typed capability inputs can remove this bridge
        // once every UI wrapper uses the canonical request object.
        if (capabilityId === "knowledge.cli") {
            const rawArgs = Array.isArray(value) ? value.map(String) : (value && typeof value === "object" && Array.isArray(value.args) ? value.args.map(String) : []);
            if (rawArgs.length === 0)
                throw Object.assign(new Error("CLI_COMPAT_ARGS_REQUIRED"), { code: "CLI_COMPAT_ARGS_REQUIRED" });
            const args = rawArgs.filter((arg) => !arg.startsWith("--request-id="));
            if (!args.includes("--json"))
                args.push("--json");
            // The bridge's cwd is the app's launch directory, not a repo checkout —
            // meaningless for git-aware scope inference. A scoped verb still infers
            // repoId from a unique symbol match and then reads real git state at
            // that repo's registered rootPath (Task 6); if the dev has since
            // switched to a branch that isn't indexed yet (an everyday occurrence),
            // that exits 4 (BRANCH_NOT_INDEXED). Phase 1A force-injected
            // --allow-fallback here so the UI (which couldn't render the blocker
            // yet) always got an answer instead of a hard failure. Phase 1B's Wiki
            // can now render a scope blocker, so the injection is gone: a caller
            // that wants the fallback answer must ask for it explicitly via
            // --allow-fallback in `args` (the client does this on the blocker
            // panel's retry). Direct CLI usage is unaffected — it doesn't go
            // through this bridge.
            const lines = [];
            const exitCode = await runCli(args, { ...deps, out: (line) => lines.push(line), err: (line) => lines.push(line) });
            if (exitCode === 4) {
                // reportScopeResolutionError (command-dispatch.ts), in --json mode
                // (forced above), emits exactly one machine-parseable line:
                // `{ scopeError: { code, message, candidates } }`. Parse it into a
                // structured throw instead of the opaque last-stdout-line Error the
                // bridge used to build, so dispatchQueryFrame's catch (which reads
                // `error.code`/`error.message` into the response frame) surfaces
                // BRANCH_NOT_INDEXED/SCOPE_NOT_FOUND with the candidate list intact.
                //
                // The Error's `.message` is set to the JSON-encoded `{ code, message,
                // candidates }` payload itself (not just the prose message) — this
                // duplicates `code` inside the string on purpose. The Tauri Rust
                // bridge (src-tauri/src/knowledge.rs's resident-worker reader thread)
                // only ever forwards the response frame's `error.message` string to
                // the webview — the sibling `error.code` field is dropped in transit
                // — so `code` has to survive inside the text that DOES cross that
                // boundary. The client (knowledge-client.ts's ScopeBlockedError)
                // JSON.parses whatever string it receives (whether from this
                // in-process test harness or from the real Tauri IPC round trip) and
                // reads `code`/`message`/`candidates` back out of it.
                let parsed;
                for (let i = lines.length - 1; i >= 0 && !parsed; i -= 1) {
                    try {
                        const candidate = JSON.parse(lines[i]);
                        if (candidate && typeof candidate === "object" && "scopeError" in candidate)
                            parsed = candidate;
                    }
                    catch { /* not JSON, keep scanning */ }
                }
                const scopeError = parsed?.scopeError;
                if (scopeError) {
                    const payload = { code: scopeError.code, message: scopeError.message, candidates: scopeError.candidates ?? [] };
                    throw Object.assign(new Error(JSON.stringify(payload)), { code: scopeError.code });
                }
                throw Object.assign(new Error(lines.at(-1) ?? "CLI_EXIT_4"), { code: "CLI_EXIT_4" });
            }
            if (exitCode !== 0)
                throw Object.assign(new Error(lines.at(-1) ?? `CLI_EXIT_${exitCode}`), { code: `CLI_EXIT_${exitCode}` });
            const result = lines.at(-1) ?? "null";
            try {
                return JSON.parse(result);
            }
            catch {
                return result;
            }
        }
        throw Object.assign(new Error(`${capabilityId} is not implemented by query runtime`), { code: "CAPABILITY_NOT_IMPLEMENTED" });
    };
    for await (const line of rl) {
        if (!line.trim())
            continue;
        let frame;
        try {
            frame = parseFrame(line);
            framingErrors = 0;
        }
        catch (error) {
            framingErrors += 1;
            output.write(encodeFrame({ type: "response", id: "unknown", ok: false, error: { code: String(error.message) === "PROTOCOL_MAJOR_MISMATCH" ? "PROTOCOL_MAJOR_MISMATCH" : "MALFORMED_FRAME", message: String(error.message) } }));
            if (framingErrors >= 3) {
                framingCorruption = true;
                // Stop retaining the still-open parent stdin pipe. Otherwise the
                // runtime has finished but Node cannot exit until the client closes
                // its side, defeating the corruption self-recovery contract.
                rl.close();
                input.pause();
                break;
            }
            continue;
        }
        const capability = frame.type === "request" ? CAPABILITIES.find((candidate) => candidate.id === frame.capabilityId) : undefined;
        const task = frame.type === "request"
            ? executionQueue.run(capability?.mutating ?? true, async () => { const response = await dispatchQueryFrame(frame, invoke, cancelled, active); if (capability?.mutating)
                caches.invalidate(); return response; })
            : dispatchQueryFrame(frame, invoke, cancelled, active);
        tasks.push(task.then((response) => { if (response)
            output.write(encodeFrame(response)); }));
    }
    await Promise.all(tasks);
    await queryWorkers.close();
    store.close();
    return framingCorruption ? 1 : 0;
}
//# sourceMappingURL=query-server.js.map