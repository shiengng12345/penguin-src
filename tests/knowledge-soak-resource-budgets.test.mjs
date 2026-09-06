import assert from "node:assert/strict";
import { test } from "node:test";

import { runStressProfile } from "../scripts/knowledge-stress.mjs";
import { createIndexedC6Fixture, closeFixture } from "./helpers/knowledge-c6-fixture.mjs";

test("C6 short soak keeps resource samples and SQLite integrity observable", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 8 });
  closeFixture(fixture);
  const report = await runStressProfile({
    rootPath: fixture.parent,
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    profileName: "soak",
    options: { rootPath: fixture.parent, durationOverride: 0.5, concurrencyOverride: 6, writerOverride: 0, maxRequestsOverride: 700 },
    argv: ["--execute", "--profile", "soak", "--duration-seconds=0.5"],
  });

  assert.ok(report.requestCount > 100, `short soak did not generate enough traffic: ${report.requestCount}`);
  assert.equal(report.rawLockErrorCount, 0);
  assert.equal(report.timeoutCount, 0);
  assert.equal(report.infrastructureErrorCount, 0);
  assert.equal(report.dbIntegrity, "ok", JSON.stringify(report.integrity));
  assert.ok(report.resource.samples.length >= 2);
  assert.ok(Number.isFinite(report.resource.peakRssBytes));
  assert.ok(Number.isFinite(report.resource.peakDiskBytes));
  assert.ok((report.resource.fdStart ?? 0) >= 0 && (report.resource.fdEnd ?? 0) >= 0);
  if (report.resource.fdStart != null && report.resource.fdEnd != null) {
    assert.ok(Math.abs(report.resource.fdEnd - report.resource.fdStart) <= 5, "fixture must not leak file descriptors");
  }
  assert.equal(report.gate.conditions.resources.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.latencyP95.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.latencyP99.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.status, "pass", JSON.stringify(report.gate));
  assert.ok(report.requestCount <= report.profile.maxRequests, "short soak must honor maxRequests");
  assert.ok(report.concurrency.peakActiveWorkers >= 2, JSON.stringify(report.concurrency));
  assert.ok(report.gaps.includes("short_fixture_soak_not_8_hours"), "report must not overclaim the live soak gate");
  assert.equal(report.validRequestsPassed, true);
});
