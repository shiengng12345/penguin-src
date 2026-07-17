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
