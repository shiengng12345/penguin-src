import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-reg-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

test("registerRepo is idempotent on root_path and updates name", () => {
  const store = openTemp();
  const id1 = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const id2 = store.registerRepo({ name: "fpms-renamed", rootPath: "/work/fpms" });
  assert.equal(id1, id2);
  const repo = store.getRepoByRoot("/work/fpms");
  assert.equal(repo.id, id1);
  assert.equal(repo.name, "fpms-renamed");
  assert.equal(repo.remote_url, null);
  assert.equal(store.getRepoByRoot("/work/nope"), null);
  store.close();
});

test("registerBranch is idempotent on (repo_id, name) and updates status/head", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const b1 = store.registerBranch({ repoId, name: "main", headCommit: "abc", status: "live" });
  const b2 = store.registerBranch({ repoId, name: "main", headCommit: "def", status: "snapshot" });
  assert.equal(b1, b2);
  const branch = store.getBranch(repoId, "main");
  assert.equal(branch.head_commit, "def");
  assert.equal(branch.status, "snapshot");
  const feat = store.registerBranch({ repoId, name: "feature/x", status: "live" });
  assert.notEqual(feat, b1);
  store.close();
});

test("setBranchStatus and recordBranchIndexed mutate the branch row", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });

  store.setBranchStatus(branchId, "gone");
  assert.equal(store.getBranch(repoId, "main").status, "gone");

  store.recordBranchIndexed({ branchId, commit: "abc123" });
  const after = store.getBranch(repoId, "main");
  assert.equal(after.last_indexed_commit, "abc123");
  assert.ok(after.last_indexed_at, "last_indexed_at should be set");
  store.close();
});
