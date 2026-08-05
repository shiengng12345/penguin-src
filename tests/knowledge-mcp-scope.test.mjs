import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

// knowledge-tools.ts is bundled into the MCP server (esbuild → single file), so
// it isn't separately importable as TS. Bundle it the same way
// tests/knowledge-mcp-tools.test.mjs does, so this exercises the same module
// graph as the release server.
async function loadTools() {
  const root = mkdtempSync(join(tmpdir(), `penguin-mcp-scope-tools-${process.pid}-`));
  const handler = join(root, "handler.mjs");
  const defs = join(root, "defs.mjs");
  const coreDist = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname;
  await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: handler, alias: { "@penguin/knowledge-core": coreDist } });
  await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tool-defs.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: defs });
  return { ...(await import(`file://${defs}`)), ...(await import(`file://${handler}`)) };
}
const { handleKnowledgeTool } = await loadTools();

// Same fixture idiom as tests/knowledge-cli-scope.test.mjs: a real git repo
// checked out on an un-indexed branch ("feature-x"), with only "main"
// registered + indexed in the knowledge store.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-mcp-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-main' WHERE id=?").run(branchId);
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Alpha`, repoId, title: "Alpha" });
  store.upsertSymbolVersion({ nodeId, branchId, commitSha: "sha-main", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "Alpha()", contentHash: "h1" });
  store.indexSymbolText({ nodeId, name: "Alpha", signature: "Alpha()" });
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  return { store, dir, rootPath, nodeId };
}

test("knowledge_context on an un-indexed checked-out branch returns a BRANCH_NOT_INDEXED tool error", () => {
  const { store } = fixture();
  const result = handleKnowledgeTool("knowledge_context", { target: "Alpha" }, store);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /BRANCH_NOT_INDEXED/);
  assert.match(serialized, /penguin index/);
  store.close();
});

test("knowledge_context with allow_fallback:true answers from the live branch and carries the scope envelope", () => {
  const { store } = fixture();
  const result = handleKnowledgeTool("knowledge_context", { target: "Alpha", allow_fallback: true }, store);
  assert.equal(result.locator?.branchName, "main");
  assert.equal(result.alignment, "fallback");
  assert.ok(result.warnings?.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"), JSON.stringify(result.warnings));
  store.close();
});

// get_node/explore_graph/compare_branches are selector-gated (see
// legacyGatedRepoId in knowledge-tools.ts): they don't have allow_fallback in
// their schemas or locator/warnings on their results, so unlike the 9 named
// scoped tools above, routing their symbol-inferred repo through
// resolveQueryScope unconditionally would newly hard-fail previously-answering
// calls with BRANCH_NOT_INDEXED. These two cases pin that gate down.
test("get_node with no selector against an un-indexed checked-out branch still answers (selector-gated, not scope-unified)", () => {
  const { store, nodeId } = fixture();
  const result = handleKnowledgeTool("get_node", { id: nodeId }, store);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /BRANCH_NOT_INDEXED/);
  assert.equal(result.node?.title, "Alpha");
  store.close();
});

test("get_node with an explicit branch selector for a non-existent branch still errors (SCOPE_NOT_FOUND path unchanged)", () => {
  const { store, nodeId } = fixture();
  const result = handleKnowledgeTool("get_node", { id: nodeId, branch: "no-such-branch" }, store);
  assert.equal(result.error?.code, "SCOPE_NOT_FOUND", JSON.stringify(result));
  store.close();
});

// status_panel is the MCP-side wiring for knowledge.status_panel (Task 3):
// same fixture as above (git checked out on un-indexed "feature-x", only
// "main" registered/indexed) exercises the same branch_not_indexed +
// live-fallback path already covered end-to-end for the native query-server
// runtime in tests/knowledge-status-panel.test.mjs.
test("status_panel reports branch_not_indexed with a live fallback via the MCP handler", () => {
  const { store, rootPath } = fixture();
  const result = handleKnowledgeTool("status_panel", {}, store);
  assert.equal(result.db.schemaVersion, 14);
  assert.equal(result.repos.length, 1);
  assert.equal(result.repos[0].rootPath, rootPath);
  assert.equal(result.repos[0].branchName, "feature-x");
  assert.equal(result.repos[0].revisionAlignment, "branch_not_indexed");
  assert.equal(result.repos[0].indexedBranch, "main");
  store.close();
});
