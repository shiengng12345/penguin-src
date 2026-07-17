import { KnowledgeContractError } from "./errors.js";
import type {
  SearchDiagnostics,
  SearchEvidence,
  SearchHit,
  SearchLocator,
  SearchResponse,
} from "./search.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): never {
  throw new KnowledgeContractError("INVALID_SEARCH_RESPONSE", message, { path });
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(path, path + " must be a non-empty string");
  return value;
}

function validateLocator(value: unknown, path: string): SearchLocator {
  if (!isRecord(value)) invalid(path, path + " must be an object");
  requireString(value.repoId, path + ".repoId");
  requireString(value.repoName, path + ".repoName");
  requireString(value.revisionId, path + ".revisionId");
  if (value.revisionKind !== "commit" && value.revisionKind !== "working_tree") {
    invalid(path + ".revisionKind", path + ".revisionKind is invalid");
  }
  requireString(value.filePath, path + ".filePath");
  return value as unknown as SearchLocator;
}

function validateEvidence(value: unknown, path: string): SearchEvidence {
  if (!isRecord(value)) invalid(path, path + " must be an object");
  if (!["source", "graph", "note", "runtime", "semantic"].includes(String(value.source))) {
    invalid(path + ".source", path + ".source is invalid");
  }
  if (!["verified", "observed", "reviewed", "inference"].includes(String(value.status))) {
    invalid(path + ".status", path + ".status is invalid");
  }
  validateLocator(value.locator, path + ".locator");
  return value as unknown as SearchEvidence;
}

function validateHit(value: unknown, path: string): SearchHit {
  if (!isRecord(value)) invalid(path, path + " must be an object");
  requireString(value.hitId, path + ".hitId");
  requireString(value.kind, path + ".kind");
  requireString(value.lane, path + ".lane");
  requireString(value.title, path + ".title");
  validateLocator(value.locator, path + ".locator");
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) invalid(path + ".score", path + ".score must be finite");
  if (!Array.isArray(value.rankReasons) || value.rankReasons.some((reason) => typeof reason !== "string")) {
    invalid(path + ".rankReasons", path + ".rankReasons must be a string array");
  }
  if (!Array.isArray(value.evidence)) invalid(path + ".evidence", path + ".evidence must be an array");
  value.evidence.forEach((evidence, index) => validateEvidence(evidence, path + ".evidence[" + index + "]"));
  return value as unknown as SearchHit;
}

export function validateSearchResponse(input: unknown): SearchResponse {
  if (!isRecord(input)) invalid("response", "response must be an object");
  if (input.schemaVersion !== "2") invalid("response.schemaVersion", "response.schemaVersion must be 2");
  if (!Array.isArray(input.hits)) invalid("response.hits", "response.hits must be an array");
  input.hits.forEach((hit, index) => validateHit(hit, "response.hits[" + index + "]"));
  if (!isRecord(input.diagnostics)) invalid("response.diagnostics", "response.diagnostics must be an object");
  if (input.error !== undefined) {
    if (!isRecord(input.error) || typeof input.error.code !== "string" || typeof input.error.message !== "string" || !isRecord(input.error.details) || typeof input.error.retryable !== "boolean") {
      invalid("response.error", "response.error must be a typed error envelope");
    }
  }
  if (!isRecord(input.page)) invalid("response.page", "response.page must be an object");
  if (typeof input.page.limit !== "number" || !Number.isInteger(input.page.limit)) invalid("response.page.limit", "response.page.limit must be an integer");
  if (typeof input.page.totalIsExact !== "boolean") invalid("response.page.totalIsExact", "response.page.totalIsExact must be boolean");
  return input as unknown as SearchResponse;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function normalizeSearchResponse(input: unknown): SearchResponse {
  const response = validateSearchResponse(input);
  const normalized = {
    ...response,
    diagnostics: {
      ...response.diagnostics,
      skippedLanes: [...response.diagnostics.skippedLanes].sort((a, b) => a.lane.localeCompare(b.lane)),
      exclusions: [...response.diagnostics.exclusions].sort((a, b) => a.filePath.localeCompare(b.filePath)),
      warnings: [...response.diagnostics.warnings].sort((a, b) => a.code.localeCompare(b.code)),
      suggestions: [...response.diagnostics.suggestions].sort((a, b) => a.query.localeCompare(b.query)),
      timingsMs: {},
    } as SearchDiagnostics,
  };
  return stable(normalized) as SearchResponse;
}
