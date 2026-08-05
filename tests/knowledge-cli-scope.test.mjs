import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { runQueryServer } from "../packages/knowledge-cli/dist/query-server.js";

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

// Regression for the query-server `knowledge.cli` compat bridge (Wiki/Tauri
// resident worker): the bridge's own `cwd` is the app's launch directory —
// meaningless for git-aware scope inference — but a scoped verb still infers
// repoId from a unique symbol match, then resolveQueryScope reads real git
// state at THAT repo's registered rootPath. If the dev has since switched to
// a branch that isn't indexed yet (an everyday occurrence), the verb used to
// exit 4 (BRANCH_NOT_INDEXED) and the bridge would throw an opaque
// CLI_EXIT_4 Error — a hard failure for normal Wiki operation, since the
// frontend never sends --allow-fallback. The bridge now force-injects
// --allow-fallback (mirroring how it already force-injects --json), so this
// must come back ok:true with a fallback envelope instead of an error.
test("query-server knowledge.cli bridge force-injects --allow-fallback so an un-indexed checked-out branch answers instead of hard-failing", async () => {
  const { store, rootPath } = fixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

  const input = new Readable({ read() {} });
  let resolveResponse;
  const responseArrived = new Promise((resolve) => { resolveResponse = resolve; });
  const output = {
    write: (chunk) => {
      const frame = JSON.parse(chunk);
      if (frame.id === "compat") resolveResponse(frame);
      return true;
    },
  };
  const deps = {
    // The bridge's real-world cwd is the app's launch dir — deliberately
    // unrelated to the fixture repo's rootPath, to prove cwd plays no part
    // in this recovering: repoId comes from the unique "Alpha" symbol match.
    cwd: "/nowhere/the/tauri/app/happened/to/launch/from",
    out: () => {}, err: () => {},
    openStore: () => store,
    storeExists: () => true,
  };

  const serverExit = runQueryServer(deps, input, output);
  input.push(`${JSON.stringify({ type: "request", id: "compat", capabilityId: "knowledge.cli", input: { args: ["context", "Alpha"] } })}\n`);
  const response = await responseArrived;
  input.push(null);
  await serverExit;

  assert.equal(response.ok, true, `expected the bridge to answer instead of erroring: ${JSON.stringify(response)}`);
  assert.equal(response.result.alignment, "fallback");
  assert.ok(response.result.warnings.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"));
  assert.equal(response.result.locator.branchName, "main");
  // store.close() is called by runQueryServer itself.
});

// Phase 1B Task 2: for context/flow, `target` IS a symbol name, so a unique
// symbol match is a trustworthy repo signal. For `search`, `target` is free
// query text — a two-repo fixture where the query text uniquely matches a
// symbol ONLY in repo B proves the search verb prefers cwd-prefix inference
// over that query-text match, and discloses when it must fall back anyway.
function twoRepoFixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-cli-scope-two-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });

  const rootA = join(dir, "repoA");
  mkdirSync(rootA, { recursive: true });
  const repoIdA = store.registerRepo({ name: "A", rootPath: rootA });
  const branchIdA = store.registerBranch({ repoId: repoIdA, name: "main", headCommit: "sha-a", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-a' WHERE id=?").run(branchIdA);
  const nodeIdA = store.upsertNode({ nodeType: "symbol", identityKey: `${repoIdA}::Alpha`, repoId: repoIdA, title: "Alpha" });
  store.upsertSymbolVersion({ nodeId: nodeIdA, branchId: branchIdA, commitSha: "sha-a", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "Alpha()", contentHash: "h1" });
  store.indexSymbolText({ nodeId: nodeIdA, name: "Alpha", signature: "Alpha()" });

  const rootB = join(dir, "repoB");
  mkdirSync(rootB, { recursive: true });
  const repoIdB = store.registerRepo({ name: "B", rootPath: rootB });
  const branchIdB = store.registerBranch({ repoId: repoIdB, name: "main", headCommit: "sha-b", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-b' WHERE id=?").run(branchIdB);
  const nodeIdB = store.upsertNode({ nodeType: "symbol", identityKey: `${repoIdB}::Beta`, repoId: repoIdB, title: "Beta" });
  store.upsertSymbolVersion({ nodeId: nodeIdB, branchId: branchIdB, commitSha: "sha-b", filePath: "src/b.ts", lang: "typescript", kind: "function", signature: "Beta()", contentHash: "h2" });
  store.indexSymbolText({ nodeId: nodeIdB, name: "Beta", signature: "Beta()" });

  return { store, dir, rootA, rootB };
}

test("search with cwd inside repo A scopes to A even though the query text uniquely matches a symbol only in repo B", async () => {
  const { store, rootA } = twoRepoFixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "main", rootA]);
  execFileSync("git", ["-C", rootA, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

  const lines = [];
  const code = await runCli(["search", "Beta", "--json"], cliDeps(store, rootA, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.locator.repoName, "A");
  store.close();
});

test("search with cwd outside any registered repo falls back to the query-text symbol match and discloses REPO_INFERRED_FROM_QUERY", async () => {
  const { store, dir } = twoRepoFixture();
  const outside = mkdtempSync(join(tmpdir(), "penguin-cli-scope-outside-"));
  const lines = [];
  const code = await runCli(["search", "Beta", "--json"], cliDeps(store, outside, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.locator.repoName, "B");
  assert.ok(payload.warnings.some((w) => w.code === "REPO_INFERRED_FROM_QUERY"));
  assert.match(payload.warnings.find((w) => w.code === "REPO_INFERRED_FROM_QUERY").message, /query text match in B/);
  store.close();
});
