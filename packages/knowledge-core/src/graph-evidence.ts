import type { GraphEdgeEvidenceEnvelope } from "@penguin/knowledge-contracts";

export interface RawGraphEdgeEvidence {
  edgeType?: unknown;
  origin?: unknown;
  method?: unknown;
  confidence?: unknown;
  provenance?: unknown;
  evidenceId?: unknown;
  scope?: unknown;
  branchId?: unknown;
}

const EXECUTION_EDGE_TYPES = new Set([
  "handles",
  "calls",
  "renders",
  "invokes_dynamic",
  "invokes",
  "dispatches_to",
  "injects",
  "provides",
  "implements",
  "reads",
  "writes",
  "throws",
  "uses",
]);

const REFERENCE_EDGE_TYPES = new Set(["references"]);

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveLine(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && Number.isInteger(number) && number >= 1 ? number : null;
}

function normalizedProvenance(raw: RawGraphEdgeEvidence, parsed: Record<string, unknown> | null): GraphEdgeEvidenceEnvelope["provenance"] {
  const filePath = nonEmptyString(parsed?.filePath) ?? nonEmptyString(parsed?.file);
  const startLine = positiveLine(parsed?.startLine) ?? positiveLine(parsed?.line);
  const evidenceId = nonEmptyString(raw.evidenceId) ?? nonEmptyString(parsed?.evidenceId) ?? nonEmptyString(parsed?.evidence_id);
  if (!filePath && startLine == null && !evidenceId) return null;
  return {
    ...(filePath ? { filePath } : {}),
    ...(startLine == null ? {} : { startLine }),
    ...(evidenceId ? { evidenceId } : {}),
  };
}

function normalizedScope(raw: RawGraphEdgeEvidence, parsed: Record<string, unknown> | null): GraphEdgeEvidenceEnvelope["scope"] {
  const value = nonEmptyString(raw.scope) ?? nonEmptyString(parsed?.scope);
  if (value === "revision" || value === "environment") return value;
  if (raw.branchId != null || value === "branch") return "revision";
  return "unknown";
}

/**
 * Convert every storage/query edge representation into the public evidence
 * contract. This intentionally does not claim that a framework adapter is a
 * direct runtime call: those edges are statically inferred, even though the
 * adapter itself has a source locator.
 */
export function graphEdgeEvidence(raw?: RawGraphEdgeEvidence | null, fallbackGap = "edge_record_missing"): GraphEdgeEvidenceEnvelope {
  const input = raw ?? {};
  const parsed = record(input.provenance);
  const origin = nonEmptyString(input.origin) ?? nonEmptyString(parsed?.evidenceOrigin);
  const method = nonEmptyString(input.method);
  const provenance = normalizedProvenance(input, parsed);
  const scope = normalizedScope(input, parsed);
  const edgeType = nonEmptyString(input.edgeType);
  const gaps: string[] = [];
  const hasRecord = raw != null;
  if (!hasRecord) gaps.push(fallbackGap);
  if (hasRecord && !origin && !method && !provenance) gaps.push("edge_evidence_missing");
  if (hasRecord && !provenance) gaps.push("provenance_locator_missing");

  let evidenceState: GraphEdgeEvidenceEnvelope["evidenceState"] = "unresolved";
  if (method === "RUNTIME_OBSERVED" || parsed?.evidenceOrigin === "runtime_observation") {
    evidenceState = "proven";
  } else if (method === "EXTRACTED" || method === "ASSERTED") {
    evidenceState = origin || provenance ? "proven" : "unresolved";
  } else if (method === "INFERRED") {
    evidenceState = "candidate";
  } else if (edgeType === "injects" || edgeType === "provides" || edgeType === "implements" || edgeType === "dispatches_to"
    || method === "DI_MODULE_PROVIDER" || method === "INTERFACE_IMPLEMENTATION") {
    evidenceState = "inferred";
  } else if (origin || method || provenance) {
    evidenceState = "candidate";
  }

  return {
    evidenceState,
    origin,
    method,
    confidence: finiteNumber(input.confidence),
    scope,
    provenance,
    gaps: [...new Set(gaps)],
  };
}

export function unresolvedGraphEdgeEvidence(reason = "edge_record_missing"): GraphEdgeEvidenceEnvelope {
  return graphEdgeEvidence(null, reason);
}

export function isExecutionEdge(edgeType: string): boolean {
  return EXECUTION_EDGE_TYPES.has(edgeType);
}

export function isReferenceEdge(edgeType: string): boolean {
  return REFERENCE_EDGE_TYPES.has(edgeType);
}

export { EXECUTION_EDGE_TYPES, REFERENCE_EDGE_TYPES };
