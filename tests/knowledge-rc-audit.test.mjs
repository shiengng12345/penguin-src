import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

test("RC2 audit rejects a reused fingerprint and records explicit blockers", () => {
  const env = { ...process.env, PENGUIN_SKIP_RC_GATE: "true" };
  assert.throws(() => execFileSync(process.execPath, ["scripts/knowledge-rc-audit.mjs", "--phase=RC2", "--id=rc-test"], { encoding: "utf8", env }), /Command failed/);
  const result = spawnSync(process.execPath, ["scripts/knowledge-rc-audit.mjs", "--phase=RC1", "--id=rc-test", "--out=/tmp/penguin-rc-test.json"], { encoding: "utf8", env });
  const report = JSON.parse(result.stdout);
  // Assert the RULE, not the state of whatever worktree happens to run this.
  // Hard-coding "dirty" made the suite pass only while uncommitted changes
  // existed and fail the moment the tree was clean — including on CI.
  assert.equal(
    report.blockers.includes("RC_SOURCE_DIRTY"),
    report.git.dirty,
    "RC_SOURCE_DIRTY must track the actual worktree state",
  );
  assert.equal(report.passed, report.blockers.length === 0);
  if (report.git.dirty) assert.equal(report.passed, false, "a dirty tree can never pass an RC audit");
  assert.match(report.capabilityHash, /^[a-f0-9]{64}$/);
});
