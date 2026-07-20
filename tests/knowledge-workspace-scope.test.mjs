import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { assertWorkspacePath, canonicalPathForCheck, isPathWithinWorkspace, parseWorkspaceRoots } from "../packages/knowledge-core/dist/index.js";

test("workspace scope resolves real paths and rejects symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-scope-root-"));
  const outside = mkdtempSync(join(tmpdir(), "penguin-scope-outside-"));
  const link = join(root, "linked");
  symlinkSync(outside, link, "dir");
  const roots = parseWorkspaceRoots(root, root);
  assert.equal(isPathWithinWorkspace(join(root, "inside"), roots), true);
  assert.equal(isPathWithinWorkspace(join(link, "secret.ts"), roots), false);
  assert.throws(() => assertWorkspacePath(link, roots, "test"), /WORKSPACE_SCOPE_DENIED/);
});

test("workspace scope accepts configured roots and rejects traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-scope-config-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const roots = parseWorkspaceRoots(repo, "/");
  assert.equal(assertWorkspacePath(join(repo, "src"), roots, "repo"), canonicalPathForCheck(join(repo, "src")));
  assert.throws(() => assertWorkspacePath(join(repo, "..", "outside"), roots, "repo"), /WORKSPACE_SCOPE_DENIED/);
});
