import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

test("RC2 audit rejects a reused fingerprint and records explicit blockers", () => {
  const env = { ...process.env, PENGUIN_SKIP_RC_GATE: "true" };
  assert.throws(() => execFileSync(process.execPath, ["scripts/knowledge-rc-audit.mjs", "--phase=RC2", "--id=rc-test"], { encoding: "utf8", env }), /Command failed/);
  const result = spawnSync(process.execPath, ["scripts/knowledge-rc-audit.mjs", "--phase=RC1", "--id=rc-test", "--out=/tmp/penguin-rc-test.json"], { encoding: "utf8", env });
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false, "dirty source is correctly a release blocker in this worktree");
  assert.ok(report.blockers.includes("RC_SOURCE_DIRTY"));
  assert.match(report.capabilityHash, /^[a-f0-9]{64}$/);
});
