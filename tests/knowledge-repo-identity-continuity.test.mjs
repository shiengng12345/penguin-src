import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin Identity Test",
  GIT_AUTHOR_EMAIL: "penguin-identity@example.invalid",
  GIT_COMMITTER_NAME: "Penguin Identity Test",
  GIT_COMMITTER_EMAIL: "penguin-identity@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

test("realpath and symlink aliases keep one repository and branch identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-repo-identity-"));
  const repo = join(directory, "repo");
  const alias = join(directory, "repo-alias");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "identity.ts"), "export const identity = true;\n");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "identity fixture");
  symlinkSync(repo, alias, "dir");

  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  try {
    const first = await indexRepo({ store, rootPath: repo, mode: "incremental", semantic: { enabled: false } });
    const second = await indexRepo({ store, rootPath: alias, mode: "incremental", semantic: { enabled: false } });
    assert.equal(realpathSync.native(repo), realpathSync.native(alias));
    assert.equal(second.repoId, first.repoId);
    assert.equal(second.branchId, first.branchId);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM repos").get().n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM branches").get().n, 1);
    assert.equal(second.parsed, 0, "the alias run should reuse the same clean revision");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
