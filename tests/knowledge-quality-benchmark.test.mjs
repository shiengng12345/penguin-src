import assert from "node:assert/strict";
import { test } from "node:test";
import { runKnowledgeQualityBenchmark } from "../scripts/knowledge-quality-benchmark.mjs";

test("golden benchmark reports deterministic TP/FP/FN and lifecycle checks", async () => {
  const first = await runKnowledgeQualityBenchmark();
  const second = await runKnowledgeQualityBenchmark();
  assert.deepEqual(second, first, "same fixture must produce byte-stable metrics");

  for (const metric of Object.values(first.metrics)) {
    assert.equal(typeof metric.tp, "number");
    assert.equal(typeof metric.fp, "number");
    assert.equal(typeof metric.fn, "number");
    assert.ok(metric.precision >= 0.95, JSON.stringify(metric));
    assert.ok(metric.recall >= 0.90, JSON.stringify(metric));
  }
  assert.equal(first.checks.branchIsolation, true);
  assert.equal(first.checks.renameAlias, true);
  assert.equal(first.checks.deleteStale, true);
  assert.equal(first.passed, true, JSON.stringify(first));
});
