import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  KnowledgeStore,
  createFullResetPlan,
  readResetManifest,
  recoverFullReset,
  rollbackFullReset,
} from "../packages/knowledge-core/dist/index.js";
import { assertDatabaseIntegrity, databaseFileSizes } from "../scripts/knowledge-load-report.mjs";
import { closeFixture, createIndexedC6Fixture } from "./helpers/knowledge-c6-fixture.mjs";

function killedTransaction({ dbPath, ledgerPath }) {
  const coreUrl = pathToFileURL(resolve("packages/knowledge-core/dist/index.js")).href;
  const source = `
    import { KnowledgeStore } from ${JSON.stringify(coreUrl)};
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(dbPath)}, ledgerPath: ${JSON.stringify(ledgerPath)} });
    store.db.transaction(() => {
      store.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("wal_uncommitted", "must_rollback");
      process.kill(process.pid, "SIGKILL");
    }).immediate();
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("SQLite rolls back an uncommitted WAL transaction after SIGKILL", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-wal-recovery-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const initial = KnowledgeStore.open({ dbPath, ledgerPath });
  initial.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("wal_committed", "must_survive");
  assert.equal(initial.db.pragma("journal_mode", { simple: true }), "wal");
  initial.close();

  const killed = killedTransaction({ dbPath, ledgerPath });
  assert.equal(killed.signal, "SIGKILL", `${killed.stdout}\n${killed.stderr}`);

  const recovered = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
  try {
    assert.deepEqual(assertDatabaseIntegrity(recovered), {
      quickCheck: "ok",
      integrityCheck: "ok",
      ok: true,
    });
    assert.equal(recovered.db.prepare("SELECT value FROM meta WHERE key=?").get("wal_committed")?.value, "must_survive");
    assert.equal(recovered.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key=?").get("wal_uncommitted").count, 0);
    const checkpoint = recovered.db.pragma("wal_checkpoint(TRUNCATE)")?.[0];
    assert.equal(Number(checkpoint?.busy ?? 0), 0);
  } finally {
    recovered.close();
  }
  assert.ok(databaseFileSizes(dbPath).walBytes <= 64 * 1024 * 1024);
});

function resetCrashChild({ fixture, plan, checkpoint }) {
  const coreUrl = pathToFileURL(resolve("packages/knowledge-core/dist/index.js")).href;
  const source = `
    import { KnowledgeStore, executeFullReset } from ${JSON.stringify(coreUrl)};
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(fixture.dbPath)}, ledgerPath: ${JSON.stringify(fixture.ledgerPath)} });
    const kill = () => process.kill(process.pid, "SIGKILL");
    executeFullReset(store, ${JSON.stringify(plan)}, {
      databasePath: ${JSON.stringify(fixture.dbPath)},
      token: ${JSON.stringify(plan.confirmationToken)},
      manifestPath: ${JSON.stringify(plan.manifestPath)},
      testHooks: {
        afterFence: () => { if (${JSON.stringify(checkpoint)} === "after_fence") kill(); },
        afterDelete: ({ changes }) => { if (${JSON.stringify(checkpoint)} === "during_reset" && changes > 0) kill(); },
        afterReset: () => { if (${JSON.stringify(checkpoint)} === "after_reset") kill(); },
      },
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("a SIGKILL during reset is fenced, diagnosed, and restorable from backup", async () => {
  for (const checkpoint of ["after_fence", "during_reset", "after_reset"]) {
    const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 4 });
    closeFixture(fixture);
    const backupPath = join(fixture.databaseDirectory, "reset-backup.db");
    const manifestPath = join(fixture.databaseDirectory, "reset-manifest.json");
    const planner = KnowledgeStore.open({ dbPath: fixture.dbPath, ledgerPath: fixture.ledgerPath });
    const planned = await createFullResetPlan({ db: planner.db }, {
      rootPath: fixture.roots[0],
      databasePath: fixture.dbPath,
      backupPath,
      manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    planner.close();

    const killed = resetCrashChild({ fixture, plan: planned.plan, checkpoint });
    assert.equal(killed.signal, "SIGKILL", `${checkpoint}: ${killed.stdout}\n${killed.stderr}`);
    assert.equal(existsSync(`${fixture.dbPath}.full-reset.lock`), true, `${checkpoint}: crash must leave a recoverable fence`);

    const store = KnowledgeStore.open({ dbPath: fixture.dbPath, ledgerPath: fixture.ledgerPath, allowSchemaMutation: false });
    try {
      const recovered = recoverFullReset(store, { databasePath: fixture.dbPath, manifestPath, confirmed: true });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.databaseIntegrity, "not_checked");
      assert.equal(recovered.rollbackAvailable, true);
      assert.equal(existsSync(`${fixture.dbPath}.full-reset.lock`), false);
      assert.equal(readResetManifest(manifestPath).phase, "failed");

      const destination = join(fixture.databaseDirectory, `rollback-${checkpoint}.db`);
      const rollback = rollbackFullReset(store, backupPath, destination, { confirmed: true });
      assert.equal(rollback.integrity, "ok");
      const restored = KnowledgeStore.open({
        dbPath: destination,
        ledgerPath: join(fixture.databaseDirectory, `rollback-${checkpoint}.ledger.jsonl`),
        allowSchemaMutation: false,
      });
      try {
        assert.ok(Number(restored.db.prepare("SELECT COUNT(*) AS count FROM files_index").get().count) > 0);
        assert.deepEqual(assertDatabaseIntegrity(restored), {
          quickCheck: "ok",
          integrityCheck: "ok",
          ok: true,
        });
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  }
});
