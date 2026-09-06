import type { SemanticGenerationState, SemanticStatus } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";

interface GenerationStatusRow {
  generationId: string;
  scopeKey: string;
  snapshotId: string;
  generationStatus: "staging" | "active" | "retired" | "failed";
  expected: number;
  failureReason: string | null;
  modelId: string;
  modelHash: string;
  providerId: string;
  weightsDigest: string;
  tokenizerDigest: string;
  preprocessingDigest: string;
  pooling: string;
  normalization: string;
  dimensions: number;
  chunkerVersion: string;
  activeGenerationId: string | null;
  pauseRequested: number;
  ready: number;
  running: number;
  pending: number;
  retryableFailed: number;
  terminalFailed: number;
  latestError: string | null;
  nextAttemptAt: string | null;
  lastHeartbeatAt: string | null;
  workerBuildId: string | null;
  leaseOwnerId: string | null;
  leaseOwnerPid: number | null;
  leaseExpiresAt: string | null;
  metricJson: string | null;
}

interface SemanticProgressMetric {
  ready: number;
  sampledAt: string;
  startedAt: string;
  ratePerSecond: number | null;
}

const METRIC_PREFIX = "semantic_progress::";
const WORKER_RUNTIME_META_KEY = "semantic_worker_runtime";

interface PersistedWorkerRuntimeState {
  status?: string;
  reason?: string | null;
  remediation?: string | null;
  identity?: { buildId?: string };
}

