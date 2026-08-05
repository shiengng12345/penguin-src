import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIndexMode } from "../packages/knowledge-indexer/dist/index.js";

test("schema bump forces rebuild even when parser version matches", () => {
  assert.equal(resolveIndexMode("incremental", { parser_version: "p1", indexed_schema_version: 13 }, "p1", 14), "rebuild");
  assert.equal(resolveIndexMode("incremental", { parser_version: "p1", indexed_schema_version: 14 }, "p1", 14), "incremental");
  assert.equal(resolveIndexMode("incremental", { parser_version: "p0", indexed_schema_version: 14 }, "p1", 14), "rebuild");
  assert.equal(resolveIndexMode("rebuild", { parser_version: "p1", indexed_schema_version: 14 }, "p1", 14), "rebuild");
  // No prior branch row (first index) → incremental is fine; pipeline treats it as fresh anyway.
  assert.equal(resolveIndexMode("incremental", undefined, "p1", 14), "incremental");
});
