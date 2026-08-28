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

// The bundle only ships the worker files the bundler is told about. parse-worker
// was missing for a release: parallel parsing silently never ran in the packaged
// CLI, and the failed spawns left `penguin rebuild` exiting 0 having written
// nothing. Derive the expectation from the source instead of restating it — a
// new `new Worker("./x.js")` anywhere in the CLI's dependency tree fails here
// until the bundler emits x.js.
test("every worker the bundled CLI can spawn ships beside it", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const cliBundle = resolve("packages/knowledge-cli/bundle");

  const spawned = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "bundle") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(/new Worker\(\s*new URL\(\s*"\.\/([\w.-]+)\.js"/g)) {
        spawned.add(`${match[1]}.js`);
      }
    }
  };
  walk(resolve("packages"));

  assert.ok(spawned.size > 0, "found no worker spawns to check — the scan is broken, not the bundle");
  for (const file of spawned) {
    assert.equal(
      existsSync(join(cliBundle, file)),
      true,
      `${file} is spawned as a worker but is not in the CLI bundle — add it to workerBuilds in scripts/bundle-knowledge-cli.mjs`,
    );
  }
});
