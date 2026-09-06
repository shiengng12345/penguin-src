import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const app = process.env.PENGUIN_APP_PATH ?? join(root, "src-tauri/target/release/bundle/macos/Penguin.app");

test("installed artifact exposes one complete runtime to two fresh MCP clients", { skip: !existsSync(app) }, () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/knowledge-release-bundle-gate.mjs")], {
    cwd: root,
    env: { ...process.env, PENGUIN_APP_PATH: app },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.embeddedCli.buildId, report.checks.launcherCli.buildId);
  assert.equal(report.checks.embeddedCli.capabilityHash, report.checks.launcherCli.capabilityHash);
  assert.equal(report.checks.embeddedMcp.health.runningBuildId, report.checks.launcherMcp.health.runningBuildId);
  assert.equal(report.checks.embeddedMcp.health.outdated, undefined);
  assert.equal(report.checks.embeddedMcp.modelHash, report.checks.launcherMcp.modelHash);
  assert.ok(report.checks.embeddedMcp.toolCount > 0);
  assert.ok(report.checks.launcherMcp.toolCount > 0);

  const dependencies = report.checks.tauriStartup.nativeDependencies;
  assert.deepEqual(dependencies.map((dependency) => dependency.name).sort(), [
    "better-sqlite3",
    "bundled-node",
    "embedding-model",
    "embedding-model-manifest",
    "embedding-tokenizer",
    "onnxruntime-node",
    "sharp",
    "sqlite-vec",
  ]);
  assert.ok(dependencies.every((dependency) => dependency.status === "ready" && /^[a-f0-9]{64}$/u.test(dependency.sha256)));
});
