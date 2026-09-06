import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

import {
  EmbeddingLifecycle,
  openBundledEmbeddingProvider,
  type EmbeddingProvider,
  type KnowledgeStore,
} from "@penguin/knowledge-core";
import { drainSemanticQueue } from "@penguin/knowledge-indexer";
import { runtimeIdentity as inspectRuntimeIdentity } from "./runtime-identity.js";

const WORKER_RUNTIME_META_KEY = "semantic_worker_runtime";
const VERSION_MISMATCH_REMEDIATION = "restart Penguin and the Claude/Codex client so the active versioned runtime is reloaded";
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_HISTORY_COUNT = 3;
const LOG_LOCK_STALE_MS = 30_000;
const LOG_LOCK_ATTEMPTS = 500;
const ABORT_CLEANUP_ATTEMPTS = 16;
const ABORT_CLEANUP_RETRY_MS = 25;
// The stable launcher's verified graceful-cleanup window is 7.5s. Keep every
// SQLite wait short and leave enough margin to exit into dead-owner reclaim.
const ABORT_CLEANUP_BUSY_TIMEOUT_MS = 100;
const ABORT_CLEANUP_DEADLINE_MS = 6_000;

export interface SemanticWorkerLogOptions {
  path: string;
  maxBytes?: number;
  historyCount?: number;
}

interface ResolvedWorkerLogOptions {
  path: string;
  maxBytes: number;
  historyCount: number;
}

function positiveInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function resolveWorkerLogOptions(options?: SemanticWorkerLogOptions): ResolvedWorkerLogOptions | null {
  const path = options?.path ?? process.env.PENGUIN_SEMANTIC_WORKER_LOG_PATH;
  if (!path) return null;
  return {
    path,
    maxBytes: positiveInteger(options?.maxBytes ?? process.env.PENGUIN_SEMANTIC_WORKER_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES, 128, 100 * 1024 * 1024),
    historyCount: positiveInteger(options?.historyCount ?? process.env.PENGUIN_SEMANTIC_WORKER_LOG_HISTORY_COUNT, DEFAULT_LOG_HISTORY_COUNT, 0, 20),
  };
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function waitSynchronously(milliseconds: number): void {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, milliseconds);
}

function withLogLock<T>(options: ResolvedWorkerLogOptions, action: () => T): T {
  mkdirSync(dirname(options.path), { recursive: true });
  const lockPath = `${options.path}.lock`;
  let descriptor: number | null = null;
  for (let attempt = 0; attempt < LOG_LOCK_ATTEMPTS; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOG_LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch (inspectionError) {
        if (errno(inspectionError) !== "ENOENT") throw inspectionError;
      }
      waitSynchronously(2);
    }
  }
  if (descriptor == null) throw new Error("SEMANTIC_WORKER_LOG_LOCK_TIMEOUT");
  try {
    return action();
  } finally {
    try { closeSync(descriptor); } catch { /* descriptor cleanup is best effort */ }
    rmSync(lockPath, { force: true });
  }
}

function safeSize(path: string): number {
  try { return statSync(path).size; }
  catch (error) {
    if (errno(error) === "ENOENT") return 0;
    throw error;
  }
}

function safeRename(source: string, destination: string): void {
  try { renameSync(source, destination); }
  catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHistoryUnlocked(options: ResolvedWorkerLogOptions): void {
  const directory = dirname(options.path);
  const pattern = new RegExp(`^${escapedRegExp(basename(options.path))}\\.(\\d+)$`);
  for (const entry of readdirSync(directory)) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const index = Number(match[1]);
    const path = join(directory, entry);
    if (!Number.isSafeInteger(index) || index < 1 || index > options.historyCount) {
      rmSync(path, { force: true });
      continue;
    }
    if (safeSize(path) > options.maxBytes) truncateSync(path, options.maxBytes);
  }
}

function rotateCurrentLogUnlocked(options: ResolvedWorkerLogOptions): void {
  if (safeSize(options.path) === 0 && !existsSync(options.path)) return;
  if (safeSize(options.path) > options.maxBytes) truncateSync(options.path, options.maxBytes);
  if (options.historyCount === 0) {
    rmSync(options.path, { force: true });
    return;
  }
  rmSync(`${options.path}.${options.historyCount}`, { force: true });
  for (let index = options.historyCount - 1; index >= 1; index -= 1) {
    safeRename(`${options.path}.${index}`, `${options.path}.${index + 1}`);
  }
  safeRename(options.path, `${options.path}.1`);
}

function prepareBoundedLogUnlocked(options: ResolvedWorkerLogOptions): void {
  normalizeHistoryUnlocked(options);
  if (safeSize(options.path) >= options.maxBytes) rotateCurrentLogUnlocked(options);
  normalizeHistoryUnlocked(options);
}

function prepareBoundedLog(options: ResolvedWorkerLogOptions): void {
  withLogLock(options, () => prepareBoundedLogUnlocked(options));
}

