import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_COVERAGE_POLICY,
  classifyCoveragePath,
} from "../packages/knowledge-indexer/dist/coverage-policy.js";

test("coverage policy admits text classifications including generated/vendor", () => {
  for (const filePath of ["src/app.ts", "config/service.yml", "dist/app.js", "public/vendor.js", "README.md"]) {
    const result = classifyCoveragePath(filePath, DEFAULT_COVERAGE_POLICY);
    assert.equal(result.status, "admitted", filePath);
    assert.equal(result.reasonCode, "text_searchable", filePath);
  }
});

test("coverage policy excludes secrets and path escapes before content reads", () => {
  for (const filePath of [".env", ".env.local", "certs/client.pem", "keys/server.key", "config/credentials.json"]) {
    const result = classifyCoveragePath(filePath, DEFAULT_COVERAGE_POLICY);
    assert.equal(result.status, "excluded", filePath);
    assert.equal(result.reasonCode, "secret_policy", filePath);
  }
  const escaped = classifyCoveragePath("../outside.ts", DEFAULT_COVERAGE_POLICY);
  assert.equal(escaped.status, "excluded");
  assert.equal(escaped.reasonCode, "outside_workspace");
});

test("generated/vendor exclusions require an explicit stricter local policy", () => {
  assert.equal(classifyCoveragePath("dist/app.js", { ...DEFAULT_COVERAGE_POLICY, exactSearchGenerated: false }).reasonCode, "generated_policy");
  assert.equal(classifyCoveragePath("public/vendor/lib.js", { ...DEFAULT_COVERAGE_POLICY, exactSearchVendor: false }).reasonCode, "vendor_policy");
});
