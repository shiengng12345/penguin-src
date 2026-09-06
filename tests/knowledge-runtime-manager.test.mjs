import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const launcher = join(root, "scripts/knowledge-cli-launcher.mjs");
const knowledgeSource = readFileSync(join(root, "src-tauri/src/knowledge.rs"), "utf8");
const libSource = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
const mcpSource = readFileSync(join(root, "src-tauri/src/mcp.rs"), "utf8");

function generation(root, id, marker) {
  const dir = join(root, id);
  mkdirSync(join(dir, "wasm"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "penguin.mjs"), marker);
  writeFileSync(join(dir, "node"), `#!/bin/sh\nprintf '%s\\n' ${marker} "$@"\n`);
  chmodSync(join(dir, "node"), 0o755);
  writeFileSync(join(dir, ".ready"), id);
  return dir;
}

function manifest(id) {
  return {
    schemaVersion: 1, ready: true, buildId: id, appVersion: "1.16.0",
    capabilityHash: "a".repeat(64), modelHash: "b".repeat(64), contractSchemaVersion: 18,
    contractVersion: "2", cliEntry: "penguin.mjs", mcpEntry: "mcp/dist/index.js",
    nodePath: "node", wasmPath: "wasm", createdAt: "test", fileHashes: {},
  };
}

test("activation switches only after a complete ready generation is available", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-runtime-manager-"));
  const first = generation(runtimeRoot, "build-a", "A");
  generation(runtimeRoot, "build-b", "B");
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify(manifest("build-a")));
  symlinkSync(first, join(runtimeRoot, "current"));

  const before = spawnSync(process.execPath, [launcher, "status"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimeRoot }, encoding: "utf8",
  });
  assert.equal(before.status, 0);
  assert.match(before.stdout, /^A\n/);

  const current = join(runtimeRoot, "current");
  const tmp = join(runtimeRoot, ".current-test");
  symlinkSync(join(runtimeRoot, "build-b"), tmp);
  // This is the same atomic publication primitive used by the Rust manager.
  // The old pointer remains untouched until rename succeeds.
  renameSync(tmp, current);
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify(manifest("build-b")));
  const after = spawnSync(process.execPath, [launcher, "status"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimeRoot }, encoding: "utf8",
  });
  assert.equal(after.status, 0);
  assert.match(after.stdout, /^B\n/);
  assert.equal(JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")).buildId, "build-b");
});

test("a malformed active generation is never repaired by selecting another build", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-runtime-invalid-"));
  const first = generation(runtimeRoot, "build-a", "A");
  generation(runtimeRoot, "build-b", "B");
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify({ ...manifest("build-a"), ready: false }));
  symlinkSync(first, join(runtimeRoot, "current"));
  const result = spawnSync(process.execPath, [launcher], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimeRoot }, encoding: "utf8",
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /RUNTIME_MANIFEST_INVALID/);
});

test("Tauri exposes runtime sync health and restart commands", () => {
  for (const command of ["knowledge_runtime_sync", "knowledge_runtime_health", "knowledge_runtime_restart_required"]) {
    assert.match(knowledgeSource, new RegExp("fn " + command), command + " must be implemented in the Tauri knowledge bridge");
    assert.match(libSource, new RegExp("knowledge::" + command), command + " must be registered with Tauri");
  }
});

test("Tauri startup, CLI install, and MCP generation install share the versioned manager", () => {
  assert.match(knowledgeSource, /KnowledgeRuntimeManager/);
  assert.match(knowledgeSource, /install_bundled_knowledge_runtime_from_bundles/);
  assert.match(knowledgeSource, /runtime_root\(\)/);
  assert.match(mcpSource, /knowledge_runtime_sync|KnowledgeRuntimeManager|current/);
});
