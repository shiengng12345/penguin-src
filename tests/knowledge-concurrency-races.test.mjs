import assert from "node:assert/strict";
import { test } from "node:test";

import { runStressProfile } from "../scripts/knowledge-stress.mjs";
import { createIndexedC6Fixture, closeFixture } from "./helpers/knowledge-c6-fixture.mjs";

test("C6 writer race serializes two writers while readers continue", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 2, filesPerRepo: 6 });
  closeFixture(fixture);
  const report = await runStressProfile({
    rootPath: fixture.parent,
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    profileName: "writer_race",
    options: {
      rootPath: fixture.parent,
      durationOverride: 0.35,
      concurrencyOverride: 6,
      writerOverride: 2,
      sessionsOverride: 2,
      maxRequestsOverride: 300,
    },
    argv: ["--execute", "--profile", "writer_race", "--writer-concurrency=2"],
  });

  assert.equal(report.profile.concurrentWriters, 2);
  assert.equal(report.operationIds.filter((id) => id.startsWith("writer:")).length, 2, "both writer requests need receipts");
  assert.ok(report.requestCount >= 2, "writer and reader requests must be counted");
  assert.equal(report.rawLockErrorCount, 0, JSON.stringify(report.errorsByType));
  assert.equal(report.timeoutCount, 0, JSON.stringify(report.errorsByType));
  assert.equal(report.infrastructureErrorCount, 0, JSON.stringify(report.errorSamples));
  assert.equal(report.dbIntegrity, "ok", JSON.stringify(report.integrity));
  assert.equal(report.validRequestsPassed, true);
});

test("mixed profile reports typed writer contention instead of leaking SQLite errors", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 2 });
  closeFixture(fixture);
  const report = await runStressProfile({
    rootPath: fixture.parent,
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    profileName: "mixed",
    options: { rootPath: fixture.parent, durationOverride: 0.2, concurrencyOverride: 4, writerOverride: 2, maxRequestsOverride: 150 },
    argv: ["--execute", "--profile", "mixed"],
  });
  assert.equal(report.rawLockErrorCount, 0);
  assert.equal(report.dbIntegrity, "ok");
  assert.equal(report.infrastructureErrorCount, 0, JSON.stringify(report.errorSamples));
  assert.ok(report.errorSamples.every((sample) => sample.code === "INDEX_WRITER_BUSY"), JSON.stringify(report.errorSamples));
  assert.ok(report.operationIds.some((id) => id.startsWith("writer:")));
});
