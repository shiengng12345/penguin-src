import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { resolveBranchBase } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-branch-base-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "repo", rootPath: join(dir, "repo") });
  const mainId = store.registerBranch({ repoId, name: "main", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature/x", status: "snapshot" });
  return { store, repoId, mainId, featureId };
}

test("master selection is atomic and exposes the selected default branch", () => {
  const { store, repoId, mainId, featureId } = fixture();
  const first = store.setDefaultBranch(repoId, mainId);
  const second = store.setDefaultBranch(repoId, featureId);
  assert.equal(first.branch, "main");
  assert.equal(second.branch, "feature/x");
  assert.equal(store.getDefaultBranch(repoId).id, featureId);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM branches WHERE repo_id=? AND default_branch=1").get(repoId).n, 1);
  store.close();
});

test("SQLite rejects a second default branch even when bypassing the store API", () => {
  const { store, repoId, mainId, featureId } = fixture();
  store.setDefaultBranch(repoId, mainId);
  assert.throws(() => store.db.prepare("UPDATE branches SET default_branch=1 WHERE id=?").run(featureId), /UNIQUE|constraint/i);
  store.close();
});

test("branch base resolver prefers prior, exact merge-base, then canonical fallback", () => {
  const prior = resolveBranchBase({ repoId: "r", targetBranch: "feature/x", canonicalMaster: "main", priorSnapshotId: "prior", priorCommitSha: "p", mergeBaseSha: "m", mergeBaseSnapshotId: "merge", canonicalSnapshotId: "master", canonicalCommitSha: "c", historyState: "complete" });
  assert.equal(prior.baseSnapshotId, "prior");
  assert.equal(prior.reason, "prior_branch_snapshot");
  const merge = resolveBranchBase({ repoId: "r", targetBranch: "feature/x", canonicalMaster: "main", priorSnapshotId: null, priorCommitSha: null, mergeBaseSha: "m", mergeBaseSnapshotId: "merge", canonicalSnapshotId: "master", canonicalCommitSha: "c", historyState: "complete" });
  assert.equal(merge.baseSnapshotId, "merge");
  assert.equal(merge.reason, "git_merge_base");
  const materialize = resolveBranchBase({ repoId: "r", targetBranch: "feature/x", canonicalMaster: "main", priorSnapshotId: null, priorCommitSha: null, mergeBaseSha: "m", mergeBaseSnapshotId: null, canonicalSnapshotId: "master", canonicalCommitSha: "c", historyState: "complete" });
  assert.equal(materialize.materializationRequired, true);
  assert.equal(materialize.baseCommitSha, "m");
  const degraded = resolveBranchBase({ repoId: "r", targetBranch: "feature/x", canonicalMaster: "main", priorSnapshotId: null, priorCommitSha: null, mergeBaseSha: null, mergeBaseSnapshotId: null, canonicalSnapshotId: "master", canonicalCommitSha: "c", historyState: "shallow" });
  assert.equal(degraded.baseSnapshotId, "master");
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.reason, "degraded_history");
});

test("branch names do not change base resolution", () => {
  const input = { repoId: "r", canonicalMaster: "main", priorSnapshotId: null, priorCommitSha: null, mergeBaseSha: "m", mergeBaseSnapshotId: "merge", canonicalSnapshotId: "master", canonicalCommitSha: "c", historyState: "complete" };
  const left = resolveBranchBase({ ...input, targetBranch: "mainline" });
  const right = resolveBranchBase({ ...input, targetBranch: "feature/master" });
  assert.deepEqual({ ...left, targetBranch: null }, { ...right, targetBranch: null });
});
