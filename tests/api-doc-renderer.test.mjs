import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManagedSections, renderApiDocumentation } from "../packages/api-doc-generator/dist/index.js";
const revision = { revisionId: "r1", repoId: "repo", repo: "fpms", commitSha: "abc", trust: "exact_commit", resolutionSource: "commit" };
const field = { path: "request.email", name: "email", type: "string", presence: "optional", repeated: false, evidenceIds: ["schema"] };
const ir = { documentKey: "api-doc:v1:frontend:en-us:aaaaaaaaaaaaaaaa", title: "Responsible Gaming", revisions: [revision], enums: [{ name: "Status", revisionId: "r1", values: [{ name: "OK", number: 0 }], evidenceIds: ["schema"] }], endpoints: [{ endpointKey: "rg.GetLimit", revisionId: "r1", service: "rg", method: "GetLimit", route: "/rg/limit", protocol: "grpc", description: "get limit", dependencies: [], headers: [], requestSchema: [field], responseSchema: [field], requestClasses: [{ scenarioId: "s1", scenario: "valid", headers: [], bodyPartitions: ["valid"], preconditions: [], validity: "valid", expectedOutcomeClassIds: ["o1"], sideEffectRisk: "none", evidenceIds: ["schema"], coverage: "partial" }], responseClasses: [{ outcomeClassId: "o1", trigger: "success", requestClassIds: ["s1"], preconditions: [], transport: { protocol: "grpc", status: "OK" }, bodyPresence: "present", messageClass: { kind: "exact", values: ["ok"] }, sideEffects: [], retry: "safe", revisionId: "r1", evidenceIds: ["schema"], examples: [], coverage: "partial" }], examples: [], frontendGuidance: [], evidenceIds: ["schema"], gaps: [{ gapId: "g", code: "no_static_edge", message: "notifyRgPopup unresolved", evidenceIds: [] }], coverage: { level: "partial", analyzedRequestPartitions: 1, unresolvedRequestConstraints: 0, discoveredStaticExits: 1, resolvedStaticExits: 1, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "not_requested", blockers: [] } }], websocketEvents: [{ eventKey: "rg.event", revisionId: "r1", name: "LimitChanged", direction: "server_to_client", payloadSchema: [], behavior: "updates", evidenceIds: ["schema"], gaps: [] }], commonResponses: [], frontendChecklist: [{ key: "auth", text: "send auth", evidenceIds: ["schema"] }], evidence: [{ evidenceId: "schema", source: "schema", revisionId: "r1", locator: "demo.proto", status: "verified" }], gaps: [{ gapId: "g", code: "no_static_edge", message: "notifyRgPopup unresolved", evidenceIds: [] }], coverage: { level: "partial", analyzedRequestPartitions: 1, unresolvedRequestConstraints: 0, discoveredStaticExits: 1, resolvedStaticExits: 1, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "not_requested", blockers: [] } };
test("renderer preserves Responsible Gaming sections, markers and partial coverage", () => {
  const rendered = renderApiDocumentation(ir);
  assert.match(rendered.markdown, /Generation coverage and evidence freshness/);
  assert.match(rendered.markdown, /Enums/);
  assert.match(rendered.markdown, /HEADER[\s\S]*REQUEST[\s\S]*RESPONSE/);
  assert.match(rendered.markdown, /Known Response Matrix/);
  assert.match(rendered.markdown, /WebSocket/);
  assert.match(rendered.markdown, /Frontend Checklist/);
  assert.match(rendered.markdown, /notifyRgPopup/);
  assert.doesNotMatch(rendered.markdown, /All Possible Responses/);
  assert.match(rendered.larkXml, /PENGUIN_API_DOC_BEGIN/);
  assert.equal(rendered.markdown, renderApiDocumentation(ir).markdown);
});
test("managed-section parser rejects unbalanced or duplicate marker structures", () => {
  const ok = parseManagedSections(ir.documentKey, [
    { blockId: "b", topLevelIndex: 0, xml: `<p>PENGUIN_API_DOC_BEGIN:v1:${ir.documentKey}:summary</p>` },
    { blockId: "c", topLevelIndex: 1, xml: "<p>content</p>" },
    { blockId: "e", topLevelIndex: 2, xml: `<p>PENGUIN_API_DOC_END:v1:${ir.documentKey}:summary</p>` },
  ]);
  assert.equal(ok.status, "ok");
  const bad = parseManagedSections(ir.documentKey, [{ blockId: "b", topLevelIndex: 0, xml: `<p>PENGUIN_API_DOC_BEGIN:v1:${ir.documentKey}:summary</p>` }]);
  assert.equal(bad.status, "structural_conflict");
});
