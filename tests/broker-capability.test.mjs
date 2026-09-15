// tests/broker-capability.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { probe } from "../scripts/broker-capability-probe.mjs";

const ADMIN = process.env.BROKER_ADMIN_URL ?? "http://localhost:8080";

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
