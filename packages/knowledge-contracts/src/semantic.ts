import { KnowledgeContractError } from "./errors.js";

export const SEMANTIC_GENERATION_STATES = [
  "disabled",
  "not_queued",
  "chunks_ready",
  "queued",
  "embedding",
  "pausing",
  "paused",
  "retry_wait",
  "stalled",
  "active",
  "superseded",
  "cancelled",
] as const;

export type SemanticGenerationState = (typeof SEMANTIC_GENERATION_STATES)[number];
export type SemanticControlAction = "pause" | "resume" | "retry" | "cancel";

export interface SemanticStatus {
  state: SemanticGenerationState;
  scopeKey: string;
  repoId: string | null;
  generationId: string | null;
  activeGenerationId: string | null;
  snapshotId: string | null;
  modelId: string | null;
  modelHash: string | null;
  providerId: string | null;
  weightsDigest: string | null;
  tokenizerDigest: string | null;
  preprocessingDigest: string | null;
  pooling: string | null;
  normalization: string | null;
  dimensions: number | null;
  chunkerVersion: string | null;
  expected: number;
  ready: number;
  running: number;
  pending: number;
  retryableFailed: number;
  terminalFailed: number;
  progressPercent: number;
  ratePerSecond: number | null;
  etaSeconds: number | null;
  paused: boolean;
  pauseRequested: boolean;
  lastHeartbeatAt: string | null;
  workerBuildId: string | null;
  lease: {
    active: boolean;
    ownerId: string | null;
    ownerPid: number | null;
    expiresAt: string | null;
  };
  reason: string | null;
  restartRequired: boolean;
}

export interface SemanticControlRequest {
  action: SemanticControlAction;
  scopeKey: string;
  generationId?: string;
  /** Caller-generated correlation/idempotency key. This is not an
   * authorization secret; transports may require their own confirmation. */
  operationToken: string;
}

export interface SemanticControlResult {
  accepted: boolean;
  action: SemanticControlAction;
  scopeKey: string;
  generationId: string | null;
  operationToken: string;
  status: SemanticStatus;
  worker?: SemanticWorkerWakeResult;
}

export interface SemanticWorkerWakeResult {
  status: "started" | "already_running" | "not_needed" | "start_failed" | "version_mismatch";
  pid: number | null;
  reason: string | null;
  logPath: string;
}

export interface SemanticStatusResponse {
  statuses: SemanticStatus[];
  requestedScopeKey?: string;
  resolvedScopeKey?: string;
}

const STATUS_KEYS = new Set<keyof SemanticStatus>([
  "state", "scopeKey", "repoId", "generationId", "activeGenerationId", "snapshotId",
  "modelId", "modelHash", "providerId", "weightsDigest", "tokenizerDigest", "preprocessingDigest",
  "pooling", "normalization", "dimensions", "chunkerVersion", "expected", "ready", "running", "pending",
  "retryableFailed", "terminalFailed", "progressPercent", "ratePerSecond", "etaSeconds",
  "paused", "pauseRequested", "lastHeartbeatAt", "workerBuildId", "lease", "reason", "restartRequired",
]);

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new KnowledgeContractError("INVALID_SEMANTIC_CONTRACT", message, details);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must be a non-empty string`, { field });
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) invalid(`${field} must be a non-negative integer`, { field });
  return Number(value);
}

function nullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`${field} must be null or a non-negative finite number`, { field });
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean`, { field });
  return value;
}

function semanticWorkerLease(value: unknown): SemanticStatus["lease"] {
  const input = record(value, "lease");
  const allowed = new Set(["active", "ownerId", "ownerPid", "expiresAt"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`lease contains unknown property ${key}`, { field: `lease.${key}` });
  }
  const active = requiredBoolean(input.active, "lease.active");
  const ownerId = nullableString(input.ownerId, "lease.ownerId");
  const ownerPid = input.ownerPid === null ? null : nonNegativeInteger(input.ownerPid, "lease.ownerPid");
  const expiresAt = nullableString(input.expiresAt, "lease.expiresAt");
  if (active && (!ownerId || ownerPid === null || !expiresAt)) {
    invalid("an active lease requires ownerId, ownerPid, and expiresAt", { active, ownerId, ownerPid, expiresAt });
  }
  return { active, ownerId, ownerPid, expiresAt };
}

