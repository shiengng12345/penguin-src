import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  createFullResetPlan,
  readResetManifest,
  recoverFullReset,
} from "../packages/knowledge-core/dist/index.js";
import { closeFixture, createIndexedC6Fixture } from "./helpers/knowledge-c6-fixture.mjs";

test("reset recovery refuses live or mismatched owners and reaps only a confirmed dead fence", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 2 });
  try {
    const backupPath = join(fixture.databaseDirectory, "reset-backup.db");
    const manifestPath = join(fixture.databaseDirectory, "reset-manifest.json");
    const { plan } = await createFullResetPlan({ db: fixture.store.db }, {
      rootPath: fixture.roots[0],
      databasePath: fixture.dbPath,
      backupPath,
      manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    const fencePath = `${fixture.dbPath}.full-reset.lock`;
    const writeFence = (operationId, pid) => writeFileSync(fencePath, `${JSON.stringify({
      formatVersion: 1,
      operationId,
      pid,
    })}\n`, { mode: 0o600 });

    writeFence(plan.operationId, process.pid);
    assert.throws(
      () => recoverFullReset(fixture.store, { databasePath: fixture.dbPath, manifestPath, confirmed: true }),
      /RESET_RECOVERY_FENCE_OWNER_ALIVE/,
    );

    writeFence("reset_unrelated", 2_147_483_647);
    assert.throws(
      () => recoverFullReset(fixture.store, { databasePath: fixture.dbPath, manifestPath, confirmed: true }),
      /RESET_RECOVERY_FENCE_MISMATCH/,
    );

    writeFence(plan.operationId, 2_147_483_647);
    fixture.store.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('index_lock::global',?)").run(JSON.stringify({
      pid: 2_147_483_647,
      startedAt: "2026-09-02T00:00:00.000Z",
      kind: "full_corpus_reset",
      operationId: plan.operationId,
    }));
    assert.throws(
      () => recoverFullReset(fixture.store, { databasePath: fixture.dbPath, manifestPath, confirmed: false }),
      /RESET_RECOVERY_CONFIRMATION_REQUIRED/,
    );
    assert.equal(existsSync(fencePath), true);

    const receipt = recoverFullReset(fixture.store, {
      databasePath: fixture.dbPath,
      manifestPath,
      confirmed: true,
    });
    assert.equal(receipt.recovered, true);
    assert.equal(receipt.databaseIntegrity, "not_checked");
    assert.equal(receipt.rollbackAvailable, true);
    assert.equal(existsSync(fencePath), false);
    assert.equal(
      fixture.store.db.prepare("SELECT value FROM meta WHERE key='index_lock::global'").get(),
      undefined,
    );
    assert.equal(readResetManifest(manifestPath).phase, "failed");

    fixture.store.db.prepare("INSERT INTO meta(key,value) VALUES ('index_lock::global',?)").run(JSON.stringify({
      pid: 2_147_483_647,
      startedAt: "2026-09-02T00:00:00.000Z",
      kind: "full_corpus_reset",
      operationId: plan.operationId,
    }));
    const markerOnlyReceipt = recoverFullReset(fixture.store, {
      databasePath: fixture.dbPath,
      manifestPath,
      confirmed: true,
    });
    assert.equal(markerOnlyReceipt.recovered, true);
    assert.equal(
      fixture.store.db.prepare("SELECT value FROM meta WHERE key='index_lock::global'").get(),
      undefined,
    );
  } finally {
    closeFixture(fixture);
  }
});
