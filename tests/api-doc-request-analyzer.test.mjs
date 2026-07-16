import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRequestClasses } from "../packages/api-doc-generator/dist/index.js";
const endpoint = { endpointKey: "svc.Submit", revisionId: "r1", service: "svc", method: "Submit", route: "/submit", protocol: "grpc", description: "", requestFields: [], responseFields: [], enums: [], schemaGaps: [], evidenceIds: ["schema"] };
test("request analysis covers boundaries and oneof/cross-field partitions without Cartesian explosion", () => {
  const result = analyzeRequestClasses({ endpoint, defaultExpectedOutcomeClassIds: ["ok"], constraints: [
    { constraintId: "auth", endpointKey: endpoint.endpointKey, kind: "auth", description: "auth", validPartitions: ["auth:present"], invalidPartitions: ["auth:missing"], preconditions: [], expectedOutcomeClassIds: ["unauth"], sideEffectRisk: "write", evidenceIds: ["auth-e"] },
    { constraintId: "amount", endpointKey: endpoint.endpointKey, kind: "range", fieldPath: "amount", description: "amount", validPartitions: ["amount:min", "amount:max"], invalidPartitions: ["amount:below_min", "amount:above_max"], preconditions: [], expectedOutcomeClassIds: ["bad"], sideEffectRisk: "write", evidenceIds: ["range-e"] },
    { constraintId: "identity", endpointKey: endpoint.endpointKey, kind: "oneof", description: "identity", validPartitions: ["identity:email", "identity:phone"], invalidPartitions: ["identity:both_oneof_members"], preconditions: [], expectedOutcomeClassIds: ["bad"], sideEffectRisk: "write", evidenceIds: ["oneof-e"] },
    { constraintId: "schedule", endpointKey: endpoint.endpointKey, kind: "cross_field", description: "schedule", validPartitions: [], invalidPartitions: ["startAt:missing"], preconditions: ["schedule=true"], expectedOutcomeClassIds: ["bad"], sideEffectRisk: "write", evidenceIds: ["cross-e"] },
  ] });
  assert.ok(result.classes.some((item) => item.bodyPartitions.includes("amount:below_min")));
  assert.ok(result.classes.some((item) => item.bodyPartitions.includes("identity:both_oneof_members")));
  assert.ok(result.classes.some((item) => item.preconditions.includes("schedule=true")));
  assert.ok(result.classes.length < 30);
  assert.equal(new Set(result.classes.map((item) => item.scenarioId)).size, result.classes.length);
  assert.ok(result.classes.every((item) => item.evidenceIds.length > 0));
});
