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

test("peeking never consumes a message (V-B2)", async () => {
  // Called out separately because it is the safety property the whole module
  // rests on: an operator inspecting a topic must not steal from its consumers.
  const report = await probe(ADMIN);
  const finding = report.findings["V-B2"];
  assert.equal(finding.ok, true, `peek moved the cursor or drained backlog — ${finding.detail}`);
});

test("probe leaves no scratch resources behind", async () => {
  const res = await fetch(`${ADMIN}/admin/v2/persistent/public/default`);
  const topics = await res.json();
  assert.equal(topics.filter((t) => t.includes("broker-probe")).length, 0);
});
