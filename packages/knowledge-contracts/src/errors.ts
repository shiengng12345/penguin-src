export class KnowledgeContractError extends Error {
  readonly code: "INVALID_SEARCH_REQUEST" | "INVALID_SEARCH_RESPONSE" | "INVALID_OUTPUT" | "OUTPUT_SCHEMA_NOT_REGISTERED" | "CAPABILITY_NOT_IMPLEMENTED" | "SURFACE_RUNTIME_UNAVAILABLE";
  readonly details: Record<string, unknown>;

  constructor(
    code: "INVALID_SEARCH_REQUEST" | "INVALID_SEARCH_RESPONSE" | "INVALID_OUTPUT" | "OUTPUT_SCHEMA_NOT_REGISTERED" | "CAPABILITY_NOT_IMPLEMENTED" | "SURFACE_RUNTIME_UNAVAILABLE",
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KnowledgeContractError";
    this.code = code;
    this.details = details;
  }
}

export interface KnowledgeErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Normalize errors crossing CLI, resident-query, and MCP boundaries. */
export function normalizeKnowledgeError(error: unknown, fallbackCode = "INTERNAL"): KnowledgeErrorEnvelope {
  const record = errorRecord(error);
  const nested = record && errorRecord(record.error);
  const source = nested ?? record;
  const details = source && errorRecord(source.details);
  return {
    code: typeof source?.code === "string" && source.code ? source.code : fallbackCode,
    message: typeof source?.message === "string" && source.message
      ? source.message
      : error instanceof Error ? error.message : String(error),
    retryable: source?.retryable === true,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

export function knowledgeErrorEnvelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
): KnowledgeErrorEnvelope {
  return normalizeKnowledgeError({ code, message, details, retryable });
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
    `${error.message} ${remediation}`,
    { candidates: [...(error.candidates ?? [])], remediation },
  );
}
