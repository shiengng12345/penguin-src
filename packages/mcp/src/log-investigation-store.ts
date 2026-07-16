import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { InvestigationContinuation, InvestigationSessionState, InvestigationStateStore } from "./log-investigation-contract.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(state: InvestigationSessionState): string {
  return createHash("sha256").update(canonical(state)).digest("hex");
}

export class FileInvestigationStateStore implements InvestigationStateStore {
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  constructor(private readonly rootDir: string, options: { ttlMs?: number; maxBytes?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }
  private path(sessionId: string): string { return join(this.rootDir, `${sessionId}.json`); }
  private write(state: InvestigationSessionState): InvestigationContinuation {
    const stateHash = hash(state);
    const continuation: InvestigationContinuation = {
      version: 1, sessionId: state.sessionId, stateHash,
      pendingStepIds: state.targets.flatMap((target) => target.pendingStepIds),
      startedAt: state.startedAt, deadlineAt: state.deadlineAt,
    };
    const envelope = JSON.stringify({ state, stateHash, continuation });
    if (Buffer.byteLength(envelope) > this.maxBytes) throw new Error("investigation state exceeds maxBytes");
    const destination = this.path(state.sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, envelope, { mode: 0o600 });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    return continuation;
  }
  create(input: Omit<InvestigationSessionState, "sessionId" | "updatedAt">): InvestigationContinuation {
    const state = { ...input, version: 1 as const, sessionId: randomUUID(), updatedAt: new Date().toISOString() };
    return this.write(state);
  }
  load(continuation: InvestigationContinuation): InvestigationSessionState {
    if (continuation.version !== 1) throw new Error("unsupported investigation continuation version");
    const path = this.path(continuation.sessionId);
    if (!existsSync(path)) throw new Error("investigation state not found");
    if (statSync(path).size > this.maxBytes) throw new Error("investigation state exceeds maxBytes");
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { state: InvestigationSessionState; stateHash: string; continuation: InvestigationContinuation };
    const now = Date.now();
    if (Date.parse(envelope.state.deadlineAt) < now) throw new Error("investigation state expired");
    if (envelope.stateHash !== continuation.stateHash || hash(envelope.state) !== envelope.stateHash) throw new Error("investigation state hash/integrity mismatch");
    return envelope.state;
  }
  save(state: InvestigationSessionState): InvestigationContinuation {
    return this.write({ ...state, updatedAt: new Date().toISOString() });
  }
  remove(sessionId: string): void { rmSync(this.path(sessionId), { force: true }); }
  pruneExpired(now: Date): string[] {
    const removed: string[] = [];
    if (!existsSync(this.rootDir)) return removed;
    for (const file of readdirSync(this.rootDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const state = JSON.parse(readFileSync(join(this.rootDir, file), "utf8")) as { state: InvestigationSessionState };
        if (Date.parse(state.state.deadlineAt) < now.getTime()) { rmSync(join(this.rootDir, file), { force: true }); removed.push(file.slice(0, -5)); }
      } catch { rmSync(join(this.rootDir, file), { force: true }); }
    }
    return removed;
  }
}
