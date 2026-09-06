import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendResetManifestPhase,
  consumeResetPlan,
  createFullResetPlan,
  readResetManifest,
} from "../packages/knowledge-core/dist/index.js";
import { closeFixture, createIndexedC6Fixture } from "./helpers/knowledge-c6-fixture.mjs";

test("reset manifest is immutable, plan-bound, single-use, and tamper evident", async () => {
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

    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    assert.equal(existsSync(plan.baselinePath), true);
    assert.equal(existsSync(plan.protectedAssetPath), true);
    assert.equal(statSync(plan.baselinePath).mode & 0o777, 0o600);
    assert.equal(statSync(plan.protectedAssetPath).mode & 0o777, 0o600);
    assert.equal(readResetManifest(manifestPath).phase, "backed_up");
    appendResetManifestPhase(manifestPath, "fenced", { fixture: true });
    assert.equal(readResetManifest(manifestPath).phase, "fenced");

    assert.throws(() => consumeResetPlan(manifestPath, "reset_wrong"), /RESET_CONFIRMATION_TOKEN_MISMATCH/);
    assert.equal(readResetManifest(manifestPath).tokenConsumed, false);
    consumeResetPlan(manifestPath, plan.confirmationToken);
    assert.equal(readResetManifest(manifestPath).tokenConsumed, true);
    assert.throws(() => consumeResetPlan(manifestPath, plan.confirmationToken), /RESET_PLAN_ALREADY_CONSUMED/);

    const tampered = JSON.parse(readFileSync(manifestPath, "utf8"));
    tampered.plan.rootPath = `${tampered.plan.rootPath}-tampered`;
    writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => readResetManifest(manifestPath), /RESET_PLAN_DIGEST_INVALID/);
  } finally {
    closeFixture(fixture);
  }
});
