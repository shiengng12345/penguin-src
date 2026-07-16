import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, GitTopologyStore } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-topology-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "topology", rootPath: join(dir, "repo") });
  const mainId = store.registerBranch({ repoId, name: "main", headCommit: "abc", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature", headCommit: "abc", status: "snapshot" });
  return { store, topology: new GitTopologyStore(store), repoId, mainId, featureId };
}

test("fresh knowledge DB contains immutable topology tables and branch pointers", () => {
  const { store } = fixture();
  for (const table of ["git_commits", "revision_snapshots", "deployment_revisions", "revision_references"]) {
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  const columns = store.db.prepare("PRAGMA table_info(branches)").all().map((row) => row.name);
  for (const column of ["default_branch", "base_branch_name", "merge_base_commit", "current_snapshot_id", "last_accessed_at", "deleted_at", "recover_until"]) {
    assert.ok(columns.includes(column), column);
  }
  store.close();
});

test("two branches can share one ready snapshot and failed publication keeps the old pointer", () => {
  const { store, topology, repoId, mainId, featureId } = fixture();
  const snapshot = topology.createBuildingSnapshot({
    snapshotKey: "same-clean-commit",
    repoId,
    commitSha: "abc",
    parserVersion: "parser-1",
    resolverVersion: "resolver-1",
    schemaVersion: 7,
  });
  assert.throws(() => topology.publishSnapshot({ branchId: mainId, snapshotId: snapshot.id, headCommit: "abc" }), /ready/);
  topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId: mainId, snapshotId: snapshot.id, headCommit: "abc" });
  topology.pointBranchAtSnapshot(featureId, snapshot.id);
  assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(mainId).current_snapshot_id, snapshot.id);
  assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(featureId).current_snapshot_id, snapshot.id);
  store.close();
});
