import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("universal retrieval benchmark produces independent recall and locator metrics", () => {
  const result = spawnSync(process.execPath, ["scripts/knowledge-universal-retrieval-benchmark.mjs", "--root=tests/fixtures/knowledge-universal-retrieval", "--limit=10"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exactRecall, 1);
  assert.equal(report.locatorAccuracy, 1);
  assert.equal(report.unexpectedVerifiedHits, 0);
});
