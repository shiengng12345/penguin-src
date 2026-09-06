import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const indexerRequire = createRequire(new URL("../packages/knowledge-indexer/dist/index.js", import.meta.url));
const grammarWasmDir = join(dirname(indexerRequire.resolve("tree-sitter-wasms/package.json")), "out");
const testWasmDir = mkdtempSync(join(tmpdir(), "penguin-mcp-working-tree-wasm-"));
for (const name of readdirSync(grammarWasmDir)) {
  if (name.endsWith(".wasm")) copyFileSync(join(grammarWasmDir, name), join(testWasmDir, name));
}
copyFileSync(join(dirname(indexerRequire.resolve("web-tree-sitter")), "tree-sitter.wasm"), join(testWasmDir, "tree-sitter.wasm"));

async function loadMcpTools() {
  const root = mkdtempSync(join(tmpdir(), `penguin-mcp-working-tree-${process.pid}-`));
  const handler = join(root, "handler.mjs");
  const coreDist = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname;
  await build({
    entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: handler,
    alias: { "@penguin/knowledge-core": coreDist },
    banner: {
      js: "import { createRequire as __pgvCreateRequire } from 'node:module'; const require = __pgvCreateRequire(import.meta.url);",
    },
  });
  return { module: await import(`file://${handler}`), root };
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

test("MCP workingTree search prepares an exact isolated overlay", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-mcp-working-tree-repo-"));
  const dbDir = mkdtempSync(join(tmpdir(), "penguin-mcp-working-tree-db-"));
  const { module, root: bundleRoot } = await loadMcpTools();
  const store = KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") });
  const previousWasmDir = process.env.PENGUIN_WASM_DIR;
  process.env.PENGUIN_WASM_DIR = testWasmDir;
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.ts"), "export const base = true;\n");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "penguin@test"]);
    git(root, ["config", "user.name", "Penguin Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);

    const indexed = await indexRepo({ store, rootPath: root, mode: "rebuild", semantic: { enabled: false } });
    const branchBefore = store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id;
    writeFileSync(join(root, "src", "main.ts"), "export const mcpOverlayMarker = 'mcp-overlay-only';\n");
    writeFileSync(join(root, "src", "new.ts"), "export const newMcpOverlayFile = true;\n");

    const response = await module.runKnowledgeTool("knowledge_search", {
      query: "mcp-overlay-only",
      contract_version: "2",
      scope: { revisions: [{ repoId: indexed.repoId, workingTree: true }] },
      page: { limit: 10 },
    }, { store });

    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(response.workingTree.applied, true, JSON.stringify(response));
    assert.equal(response.revision.trust, "exact_worktree", JSON.stringify(response));
    assert.equal(response.diagnostics.resolvedScopes[0].revisionKind, "working_tree", JSON.stringify(response));
    assert.ok(response.hits.some((hit) => hit.snippet?.includes("mcp-overlay-only")), JSON.stringify(response));
    assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id, branchBefore);
  } finally {
    if (previousWasmDir === undefined) delete process.env.PENGUIN_WASM_DIR;
    else process.env.PENGUIN_WASM_DIR = previousWasmDir;
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(bundleRoot, { recursive: true, force: true });
    rmSync(testWasmDir, { recursive: true, force: true });
  }
});