export function validateSemanticStatus(value: unknown): SemanticStatus {
  const input = record(value, "semantic status");
  for (const key of Object.keys(input)) {
    if (!STATUS_KEYS.has(key as keyof SemanticStatus)) invalid(`semantic status contains unknown property ${key}`, { field: key });
  }
  const state = input.state;
  if (typeof state !== "string" || !SEMANTIC_GENERATION_STATES.includes(state as SemanticGenerationState)) invalid("state is not a canonical semantic state", { state });
  const expected = nonNegativeInteger(input.expected, "expected");
  const ready = nonNegativeInteger(input.ready, "ready");
  const running = nonNegativeInteger(input.running, "running");
  const pending = nonNegativeInteger(input.pending, "pending");
  const retryableFailed = nonNegativeInteger(input.retryableFailed, "retryableFailed");
  const terminalFailed = nonNegativeInteger(input.terminalFailed, "terminalFailed");
  if (ready > expected) invalid("ready cannot exceed expected", { ready, expected });
  if (ready + running + pending + retryableFailed + terminalFailed > expected) {
    invalid("semantic job counts cannot exceed expected", { expected, ready, running, pending, retryableFailed, terminalFailed });
  }
  const progressPercent = input.progressPercent;
  if (typeof progressPercent !== "number" || !Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
    invalid("progressPercent must be between 0 and 100", { progressPercent });
  }
  return {
    state: state as SemanticGenerationState,
    scopeKey: requiredString(input.scopeKey, "scopeKey"),
    repoId: nullableString(input.repoId, "repoId"),
    generationId: nullableString(input.generationId, "generationId"),
    activeGenerationId: nullableString(input.activeGenerationId, "activeGenerationId"),
    snapshotId: nullableString(input.snapshotId, "snapshotId"),
    modelId: nullableString(input.modelId, "modelId"),
    modelHash: nullableString(input.modelHash, "modelHash"),
    providerId: nullableString(input.providerId ?? null, "providerId"),
    weightsDigest: nullableString(input.weightsDigest ?? null, "weightsDigest"),
    tokenizerDigest: nullableString(input.tokenizerDigest ?? null, "tokenizerDigest"),
    preprocessingDigest: nullableString(input.preprocessingDigest ?? null, "preprocessingDigest"),
    pooling: nullableString(input.pooling ?? null, "pooling"),
    normalization: nullableString(input.normalization ?? null, "normalization"),
    dimensions: input.dimensions === null ? null : nonNegativeInteger(input.dimensions, "dimensions"),
    chunkerVersion: nullableString(input.chunkerVersion, "chunkerVersion"),
    expected,
    ready,
    running,
    pending,
    retryableFailed,
    terminalFailed,
    progressPercent,
    ratePerSecond: nullableNonNegativeNumber(input.ratePerSecond, "ratePerSecond"),
    etaSeconds: nullableNonNegativeNumber(input.etaSeconds, "etaSeconds"),
    paused: requiredBoolean(input.paused, "paused"),
    pauseRequested: requiredBoolean(input.pauseRequested, "pauseRequested"),
    lastHeartbeatAt: nullableString(input.lastHeartbeatAt, "lastHeartbeatAt"),
    workerBuildId: nullableString(input.workerBuildId, "workerBuildId"),
    lease: semanticWorkerLease(input.lease),
    reason: nullableString(input.reason, "reason"),
    restartRequired: requiredBoolean(input.restartRequired, "restartRequired"),
  };
}

