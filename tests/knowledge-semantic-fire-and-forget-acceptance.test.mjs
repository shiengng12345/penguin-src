import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("semantic fire-and-forget acceptance covers every source/package gate", { timeout: 180_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/knowledge-semantic-fire-and-forget-acceptance.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.deepEqual(report.gates.map((gate) => gate.id), [
    "G1", "G2-G3", "G4", "G5-G6", "G7", "G8", "G9", "G10", "G11-source-bundle",
  ]);
  assert.ok(report.gates.every((gate) => gate.passed));
  assert.equal(report.bundle.schemaVersion, 18);
  assert.match(report.bundle.capabilityHash, /^[a-f0-9]{64}$/u);
  assert.equal(report.bundle.verifiedAssets, 5);
});
