import { createInterface } from "node:readline";
import { CAPABILITIES, capabilityHash } from "@penguin/knowledge-contracts";
import { searchKnowledge, getSourceHit, compactIndexStatus, SCHEMA_VERSION } from "@penguin/knowledge-core";
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

export async function runQueryServer(deps: CliDeps, input = process.stdin, output = process.stdout): Promise<number> {
  if (!deps.storeExists()) { output.write(encodeFrame({ type: "hello", protocolVersion: 1, capabilityHash: capabilityHash(CAPABILITIES), schemaVersion: SCHEMA_VERSION })); return 3; }
  const store = deps.openStore();
  const cancelled = new Set<string>();
  const active = new Map<string, AbortController>();
  const executionQueue = new QueryExecutionQueue();
  output.write(encodeFrame(queryHello(SCHEMA_VERSION)));
  const rl = createInterface({ input });
  const tasks: Promise<void>[] = [];
  let framingErrors = 0;
  let framingCorruption = false;
  const invoke = async (capabilityId: string, value: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (capabilityId === "knowledge.capabilities") return { schemaVersion: "1", capabilityHash: capabilityHash(CAPABILITIES), capabilities: CAPABILITIES };
    if (capabilityId === "knowledge.index_status") return compactIndexStatus(store);
    if (capabilityId === "knowledge.get_hit") {
      const request = value as { snapshotId: string; filePath: string; repoId?: string; startLine?: number; endLine?: number; startByte?: number; contextLines?: number };
      if (!request.snapshotId || !request.filePath) throw Object.assign(new Error("HIT_LOCATOR_REQUIRED"), { code: "HIT_LOCATOR_REQUIRED" });
      return getSourceHit(store, { snapshotId: request.snapshotId, filePath: request.filePath, ...(request.repoId ? { repoId: request.repoId } : {}), ...(Number.isInteger(request.startLine) ? { startLine: request.startLine } : {}), ...(Number.isInteger(request.endLine) ? { endLine: request.endLine } : {}), ...(Number.isInteger(request.startByte) ? { startByte: request.startByte } : {}), ...(Number.isInteger(request.contextLines) ? { contextLines: request.contextLines } : {}) });
    }
    if (capabilityId === "knowledge.search") {
      const request = value as { scope?: { revisions?: Array<{ repoId?: string; snapshotId?: string }> } };
      const scopes = request.scope?.revisions?.filter((revision): revision is { repoId?: string; snapshotId: string } => typeof revision.snapshotId === "string")
        .map((revision) => ({ ...(revision.repoId ? { repoId: revision.repoId } : {}), snapshotId: revision.snapshotId }));
      return searchKnowledge(value as never, { store, ...(scopes?.length ? { scopes } : {}), signal });
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
      const lines: string[] = [];
      const exitCode = await runCli(args, { ...deps, out: (line) => lines.push(line), err: (line) => lines.push(line) });
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
      ? executionQueue.run(capability?.mutating ?? true, () => dispatchQueryFrame(frame, invoke, cancelled, active))
      : dispatchQueryFrame(frame, invoke, cancelled, active);
    tasks.push(task.then((response) => { if (response) output.write(encodeFrame(response)); }));
  }
  await Promise.all(tasks);
  store.close();
  return framingCorruption ? 1 : 0;
}
