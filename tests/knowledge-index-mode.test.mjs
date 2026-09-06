import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIndexMode } from "../packages/knowledge-indexer/dist/index.js";
import { INDEX_FORMAT_VERSION, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

test("semantic-only database schema migration does not force a parser graph rebuild", () => {
  assert.equal(SCHEMA_VERSION, 18);
  assert.equal(INDEX_FORMAT_VERSION, 17);
  assert.equal(
    resolveIndexMode(
      "incremental",
      { parser_version: "p1", resolver_version: "r1", indexed_schema_version: 17 },
      "p1",
      INDEX_FORMAT_VERSION,
      "r1",
    ),
    "incremental",
  );
});

test("schema bump forces rebuild even when parser version matches", () => {
  assert.equal(resolveIndexMode("incremental", { parser_version: "p1", indexed_schema_version: 13 }, "p1", 14), "rebuild");
  assert.equal(resolveIndexMode("incremental", { parser_version: "p1", indexed_schema_version: 14 }, "p1", 14), "incremental");
  assert.equal(resolveIndexMode("incremental", { parser_version: "p0", indexed_schema_version: 14 }, "p1", 14), "rebuild");
  assert.equal(resolveIndexMode("rebuild", { parser_version: "p1", indexed_schema_version: 14 }, "p1", 14), "rebuild");
  // No prior branch row (first index) → incremental is fine; pipeline treats it as fresh anyway.
  assert.equal(resolveIndexMode("incremental", undefined, "p1", 14), "incremental");
});

// A resolver-only fix changes the EDGES derived from an unchanged parse. This
// rule was missing, so `penguin index` reported "0 parsed, 3333 skipped" and
// the fix never reached the real database — every test passed regardless.
test("resolver bump forces rebuild even when parser and schema match", () => {
  const at = (resolver) => ({ parser_version: "p1", resolver_version: resolver, indexed_schema_version: 14 });
  assert.equal(resolveIndexMode("incremental", at("r1"), "p1", 14, "r2"), "rebuild");
  assert.equal(resolveIndexMode("incremental", at("r2"), "p1", 14, "r2"), "incremental");
});

test("a branch indexed before the column existed rebuilds once", () => {
  // resolver_version reads null on such a branch. Rebuilding is the safe
  // direction: its edges came from an unknown resolver.
  const prior = { parser_version: "p1", resolver_version: null, indexed_schema_version: 14 };
  assert.equal(resolveIndexMode("incremental", prior, "p1", 14, "r2"), "rebuild");
});

test("omitting the resolver version leaves the decision unchanged", () => {
  // Callers that don't pass it (older embedders) must not start rebuilding on
  // every run just because the branch row has no resolver recorded.
  const prior = { parser_version: "p1", resolver_version: null, indexed_schema_version: 14 };
  assert.equal(resolveIndexMode("incremental", prior, "p1", 14), "incremental");
});
