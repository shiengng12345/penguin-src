export type CursorErrorCode =
  | "CURSOR_INVALID"
  | "CURSOR_EXPIRED"
  | "CURSOR_OPERATION_MISMATCH"
  | "CURSOR_REQUEST_MISMATCH"
  | "CURSOR_REVISION_STALE"
  | "CURSOR_SCOPE_MISMATCH";

export type KnowledgeErrorCode =
  | "INVALID_SEARCH_REQUEST"
  | "INVALID_SEARCH_RESPONSE"
  | "INVALID_SEMANTIC_CONTRACT"
  | "INVALID_OUTPUT"
  | "OUTPUT_SCHEMA_NOT_REGISTERED"
  | "CAPABILITY_NOT_IMPLEMENTED"
  | "SURFACE_RUNTIME_UNAVAILABLE"
  | "REPOSITORY_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "BRANCH_NOT_INDEXED"
  | "INVALID_ARGUMENT"
  | "INVALID_QUERY"
  | "MISSING_REQUIRED_ARGUMENT"
  | "UNKNOWN_CAPABILITY"
  | "QUERY_TIMEOUT"
  | CursorErrorCode;

export class KnowledgeContractError extends Error {
  readonly code: KnowledgeErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: KnowledgeErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(message);
    this.name = "KnowledgeContractError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export interface KnowledgeErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  remediation?: string;
}

/**
 * Stable ownership evidence for a target rejected from the requested scope.
 * Flat fields keep CLI/MCP consumers simple; the nested records retain the
 * complete source-vs-requested provenance for diagnostics and logs.
 */
export interface ScopeMismatchDetails {
  target: string;
  requestedRepoId: string | null;
  requestedRevisionId: string | null;
  actualRepoId: string | null;
  actualRevisionId: string | null;
  requested: { repoId: string | null; branchId: string | null; revisionId: string | null };
  actual: {
    repoId: string | null;
    branchId: string | null;
    revisionId: string | null;
    membershipRepoIds: string[];
  };
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function defaultErrorRemediation(code: string): string {
  if (/TIMEOUT/u.test(code)) {
    return "retry with a narrower scope and a smaller page limit; inspect the elapsed and budget values before retrying";
  }
  if (code === "CANCELLED") return "retry the same request when the caller is ready";
  if (/CURSOR/u.test(code)) return "restart pagination from the first page with the same scope and options";
  if (/REPOSITORY|WORKSPACE|BRANCH|SCOPE|TARGET/u.test(code)) {
    return "call index_status or knowledge_search, then retry with an explicit canonical repo, branch, snapshot or node identity";
  }
  if (/INVALID|MISSING|UNKNOWN/u.test(code)) {
    return "inspect the live capability input schema, correct the request, and retry";
  }
  return "call knowledge_doctor, inspect the typed details, then retry the bounded request";
}

/** Normalize errors crossing CLI, resident-query, and MCP boundaries. */
export function normalizeKnowledgeError(error: unknown, fallbackCode = "INTERNAL"): KnowledgeErrorEnvelope {
  const record = errorRecord(error);
  const nested = record && errorRecord(record.error);
  const source = nested ?? record;
  const details = source && errorRecord(source.details);
  const code = typeof source?.code === "string" && source.code ? source.code : fallbackCode;
  const remediation = typeof source?.remediation === "string" && source.remediation
    ? source.remediation
    : typeof details?.remediation === "string" && details.remediation
      ? details.remediation
      : defaultErrorRemediation(code);
  return {
    code,
    message: typeof source?.message === "string" && source.message
      ? source.message
      : error instanceof Error ? error.message : String(error),
    retryable: source?.retryable === true || /TIMEOUT/u.test(code),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
    remediation,
  };
}

export function knowledgeErrorEnvelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
  remediation?: string,
): KnowledgeErrorEnvelope {
  const envelope = normalizeKnowledgeError({ code, message, details, retryable });
  if (remediation) {
    return { ...envelope, remediation };
  }
  return envelope;
}

export function scopeResolutionErrorEnvelope(error: {
  code: string;
  message: string;
  candidates?: readonly Record<string, unknown>[];
}): KnowledgeErrorEnvelope {
  const remediation = error.code === "BRANCH_NOT_INDEXED"
    ? "pass allow_fallback: true to query another indexed branch"
    : "specify branch, commit, or snapshot";
  return knowledgeErrorEnvelope(
    error.code,
    error.message,
    { candidates: [...(error.candidates ?? [])] },
    false,
    remediation,
  );
}
