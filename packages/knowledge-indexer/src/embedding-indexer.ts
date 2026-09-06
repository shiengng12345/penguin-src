import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type {
  EmbeddingProvider,
  EmbeddingJobRecord,
  EmbeddingSpaceIdentity,
  KnowledgeStore,
} from "@penguin/knowledge-core";
import {
  createEmbeddingSpace,
  EmbeddingLifecycle,
  recordSemanticProgressSample,
  VectorStore,
} from "@penguin/knowledge-core";

export interface EmbeddingBackfillCheckpoint {
  generationId: string;
  lastChunkId: string | null;
  expectedChunks: number;
  readyChunks: number;
  failedChunks: number;
  cancelled: boolean;
}

export interface EmbeddingBackfillInput {
  store: KnowledgeStore;
  provider: EmbeddingProvider;
  space: EmbeddingSpaceIdentity;
  snapshotId: string;
  scopeKey: string;
  chunkIds?: string[];
  /** Resume an already-created staging generation without rebuilding its job list. */
  generationId?: string;
  /** Reuse plan shared by the fair scheduler across bounded drain rounds. */
  reusePlan?: ReadonlyMap<string, string>;
  textLoader: (chunkId: string) => string | Promise<string>;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (checkpoint: EmbeddingBackfillCheckpoint) => void;
  onBatchTiming?: (timing: SemanticBatchTiming) => void;
  ownerId?: string;
  /** Stop after this many claimed batches so other scopes get a turn. */
  maxBatches?: number;
  /** Worker-owned progress shared across fair maxBatches-limited calls. */
  schedulerState?: SemanticSchedulerState;
  /** Reports sanitized periodic WAL checkpoint failures without failing committed work. */
  onCheckpointFailure?: (failure: SemanticCheckpointFailure) => void;
  /** Internal timing overrides for deterministic lease tests. */
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  /** Reuse a drain-owned watchdog instead of starting one per backfill call. */
  leaseWatchdog?: EmbeddingLeaseWatchdog;
}

export interface EmbeddingBackfillResult {
  checkpoint: EmbeddingBackfillCheckpoint;
  activated: boolean;
  spaceId: string;
}

export interface SemanticEnqueueResult {
  status: "queued" | "active";
  generationId: string;
  expectedChunks: number;
  readyChunks: number;
  supersededGenerations: number;
  spaceId: string;
}

export interface SemanticDrainInput {
  store: KnowledgeStore;
  provider: EmbeddingProvider;
  ownerId: string;
  signal?: AbortSignal;
  batchSize?: number;
  /** Maximum batches each queued generation may claim in one fair drain round. */
  maxBatchesPerRound?: number;
  schedulerState?: SemanticSchedulerState;
  /** Publish an initial lower-bound vector lane once this many chunks are ready. */
  bootstrapReadyChunks?: number;
  onProgress?: (checkpoint: EmbeddingBackfillCheckpoint) => void;
  onBatchTiming?: (timing: SemanticBatchTiming) => void;
  onCheckpointFailure?: (failure: SemanticCheckpointFailure) => void;
  /** Internal/test hook; the drain round owns and closes this watchdog. */
  leaseWatchdog?: EmbeddingLeaseWatchdog;
}

export interface SemanticSchedulerState {
  completedBatches: number;
  /** Cached per-generation reuse plans; building one is O(corpus), so do it once. */
  reusePlans?: Map<string, ReadonlyMap<string, string>>;
}

export interface SemanticCheckpointFailure {
  code: "WAL_CHECKPOINT_FAILED";
  completedBatches: number;
}

export interface SemanticBatchTiming {
  generationId: string;
  claimedChunks: number;
  committedChunks: number;
  failedChunks: number;
  providerCalls: number;
  claimWaitMs: number;
  sourceLoadMs: number;
  inferenceMs: number;
  validationMs: number;
  vectorWriteMs: number;
  commitMs: number;
  totalMs: number;
  outcome: "committed" | "recovered" | "failed";
  errorCode?: string;
}

interface LeaseWatchdogReply {
  type: "ready" | "begun" | "ended" | "stopped" | "error";
  requestId?: number;
  code?: string;
}

interface PendingLeaseWatchdogRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface EmbeddingLeaseWatchdog {
  begin(jobIds: readonly string[], ownerId: string, leaseDurationMs: number, heartbeatIntervalMs: number): Promise<void>;
  end(): Promise<void>;
  error(): Error | null;
  close(): Promise<void>;
}

function resolveBetterSqlite3Entry(): string | null {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire.resolve("better-sqlite3");
  } catch {
    // knowledge-indexer consumes better-sqlite3 through knowledge-core. In the
    // pnpm workspace it is intentionally not duplicated as an indexer direct
    // dependency, so resolve from the core package when running from dist.
    try {
      const coreEntry = localRequire.resolve("@penguin/knowledge-core");
      return createRequire(coreEntry).resolve("better-sqlite3");
    } catch {
      return null;
    }
  }
}

