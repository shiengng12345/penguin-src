import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("self-contained CLI and MCP bundles include the RE2 WASM runtime", () => {
  const cliRoot = "packages/knowledge-cli/bundle";
  const mcpRoot = "packages/mcp/bundle";
  assert.equal(existsSync(`${cliRoot}/node`), true);
  assert.equal(existsSync(`${cliRoot}/node_modules/re2-wasm/package.json`), true);
  assert.equal(existsSync(`${mcpRoot}/node_modules/re2-wasm/package.json`), true);
  const probe = spawnSync(resolve(cliRoot, "node"), ["-e", "const {RE2}=require('re2-wasm'); if (!new RE2('needle','u').test('needle')) process.exit(2)"], {
    cwd: resolve(cliRoot),
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, probe.stderr);
});

test("self-contained MCP bundle executes its bounded knowledge worker", () => {
  const mcpRoot = resolve("packages/mcp/bundle");
  const workerPath = join(mcpRoot, "dist", "knowledge-worker.js");
  const dir = mkdtempSync(join(tmpdir(), "penguin-mcp-worker-bundle-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  store.close();

  try {
    const script = [
      "const { Worker } = require('node:worker_threads');",
      "const worker = new Worker(process.argv[1], { workerData: { dbPath: process.argv[2], ledgerPath: process.argv[3] } });",
      "const timer = setTimeout(() => { console.error('worker timeout'); worker.terminate(); process.exit(3); }, 5000);",
      "worker.once('error', (error) => { clearTimeout(timer); console.error(error); process.exit(2); });",
      "worker.once('message', (message) => { clearTimeout(timer); if (!message.ok || message.id !== 'probe') { console.error(JSON.stringify(message)); process.exit(4); } worker.terminate().then(() => process.exit(0)); });",
      "worker.postMessage({ type: 'run', id: 'probe', capabilityId: 'knowledge.mcp_tool', input: { name: 'knowledge_index_status', arguments: { mode: 'compact' } } });",
    ].join("\n");
    const probe = spawnSync(
      join(mcpRoot, "node"),
      ["-e", script, workerPath, dbPath, ledgerPath],
      { cwd: mcpRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
