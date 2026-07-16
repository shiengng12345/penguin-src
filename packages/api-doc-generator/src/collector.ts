import { createHash } from "node:crypto";
import type { DocumentationCollectionResult, DocumentationFactBundle, DocumentationRequest, DocumentationSourceAdapter, EvidenceRef, ResolvedSubject, RuntimeEvidenceResult } from "./types.js";
import { canonicalJson } from "./identity.js";

function evidenceId(source: EvidenceRef["source"], locator: string, revisionId: string | undefined, payload: unknown): string {
  return `${source}:${createHash("sha256").update(canonicalJson({ source, locator, revisionId, payload })).digest("hex").slice(0, 24)}`;
}
function addEvidence(out: EvidenceRef[], source: EvidenceRef["source"], locator: string, revisionId: string | undefined, payload: unknown, status: EvidenceRef["status"] = "verified"): string {
  const id = evidenceId(source, locator, revisionId, payload);
  if (!out.some((item) => item.evidenceId === id)) out.push({ evidenceId: id, source, locator, revisionId, status });
  return id;
}
const emptyRuntime = (requested: boolean): RuntimeEvidenceResult => requested ? { status: "unavailable", observations: [], evidence: [], gaps: [{ gapId: "gap_runtime_unavailable", code: "runtime_evidence_unavailable", message: "Runtime evidence was requested but no provider was available.", evidenceIds: [] }] } : { status: "unavailable", observations: [], evidence: [], gaps: [] };

export async function collectDocumentationFacts(request: DocumentationRequest, adapter: DocumentationSourceAdapter): Promise<DocumentationCollectionResult> {
  const resolved = await adapter.resolveSubjects(request.subjects);
  if (resolved.status !== "resolved") return resolved;
  let revisions: DocumentationFactBundle["revisions"];
  try { revisions = await adapter.resolveRevisions(request, resolved.subjects); } catch (error) {
    const message = String((error as Error).message ?? error);
    return { status: "ambiguous_revision", repos: resolved.subjects.map((subject) => subject.repo), reason: message };
  }
  const revisionByRepo = new Map(revisions.map((revision) => [revision.repoId, revision]));
  const gaps = [] as DocumentationFactBundle["gaps"];
  const evidence: EvidenceRef[] = [];
  const endpoints = [], requestConstraints = [], responseProducers = [], codeFacts = [], testFacts = [], wikiFacts = [], eventFacts = [], checklistFacts = [];
  for (const subject of [...resolved.subjects].sort((a, b) => a.identityKey.localeCompare(b.identityKey))) {
    const revision = revisionByRepo.get(subject.repoId);
    if (!revision) { gaps.push({ gapId: `gap_revision_${subject.repoId}`, code: "revision_unresolved", message: `No revision resolved for ${subject.repo}.`, evidenceIds: [] }); continue; }
    const endpoint = await adapter.collectEndpoint(subject, revision);
    endpoint.evidenceIds = [...new Set(endpoint.evidenceIds)];
    endpoint.schemaGaps.forEach((gap) => gaps.push(gap));
    endpoints.push(endpoint);
    requestConstraints.push(...await adapter.collectRequestConstraints(subject, revision));
    responseProducers.push(...await adapter.collectResponseProducers(subject, revision));
    codeFacts.push(...await adapter.collectCodeFacts(subject, revision));
    testFacts.push(...await adapter.collectTestFacts(subject, revision));
    wikiFacts.push(...await adapter.collectWikiFacts(subject, revision));
    eventFacts.push(...await adapter.collectEvents(subject, revision));
    checklistFacts.push(...await adapter.collectChecklistFacts(subject, revision));
    const sourceEvidence = endpoint.evidenceIds.length ? endpoint.evidenceIds : [addEvidence(evidence, "schema", subject.endpointKey, revision.revisionId, endpoint)];
    endpoint.evidenceIds = sourceEvidence;
    for (const collection of [requestConstraints, responseProducers, codeFacts, testFacts, wikiFacts, eventFacts, checklistFacts]) {
      for (const fact of collection.filter((item) => "endpointKey" in item && (item as { endpointKey?: string }).endpointKey === subject.endpointKey)) {
        if (!(fact as { evidenceIds?: string[] }).evidenceIds?.length) (fact as { evidenceIds: string[] }).evidenceIds = [addEvidence(evidence, "code", `${subject.endpointKey}:${fact.constructor.name}`, revision.revisionId, fact)];
      }
    }
  }
  const runtime = request.includeRuntimeEvidence && adapter.collectRuntimeEvidence ? await adapter.collectRuntimeEvidence(request, resolved.subjects, revisions) : emptyRuntime(request.includeRuntimeEvidence);
  evidence.push(...runtime.evidence);
  gaps.push(...runtime.gaps);
  return { status: "collected", bundle: { request, subjects: resolved.subjects, revisions, endpoints, requestConstraints, responseProducers, codeFacts, testFacts, wikiFacts, eventFacts, checklistFacts, runtime, evidence, gaps } };
}
