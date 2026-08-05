import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, resolveQueryScope, ScopeResolutionError } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-query-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const mainId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-main', last_indexed_at='2026-08-05T00:00:00Z' WHERE id=?").run(mainId);
  return { store, repoId, rootPath };
}

test("aligned: checked-out branch is indexed at head", () => {
  const { store, repoId, rootPath } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    readGitState: () => ({ branch: "main", headSha: "sha-main", dirty: false }),
  });
  assert.equal(scope.alignment, "aligned");
  assert.equal(scope.locator.branchName, "main");
  assert.equal(scope.locator.rootPath, rootPath);
  assert.deepEqual(scope.warnings, []);
  store.close();
});

test("behind + dirty: aligned with REVISION_BEHIND and WORKTREE_DRIFT warnings", () => {
  const { store, repoId } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    readGitState: () => ({ branch: "main", headSha: "sha-newer", dirty: true }),
  });
  assert.equal(scope.alignment, "aligned");
  const codes = scope.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["REVISION_BEHIND", "WORKTREE_DRIFT"]);
  store.close();
});

test("checked-out branch not indexed → hard BRANCH_NOT_INDEXED", () => {
  const { store, repoId } = fixture();
  assert.throws(
    () => resolveQueryScope(store, { repoId, readGitState: () => ({ branch: "feature-x", headSha: "sha-f", dirty: false }) }),
    (err) => err instanceof ScopeResolutionError && err.code === "BRANCH_NOT_INDEXED" && /penguin index/.test(err.message),
  );
  store.close();
});

test("allowFallback downgrades the blocker to a warning and falls back to the live branch", () => {
  const { store, repoId } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    allowFallback: true,
    readGitState: () => ({ branch: "feature-x", headSha: "sha-f", dirty: false }),
  });
  assert.equal(scope.alignment, "fallback");
  assert.equal(scope.locator.branchName, "main");
  assert.ok(scope.warnings.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"));
  store.close();
});

test("explicit branch selector differing from checkout warns SCOPE_DIFFERS_FROM_CHECKOUT", () => {
  const { store, repoId } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    branch: "main",
    readGitState: () => ({ branch: "feature-x", headSha: "sha-f", dirty: false }),
  });
  assert.equal(scope.alignment, "explicit");
  assert.ok(scope.warnings.some((w) => w.code === "SCOPE_DIFFERS_FROM_CHECKOUT"));
  store.close();
});

test("cwd inside the repo root infers the repo", () => {
  const { store, rootPath } = fixture();
  const scope = resolveQueryScope(store, {
    cwd: join(rootPath, "src", "deep"),
    readGitState: () => ({ branch: "main", headSha: "sha-main", dirty: false }),
  });
  assert.equal(scope.locator.repoName, "demo");
  store.close();
});
