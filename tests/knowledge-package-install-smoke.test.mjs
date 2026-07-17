import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("built knowledge packages and surface parity are install-smoke ready", () => {
  const result = spawnSync(process.execPath, ["scripts/knowledge-package-install-smoke.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.results.every((entry) => entry.exists));
  assert.equal(report.parityExitCode, 0);
});
