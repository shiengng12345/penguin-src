// tests/broker-capability.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { probe, probeAuth } from "../scripts/broker-capability-probe.mjs";

const ADMIN = process.env.BROKER_ADMIN_URL ?? "http://localhost:8080";
const SECURE = process.env.BROKER_SECURE_URL ?? "http://localhost:8081";

test("broker capability probe reproduces the Phase 0 findings", async () => {
  const report = await probe(ADMIN);
  assert.equal(report.brokerVersion, "4.2.4", "pinned broker version");
  assert.ok(report.clusters.includes("standalone"));
  for (const id of ["V-A5", "V-A6", "V-B3", "V-B4", "V-D3", "V-E5", "V-E6", "V-E7", "V-E8"]) {
    assert.equal(report.findings[id]?.ok, true, `${id}: ${report.findings[id]?.detail}`);
  }
});

test("peeking never advances the cursor (V-B2 — empty-topic proof only)", async () => {
  // Called out separately because it is the safety property the whole module
  // rests on: an operator inspecting a topic must not steal from its
  // consumers. The proof runs against an empty scratch topic (Admin REST
  // cannot produce), so it shows peek does not fabricate cursor movement —
  // not that peek leaves a real message's cursor untouched. See the
  // `strength: "empty-topic-only"` field on the finding.
  const report = await probe(ADMIN);
  const finding = report.findings["V-B2"];
  assert.equal(finding.ok, true, `peek moved the cursor or drained backlog — ${finding.detail}`);
  assert.equal(finding.strength, "empty-topic-only", "proof-strength disclosure must be present on V-B2");
});

test("probe leaves no scratch resources behind", async () => {
  const res = await fetch(`${ADMIN}/admin/v2/persistent/public/default`);
  const topics = await res.json();
  assert.equal(topics.filter((t) => t.includes("broker-probe")).length, 0);
});

test("cleanup runs even when the probe throws mid-run (forced non-JSON response)", async () => {
  // Stub fetch so the V-A6 `/partitioned` call — which the probe issues
  // *after* creating the broker-probe-plain and broker-probe-part scratch
  // topics but *before* the V-E6 tenant/namespace ever get created — returns
  // a non-JSON body. The probe's own unguarded `JSON.parse` on that response
  // throws, which must send the function through its `finally` cleanup
  // instead of leaving broker-probe-plain/broker-probe-part (or, on a
  // differently-timed failure, the broker-probe-t tenant/namespace) orphaned
  // on the broker. Every other call passes through to the real broker.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === "string" ? url : String(url);
    if (href.includes("/partitioned")) {
      return new Response("not valid json {{{", { status: 200 });
    }
    return originalFetch(url, opts);
  };

  try {
    await assert.rejects(() => probe(ADMIN));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const topicsRes = await fetch(`${ADMIN}/admin/v2/persistent/public/default`);
  const topics = await topicsRes.json();
  assert.equal(topics.filter((t) => t.includes("broker-probe")).length, 0,
    "a scratch topic survived a mid-probe failure");

  const tenantsRes = await fetch(`${ADMIN}/admin/v2/tenants`);
  const tenants = await tenantsRes.json();
  assert.equal(tenants.includes("broker-probe-t"), false,
    "the scratch tenant survived a mid-probe failure");
});

// Decode a JWT's `exp` claim (seconds since epoch) without verifying the
// signature — we only need to know when the token lapses, not validate it.
function decodeExp(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return payload.exp ?? null;
}

// Shared by every test below: reads the auth-shape scratch tokens and waits
// for the 1s-TTL expired token to actually lapse before returning
// probeAuth's five shapes. Called fresh per test rather than memoized, since
// each test run is independent and the wait is a no-op once the token has
// already expired (waitMs <= 0).
async function authShapes() {
  const nobody = (await readFile(new URL("../infra/broker/secure/nobody.jwt", import.meta.url), "utf8")).trim();
  const expired = (await readFile(new URL("../infra/broker/secure/expired.jwt", import.meta.url), "utf8")).trim();

  const exp = decodeExp(expired);
  if (exp !== null) {
    const waitMs = exp * 1000 - Date.now() + 1000; // +1s margin past expiry
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  return probeAuth(SECURE, { nobody, expired });
}

test("local-secure profile produces real 401/403 shapes across superuser and scoped operations", async () => {
  // V-F1 / V-F2 — the local-open broker has no auth provider, so it can never
  // produce these rejections. This is the only place in the module these
  // shapes are ever observed, which is why Task 8's error map is built from
  // the exact status/reason/bodyKind recorded here rather than from
  // documentation.
  //
  // Controller ruling A: 401-vs-403 is endpoint-dependent, not credential-
  // dependent — the same no-permission token gets 401 from a superuser-gated
  // operation (list tenants) and 403 from a namespace/topic-scoped one (get
  // topics), so both shapes are asserted rather than picking one.
  const shapes = await authShapes();

  assert.equal(shapes.noToken.status, 401, "no token must be rejected, not silently allowed");
  assert.equal(shapes.badToken.status, 401, "a malformed token must be 401");
  assert.equal(shapes.expiredToken.status, 401, "an expired token must be rejected as unauthenticated");
  assert.equal(shapes.forbiddenSuperuser.status, 401,
    "a valid token without permission on a superuser-gated operation (list tenants) is 401, not 403");
  assert.equal(shapes.forbiddenScoped.status, 403,
    "a valid token without permission on a namespace/topic-scoped operation (get topics) is 403");

  // Controller ruling B: record the body SHAPE, not just the status — 403
  // carries a JSON `reason` naming the operation and resource; 401 does not.
  assert.equal(shapes.noToken.bodyKind, "html", "a bare auth rejection is a generic Jetty HTML page, not JSON");
  assert.equal(shapes.forbiddenScoped.bodyKind, "json", "a scoped authorization rejection is JSON");
  assert.ok(shapes.forbiddenScoped.reason && shapes.forbiddenScoped.reason.length > 0,
    "the scoped 403's reason must be extractable and non-empty");
});

test("expired, missing and malformed tokens are indistinguishable at the HTTP layer (V-F1)", async () => {
  // Controller ruling C: this is not a limitation to work around — it is
  // itself the finding the module's error map must respect. Pulsar returns
  // byte-identical 401 responses for no token, a malformed token, and an
  // expired token, so the module must never claim to tell a user their
  // token "expired" versus simply being wrong. If a future Pulsar version
  // starts distinguishing these, this assertion breaks and we find out.
  const shapes = await authShapes();

  assert.equal(shapes.noToken.status, shapes.badToken.status);
  assert.equal(shapes.badToken.status, shapes.expiredToken.status);
  assert.equal(shapes.noToken.body, shapes.badToken.body,
    "noToken and badToken bodies must be identical — this is the observed behavior, not an assumption");
  assert.equal(shapes.badToken.body, shapes.expiredToken.body,
    "badToken and expiredToken bodies must be identical — Pulsar gives no way to tell 'expired' from 'wrong' here");
});