function appendBoundedLog(options: ResolvedWorkerLogOptions | null, event: Record<string, unknown>): boolean {
  if (!options) return true;
  try {
    return withLogLock(options, () => {
      prepareBoundedLogUnlocked(options);
      let record = Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      if (record.length > options.maxBytes) {
        record = Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), event: "log_record_truncated", originalBytes: record.length })}\n`);
        if (record.length > options.maxBytes) record = record.subarray(0, options.maxBytes);
      }
      if (safeSize(options.path) + record.length > options.maxBytes) rotateCurrentLogUnlocked(options);
      appendFileSync(options.path, record);
      if (safeSize(options.path) > options.maxBytes) truncateSync(options.path, options.maxBytes);
      normalizeHistoryUnlocked(options);
      return true;
    });
  } catch {
    // Logging is observability only and must never stop semantic progress.
    return false;
  }
}

export function appendSemanticWorkerDiagnostic(options: SemanticWorkerLogOptions, event: Record<string, unknown>): boolean {
  return appendBoundedLog(resolveWorkerLogOptions(options), event);
}

function diagnosticCode(value: unknown, prefix = "WORKER_DIAGNOSTIC"): string | null {
  if (value == null) return null;
  const text = String(value);
  if (/^[A-Z][A-Z0-9_]{2,127}$/.test(text)) return text;
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12).toUpperCase();
  return `${prefix}_${digest}`;
}

export interface SemanticRuntimeIdentity {
  buildId: string;
  capabilityHash: string;
  schemaVersion: number;
  modelHash: string;
}

export interface SemanticWorkerRuntimeState {
  status: SemanticWorkerExit | "running" | "start_failed";
  reason: string | null;
  remediation: string | null;
  identity: SemanticRuntimeIdentity;
  ownerId: string | null;
  ownerPid: number | null;
  ownerProcessIdentity?: ProcessIdentity | null;
  startToken: string | null;
  updatedAt: string;
}

function environmentRuntimeIdentity(buildId?: string): SemanticRuntimeIdentity {
  const schemaVersion = Number(process.env.PENGUIN_SCHEMA_VERSION ?? 18);
  return {
    buildId: buildId ?? process.env.PENGUIN_BUILD_ID ?? "development",
    capabilityHash: process.env.PENGUIN_CAPABILITY_HASH ?? "unknown",
    schemaVersion: Number.isInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 18,
    modelHash: process.env.PENGUIN_MODEL_HASH ?? "unknown",
  };
}

function activeRuntimeIdentity(): SemanticRuntimeIdentity {
  const identity = inspectRuntimeIdentity();
  return {
    buildId: identity.buildId,
    capabilityHash: identity.capabilityHash,
    schemaVersion: identity.schemaVersion,
    modelHash: identity.modelHash,
  };
}

function sameRuntimeIdentity(left: SemanticRuntimeIdentity, right: SemanticRuntimeIdentity): boolean {
  return left.buildId === right.buildId
    && left.capabilityHash === right.capabilityHash
    && left.schemaVersion === right.schemaVersion
    && left.modelHash === right.modelHash;
}

function writeWorkerRuntimeState(store: KnowledgeStore, state: SemanticWorkerRuntimeState): void {
  store.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(WORKER_RUNTIME_META_KEY, JSON.stringify(state));
}

export function readSemanticWorkerRuntimeState(store: KnowledgeStore): SemanticWorkerRuntimeState | null {
  try {
    const row = store.db.prepare("SELECT value FROM meta WHERE key=?").get(WORKER_RUNTIME_META_KEY) as { value: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as SemanticWorkerRuntimeState;
    if (!value || typeof value !== "object" || !value.identity || typeof value.status !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export type SemanticWorkerExit = "drained" | "paused" | "stalled" | "already_running" | "version_mismatch" | "model_unavailable";

export interface SemanticWorkerResult {
  status: SemanticWorkerExit;
  ownerId: string;
  generations: number;
  activated: number;
  readyChunks: number;
  failedChunks: number;
  reason: string | null;
}

export interface RunSemanticWorkerInput {
  store: KnowledgeStore;
  ownerId?: string;
  buildId?: string;
  expectedBuildId?: string;
  runtimeIdentity?: SemanticRuntimeIdentity;
  expectedRuntimeIdentity?: SemanticRuntimeIdentity;
  providerFactory?: () => Promise<EmbeddingProvider>;
  signal?: AbortSignal;
  leaseMs?: number;
  batchSize?: number;
  /** Publish a bounded first searchable lane on clean-install scopes. */
  bootstrapReadyChunks?: number;
  /** Fair scheduler budget; bounded to avoid one scope monopolising the worker. */
  maxBatchesPerRound?: number;
  log?: SemanticWorkerLogOptions;
  /** Internal process wrapper hook; called once the bounded abort cleanup starts. */
  onAbortCleanup?: (cleanup: Promise<boolean>) => void;
  /** Internal maintenance hook used to exercise the final registry cleanup race. */
  onBeforeOwnershipRegistryQuarantine?: (path: string) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}

type WorkerLeaseOwnerStatus = "absent" | "expired" | "live" | "reclaimable" | "unproven" | "reclaimed";

function validPersistedProcessIdentity(value: ProcessIdentity | null | undefined, ownerPid: number): value is ProcessIdentity {
  return Boolean(value
    && value.pid === ownerPid
    && Number.isInteger(value.ppid) && value.ppid >= 0
    && Number.isInteger(value.pgid) && value.pgid > 1
    && typeof value.startIdentity === "string" && value.startIdentity.length > 0);
}

function workerLeaseOwnerStatus(
  store: KnowledgeStore,
  lifecycle: EmbeddingLifecycle,
  now = new Date().toISOString(),
  expectedIdentity?: SemanticRuntimeIdentity,
): WorkerLeaseOwnerStatus {
  const lease = lifecycle.getWorkerLease();
  if (!lease) return "absent";
  if (lease.leaseExpiresAt <= now) return "expired";
  if (!Number.isInteger(lease.ownerPid) || lease.ownerPid <= 1) return "unproven";
  const runtime = readSemanticWorkerRuntimeState(store);
  if (runtime?.status !== "running"
    || runtime.ownerId !== lease.ownerId
    || runtime.ownerPid !== lease.ownerPid
    || lease.buildId !== runtime.identity.buildId
    || (expectedIdentity !== undefined && !sameRuntimeIdentity(runtime.identity, expectedIdentity))
    || !validPersistedProcessIdentity(runtime.ownerProcessIdentity, lease.ownerPid)) return "unproven";
  if (process.platform === "win32") return "unproven";
  let current: ProcessIdentity | undefined;
  try { current = posixProcessSnapshot().get(lease.ownerPid); }
  catch { return "unproven"; }
  if (!current || !currentProcessIdentity(runtime.ownerProcessIdentity)) return "reclaimable";
  return "live";
}

function reclaimDeadWorkerLease(store: KnowledgeStore, lifecycle: EmbeddingLifecycle): WorkerLeaseOwnerStatus {
  const status = workerLeaseOwnerStatus(store, lifecycle);
  if (status !== "reclaimable") return status;
  const lease = lifecycle.getWorkerLease();
  if (!lease) return "absent";
  const reclaimed = store.db.transaction(() => {
    const now = new Date().toISOString();
    const released = store.db.prepare(`
      UPDATE semantic_worker_leases
         SET heartbeat_at=?, lease_expires_at=?
       WHERE lock_name='semantic-drain' AND owner_id=? AND owner_pid=?
         AND heartbeat_at=? AND lease_expires_at=?
    `).run(now, now, lease.ownerId, lease.ownerPid, lease.heartbeatAt, lease.leaseExpiresAt).changes;
    if (released === 0) return false;
    store.db.prepare(`
      UPDATE embedding_jobs
         SET status='pending', attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END,
             error='WORKER_OWNER_DEAD', lease_owner=NULL, lease_expires_at=NULL,
             next_attempt_at=NULL, updated_at=?
       WHERE status='running' AND lease_owner=?
    `).run(now, lease.ownerId);
    return true;
  })();
  return reclaimed ? "reclaimed" : workerLeaseOwnerStatus(store, lifecycle);
}

export async function runSemanticWorker(input: RunSemanticWorkerInput): Promise<SemanticWorkerResult> {
  const ownerId = input.ownerId ?? `semantic-worker:${process.pid}:${randomUUID()}`;
  const log = resolveWorkerLogOptions(input.log);
  const identity = input.runtimeIdentity ?? environmentRuntimeIdentity(input.buildId);
  const expectedIdentity = input.expectedRuntimeIdentity
    ?? (input.expectedBuildId ? { ...identity, buildId: input.expectedBuildId } : identity);
  const startToken = process.env.PENGUIN_WORKER_START_TOKEN ?? null;
  let checkpointFailureCode: "WAL_CHECKPOINT_FAILED" | null = null;
  const persist = (status: SemanticWorkerRuntimeState["status"], reason: string | null, remediation: string | null = null): void => {
    writeWorkerRuntimeState(input.store, {
      status, reason, remediation, identity, ownerId, ownerPid: process.pid, startToken,
      ownerProcessIdentity: process.platform === "win32" ? null : posixProcessSnapshot().get(process.pid) ?? null,
      updatedAt: new Date().toISOString(),
    });
  };
  const result = (status: SemanticWorkerExit, totals = { generations: 0, activated: 0, readyChunks: 0, failedChunks: 0 }, reason: string | null = null): SemanticWorkerResult => {
    const reportedReason = diagnosticCode(reason ?? (status === "drained" ? checkpointFailureCode : null));
    persist(status, reportedReason, status === "version_mismatch" ? VERSION_MISMATCH_REMEDIATION : null);
    removeCurrentWorkerOwnershipRegistry(input.onBeforeOwnershipRegistryQuarantine);
    appendBoundedLog(log, { event: "worker_exit", status, reason: reportedReason, ownerId, ...totals });
    return { status, ownerId, ...totals, reason: reportedReason };
  };
  const resultWithoutPersistence = (
    status: SemanticWorkerExit,
    reason: string | null = null,
  ): SemanticWorkerResult => {
    removeCurrentWorkerOwnershipRegistry(input.onBeforeOwnershipRegistryQuarantine);
    appendBoundedLog(log, {
      event: "worker_exit", status, reason, ownerId,
      generations: 0, activated: 0, readyChunks: 0, failedChunks: 0,
    });
    return { status, ownerId, generations: 0, activated: 0, readyChunks: 0, failedChunks: 0, reason };
  };
  const lifecycle = new EmbeddingLifecycle(input.store);
  if (!sameRuntimeIdentity(identity, expectedIdentity)) {
    const competingOwner = workerLeaseOwnerStatus(input.store, lifecycle, new Date().toISOString(), expectedIdentity);
    if (competingOwner === "live") return resultWithoutPersistence("already_running");

    const persisted = input.store.db.transaction(() => {
      const lease = lifecycle.getWorkerLease();
      if (lease && lease.leaseExpiresAt > new Date().toISOString()) return false;
      persist("version_mismatch", "VERSION_MISMATCH", VERSION_MISMATCH_REMEDIATION);
      return true;
    })();
    if (!persisted) {
      const revalidated = workerLeaseOwnerStatus(input.store, lifecycle, new Date().toISOString(), expectedIdentity);
      if (revalidated === "live") return resultWithoutPersistence("already_running");
      return resultWithoutPersistence("version_mismatch", "VERSION_MISMATCH");
    }
    removeCurrentWorkerOwnershipRegistry(input.onBeforeOwnershipRegistryQuarantine);
    appendBoundedLog(log, {
      event: "worker_exit", status: "version_mismatch", reason: "VERSION_MISMATCH", ownerId,
      generations: 0, activated: 0, readyChunks: 0, failedChunks: 0,
    });
    return {
      status: "version_mismatch", ownerId, generations: 0, activated: 0,
      readyChunks: 0, failedChunks: 0, reason: "VERSION_MISMATCH",
    };
  }
  const leaseMs = input.leaseMs ?? 90_000;
  const initialOwnerStatus = reclaimDeadWorkerLease(input.store, lifecycle);
  if (initialOwnerStatus === "unproven") {
    const reason = "WORKER_OWNER_IDENTITY_UNPROVEN";
    appendBoundedLog(log, { event: "worker_exit", status: "stalled", reason, ownerId, generations: 0, activated: 0, readyChunks: 0, failedChunks: 0 });
    removeCurrentWorkerOwnershipRegistry(input.onBeforeOwnershipRegistryQuarantine);
    return { status: "stalled", ownerId, generations: 0, activated: 0, readyChunks: 0, failedChunks: 0, reason };
  }
  const now = new Date();
  const acquire = (): boolean => input.store.db.transaction(() => {
    const didAcquire = lifecycle.acquireWorkerLease({
      ownerId,
      ownerPid: process.pid,
      buildId: identity.buildId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    if (didAcquire) persist("running", null);
    return didAcquire;
  })();
  let acquired = acquire();
  if (!acquired) {
    const ownerStatus = reclaimDeadWorkerLease(input.store, lifecycle);
    if (ownerStatus === "unproven") {
      const reason = "WORKER_OWNER_IDENTITY_UNPROVEN";
      appendBoundedLog(log, { event: "worker_exit", status: "stalled", reason, ownerId, generations: 0, activated: 0, readyChunks: 0, failedChunks: 0 });
      removeCurrentWorkerOwnershipRegistry(input.onBeforeOwnershipRegistryQuarantine);
      return { status: "stalled", ownerId, generations: 0, activated: 0, readyChunks: 0, failedChunks: 0, reason };
    }
    if (ownerStatus === "reclaimed" || ownerStatus === "expired" || ownerStatus === "absent") acquired = acquire();
  }
  // A losing worker must not overwrite the live owner's durable identity.
  // ensureSemanticWorker relies on that record to detect an old runtime which
  // still owns the lease after an app/runtime upgrade.
  if (!acquired) {
    removeCurrentWorkerOwnershipRegistry(input.onBeforeOwnershipRegistryQuarantine);
    return { status: "already_running", ownerId, generations: 0, activated: 0, readyChunks: 0, failedChunks: 0, reason: null };
  }
  appendBoundedLog(log, { event: "worker_started", status: "running", ownerId });

  let abortCleanup: Promise<boolean> | null = null;
  const releaseAbortedWork = (): Promise<boolean> => {
    if (abortCleanup) return abortCleanup;
    abortCleanup = (async () => {
      const deadline = Date.now() + ABORT_CLEANUP_DEADLINE_MS;
      // The worker is terminating: never let the connection's default 5s
      // busy_timeout consume the launcher's whole graceful shutdown window.
      try { input.store.db.pragma(`busy_timeout = ${ABORT_CLEANUP_BUSY_TIMEOUT_MS}`); } catch { /* cleanup still has dead-owner fallback */ }
      for (let attempt = 0; attempt < ABORT_CLEANUP_ATTEMPTS && Date.now() < deadline; attempt += 1) {
        try {
          input.store.db.transaction(() => {
            input.store.db.prepare(`
              UPDATE embedding_jobs
                 SET status='pending',attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END,
                     error='WORKER_ABORTED',lease_owner=NULL,lease_expires_at=NULL,
                     next_attempt_at=NULL,updated_at=?
               WHERE status='running' AND lease_owner=?
            `).run(new Date().toISOString(), ownerId);
            lifecycle.releaseWorkerLease(ownerId);
            persist("stalled", "WORKER_ABORTED");
          })();
          return true;
        } catch {
          const remaining = deadline - Date.now();
          if (attempt + 1 < ABORT_CLEANUP_ATTEMPTS && remaining > 0) {
            await sleep(Math.min(ABORT_CLEANUP_RETRY_MS * (attempt + 1), remaining));
          }
        }
      }
      appendBoundedLog(log, { event: "worker_abort_cleanup_failed", status: "stalled", reason: "WORKER_ABORT_CLEANUP_FAILED", ownerId });
      return false;
    })();
    return abortCleanup;
  };
  const startAbortCleanup = (): void => {
    const cleanup = releaseAbortedWork();
    input.onAbortCleanup?.(cleanup);
  };
  input.signal?.addEventListener("abort", startAbortCleanup, { once: true });
  if (input.signal?.aborted) startAbortCleanup();

  let heartbeatLost = false;
  const heartbeat = setInterval(() => {
    const heartbeatNow = new Date();
    heartbeatLost = !lifecycle.heartbeatWorkerLease({
      ownerId,
      now: heartbeatNow.toISOString(),
      leaseExpiresAt: new Date(heartbeatNow.getTime() + leaseMs).toISOString(),
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  let totals = { generations: 0, activated: 0, readyChunks: 0, failedChunks: 0 };
  const schedulerState = { completedBatches: 0 };
  try {
    const queued = input.store.db.prepare(`
      SELECT COUNT(*) AS n
        FROM embedding_generations g
       WHERE g.status='staging'
          OR (g.status='active' AND EXISTS (
            SELECT 1 FROM embedding_jobs j
             WHERE j.generation_id=g.id AND j.status IN ('pending','running','failed')
          ))
    `).get() as { n: number };
    if (queued.n === 0) return result("drained", totals);
    let provider: EmbeddingProvider;
    try {
      provider = await (input.providerFactory?.() ?? openBundledEmbeddingProvider());
    } catch (error) {
      return result("model_unavailable", totals, String((error as Error).message ?? error));
    }

    while (!input.signal?.aborted && !heartbeatLost) {
      const compatibility = input.store.db.prepare(`
        SELECT
          COALESCE(SUM(s.identity_hash=?),0) AS matching,
          COALESCE(SUM(s.identity_hash<>?),0) AS mismatched
          FROM embedding_generations g
          JOIN embedding_spaces s ON s.id=g.space_id
         WHERE g.status IN ('staging','active')
      `).get(provider.modelHash, provider.modelHash) as { matching: number; mismatched: number };
      // A runtime update may change model/tokenizer/chunker identity while old
      // durable work is still queued. Never busy-loop over work this provider
      // is forbidden to claim; leave it untouched and surface the exact
      // fail-closed reason to CLI/MCP/Tauri.
      if (compatibility.matching === 0 && compatibility.mismatched > 0) {
        return result("version_mismatch", totals, "MODEL_IDENTITY_MISMATCH");
      }
      try {
        const result = await drainSemanticQueue({
          store: input.store,
          provider,
          ownerId,
          signal: input.signal,
        // The durable worker uses a throughput-oriented claim size. Direct
        // backfill callers retain the conservative 32-item default used for
        // small/interactive jobs; worker throughput is separately bounded by
        // maxBatchesPerRound.
          batchSize: input.batchSize ?? 128,
          bootstrapReadyChunks: input.bootstrapReadyChunks ?? 512,
          maxBatchesPerRound: input.maxBatchesPerRound ?? 8,
          schedulerState,
          onBatchTiming: (timing) => appendBoundedLog(log, {
            event: "embedding_batch_timing",
            status: "running",
            ownerId,
            ...timing,
          }),
          onCheckpointFailure: (failure) => {
            checkpointFailureCode = failure.code;
            persist("running", failure.code, "inspect semantic worker logs and storage health; committed embeddings remain valid");
            appendBoundedLog(log, {
              event: "checkpoint_failed",
              status: "running",
              reason: failure.code,
              ownerId,
              completedBatches: failure.completedBatches,
            });
          },
        });
        totals = {
          generations: Math.max(totals.generations, result.generations),
          activated: totals.activated + result.activated,
          readyChunks: result.readyChunks,
          failedChunks: result.failedChunks,
        };
        appendBoundedLog(log, {
          event: "worker_progress",
          status: "running",
          ownerId,
          completedBatches: schedulerState.completedBatches,
          ...totals,
        });
      } catch {
        // Job-level errors are already sanitized and persisted. The bounded
        // retry schedule below decides whether this short-lived worker waits.
      }
      // The old aggregate joined every job row after every bounded batch. On
      // a 500k-chunk corpus that turns a fair scheduler into another full
      // corpus scan per round. Existence probes use the generation/status
      // indexes and stop as soon as the scheduler decision is known.
      const state = input.store.db.prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM embedding_generations g
            JOIN embedding_spaces s ON s.id=g.space_id
            JOIN semantic_controls c ON c.scope_key=g.scope_key
           WHERE g.status IN ('staging','active') AND s.identity_hash=? AND COALESCE(c.pause_requested,0)=1
          ) AS paused,
          EXISTS(
            SELECT 1 FROM embedding_jobs j
            JOIN embedding_generations g ON g.id=j.generation_id
            JOIN embedding_spaces s ON s.id=g.space_id
           WHERE g.status IN ('staging','active') AND s.identity_hash=? AND j.status='pending'
          ) AS pending,
          EXISTS(
            SELECT 1 FROM embedding_jobs j
            JOIN embedding_generations g ON g.id=j.generation_id
            JOIN embedding_spaces s ON s.id=g.space_id
           WHERE g.status IN ('staging','active') AND s.identity_hash=? AND j.status='running'
          ) AS running,
          EXISTS(
            SELECT 1 FROM embedding_jobs j
            JOIN embedding_generations g ON g.id=j.generation_id
            JOIN embedding_spaces s ON s.id=g.space_id
           WHERE g.status IN ('staging','active') AND s.identity_hash=? AND j.status='failed' AND j.attempts<5
          ) AS retryable,
          EXISTS(
            SELECT 1 FROM embedding_jobs j
            JOIN embedding_generations g ON g.id=j.generation_id
            JOIN embedding_spaces s ON s.id=g.space_id
           WHERE g.status IN ('staging','active') AND s.identity_hash=? AND j.status='failed' AND j.attempts>=5
          ) AS terminal,
          (
            SELECT MIN(j.next_attempt_at) FROM embedding_jobs j
            JOIN embedding_generations g ON g.id=j.generation_id
            JOIN embedding_spaces s ON s.id=g.space_id
           WHERE g.status IN ('staging','active') AND s.identity_hash=? AND j.status='failed' AND j.attempts<5
          ) AS nextAttemptAt
      `).get(provider.modelHash, provider.modelHash, provider.modelHash, provider.modelHash, provider.modelHash, provider.modelHash) as { paused: number; pending: number; running: number; retryable: number; terminal: number; nextAttemptAt: string | null };
      if (state.paused > 0 && state.running === 0) return result("paused", totals);
      if (state.pending > 0) continue;
      if (state.retryable > 0 && state.nextAttemptAt) {
        const waitMs = Math.max(0, Math.min(60_000, Date.parse(state.nextAttemptAt) - Date.now()));
        await sleep(waitMs || 25, input.signal);
        continue;
      }
      if (state.terminal > 0) return result("stalled", totals, "EMBEDDING_RETRY_EXHAUSTED");
      const checkpoint = input.store.db.pragma("wal_checkpoint(PASSIVE)") as Array<{ busy: number; log: number; checkpointed: number }>;
      const wal = checkpoint[0];
      // TRUNCATE only after PASSIVE proves every frame was folded and no
      // conflicting writer held the checkpoint. A race still fails soft.
      if (wal && wal.busy === 0 && wal.log === wal.checkpointed) {
        try { input.store.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* next worker/startup retries */ }
      }
      return result("drained", totals);
    }
    return result("stalled", totals, heartbeatLost ? "WORKER_LEASE_LOST" : "WORKER_ABORTED");
  } finally {
    clearInterval(heartbeat);
    input.signal?.removeEventListener("abort", startAbortCleanup);
    if (input.signal?.aborted) await releaseAbortedWork();
    else lifecycle.releaseWorkerLease(ownerId);
  }
}

