import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("knowledge baseline snapshot emits a reproducible JSON report", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/knowledge-baseline-snapshot.mjs", "--json"],
    { cwd: ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.capturedAt, "string");
  assert.equal(typeof report.git.branch, "string");
  assert.equal(typeof report.git.head, "string");
  assert.equal(typeof report.schemaVersion, "number");
  assert.ok(report.fixture.fileCount >= 6);
  assert.ok(report.fixture.needleCount >= 7);
  assert.deepEqual(report.knownMisses, []);
  assert.equal(report.tests.baseline.status, "passed");
  assert.equal(result.stdout.includes("/Users/"), false);
});
