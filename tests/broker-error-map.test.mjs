// tests/broker-error-map.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { isSuccess, mapHttpError, mapTransportError } from "@penguin/broker-core";

const FIXTURES_DIR = new URL("./fixtures/broker/", import.meta.url);

test("success spans 200, 202 and 204", () => {
  // 202 is the schema compatibility endpoint's success code; 204 is every write.
  // Hardcoding `=== 200` silently breaks both.
  assert.equal(isSuccess(200), true);
  assert.equal(isSuccess(202), true);
  assert.equal(isSuccess(204), true);
  assert.equal(isSuccess(404), false);
});

test("an incompatible schema is a result, not a server fault", () => {
  const reason =
    "Error during schema compatibility check with strategy FULL: " +
    "org.apache.avro.SchemaValidationException: Unable to read schema";
  const err = mapHttpError(500, reason, "/admin/v2/schemas/public/default/t/compatibility");
  assert.equal(err.code, "SCHEMA_INCOMPATIBLE");
  assert.equal(err.retryable, false, "retrying an incompatible schema never helps");
});

test("an infrastructure fault mentioning schema compatibility is retryable, not an incompatible schema", () => {
  // The loose phrase "schema compatibility check" appears in genuine infra
  // faults too (e.g. a zookeeper outage encountered while doing the check).
  // Only an actual exception class name is specific enough to mean the
  // schema itself is the problem; the phrase alone must fall through to the
  // generic 500 handling (SOURCE_UNAVAILABLE, retryable) instead.
  const reason = "Error during schema compatibility check: connection to zookeeper lost";
  const err = mapHttpError(500, reason, "/admin/v2/schemas/public/default/t/compatibility");
  assert.equal(err.code, "SOURCE_UNAVAILABLE");
  assert.equal(err.retryable, true);
});

test("a genuine 500 stays retryable", () => {
  const err = mapHttpError(500, "Internal server error", "/admin/v2/tenants");
  assert.equal(err.code, "SOURCE_UNAVAILABLE");
  assert.equal(err.retryable, true);
});

test("405 on peek means not-supported-here, not method-not-allowed noise", () => {
  const err = mapHttpError(405, "Peek messages on a partitioned topic is not allowed", "/peek");
  assert.equal(err.code, "NOT_SUPPORTED_HERE");
  assert.equal(err.retryable, false);
});

test("409 is a conflict the user must resolve, not a retry", () => {
  const err = mapHttpError(409, "Topic has active subscriptions", "/admin/v2/tenants/x");
  assert.equal(err.code, "CONFLICT");
  assert.equal(err.retryable, false);
});

test("auth failures are terminal", () => {
  assert.equal(mapHttpError(401, null, "/x").code, "AUTHENTICATION_FAILED");
  assert.equal(mapHttpError(401, null, "/x").retryable, false);
  assert.equal(mapHttpError(403, null, "/x").code, "FORBIDDEN");
});

test("rate limiting is retryable", () => {
  const err = mapHttpError(429, null, "/x");
  assert.equal(err.code, "RATE_LIMITED");
  assert.equal(err.retryable, true);
});

test("transport failures map by kind", () => {
  assert.equal(mapTransportError({ kind: "timeout", message: "" }).code, "TIMEOUT");
  assert.equal(mapTransportError({ kind: "tls", message: "" }).code, "TLS_ERROR");
  assert.equal(mapTransportError({ kind: "tls", message: "" }).retryable, false);
  assert.equal(mapTransportError({ kind: "connect", message: "" }).code, "SOURCE_UNAVAILABLE");
  assert.equal(mapTransportError({ kind: "parse", message: "" }).code, "MALFORMED_RESPONSE");
});

test("the reason field is carried through for display", () => {
  const err = mapHttpError(404, "Namespace does not exist", "/x");
  assert.equal(err.code, "NOT_FOUND");
  assert.match(err.message, /Namespace does not exist/);
});

