import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, GitTopologyStore, FileFactStore, fileFactId } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-file-facts-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "facts", rootPath: join(dir, "repo") });
  const topology = new GitTopologyStore(store);
  const base = topology.createBuildingSnapshot({ snapshotKey: "base", repoId, commitSha: "base", parserVersion: "p1", resolverVersion: "r1", schemaVersion: 9 });
  const feature = topology.createBuildingSnapshot({ snapshotKey: "feature", repoId, commitSha: "feature", parserVersion: "p1", resolverVersion: "r1", schemaVersion: 9, baseSnapshotId: base.id, mergeBaseSha: "base" });
  return { store, facts: new FileFactStore(store), base, feature };
}

function fact(repoId, filePath, contentHash, title = filePath) {
  return { repoId, filePath, contentHash, language: "typescript", parserVersion: "p1", exportsHash: `exports-${contentHash}`, symbols: [{ identityKey: `${repoId}:${filePath}:${title}`, title, kind: "function", contentHash }], imports: [], unresolvedReferences: [], endpoints: [], logSites: [] };
}

test("file facts are content-addressed but path-sensitive", () => {
  const { store, facts } = fixture();
  const repoId = store.db.prepare("SELECT repo_id FROM revision_snapshots LIMIT 1").get().repo_id;
  const left = facts.upsertFileFact(fact(repoId, "a.ts", "same"));
  assert.equal(facts.upsertFileFact(fact(repoId, "a.ts", "same")), left);
  const right = facts.upsertFileFact(fact(repoId, "b.ts", "same"));
  assert.notEqual(left, right);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM file_facts").get().n, 2);
  assert.equal(left, fileFactId(fact(repoId, "a.ts", "same")));
  store.close();
});

test("effective manifest applies base plus add/modify/delete without following moving main", () => {
  const { store, facts, base, feature } = fixture();
  const repoId = store.db.prepare("SELECT repo_id FROM revision_snapshots LIMIT 1").get().repo_id;
  const kept = facts.upsertFileFact(fact(repoId, "kept.ts", "old"));
  const deleted = facts.upsertFileFact(fact(repoId, "deleted.ts", "old"));
  const modified = facts.upsertFileFact(fact(repoId, "modified.ts", "old"));
  facts.upsertFileFact(fact(repoId, "modified.ts", "new"));
  const added = facts.upsertFileFact(fact(repoId, "added.ts", "new"));
  facts.replaceOverlay(base.id, [{ op: "add", path: "kept.ts", fileFactId: kept }, { op: "add", path: "deleted.ts", fileFactId: deleted }, { op: "add", path: "modified.ts", fileFactId: modified }]);
  facts.replaceOverlay(feature.id, [{ op: "modify", path: "modified.ts", fileFactId: facts.upsertFileFact(fact(repoId, "modified.ts", "feature")) }, { op: "add", path: "added.ts", fileFactId: added }, { op: "delete", path: "deleted.ts", fileFactId: null }]);
  assert.deepEqual([...facts.effectiveManifest(feature.id).keys()].sort(), ["added.ts", "kept.ts", "modified.ts"]);
  const before = facts.effectiveManifest(feature.id).get("kept.ts");
  const topology = new GitTopologyStore(store);
  const advanced = topology.createBuildingSnapshot({ snapshotKey: "main-advanced", repoId, commitSha: "main-advanced", parserVersion: "p1", resolverVersion: "r1", schemaVersion: 9 });
  facts.replaceOverlay(advanced.id, [{ op: "add", path: "kept.ts", fileFactId: facts.upsertFileFact(fact(repoId, "kept.ts", "advanced-main")) }]);
  assert.equal(facts.effectiveManifest(feature.id).get("kept.ts"), before);
  facts.materializeManifest(feature.id);
  store.db.prepare("DELETE FROM effective_snapshot_files WHERE snapshot_id=?").run(feature.id);
  assert.equal(facts.materializeManifest(feature.id), 3);
  store.close();
});

test("manifest validation rejects a publish target that differs from its effective COW view", () => {
  const { store, facts, base } = fixture();
  const repoId = store.db.prepare("SELECT repo_id FROM revision_snapshots LIMIT 1").get().repo_id;
  const id = facts.upsertFileFact(fact(repoId, "actual.ts", "actual"));
  facts.replaceOverlay(base.id, [{ op: "add", path: "actual.ts", fileFactId: id }]);
  facts.materializeManifest(base.id);
  assert.doesNotThrow(() => facts.assertManifestMatches(base.id, new Map([["actual.ts", id]])));
  assert.throws(() => facts.assertManifestMatches(base.id, new Map([["wrong.ts", id]])), /manifest mismatch/i);
  store.close();
});

test("rename is represented as delete plus add and durable event", () => {
  const { store, facts, base } = fixture();
  const repoId = store.db.prepare("SELECT repo_id FROM revision_snapshots LIMIT 1").get().repo_id;
  const renamed = facts.upsertFileFact(fact(repoId, "new.ts", "same"));
  facts.replaceOverlay(base.id, [{ op: "delete", path: "old.ts", fileFactId: null }, { op: "add", path: "new.ts", fileFactId: renamed, renamedFrom: "old.ts" }]);
  facts.replaceRenameEvents(base.id, [{ snapshotId: base.id, fromPath: "old.ts", toPath: "new.ts", fileFactId: renamed, contentHash: "same" }]);
  assert.equal(facts.effectiveManifest(base.id).has("old.ts"), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM snapshot_rename_events WHERE snapshot_id=?").get(base.id).n, 1);
  store.close();
});
