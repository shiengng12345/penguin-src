import type { DocumentationRevision, EvidenceRef, ExampleDoc, EvidenceGap } from "./types.js";
export interface EvidenceValidation { valid: boolean; missingEvidenceIds: string[]; missingRevisionIds: string[]; gaps: EvidenceGap[] }
export function validateEvidenceReferences(input: { evidence: EvidenceRef[]; revisions: DocumentationRevision[]; references: Array<{ evidenceIds: string[]; revisionId?: string; locator?: string }> }): EvidenceValidation {
  const evidenceIds = new Set(input.evidence.map((item) => item.evidenceId)), revisionIds = new Set(input.revisions.map((item) => item.revisionId));
  const missingEvidenceIds = [...new Set(input.references.flatMap((item) => item.evidenceIds).filter((id) => !evidenceIds.has(id)))];
  const missingRevisionIds = [...new Set(input.references.map((item) => item.revisionId).filter((id): id is string => Boolean(id)).filter((id) => !revisionIds.has(id)))];
  return {
    valid: missingEvidenceIds.length === 0 && missingRevisionIds.length === 0,
    missingEvidenceIds,
    missingRevisionIds,
    gaps: [
      ...missingEvidenceIds.map((id) => ({ gapId: `gap_evidence_${id}`, code: "evidence_unresolved", message: `Evidence ${id} could not be resolved.`, evidenceIds: [] })),
      ...missingRevisionIds.map((id) => ({ gapId: `gap_revision_${id}`, code: "revision_unresolved", message: `Revision ${id} could not be resolved.`, revisionId: id, evidenceIds: [] })),
    ],
  };
}
function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(bearer\s+|token|password|passwd|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1<PLACEHOLDER>").replace(/[A-Za-z0-9_-]{24,}/g, "<PLACEHOLDER>");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|password|secret|api.?key|cookie|authorization/i.test(key) ? "<PLACEHOLDER>" : scrub(item)]));
  return value;
}
export function selectSafeExample(input: { origin: ExampleDoc["origin"]; label: string; value: unknown; revisionId?: string; targetId?: string; observedAt?: string; evidenceIds: string[] }): ExampleDoc { return { exampleId: `example:${input.origin}:${input.evidenceIds.slice().sort().join(",")}:${input.label}`, origin: input.origin, synthetic: input.origin === "synthetic", label: input.label, value: scrub(input.value), ...(input.revisionId ? { revisionId: input.revisionId } : {}), ...(input.targetId ? { targetId: input.targetId } : {}), ...(input.observedAt ? { observedAt: input.observedAt } : {}), evidenceIds: [...new Set(input.evidenceIds)] }; }
