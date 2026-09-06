import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);

test("hybrid benchmark freezes 200 questions and all required scenario classes", async () => {
  const result = await run(process.execPath, ["scripts/knowledge-hybrid-benchmark.mjs"]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.questionCount, 200);
  assert.equal(report.corpus.passed, true);
  assert.deepEqual(Object.values(report.categoryCounts), Array(10).fill(20));
  assert.equal(report.consumerBoundary, "consumer_mcp_only");
});

test("hybrid benchmark runs real local inference and enforces quality and latency gates", { timeout: 180_000 }, async () => {
  const result = await run(process.execPath, ["scripts/knowledge-hybrid-benchmark.mjs", "--gate"], { timeout: 170_000 });
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "PASS");
  assert.equal(report.quality.realInference, true);
  assert.equal(report.quality.semantic.questions, 20);
  assert.ok(report.quality.semantic.recallAt5 >= 0.9, JSON.stringify(report.quality.semantic));
  assert.ok(report.quality.semantic.mrr >= 0.65, JSON.stringify(report.quality.semantic));
  assert.equal(report.quality.deterministic.passed, true);
  assert.ok(report.latency.coldStartMs > 0);
  assert.ok(report.latency.queryP95Ms > 0);
  assert.equal(report.network.runtimeDownloadsAllowed, false);
});