export async function runSemanticWorkerWithProcessSignals(input: RunSemanticWorkerInput): Promise<SemanticWorkerResult> {
  const controller = new AbortController();
  let abortCleanup: Promise<boolean> | null = null;
  let forcedExit = false;
  const abort = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    // Provider calls may be non-cancellable. Once bounded cleanup has either
    // released the rows or timed out, this dedicated worker must exit so the
    // persisted owner identity makes the next wake reclaim immediately.
    void (async () => {
      const cleanup = abortCleanup ?? Promise.resolve(false);
      await Promise.race([cleanup, sleep(ABORT_CLEANUP_DEADLINE_MS)]);
      if (!forcedExit) {
        forcedExit = true;
        process.exit(0);
      }
    })();
  };
  const forwardExternalAbort = (): void => abort();
  if (input.signal?.aborted) forwardExternalAbort();
  else input.signal?.addEventListener("abort", forwardExternalAbort, { once: true });
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  process.on("SIGHUP", abort);
  try {
    return await runSemanticWorker({
      ...input,
      signal: controller.signal,
      onAbortCleanup: (cleanup) => { abortCleanup ??= cleanup; },
    });
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
    process.off("SIGHUP", abort);
    input.signal?.removeEventListener("abort", forwardExternalAbort);
  }
}

