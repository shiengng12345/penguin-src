import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

test("shadow weekly review reports category breakdown and blockers", () => {
  const raw = execFileSync(process.execPath, ["scripts/knowledge-shadow-weekly-review.mjs", "docs/knowledge-v2/real-question-differential-report.json"], { encoding: "utf8" });
  const report = JSON.parse(raw);
  assert.equal(report.questionCount, 110);
  assert.ok(Object.keys(report.categoryReview).length >= 5);
  assert.equal(report.blockingExternalOnlyCorrect, 0);
  assert.deepEqual(report.honestGaps.codegraph, []);
});
