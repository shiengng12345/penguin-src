#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const startedAt = new Date().toISOString();
const gates = [];

function runGate(id, description, files) {
  const started = Date.now();
  // These suites intentionally exercise detached processes, leases and
  // process-group cleanup. Running their test files concurrently makes the
  // OS-level ownership assertions contend with each other and turns a
  // deterministic lifecycle result into a flaky timeout. Query latency
  // budgets remain enforced by their own gates; this is only test isolation.
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const passed = result.status === 0;
  gates.push({
    id,
    description,
    passed,
    durationMs: Date.now() - started,
    files,
    ...(passed ? {} : {
      exitCode: result.status,
      stdout: String(result.stdout ?? "").slice(-8_000),
      stderr: String(result.stderr ?? "").slice(-8_000),
      signal: result.signal ?? null,
    }),
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyBundle() {
  const cli = join(root, "packages/knowledge-cli/bundle");
  const mcp = join(root, "packages/mcp/bundle");
  const modelRoot = join(cli, "models/nomic-embed-text-v1.5");
  const manifestPath = join(modelRoot, "manifest.json");
  const required = [
    join(cli, "node"),
    join(cli, "penguin.mjs"),
    join(cli, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
    join(cli, "node_modules/sqlite-vec-darwin-arm64/vec0.dylib"),
    join(cli, "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node"),
    join(mcp, "dist/index.js"),
    manifestPath,
  ];
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`PACKAGED_RUNTIME_MISSING: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [relative, expected] of Object.entries(manifest.assetDigests ?? {})) {
    const path = join(modelRoot, relative);
    if (!existsSync(path)) throw new Error(`MODEL_ASSET_MISSING: ${relative}`);
    const actual = sha256(path);
    if (actual !== expected) throw new Error(`MODEL_ASSET_HASH_MISMATCH: ${relative}`);
  }
  const probe = spawnSync(join(cli, "node"), [join(cli, "penguin.mjs"), "capabilities", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, PENGUIN_BUILD_ID: "semantic-acceptance" },
  });
  if (probe.status !== 0) throw new Error(`PACKAGED_CLI_FAILED: ${probe.stderr || probe.stdout}`);
  const payload = JSON.parse(String(probe.stdout).trim().split(/\r?\n/u).at(-1));
  if (Number(payload.schemaVersion) !== 18) throw new Error(`PACKAGED_SCHEMA_MISMATCH: ${payload.schemaVersion}`);
  return {
    modelId: manifest.modelId,
    modelDigest: manifest.weightsDigest,
    tokenizerDigest: manifest.tokenizerDigest,
    verifiedAssets: Object.keys(manifest.assetDigests ?? {}).length,
    buildId: payload.buildId,
    capabilityHash: payload.capabilityHash,
    schemaVersion: Number(payload.schemaVersion),
  };
}

runGate("G1", "Graph-first return and durable enqueue", ["tests/knowledge-semantic-fire-and-forget.test.mjs"]);
runGate("G2-G3", "Atomic claims, parent detachment, crash kill and lease recovery", [
  "tests/knowledge-semantic-worker-leases.test.mjs",
  "tests/knowledge-semantic-supervisor.test.mjs",
]);
runGate("G4", "Pause, resume, retry, cancel and transport status parity", [
  "tests/knowledge-semantic-status-contract.test.mjs",
  "tests/knowledge-semantic-status-parity.test.mjs",
]);
runGate("G5-G6", "Fail-closed readiness, active generation integrity and supersession", [
  "tests/knowledge-embedding-lifecycle.test.mjs",
  "tests/knowledge-embedding-indexer.test.mjs",
  "tests/knowledge-search-engine.test.mjs",
]);
runGate("G7", "Fresh MCP-only cold start wakes queued semantic work", ["tests/mcp-semantic-cold-start.test.mjs"]);
runGate("G8", "Runtime upgrade, capability/schema parity and stable launchers", [
  "tests/knowledge-install-upgrade-test.mjs",
  "tests/mcp-generation-watch.test.mjs",
  "tests/knowledge-rust-pins.test.mjs",
]);
runGate("G9", "Bounded batches, fair scope scheduling, durable rate/ETA and WAL/log bounds", [
  "tests/knowledge-semantic-worker-performance.test.mjs",
  "tests/knowledge-storage-report.test.mjs",
]);
runGate("G10", "Graph default, Focus absent, Tauri status and controls", [
  "tests/knowledge-tauri-semantic-control.test.mjs",
  "tests/knowledge-wiki-semantic-status-ui.test.mjs",
  "tests/wiki-page.test.mjs",
]);

let bundle = null;
try {
  bundle = verifyBundle();
  gates.push({ id: "G11-source-bundle", description: "Self-contained native/model bundle integrity", passed: true, durationMs: 0 });
} catch (error) {
  gates.push({ id: "G11-source-bundle", description: "Self-contained native/model bundle integrity", passed: false, durationMs: 0, error: String(error?.stack ?? error) });
}

const output = {
  acceptance: "penguin-semantic-fire-and-forget",
  startedAt,
  finishedAt: new Date().toISOString(),
  passed: gates.every((gate) => gate.passed),
  bundle,
  gates,
  limitations: [
    "This disposable acceptance does not claim the user's full FPMS-NT generation is active.",
    "Installed DMG verification and two independent Round 21 MCP-only scores remain separate closure gates.",
  ],
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exitCode = output.passed ? 0 : 1;
