import { createScenarioId } from "./identity.js";
import type { EndpointFact, RequestClass, RequestClassAnalysis, RequestConstraintFact } from "./types.js";
export function analyzeRequestClasses(input: { endpoint: EndpointFact; constraints: RequestConstraintFact[]; defaultExpectedOutcomeClassIds: string[] }): RequestClassAnalysis {
  const classes: RequestClass[] = [];
  const add = (scenario: string, bodyPartitions: string[], validity: RequestClass["validity"], preconditions: string[], sideEffectRisk: RequestClass["sideEffectRisk"], evidenceIds: string[]) => {
    const scenarioId = createScenarioId({ endpointKey: input.endpoint.endpointKey, kind: "request", partitions: bodyPartitions, preconditions });
    if (!classes.some((item) => item.scenarioId === scenarioId)) classes.push({ scenarioId, scenario, headers: [], bodyPartitions, preconditions, validity, expectedOutcomeClassIds: input.defaultExpectedOutcomeClassIds, sideEffectRisk, evidenceIds: [...new Set(evidenceIds)], coverage: "bounded" });
  };
  add("canonical valid request", ["body:valid"], "valid", [], "none", input.endpoint.evidenceIds);
  for (const constraint of input.constraints) {
    const evidence = [...new Set([...constraint.evidenceIds, ...input.endpoint.evidenceIds])];
    for (const partition of constraint.validPartitions) add(`${constraint.description}: ${partition}`, [partition], "valid", constraint.preconditions, constraint.sideEffectRisk, evidence);
    for (const partition of constraint.invalidPartitions) add(`${constraint.description}: ${partition}`, [partition], "invalid", constraint.preconditions, constraint.sideEffectRisk, evidence);
  }
  return { classes, analyzedConstraintIds: input.constraints.map((item) => item.constraintId), unresolvedConstraintIds: [], generationStrategy: "equivalence_boundary_pairwise" };
}
