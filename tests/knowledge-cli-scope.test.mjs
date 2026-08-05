import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-cli-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-main' WHERE id=?").run(branchId);
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Alpha`, repoId, title: "Alpha" });
  store.upsertSymbolVersion({ nodeId, branchId, commitSha: "sha-main", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "Alpha()", contentHash: "h1" });
  store.indexSymbolText({ nodeId, name: "Alpha", signature: "Alpha()" });
  return { store, dir, rootPath };
}

// NOTE: CliDeps.cwd is a plain string field (not a factory) in this codebase
// (see tests/knowledge-cli.test.mjs's `harness()`), so the deps builder below
// mirrors that shape rather than the `cwd: () => cwd` sketch in the task
// brief — the brief's anchor assumed `cwd` was absent from CliDeps, but it is
// already a required string property used pervasively across command-dispatch.ts.
function cliDeps(store, cwd, lines) {
  return { openStore: () => store, storeExists: () => true, out: (l) => lines.push(l), err: (l) => lines.push(l), cwd };
}

test("context on an un-indexed checked-out branch exits 4 with BRANCH_NOT_INDEXED", async () => {
  const { store, rootPath } = fixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const lines = [];
  const code = await runCli(["context", "Alpha", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 4);
  assert.match(lines.join("\n"), /penguin index/);
  store.close();
});

test("context with --allow-fallback answers from the live branch and carries the envelope", async () => {
  const { store, rootPath } = fixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const lines = [];
  const code = await runCli(["context", "Alpha", "--allow-fallback", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.locator.branchName, "main");
  assert.equal(payload.alignment, "fallback");
  assert.ok(payload.warnings.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"));
  store.close();
});

test("context on an indexed branch with no git repo at cwd falls back to the sole live branch (GIT_UNAVAILABLE)", async () => {
  const { store, rootPath } = fixture();
  const lines = [];
  const code = await runCli(["context", "Alpha", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.locator.branchName, "main");
  assert.equal(payload.alignment, "fallback");
  assert.ok(payload.warnings.some((w) => w.code === "GIT_UNAVAILABLE"));
  store.close();
});

test("context with cwd outside any registered repo softens REPO_REQUIRED back to unscoped (no envelope)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-cli-scope-outside-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const lines = [];
  const code = await runCli(["context", "Nonexistent", "--json"], cliDeps(store, dir, lines));
  assert.equal(code, 1); // no focus found — but must not error out on scope resolution
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.locator, undefined);
  store.close();
});

test("--allow-fallback is a recognized boolean flag (does not swallow the next positional arg)", async () => {
  const { store, rootPath } = fixture();
  const lines = [];
  const code = await runCli(["context", "Alpha", "--allow-fallback", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.focus?.title, "Alpha");
  store.close();
});
