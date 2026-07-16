import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeResponseClasses } from "../packages/api-doc-generator/dist/index.js";
const endpoint = { endpointKey: "svc.Submit", revisionId: "r1", service: "svc", method: "Submit", route: "/submit", protocol: "grpc", description: "", requestFields: [], responseFields: [], enums: [], schemaGaps: [], evidenceIds: ["schema"] };
test("response analysis keeps business/transport outcomes distinct and groups dynamic dependency messages", () => {
  const result = analyzeResponseClasses({ endpoint, requestClasses: [], testFacts: [], runtimeObservations: [], producers: [
    { producerId: "ok", endpointKey: endpoint.endpointKey, kind: "explicit_return", trigger: "success", requestClassIds: [], preconditions: [], transport: { protocol: "grpc", status: "OK" }, businessStatus: "SUCCESS", bodyPresence: "present", messageClass: { kind: "exact", values: ["ok"] }, sideEffects: [], retry: "safe", revisionId: "r1", evidenceIds: ["ok-e"] },
    { producerId: "dep", endpointKey: endpoint.endpointKey, kind: "dependency_failure", trigger: "executor failed", requestClassIds: [], preconditions: [], transport: { protocol: "grpc", status: "INTERNAL" }, bodyPresence: "absent", messageClass: { kind: "dynamic_dependency", pattern: "<dynamic executor error>", producer: "executor" }, sideEffects: [], retry: "conditional", revisionId: "r1", evidenceIds: ["dep-e"] },
    { producerId: "business", endpointKey: endpoint.endpointKey, kind: "business_branch", trigger: "rejected", requestClassIds: [], preconditions: [], transport: { protocol: "grpc", status: "OK" }, businessStatus: "REJECTED", bodyPresence: "present", messageClass: { kind: "static_set", values: ["rejected"] }, sideEffects: [], retry: "safe", revisionId: "r1", evidenceIds: ["business-e"] },
  ] });
  assert.equal(result.classes.length, 3);
  assert.equal(result.classes.filter((item) => item.messageClass.kind === "dynamic_dependency").length, 1);
  assert.equal(result.classes.find((item) => item.messageClass.kind === "dynamic_dependency").bodyPresence, "absent");
  assert.equal(result.unresolvedProducerIds.length, 0);
  assert.ok(result.classes.every((item) => item.revisionId && item.evidenceIds.length));
});
