import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test("canary audit applies resource budgets and stops before the next root", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-canary-budget-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "canary.ts"), "export const BudgetNeedle = 1;\n");
  const second = join(dir, "missing-second-root");
  const budget = join(dir, "budget.json");
  writeFileSync(budget, JSON.stringify({ indexMs: 0, databaseBytes: 1, peakRssBytes: 1, databaseAmplificationRatio: 0 }));
  const result = spawnSync(process.execPath, ["scripts/knowledge-canary-audit.mjs", `--root=${dir},${second}`, "--limit=1", "--min-needles=1", `--budget=${budget}`], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  assert.equal(report.canaryCount, 1);
  assert.ok(report.canaries[0].budgetFailures.length > 0);
  assert.equal(report.canaries[0].root, dir);
});
