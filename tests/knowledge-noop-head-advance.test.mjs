import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  KnowledgeStore,
  ScopeResolutionError,
  openRevisionView,
  resolveQueryScope,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin A1 Test",
  GIT_AUTHOR_EMAIL: "penguin-a1@example.invalid",
  GIT_COMMITTER_NAME: "Penguin A1 Test",
  GIT_COMMITTER_EMAIL: "penguin-a1@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-noop-head-advance-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "stable.ts"),
    "export function stable(): number { return 1; }\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "commit A");
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  return { dir, repo, store };
}

function branchTruth(store, repoId) {
  return store.db.prepare(`
    SELECT id, head_commit AS headCommit,
           last_indexed_commit AS lastIndexedCommit,
           last_indexed_at AS lastIndexedAt,
           current_snapshot_id AS snapshotId
      FROM branches
     WHERE repo_id=? AND name='main'
  `).get(repoId);
}

function revisionGeneration(store) {
  const row = store.db.prepare("SELECT value FROM meta WHERE key='revision_generation'").get();
  return row ? Number(row.value) : null;
}

test("identical-tree commit B publishes a new ready snapshot even when incremental parsing is a no-op", async () => {
  const value = fixture();
  try {
    const commitA = git(value.repo, "rev-parse", "HEAD");
    const treeA = git(value.repo, "rev-parse", "HEAD^{tree}");
    const first = await indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" });
    const atA = branchTruth(value.store, first.repoId);

    assert.equal(atA.headCommit, commitA);
    assert.equal(atA.lastIndexedCommit, commitA);
    assert.ok(atA.snapshotId);
    assert.equal(revisionGeneration(value.store), 1);
    assert.equal(first.revisionTruth.revisionGeneration, 1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    git(value.repo, "commit", "--allow-empty", "-q", "-m", "commit B with identical tree");
    const commitB = git(value.repo, "rev-parse", "HEAD");
    const treeB = git(value.repo, "rev-parse", "HEAD^{tree}");
    assert.notEqual(commitB, commitA);
    assert.equal(treeB, treeA, "the tracked tree must be byte-identical across A and B");

    const second = await indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" });
    const atB = branchTruth(value.store, first.repoId);
    const snapshotB = value.store.db.prepare(
      "SELECT commit_sha AS commitSha, state FROM revision_snapshots WHERE id=?",
    ).get(atB.snapshotId);

    assert.equal(second.parsed, 0);
    assert.equal(second.skipped, 1);
    assert.notEqual(atB.snapshotId, atA.snapshotId);
    assert.equal(snapshotB.commitSha, commitB);
    assert.equal(snapshotB.state, "ready");
    assert.equal(atB.headCommit, commitB);
    assert.equal(atB.lastIndexedCommit, commitB);
    assert.ok(atB.lastIndexedAt > atA.lastIndexedAt, "last_indexed_at must advance on a no-op parse");
    assert.equal(revisionGeneration(value.store), 2);
    assert.deepEqual(second.revisionTruth, {
      repoId: first.repoId,
      branchId: first.branchId,
      snapshotId: atB.snapshotId,
      indexedCommit: commitB,
      currentHead: commitB,
      worktreeDirty: false,
      alignment: "aligned",
      checkedAt: atB.lastIndexedAt,
      revisionGeneration: 2,
    });

    const snapshotA = value.store.db.prepare(
      "SELECT state FROM revision_snapshots WHERE id=? AND repo_id=?",
    ).get(atA.snapshotId, first.repoId);
    assert.equal(snapshotA.state, "ready");

    const historicalBySnapshot = resolveQueryScope(value.store, {
      repoId: first.repoId,
      snapshotId: atA.snapshotId,
      readGitState: () => ({ branch: "main", headSha: commitB, dirty: false }),
    });
    assert.equal(historicalBySnapshot.alignment, "explicit");
    assert.equal(historicalBySnapshot.revision.snapshotId, atA.snapshotId);
    assert.equal(historicalBySnapshot.revision.commitSha, commitA);

    const historicalByCommit = resolveQueryScope(value.store, {
      repoId: first.repoId,
      commitSha: commitA,
      readGitState: () => ({ branch: "main", headSha: commitB, dirty: false }),
    });
    assert.equal(historicalByCommit.alignment, "explicit");
    assert.equal(historicalByCommit.revision.snapshotId, atA.snapshotId);
    assert.equal(historicalByCommit.revision.commitSha, commitA);

    for (const historical of [historicalBySnapshot, historicalByCommit]) {
      const view = openRevisionView(value.store, historical.revision);
      assert.ok(
        view.listFiles().some((file) => file.filePath === "src/stable.ts"),
        "historical snapshot A must retain readable file facts",
      );
      assert.ok(
        view.symbolVersions().length > 0,
        "historical snapshot A must retain readable symbol versions",
      );
    }

    const foreignRepoId = value.store.registerRepo({
      name: "foreign",
      rootPath: join(value.dir, "foreign"),
    });
    assert.throws(
      () => resolveQueryScope(value.store, {
        repoId: foreignRepoId,
        snapshotId: atA.snapshotId,
        readGitState: () => null,
      }),
      (error) => error instanceof ScopeResolutionError && error.code === "SCOPE_NOT_FOUND",
      "a ready snapshot must never resolve outside its repository",
    );

    const currentB = resolveQueryScope(value.store, {
      repoId: first.repoId,
      readGitState: () => ({ branch: "main", headSha: commitB, dirty: false }),
    });
    assert.equal(currentB.alignment, "aligned");
    assert.equal(currentB.revision.snapshotId, atB.snapshotId);

    value.store.db.prepare("UPDATE branches SET status='gone' WHERE id=?").run(first.branchId);
    const historyWithoutLiveBranch = resolveQueryScope(value.store, {
      repoId: first.repoId,
      snapshotId: atA.snapshotId,
      readGitState: () => ({ branch: "main", headSha: commitB, dirty: false }),
    });
    assert.equal(historyWithoutLiveBranch.alignment, "explicit");
    assert.equal(historyWithoutLiveBranch.revision.snapshotId, atA.snapshotId);
    assert.equal(historyWithoutLiveBranch.revision.branchId, undefined);
  } finally {
    value.store.close();
    rmSync(value.dir, { recursive: true, force: true });
  }
});

test("revision publication failure rolls back every branch truth field", async () => {
  const value = fixture();
  try {
    const commitA = git(value.repo, "rev-parse", "HEAD");
    const first = await indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" });
    const atA = branchTruth(value.store, first.repoId);

    git(value.repo, "commit", "--allow-empty", "-q", "-m", "commit B");
    const commitB = git(value.repo, "rev-parse", "HEAD");
    assert.notEqual(commitB, commitA);

    value.store.db.exec(`
      CREATE TRIGGER fail_revision_publication
      BEFORE UPDATE OF value ON meta
      WHEN OLD.key='revision_generation'
      BEGIN
        SELECT RAISE(ABORT, 'forced revision publication failure');
      END;
    `);

    await assert.rejects(
      () => indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" }),
      /forced revision publication failure/,
    );

    const afterFailure = branchTruth(value.store, first.repoId);
    assert.deepEqual(afterFailure, atA, "head, indexed commit, timestamp, and snapshot pointer must roll back together");
    assert.equal(revisionGeneration(value.store), 1);
  } finally {
    value.store.close();
    rmSync(value.dir, { recursive: true, force: true });
  }
});
