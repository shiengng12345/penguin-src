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
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blob_lines WHERE source_blob_id=?").get(unused.blob).n, 0);
  store.close();
});

// Re-indexing a branch names its previous snapshot as base — lineage, from
// resolveBranchBase's "prior_branch_snapshot" path — even though each snapshot
// also materialises its own complete effective file set. Protecting every named
// base made the whole chain immortal: each re-index left one more permanently
// protected snapshot behind, with its own resolution sets and source facts.
// Five rebuilds took a real 6GB database to 25GB with nothing collectable.

function chainedSnapshots(store, repoId, count) {
  const topology = new GitTopologyStore(store);
  const made = [];
  let base;
  for (let i = 0; i < count; i += 1) {
    const snapshot = topology.createBuildingSnapshot({
      snapshotKey: `snap-${i}`, repoId, parserVersion: "p", resolverVersion: `r${i}`,
      schemaVersion: 14, ...(base ? { baseSnapshotId: base } : {}),
    });
    // Each one materialises its own effective set: it does not read through to
    // its base, which is exactly why the base need not be kept.
    const src = putSource(store, repoId, "src/a.ts", `version ${i}`);
    const cow = new SourceSnapshotStore(store);
    cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/a.ts", sourceFactId: src.fact }]);
    cow.materializeManifest(snapshot.id);
    // A real full index materialises its file manifest too; without it the
    // snapshot genuinely reads through to its base and must keep it alive.
    store.db.prepare(
      "INSERT OR IGNORE INTO effective_snapshot_files (snapshot_id, file_path, file_fact_id) VALUES (?,?,?)",
    ).run(snapshot.id, "src/a.ts", `fact-${i}`);
    topology.markSnapshotReady(snapshot.id);
    made.push(snapshot.id);
    base = snapshot.id;
  }
  return made;
}

test("a superseded snapshot of the same revision is collectable, not immortal", () => {
  const store = openStore();
  const repoId = store.registerRepo({ name: "chain", rootPath: "/chain" });
  const made = chainedSnapshots(store, repoId, 6);
  // All six describe the same commit — six re-indexes of one revision.
  store.db.prepare("UPDATE revision_snapshots SET commit_sha='c0' WHERE repo_id=?").run(repoId);
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run(made.at(-1), branchId);

  const plan = planRevisionCollection(store, repoId);
  const kept = new Set(plan.keep.map((k) => k.snapshotId));
  assert.ok(kept.has(made.at(-1)), "the newest snapshot backs the live branch and must be kept");
  assert.equal(
    plan.collect.length,
    5,
    `the five superseded snapshots must be collectable, got keep=${JSON.stringify(plan.keep)}`,
  );
  assert.ok(
    plan.collect.every((c) => c.reason === "superseded_by_newer_snapshot_of_same_revision"),
    `and for that reason, got ${JSON.stringify(plan.collect)}`,
  );
  store.close();
});

test("a base that a dependent actually reads through is still protected", () => {
  // The protection is narrowed, not removed: a snapshot with no effective set
  // of its own must read its base, so the base survives.
  const store = openStore();
  const repoId = store.registerRepo({ name: "overlay", rootPath: "/overlay" });
  const topology = new GitTopologyStore(store);
  const base = topology.createBuildingSnapshot({ snapshotKey: "base", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 14 });
  const src = putSource(store, repoId, "src/a.ts", "base");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(base.id, [{ op: "add", path: "src/a.ts", sourceFactId: src.fact }]);
  cow.materializeManifest(base.id);
  topology.markSnapshotReady(base.id);

  // A dependent with NO effective set of its own.
  const dependent = topology.createBuildingSnapshot({ snapshotKey: "dep", repoId, parserVersion: "p", resolverVersion: "r2", schemaVersion: 14, baseSnapshotId: base.id });
  topology.markSnapshotReady(dependent.id);

  const plan = planRevisionCollection(store, repoId);
  const kept = plan.keep.find((k) => k.snapshotId === base.id);
  assert.ok(kept, `the base must be kept, got ${JSON.stringify(plan)}`);
  assert.ok(kept.reasons.includes("overlay_base"), `and for that reason, got ${JSON.stringify(kept)}`);
  store.close();
});

test("a snapshot still being built keeps its base alive", () => {
  const store = openStore();
  const repoId = store.registerRepo({ name: "building", rootPath: "/building" });
  const topology = new GitTopologyStore(store);
  const base = topology.createBuildingSnapshot({ snapshotKey: "base", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 14 });
  const src = putSource(store, repoId, "src/a.ts", "base");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(base.id, [{ op: "add", path: "src/a.ts", sourceFactId: src.fact }]);
  cow.materializeManifest(base.id);
  topology.markSnapshotReady(base.id);
  // Left in 'building': it is absent from the plan's snapshot list, so without
  // an explicit rule its base would be collected out from under it.
  topology.createBuildingSnapshot({ snapshotKey: "wip", repoId, parserVersion: "p", resolverVersion: "r2", schemaVersion: 14, baseSnapshotId: base.id });

  const kept = planRevisionCollection(store, repoId).keep.find((k) => k.snapshotId === base.id);
  assert.ok(kept?.reasons.includes("overlay_base"), `an in-progress index must not lose its base, got ${JSON.stringify(kept)}`);
  store.close();
});

test("distinct revisions still fill the hot limit", () => {
  // The limit counts revisions now. Six snapshots of six different commits are
  // six distinct views and all stay hot.
  const store = openStore();
  const repoId = store.registerRepo({ name: "distinct", rootPath: "/distinct" });
  const made = chainedSnapshots(store, repoId, 6);
  made.forEach((id, i) => store.db.prepare("UPDATE revision_snapshots SET commit_sha=? WHERE id=?").run(`commit-${i}`, id));
  const plan = planRevisionCollection(store, repoId);
  assert.equal(plan.collect.length, 0, `distinct revisions must not be collected, got ${JSON.stringify(plan.collect)}`);
  assert.equal(plan.keep.length, 6);
  store.close();
});
