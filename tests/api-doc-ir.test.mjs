import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocumentKey, createRevisionSetHash, createScenarioId, validateDocumentationRequest } from "../packages/api-doc-generator/dist/index.js";

const base = { subjects: [{ repo: "fpms", service: "FrontendService", method: "Login" }], revision: { branch: "main" }, audience: "frontend", language: "en-US", mode: "preview", includeRuntimeEvidence: false };
test("API documentation identity is stable across ordering and non-canonical mode/revision", () => {
  assert.equal(createDocumentKey(base), createDocumentKey({ ...base, subjects: [...base.subjects].reverse(), mode: "sync", revision: { branch: "feature/x" } }));
  assert.notEqual(createDocumentKey(base), createDocumentKey({ ...base, audience: "operations" }));
  assert.notEqual(createDocumentKey(base), createDocumentKey({ ...base, language: "pt-BR" }));
  assert.notEqual(createDocumentKey(base), createDocumentKey({ ...base, subjects: [{ service: "OtherService" }] }));
});
test("request validation rejects unsafe ambiguity and missing runtime scope", () => {
  assert.equal(validateDocumentationRequest({ ...base, subjects: [] }).ok, false);
  assert.equal(validateDocumentationRequest({ ...base, includeRuntimeEvidence: true, runtimeScope: undefined }).ok, false);
  assert.equal(validateDocumentationRequest({ ...base, subjects: [{ repo: "a" }, { repo: "b" }], revision: { commitSha: "abc" } }).ok, false);
  assert.equal(validateDocumentationRequest({ ...base, nope: true }).ok, false);
});
test("revision and scenario hashes are order independent and do not expose raw paths", () => {
  const revisions = [{ revisionId: "a", repoId: "a", repo: "a", commitSha: "1", trust: "exact_commit", resolutionSource: "commit" }, { revisionId: "b", repoId: "b", repo: "b", commitSha: "2", trust: "exact_commit", resolutionSource: "commit" }];
  assert.equal(createRevisionSetHash(revisions), createRevisionSetHash([...revisions].reverse()));
  assert.equal(createScenarioId({ endpointKey: "x", kind: "request", partitions: ["missing", "empty"], preconditions: ["auth"] }), createScenarioId({ endpointKey: "x", kind: "request", partitions: ["empty", "missing"], preconditions: ["auth"] }));
  assert.match(createDocumentKey(base), /^api-doc:v1:frontend:en-us:[0-9a-f]{16}$/);
  assert.doesNotMatch(createDocumentKey(base), /feature|main/);
});