function persistedWorkerRuntimeState(store: KnowledgeStore): PersistedWorkerRuntimeState | null {
  const row = store.db.prepare("SELECT value FROM meta WHERE key=?").get(WORKER_RUNTIME_META_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as PersistedWorkerRuntimeState;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Persist a smoothed progress sample so rate and ETA survive client restarts. */
export function recordSemanticProgressSample(
  store: KnowledgeStore,
  generationId: string,
  ready: number,
  now = new Date().toISOString(),
): void {
  const key = `${METRIC_PREFIX}${generationId}`;
  const row = store.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  let previous: SemanticProgressMetric | null = null;
  try { previous = row ? JSON.parse(row.value) as SemanticProgressMetric : null; } catch { previous = null; }
  const elapsed = previous ? (Date.parse(now) - Date.parse(previous.sampledAt)) / 1_000 : 0;
  const delta = previous ? Math.max(0, ready - previous.ready) : 0;
  const instant = elapsed > 0 && delta > 0 ? delta / elapsed : null;
  const ratePerSecond = instant == null
    ? previous?.ratePerSecond ?? null
    : previous?.ratePerSecond == null
      ? instant
      : previous.ratePerSecond * 0.7 + instant * 0.3;
  const metric: SemanticProgressMetric = {
    ready,
    sampledAt: now,
    startedAt: previous?.startedAt ?? now,
    ratePerSecond: ratePerSecond == null ? null : Math.round(ratePerSecond * 100) / 100,
  };
  store.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(metric));
}

function parseMetric(value: string | null): SemanticProgressMetric | null {
  if (!value) return null;
  try {
    const metric = JSON.parse(value) as SemanticProgressMetric;
    return Number.isFinite(metric.ready) && Number.isFinite(Date.parse(metric.sampledAt)) ? metric : null;
  } catch { return null; }
}

function stateFor(row: GenerationStatusRow, now: string): SemanticGenerationState {
  if (row.generationStatus === "active") return "active";
  if (row.generationStatus === "retired") return "superseded";
  if (row.generationStatus === "failed") {
    if (row.failureReason === "USER_CANCELLED") return "cancelled";
    if (row.failureReason === "SUPERSEDED_BY_NEWER_SNAPSHOT" || row.failureReason === "SEMANTIC_CHUNK_SET_REPLACED") return "superseded";
    return "stalled";
  }
  if (row.pauseRequested === 1) return row.running > 0 ? "pausing" : "paused";
  if (row.running > 0) return "embedding";
  if (row.terminalFailed > 0) return "stalled";
  if (row.retryableFailed > 0) return row.nextAttemptAt && row.nextAttemptAt > now ? "retry_wait" : "queued";
  if (row.pending > 0 || row.ready === row.expected) return "queued";
  return "chunks_ready";
}

export function listSemanticStatuses(store: KnowledgeStore, scopeKey?: string, now = new Date().toISOString()): SemanticStatus[] {
  const workerRuntime = persistedWorkerRuntimeState(store);
  const rows = store.db.prepare(`
    SELECT g.id AS generationId,g.scope_key AS scopeKey,g.snapshot_id AS snapshotId,
           g.status AS generationStatus,g.expected_chunks AS expected,g.failure_reason AS failureReason,
           s.model_id AS modelId,s.identity_hash AS modelHash,s.provider_id AS providerId,
           s.weights_digest AS weightsDigest,s.tokenizer_digest AS tokenizerDigest,
           s.preprocessing_digest AS preprocessingDigest,s.pooling AS pooling,s.normalization AS normalization,
           s.dimensions AS dimensions,s.chunker_version AS chunkerVersion,
           active.generation_id AS activeGenerationId,
           COALESCE(control.pause_requested,0) AS pauseRequested,
           COALESCE(SUM(j.status='ready'),0) AS ready,
           COALESCE(SUM(g.status IN ('staging','active') AND j.status='running'),0) AS running,
           COALESCE(SUM(g.status IN ('staging','active') AND j.status='pending'),0) AS pending,
           COALESCE(SUM(g.status IN ('staging','active') AND j.status='failed' AND j.attempts<5),0) AS retryableFailed,
           COALESCE(SUM(g.status IN ('staging','active') AND j.status='failed' AND j.attempts>=5),0) AS terminalFailed,
           MAX(CASE WHEN j.status='failed' THEN j.error END) AS latestError,
           MIN(CASE WHEN g.status IN ('staging','active') AND j.status='failed' AND j.attempts<5 THEN j.next_attempt_at END) AS nextAttemptAt,
           lease.heartbeat_at AS lastHeartbeatAt,lease.build_id AS workerBuildId,
           lease.owner_id AS leaseOwnerId,lease.owner_pid AS leaseOwnerPid,lease.lease_expires_at AS leaseExpiresAt,
           metric.value AS metricJson
      FROM embedding_generations g
      JOIN embedding_spaces s ON s.id=g.space_id
      LEFT JOIN embedding_jobs j ON j.generation_id=g.id
      LEFT JOIN semantic_active_spaces active ON active.scope_key=g.scope_key
      LEFT JOIN semantic_controls control ON control.scope_key=g.scope_key
      LEFT JOIN semantic_worker_leases lease ON lease.lock_name='semantic-drain'
      LEFT JOIN meta metric ON metric.key='semantic_progress::'||g.id
     WHERE (? IS NULL OR g.scope_key=?)
     GROUP BY g.id
     ORDER BY g.rowid DESC
  `).all(scopeKey ?? null, scopeKey ?? null) as GenerationStatusRow[];
  const statuses: SemanticStatus[] = rows.map((row) => {
    const state = stateFor(row, now);
    const metric = parseMetric(row.metricJson);
    const ratePerSecond = metric?.ratePerSecond ?? null;
    const etaSeconds = ratePerSecond && row.ready < row.expected
      ? Math.round((row.expected - row.ready) / ratePerSecond)
      : null;
    return {
      state,
      scopeKey: row.scopeKey,
      repoId: row.scopeKey.startsWith("repo:") ? row.scopeKey.slice(5) : null,
      generationId: row.generationId,
      activeGenerationId: row.activeGenerationId,
      snapshotId: row.snapshotId,
      modelId: row.modelId,
      modelHash: row.modelHash,
      providerId: row.providerId,
      weightsDigest: row.weightsDigest,
      tokenizerDigest: row.tokenizerDigest,
      preprocessingDigest: row.preprocessingDigest,
      pooling: row.pooling,
      normalization: row.normalization,
      dimensions: row.dimensions,
      chunkerVersion: row.chunkerVersion,
      expected: row.expected,
      ready: row.ready,
      running: row.running,
      pending: row.pending,
      retryableFailed: row.retryableFailed,
      terminalFailed: row.terminalFailed,
      progressPercent: row.expected > 0 ? Math.round((row.ready / row.expected) * 10_000) / 100 : 0,
      ratePerSecond,
      etaSeconds,
      paused: state === "paused",
      pauseRequested: row.pauseRequested === 1,
      lastHeartbeatAt: row.lastHeartbeatAt,
      workerBuildId: row.workerBuildId ?? workerRuntime?.identity?.buildId ?? null,
      lease: {
        active: row.leaseExpiresAt !== null && row.leaseExpiresAt > now,
        ownerId: row.leaseOwnerId,
        ownerPid: row.leaseOwnerPid,
        expiresAt: row.leaseExpiresAt,
      },
      reason: state === "active" && row.ready < row.expected
        ? "SEMANTIC_PARTIAL_INDEX"
        : state !== "active" && ["version_mismatch", "model_unavailable", "start_failed"].includes(workerRuntime?.status ?? "")
        ? workerRuntime?.reason ?? row.latestError
        : state === "stalled" || state === "superseded" || state === "cancelled"
          ? row.failureReason ?? row.latestError ?? null
          : row.latestError,
      restartRequired: workerRuntime?.status === "version_mismatch",
    };
  });

  const representedScopes = new Set(statuses.map((status) => status.scopeKey));
  const repositories = store.db.prepare(`
    SELECT r.id AS repoId,
           'repo:' || r.id AS scopeKey,
           (
             SELECT b.current_snapshot_id
               FROM branches b
              WHERE b.repo_id=r.id AND b.current_snapshot_id IS NOT NULL
              ORDER BY (b.status='live') DESC,b.rowid DESC
              LIMIT 1
           ) AS snapshotId
      FROM repos r
     WHERE (? IS NULL OR 'repo:' || r.id = ?)
     ORDER BY r.name COLLATE NOCASE,r.id
  `).all(scopeKey ?? null, scopeKey ?? null) as Array<{
    repoId: string;
    scopeKey: string;
    snapshotId: string | null;
  }>;

  for (const repository of repositories) {
    if (representedScopes.has(repository.scopeKey)) continue;
    statuses.push({
      state: "not_queued",
      scopeKey: repository.scopeKey,
      repoId: repository.repoId,
      generationId: null,
      activeGenerationId: null,
      snapshotId: repository.snapshotId,
      modelId: null,
      modelHash: null,
      providerId: null,
      weightsDigest: null,
      tokenizerDigest: null,
      preprocessingDigest: null,
      pooling: null,
      normalization: null,
      dimensions: null,
      chunkerVersion: null,
      expected: 0,
      ready: 0,
      running: 0,
      pending: 0,
      retryableFailed: 0,
      terminalFailed: 0,
      progressPercent: 0,
      ratePerSecond: null,
      etaSeconds: null,
      paused: false,
      pauseRequested: false,
      lastHeartbeatAt: null,
      workerBuildId: workerRuntime?.identity?.buildId ?? null,
      lease: {
        active: false,
        ownerId: null,
        ownerPid: null,
        expiresAt: null,
      },
      reason: "SEMANTIC_GENERATION_NOT_QUEUED",
      restartRequired: workerRuntime?.status === "version_mismatch",
    });
  }

  return statuses;
}

export interface SemanticScopeResolution {
  requestedScopeKey: string;
  resolvedScopeKey?: string;
  validScopeKeys: string[];
  validRepositoryNames: string[];
  ambiguousRepoIds?: string[];
}

/** Resolve the user-facing repository name/id accepted by CLI/MCP to the
 * durable `repo:<id>` key used by embedding generations. Existing non-repo
 * scope keys remain valid when they are already present in the database. */
export function resolveSemanticScopeKey(store: KnowledgeStore, requestedScopeKey: string): SemanticScopeResolution {
  const requested = requestedScopeKey.trim();
  const generationScopeKeys = (store.db.prepare("SELECT DISTINCT scope_key AS scopeKey FROM embedding_generations ORDER BY scope_key").all() as Array<{ scopeKey: string }>).map((row) => row.scopeKey);
  const repositories = store.db.prepare("SELECT id,name FROM repos ORDER BY name COLLATE NOCASE,id").all() as Array<{ id: string; name: string }>;
  const validScopeKeys = [...new Set([...generationScopeKeys, ...repositories.map((repo) => `repo:${repo.id}`)])].sort();
  const validRepositoryNames = [...new Set(repositories.map((repo) => repo.name))];
  if (validScopeKeys.includes(requested)) return { requestedScopeKey, resolvedScopeKey: requested, validScopeKeys, validRepositoryNames };
  const selector = requested.startsWith("repo:") ? requested.slice(5) : requested;
  const repoIds = store.resolveRepoIds(selector);
  if (repoIds.length === 1) return { requestedScopeKey, resolvedScopeKey: `repo:${repoIds[0]}`, validScopeKeys, validRepositoryNames };
  return {
    requestedScopeKey,
    validScopeKeys,
    validRepositoryNames,
    ...(repoIds.length > 1 ? { ambiguousRepoIds: repoIds } : {}),
  };
}

/** Overlay process-generation truth without teaching the durable DB about a
 * particular CLI/MCP/Tauri process. Long-lived clients use this when the
 * stable launcher has moved to a newer runtime than the process answering the
 * request. */
export function applySemanticRuntimeState(
  statuses: SemanticStatus[],
  runtime: { restartRequired: boolean },
): SemanticStatus[] {
  if (!runtime.restartRequired) return statuses;
  return statuses.map((status) => ({ ...status, restartRequired: true }));
}

export function semanticStatus(store: KnowledgeStore, scopeKey: string, now = new Date().toISOString()): SemanticStatus | undefined {
  return listSemanticStatuses(store, scopeKey, now)[0];
}
