import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, resolveBundledEmbeddingSpaceIdentity } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

function runtimeIdentityFixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-worker-runtime-identity-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const runtimeRoot = join(dir, "runtimes");
  const current = join(runtimeRoot, "current");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    ready: true,
    buildId: "available-build-b",
    appVersion: "1.0.0",
    capabilityHash: "a".repeat(64),
    contractSchemaVersion: 18,
    contractVersion: "2",
    modelHash: "b".repeat(64),
  }));
  KnowledgeStore.open({ dbPath, ledgerPath }).close();
  return { dir, dbPath, ledgerPath, runtimeRoot };
}

function runSemanticWorkerIdentityProbe(value, runningBuildId) {
  const env = {
    ...process.env,
    PENGUIN_RUNTIME_ROOT: value.runtimeRoot,
    PENGUIN_KNOWLEDGE_DB: value.dbPath,
    PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath,
    PENGUIN_CAPABILITY_HASH: "a".repeat(64),
    PENGUIN_SCHEMA_VERSION: "18",
    PENGUIN_MODEL_HASH: "b".repeat(64),
  };
  if (runningBuildId === undefined) delete env.PENGUIN_BUILD_ID;
  else env.PENGUIN_BUILD_ID = runningBuildId;
  return spawnSync(process.execPath, [resolve("packages/knowledge-cli/dist/bin.js"), "semantic", "worker", "--drain", "--json"], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
}

for (const [name, runningBuildId] of [
  ["running build A differs from available build B", "running-build-a"],
  ["PENGUIN_BUILD_ID is missing", undefined],
]) {
  test(`semantic worker fails closed when ${name}`, () => {
    const value = runtimeIdentityFixture();
    try {
      const result = runSemanticWorkerIdentityProbe(value, runningBuildId);
      assert.equal(result.status, 5, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
      assert.equal(payload.status, "version_mismatch");
      assert.equal(payload.reason, "VERSION_MISMATCH");
      const verify = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
      const runtime = JSON.parse(verify.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value);
      const lease = verify.db.prepare("SELECT lease_expires_at AS leaseExpiresAt FROM semantic_worker_leases WHERE lock_name='semantic-drain'").get();
      verify.close();
      assert.equal(runtime.status, "version_mismatch");
      assert.notEqual(runtime.identity.buildId, "available-build-b", "available build must not self-certify the running worker");
      assert.equal(lease, undefined, "identity rejection happens before worker lease acquisition");
    } finally {
      rmSync(value.dir, { recursive: true, force: true });
    }
  });
}

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

test("self-contained CLI bundle loads sqlite-vec without workspace resolution", () => {
  const sourceRoot = resolve("packages/knowledge-cli/bundle");
  const isolatedRoot = mkdtempSync(join(tmpdir(), "penguin-sqlite-vec-bundle-"));
  const runtimeRoot = join(isolatedRoot, "runtime");
  cpSync(sourceRoot, runtimeRoot, { recursive: true });
  const packageName = `sqlite-vec-darwin-${process.arch}`;
  try {
    assert.equal(existsSync(join(runtimeRoot, "node_modules/sqlite-vec/package.json")), true);
    assert.equal(existsSync(join(runtimeRoot, "node_modules", packageName, "vec0.dylib")), true);
    const probe = spawnSync(join(runtimeRoot, "node"), ["-e", [
      "const Database=require('better-sqlite3');",
      "const sqliteVec=require('sqlite-vec');",
      "if (!sqliteVec.getLoadablePath().includes(process.cwd())) process.exit(11);",
      "const db=new Database(':memory:'); sqliteVec.load(db);",
      "db.exec('create virtual table vectors using vec0(embedding float[2])');",
      "db.prepare('insert into vectors(embedding) values (?)').run(Buffer.from(new Float32Array([1,0]).buffer));",
      "const rows=db.prepare('select rowid,distance from vectors where embedding match ? and k=1').all(Buffer.from(new Float32Array([1,0]).buffer));",
      "if (rows.length !== 1 || rows[0].distance !== 0) process.exit(12);",
      "db.close();",
    ].join(" ")], { cwd: runtimeRoot, encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_PATH: "" } });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("self-contained CLI bundle contains the pinned local embedding model", () => {
  const modelRoot = resolve("packages/knowledge-cli/bundle/models/nomic-embed-text-v1.5");
  assert.equal(existsSync(join(modelRoot, "manifest.json")), true);
  assert.equal(existsSync(join(modelRoot, "onnx/model_quantized.onnx")), true);
  assert.equal(existsSync(join(modelRoot, "tokenizer.json")), true);
});

test("self-contained CLI bundle drains and activates a real bundled embedding generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-bundled-semantic-drain-"));
  const repo = join(dir, "repo");
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const runtimeRoot = join(dir, "runtimes");
  const cliRoot = resolve("packages/knowledge-cli/bundle");
  const modelRoot = join(cliRoot, "models/nomic-embed-text-v1.5");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(repo, "src", "semantic.ts"), "export function exactSemanticDrainProof() { return 'bundled provider'; }\n");
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Penguin Test", GIT_AUTHOR_EMAIL: "penguin@example.invalid", GIT_COMMITTER_NAME: "Penguin Test", GIT_COMMITTER_EMAIL: "penguin@example.invalid" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  execFileSync("git", ["-C", repo, "add", "."], { env: gitEnv });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"], { env: gitEnv });
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const space = resolveBundledEmbeddingSpaceIdentity({ modelDirectory: modelRoot });
  const report = await indexRepo({ store, rootPath: repo, mode: "incremental", semantic: { enabled: true, space } });
  assert.equal(report.semantic.status, "queued");
  store.close();
  try {
    const result = spawnSync(join(cliRoot, "node"), [join(cliRoot, "penguin.mjs"), "semantic", "worker", "--drain", "--json"], {
      cwd: cliRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PENGUIN_RUNTIME_ROOT: runtimeRoot,
        PENGUIN_KNOWLEDGE_DB: dbPath,
        PENGUIN_KNOWLEDGE_LEDGER: ledgerPath,
        PENGUIN_EMBEDDING_MODEL_DIR: modelRoot,
        PENGUIN_BUILD_ID: "bundle-test",
        PENGUIN_CAPABILITY_HASH: "a".repeat(64),
        PENGUIN_SCHEMA_VERSION: "18",
        PENGUIN_MODEL_HASH: "b".repeat(64),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(payload.status, "drained");
    const verify = KnowledgeStore.open({ dbPath, ledgerPath });
    assert.equal(verify.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(report.semantic.generationId).status, "active");
    assert.equal(verify.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='ready'").get(report.semantic.generationId).n > 0, true);
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release CLI bundle keeps only the target ONNX native payload", () => {
  const nativeRoot = resolve("packages/knowledge-cli/bundle/node_modules/onnxruntime-node/bin/napi-v6");
  const targetPlatform = process.platform;
  const targetArch = process.arch;
  assert.equal(existsSync(join(nativeRoot, targetPlatform, targetArch, "onnxruntime_binding.node")), true);
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const arch of ["arm64", "x64"]) {
      if (platform === targetPlatform && arch === targetArch) continue;
      assert.equal(
        existsSync(join(nativeRoot, platform, arch)),
        false,
        `foreign ONNX payload must not ship: ${platform}/${arch}`,
      );
    }
  }
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

test("fresh MCP bundle can load knowledge-indexer read-only note tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-mcp-indexer-bundle-"));
  const mcpRoot = join(dir, "runtime");
  // Run outside the monorepo so a missing bundled dependency cannot resolve
  // accidentally through packages/mcp/node_modules.
  cpSync(resolve("packages/mcp/bundle"), mcpRoot, { recursive: true });
  const workerPath = join(mcpRoot, "dist", "knowledge-worker.js");
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
      "worker.once('message', (message) => { clearTimeout(timer); const result = message.result; if (!message.ok || message.id !== 'notes' || result?.error || !Array.isArray(result?.items)) { console.error(JSON.stringify(message)); process.exit(4); } worker.terminate().then(() => process.exit(0)); });",
      "worker.postMessage({ type: 'run', id: 'notes', capabilityId: 'knowledge.mcp_tool', input: { name: 'knowledge_note_list', arguments: {} } });",
    ].join("\n");
    const probe = spawnSync(
      join(mcpRoot, "node"),
      ["-e", script, workerPath, dbPath, ledgerPath],
      { cwd: mcpRoot, encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: dir } },
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