function workerExecArgv(): string[] {
  // Worker threads inherit process.execArgv by default. Launchers and test
  // runners add flags such as --input-type, --test-* and --inspect-port that
  // are either invalid for a file entrypoint or collide with the parent
  // inspector. The watchdog needs no caller-specific V8/diagnostic options;
  // starting with Node's normal defaults is the portable choice.
  return [];
}

/**
 * Renew file-backed SQLite leases from a separate event loop. Provider calls
 * may be synchronous (ONNX/native work) and can block this process's timers;
 * a main-thread interval therefore cannot prove ownership for a short lease.
 * The watchdog only extends the same owner+unexpired rows. Completion still
 * performs its own guarded update on the main connection.
 */
class LeaseWatchdog implements EmbeddingLeaseWatchdog {
  private readonly pending = new Map<number, PendingLeaseWatchdogRequest>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private nextRequestId = 1;
  private failure: Error | null = null;
  private closing = false;
  private closed = false;

  private constructor(private readonly worker: Worker) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    worker.on("message", (message: LeaseWatchdogReply) => {
      if (message.type === "ready") {
        this.resolveReady();
        return;
      }
      if (message.type === "error") {
        this.fail(new Error(message.code ?? "EMBEDDING_LEASE_WATCHDOG_FAILED"));
        return;
      }
      if (message.requestId === undefined) return;
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      clearTimeout(request.timer);
      request.resolve();
    });
    worker.on("error", () => {
      if (!this.closing) this.fail(new Error("EMBEDDING_LEASE_WATCHDOG_FAILED"));
    });
    worker.on("exit", (code) => {
      if (!this.closing && code !== 0) this.fail(new Error("EMBEDDING_LEASE_WATCHDOG_FAILED"));
    });
  }

  static async open(store: KnowledgeStore): Promise<LeaseWatchdog | null> {
    const dbPath = store.db.name;
    // better-sqlite3 connections to :memory: are private to a thread, so a
    // second connection could not see the claimed jobs. The caller retains its
    // main-thread timer for that deliberately unsupported cross-thread case.
    if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file::memory:")) return null;
    const betterSqlite3Entry = resolveBetterSqlite3Entry();
    if (!betterSqlite3Entry) throw new Error("EMBEDDING_LEASE_WATCHDOG_UNAVAILABLE");
    let worker: Worker;
    try {
      worker = new Worker(new URL("./lease-watchdog.js", import.meta.url), {
        workerData: { dbPath, betterSqlite3Entry },
        execArgv: workerExecArgv(),
      });
    } catch {
      throw new Error("EMBEDDING_LEASE_WATCHDOG_UNAVAILABLE");
    }
    const watchdog = new LeaseWatchdog(worker);
    try {
      await watchdog.waitReady(2_000);
      return watchdog;
    } catch {
      await watchdog.close();
      throw new Error("EMBEDDING_LEASE_WATCHDOG_UNAVAILABLE");
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectReady(error);
    for (const [requestId, request] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("EMBEDDING_LEASE_WATCHDOG_READY_TIMEOUT")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private request(type: "begin" | "end" | "shutdown", payload: Record<string, unknown> = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("EMBEDDING_LEASE_WATCHDOG_TIMEOUT"));
      }, 2_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.worker.postMessage({ type, requestId, ...payload });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("EMBEDDING_LEASE_WATCHDOG_FAILED"));
      }
    });
  }

  async begin(jobIds: readonly string[], ownerId: string, leaseDurationMs: number, heartbeatIntervalMs: number): Promise<void> {
    if (this.failure) throw this.failure;
    await this.request("begin", { jobIds: [...jobIds], ownerId, leaseDurationMs, heartbeatIntervalMs });
    if (this.failure) throw this.failure;
  }

  async end(): Promise<void> {
    if (this.closed) return;
    try { await this.request("end"); } catch { /* cleanup is best effort; completion remains guarded */ }
  }

  error(): Error | null { return this.failure; }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.request("shutdown"); } catch { /* terminate below bounds cleanup */ }
    this.closing = true;
    this.closed = true;
    this.pending.clear();
    await this.worker.terminate().catch(() => -1);
  }
}

export interface SemanticDrainResult {
  generations: number;
  activated: number;
  readyChunks: number;
  failedChunks: number;
}

