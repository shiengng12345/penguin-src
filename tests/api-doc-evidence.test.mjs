import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSafeExample, validateEvidenceReferences } from "../packages/api-doc-generator/dist/index.js";

test("evidence validation fails closed for missing evidence and revisions", () => {
  const result = validateEvidenceReferences({
    evidence: [{ evidenceId: "e1", source: "schema", locator: "svc.Login", status: "verified" }],
    revisions: [{ revisionId: "r1", repoId: "repo", repo: "fpms", commitSha: "abc", trust: "exact_commit", resolutionSource: "commit" }],
    references: [{ evidenceIds: ["e1", "missing"], revisionId: "gone" }],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingEvidenceIds, ["missing"]);
  assert.deepEqual(result.missingRevisionIds, ["gone"]);
  assert.ok(result.gaps.some((gap) => gap.code === "evidence_unresolved"));
  assert.ok(result.gaps.some((gap) => gap.code === "revision_unresolved"));
});

test("safe examples redact credentials, long tokens, and sensitive object keys", () => {
  const example = selectSafeExample({
    origin: "sls",
    label: "observed request",
    value: {
      authorization: "Bearer secret-token-value",
      password: "hunter2",
      nested: "opaque_123456789012345678901234",
      normal: "kept",
    },
    revisionId: "r1",
    targetId: "qat-fpms",
    evidenceIds: ["e2", "e1", "e2"],
  });
  assert.equal(example.synthetic, false);
  assert.equal(example.value.authorization, "<PLACEHOLDER>");
  assert.equal(example.value.password, "<PLACEHOLDER>");
  assert.equal(example.value.normal, "kept");
  assert.equal(example.value.nested, "<PLACEHOLDER>");
  assert.deepEqual(example.evidenceIds, ["e2", "e1"]);
  assert.equal(example.revisionId, "r1");
});

test("synthetic examples are explicitly marked and preserve provenance fields", () => {
  const example = selectSafeExample({ origin: "synthetic", label: "default body", value: { ok: true }, evidenceIds: ["schema-1"] });
  assert.equal(example.synthetic, true);
  assert.equal(example.origin, "synthetic");
  assert.deepEqual(example.evidenceIds, ["schema-1"]);
});