// --- Additional tests: the three measured auth-shape consequences (Task 3 Step 6) ---
// Real shapes observed against a JWT-enabled Pulsar, recorded in
// task-3-report.md's "Final five shapes" table.

test("a 401 carrying JSON still yields its reason (bodyKind does not correlate with status)", () => {
  // `forbiddenSuperuser`: a cryptographically valid token, on a superuser-gated
  // endpoint, returns 401 -- but unlike noToken/badToken/expiredToken, its body
  // IS parseable JSON with a `reason`. The mapper must never assume "401 means
  // no JSON"; it must always attempt the parse and use the reason when present.
  const reason =
    "Unauthorized to validateBothTenantOperationAndSuperUser for originalPrincipal " +
    "[null] and clientAppId [nobody] about operation [LIST_TENANTS] ";
  const err = mapHttpError(401, reason, "/admin/v2/tenants");
  assert.equal(err.code, "AUTHENTICATION_FAILED");
  assert.equal(err.retryable, false);
  assert.match(err.message, /LIST_TENANTS/, "the specific observed reason must be surfaced, not discarded");
});

test("a 401 with an unparseable HTML body degrades to an honest, non-empty, non-HTML message", () => {
  // noToken / badToken / expiredToken all return byte-identical generic Jetty
  // HTML with no machine-readable reason. The caller extracts `reason` by
  // attempting a parse and passes null on failure -- the fallback message
  // must never be empty and must never leak HTML into a user-facing string.
  const err = mapHttpError(401, null, "/admin/v2/tenants");
  assert.equal(err.code, "AUTHENTICATION_FAILED");
  assert.ok(err.message.length > 0, "fallback message must never be empty");
  assert.doesNotMatch(err.message, /<[a-z][\s\S]*>/i, "fallback message must never leak HTML markup");
});

test("AUTHENTICATION_FAILED never claims the credential itself is wrong", () => {
  // Missing, malformed and expired tokens are byte-identical over HTTP, and a
  // VALID token on a superuser-gated endpoint also yields 401. So the message
  // must not assert "token expired" or "invalid token" as fact -- it must
  // honestly cover all four possibilities (missing, malformed, expired,
  // insufficient privilege) instead of presenting inference as fact.
  const err = mapHttpError(401, null, "/admin/v2/tenants");
  assert.doesNotMatch(err.message, /token expired/i);
  assert.doesNotMatch(err.message, /invalid token/i);
  assert.match(err.message, /missing/i);
  assert.match(err.message, /malformed/i);
  assert.match(err.message, /expired/i);
  assert.match(err.message, /privilege/i);
});

// --- Captured-evidence tests: real responses from the unauthenticated `pulsar`
// container (Admin REST http://localhost:8080), probed against a real
// `broker-probe-schema` topic. See task-8-report.md fix round 1 for the
// verbatim capture steps, both observed status codes, and cleanup
// confirmation. The `reason` used below comes from the fixture file, not a
// hand-copied string literal.

test("the captured incompatible-schema fixture (real 500) maps to SCHEMA_INCOMPATIBLE", async () => {
  const raw = await readFile(new URL("schema-incompatible-500.json", FIXTURES_DIR), "utf8");
  const { reason } = JSON.parse(raw);
  assert.ok(reason && reason.length > 0, "fixture must carry a non-empty reason");

  const err = mapHttpError(500, reason, "/admin/v2/schemas/public/default/broker-probe-schema/compatibility");
  assert.equal(err.code, "SCHEMA_INCOMPATIBLE");
  assert.equal(err.retryable, false);
});

test("the captured compatible-schema fixture (real 202) is a success status", async () => {
  const raw = await readFile(new URL("schema-compatible-202.json", FIXTURES_DIR), "utf8");
  const body = JSON.parse(raw);
  assert.equal(body.compatibility, true);
  assert.equal(isSuccess(202), true);
});
