import assert from "node:assert/strict";
import { test } from "node:test";

test("knowledge-core dist is importable", async () => {
  const mod = await import("../packages/knowledge-core/dist/index.js");
  assert.equal(mod.KNOWLEDGE_CORE_VERSION, "0.0.1");
});
