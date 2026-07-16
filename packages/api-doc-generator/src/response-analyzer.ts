import { createScenarioId } from "./identity.js";
import type { EndpointFact, RequestClass, ResponseClass, ResponseClassAnalysis, ResponseProducerFact, RuntimeEvidenceObservation, TestFact } from "./types.js";
export function analyzeResponseClasses(input: { endpoint: EndpointFact; requestClasses: RequestClass[]; producers: ResponseProducerFact[]; testFacts: TestFact[]; runtimeObservations: RuntimeEvidenceObservation[] }): ResponseClassAnalysis {
  const classes: ResponseClass[] = [], dynamic = new Set<string>();
  for (const producer of input.producers) {
    const partitions = [producer.producerId, producer.trigger, String(producer.businessStatus ?? ""), producer.messageClass.kind, producer.bodyPresence];
    const outcomeClassId = createScenarioId({ endpointKey: input.endpoint.endpointKey, kind: "response", partitions, preconditions: producer.preconditions });
    const existing = classes.find((item) => item.outcomeClassId === outcomeClassId);
    const item: ResponseClass = { outcomeClassId, trigger: producer.trigger, requestClassIds: producer.requestClassIds.length ? producer.requestClassIds : input.requestClasses.map((request) => request.scenarioId), preconditions: producer.preconditions, transport: producer.transport, businessStatus: producer.businessStatus, bodyPresence: producer.bodyPresence, bodyShape: producer.bodyShape, messageClass: producer.messageClass, sideEffects: producer.sideEffects, retry: producer.retry, frontendAction: producer.frontendAction, revisionId: producer.revisionId, evidenceIds: producer.evidenceIds.length ? producer.evidenceIds : input.endpoint.evidenceIds, examples: [], coverage: producer.kind === "runtime" ? "observed" : "bounded" };
    if (!existing) classes.push(item);
    if (producer.messageClass.kind === "dynamic_dependency") dynamic.add(producer.producerId);
  }
  for (const observation of input.runtimeObservations) {
    const found = observation.responseClassId ? classes.find((item) => item.outcomeClassId === observation.responseClassId) : undefined;
    if (found) found.coverage = "observed";
  }
  const discovered = input.producers.map((producer) => producer.producerId);
  const unresolved = input.producers.filter((producer) => producer.kind === "dependency_failure" && producer.messageClass.kind !== "dynamic_dependency").map((producer) => producer.producerId);
  return { classes, discoveredProducerIds: discovered, resolvedProducerIds: discovered.filter((id) => !unresolved.includes(id)), unresolvedProducerIds: unresolved, dynamicProducerIds: [...dynamic] };
}