export function enqueueSemanticGeneration(input: {
  store: KnowledgeStore;
  repoId: string;
  snapshotId: string;
  scopeKey: string;
  space: EmbeddingSpaceIdentity;
  chunkIds?: readonly string[];
}): SemanticEnqueueResult {
  const space = createEmbeddingSpace(input.store, input.space);
  const ids = input.chunkIds ?? (input.store.db.prepare(
    "SELECT id FROM semantic_chunks WHERE repo_id=? AND snapshot_id=? ORDER BY id",
  ).all(input.repoId, input.snapshotId) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) throw new Error("EMBEDDING_NO_CHUNKS");
  if (input.scopeKey !== `repo:${input.repoId}`) throw new Error("EMBEDDING_SCOPE_REPOSITORY_MISMATCH");
  const matchingChunks = Number((input.store.db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS n
      FROM json_each(?) requested
      JOIN semantic_chunks c ON c.id=requested.value
     WHERE c.repo_id=? AND c.snapshot_id=?
  `).get(JSON.stringify(ids), input.repoId, input.snapshotId) as { n: number }).n);
  if (matchingChunks !== ids.length) throw new Error("EMBEDDING_CHUNK_SCOPE_MISMATCH");
  const active = input.store.db.prepare(`
    SELECT g.id
      FROM semantic_active_spaces a
      JOIN embedding_generations g ON g.id=a.generation_id
     WHERE a.scope_key=? AND g.snapshot_id=? AND g.space_id=? AND g.status='active'
  `).get(input.scopeKey, input.snapshotId, space.id) as { id: string } | undefined;
  if (active) {
    return {
      status: "active",
      generationId: active.id,
      expectedChunks: ids.length,
      readyChunks: ids.length,
      supersededGenerations: 0,
      spaceId: space.id,
    };
  }

  const lifecycle = new EmbeddingLifecycle(input.store);
  let generationId = "";
  let supersededGenerations = 0;
  const tx = input.store.db.transaction(() => {
    input.store.db.prepare(`
      UPDATE embedding_generations
         SET status='staging',expected_chunks=?,failure_reason=NULL,activated_at=NULL,retired_at=NULL
       WHERE space_id=? AND snapshot_id=? AND scope_key=? AND status='failed'
         AND failure_reason='SUPERSEDED_BY_NEWER_SNAPSHOT'
    `).run(ids.length, space.id, input.snapshotId, input.scopeKey);
    const generation = lifecycle.createGeneration({
      spaceId: space.id,
      snapshotId: input.snapshotId,
      scopeKey: input.scopeKey,
      expectedChunks: ids.length,
    });
    generationId = generation.id;
    if (generation.status !== "staging") throw new Error("EMBEDDING_GENERATION_NOT_STAGING");
    const superseded = input.store.db.prepare(`
      UPDATE embedding_generations
         SET status='failed',failure_reason='SUPERSEDED_BY_NEWER_SNAPSHOT'
       WHERE scope_key=? AND status='staging' AND id<>?
         AND (snapshot_id<>? OR space_id<>?)
    `).run(input.scopeKey, generation.id, input.snapshotId, space.id);
    supersededGenerations = superseded.changes;
    input.store.db.prepare(`
      UPDATE embedding_jobs
         SET status='failed',error='SUPERSEDED_BY_NEWER_SNAPSHOT',lease_owner=NULL,
             lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
       WHERE generation_id IN (
         SELECT id FROM embedding_generations
          WHERE scope_key=? AND status='failed' AND failure_reason='SUPERSEDED_BY_NEWER_SNAPSHOT'
       ) AND status IN ('pending','running','failed')
    `).run(new Date().toISOString(), input.scopeKey);
    for (const chunkId of ids) lifecycle.createJob({ generationId: generation.id, chunkId });
    input.store.db.prepare(`
      UPDATE embedding_jobs
         SET status='pending',attempts=0,error=NULL,lease_owner=NULL,
             lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
       WHERE generation_id=? AND status='failed' AND error='SUPERSEDED_BY_NEWER_SNAPSHOT'
    `).run(new Date().toISOString(), generation.id);
  });
  tx();
  const ready = input.store.db.prepare(
    "SELECT COALESCE(SUM(status='ready'),0) AS ready FROM embedding_jobs WHERE generation_id=?",
  ).get(generationId) as { ready: number };
  return {
    status: "queued",
    generationId,
    expectedChunks: ids.length,
    readyChunks: ready.ready,
    supersededGenerations,
    spaceId: space.id,
  };
}

function spaceIdentityForProvider(store: KnowledgeStore, provider: EmbeddingProvider): EmbeddingSpaceIdentity | undefined {
  return store.db.prepare(`
    SELECT provider_id AS providerId,model_id AS modelId,weights_digest AS weightsDigest,
           tokenizer_digest AS tokenizerDigest,preprocessing_digest AS preprocessingDigest,
           dimensions,pooling,normalization,chunker_version AS chunkerVersion
      FROM embedding_spaces WHERE identity_hash=?
  `).get(provider.modelHash) as EmbeddingSpaceIdentity | undefined;
}

export async function drainSemanticQueue(input: SemanticDrainInput): Promise<SemanticDrainResult> {
  const maxBatchesPerRound = input.maxBatchesPerRound ?? 1;
  if (!Number.isInteger(maxBatchesPerRound) || maxBatchesPerRound < 1 || maxBatchesPerRound > 256) {
    throw new Error("EMBEDDING_MAX_BATCHES_PER_ROUND_INVALID");
  }
  const space = spaceIdentityForProvider(input.store, input.provider);
  if (!space) throw new Error("EMBEDDING_SPACE_NOT_REGISTERED");
  const generations = input.store.db.prepare(`
    SELECT g.id,g.space_id AS spaceId,g.snapshot_id AS snapshotId,g.scope_key AS scopeKey
      FROM embedding_generations g
      JOIN embedding_spaces s ON s.id=g.space_id
     WHERE s.identity_hash=?
       AND (
         g.status='staging'
         OR (g.status='active' AND EXISTS (
           SELECT 1 FROM embedding_jobs pending
            WHERE pending.generation_id=g.id
              AND pending.status IN ('pending','running','failed')
         ))
       )
     -- A replacement staging generation is the work that makes the newest
     -- index queryable. Older active partial generations remain a fallback,
     -- but must not monopolise the single durable worker before the new
     -- snapshot has even started embedding.
     ORDER BY CASE WHEN g.status='staging' THEN 0 ELSE 1 END,g.created_at,g.id
  `).all(input.provider.modelHash) as Array<{ id: string; spaceId: string; snapshotId: string; scopeKey: string }>;
  let activated = 0;
  let readyChunks = 0;
  let failedChunks = 0;
  const reusePlans = input.schedulerState?.reusePlans ?? new Map<string, ReadonlyMap<string, string>>();
  if (input.schedulerState && !input.schedulerState.reusePlans) input.schedulerState.reusePlans = reusePlans;
  const leaseWatchdog = input.leaseWatchdog ?? await LeaseWatchdog.open(input.store);
  const loadSource = input.store.db.prepare(`
    SELECT c.canonical_file_path AS canonicalFilePath,
           c.start_byte AS startByte,c.end_byte AS endByte,b.decoded_content AS text
      FROM semantic_chunks c JOIN source_blobs b ON b.id=c.source_blob_id
     WHERE c.id=?
  `);
  try {
    for (const generation of generations) {
      if (input.signal?.aborted) break;
      const reusePlan = reusePlans.get(generation.id) ?? reusableSourceChunks(
        input.store,
        generation.snapshotId,
        input.provider.modelHash,
        generation.spaceId,
      );
      reusePlans.set(generation.id, reusePlan);
      const backfill = await backfillEmbeddings({
        store: input.store,
        provider: input.provider,
        space,
        snapshotId: generation.snapshotId,
        scopeKey: generation.scopeKey,
        generationId: generation.id,
        reusePlan,
        // Queue drains are worker-facing and use the throughput default; the
        // lower-level backfill API keeps its conservative direct-call default.
        batchSize: input.batchSize ?? 128,
        signal: input.signal,
        ownerId: input.ownerId,
        maxBatches: maxBatchesPerRound,
        schedulerState: input.schedulerState,
        leaseWatchdog: leaseWatchdog ?? undefined,
        onProgress: input.onProgress,
        onBatchTiming: input.onBatchTiming,
        onCheckpointFailure: input.onCheckpointFailure,
        textLoader: (chunkId) => {
          const row = loadSource.get(chunkId) as { canonicalFilePath: string; startByte: number; endByte: number; text: string } | undefined;
          if (!row) throw new Error("SEMANTIC_CHUNK_SOURCE_MISSING");
          const source = Buffer.from(row.text, "utf8").subarray(row.startByte, row.endByte).toString("utf8");
          return `file: ${row.canonicalFilePath}\n${source}`;
        },
      });
      readyChunks += backfill.checkpoint.readyChunks;
      failedChunks += backfill.checkpoint.failedChunks;
      if (!backfill.checkpoint.cancelled && backfill.checkpoint.failedChunks === 0) {
        const current = new EmbeddingLifecycle(input.store).getGeneration(generation.id);
        if (current?.status === "staging"
          && backfill.checkpoint.readyChunks === backfill.checkpoint.expectedChunks) {
          activateEmbeddingGeneration(input.store, generation.id);
          activated += 1;
        } else if (current?.status === "staging"
          && backfill.checkpoint.readyChunks >= Math.max(1, input.bootstrapReadyChunks ?? 512)) {
          // A clean install has no older active semantic generation. Publish a
          // bounded bootstrap lane so search becomes useful quickly; updates
          // keep the old active generation until the replacement is complete.
          try {
            new EmbeddingLifecycle(input.store).activatePartialGeneration(
              generation.id,
              Math.max(1, input.bootstrapReadyChunks ?? 512),
            );
            activated += 1;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "EMBEDDING_PARTIAL_ACTIVE_GENERATION_EXISTS") throw error;
          }
        }
      }
    }
  } finally {
    await leaseWatchdog?.close();
  }
  return { generations: generations.length, activated, readyChunks, failedChunks };
}

function chunksById(store: KnowledgeStore, ids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const get = store.db.prepare("SELECT id,text_hash AS textHash FROM semantic_chunks WHERE id=?");
  for (const id of ids) {
    const row = get.get(id) as { id: string; textHash: string } | undefined;
    if (!row) throw new Error("SEMANTIC_CHUNK_NOT_FOUND");
    result.set(row.id, row.textHash);
  }
  return result;
}

function checkpoint(
  store: KnowledgeStore,
  generationId: string,
  expectedChunks: number,
  cancelled: boolean,
  counters?: { lastChunkId: string | null; readyChunks: number; failedChunks: number },
): EmbeddingBackfillCheckpoint {
  const row = counters ?? (store.db.prepare(`
    SELECT COALESCE(MAX(j.chunk_id),'') AS lastChunkId,
           COALESCE(SUM(j.status='ready'),0) AS readyChunks,
           COALESCE(SUM(j.status='failed'),0) AS failedChunks
      FROM embedding_jobs j WHERE j.generation_id=?
  `).get(generationId) as { lastChunkId: string; readyChunks: number; failedChunks: number });
  const result = { generationId, lastChunkId: row.lastChunkId || null, expectedChunks, readyChunks: row.readyChunks, failedChunks: row.failedChunks, cancelled };
  recordSemanticProgressSample(store, generationId, result.readyChunks);
  return result;
}

function reusableSourceChunks(store: KnowledgeStore, snapshotId: string, modelHash: string, spaceId: string): Map<string, string> {
  const rows = store.db.prepare(`
    SELECT current.id AS currentChunkId,old.id AS sourceChunkId
      FROM semantic_chunks current
      JOIN semantic_chunks old
        ON old.id<>current.id
       AND old.repo_id=current.repo_id
       AND old.canonical_file_path=current.canonical_file_path
       AND old.content_hash=current.content_hash
       AND old.chunker_version=current.chunker_version
      JOIN semantic_embedding_refs r ON r.chunk_id=old.id AND r.model_hash=? AND r.space_id=? AND r.status='ready'
      JOIN embedding_generations g ON g.id=r.generation_id
       AND (g.status IN ('active','retired') OR (g.status='failed' AND g.failure_reason='SUPERSEDED_BY_NEWER_SNAPSHOT'))
     WHERE current.snapshot_id=?
     ORDER BY current.id,CASE WHEN g.status='active' THEN 0 ELSE 1 END,g.activated_at DESC,old.id
  `).all(modelHash, spaceId, snapshotId) as Array<{ currentChunkId: string; sourceChunkId: string }>;
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!result.has(row.currentChunkId)) result.set(row.currentChunkId, row.sourceChunkId);
  }
  return result;
}

/**
 * Resumable index-time embedding. Documents are read from persisted chunk
 * rows, embedded in batches, and written into a staging generation. The caller
 * must explicitly activate the returned generation; no partial batch is
 * queryable.
 */
export async function backfillEmbeddings(input: EmbeddingBackfillInput): Promise<EmbeddingBackfillResult> {
  // Keep the scheduler's default conservative. The transformers backend can
  // still split each claimed batch into larger inference waves, while the
  // scheduler bound protects SQLite/WAL and keeps progress fairly observable.
  // Callers can raise this explicitly after measuring their machine.
  const batchSize = input.batchSize ?? 32;
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 20_000;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("EMBEDDING_BATCH_SIZE_INVALID");
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 20 || !Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 5 || heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error("EMBEDDING_LEASE_TIMING_INVALID");
  }
  if (input.provider.dimensions !== input.space.dimensions) throw new Error("DIMENSION_MISMATCH");
  const space = createEmbeddingSpace(input.store, input.space);
  const vectorStore = new VectorStore(input.store);
  vectorStore.ensureModel(input.provider);
  if (input.provider.modelHash !== space.identityHash) throw new Error("EMBEDDING_PROVIDER_IDENTITY_MISMATCH");
  const lifecycle = new EmbeddingLifecycle(input.store);
  const existingGeneration = input.generationId ? lifecycle.getGeneration(input.generationId) : undefined;
  if (input.generationId) {
    if (!existingGeneration) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (!['staging', 'active'].includes(existingGeneration.status)) throw new Error("EMBEDDING_GENERATION_NOT_STAGING");
    if (existingGeneration.spaceId !== space.id) throw new Error("EMBEDDING_SPACE_MISMATCH");
    if (existingGeneration.snapshotId !== input.snapshotId || existingGeneration.scopeKey !== input.scopeKey) {
      throw new Error("EMBEDDING_GENERATION_SCOPE_MISMATCH");
    }
  }
  const ids = input.generationId
    ? []
    : input.chunkIds ?? (input.store.db.prepare("SELECT id FROM semantic_chunks WHERE snapshot_id=? ORDER BY id").all(input.snapshotId) as Array<{ id: string }>).map((row) => row.id);
  const chunks = input.generationId ? new Map<string, string>() : chunksById(input.store, ids);
  if (!input.generationId && !chunks.size) throw new Error("EMBEDDING_NO_CHUNKS");
  const schedulerState = input.schedulerState ?? { completedBatches: 0 };
  const completeBatch = (): void => {
    schedulerState.completedBatches += 1;
    if (schedulerState.completedBatches % 8 === 0) {
      try {
        // SQLite reports ordinary reader/writer contention in the returned
        // busy count. A thrown exception is therefore an actual checkpoint
        // failure (for example IOERR), not a normal busy result.
        input.store.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        input.onCheckpointFailure?.({
          code: "WAL_CHECKPOINT_FAILED",
          completedBatches: schedulerState.completedBatches,
        });
      }
    }
  };
  const ownerId = input.ownerId ?? `embedding-backfill:${process.pid}:${randomUUID()}`;
  const generation = existingGeneration ?? lifecycle.createGeneration({ spaceId: space.id, snapshotId: input.snapshotId, scopeKey: input.scopeKey, expectedChunks: chunks.size });
  if (!existingGeneration) {
    for (const id of chunks.keys()) lifecycle.createJob({ generationId: generation.id, chunkId: id });
  }
  lifecycle.reclaimExpiredJobs(new Date().toISOString(), generation.id);

  // Build the reuse plan once. The previous implementation called a JOIN for
  // every pending chunk inside every batch iteration. A first-time backfill has
  // no reusable vectors, turning N chunks into roughly N²/(2*batchSize) SQLite
  // probes (64 chunks with batchSize=8 already produced 288 queries).
  const reusableChunks = input.reusePlan ?? reusableSourceChunks(
    input.store,
    input.snapshotId,
    input.provider.modelHash,
    space.id,
  );
  const expectedChunks = generation.expectedChunks;
  let cancelled = false;
  let completedBatches = 0;
  const initial = checkpoint(input.store, generation.id, expectedChunks, false);
  let lastChunkId = initial.lastChunkId;
  let readyChunks = initial.readyChunks;
  let failedChunks = initial.failedChunks;
  const emitProgress = (): void => {
    input.onProgress?.(checkpoint(input.store, generation.id, expectedChunks, false, {
      lastChunkId,
      readyChunks,
      failedChunks,
    }));
  };
  input.onProgress?.(initial);
  const ownsLeaseWatchdog = !input.leaseWatchdog;
  const leaseWatchdog = input.leaseWatchdog ?? await LeaseWatchdog.open(input.store);
  try {
    while (true) {
      if (input.maxBatches !== undefined && completedBatches >= input.maxBatches) break;
      if (input.signal?.aborted) { cancelled = true; break; }
      const now = new Date();
      const adaptiveBatching = input.batchSize === undefined;
      const batchStartedAt = performance.now();
      const claimStartedAt = performance.now();
      const claimed = lifecycle.claimJobs({
        ownerId,
        generationId: generation.id,
        limit: batchSize,
        minimumBatchSize: adaptiveBatching ? 1 : batchSize,
        paddingBudgetBytes: adaptiveBatching ? batchSize * 4_096 : undefined,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      });
      const claimWaitMs = performance.now() - claimStartedAt;
      if (!claimed.length) break;
      completedBatches += 1;
      lastChunkId = claimed[claimed.length - 1].chunkId;
      let sourceLoadMs = 0;
      let inferenceMs = 0;
      let validationMs = 0;
      let vectorWriteMs = 0;
      let commitMs = 0;
      let providerCalls = 0;
      let committedChunks = 0;
      let failedInBatch = 0;
      const emitBatchTiming = (outcome: SemanticBatchTiming["outcome"], errorCode?: string): void => {
        input.onBatchTiming?.({
          generationId: generation.id,
          claimedChunks: claimed.length,
          committedChunks,
          failedChunks: failedInBatch,
          providerCalls,
          claimWaitMs,
          sourceLoadMs,
          inferenceMs,
          validationMs,
          vectorWriteMs,
          commitMs,
          totalMs: performance.now() - batchStartedAt,
          outcome,
          ...(errorCode ? { errorCode } : {}),
        });
      };

      const embeddingJobs: EmbeddingJobRecord[] = [];
      for (const job of claimed) {
        const sourceChunkId = reusableChunks.get(job.chunkId);
        if (!sourceChunkId) {
          embeddingJobs.push(job);
          continue;
        }
        try {
          const transactionStartedAt = performance.now();
          let vectorWriteFinishedAt = transactionStartedAt;
          input.store.db.transaction(() => {
            vectorStore.copy(input.provider.modelHash, sourceChunkId, job.chunkId, { generationId: generation.id, spaceId: space.id });
            vectorWriteFinishedAt = performance.now();
            lifecycle.completeClaimedJob(job.id, ownerId);
          })();
          vectorWriteMs += vectorWriteFinishedAt - transactionStartedAt;
          commitMs += performance.now() - vectorWriteFinishedAt;
          readyChunks += 1;
          committedChunks += 1;
        } catch (error) {
          try {
            lifecycle.failClaimedJob(job.id, ownerId, error instanceof Error ? error.message : "EMBEDDING_REUSE_FAILED");
          } catch (failure) {
            if (!(failure instanceof Error) || failure.message !== "EMBEDDING_JOB_OWNERSHIP_LOST") throw failure;
          }
          if (error instanceof Error && error.message === "EMBEDDING_JOB_OWNERSHIP_LOST") throw error;
          failedInBatch += 1;
        }
      }
      if (!embeddingJobs.length) {
        emitProgress();
        emitBatchTiming(failedInBatch > 0 ? "recovered" : "committed");
        completeBatch();
        continue;
      }

      let heartbeatError: unknown;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      try {
        if (leaseWatchdog) {
          await leaseWatchdog.begin(
            embeddingJobs.map((job) => job.id),
            ownerId,
            leaseDurationMs,
            heartbeatIntervalMs,
          );
        } else {
          heartbeat = setInterval(() => {
            try {
              const heartbeatNow = new Date();
              const count = lifecycle.heartbeatJobs({
                ownerId,
                jobIds: embeddingJobs.map((job) => job.id),
                now: heartbeatNow.toISOString(),
                leaseExpiresAt: new Date(heartbeatNow.getTime() + leaseDurationMs).toISOString(),
              });
              if (count !== embeddingJobs.length) heartbeatError = new Error("EMBEDDING_JOB_OWNERSHIP_LOST");
            } catch (error) {
              heartbeatError = error;
            }
          }, heartbeatIntervalMs);
          heartbeat.unref();
        }
        const sourceLoadStartedAt = performance.now();
        const texts = await Promise.all(embeddingJobs.map((job) => input.textLoader(job.chunkId)));
        sourceLoadMs += performance.now() - sourceLoadStartedAt;
        if (texts.some((text) => typeof text !== "string")) throw new Error("EMBEDDING_TEXT_LOADER_INVALID");
        const inferenceStartedAt = performance.now();
        providerCalls += 1;
        const vectors = input.provider.embedDocuments
          ? await input.provider.embedDocuments(texts)
          : await input.provider.embed(texts);
        inferenceMs += performance.now() - inferenceStartedAt;
        const validationStartedAt = performance.now();
        const watchdogError = leaseWatchdog?.error();
        if (watchdogError) throw watchdogError;
        if (heartbeatError) throw heartbeatError;
        if (vectors.length !== embeddingJobs.length || vectors.some((vector) => !(vector instanceof Float32Array) || vector.length !== input.provider.dimensions || [...vector].some((value) => !Number.isFinite(value)))) throw new Error("EMBEDDING_RESPONSE_INVALID");
        validationMs += performance.now() - validationStartedAt;
        const transactionStartedAt = performance.now();
        let vectorWriteFinishedAt = transactionStartedAt;
        input.store.db.transaction(() => {
          vectorStore.putBatch(
            input.provider.modelHash,
            embeddingJobs.map((job, index) => ({ chunkId: job.chunkId, vector: vectors[index] })),
            { generationId: generation.id, spaceId: space.id },
          );
          vectorWriteFinishedAt = performance.now();
          for (const job of embeddingJobs) lifecycle.completeClaimedJob(job.id, ownerId);
        })();
        vectorWriteMs += vectorWriteFinishedAt - transactionStartedAt;
        commitMs += performance.now() - vectorWriteFinishedAt;
        readyChunks += embeddingJobs.length;
        committedChunks += embeddingJobs.length;
        failedChunks = Math.max(0, failedChunks - embeddingJobs.filter((job) => job.attempts > 1).length);
        emitProgress();
        emitBatchTiming("committed");
        completeBatch();
      } catch (error) {
        // A single claimed job has no neighbouring work to isolate. Retrying
        // it inside this same call would silently turn a provider failure into
        // a success and would violate the resumable-failure contract.
        if (embeddingJobs.length === 1) {
          const job = embeddingJobs[0];
          lifecycle.failClaimedJob(job.id, ownerId, error instanceof Error ? error.message : "EMBEDDING_FAILED");
          if (job.attempts === 1) failedChunks += 1;
          failedInBatch += 1;
          emitBatchTiming("failed", error instanceof Error ? error.message : "EMBEDDING_FAILED");
          throw error;
        }
        // A provider, source or vector error may belong to one chunk only.
        // Retry the claimed batch one item at a time before fan-out marking;
        // otherwise a single poison chunk makes every healthy neighbour look
        // failed and needlessly multiplies the retry backlog.
        let isolatedFailures = 0;
        for (const job of embeddingJobs) {
          try {
            const sourceLoadStartedAt = performance.now();
            const text = await input.textLoader(job.chunkId);
            sourceLoadMs += performance.now() - sourceLoadStartedAt;
            if (typeof text !== "string") throw new Error("EMBEDDING_TEXT_LOADER_INVALID");
            const inferenceStartedAt = performance.now();
            providerCalls += 1;
            const vectors = input.provider.embedDocuments
              ? await input.provider.embedDocuments([text])
              : await input.provider.embed([text]);
            inferenceMs += performance.now() - inferenceStartedAt;
            const vector = vectors[0];
            const validationStartedAt = performance.now();
            if (vectors.length !== 1 || !(vector instanceof Float32Array) || vector.length !== input.provider.dimensions || [...vector].some((value) => !Number.isFinite(value))) {
              throw new Error("EMBEDDING_RESPONSE_INVALID");
            }
            const watchdogError = leaseWatchdog?.error();
            if (watchdogError) throw watchdogError;
            if (heartbeatError) throw heartbeatError;
            validationMs += performance.now() - validationStartedAt;
            const transactionStartedAt = performance.now();
            let vectorWriteFinishedAt = transactionStartedAt;
            input.store.db.transaction(() => {
              vectorStore.putBatch(
                input.provider.modelHash,
                [{ chunkId: job.chunkId, vector }],
                { generationId: generation.id, spaceId: space.id },
              );
              vectorWriteFinishedAt = performance.now();
              lifecycle.completeClaimedJob(job.id, ownerId);
            })();
            vectorWriteMs += vectorWriteFinishedAt - transactionStartedAt;
            commitMs += performance.now() - vectorWriteFinishedAt;
            readyChunks += 1;
            committedChunks += 1;
            if (job.attempts > 1) failedChunks = Math.max(0, failedChunks - 1);
          } catch (failure) {
            if (failure instanceof Error && failure.message === "EMBEDDING_JOB_OWNERSHIP_LOST") throw failure;
            isolatedFailures += 1;
            failedInBatch += 1;
            lifecycle.failClaimedJob(job.id, ownerId, failure instanceof Error ? failure.message : "EMBEDDING_FAILED");
            if (job.attempts === 1) failedChunks += 1;
          }
        }
        emitBatchTiming(isolatedFailures === embeddingJobs.length ? "failed" : "recovered", error instanceof Error ? error.message : "EMBEDDING_FAILED");
        if (isolatedFailures === embeddingJobs.length) throw error;
        emitProgress();
        completeBatch();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (leaseWatchdog) await leaseWatchdog.end();
      }
    }
  } finally {
    if (ownsLeaseWatchdog) await leaseWatchdog?.close();
  }
  const final = checkpoint(input.store, generation.id, expectedChunks, cancelled, {
    lastChunkId,
    readyChunks,
    failedChunks,
  });
  return { checkpoint: final, activated: false, spaceId: space.id };
}

/** Activate only after a separate text-aware worker has completed all jobs. */
export function activateEmbeddingGeneration(store: KnowledgeStore, generationId: string): EmbeddingBackfillResult {
  const lifecycle = new EmbeddingLifecycle(store);
  const generation = lifecycle.activateGeneration(generationId);
  const row = store.db.prepare("SELECT expected_chunks AS expectedChunks FROM embedding_generations WHERE id=?").get(generationId) as { expectedChunks: number };
  return { checkpoint: checkpoint(store, generationId, row.expectedChunks, false), activated: generation.status === "active", spaceId: generation.spaceId };
}

export function garbageCollectEmbeddingVectors(store: KnowledgeStore, modelHash?: string): { refs: number; vectors: number } {
  return new VectorStore(store).garbageCollect(modelHash);
}
