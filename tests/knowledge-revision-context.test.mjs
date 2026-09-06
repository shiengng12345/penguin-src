import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitTopologyStore, KnowledgeStore, resolveRevisionContext } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-revision-"));
  return {
    dir,
    store: KnowledgeStore.open({
      dbPath: join(dir, "knowledge.db"),
      ledgerPath: join(dir, "ledger.jsonl"),
    }),
  };
}

function registerRepo(store, name = "repo") {
  const repoId = store.registerRepo({ name, rootPath: join("/tmp", name) });
  return repoId;
}

function readySnapshot(store, { repoId, commitSha, key }) {
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({
    snapshotKey: key,
    repoId,
    commitSha,
    parserVersion: "revision-context-test",
    resolverVersion: "revision-context-test",
    schemaVersion: 17,
  });
  topology.markSnapshotReady(snapshot.id);
  return { topology, snapshot };
}

test("resolves an explicit branch, exact commit, and the sole live branch", () => {
  const { store } = openStore();
  const repoId = registerRepo(store);
  store.registerBranch({ repoId, name: "main", headCommit: "abc123", status: "live" });
  store.registerBranch({ repoId, name: "feature", headCommit: "def456", status: "snapshot" });

  assert.equal(resolveRevisionContext(store, { repoId, branch: "feature" }).status, "resolved");
  assert.equal(resolveRevisionContext(store, { repoId, commitSha: "abc123" }).context.commitSha, "abc123");
  assert.equal(resolveRevisionContext(store, { repoId }).context.branch, "main");
  assert.equal(resolveRevisionContext(store, { repoId, branch: "missing" }).status, "not_found");
  store.close();
});

test("fails closed when multiple live branches make the default ambiguous", () => {
  const { store } = openStore();
  const repoId = registerRepo(store, "multi");
  store.registerBranch({ repoId, name: "main", headCommit: "abc123", status: "live" });
  store.registerBranch({ repoId, name: "worktree/main", headCommit: "def456", status: "live" });

  const result = resolveRevisionContext(store, { repoId });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.branch).sort(),
    ["main", "worktree/main"],
  );
  store.close();
});

test("branch, exact commit, and sole-live resolution promote the ready current snapshot", () => {
  const { store } = openStore();
  const repoId = registerRepo(store, "ready-current");
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "ready-sha", status: "live" });
  const { topology, snapshot } = readySnapshot(store, { repoId, commitSha: "ready-sha", key: "ready-current-main" });
  topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: "ready-sha" });

  for (const selector of [
    { repoId, branch: "main" },
    { repoId, commitSha: "ready-sha" },
    { repoId },
  ]) {
    const result = resolveRevisionContext(store, selector);
    assert.equal(result.status, "resolved", JSON.stringify(result));
    assert.equal(result.context.snapshotId, snapshot.id, JSON.stringify(result));
    assert.equal(result.context.commitSha, "ready-sha", JSON.stringify(result));
  }
  store.close();
});

test("explicit legacy selection and invalid current snapshot pointers stay legacy", () => {
  const { store } = openStore();
  const repoId = registerRepo(store, "legacy-guard");
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "indexed-sha", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("indexed-sha", branchId);

  const localBuilding = new GitTopologyStore(store).createBuildingSnapshot({
    snapshotKey: "not-ready",
    repoId,
    commitSha: "indexed-sha",
    parserVersion: "revision-context-test",
    resolverVersion: "revision-context-test",
    schemaVersion: 17,
  });
  store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run(localBuilding.id, branchId);
  assert.equal(resolveRevisionContext(store, { repoId, branch: "main" }).context.snapshotId, `legacy:${branchId}`);

  store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run("snapshot_missing", branchId);
  assert.equal(resolveRevisionContext(store, { repoId, branch: "main" }).context.snapshotId, `legacy:${branchId}`);

  const foreignRepoId = registerRepo(store, "foreign-ready");
  const { snapshot: foreignSnapshot } = readySnapshot(store, { repoId: foreignRepoId, commitSha: "indexed-sha", key: "foreign-ready" });
  store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run(foreignSnapshot.id, branchId);
  assert.equal(resolveRevisionContext(store, { repoId, branch: "main" }).context.snapshotId, `legacy:${branchId}`);

  const { snapshot: mismatchedSnapshot } = readySnapshot(store, { repoId, commitSha: "different-sha", key: "commit-mismatch" });
  store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run(mismatchedSnapshot.id, branchId);
  assert.equal(resolveRevisionContext(store, { repoId, commitSha: "indexed-sha" }).context.snapshotId, `legacy:${branchId}`);

  const explicitLegacy = resolveRevisionContext(store, { repoId, snapshotId: `legacy:${branchId}` });
  assert.equal(explicitLegacy.status, "resolved");
  assert.equal(explicitLegacy.context.snapshotId, `legacy:${branchId}`);
  store.close();
});

test("CLI files defaults to the only live branch instead of alphabetical order", async () => {
  const { store, dir } = openStore();
  const repoId = registerRepo(store, "cli-repo");
  const oldBranchId = store.registerBranch({ repoId, name: "aaa-old", headCommit: "old", status: "snapshot" });
  const liveBranchId = store.registerBranch({ repoId, name: "main", headCommit: "new", status: "live" });
  const insertFile = store.db.prepare(
    `INSERT INTO files_index (id, repo_id, branch_id, file_path, lang, status)
     VALUES (?, ?, ?, ?, ?, 'indexed')`,
  );
  insertFile.run("file-old", repoId, oldBranchId, "old-only.ts", "typescript");
  insertFile.run("file-main", repoId, liveBranchId, "main-only.ts", "typescript");
  const repoName = store.db.prepare("SELECT name FROM repos WHERE id=?").get(repoId).name;
  store.close();

  const output = [];
  const code = await runCli(["files", repoName, "--json"], {
    cwd: dir,
    out: (line) => output.push(line),
    err: (line) => output.push(`ERR:${line}`),
    openStore: () => KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }),
    storeExists: () => true,
  });

  assert.equal(code, 0);
  const parsed = JSON.parse(output.at(-1));
  assert.deepEqual(parsed.map((file) => file.filePath), ["main-only.ts"]);
});
