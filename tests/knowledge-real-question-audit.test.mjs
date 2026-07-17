import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("real-question release audit fails closed for the intentionally incomplete sample corpus", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-real-question-audit-"));
  const input = join(dir, "incomplete.jsonl");
  writeFileSync(input, JSON.stringify({ id: "RQ-test", category: "exact_path", question: "test", scope: {}, gold: { requiredLocators: [], requiredFacts: [] } }) + "\n");
  const result = spawnSync(process.execPath, ["scripts/knowledge-real-question-audit.mjs", `--input=${input}`, "--gate"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  assert.ok(report.evidence.some((item) => item.code === "REAL_QUESTION_CATEGORY_SHORT"));
});

test("generated 110-question corpus passes category/review/baseline audit", () => {
  const result = spawnSync(process.execPath, ["scripts/knowledge-real-question-audit.mjs", "--input=docs/knowledge-v2/real-question-corpus.jsonl", "--gate"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.questionCount, 110);
  assert.equal(report.passed, true);
});
