import { test } from "node:test";
import assert from "node:assert/strict";
import { warning } from "../packages/knowledge-contracts/dist/index.js";

test("warning() builds a structured warning and omits empty data", () => {
  const w = warning("WORKTREE_DRIFT", "worktree differs from indexed fingerprint", { dirtyFiles: 3 });
  assert.deepEqual(w, {
    code: "WORKTREE_DRIFT",
    message: "worktree differs from indexed fingerprint",
    data: { dirtyFiles: 3 },
  });
  assert.deepEqual(warning("GIT_UNAVAILABLE", "no git"), { code: "GIT_UNAVAILABLE", message: "no git" });
});
