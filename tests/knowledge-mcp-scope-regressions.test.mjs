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
const wasmDir = mkdtempSync(join(tmpdir(), "penguin-mcp-scope-wasm-"));
for (const name of readdirSync(grammarWasmDir)) {
  if (name.endsWith(".wasm")) copyFileSync(join(grammarWasmDir, name), join(wasmDir, name));
}
copyFileSync(join(dirname(indexerRequire.resolve("web-tree-sitter")), "tree-sitter.wasm"), join(wasmDir, "tree-sitter.wasm"));

async function loadMcpTools() {
  const root = mkdtempSync(join(tmpdir(), `penguin-mcp-scope-${process.pid}-`));
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

function repoFixture(prefix, marker) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-repo-`));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "marker.ts"), `export class ${marker} { value = true; }\n`);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "penguin@test"]);
  git(root, ["config", "user.name", "Penguin Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

test("MCP get_node rejects a node from another repository inside the requested revision", async () => {
  const rootA = repoFixture("penguin-mcp-scope-a", "ScopedLocalNode");
  const rootB = repoFixture("penguin-mcp-scope-b", "ScopedForeignNode");
  const dbDir = mkdtempSync(join(tmpdir(), "penguin-mcp-scope-db-"));
  const { module, root: bundleRoot } = await loadMcpTools();
  const store = KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") });
  const previousWasmDir = process.env.PENGUIN_WASM_DIR;
  process.env.PENGUIN_WASM_DIR = wasmDir;
  try {
    const indexedA = await indexRepo({ store, rootPath: rootA, mode: "rebuild", semantic: { enabled: false } });
    const indexedB = await indexRepo({ store, rootPath: rootB, mode: "rebuild", semantic: { enabled: false } });
    const snapshotA = store.db.prepare("SELECT current_snapshot_id AS snapshotId FROM branches WHERE id=?").get(indexedA.branchId).snapshotId;
    const foreign = store.db.prepare("SELECT id FROM nodes WHERE repo_id=? AND title=? LIMIT 1").get(indexedB.repoId, "ScopedForeignNode");
    assert.ok(snapshotA);
    assert.ok(foreign);

    const response = await module.runKnowledgeTool("get_node", {
      id: `node:${foreign.id}`,
      repo: indexedA.repoId,
      snapshot_id: snapshotA,
    }, { store });

    assert.equal(response.error?.code, "SCOPE_MISMATCH", JSON.stringify(response));
    assert.equal(response.error?.details?.actualRepoId, indexedB.repoId, JSON.stringify(response));
  } finally {
    if (previousWasmDir === undefined) delete process.env.PENGUIN_WASM_DIR;
    else process.env.PENGUIN_WASM_DIR = previousWasmDir;
    store.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(bundleRoot, { recursive: true, force: true });
    rmSync(wasmDir, { recursive: true, force: true });
  }
});
