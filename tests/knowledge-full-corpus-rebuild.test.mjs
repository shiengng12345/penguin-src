import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import {
  discoverFullCorpusRepositories,
  readFullCorpusJob,
  runFullCorpus,
} from "../packages/knowledge-indexer/dist/index.js";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Penguin Test",
      GIT_AUTHOR_EMAIL: "penguin@example.test",
      GIT_COMMITTER_NAME: "Penguin Test",
      GIT_COMMITTER_EMAIL: "penguin@example.test",
    },
  }).trim();
}

function createRepo(parent, name, symbol) {
  const root = join(parent, name);
  mkdirSync(root);
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  writeFileSync(join(root, "src.ts"), `export function ${symbol}(): string { return "${name}"; }\n`);
  execFileSync("git", ["-C", root, "add", "src.ts"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Penguin Test",
      GIT_AUTHOR_EMAIL: "penguin@example.test",
      GIT_COMMITTER_NAME: "Penguin Test",
      GIT_COMMITTER_EMAIL: "penguin@example.test",
    },
  });
  return { root, head: git(root, ["rev-parse", "HEAD"]) };
}

function openFixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-full-corpus-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  const alpha = createRepo(projects, "alpha", "alpha");
  const beta = createRepo(projects, "beta", "beta");
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  return { directory, projects, alpha, beta, store };
}

test("cold full corpus indexes and rebuilds every discovered repository with shard receipts", async () => {
  const fixture = openFixture();
  const statusPath = join(fixture.directory, "full-corpus.json");
  try {
    assert.deepEqual(
      discoverFullCorpusRepositories(fixture.projects),
      [fixture.alpha.root, fixture.beta.root].map((root) => realpathSync.native(root)).sort(),
    );
    const result = await runFullCorpus({
      store: fixture.store,
      rootPath: fixture.projects,
      statusPath,
      modes: ["index", "rebuild"],
      semantic: { enabled: false },
    });

    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    assert.equal(result.job.state, "completed");
    assert.equal(result.job.phase, "verify");
    assert.equal(result.job.completedRepos, 2);
    assert.equal(result.repositories.index.length, 2);
    assert.equal(result.repositories.rebuild.length, 2);
    for (const mode of ["index", "rebuild"]) {
      for (const receipt of result.repositories[mode]) {
        assert.ok(receipt.repoId);
        assert.ok(receipt.branchId);
        assert.ok(receipt.head.length >= 7);
        assert.ok(receipt.snapshotId);
        assert.ok(receipt.databaseInstanceId);
        assert.ok(receipt.parsed > 0, JSON.stringify(receipt));
        assert.ok(receipt.eligibleFiles > 0, JSON.stringify(receipt));
        assert.equal(receipt.zeroEligibleFilePolicy, false);
        assert.equal(receipt.revisionAligned, true, JSON.stringify(receipt));
      }
    }

    const persisted = readFullCorpusJob(statusPath);
    assert.equal(persisted.jobId, result.job.jobId);
    assert.equal(persisted.state, "completed");
    assert.equal(persisted.phase, "verify");
    assert.equal(persisted.repoIds.length, 2);
    assert.equal(persisted.lastError, null);
    assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).rootPath, realpathSync.native(fixture.projects));
  } finally {
    fixture.store.close();
  }
});
