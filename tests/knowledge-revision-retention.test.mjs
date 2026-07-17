import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  GitTopologyStore,
  SourceSnapshotStore,
  SourceStore,
  applyRevisionCollection,
  planRevisionCollection,
} from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-revision-retention-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

function putSource(store, repoId, filePath, text) {
  const raw = Buffer.from(text, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store);
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: text, encoding: "utf8" });
  const fact = source.putSourceFact({ repoId, filePath, factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  return { blob, fact };
}

test("revision collection removes snapshot mappings and only collects unreferenced old source facts/blobs", () => {
  const store = openStore();
  const repoId = store.registerRepo({ name: "retention", rootPath: "/retention" });
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({ snapshotKey: "old", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
  const active = putSource(store, repoId, "src/active.ts", "active");
  const unused = putSource(store, repoId, "src/unused.ts", "unused");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/active.ts", sourceFactId: active.fact }]);
  cow.materializeManifest(snapshot.id);
  topology.markSnapshotReady(snapshot.id);
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  store.db.prepare("UPDATE revision_snapshots SET created_at=?,last_accessed_at=? WHERE id=?").run(old, old, snapshot.id);
  store.db.prepare("UPDATE source_facts SET created_at=? WHERE id IN (?,?)").run(old, active.fact, unused.fact);
  store.db.prepare("UPDATE source_blobs SET created_at=? WHERE id IN (?,?)").run(old, active.blob, unused.blob);

  const plan = planRevisionCollection(store, repoId, { maxHotFeatureViews: 0, coldAfterDays: 0, deletedBranchRecoveryDays: 0, factGcGraceDays: 0 });
  assert.ok(plan.collect.some((item) => item.snapshotId === snapshot.id));
  assert.ok(plan.sourceFactsToCollect.includes(unused.fact));
  assert.ok(plan.sourceBlobsToCollect.includes(unused.blob));
  const result = applyRevisionCollection(store, plan);
  assert.deepEqual(result.collectedSnapshotIds, [snapshot.id]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_sources WHERE snapshot_id=?").get(snapshot.id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_snapshot_overlays WHERE snapshot_id=?").get(snapshot.id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_facts WHERE id=?").get(unused.fact).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs WHERE id=?").get(unused.blob).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_facts WHERE id=?").get(active.fact).n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs WHERE id=?").get(active.blob).n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_fts WHERE rowid=?").get(unused.blob).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_lexical_fts WHERE rowid=?").get(unused.blob).n, 0);
  store.close();
});
