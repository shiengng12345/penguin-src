import { canonicalJson, sha256Hex } from "./canonical.js";
import { existsSync } from "node:fs";
import type { SemanticControlRequest } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import { AuditStore } from "./audit.js";
import { embeddingSpaceIdentity, type EmbeddingSpaceIdentity, type EmbeddingSpaceIdentityResult } from "./semantic-identity.js";

export type EmbeddingGenerationStatus = "staging" | "active" | "retired" | "failed";
export type EmbeddingJobStatus = "pending" | "running" | "ready" | "failed" | "deleting";

export interface EmbeddingSpaceRecord extends EmbeddingSpaceIdentityResult { createdAt: string; }
export interface EmbeddingGenerationRecord {
  id: string;
  spaceId: string;
  snapshotId: string;
  scopeKey: string;
  status: EmbeddingGenerationStatus;
  expectedChunks: number;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  failureReason: string | null;
}
export interface EmbeddingJobRecord {
  id: string;
  generationId: string;
  chunkId: string;
  status: EmbeddingJobStatus;
  attempts: number;
  error: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
}

export interface SemanticControlRecord {
  scopeKey: string;
  pauseRequested: boolean;
  cancelledGenerationId: string | null;
  updatedAt: string;
}

export interface SemanticWorkerLeaseRecord {
  lockName: string;
  ownerId: string;
  ownerPid: number;
  buildId: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface ClaimEmbeddingJobsInput {
  ownerId: string;
  generationId: string;
  limit: number;
  now?: string;
  leaseExpiresAt: string;
  minimumBatchSize?: number;
  paddingBudgetBytes?: number;
}

export interface HeartbeatEmbeddingJobsInput {
  ownerId: string;
  jobIds: readonly string[];
  now?: string;
  leaseExpiresAt: string;
}

export function createEmbeddingSpace(store: KnowledgeStore, identity: EmbeddingSpaceIdentity): EmbeddingSpaceRecord {
  const normalized = embeddingSpaceIdentity(identity);
  const createdAt = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO embedding_spaces
      (id,identity_hash,provider_id,model_id,weights_digest,tokenizer_digest,preprocessing_digest,dimensions,pooling,normalization,chunker_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(identity_hash) DO NOTHING
  `).run(normalized.id, normalized.identityHash, normalized.providerId, normalized.modelId, normalized.weightsDigest, normalized.tokenizerDigest, normalized.preprocessingDigest, normalized.dimensions, normalized.pooling, normalized.normalization, normalized.chunkerVersion, createdAt);
  const row = store.db.prepare(`
    SELECT id,identity_hash AS identityHash,provider_id AS providerId,model_id AS modelId,
           weights_digest AS weightsDigest,tokenizer_digest AS tokenizerDigest,
           preprocessing_digest AS preprocessingDigest,
           dimensions,pooling,normalization,chunker_version AS chunkerVersion,created_at AS createdAt
      FROM embedding_spaces WHERE identity_hash=?
  `).get(normalized.identityHash) as EmbeddingSpaceRecord | undefined;
  if (!row) throw new Error("EMBEDDING_SPACE_CREATE_FAILED");
  return row;
}

const GENERATION_TRANSITIONS: Record<EmbeddingGenerationStatus, readonly EmbeddingGenerationStatus[]> = {
  staging: ["active", "failed"],
  active: ["retired"],
  retired: [],
  failed: [],
};

const JOB_TRANSITIONS: Record<EmbeddingJobStatus, readonly EmbeddingJobStatus[]> = {
  pending: ["running", "deleting"],
  running: ["ready", "failed"],
  ready: ["deleting"],
  failed: ["pending", "deleting"],
  deleting: [],
};

const EMBEDDING_RETRY_BASE_MS = 30_000;
const EMBEDDING_RETRY_MAX_MS = 30 * 60_000;

// Only reasons created by the local embedding worker may cross the persistence
// boundary verbatim. Shape-based trust is unsafe: access keys and other
// secrets commonly look exactly like uppercase machine codes.
const PERSISTABLE_EMBEDDING_ERROR_CODES = new Set<string>([
  "EMBEDDING_FAILED",
  "EMBEDDING_REUSE_FAILED",
  "EMBEDDING_RESPONSE_INVALID",
  "EMBEDDING_TEXT_LOADER_INVALID",
  "SEMANTIC_CHUNK_SOURCE_MISSING",
  "SEMANTIC_DIMENSIONS_MISMATCH",
  "SEMANTIC_GENERATION_IDENTITY_REQUIRED",
  "SEMANTIC_GENERATION_NOT_WRITABLE",
  "SEMANTIC_MODEL_NOT_REGISTERED",
  "SEMANTIC_SOURCE_VECTOR_INVALID",
  "SEMANTIC_SOURCE_VECTOR_NOT_FOUND",
  "SEMANTIC_SPACE_MISMATCH",
  "SQLITE_VEC_MISSING",
]);

function embeddingRetryAt(now: string, attempts: number): string | null {
  if (attempts >= 5) return null;
  return new Date(
    Date.parse(now) + Math.min(EMBEDDING_RETRY_MAX_MS, EMBEDDING_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1)),
  ).toISOString();
}

/** Persist only a bounded machine code plus a correlation hash. Provider
 * messages can contain source chunks, paths, prompts, or credentials. */
function persistedEmbeddingError(error: string | undefined): string {
  const raw = String(error ?? "");
  if (PERSISTABLE_EMBEDDING_ERROR_CODES.has(raw)) return raw;
  return `EMBEDDING_FAILED_${sha256Hex(raw || "EMBEDDING_FAILED").slice(0, 12).toUpperCase()}`;
}

function embeddingMarkerOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove only a marker whose exact value still names a dead/stale owner.
 * The compare-and-delete prevents a worker from deleting a replacement marker
 * installed by a newer indexer between the read and the cleanup. */
function clearDeadIndexMarkers(store: KnowledgeStore, generationId: string): number {
  const markers = store.db.prepare(`
    SELECT marker.key,marker.value
      FROM embedding_generations g
      JOIN branches b ON b.current_snapshot_id=g.snapshot_id
      JOIN meta marker ON marker.key='index_lock::global'
                         OR marker.key='index_lock::' || b.id
     WHERE g.id=?
  `).all(generationId) as Array<{ key: string; value: string }>;
  let cleared = 0;
  for (const marker of markers) {
    let liveAndFresh = false;
    try {
      const owner = JSON.parse(marker.value) as { pid?: number; startedAt?: string };
      const ageMs = Date.now() - Date.parse(owner.startedAt ?? "");
      liveAndFresh = Number.isSafeInteger(owner.pid)
        && owner.pid! > 0
        && embeddingMarkerOwnerIsAlive(owner.pid!)
        && Number.isFinite(ageMs)
        && ageMs < 30 * 60_000;
    } catch {
      // Invalid marker payloads have no verifiable live owner and are stale.
    }
    if (!liveAndFresh) {
      cleared += store.db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(marker.key, marker.value).changes;
    }
  }
  return cleared;
}

export class EmbeddingLifecycle {
  constructor(private readonly store: KnowledgeStore) {}

  createGeneration(input: { spaceId: string; snapshotId: string; scopeKey: string; expectedChunks: number }): EmbeddingGenerationRecord {
    if (!Number.isInteger(input.expectedChunks) || input.expectedChunks < 1) throw new Error("EMBEDDING_EXPECTED_CHUNKS_INVALID");
    const space = this.store.db.prepare("SELECT id FROM embedding_spaces WHERE id=?").get(input.spaceId);
    if (!space) throw new Error("EMBEDDING_SPACE_NOT_FOUND");
    const id = `generation_${sha256Hex(canonicalJson([input.spaceId, input.snapshotId, input.scopeKey])).slice(0, 48)}`;
    const createdAt = new Date().toISOString();
    this.store.db.prepare(`
      INSERT INTO embedding_generations
        (id,space_id,snapshot_id,scope_key,status,expected_chunks,created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(space_id,snapshot_id,scope_key) DO UPDATE SET
        expected_chunks=excluded.expected_chunks
      WHERE embedding_generations.status='staging'
    `).run(id, input.spaceId, input.snapshotId, input.scopeKey, "staging", input.expectedChunks, createdAt);
    return this.getGeneration(id) ?? (() => { throw new Error("EMBEDDING_GENERATION_CREATE_FAILED"); })();
  }

  createJob(input: { generationId: string; chunkId: string }): EmbeddingJobRecord {
    const generation = this.getGeneration(input.generationId);
    if (!generation) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (!this.store.db.prepare("SELECT id FROM semantic_chunks WHERE id=?").get(input.chunkId)) throw new Error("SEMANTIC_CHUNK_NOT_FOUND");
    const id = `embedding_job_${sha256Hex(canonicalJson([input.generationId, input.chunkId])).slice(0, 48)}`;
    const now = new Date().toISOString();
    this.store.db.prepare(`
      INSERT INTO embedding_jobs (id,generation_id,chunk_id,status,attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(generation_id,chunk_id) DO NOTHING
    `).run(id, input.generationId, input.chunkId, "pending", 0, now, now);
    return this.getJob(id) ?? (() => { throw new Error("EMBEDDING_JOB_CREATE_FAILED"); })();
  }

  transitionJob(id: string, next: EmbeddingJobStatus, error?: string): EmbeddingJobRecord {
    const current = this.getJob(id);
    if (!current) throw new Error("EMBEDDING_JOB_NOT_FOUND");
    if (!JOB_TRANSITIONS[current.status].includes(next)) throw new Error("EMBEDDING_JOB_INVALID_TRANSITION");
    if (next === "running") throw new Error("EMBEDDING_JOB_CLAIM_REQUIRED");
    if (current.status === "running") throw new Error("EMBEDDING_JOB_OWNER_REQUIRED");
    const now = new Date().toISOString();
    const nextAttemptAt = next === "failed" ? embeddingRetryAt(now, current.attempts) : null;
    const persistedError = next === "failed" ? persistedEmbeddingError(error) : null;
    const result = this.store.db.prepare(`
      UPDATE embedding_jobs
         SET status=?, attempts=attempts + CASE WHEN ?='running' THEN 1 ELSE 0 END,
             error=?, lease_owner=CASE WHEN ?='running' THEN lease_owner ELSE NULL END,
             lease_expires_at=CASE WHEN ?='running' THEN lease_expires_at ELSE NULL END,
             next_attempt_at=?, updated_at=?
       WHERE id=? AND status=?
    `).run(next, next, persistedError, next, next, nextAttemptAt, now, id, current.status);
    if (result.changes !== 1) throw new Error("EMBEDDING_JOB_CONCURRENT_TRANSITION");
    return this.getJob(id)!;
  }

  completeClaimedJob(id: string, ownerId: string, now = new Date().toISOString()): EmbeddingJobRecord {
    const result = this.store.db.prepare(`
      UPDATE embedding_jobs
         SET status='ready',error=NULL,lease_owner=NULL,lease_expires_at=NULL,
             next_attempt_at=NULL,updated_at=?
       WHERE id=? AND status='running' AND lease_owner=?
         AND lease_expires_at IS NOT NULL AND lease_expires_at>?
    `).run(now, id, ownerId, now);
    if (result.changes !== 1) throw new Error("EMBEDDING_JOB_OWNERSHIP_LOST");
    return this.getJob(id)!;
  }

  failClaimedJob(id: string, ownerId: string, error: string, now = new Date().toISOString()): EmbeddingJobRecord {
    const current = this.getJob(id);
    if (!current) throw new Error("EMBEDDING_JOB_NOT_FOUND");
    const nextAttemptAt = embeddingRetryAt(now, current.attempts);
    const sanitized = persistedEmbeddingError(error);
    const result = this.store.db.prepare(`
      UPDATE embedding_jobs
         SET status='failed',error=?,lease_owner=NULL,lease_expires_at=NULL,
             next_attempt_at=?,updated_at=?
       WHERE id=? AND status='running' AND lease_owner=?
         AND lease_expires_at IS NOT NULL AND lease_expires_at>?
    `).run(sanitized, nextAttemptAt, now, id, ownerId, now);
    if (result.changes !== 1) throw new Error("EMBEDDING_JOB_OWNERSHIP_LOST");
    return this.getJob(id)!;
  }

  /**
   * Atomically claim a bounded batch. The guarded UPDATE ... RETURNING is the
   * ownership boundary: two CLI/MCP workers can never receive the same job.
   */
  claimJobs(input: ClaimEmbeddingJobsInput): EmbeddingJobRecord[] {
    if (!input.ownerId.trim()) throw new Error("EMBEDDING_WORKER_OWNER_REQUIRED");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) throw new Error("EMBEDDING_CLAIM_LIMIT_INVALID");
    const now = input.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(input.leaseExpiresAt)) || input.leaseExpiresAt <= now) {
      throw new Error("EMBEDDING_LEASE_INVALID");
    }
    const minimumBatchSize = input.minimumBatchSize ?? input.limit;
    const paddingBudgetBytes = input.paddingBudgetBytes ?? 0;
    const resetFencePath = `${this.store.db.name}.full-reset.lock`;
    // The durable reset fence outlives the transient SQLite writer marker
    // while protected-asset hashes are verified. Semantic publication must
    // remain quiesced for that whole interval, including the pre-transaction
    // race with reset marker acquisition.
    if (existsSync(resetFencePath)) return [];
    const claim = this.store.db.transaction(() => {
      if (existsSync(resetFencePath)) return [];
      clearDeadIndexMarkers(this.store, input.generationId);
      const rows = this.store.db.prepare(`
        WITH ranked AS (
        SELECT j.id,MAX(1,c.end_byte-c.start_byte) AS chunk_bytes,
               ROW_NUMBER() OVER (ORDER BY MAX(1,c.end_byte-c.start_byte),j.chunk_id) AS row_number
          FROM embedding_jobs j
          JOIN embedding_generations g ON g.id=j.generation_id
          JOIN semantic_chunks c ON c.id=j.chunk_id
         WHERE j.generation_id=?
           AND g.status IN ('staging','active')
           AND (
             j.status='pending'
             OR (j.status='failed' AND j.attempts<5 AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?))
           )
           AND NOT EXISTS (
             SELECT 1 FROM semantic_controls control
              WHERE control.scope_key=g.scope_key AND control.pause_requested=1
           )
           AND NOT EXISTS (
             SELECT 1 FROM branches b
             JOIN meta marker ON marker.key='index_lock::' || b.id
              WHERE b.current_snapshot_id=g.snapshot_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM meta marker
              WHERE marker.key='index_lock::global'
           )
         GROUP BY j.id
         ORDER BY chunk_bytes,j.chunk_id
         LIMIT ?
      ), selected AS (
        SELECT id FROM ranked
         WHERE row_number<=? OR (? > 0 AND chunk_bytes*row_number<=?)
      )
      UPDATE embedding_jobs
         SET status='running', attempts=attempts+1, error=NULL,
             lease_owner=?, lease_expires_at=?, next_attempt_at=NULL, updated_at=?
       WHERE id IN (SELECT id FROM selected)
         AND (
           status='pending'
           OR (status='failed' AND attempts<5 AND (next_attempt_at IS NULL OR next_attempt_at<=?))
         )
      RETURNING id,generation_id AS generationId,chunk_id AS chunkId,status,attempts,error,
                lease_owner AS leaseOwner,lease_expires_at AS leaseExpiresAt,next_attempt_at AS nextAttemptAt
      `).all(
        input.generationId,
        now,
        input.limit,
        minimumBatchSize,
        paddingBudgetBytes,
        paddingBudgetBytes,
        input.ownerId,
        input.leaseExpiresAt,
        now,
        now,
      ) as EmbeddingJobRecord[];
      const sizes = new Map((this.store.db.prepare(`
        SELECT id,MAX(1,end_byte-start_byte) AS bytes FROM semantic_chunks
         WHERE id IN (${rows.map(() => "?").join(",") || "NULL"})
      `).all(...rows.map((row) => row.chunkId)) as Array<{ id: string; bytes: number }>).map((row) => [row.id, row.bytes]));
      return rows.sort((a, b) => (sizes.get(a.chunkId) ?? 0) - (sizes.get(b.chunkId) ?? 0) || a.chunkId.localeCompare(b.chunkId));
    });
    return claim.immediate();
  }

  heartbeatJobs(input: HeartbeatEmbeddingJobsInput): number {
    if (input.jobIds.length === 0) return 0;
    const now = input.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(input.leaseExpiresAt)) || input.leaseExpiresAt <= now) {
      throw new Error("EMBEDDING_LEASE_INVALID");
    }
    const update = this.store.db.prepare(`
      UPDATE embedding_jobs
         SET lease_expires_at=?,updated_at=?
       WHERE id=? AND status='running' AND lease_owner=?
         AND lease_expires_at IS NOT NULL AND lease_expires_at>?
    `);
    const tx = this.store.db.transaction(() => input.jobIds.reduce(
      (count, id) => count + update.run(input.leaseExpiresAt, now, id, input.ownerId, now).changes,
      0,
    ));
    return tx();
  }

  reclaimExpiredJobs(now = new Date().toISOString(), generationId?: string): number {
    const result = this.store.db.prepare(`
      UPDATE embedding_jobs
         SET status=CASE WHEN attempts<5 THEN 'pending' ELSE 'failed' END,
             error='EMBEDDING_WORKER_LEASE_EXPIRED',lease_owner=NULL,
             lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
       WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
         AND (? IS NULL OR generation_id=?)
    `).run(now, now, generationId ?? null, generationId ?? null);
    return result.changes;
  }

  /** Apply one canonical semantic control exactly once per operation token.
   * The audit row and lifecycle transition share one SQLite transaction: a
   * crash cannot persist the token without the mutation or vice versa. */
  applyControl(request: SemanticControlRequest): { replayed: boolean } {
    const eventId = `semantic-control:${sha256Hex(request.operationToken)}`;
    const inputDigest = sha256Hex(canonicalJson({
      action: request.action,
      scopeKey: request.scopeKey,
      generationId: request.generationId ?? null,
    }));
    const scopeHash = sha256Hex(canonicalJson({ scopeKey: request.scopeKey }));
    const apply = this.store.db.transaction(() => {
      const prior = this.store.db.prepare(`
        SELECT capability_id AS capabilityId,scope_hash AS scopeHash,input_digest AS inputDigest
          FROM knowledge_audit_events WHERE event_id=?
      `).get(eventId) as { capabilityId: string; scopeHash: string; inputDigest: string } | undefined;
      if (prior) {
        if (prior.capabilityId !== "knowledge.semantic_control" || prior.scopeHash !== scopeHash || prior.inputDigest !== inputDigest) {
          throw Object.assign(new Error("OPERATION_TOKEN_CONFLICT: operationToken was already used for a different semantic control"), {
            code: "OPERATION_TOKEN_CONFLICT",
            operationToken: request.operationToken,
          });
        }
        return { replayed: true };
      }

      new AuditStore(this.store).append({
        capabilityId: "knowledge.semantic_control",
        actorId: "owner-local",
        scopeHash,
        input: {
          action: request.action,
          scopeKey: request.scopeKey,
          generationId: request.generationId ?? null,
        },
        resultCode: "accepted",
      }, { eventId, inputDigest });

      if (request.action === "pause") this.requestPause(request.scopeKey);
      else if (request.action === "resume") this.resumeScope(request.scopeKey);
      else if (request.action === "retry") this.retryFailures(request.generationId!);
      else this.cancelGeneration(request.generationId!);
      return { replayed: false };
    });
    return apply.immediate();
  }

  requestPause(scopeKey: string): SemanticControlRecord {
    const now = new Date().toISOString();
    this.store.db.prepare(`
      INSERT INTO semantic_controls(scope_key,pause_requested,cancelled_generation_id,updated_at)
      VALUES (?,1,NULL,?)
      ON CONFLICT(scope_key) DO UPDATE SET pause_requested=1,updated_at=excluded.updated_at
    `).run(scopeKey, now);
    return this.getControl(scopeKey)!;
  }

  resumeScope(scopeKey: string): SemanticControlRecord {
    const now = new Date().toISOString();
    this.store.db.prepare(`
      INSERT INTO semantic_controls(scope_key,pause_requested,cancelled_generation_id,updated_at)
      VALUES (?,0,NULL,?)
      ON CONFLICT(scope_key) DO UPDATE SET pause_requested=0,updated_at=excluded.updated_at
    `).run(scopeKey, now);
    return this.getControl(scopeKey)!;
  }

  retryFailures(generationId: string): number {
    const now = new Date().toISOString();
    return this.store.db.transaction(() => {
      const generation = this.store.db.prepare(
        "UPDATE embedding_generations SET expected_chunks=expected_chunks WHERE id=? AND status='staging' RETURNING id",
      ).get(generationId);
      if (!generation) {
        if (!this.getGeneration(generationId)) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
        throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
      }
      return this.store.db.prepare(`
        UPDATE embedding_jobs
           SET status='pending',attempts=0,error=NULL,lease_owner=NULL,
               lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
         WHERE generation_id=? AND status='failed'
      `).run(now, generationId).changes;
    })();
  }

  acquireWorkerLease(input: {
    lockName?: string;
    ownerId: string;
    ownerPid: number;
    buildId: string;
    now?: string;
    leaseExpiresAt: string;
  }): boolean {
    const lockName = input.lockName ?? "semantic-drain";
    const now = input.now ?? new Date().toISOString();
    const result = this.store.db.prepare(`
      INSERT INTO semantic_worker_leases
        (lock_name,owner_id,owner_pid,build_id,heartbeat_at,lease_expires_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(lock_name) DO UPDATE SET
        owner_id=excluded.owner_id,owner_pid=excluded.owner_pid,build_id=excluded.build_id,
        heartbeat_at=excluded.heartbeat_at,lease_expires_at=excluded.lease_expires_at
      WHERE semantic_worker_leases.lease_expires_at<=excluded.heartbeat_at
         OR semantic_worker_leases.owner_id=excluded.owner_id
    `).run(lockName, input.ownerId, input.ownerPid, input.buildId, now, input.leaseExpiresAt);
    return result.changes === 1;
  }

  heartbeatWorkerLease(input: {
    lockName?: string;
    ownerId: string;
    now?: string;
    leaseExpiresAt: string;
  }): boolean {
    const now = input.now ?? new Date().toISOString();
    const result = this.store.db.prepare(`
      UPDATE semantic_worker_leases
         SET heartbeat_at=?,lease_expires_at=?
       WHERE lock_name=? AND owner_id=? AND lease_expires_at>?
    `).run(now, input.leaseExpiresAt, input.lockName ?? "semantic-drain", input.ownerId, now);
    return result.changes === 1;
  }

  releaseWorkerLease(ownerId: string, lockName = "semantic-drain", now = new Date().toISOString()): boolean {
    // Keep the last owner/build/heartbeat as an audit record while making the
    // lease immediately reclaimable. Deleting the row made an idle worker
    // indistinguishable from a worker that had never started.
    return this.store.db.prepare(
      "UPDATE semantic_worker_leases SET heartbeat_at=?,lease_expires_at=? WHERE lock_name=? AND owner_id=?",
    ).run(now, now, lockName, ownerId).changes === 1;
  }

  getWorkerLease(lockName = "semantic-drain"): SemanticWorkerLeaseRecord | undefined {
    return this.store.db.prepare(`
      SELECT lock_name AS lockName,owner_id AS ownerId,owner_pid AS ownerPid,
             build_id AS buildId,heartbeat_at AS heartbeatAt,lease_expires_at AS leaseExpiresAt
        FROM semantic_worker_leases WHERE lock_name=?
    `).get(lockName) as SemanticWorkerLeaseRecord | undefined;
  }

  cancelGeneration(generationId: string): EmbeddingGenerationRecord {
    const generation = this.getGeneration(generationId);
    if (!generation) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (generation.status !== "staging") throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
    const now = new Date().toISOString();
    const tx = this.store.db.transaction(() => {
      const generationUpdate = this.store.db.prepare(`
        UPDATE embedding_generations
           SET status='failed',failure_reason='USER_CANCELLED'
         WHERE id=? AND status='staging'
      `).run(generationId);
      if (generationUpdate.changes !== 1) throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
      this.store.db.prepare(`
        UPDATE embedding_jobs
           SET status='failed',error='USER_CANCELLED',lease_owner=NULL,
               lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
         WHERE generation_id=? AND status IN ('pending','running','failed')
      `).run(now, generationId);
      this.store.db.prepare(`
        INSERT INTO semantic_controls(scope_key,pause_requested,cancelled_generation_id,updated_at)
        VALUES (?,0,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET
          cancelled_generation_id=excluded.cancelled_generation_id,
          updated_at=excluded.updated_at
      `).run(generation.scopeKey, generationId, now);
    });
    tx();
    return this.getGeneration(generationId)!;
  }

  transitionGeneration(id: string, next: EmbeddingGenerationStatus, failureReason?: string): EmbeddingGenerationRecord {
    const current = this.getGeneration(id);
    if (!current) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (!GENERATION_TRANSITIONS[current.status].includes(next)) throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
    if (next === "active") {
      try {
        return this.activateGeneration(id);
      } catch (error) {
        if (/INCOMPLETE|NOT_READY/u.test(String((error as Error).message ?? error))) {
          throw new Error("EMBEDDING_GENERATION_NOT_READY");
        }
        throw error;
      }
    }
    const result = this.store.db.prepare(`
      UPDATE embedding_generations
         SET status=?, activated_at=CASE WHEN ?='active' THEN ? ELSE activated_at END,
             retired_at=CASE WHEN ?='retired' THEN ? ELSE retired_at END,
             failure_reason=CASE WHEN ?='failed' THEN ? ELSE failure_reason END
       WHERE id=? AND status=?
    `).run(next, next, new Date().toISOString(), next, new Date().toISOString(), next, persistedEmbeddingError(failureReason), id, current.status);
    if (result.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
    return this.getGeneration(id)!;
  }

  activateGeneration(id: string): EmbeddingGenerationRecord {
    const generation = this.getGeneration(id);
    if (!generation) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (generation.status !== "staging") throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
    const now = new Date().toISOString();
    const tx = this.store.db.transaction(() => {
      const locked = this.store.db.prepare(
        "UPDATE embedding_generations SET expected_chunks=expected_chunks WHERE id=? AND status='staging' RETURNING id",
      ).get(id);
      if (!locked) throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
      this.assertReady(generation);
      const previous = this.store.db.prepare("SELECT generation_id AS generationId FROM semantic_active_spaces WHERE scope_key=?").get(generation.scopeKey) as { generationId: string } | undefined;
      if (previous?.generationId === id) throw new Error("EMBEDDING_GENERATION_ALREADY_ACTIVE");
      if (previous) {
        const retired = this.store.db.prepare("UPDATE embedding_generations SET status='retired', retired_at=? WHERE id=? AND status='active'").run(now, previous.generationId);
        if (retired.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
      }
      const activated = this.store.db.prepare("UPDATE embedding_generations SET status='active', activated_at=?, failure_reason=NULL WHERE id=? AND status='staging'").run(now, id);
      if (activated.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
      this.store.db.prepare(`
        INSERT INTO semantic_active_spaces(scope_key,generation_id,previous_generation_id,activated_at)
        VALUES (?,?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET generation_id=excluded.generation_id,previous_generation_id=excluded.previous_generation_id,activated_at=excluded.activated_at
      `).run(generation.scopeKey, id, previous?.generationId ?? null, now);
    });
    tx();
    return this.getGeneration(id)!;
  }

  /**
   * Publish a bounded bootstrap set when no older semantic generation exists.
   * The generation still owns every expected job; remaining jobs stay pending
   * and are claimed by the worker while the active generation serves an
   * explicitly partial/lower-bound vector index.  Never replace an existing
   * active generation with a partial one: an incremental update must preserve
   * the last complete semantic snapshot until the replacement is complete.
   */
  activatePartialGeneration(id: string, minimumReady = 1): EmbeddingGenerationRecord {
    if (!Number.isInteger(minimumReady) || minimumReady < 1) throw new Error("EMBEDDING_PARTIAL_MINIMUM_INVALID");
    const generation = this.getGeneration(id);
    if (!generation) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (generation.status !== "staging") throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
    const space = this.store.db.prepare("SELECT dimensions FROM embedding_spaces WHERE id=?").get(generation.spaceId) as { dimensions: number } | undefined;
    if (!space) throw new Error("EMBEDDING_SPACE_NOT_FOUND");
    const now = new Date().toISOString();
    const tx = this.store.db.transaction(() => {
      const locked = this.store.db.prepare(
        "UPDATE embedding_generations SET expected_chunks=expected_chunks WHERE id=? AND status='staging' RETURNING id",
      ).get(id);
      if (!locked) throw new Error("EMBEDDING_GENERATION_INVALID_TRANSITION");
      const previous = this.store.db.prepare("SELECT generation_id AS generationId FROM semantic_active_spaces WHERE scope_key=?").get(generation.scopeKey) as { generationId: string } | undefined;
      if (previous) throw new Error("EMBEDDING_PARTIAL_ACTIVE_GENERATION_EXISTS");
      const jobs = this.store.db.prepare(`
        SELECT COUNT(*) AS total,COALESCE(SUM(status='ready'),0) AS ready
          FROM embedding_jobs WHERE generation_id=?
      `).get(id) as { total: number; ready: number };
      const refs = this.store.db.prepare(`
        SELECT COALESCE(SUM(j.status='ready'),0) AS ready,
               COALESCE(SUM(j.status='ready' AND r.status='ready' AND v.vec_rowid IS NOT NULL AND v.dimensions=?),0) AS valid
          FROM embedding_jobs j
          LEFT JOIN semantic_embedding_refs r
            ON r.generation_id=? AND r.space_id=? AND r.chunk_id=j.chunk_id
          LEFT JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
         WHERE j.generation_id=?
      `).get(space.dimensions, id, generation.spaceId, id) as { ready: number; valid: number };
      if (jobs.total !== generation.expectedChunks || jobs.ready < minimumReady || refs.ready !== jobs.ready || refs.valid !== jobs.ready) {
        throw new Error("EMBEDDING_PARTIAL_GENERATION_INCOMPLETE");
      }
      const activated = this.store.db.prepare("UPDATE embedding_generations SET status='active',activated_at=?,failure_reason=NULL WHERE id=? AND status='staging'").run(now, id);
      if (activated.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
      this.store.db.prepare(`
        INSERT INTO semantic_active_spaces(scope_key,generation_id,previous_generation_id,activated_at)
        VALUES (?,?,NULL,?)
        ON CONFLICT(scope_key) DO UPDATE SET generation_id=excluded.generation_id,previous_generation_id=NULL,activated_at=excluded.activated_at
      `).run(generation.scopeKey, id, now);
    });
    tx();
    return this.getGeneration(id)!;
  }

  rollback(scopeKey: string): EmbeddingGenerationRecord {
    const active = this.store.db.prepare("SELECT generation_id AS generationId,previous_generation_id AS previousGenerationId FROM semantic_active_spaces WHERE scope_key=?").get(scopeKey) as { generationId: string; previousGenerationId: string | null } | undefined;
    if (!active?.previousGenerationId) throw new Error("EMBEDDING_ROLLBACK_UNAVAILABLE");
    const previous = this.getGeneration(active.previousGenerationId);
    if (!previous || previous.status !== "retired") throw new Error("EMBEDDING_ROLLBACK_UNAVAILABLE");
    const now = new Date().toISOString();
    const tx = this.store.db.transaction(() => {
      const retired = this.store.db.prepare("UPDATE embedding_generations SET status='retired', retired_at=? WHERE id=? AND status='active'").run(now, active.generationId);
      if (retired.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
      const activated = this.store.db.prepare("UPDATE embedding_generations SET status='active', activated_at=?, retired_at=NULL WHERE id=? AND status='retired'").run(now, previous.id);
      if (activated.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
      const swapped = this.store.db.prepare("UPDATE semantic_active_spaces SET generation_id=?,previous_generation_id=NULL,activated_at=? WHERE scope_key=? AND generation_id=?").run(previous.id, now, scopeKey, active.generationId);
      if (swapped.changes !== 1) throw new Error("EMBEDDING_GENERATION_CONCURRENT_TRANSITION");
    });
    tx();
    return this.getGeneration(previous.id)!;
  }

  private assertReady(generation: EmbeddingGenerationRecord): void {
    const space = this.store.db.prepare("SELECT id,dimensions FROM embedding_spaces WHERE id=?").get(generation.spaceId) as { id: string; dimensions: number } | undefined;
    const jobs = this.store.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(status='ready'),0) AS ready, COUNT(DISTINCT chunk_id) AS chunks FROM embedding_jobs WHERE generation_id=?`).get(generation.id) as { total: number; ready: number; chunks: number };
    const refs = this.store.db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(r.status='ready'),0) AS ready,
             COALESCE(SUM(v.vec_rowid IS NOT NULL),0) AS vectors,
             COALESCE(SUM(v.dimensions=?),0) AS dimensions
        FROM embedding_jobs j
        LEFT JOIN semantic_embedding_refs r ON r.generation_id=? AND r.space_id=? AND r.chunk_id=j.chunk_id
        LEFT JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
       WHERE j.generation_id=?
    `).get(space?.dimensions ?? -1, generation.id, generation.spaceId, generation.id) as { total: number; ready: number; vectors: number; dimensions: number };
    const integrity = this.store.db.prepare(`
      SELECT COUNT(*) AS invalid
        FROM embedding_jobs j
        LEFT JOIN semantic_chunks c ON c.id=j.chunk_id
       WHERE j.generation_id=? AND (c.id IS NULL OR c.snapshot_id IS NULL OR c.snapshot_id<>?)
    `).get(generation.id, generation.snapshotId) as { invalid: number };
    if (!space || jobs.total !== generation.expectedChunks || jobs.ready !== generation.expectedChunks || jobs.chunks !== generation.expectedChunks || refs.total !== generation.expectedChunks || refs.ready !== generation.expectedChunks || refs.vectors !== generation.expectedChunks || refs.dimensions !== generation.expectedChunks || integrity.invalid !== 0) {
      throw new Error("EMBEDDING_GENERATION_INCOMPLETE");
    }
  }

  getGeneration(id: string): EmbeddingGenerationRecord | undefined {
    return this.store.db.prepare(`
      SELECT id,space_id AS spaceId,snapshot_id AS snapshotId,scope_key AS scopeKey,status,
             expected_chunks AS expectedChunks,created_at AS createdAt,activated_at AS activatedAt,
             retired_at AS retiredAt,failure_reason AS failureReason
        FROM embedding_generations WHERE id=?
    `).get(id) as EmbeddingGenerationRecord | undefined;
  }

  private getJob(id: string): EmbeddingJobRecord | undefined {
    return this.store.db.prepare(`
      SELECT id,generation_id AS generationId,chunk_id AS chunkId,status,attempts,error,
             lease_owner AS leaseOwner,lease_expires_at AS leaseExpiresAt,next_attempt_at AS nextAttemptAt
        FROM embedding_jobs WHERE id=?
    `).get(id) as EmbeddingJobRecord | undefined;
  }

  private getControl(scopeKey: string): SemanticControlRecord | undefined {
    const row = this.store.db.prepare(`
      SELECT scope_key AS scopeKey,pause_requested AS pauseRequested,
             cancelled_generation_id AS cancelledGenerationId,updated_at AS updatedAt
        FROM semantic_controls WHERE scope_key=?
    `).get(scopeKey) as (Omit<SemanticControlRecord, "pauseRequested"> & { pauseRequested: number }) | undefined;
    return row ? { ...row, pauseRequested: row.pauseRequested === 1 } : undefined;
  }
}
