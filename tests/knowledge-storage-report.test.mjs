import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  EmbeddingLifecycle,
  buildStorageReport,
  createEmbeddingSpace,
  evaluateStorageHealth,
  runStorageMaintenance,
  recordStorageSample,
  maintenanceState,
  planRevisionCollection,
  applyRevisionCollection,
} from "../packages/knowledge-core/dist/index.js";

// Storage visibility: the report must never throw, GC runs must leave a
// persisted trace, and the health rules are ratio-based (the 25GB incident
// was a 16GB WAL against a ~5GB DB — absolute thresholds catch that too
// late).

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-storage-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test("buildStorageReport returns file sizes, samples once per day, and never throws on empty DB", () => {
  const store = openStore();
  const first = buildStorageReport(store);
  assert.ok(first.files.dbBytes > 0, "db file has real bytes");
  assert.equal(first.files.totalBytes, (first.files.dbBytes ?? 0) + (first.files.walBytes ?? 0) + (first.files.shmBytes ?? 0));
  assert.equal(first.health.level, "ok");
  assert.equal(first.gc.lastRun, null);
  assert.equal(first.gc.hotFeatureLimit, 20);
  assert.equal(first.maintenance.running, false);
  assert.deepEqual(first.repos, []);
  assert.equal(first.semantic.ready, false);
  assert.equal(first.semantic.activeGenerations, 0);
  assert.equal(first.semantic.reason, "NO_ACTIVE_SPACE");

  // Same-day resample updates in place — exactly one row per calendar day.
  buildStorageReport(store);
  const sampleRows = store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_size_samples").get();
  assert.equal(sampleRows.n, 1);
  const report = buildStorageReport(store);
  assert.equal(report.growth.samples.length, 1);
  store.close();
});

test("semantic storage report exposes an incomplete staging generation", () => {
  const store = openStore();
  const space = createEmbeddingSpace(store, {
    providerId: "fixture",
    modelId: "fixture-v1",
    weightsDigest: "a".repeat(64),
    tokenizerDigest: "b".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "l2",
    chunkerVersion: "semantic-chunker-v1",
  });
  new EmbeddingLifecycle(store).createGeneration({
    spaceId: space.id,
    snapshotId: "snapshot-1",
    scopeKey: "repo:fixture",
    expectedChunks: 1,
  });
  const semantic = buildStorageReport(store).semantic;
  assert.equal(semantic.ready, false);
  assert.equal(semantic.stagingGenerations, 1);
  assert.equal(semantic.expectedChunks, 1);
  assert.equal(semantic.readyRefs, 0);
  assert.equal(semantic.reason, "EMBEDDING_GENERATION_INCOMPLETE");
  store.close();
});

test("dbstat table categories are present and human-mappable", () => {
  const store = openStore();
  const report = buildStorageReport(store, { computeTables: true });
  assert.ok(report.tables, "dbstat available in bundled better-sqlite3");
  const keys = new Set(report.tables.categories.map((category) => category.key));
  for (const key of keys) {
    assert.ok(["graph_edges", "source_content", "fts", "vectors", "symbols", "other"].includes(key), `unknown category ${key}`);
  }
  assert.ok(report.tables.categories.every((category) => category.bytes > 0));
  assert.equal(typeof report.semantic.modelDiskBytes, "number", "semantic/vector bytes are reported separately after analyze");
  store.close();
});

test("weekly delta compares against the newest sample at least 7 days old", () => {
  const store = openStore();
  const current = buildStorageReport(store).files.totalBytes;
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  store.db
    .prepare("INSERT INTO knowledge_size_samples(sample_date,total_bytes,wal_bytes,recorded_at) VALUES (?,?,?,?)")
    .run(eightDaysAgo, current - 123 * MB, 0, new Date().toISOString());
  const report = buildStorageReport(store);
  // The report re-stats the files; sizes may drift by a page between calls.
  assert.ok(Math.abs(report.growth.weeklyDeltaBytes - 123 * MB) < MB, `delta ${report.growth.weeklyDeltaBytes}`);
  store.close();
});

