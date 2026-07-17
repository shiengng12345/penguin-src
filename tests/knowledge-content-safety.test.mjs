import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeUntrustedText } from "../packages/knowledge-core/dist/index.js";

test("source snippets redact high-confidence secrets and PII unless trusted exact is explicit", () => {
  const safe = sanitizeUntrustedText("api_token=super-secret-value-1234 CPF 123.456.789-00 email user@example.com");
  assert.doesNotMatch(safe.text, /super-secret-value|123\.456\.789-00|user@example.com/);
  assert.ok(safe.reasons.includes("secret_pattern"));
  assert.ok(safe.reasons.includes("pii_pattern"));
  assert.equal(sanitizeUntrustedText("api_token=super-secret-value-1234", true).text, "api_token=super-secret-value-1234");
});
