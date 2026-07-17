import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("canary audit stops on first failed root and reports deterministic recall evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-canary-"));
  mkdirSync(join(dir, "src"));
  const lines = Array.from({ length: 120 }, (_, i) => `export const CanaryNeedle${i} = ${i};`).join("\n");
  writeFileSync(join(dir, "src", "canary.ts"), lines);
  const out = execFileSync(process.execPath, ["scripts/knowledge-canary-audit.mjs", `--root=${dir}`, "--limit=100", "--min-needles=90"], { encoding: "utf8" });
  const report = JSON.parse(out);
  assert.equal(report.passed, true);
  assert.equal(report.canaryCount, 1);
  assert.ok(report.canaries[0].report.needleCount >= 90);
  assert.equal(report.canaries[0].report.exactRecall, 1);
});
