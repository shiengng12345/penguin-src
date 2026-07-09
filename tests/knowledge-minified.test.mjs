import assert from "node:assert/strict";
import { test } from "node:test";
import { isLikelyMinified } from "../packages/knowledge-indexer/dist/index.js";

test("isLikelyMinified: hand-written source is not flagged", () => {
  const src = Array.from({ length: 200 }, (_, i) => `  const x${i} = doThing(${i});`).join("\n");
  assert.equal(isLikelyMinified(src), false);
});
test("isLikelyMinified: packed single-line bundle is flagged", () => {
  const src = "!function(){var n=1,a=2,i=3;".padEnd(6000, "x") + "}();";
  assert.equal(isLikelyMinified(src), true);
});
test("isLikelyMinified: small files are never flagged", () => {
  assert.equal(isLikelyMinified("const a=1;".repeat(50)), false);
});