test("health: WAL ratio drives warn/critical, small WAL never warns", () => {
  const sizes = (dbBytes, walBytes) => ({ dbBytes, walBytes, shmBytes: 0, totalBytes: dbBytes + walBytes });
  // Below the 256MB floor: even a 50% ratio stays ok (tiny DBs are noisy).
  assert.equal(evaluateStorageHealth(sizes(100 * MB, 50 * MB), null).level, "ok");
  // The actual incident shape: 16GB WAL on a 5GB DB → critical on day one.
  const incident = evaluateStorageHealth(sizes(5 * GB, 16 * GB), null);
  assert.equal(incident.level, "critical");
  assert.deepEqual(incident.reasons, ["wal_ratio"]);
  // 6% ratio above the floor → warn.
  assert.equal(evaluateStorageHealth(sizes(5 * GB, Math.round(0.06 * 5 * GB)), null).level, "warn");
  // 1.6% ratio (today's real shape) → ok.
  assert.equal(evaluateStorageHealth(sizes(5 * GB, 82 * MB), null).level, "ok");
});

test("health: weekly growth thresholds and worst-of combination", () => {
  const okFiles = { dbBytes: 5 * GB, walBytes: 10 * MB, shmBytes: 0, totalBytes: 5 * GB + 10 * MB };
  assert.equal(evaluateStorageHealth(okFiles, 100 * MB).level, "ok");
  assert.equal(evaluateStorageHealth(okFiles, 600 * MB).level, "warn");
  assert.equal(evaluateStorageHealth(okFiles, 3 * GB).level, "critical");
  // Shrinking DB never warns.
  assert.equal(evaluateStorageHealth(okFiles, -2 * GB).level, "ok");
  // warn (growth) + critical (wal) → critical, both reasons reported.
  const both = evaluateStorageHealth({ dbBytes: 5 * GB, walBytes: 16 * GB, shmBytes: 0, totalBytes: 21 * GB }, 600 * MB);
  assert.equal(both.level, "critical");
  assert.deepEqual([...both.reasons].sort(), ["growth_rate", "wal_ratio"]);
});

test("applyRevisionCollection persists a GC run with its trigger", () => {
  const store = openStore();
  const plan = planRevisionCollection(store, "repo-x");
  assert.equal(plan.repoId, "repo-x");
  applyRevisionCollection(store, plan, { trigger: "auto" });
  applyRevisionCollection(store, planRevisionCollection(store, "repo-x"));
  const rows = store.db
    .prepare("SELECT repo_id, trigger_kind, error FROM knowledge_gc_runs ORDER BY id")
    .all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.trigger_kind), ["auto", "manual"]);
  assert.equal(rows[0].repo_id, "repo-x");
  assert.equal(rows[0].error, null);
  const report = buildStorageReport(store);
  assert.equal(report.gc.lastRun.triggerKind, "manual");
  store.close();
});

test("maintenance collect: runs GC across repos, persists result, releases lock", () => {
  const store = openStore();
  const result = runStorageMaintenance(store, "collect");
  assert.equal(result.action, "collect");
  assert.equal(result.error, null);
  assert.deepEqual(result.collected, { snapshots: 0, resolutionSets: 0, sourceBlobs: 0, facts: 0 });
  assert.equal(maintenanceState(store).running, false);
  const report = buildStorageReport(store);
  assert.equal(report.maintenance.lastResult.action, "collect");
  store.close();
});

test("maintenance vacuum: checkpoints, vacuums, reports reclaimed bytes", () => {
  const store = openStore();
  // Leave some garbage for VACUUM: write and delete a chunky meta value.
  store.db.prepare("INSERT INTO meta(key,value) VALUES ('bloat', ?)").run("x".repeat(4 * MB));
  store.db.prepare("DELETE FROM meta WHERE key='bloat'").run();
  const result = runStorageMaintenance(store, "vacuum");
  assert.equal(result.action, "vacuum");
  assert.equal(result.error, null);
  assert.ok(result.reclaimedBytes >= 0);
  assert.equal(maintenanceState(store).running, false);
  store.close();
});

