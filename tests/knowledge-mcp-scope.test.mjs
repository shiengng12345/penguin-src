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
  return { store, dir, rootPath };
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
