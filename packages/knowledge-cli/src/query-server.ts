import { createInterface } from "node:readline";
import { CAPABILITIES, capabilityHash, type SearchResponse } from "@penguin/knowledge-contracts";
import { searchKnowledge, getSourceHit, compactIndexStatus, buildStatusPanel, resolveRevisionContext, SCHEMA_VERSION } from "@penguin/knowledge-core";
import { runCli, type CliDeps } from "./index.js";
import { dispatchQueryFrame, encodeFrame, parseFrame, queryHello } from "./query-protocol.js";

/** Reads may overlap; mutations are chained in manifest order. */
export class QueryExecutionQueue {
  private mutationTail: Promise<void> = Promise.resolve();

  run<T>(mutating: boolean, task: () => Promise<T>): Promise<T> {
    if (!mutating) return task();
    const next = this.mutationTail.then(task);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

/** Resident-only caches. The capability registry is immutable for the process;
 * prepared statements and FTS rows live until an explicit mutation invalidates
 * them, so idle runtime does not poll SQLite just to detect drift. */
export class QueryServerCaches {
  readonly capabilityRegistry = Object.freeze(CAPABILITIES.map((capability) => ({ ...capability })));
  private readonly prepared = new Map<string, ReturnType<any>>();
  private invalidationEpoch = 0;
  constructor(private readonly store: { db: any; invalidateQueryCaches(): void }) {}
  prepare(sql: string): any { const cached = this.prepared.get(sql); if (cached) return cached; const statement = this.store.db.prepare(sql); this.prepared.set(sql, statement); return statement; }
  invalidate(): void { this.invalidationEpoch += 1; this.store.invalidateQueryCaches(); }
  stats(): { preparedStatements: number; invalidationEpoch: number; fts: { entries: number; hits: number; misses: number } } { return { preparedStatements: this.prepared.size, invalidationEpoch: this.invalidationEpoch, fts: this.store.db && typeof this.store.db === "object" && typeof (this.store as any).queryCacheStats === "function" ? (this.store as any).queryCacheStats() : { entries: 0, hits: 0, misses: 0 } }; }
}

export async function runQueryServer(deps: CliDeps, input = process.stdin, output = process.stdout): Promise<number> {
  if (!deps.storeExists()) { output.write(encodeFrame({ type: "hello", protocolVersion: 1, capabilityHash: capabilityHash(CAPABILITIES), schemaVersion: SCHEMA_VERSION })); return 3; }
  const store = deps.openStore();
  const cancelled = new Set<string>();
  const active = new Map<string, AbortController>();
  const executionQueue = new QueryExecutionQueue();
  const caches = new QueryServerCaches(store);
  caches.prepare("SELECT 1");
  output.write(encodeFrame(queryHello(SCHEMA_VERSION)));
  const rl = createInterface({ input });
  const tasks: Promise<void>[] = [];
  let framingErrors = 0;
  let framingCorruption = false;
  const invoke = async (capabilityId: string, value: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (capabilityId === "knowledge.capabilities") return { schemaVersion: "1", capabilityHash: capabilityHash(CAPABILITIES), capabilities: caches.capabilityRegistry };
    if (capabilityId === "knowledge.index_status") return compactIndexStatus(store);
    if (capabilityId === "knowledge.status_panel") return buildStatusPanel(store);
    if (capabilityId === "knowledge.get_hit") {
      const request = value as { snapshotId: string; filePath: string; repoId?: string; startLine?: number; endLine?: number; startByte?: number; contextLines?: number };
      if (!request.snapshotId || !request.filePath) throw Object.assign(new Error("HIT_LOCATOR_REQUIRED"), { code: "HIT_LOCATOR_REQUIRED" });
      return getSourceHit(store, { snapshotId: request.snapshotId, filePath: request.filePath, ...(request.repoId ? { repoId: request.repoId } : {}), ...(Number.isInteger(request.startLine) ? { startLine: request.startLine } : {}), ...(Number.isInteger(request.endLine) ? { endLine: request.endLine } : {}), ...(Number.isInteger(request.startByte) ? { startByte: request.startByte } : {}), ...(Number.isInteger(request.contextLines) ? { contextLines: request.contextLines } : {}) });
    }
    if (capabilityId === "knowledge.search") {
      const request = value as { scope?: { revisions?: Array<{ repoId?: string; repoName?: string; branch?: string; snapshotId?: string }> } };
      const requested = request.scope?.revisions ?? [];
      const scopes: Array<{ repoId?: string; repoName?: string; branch?: string; snapshotId: string }> = [];
      const scopeWarnings: Array<{ code: string; message: string }> = [];
      for (const rev of requested) {
        // A caller-supplied snapshotId is an explicit override -- pass the
        // entry through as-is (preserving any other fields it carried)
        // rather than reconstructing a stripped-down {repoId, snapshotId}.
        if (typeof rev.snapshotId === "string") { scopes.push({ ...rev, snapshotId: rev.snapshotId }); continue; }
        const repoRow = rev.repoId ?? rev.repoName
          ? (store.db.prepare("SELECT id FROM repos WHERE id=? OR name=? LIMIT 1").get(rev.repoId ?? rev.repoName, rev.repoName ?? rev.repoId) as { id: string } | undefined)
          : undefined;
        if (!repoRow) { scopeWarnings.push({ code: "SCOPE_UNRESOLVED", message: `scope entry did not match a repo: ${JSON.stringify(rev)}` }); continue; }
        const resolution = resolveRevisionContext(store, { repoId: repoRow.id, ...(rev.branch ? { branch: rev.branch } : {}) });
        if (resolution.status !== "resolved") { scopeWarnings.push({ code: "SCOPE_UNRESOLVED", message: resolution.reason }); continue; }
        // resolveRevisionContext's branch/live-fallback paths always mint a
        // `legacy:<branchId>` snapshotId (revision.ts contextOf() never reads
        // current_snapshot_id). search-engine's own scope machinery
        // (scopeRows()/revisionContext() in search-engine.ts) prefers the
        // branch's real revision_snapshots id whenever one exists, falling
        // back to the legacy form only when current_snapshot_id is still
        // null. Re-derive here so a branch that has been promoted to a real
        // snapshot is scoped to it, not silently downgraded to the legacy
        // branch-id form that source/path lane lookups can't resolve.
        const branchRow = resolution.context.branchId
          ? (store.db.prepare("SELECT current_snapshot_id AS currentSnapshotId FROM branches WHERE id=?").get(resolution.context.branchId) as { currentSnapshotId: string | null } | undefined)
          : undefined;
        scopes.push({ repoId: repoRow.id, snapshotId: branchRow?.currentSnapshotId ?? resolution.context.snapshotId });
      }
      // searchKnowledge re-derives its own scope filter from
      // request.scope.revisions on top of whatever `scopes` we pass as
      // context.scopes (see search-engine.ts): its repoName check
      // short-circuits before ever consulting branch, and its branch check
      // requires exact current_snapshot_id equality that a resolved `legacy:`
      // snapshotId cannot satisfy. Rewriting the outgoing revisions to plain
      // resolved snapshotId entries keeps that inner filter exact. Dropping
      // unresolved entries here (rather than forwarding them unresolved)
      // means a wholly-unresolvable request degrades to the default scope
      // with a warning instead of tripping searchKnowledge's own
      // REPOSITORY_NOT_FOUND error.
      const { revisions: _rawRevisions, ...restScope } = (request.scope ?? {}) as Record<string, unknown>;
      const requestForSearch = requested.length
        ? { ...(value as Record<string, unknown>), scope: scopes.length ? { ...restScope, revisions: scopes } : restScope }
        : value;
      const response = searchKnowledge(requestForSearch as never, { store, ...(scopes.length ? { scopes } : {}), signal }) as SearchResponse;
      return scopeWarnings.length
        ? { ...response, diagnostics: { ...response.diagnostics, warnings: [...response.diagnostics.warnings, ...scopeWarnings] } }
        : response;
    }
    // Compatibility bridge for the existing Tauri query surface. It keeps the
    // CLI parser/core implementation as the semantic authority while avoiding
    // a new Node process for every callers/context/graph/note request. The
    // client-side migration to typed capability inputs can remove this bridge
    // once every UI wrapper uses the canonical request object.
    if (capabilityId === "knowledge.cli") {
      const rawArgs = Array.isArray(value) ? value.map(String) : (value && typeof value === "object" && Array.isArray((value as { args?: unknown }).args) ? (value as { args: unknown[] }).args.map(String) : []);
      if (rawArgs.length === 0) throw Object.assign(new Error("CLI_COMPAT_ARGS_REQUIRED"), { code: "CLI_COMPAT_ARGS_REQUIRED" });
      const args = rawArgs.filter((arg) => !arg.startsWith("--request-id="));
      if (!args.includes("--json")) args.push("--json");
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
      const lines: string[] = [];
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
        let parsed: { scopeError?: { code: string; message: string; candidates?: unknown } } | undefined;
        for (let i = lines.length - 1; i >= 0 && !parsed; i -= 1) {
          try { const candidate = JSON.parse(lines[i]); if (candidate && typeof candidate === "object" && "scopeError" in candidate) parsed = candidate; } catch { /* not JSON, keep scanning */ }
        }
        const scopeError = parsed?.scopeError;
        if (scopeError) {
          const payload = { code: scopeError.code, message: scopeError.message, candidates: scopeError.candidates ?? [] };
          throw Object.assign(new Error(JSON.stringify(payload)), { code: scopeError.code });
        }
        throw Object.assign(new Error(lines.at(-1) ?? "CLI_EXIT_4"), { code: "CLI_EXIT_4" });
      }
      if (exitCode !== 0) throw Object.assign(new Error(lines.at(-1) ?? `CLI_EXIT_${exitCode}`), { code: `CLI_EXIT_${exitCode}` });
      const result = lines.at(-1) ?? "null";
      try { return JSON.parse(result); } catch { return result; }
    }
    throw Object.assign(new Error(`${capabilityId} is not implemented by query runtime`), { code: "CAPABILITY_NOT_IMPLEMENTED" });
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    let frame;
    try {
      frame = parseFrame(line);
      framingErrors = 0;
    } catch (error) {
      framingErrors += 1;
      output.write(encodeFrame({ type: "response", id: "unknown", ok: false, error: { code: String((error as Error).message) === "PROTOCOL_MAJOR_MISMATCH" ? "PROTOCOL_MAJOR_MISMATCH" : "MALFORMED_FRAME", message: String((error as Error).message) } }));
      if (framingErrors >= 3) { framingCorruption = true; break; }
      continue;
    }
    const capability = frame.type === "request" ? CAPABILITIES.find((candidate) => candidate.id === frame.capabilityId) : undefined;
    const task = frame.type === "request"
      ? executionQueue.run(capability?.mutating ?? true, async () => { const response = await dispatchQueryFrame(frame, invoke, cancelled, active); if (capability?.mutating) caches.invalidate(); return response; })
      : dispatchQueryFrame(frame, invoke, cancelled, active);
    tasks.push(task.then((response) => { if (response) output.write(encodeFrame(response)); }));
  }
  await Promise.all(tasks);
  store.close();
  return framingCorruption ? 1 : 0;
}