test("maintenance refuses invalid actions and concurrent work", () => {
  const store = openStore();
  assert.throws(() => runStorageMaintenance(store, "drop-everything"), /MAINTENANCE_ACTION_INVALID/);

  // A live index marker (same pid, fresh timestamp) blocks maintenance.
  store.db
    .prepare("INSERT INTO meta(key,value) VALUES ('index_lock::b1', ?)")
    .run(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.throws(() => runStorageMaintenance(store, "collect"), /INDEX_IN_PROGRESS/);
  store.db.prepare("DELETE FROM meta WHERE key='index_lock::b1'").run();

  // A live maintenance lock blocks a second run and reads back as running.
  store.db
    .prepare("INSERT INTO meta(key,value) VALUES ('knowledge_maintenance_lock', ?)")
    .run(JSON.stringify({ pid: process.pid, action: "vacuum", startedAt: new Date().toISOString() }));
  assert.equal(maintenanceState(store).running, true);
  assert.equal(maintenanceState(store).action, "vacuum");
  assert.throws(() => runStorageMaintenance(store, "collect"), /MAINTENANCE_IN_PROGRESS/);

  // A dead-pid lock is stale — state clears and maintenance proceeds.
  store.db
    .prepare("UPDATE meta SET value=? WHERE key='knowledge_maintenance_lock'")
    .run(JSON.stringify({ pid: 999999999, action: "vacuum", startedAt: new Date().toISOString() }));
  assert.equal(maintenanceState(store).running, false);
  assert.equal(runStorageMaintenance(store, "collect").error, null);
  store.close();
});

test("status panel carries cheap size fields", async () => {
  const { buildStatusPanel } = await import("../packages/knowledge-core/dist/index.js");
  const store = openStore();
  const panel = buildStatusPanel(store);
  assert.ok(panel.db.sizeBytes > 0);
  assert.notEqual(panel.db.walBytes, undefined);
  store.close();
});

test("reclaimable free pages are reported and flagged once they are worth a vacuum", () => {
  const store = openStore();
  const sizes = buildStorageReport(store).files;
  assert.equal(typeof sizes.reclaimableBytes, "number", "freelist is measurable");

  const quiet = evaluateStorageHealth(
    { dbBytes: 5 * GB, walBytes: 1 * MB, shmBytes: 0, totalBytes: 5 * GB, reclaimableBytes: 8 * MB },
    null,
  );
  assert.equal(quiet.level, "ok");
  // The FTS retirement freed 776MB into the freelist — exactly this case.
  const loaded = evaluateStorageHealth(
    { dbBytes: 7 * GB, walBytes: 1 * MB, shmBytes: 0, totalBytes: 7 * GB, reclaimableBytes: 776 * MB },
    null,
  );
  assert.equal(loaded.level, "warn");
  assert.ok(loaded.reasons.includes("reclaimable"));
  store.close();
});

test("recordStorageSample writes history without building a full report", () => {
  const store = openStore();
  recordStorageSample(store);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_size_samples").get().n, 1);
  recordStorageSample(store);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_size_samples").get().n, 1, "one row per day");
  store.close();
});

test("maintenance claim is atomic: a live lock is respected and never clobbered", () => {
  const store = openStore();
  store.db
    .prepare("INSERT INTO meta(key,value) VALUES ('knowledge_maintenance_lock', ?)")
    .run(JSON.stringify({ pid: process.pid, action: "collect", startedAt: new Date().toISOString() }));
  assert.throws(() => runStorageMaintenance(store, "vacuum"), /MAINTENANCE_IN_PROGRESS/);
  const lock = JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key='knowledge_maintenance_lock'").get().value);
  assert.equal(lock.action, "collect", "loser must not overwrite the winner's claim");
  store.close();
});
