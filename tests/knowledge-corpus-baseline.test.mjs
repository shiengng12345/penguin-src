import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  captureCorpusBaseline,
  captureProtectedAssets,
  writeCorpusBaseline,
} from "../packages/knowledge-core/dist/index.js";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

test("corpus baseline records independent Git truth, protected hashes, and no-clobber output", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-baseline-"));
  const repo = join(directory, "repo");
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  execFileSync("mkdir", [repo]);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "penguin@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Penguin Test"]);
  writeFileSync(join(repo, "README.md"), "# baseline\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "baseline"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const repoId = store.registerRepo({ name: "baseline-repo", rootPath: repo });
  store.registerBranch({ repoId, name: "main", headCommit: head, status: "live" });
  const protectedAssets = captureProtectedAssets(store, { ensureDatabaseInstanceId: false });
  const baseline = captureCorpusBaseline(store, {
    rootPath: repo,
    databasePath: dbPath,
    ledgerPath,
    protectedAssets,
    ensureDatabaseInstanceId: false,
  });
  assert.equal(baseline.formatVersion, 1);
  assert.equal(baseline.databaseInstanceId, protectedAssets.databaseInstanceId);
  assert.equal(baseline.repositories.length, 1);
  assert.equal(baseline.repositories[0].branches[0].headCommit, head);
  assert.equal(baseline.sourceGroundTruthComplete, true);
  assert.equal(baseline.sourceGroundTruthGaps.length, 0);
  assert.equal(baseline.sourceGroundTruthHash.length, 64);
  assert.equal(baseline.immutableAssetHashes["protected:bundle"], protectedAssets.bundleHash);
  assert.ok(baseline.databaseBytes > 0);
  assert.equal(baseline.walBytes >= 0, true);
  assert.equal(baseline.shmBytes >= 0, true);
  assert.equal(baseline.counts.repos, 1);
  assert.equal(baseline.counts.branches, 1);

  const output = join(directory, "baseline.json");
  writeCorpusBaseline(baseline, output);
  assert.equal(existsSync(output), true);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => writeCorpusBaseline(baseline, output), /EEXIST/);

  writeFileSync(join(repo, "working-tree.txt"), "not committed\n");
  const changed = captureCorpusBaseline(store, {
    rootPath: repo,
    databasePath: dbPath,
    protectedAssets,
    ensureDatabaseInstanceId: false,
  });
  assert.notEqual(changed.sourceGroundTruthHash, baseline.sourceGroundTruthHash);
  chmodSync(output, 0o600);
  store.close();
});
