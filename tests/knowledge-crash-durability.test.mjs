import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { test } from "node:test";

import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runFaultInjection } from "../scripts/knowledge-fault-injection.mjs";
import { closeFixture, createIndexedC6Fixture } from "./helpers/knowledge-c6-fixture.mjs";

test("all indexer crash checkpoints recover without publishing a broken snapshot", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 4 });
  closeFixture(fixture);

  const report = await runFaultInjection({
    argv: ["--execute", "--checkpoint=all"],
    execute: true,
    json: false,
    rootPath: fixture.roots[0],
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    reportPath: undefined,
    checkpoints: ["scan", "parse", "publish", "maintenance"],
    timeoutMs: 30_000,
  });

  assert.equal(report.valid, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.results.map((result) => result.checkpoint), [
    "scan",
    "parse",
    "publish",
    "maintenance",
  ]);
  assert.ok(report.results.every((result) => result.childSignal === "SIGKILL"));
  assert.ok(report.results.every((result) => result.integrityBeforeRecovery?.ok === true));
  assert.ok(report.results.every((result) => result.integrityAfterRecovery?.ok === true));
  assert.ok(report.results.every((result) => result.orphanWriterMarkersAfterRecovery === 0));

  const store = KnowledgeStore.open({
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    allowSchemaMutation: false,
  });
  try {
    const branchState = store.db.prepare(`
      SELECT s.state
       FROM branches b
        JOIN revision_snapshots s ON s.id=b.current_snapshot_id
       WHERE b.checkout_path=?
       LIMIT 1
    `).get(realpathSync.native(fixture.roots[0]));
    assert.equal(branchState?.state, "ready");
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'index_lock::%'").get().count), 0);
  } finally {
    store.close();
  }
});
