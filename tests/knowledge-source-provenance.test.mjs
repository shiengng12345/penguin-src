import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workingTreeProvenance } from "../scripts/knowledge-source-provenance.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "penguin-source-provenance-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "penguin@example.invalid");
  git(root, "config", "user.name", "Penguin Test");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

test("source provenance identifies a clean tree by commit", () => {
  const root = fixture();
  const result = workingTreeProvenance(root);
  assert.equal(result.state, "clean");
  assert.equal(result.sourceIdentity, result.sourceCommit);
  assert.match(result.worktreeDigest, /^[a-f0-9]{64}$/u);
});

test("source provenance binds dirty tracked and untracked bytes without pretending clean", () => {
  const root = fixture();
  const clean = workingTreeProvenance(root);
  writeFileSync(join(root, "tracked.txt"), "two\n");
  writeFileSync(join(root, "untracked.txt"), "three\n");
  const dirty = workingTreeProvenance(root);
  assert.equal(dirty.state, "dirty");
  assert.match(dirty.sourceIdentity, /^worktree:[a-f0-9]{64}$/u);
  assert.notEqual(dirty.worktreeDigest, clean.worktreeDigest);
  assert.deepEqual(dirty.dirtyFiles, [" M tracked.txt", "?? untracked.txt"]);

  const repeat = workingTreeProvenance(root);
  assert.equal(repeat.sourceIdentity, dirty.sourceIdentity);
  assert.equal(repeat.worktreeDigest, dirty.worktreeDigest);
});

test("source provenance changes for deletion and executable-mode changes", () => {
  const root = fixture();
  const baseline = workingTreeProvenance(root).worktreeDigest;
  git(root, "update-index", "--chmod=+x", "tracked.txt");
  const executable = workingTreeProvenance(root).worktreeDigest;
  assert.notEqual(executable, baseline);
  git(root, "rm", "--quiet", "--force", "tracked.txt");
  const deleted = workingTreeProvenance(root);
  assert.notEqual(deleted.worktreeDigest, executable);
  assert.equal(deleted.state, "dirty");
});