export function validateSemanticControlRequest(value: unknown): SemanticControlRequest {
  const input = record(value, "semantic control request");
  for (const key of Object.keys(input)) {
    if (!new Set(["action", "scopeKey", "generationId", "operationToken"]).has(key)) invalid(`semantic control contains unknown property ${key}`, { field: key });
  }
  const action = input.action;
  if (action !== "pause" && action !== "resume" && action !== "retry" && action !== "cancel") invalid("action must be pause, resume, retry, or cancel", { action });
  const scopeKey = requiredString(input.scopeKey, "scopeKey");
  const operationToken = requiredString(input.operationToken, "operationToken");
  if (operationToken.length < 8) invalid("operationToken must contain at least 8 characters", { field: "operationToken" });
  const generationId = input.generationId === undefined ? undefined : requiredString(input.generationId, "generationId");
  if ((action === "retry" || action === "cancel") && !generationId) invalid(`${action} requires generationId`, { action });
  if ((action === "pause" || action === "resume") && generationId) invalid(`${action} does not accept generationId`, { action });
  return generationId ? { action, scopeKey, generationId, operationToken } : { action, scopeKey, operationToken };
}

function semanticWorkerWakeResult(value: unknown): SemanticWorkerWakeResult {
  const input = record(value, "semantic worker wake result");
  const allowed = new Set(["status", "pid", "reason", "logPath"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`semantic worker wake result contains unknown property ${key}`, { field: `worker.${key}` });
  }
  const statuses = ["started", "already_running", "not_needed", "start_failed", "version_mismatch"] as const;
  if (typeof input.status !== "string" || !statuses.includes(input.status as (typeof statuses)[number])) {
    invalid("worker.status is not a canonical wake status", { status: input.status });
  }
  const pid = input.pid === null ? null : nonNegativeInteger(input.pid, "worker.pid");
  return {
    status: input.status as SemanticWorkerWakeResult["status"],
    pid,
    reason: nullableString(input.reason, "worker.reason"),
    logPath: requiredString(input.logPath, "worker.logPath"),
  };
}

export function validateSemanticControlResult(value: unknown): SemanticControlResult {
  const input = record(value, "semantic control result");
  const allowed = new Set(["accepted", "action", "scopeKey", "generationId", "operationToken", "status", "worker"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`semantic control result contains unknown property ${key}`, { field: key });
  }
  const request = validateSemanticControlRequest({
    action: input.action,
    scopeKey: input.scopeKey,
    ...(input.generationId === null || input.generationId === undefined ? {} : { generationId: input.generationId }),
    operationToken: input.operationToken,
  });
  const status = validateSemanticStatus(input.status);
  if (status.scopeKey !== request.scopeKey) {
    invalid("semantic control result status.scopeKey must match scopeKey", {
      scopeKey: request.scopeKey,
      statusScopeKey: status.scopeKey,
    });
  }
  if (request.generationId && status.generationId !== request.generationId) {
    invalid("semantic control result status.generationId must match generationId", {
      generationId: request.generationId,
      statusGenerationId: status.generationId,
    });
  }
  return {
    accepted: requiredBoolean(input.accepted, "accepted"),
    action: request.action,
    scopeKey: request.scopeKey,
    generationId: request.generationId ?? null,
    operationToken: request.operationToken,
    status,
    ...(input.worker === undefined ? {} : { worker: semanticWorkerWakeResult(input.worker) }),
  };
}

export function validateSemanticStatusResponse(value: unknown): SemanticStatusResponse {
  const input = record(value, "semantic status response");
  const allowed = new Set(["statuses", "requestedScopeKey", "resolvedScopeKey"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`semantic status response contains unknown property ${key}`, { field: key });
  }
  if (!Array.isArray(input.statuses)) invalid("semantic status response statuses must be an array", { field: "statuses" });
  return {
    statuses: input.statuses.map(validateSemanticStatus),
    ...(input.requestedScopeKey === undefined ? {} : { requestedScopeKey: requiredString(input.requestedScopeKey, "requestedScopeKey") }),
    ...(input.resolvedScopeKey === undefined ? {} : { resolvedScopeKey: requiredString(input.resolvedScopeKey, "resolvedScopeKey") }),
  };
}