export type SemanticWorkerStartStatus = "started" | "already_running" | "not_needed" | "start_failed" | "version_mismatch";

export interface SemanticWorkerStartResult {
  status: SemanticWorkerStartStatus;
  pid: number | null;
  reason: string | null;
  logPath: string;
}

function boundBootstrapDiagnostic(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size > maxBytes) truncateSync(path, maxBytes);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function settleBootstrapDiagnostic(path: string, maxBytes: number, timeoutMs = 100): void {
  if (!existsSync(path)) return;
  const deadline = Date.now() + timeoutMs;
  let previousSize = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    boundBootstrapDiagnostic(path, maxBytes);
    const size = safeSize(path);
    if (size > 0 && size === previousSize) {
      stableReads += 1;
      if (stableReads >= 2) return;
    } else {
      stableReads = 0;
    }
    previousSize = size;
    waitSynchronously(5);
  }
}

function processIsAlive(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!state || state.startsWith("Z")) return false;
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

function validatedOwnedPid(pid: number | undefined): number {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 1) throw new Error("OWNED_PROCESS_PID_INVALID");
  return pid!;
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  startIdentity: string;
  state?: string;
}

interface AcceptedProcessIdentity extends ProcessIdentity {
  acceptanceId: string;
  freezeId: string | null;
}

interface OwnedProcessRegistry {
  path: string;
  token: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}

interface OwnedProcessBoundary {
  root: ProcessIdentity;
  pgid: number;
  registry?: OwnedProcessRegistry;
  handoffs: Map<number, AcceptedProcessIdentity>;
  registryError: Error | null;
  cleanupReason?: string;
}

function posixProcessSnapshot(): Map<number, ProcessIdentity> {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const records = new Map<number, ProcessIdentity>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)/u.exec(line);
    if (!match || match[5].startsWith("Z")) continue;
    const pid = Number(match[1]);
    records.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), startIdentity: match[4], state: match[5] });
  }
  return records;
}

function sameProcessIdentity(expected: ProcessIdentity, current: ProcessIdentity | undefined): boolean {
  return Boolean(current
    && expected.pid === current.pid
    && expected.pgid === current.pgid
    && expected.startIdentity === current.startIdentity);
}

function currentProcessIdentity(expected: ProcessIdentity): ProcessIdentity | null {
  const current = posixProcessSnapshot().get(expected.pid);
  return sameProcessIdentity(expected, current) && expected.ppid === current!.ppid ? current! : null;
}

function posixDescendants(rootPid: number, records = posixProcessSnapshot()): ProcessIdentity[] {
  const root = validatedOwnedPid(rootPid);
  const children = new Map<number, number[]>();
  for (const record of records.values()) children.set(record.ppid, [...(children.get(record.ppid) ?? []), record.pid]);
  const descendants: Array<ProcessIdentity & { depth: number }> = [];
  const visit = (pid: number, depth: number): void => {
    for (const childPid of children.get(pid) ?? []) {
      if (childPid === root || descendants.some((entry) => entry.pid === childPid)) continue;
      const record = records.get(childPid);
      if (!record) continue;
      descendants.push({ ...record, depth });
      visit(childPid, depth + 1);
    }
  };
  visit(root, 1);
  return descendants.sort((left, right) => right.depth - left.depth || right.pid - left.pid);
}

function cleanupUnproven(code = "SEMANTIC_WORKER_CLEANUP_UNPROVEN"): Error {
  return new Error(code);
}

interface OwnershipRecord {
  type: string;
  version: number;
  token: string;
  pid?: number;
  ppid?: number;
  pgid?: number;
  startIdentity?: string;
  acceptanceId?: string;
  freezeId?: string;
  controllerPid?: number;
}

