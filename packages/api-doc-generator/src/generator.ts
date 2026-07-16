import { createDocumentKey, createRevisionSetHash } from "./identity.js";
import { validateEvidenceReferences, selectSafeExample } from "./evidence.js";
import { analyzeRequestClasses } from "./request-analyzer.js";
import { analyzeResponseClasses } from "./response-analyzer.js";
import { aggregateDocumentCoverage, deriveCoverage } from "./coverage.js";
import type { ApiDocumentationIR, ChecklistItem, DocumentationFactBundle, EndpointDoc, EvidenceRef, ResponseClass } from "./types.js";
export type ApiDocumentationBuildResult = { status: "generated"; ir: ApiDocumentationIR } | { status: "invalid_fact_bundle"; gaps: import("./types.js").EvidenceGap[] };
export async function buildApiDocumentation(input: { bundle: DocumentationFactBundle }): Promise<ApiDocumentationBuildResult> {
  const { bundle } = input;
  const revisionIds = new Set(bundle.revisions.map((revision) => revision.revisionId));
  const structuralGaps = bundle.endpoints.filter((endpoint) => !revisionIds.has(endpoint.revisionId)).map((endpoint) => ({ gapId: `gap_endpoint_revision_${endpoint.endpointKey}`, code: "revision_unresolved", message: `Endpoint ${endpoint.endpointKey} references an unknown revision.`, endpointKey: endpoint.endpointKey, evidenceIds: [] }));
  if (structuralGaps.length) return { status: "invalid_fact_bundle", gaps: structuralGaps };
  const endpoints: EndpointDoc[] = [];
  const allEvidence: EvidenceRef[] = [...bundle.evidence];
  for (const fact of [...bundle.endpoints].sort((a, b) => a.endpointKey.localeCompare(b.endpointKey))) {
    const constraints = bundle.requestConstraints.filter((item) => item.endpointKey === fact.endpointKey);
    const producers = bundle.responseProducers.filter((item) => item.endpointKey === fact.endpointKey);
    const request = analyzeRequestClasses({ endpoint: fact, constraints, defaultExpectedOutcomeClassIds: producers.map((item) => item.producerId) });
    const runtime = bundle.runtime.observations.filter((item) => item.endpointKey === fact.endpointKey);
    const response = analyzeResponseClasses({ endpoint: fact, requestClasses: request.classes, producers, testFacts: bundle.testFacts, runtimeObservations: runtime });
    const endpointEvidence = [...new Set([...(fact.evidenceIds ?? []), ...constraints.flatMap((item) => item.evidenceIds), ...producers.flatMap((item) => item.evidenceIds)])];
    const validation = validateEvidenceReferences({ evidence: allEvidence, revisions: bundle.revisions, references: [{ evidenceIds: endpointEvidence, revisionId: fact.revisionId }, ...request.classes.map((item) => ({ evidenceIds: item.evidenceIds })), ...response.classes.map((item) => ({ evidenceIds: item.evidenceIds, revisionId: item.revisionId }))] });
    const coverage = deriveCoverage({ endpointKey: fact.endpointKey, schemaGaps: fact.schemaGaps, requestAnalysis: request, responseAnalysis: response, revisionTrust: bundle.revisions.find((revision) => revision.revisionId === fact.revisionId)?.trust ?? "trust_unavailable", evidenceValidation: validation, testCoveredClassIds: bundle.testFacts.flatMap((item) => [...item.coveredProducerIds, ...item.coveredConstraintIds]), runtimeObservedClassIds: runtime.flatMap((item) => item.responseClassId ? [item.responseClassId] : []), runtimeEvidenceState: bundle.runtime.status === "available" ? "available" : bundle.request.includeRuntimeEvidence ? bundle.runtime.status : "not_requested" });
    const examples = runtime.map((item) => selectSafeExample({ origin: "sls", label: `Observed ${item.targetId}`, value: item.payload, revisionId: fact.revisionId, targetId: item.targetId, observedAt: item.observedAt, evidenceIds: item.evidenceIds }));
    endpoints.push({ endpointKey: fact.endpointKey, revisionId: fact.revisionId, service: fact.service, method: fact.method, route: fact.route, protocol: fact.protocol, description: fact.description ?? "", dependencies: [], headers: [], requestSchema: fact.requestFields, responseSchema: fact.responseFields, requestClasses: request.classes, responseClasses: response.classes, examples, frontendGuidance: bundle.codeFacts.filter((item) => item.kind === "frontend_guidance" && item.evidenceIds.length).map((item) => item.statement), evidenceIds: endpointEvidence, gaps: [...fact.schemaGaps, ...coverage.blockers], coverage });
  }
  const documentCoverage = aggregateDocumentCoverage(endpoints);
  const checklist: ChecklistItem[] = bundle.checklistFacts.map((fact) => ({ key: fact.key, text: fact.text, evidenceIds: fact.evidenceIds }));
  const ir: ApiDocumentationIR = { documentKey: createDocumentKey(bundle.request), title: `API Documentation - ${bundle.request.subjects.map((subject) => subject.service ?? subject.route ?? subject.repo ?? "subject").join(", ")}`, revisions: bundle.revisions, enums: bundle.endpoints.flatMap((endpoint) => endpoint.enums), endpoints, websocketEvents: bundle.eventFacts.map((event) => ({ eventKey: event.eventKey, revisionId: event.revisionId, name: event.name, direction: event.direction, payloadSchema: event.payloadFields, behavior: event.behavior ?? "", evidenceIds: event.evidenceIds, gaps: [] })), commonResponses: [], frontendChecklist: checklist, evidence: allEvidence, gaps: [...bundle.gaps, ...endpoints.flatMap((endpoint) => endpoint.gaps)], coverage: documentCoverage };
  return { status: "generated", ir };
}
