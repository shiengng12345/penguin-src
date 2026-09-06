import assert from "node:assert/strict";
import { test } from "node:test";

import { mcpResultText } from "../packages/mcp/dist/result-text.js";

test("typed search failures are rendered as structured JSON instead of a zero-hit summary", () => {
  const value = {
    hits: [],
    returnedCount: 0,
    diagnostics: {
      queryStatus: "NO_MATCH_INCOMPLETE",
      searchedLanes: ["exact", "lexical"],
      skippedLanes: [{ lane: "semantic", reason: "no_active_space" }],
    },
    error: {
      code: "MODE_UNAVAILABLE",
      message: "semantic search has no active embedding generation for the resolved scope",
      retryable: false,
      details: { reason: "no_active_space" },
    },
  };

  const text = mcpResultText(value);
  const parsed = JSON.parse(text);
  assert.equal(parsed.error.code, "MODE_UNAVAILABLE");
  assert.equal(parsed.diagnostics.queryStatus, "NO_MATCH_INCOMPLETE");
  assert.deepEqual(parsed.diagnostics.skippedLanes, [{ lane: "semantic", reason: "no_active_space" }]);
});

test("successful search responses retain the compact human summary", () => {
  assert.equal(mcpResultText({ hits: [{ hitId: "h1" }], diagnostics: { searchedLanes: ["exact"] } }), "1 hits · lanes exact");
});