function readOwnershipRecords(registry: OwnedProcessRegistry): OwnershipRecord[] {
  const stat = lstatSync(registry.path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== registry.dev || stat.ino !== registry.ino
    || stat.uid !== registry.uid || (stat.mode & 0o777) !== registry.mode) throw cleanupUnproven();
  const content = readFileSync(registry.path, "utf8");
  if (content && !content.endsWith("\n")) throw cleanupUnproven();
  const records: OwnershipRecord[] = [];
  for (const row of content.split(/\r?\n/u)) {
    if (!row) continue;
    let value: Partial<OwnershipRecord>;
    try { value = JSON.parse(row) as Partial<OwnershipRecord>; }
    catch { throw cleanupUnproven(); }
    if (value.version !== 1 || value.token !== registry.token || typeof value.type !== "string") throw cleanupUnproven();
    if (value.controllerPid !== undefined && (!Number.isInteger(value.controllerPid) || value.controllerPid <= 1)) throw cleanupUnproven();
    if (value.type === "registry") {
      // The first record binds cleanup to the registry creator's token and inode.
    } else if (value.type === "handoff") {
      if (!Number.isInteger(value.pid) || value.pid! <= 1
        || !Number.isInteger(value.ppid) || value.ppid! <= 1
        || !Number.isInteger(value.pgid) || value.pgid! <= 1
        || typeof value.startIdentity !== "string" || !value.startIdentity) throw cleanupUnproven();
    } else if (value.type === "handoff-accepted") {
      if (!Number.isInteger(value.pid) || value.pid! <= 1
        || !Number.isInteger(value.pgid) || value.pgid! <= 1
        || typeof value.startIdentity !== "string" || !value.startIdentity
        || typeof value.acceptanceId !== "string" || !value.acceptanceId) throw cleanupUnproven();
    } else if (value.type === "handoff-freeze" || value.type === "handoff-frozen") {
      if (!Number.isInteger(value.pid) || value.pid! <= 1
        || typeof value.acceptanceId !== "string" || !value.acceptanceId
        || typeof value.freezeId !== "string" || !value.freezeId) throw cleanupUnproven();
      if (value.type === "handoff-frozen"
        && (!Number.isInteger(value.pgid) || value.pgid! <= 1
          || typeof value.startIdentity !== "string" || !value.startIdentity)) throw cleanupUnproven();
    } else {
      throw cleanupUnproven();
    }
    records.push(value as OwnershipRecord);
  }
  return records;
}

function readOwnershipHandoffs(registry: OwnedProcessRegistry): Array<ProcessIdentity & { controllerPid?: number }> {
  const records = new Map<number, ProcessIdentity & { controllerPid?: number }>();
  for (const value of readOwnershipRecords(registry)) {
    if (value.type !== "handoff") continue;
    const record = { pid: value.pid!, ppid: value.ppid!, pgid: value.pgid!, startIdentity: value.startIdentity!,
      ...(value.controllerPid === undefined ? {} : { controllerPid: value.controllerPid }) };
    const previous = records.get(record.pid);
    if (previous && !sameProcessIdentity(previous, record)) throw cleanupUnproven();
    records.set(record.pid, record);
  }
  return [...records.values()];
}

function appendOwnershipRecord(registry: OwnedProcessRegistry, record: Omit<OwnershipRecord, "version" | "token">): void {
  const before = lstatSync(registry.path);
  if (!before.isFile() || before.nlink !== 1 || before.dev !== registry.dev || before.ino !== registry.ino
    || before.uid !== registry.uid || (before.mode & 0o777) !== registry.mode) throw cleanupUnproven();
  appendFileSync(registry.path, `${JSON.stringify({ ...record, version: 1, token: registry.token })}\n`, { encoding: "utf8" });
  const after = lstatSync(registry.path);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== registry.dev || after.ino !== registry.ino
    || after.uid !== registry.uid || (after.mode & 0o777) !== registry.mode) throw cleanupUnproven();
}

function isDescendant(rootPid: number, record: ProcessIdentity, snapshot: Map<number, ProcessIdentity>): boolean {
  const seen = new Set<number>();
  let cursor: ProcessIdentity | undefined = record;
  while (cursor && cursor.pid !== rootPid && !seen.has(cursor.pid)) {
    seen.add(cursor.pid);
    cursor = snapshot.get(cursor.ppid);
  }
  return cursor?.pid === rootPid;
}

function createOwnedProcessBoundary(child: ReturnType<typeof spawn>, registry?: OwnedProcessRegistry): OwnedProcessBoundary | null {
  const rootPid = validatedOwnedPid(child.pid);
  if (process.platform === "win32") return null;
  let root: ProcessIdentity | undefined;
  if (!waitForCondition(() => {
    root = posixProcessSnapshot().get(rootPid);
    return Boolean(root) || child.exitCode !== null || child.signalCode !== null;
  }, 500) || !root) return null;
  const caller = posixProcessSnapshot().get(process.pid);
  if (root.pgid !== root.pid || !caller || caller.pgid === root.pgid) return null;
  return { root, pgid: root.pgid, registry, handoffs: new Map(), registryError: null };
}

function observeOwnedProcessBoundary(boundary: OwnedProcessBoundary): void {
  if (!boundary.registry) return;
  const snapshot = posixProcessSnapshot();
  for (const claimed of readOwnershipHandoffs(boundary.registry)) {
    if (claimed.controllerPid != null && claimed.controllerPid !== process.pid) continue;
    const accepted = boundary.handoffs.get(claimed.pid);
    if (accepted) {
      if (!sameProcessIdentity(accepted, claimed)) throw cleanupUnproven();
      continue;
    }
    const current = snapshot.get(claimed.pid);
    if (!current || !sameProcessIdentity(claimed, current)
      || !isDescendant(boundary.root.pid, current, snapshot)
      || current.pgid !== current.pid) throw cleanupUnproven("SEMANTIC_WORKER_OWNERSHIP_HANDOFF_UNPROVEN");
    const acceptance: AcceptedProcessIdentity = { ...current, acceptanceId: randomUUID(), freezeId: null };
    appendOwnershipRecord(boundary.registry, {
      type: "handoff-accepted", pid: current.pid, pgid: current.pgid,
      startIdentity: current.startIdentity, acceptanceId: acceptance.acceptanceId, controllerPid: process.pid,
    });
    boundary.handoffs.set(current.pid, acceptance);
  }
}

function freezeAcceptedHandoffs(boundary: OwnedProcessBoundary, timeoutMs: number): boolean {
  if (boundary.handoffs.size === 0) return true;
  if (!boundary.registry) return false;
  for (const accepted of boundary.handoffs.values()) {
    accepted.freezeId ??= randomUUID();
    appendOwnershipRecord(boundary.registry, {
      type: "handoff-freeze", pid: accepted.pid,
      acceptanceId: accepted.acceptanceId, freezeId: accepted.freezeId, controllerPid: process.pid,
    });
  }
  return waitForCondition(() => {
    const records = readOwnershipRecords(boundary.registry!);
    const snapshot = posixProcessSnapshot();
    return [...boundary.handoffs.values()].every((accepted) => {
      const frozen = records.find((record) => record.type === "handoff-frozen"
        && record.pid === accepted.pid
        && record.acceptanceId === accepted.acceptanceId
        && record.freezeId === accepted.freezeId
        && record.pgid === accepted.pgid
        && record.startIdentity === accepted.startIdentity);
      const current = snapshot.get(accepted.pid);
      return Boolean(frozen && sameProcessIdentity(accepted, current)
        && current!.pgid === current!.pid && current!.state?.startsWith("T"));
    });
  }, timeoutMs);
}

function freezeDirectProcessGroup(
  child: ReturnType<typeof spawn>,
  boundary: OwnedProcessBoundary,
  timeoutMs: number,
): Map<number, ProcessIdentity> | null {
  if (child.pid !== boundary.root.pid || child.exitCode !== null || child.signalCode !== null) return null;
  const before = posixProcessSnapshot();
  const root = before.get(boundary.root.pid);
  const caller = before.get(process.pid);
  if (!sameProcessIdentity(boundary.root, root) || root!.ppid !== process.pid
    || root!.pgid !== root!.pid || !caller || caller.pgid === root!.pgid) return null;
  if (!child.kill("SIGSTOP")) return null;
  const rootFrozen = waitForCondition(() => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const current = posixProcessSnapshot().get(boundary.root.pid);
    return Boolean(sameProcessIdentity(boundary.root, current)
      && current!.ppid === process.pid && current!.pgid === current!.pid && current!.state?.startsWith("T"));
  }, timeoutMs);
  if (!rootFrozen) return null;
  process.kill(-boundary.pgid, "SIGSTOP");
  const groupFrozen = waitForCondition(() => {
    const snapshot = posixProcessSnapshot();
    const members = [...snapshot.values()].filter((record) => record.pgid === boundary.pgid);
    const currentRoot = snapshot.get(boundary.root.pid);
    return members.length > 0
      && Boolean(sameProcessIdentity(boundary.root, currentRoot) && currentRoot!.ppid === process.pid)
      && members.every((record) => record.state?.startsWith("T"));
  }, timeoutMs);
  if (!groupFrozen) return null;
  observeOwnedProcessBoundary(boundary);
  return posixProcessSnapshot();
}

