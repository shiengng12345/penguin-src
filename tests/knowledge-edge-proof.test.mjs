import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEdgeTrust } from "../packages/knowledge-core/dist/index.js";

test("edge trust requires explicit proof and keeps framework convention candidate", () => {
  assert.equal(classifyEdgeTrust({ method: "EXTRACTED", provenance: { proof: "ast_exact" } }).status, "verified");
  assert.equal(classifyEdgeTrust({ method: "INFERRED" }).status, "candidate");
  assert.equal(classifyEdgeTrust({ method: "EXTRACTED", provenance: { frameworkConvention: true } }).status, "candidate");
  assert.equal(classifyEdgeTrust({ method: "EXTRACTED", provenance: { frameworkRegistration: true } }).proof, "framework_registration");
});

