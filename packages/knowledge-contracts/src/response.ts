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

export type GraphEdgeEvidenceState = "proven" | "inferred" | "candidate" | "unresolved";

export interface GraphEdgeEvidenceEnvelope {
  evidenceState: GraphEdgeEvidenceState;
  origin: string | null;
  method: string | null;
  confidence: number | null;
  scope: "revision" | "environment" | "unknown";
  provenance: { filePath?: string; startLine?: number; evidenceId?: string } | null;
  gaps: string[];
}

export function validateGraphEdgeEvidenceEnvelope(
  input: unknown,
  path = "edgeEvidence",
): GraphEdgeEvidenceEnvelope {
  if (!isRecord(input)) invalid(path, path + " must be an object");
  if (!["proven", "inferred", "candidate", "unresolved"].includes(String(input.evidenceState))) {
    invalid(path + ".evidenceState", path + ".evidenceState is invalid");
  }
  for (const key of ["origin", "method"] as const) {
    if (input[key] !== null && typeof input[key] !== "string") invalid(path + "." + key, path + "." + key + " must be a string or null");
  }
  if (input.confidence !== null && (typeof input.confidence !== "number" || !Number.isFinite(input.confidence))) {
    invalid(path + ".confidence", path + ".confidence must be finite or null");
  }
  if (!["revision", "environment", "unknown"].includes(String(input.scope))) invalid(path + ".scope", path + ".scope is invalid");
  if (input.provenance !== null) {
    if (!isRecord(input.provenance)) invalid(path + ".provenance", path + ".provenance must be an object or null");
    for (const key of ["filePath", "evidenceId"] as const) {
      if (input.provenance[key] !== undefined && typeof input.provenance[key] !== "string") invalid(path + ".provenance." + key, path + ".provenance." + key + " must be a string");
    }
    if (input.provenance.startLine !== undefined && (!Number.isInteger(input.provenance.startLine) || Number(input.provenance.startLine) < 1)) {
      invalid(path + ".provenance.startLine", path + ".provenance.startLine must be a positive integer");
    }
  }
  if (!Array.isArray(input.gaps) || input.gaps.some((gap) => typeof gap !== "string")) invalid(path + ".gaps", path + ".gaps must be a string array");
  return input as unknown as GraphEdgeEvidenceEnvelope;
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
  if (!["source", "graph", "note", "runtime"].includes(String(value.source))) {
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
  if ((value.kind === "symbol" || value.kind === "field")
    && typeof value.nodeId !== "string"
    && typeof (value.locator as Record<string, unknown>).nodeId !== "string") {
    invalid(path + ".nodeId", path + " symbol/field hits must expose a public node id; source-only matches must use kind=source_occurrence");
  }
  return value as unknown as SearchHit;
}

export function validateSearchResponse(input: unknown): SearchResponse {
  if (!isRecord(input)) invalid("response", "response must be an object");
  if (input.schemaVersion !== "2") invalid("response.schemaVersion", "response.schemaVersion must be 2");
  if (!Array.isArray(input.hits)) invalid("response.hits", "response.hits must be an array");
  input.hits.forEach((hit, index) => validateHit(hit, "response.hits[" + index + "]"));
  const hitCount = input.hits.length;
  if (input.returnedCount !== undefined && (!Number.isInteger(input.returnedCount) || Number(input.returnedCount) !== hitCount)) {
    invalid("response.returnedCount", "response.returnedCount must equal response.hits.length");
  }
  if (input.candidateCount !== undefined && (!Number.isInteger(input.candidateCount) || Number(input.candidateCount) < hitCount)) {
    invalid("response.candidateCount", "response.candidateCount must be an integer greater than or equal to response.hits.length");
  }
  if (!isRecord(input.diagnostics)) invalid("response.diagnostics", "response.diagnostics must be an object");
  if (![
    "MATCH",
    "NO_MATCH_VERIFIED",
    "NO_MATCH_INCOMPLETE",
    "SCOPE_ERROR",
    "INDEX_ERROR",
  ].includes(String(input.diagnostics.queryStatus))) {
    invalid("response.diagnostics.queryStatus", "response.diagnostics.queryStatus is invalid");
  }
  if (hitCount > 0 && input.diagnostics.queryStatus !== "MATCH") {
    invalid("response.diagnostics.queryStatus", "response.diagnostics.queryStatus must be MATCH when hits are returned");
  }
  if (hitCount === 0 && input.diagnostics.queryStatus === "MATCH") {
    invalid("response.diagnostics.queryStatus", "response.diagnostics.queryStatus cannot be MATCH when no hits are returned");
  }
  if (!Array.isArray(input.diagnostics.nextActions)) {
    invalid("response.diagnostics.nextActions", "response.diagnostics.nextActions must be an array");
  }
  if (!isRecord(input.diagnostics.requestedScope)) {
    invalid("response.diagnostics.requestedScope", "response.diagnostics.requestedScope must be an object");
  }
  if (!Array.isArray(input.diagnostics.resolvedScope)) {
    invalid("response.diagnostics.resolvedScope", "response.diagnostics.resolvedScope must be an array");
  }
  if (typeof input.diagnostics.scopeApplied !== "boolean") {
    invalid("response.diagnostics.scopeApplied", "response.diagnostics.scopeApplied must be boolean");
  }
  if (!isRecord(input.diagnostics.semantic)
    || typeof input.diagnostics.semantic.requested !== "boolean"
    || typeof input.diagnostics.semantic.applied !== "boolean"
    || !Number.isInteger(input.diagnostics.semantic.ready)
    || !Number.isInteger(input.diagnostics.semantic.expected)
    || !Array.isArray(input.diagnostics.semantic.activeGenerationIds)
    || !Array.isArray(input.diagnostics.semantic.lanesUsed)) {
    invalid("response.diagnostics.semantic", "response.diagnostics.semantic must expose truthful application and progress fields");
  }
  if (!Number.isInteger(input.diagnostics.candidateCount) || Number(input.diagnostics.candidateCount) < 0) {
    invalid("response.diagnostics.candidateCount", "response.diagnostics.candidateCount must be a non-negative integer");
  }
  if (Number(input.diagnostics.candidateCount) < hitCount) {
    invalid("response.diagnostics.candidateCount", "response.diagnostics.candidateCount must be greater than or equal to response.hits.length");
  }
  if (input.candidateCount !== undefined && Number(input.diagnostics.candidateCount) !== Number(input.candidateCount)) {
    invalid("response.diagnostics.candidateCount", "response.diagnostics.candidateCount must equal response.candidateCount");
  }
  if (input.evidence !== undefined) {
    if (!isRecord(input.evidence)) invalid("response.evidence", "response.evidence must be an object");
    if (!Number.isInteger(input.evidence.returnedCount) || Number(input.evidence.returnedCount) !== hitCount) {
      invalid("response.evidence.returnedCount", "response.evidence.returnedCount must equal response.hits.length");
    }
    if (input.evidence.candidateCount !== null && (!Number.isInteger(input.evidence.candidateCount) || Number(input.evidence.candidateCount) < hitCount)) {
      invalid("response.evidence.candidateCount", "response.evidence.candidateCount must be null or an integer greater than or equal to response.hits.length");
    }
    if (input.returnedCount !== undefined && Number(input.evidence.returnedCount) !== Number(input.returnedCount)) {
      invalid("response.evidence.returnedCount", "response.evidence.returnedCount must equal response.returnedCount");
    }
    if (input.candidateCount !== undefined && input.evidence.candidateCount !== null && Number(input.evidence.candidateCount) !== Number(input.candidateCount)) {
      invalid("response.evidence.candidateCount", "response.evidence.candidateCount must equal response.candidateCount");
    }
  }
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
      nextActions: [...response.diagnostics.nextActions].sort((a, b) => a.command.localeCompare(b.command)),
      suggestions: [...response.diagnostics.suggestions].sort((a, b) => a.query.localeCompare(b.query)),
      timingsMs: {},
    } as SearchDiagnostics,
  };
  return stable(normalized) as SearchResponse;
}

/** Canonical shape for every public read-only list. `null` means the source
 * cannot establish the value; callers must inspect `gaps` instead of treating
 * an absent count as zero. */
export interface KnowledgeListEnvelope<T = unknown> {
  items: T[];
  scope: Record<string, unknown> | null;
  revision: Record<string, unknown> | null;
  freshness: Record<string, unknown>;
  coverage: {
    status: "complete" | "partial" | "unknown";
    discovered: number | null;
    admitted: number | null;
    excluded: number | null;
    failed: number | null;
    stale: number | null;
    unresolvedReferences: number | null;
  };
  completeness: "complete" | "lower_bound" | "partial" | "unknown";
  proofStatus: "proven" | "not_proven" | "candidate" | "unresolved";
  candidateCount: number | null;
  returnedCount: number;
  remainingCount: number | null;
  totalIsExact: boolean;
  truncated: boolean;
  nextCursor: string | null;
  gaps: string[];
}