function terminateSpawnedTree(child: ReturnType<typeof spawn>, graceMs = 750, boundary?: OwnedProcessBoundary | null): boolean {
  const rootPid = validatedOwnedPid(child.pid);
  if (process.platform === "win32") {
    const taskkill = (force: boolean): void => {
      try {
        execFileSync("taskkill", ["/PID", String(rootPid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
      } catch { /* Windows cannot prove the whole descendant tree after taskkill. */ }
    };
    taskkill(false);
    waitForCondition(() => !processIsAlive(rootPid), graceMs);
    if (processIsAlive(rootPid)) taskkill(true);
    return false;
  }

  if (!boundary) return !processIsAlive(rootPid);
  const failClosed = (reason: string): false => {
    boundary.cleanupReason = reason;
    return false;
  };
  let ownershipFailure = boundary.registryError;
  const observe = (): Map<number, ProcessIdentity> => {
    const snapshot = posixProcessSnapshot();
    try { observeOwnedProcessBoundary(boundary); }
    catch (error) { ownershipFailure ??= error as Error; }
    for (const record of posixDescendants(rootPid, snapshot)) {
      if (record.pgid !== boundary.pgid) {
        const accepted = boundary.handoffs.get(record.pid);
        const acceptedGroup = [...boundary.handoffs.values()].find((candidate) => candidate.pgid === record.pgid);
        const sentinel = acceptedGroup ? snapshot.get(acceptedGroup.pid) : undefined;
        const groupIsPinned = Boolean(acceptedGroup
          && sameProcessIdentity(acceptedGroup, sentinel)
          && sentinel!.pgid === sentinel!.pid);
        if ((!accepted || !sameProcessIdentity(accepted, record)) && !groupIsPinned) {
          ownershipFailure ??= cleanupUnproven("SEMANTIC_WORKER_HANDOFF_GROUP_UNPROVEN");
        }
      }
    }
    return snapshot;
  };
  let snapshot = observe();
  if (ownershipFailure) return failClosed(ownershipFailure.message);
  const root = snapshot.get(rootPid);
  const caller = snapshot.get(process.pid);
  const groupExists = [...snapshot.values()].some((record) => record.pgid === boundary.pgid);
  if ((root && (!sameProcessIdentity(boundary.root, root) || root.ppid !== process.pid || root.pgid !== root.pid))
    || !caller || caller.pgid === boundary.pgid) return failClosed("SEMANTIC_WORKER_DIRECT_CHILD_IDENTITY_UNPROVEN");
  if (!root && !groupExists && boundary.handoffs.size === 0) return !ownershipFailure;
  if (!root) return failClosed("SEMANTIC_WORKER_DIRECT_CHILD_LIVENESS_UNPROVEN");
  const freezeTimeoutMs = Math.min(2_000, Math.max(500, graceMs));
  if (!freezeAcceptedHandoffs(boundary, freezeTimeoutMs)) return failClosed("SEMANTIC_WORKER_HANDOFF_FREEZE_UNPROVEN");
  const frozenSnapshot = freezeDirectProcessGroup(child, boundary, freezeTimeoutMs);
  if (!frozenSnapshot) return failClosed("SEMANTIC_WORKER_DIRECT_CHILD_FREEZE_UNPROVEN");
  const directMembers = [...frozenSnapshot.values()].filter((record) => record.pgid === boundary.pgid);
  const directSentinel = directMembers.find((record) => record.pid !== boundary.root.pid) ?? null;
  process.kill(-boundary.pgid, "SIGTERM");
  for (const record of directMembers) {
    if (record.pid === directSentinel?.pid) continue;
    if (record.pid === boundary.root.pid) child.kill("SIGCONT");
    else process.kill(record.pid, "SIGCONT");
  }
  waitForCondition(() => {
    const current = posixProcessSnapshot();
    return ![...current.values()].some((record) => record.pgid === boundary.pgid && record.pid !== directSentinel?.pid);
  }, graceMs);
  snapshot = posixProcessSnapshot();
  if ([...snapshot.values()].some((record) => record.pgid === boundary.pgid)) {
    if (directSentinel) {
      const sentinel = snapshot.get(directSentinel.pid);
      if (!sameProcessIdentity(directSentinel, sentinel) || !sentinel!.state?.startsWith("T")) ownershipFailure ??= cleanupUnproven();
    } else {
      const refrozen = freezeDirectProcessGroup(child, boundary, freezeTimeoutMs);
      if (!refrozen) ownershipFailure ??= cleanupUnproven();
      snapshot = refrozen ?? snapshot;
    }
    if (!ownershipFailure) process.kill(-boundary.pgid, "SIGKILL");
  }
  for (const accepted of boundary.handoffs.values()) {
    snapshot = posixProcessSnapshot();
    if (![...snapshot.values()].some((record) => record.pgid === accepted.pgid)) continue;
    const sentinel = snapshot.get(accepted.pid);
    if (!sameProcessIdentity(accepted, sentinel) || sentinel!.pgid !== sentinel!.pid || !sentinel!.state?.startsWith("T")) {
      ownershipFailure ??= cleanupUnproven();
      continue;
    }
    process.kill(-accepted.pgid, "SIGKILL");
  }
  const proven = waitForCondition(() => {
    snapshot = posixProcessSnapshot();
    return ![...snapshot.values()].some((record) => record.pgid === boundary.pgid)
      && [...boundary.handoffs.values()].every((record) => ![...snapshot.values()].some((current) => current.pgid === record.pgid));
  }, 2_000);
  if (ownershipFailure) return failClosed(ownershipFailure.message);
  if (!proven) return failClosed("SEMANTIC_WORKER_PROCESS_TREE_EXIT_UNPROVEN");
  return true;
}

function waitForCondition(predicate: () => boolean, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    waitSynchronously(10);
  }
  return predicate();
}

function consumeBootstrapDiagnostic(path: string, maxBytes: number): string | null {
  try {
    boundBootstrapDiagnostic(path, maxBytes);
    const bytes = readFileSync(path);
    rmSync(path, { force: true });
    if (bytes.length === 0) return null;
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12).toUpperCase();
    return `WORKER_BOOTSTRAP_STDERR_${digest}`;
  } catch (error) {
    rmSync(path, { force: true });
    if (errno(error) === "ENOENT") return null;
    return "WORKER_BOOTSTRAP_STDERR_UNREADABLE";
  }
}

function fallbackBootstrapDiagnostic(reason: string, startToken: string): string {
  const digest = createHash("sha256")
    .update(`${reason}\0${startToken}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `WORKER_BOOTSTRAP_FALLBACK_${digest}`;
}

function removeCurrentWorkerOwnershipRegistry(onBeforeQuarantine?: (path: string) => void): void {
  const path = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY;
  const token = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN;
  const numeric = (name: string): number | null => {
    const raw = process.env[name];
    if (!raw || !/^\d+$/u.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const dev = numeric("PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_DEV");
  const ino = numeric("PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_INO");
  const uid = numeric("PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_UID");
  const mode = numeric("PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_MODE");
  if (!path || !token || dev == null || ino == null || uid == null || mode == null) return;
  removeOwnedProcessRegistry({ path, token, dev, ino, uid, mode }, onBeforeQuarantine);
}

function ownedRegistryHeaderMatches(registry: OwnedProcessRegistry, content: Buffer): boolean {
  try {
    const firstLine = content.toString("utf8").split(/\r?\n/u, 1)[0];
    if (!firstLine) return false;
    const header = JSON.parse(firstLine) as { type?: unknown; version?: unknown; token?: unknown };
    return header.type === "registry" && header.version === 1 && header.token === registry.token;
  } catch {
    return false;
  }
}

function ownedRegistryStatMatches(registry: OwnedProcessRegistry, path = registry.path): boolean {
  try {
    const stat = lstatSync(path);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    return stat.isFile() && stat.nlink === 1
      && stat.dev === registry.dev && stat.ino === registry.ino
      && stat.uid === registry.uid && (stat.mode & 0o777) === registry.mode
      && registry.mode === 0o600 && (currentUid == null || stat.uid === currentUid);
  } catch {
    return false;
  }
}

function ownedRegistrySnapshot(registry: OwnedProcessRegistry, path = registry.path): Buffer | null {
  try {
    if (!ownedRegistryStatMatches(registry, path)) return null;
    const content = readFileSync(path);
    if (!ownedRegistryHeaderMatches(registry, content) || !ownedRegistryStatMatches(registry, path)) return null;
    return content;
  } catch {
    return null;
  }
}

function restoreQuarantinedRegistry(path: string, quarantinePath: string): void {
  try {
    if (!existsSync(path)) renameSync(quarantinePath, path);
  } catch { /* preserving quarantine is the fail-closed fallback */ }
}

function createOwnedProcessRegistry(
  log: ResolvedWorkerLogOptions,
  token: string,
  onCreated?: (path: string) => void,
  onBeforeQuarantine?: (path: string) => void,
): OwnedProcessRegistry {
  const path = `${log.path}.owners-${token}`;
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  try {
    appendFileSync(descriptor, `${JSON.stringify({ type: "registry", version: 1, token })}\n`, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const registry = { path, token, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (uid != null && stat.uid !== uid)) {
    removeOwnedProcessRegistry(registry, onBeforeQuarantine);
    throw cleanupUnproven("SEMANTIC_WORKER_OWNERSHIP_REGISTRY_FAILED");
  }
  try { onCreated?.(path); }
  catch {
    removeOwnedProcessRegistry(registry, onBeforeQuarantine);
    throw cleanupUnproven("SEMANTIC_WORKER_OWNERSHIP_REGISTRY_FAILED");
  }
  return registry;
}

function removeOwnedProcessRegistry(
  registry: OwnedProcessRegistry | null,
  onBeforeQuarantine?: (path: string) => void,
): void {
  if (!registry) return;
  const quarantinePath = join(
    dirname(registry.path),
    `.${basename(registry.path)}.quarantine-${process.pid}-${randomUUID()}`,
  );
  try {
    const expectedContent = ownedRegistrySnapshot(registry);
    if (!expectedContent) return;
    onBeforeQuarantine?.(registry.path);
    renameSync(registry.path, quarantinePath);
    const quarantinedContent = ownedRegistrySnapshot(registry, quarantinePath);
    if (!quarantinedContent || !quarantinedContent.equals(expectedContent)) {
      restoreQuarantinedRegistry(registry.path, quarantinePath);
      return;
    }
    rmSync(quarantinePath);
  } catch { /* registry removal must not change worker result */ }
}

export function ensureSemanticWorker(input: {
  store: KnowledgeStore;
  launcherPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  log?: Omit<SemanticWorkerLogOptions, "path">;
  now?: string;
  expectedRuntimeIdentity?: SemanticRuntimeIdentity;
  readinessTimeoutMs?: number;
  /** Internal maintenance hook used to force a post-create setup failure. */
  onOwnershipRegistryCreated?: (path: string) => void;
  /** Internal maintenance hook used to exercise the final cleanup race. */
  onBeforeOwnershipRegistryQuarantine?: (path: string) => void;
}): SemanticWorkerStartResult {
  const now = input.now ?? new Date().toISOString();
  const logPath = input.logPath ?? join(homedir(), ".penguin", "knowledge", "logs", "semantic-worker.log");
  // WHY: the ONNX embedding worker's native memory is unbounded (2026-09-06:
  // 24GB RSS, machine swapped to a halt). Every wake path (Penguin.app startup,
  // MCP startup, index/rebuild, CLI wake) funnels through here, so one marker
  // file is a complete kill switch. A file is used instead of an env var
  // because the spawners run from unrelated environments.
  const disabledMarker = join(homedir(), ".penguin", "semantic-worker.disabled");
  if (existsSync(disabledMarker)) return { status: "not_needed", pid: null, reason: "SEMANTIC_WORKER_DISABLED", logPath };
  const queued = input.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_generations WHERE status='staging'").get() as { n: number };
  if (queued.n === 0) return { status: "not_needed", pid: null, reason: null, logPath };
  const expectedIdentity = input.expectedRuntimeIdentity ?? activeRuntimeIdentity();
  const lifecycle = new EmbeddingLifecycle(input.store);
  type CompetingOwnerValidation =
    | { status: "absent" }
    | { status: "unproven"; pid: number | null }
    | { status: "valid"; result: SemanticWorkerStartResult };
  const validateCompetingOwner = (ownStartToken?: string): CompetingOwnerValidation => {
    const ownerStatus = reclaimDeadWorkerLease(input.store, lifecycle);
    const candidate = lifecycle.getWorkerLease();
    if (!candidate || candidate.leaseExpiresAt <= new Date().toISOString()) return { status: "absent" };
    const runtime = readSemanticWorkerRuntimeState(input.store);
    if (ownerStatus === "unproven"
      || !runtime || runtime.status !== "running" || runtime.startToken === ownStartToken
      || runtime.ownerId !== candidate.ownerId
      || runtime.ownerPid !== candidate.ownerPid
      || !runtime.ownerProcessIdentity
      || runtime.ownerProcessIdentity.pid !== candidate.ownerPid
      || candidate.buildId !== runtime.identity.buildId
      || !currentProcessIdentity(runtime.ownerProcessIdentity)) {
      return { status: "unproven", pid: candidate.ownerPid };
    }
    if (!sameRuntimeIdentity(runtime.identity, expectedIdentity)) {
      return {
        status: "valid",
        result: { status: "version_mismatch", pid: candidate.ownerPid, reason: "VERSION_MISMATCH", logPath },
      };
    }
    return {
      status: "valid",
      result: { status: "already_running", pid: candidate.ownerPid, reason: null, logPath },
    };
  };
  const liveOwnerResult = (ownStartToken?: string): SemanticWorkerStartResult | null => {
    const validation = validateCompetingOwner(ownStartToken);
    return validation.status === "valid" ? validation.result : null;
  };
  const initialOwner = validateCompetingOwner();
  const lease = lifecycle.getWorkerLease();
  if (lease && lease.leaseExpiresAt > now) {
    if (initialOwner.status === "valid") return initialOwner.result;
    return { status: "start_failed", pid: lease.ownerPid, reason: "SEMANTIC_WORKER_OWNER_IDENTITY_UNPROVEN", logPath };
  }

  const startToken = randomUUID();
  const log = resolveWorkerLogOptions({ path: logPath, ...input.log })!;
  const bootstrapPath = `${log.path}.bootstrap-${startToken}`;
  let ownershipRegistry: OwnedProcessRegistry | null = null;
  let ownershipBoundary: OwnedProcessBoundary | null = null;
  const recordStartFailure = (reason: string, pid: number | null): SemanticWorkerStartResult => {
    const persisted = input.store.db.transaction(() => {
      const activeLease = input.store.db.prepare(`
        SELECT owner_pid AS ownerPid
          FROM semantic_worker_leases
         WHERE lock_name='semantic-drain' AND lease_expires_at>?
      `).get(new Date().toISOString()) as { ownerPid: number } | undefined;
      if (activeLease) return false;
      writeWorkerRuntimeState(input.store, {
        status: "start_failed", reason, remediation: "verify the installed Penguin runtime and retry semantic wake",
        identity: expectedIdentity, ownerId: null, ownerPid: pid, startToken, updatedAt: new Date().toISOString(),
      });
      return true;
    })();
    if (!persisted) {
      let competing: CompetingOwnerValidation = { status: "unproven", pid };
      try { competing = validateCompetingOwner(startToken); }
      catch { /* fail closed without replacing an active runtime */ }
      if (competing.status === "valid") return competing.result;
      appendBoundedLog(log, {
        event: "worker_start_failure_not_recorded",
        status: "start_failed",
        reason: "SEMANTIC_WORKER_COMPETING_OWNER_REVALIDATION_FAILED",
        ownerPid: competing.status === "unproven" ? competing.pid : pid,
        startToken,
      });
      return {
        status: "start_failed",
        pid: competing.status === "unproven" ? competing.pid : pid,
        reason: "SEMANTIC_WORKER_COMPETING_OWNER_REVALIDATION_FAILED",
        logPath,
      };
    }
    settleBootstrapDiagnostic(bootstrapPath, log.maxBytes);
    const diagnostic = consumeBootstrapDiagnostic(bootstrapPath, log.maxBytes)
      ?? fallbackBootstrapDiagnostic(reason, startToken);
    appendBoundedLog(log, { event: "worker_start_failed", status: "start_failed", reason, diagnostic, ownerPid: pid, startToken });
    return { status: "start_failed", pid, reason, logPath };
  };
  try {
    prepareBoundedLog(log);
  } catch {
    const reason = "SEMANTIC_WORKER_LOG_PREPARE_FAILED";
    writeWorkerRuntimeState(input.store, {
      status: "start_failed", reason, remediation: "verify semantic worker log permissions and retry semantic wake",
      identity: expectedIdentity, ownerId: null, ownerPid: null, startToken, updatedAt: new Date().toISOString(),
    });
    return { status: "start_failed", pid: null, reason, logPath };
  }
  try {
    ownershipRegistry = createOwnedProcessRegistry(
      log,
      startToken,
      input.onOwnershipRegistryCreated,
      input.onBeforeOwnershipRegistryQuarantine,
    );
  } catch {
    return recordStartFailure("SEMANTIC_WORKER_OWNERSHIP_REGISTRY_FAILED", null);
  }
  const stableLauncher = input.launcherPath ?? process.env.PENGUIN_CLI_LAUNCHER ?? join(homedir(), ".local", "bin", "penguin");
  if (!existsSync(stableLauncher)) {
    removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
    return recordStartFailure("SEMANTIC_WORKER_LAUNCHER_NOT_FOUND", null);
  }
  try { accessSync(stableLauncher, constants.X_OK); }
  catch {
    removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
    return recordStartFailure("SEMANTIC_WORKER_LAUNCHER_NOT_EXECUTABLE", null);
  }

  let spawnedChild: ReturnType<typeof spawn> | null = null;
  try {
    const bootstrapDescriptor = openSync(bootstrapPath, "ax", 0o600);
    let launchedChild: ReturnType<typeof spawn>;
    try {
      launchedChild = spawn(stableLauncher, ["semantic", "worker", "--drain", "--json"], {
        cwd: input.cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...input.env,
          PENGUIN_KNOWLEDGE_TRUSTED_BACKGROUND: "1",
          PENGUIN_WORKER_START_TOKEN: startToken,
          PENGUIN_SEMANTIC_WORKER_LOG_PATH: log.path,
          PENGUIN_SEMANTIC_WORKER_LOG_MAX_BYTES: String(log.maxBytes),
          PENGUIN_SEMANTIC_WORKER_LOG_HISTORY_COUNT: String(log.historyCount),
          PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY: ownershipRegistry.path,
          PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN: ownershipRegistry.token,
          PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_DEV: String(ownershipRegistry.dev),
          PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_INO: String(ownershipRegistry.ino),
          PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_UID: String(ownershipRegistry.uid),
          PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_MODE: String(ownershipRegistry.mode),
          PENGUIN_RUNTIME_OWNERSHIP_CONTROLLER_PID: String(process.pid),
        },
        detached: true,
        stdio: ["ignore", "ignore", bootstrapDescriptor],
      });
      spawnedChild = launchedChild;
    } finally {
      closeSync(bootstrapDescriptor);
    }
    const child = launchedChild;
    // spawn errors (bad shebang, vanished interpreter, permission race) are
    // asynchronous EventEmitter errors even though pid is already undefined.
    // Always consume the event so it cannot terminate index/rebuild.
    child.once("error", () => undefined);
    if (child.pid == null) {
      removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
      return recordStartFailure("SEMANTIC_WORKER_LAUNCH_FAILED", null);
    }
    ownershipBoundary = createOwnedProcessBoundary(child, ownershipRegistry);
    if (!ownershipBoundary) {
      removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
      return recordStartFailure("SEMANTIC_WORKER_CLEANUP_UNPROVEN", child.pid);
    }
    const finishWithCompetingOwner = (observed: SemanticWorkerStartResult): SemanticWorkerStartResult => {
      let cleanupProven = false;
      try {
        cleanupProven = terminateSpawnedTree(
          child,
          Math.min(1_000, Math.max(100, input.readinessTimeoutMs ?? 750)),
          ownershipBoundary,
        );
      } catch { /* fail closed below without replacing the competing owner's runtime */ }
      if (!cleanupProven) {
        appendBoundedLog(log, {
          event: "worker_cleanup_unproven",
          status: "start_failed",
          reason: "SEMANTIC_WORKER_CLEANUP_UNPROVEN",
          ownershipReason: ownershipBoundary?.cleanupReason ?? ownershipBoundary?.registryError?.message ?? null,
          ownerPid: child.pid,
          startToken,
        });
        removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
        return { status: "start_failed", pid: child.pid ?? null, reason: "SEMANTIC_WORKER_CLEANUP_UNPROVEN", logPath };
      }
      removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
      settleBootstrapDiagnostic(bootstrapPath, log.maxBytes, 500);
      consumeBootstrapDiagnostic(bootstrapPath, log.maxBytes);
      let revalidated: SemanticWorkerStartResult | null = null;
      try { revalidated = liveOwnerResult(startToken); }
      catch { /* fail closed below without replacing the competing owner's runtime */ }
      if (!revalidated || revalidated.status !== observed.status || revalidated.pid !== observed.pid) {
        appendBoundedLog(log, {
          event: "worker_competing_owner_revalidation_failed",
          status: "start_failed",
          reason: "SEMANTIC_WORKER_COMPETING_OWNER_REVALIDATION_FAILED",
          ownerPid: observed.pid,
          startToken,
        });
        return {
          status: "start_failed",
          pid: child.pid ?? null,
          reason: "SEMANTIC_WORKER_COMPETING_OWNER_REVALIDATION_FAILED",
          logPath,
        };
      }
      return revalidated;
    };
    const deadline = Date.now() + (input.readinessTimeoutMs ?? 3_000);
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
      boundBootstrapDiagnostic(bootstrapPath, log.maxBytes);
      try { observeOwnedProcessBoundary(ownershipBoundary); }
      catch (error) { ownershipBoundary.registryError ??= error as Error; }
      const runtime = readSemanticWorkerRuntimeState(input.store);
      if (runtime?.startToken === startToken) {
        if (!sameRuntimeIdentity(runtime.identity, expectedIdentity) || runtime.status === "version_mismatch") {
          const diagnostic = consumeBootstrapDiagnostic(bootstrapPath, log.maxBytes);
          appendBoundedLog(log, { event: "worker_start_rejected", status: "version_mismatch", reason: "VERSION_MISMATCH", diagnostic, ownerPid: runtime.ownerPid, startToken });
          removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
          return { status: "version_mismatch", pid: runtime.ownerPid, reason: "VERSION_MISMATCH", logPath };
        }
        if (runtime.status === "model_unavailable" || runtime.status === "start_failed") {
          const reason = diagnosticCode(runtime.reason) ?? "SEMANTIC_WORKER_START_FAILED";
          const diagnostic = consumeBootstrapDiagnostic(bootstrapPath, log.maxBytes)
            ?? fallbackBootstrapDiagnostic(reason, startToken);
          appendBoundedLog(log, { event: "worker_start_failed", status: "start_failed", reason, diagnostic, ownerPid: runtime.ownerPid, startToken });
          removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
          return { status: "start_failed", pid: runtime.ownerPid, reason, logPath };
        }
        const diagnostic = consumeBootstrapDiagnostic(bootstrapPath, log.maxBytes);
        if (diagnostic) appendBoundedLog(log, { event: "worker_bootstrap_diagnostic", status: "running", diagnostic, ownerPid: runtime.ownerPid, startToken });
        return { status: "started", pid: runtime.ownerPid ?? child.pid ?? null, reason: null, logPath };
      }
      const liveOwner = liveOwnerResult(startToken);
      if (liveOwner) return finishWithCompetingOwner(liveOwner);
      Atomics.wait(waiter, 0, 0, 20);
    }
    if (child.pid != null) {
      const liveOwner = liveOwnerResult(startToken);
      if (liveOwner) return finishWithCompetingOwner(liveOwner);
      const cleanupProven = terminateSpawnedTree(child, Math.min(1_000, Math.max(100, input.readinessTimeoutMs ?? 750)), ownershipBoundary);
      if (!cleanupProven) {
        appendBoundedLog(log, {
          event: "worker_cleanup_unproven",
          status: "start_failed",
          reason: "SEMANTIC_WORKER_CLEANUP_UNPROVEN",
          ownershipReason: ownershipBoundary?.cleanupReason ?? ownershipBoundary?.registryError?.message ?? null,
          ownerPid: child.pid,
          startToken,
        });
        removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
        return { status: "start_failed", pid: child.pid, reason: "SEMANTIC_WORKER_CLEANUP_UNPROVEN", logPath };
      }
      removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
      settleBootstrapDiagnostic(bootstrapPath, log.maxBytes, 500);
      let finalOwner: CompetingOwnerValidation = { status: "unproven", pid: child.pid };
      try { finalOwner = validateCompetingOwner(startToken); }
      catch { /* fail closed below without replacing a concurrently published runtime */ }
      if (finalOwner.status === "valid") {
        consumeBootstrapDiagnostic(bootstrapPath, log.maxBytes);
        return finalOwner.result;
      }
      if (finalOwner.status === "unproven") {
        appendBoundedLog(log, {
          event: "worker_competing_owner_revalidation_failed",
          status: "start_failed",
          reason: "SEMANTIC_WORKER_COMPETING_OWNER_REVALIDATION_FAILED",
          ownerPid: finalOwner.pid,
          startToken,
        });
        return {
          status: "start_failed",
          pid: finalOwner.pid,
          reason: "SEMANTIC_WORKER_COMPETING_OWNER_REVALIDATION_FAILED",
          logPath,
        };
      }
    }
    return recordStartFailure("SEMANTIC_WORKER_READINESS_TIMEOUT", child.pid ?? null);
  } catch (error) {
    removeOwnedProcessRegistry(ownershipRegistry, input.onBeforeOwnershipRegistryQuarantine);
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "SEMANTIC_WORKER_LAUNCHER_NOT_FOUND" : "SEMANTIC_WORKER_START_FAILED";
    return recordStartFailure(reason, null);
  } finally {
    spawnedChild?.unref();
  }
}
