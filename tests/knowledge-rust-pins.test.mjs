import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CAPABILITIES, capabilityHash } from "../packages/knowledge-contracts/dist/index.js";
import { SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

// Phase 1B closing carryover #11's most dangerous half: src-tauri/src/knowledge.rs
// hand-pins EXPECTED_CAPABILITY_HASH (the resident query-server handshake gate)
// and packages/mcp/src/index.ts hand-pins schemaVersion (kept literal on purpose
// so the release-bundled MCP server has no knowledge-core/native dep). Neither
// value is imported from the contracts/core packages at build time, so nothing
// short of a test catches one side drifting after CAPABILITIES or SCHEMA_VERSION
// changes. These two tests extract the hand-synced literal via regex and assert
// it still matches the canonical source of truth.

test("src-tauri EXPECTED_CAPABILITY_HASH matches capabilityHash(CAPABILITIES)", async () => {
  const source = await readFile(new URL("../src-tauri/src/knowledge.rs", import.meta.url), "utf8");
  const match = source.match(/const EXPECTED_CAPABILITY_HASH: &str = "([0-9a-f]{64})";/);
  assert.ok(match, "EXPECTED_CAPABILITY_HASH constant not found in src-tauri/src/knowledge.rs");
  assert.equal(
    match[1],
    capabilityHash(CAPABILITIES),
    "src-tauri's EXPECTED_CAPABILITY_HASH is stale — recompute with " +
      "`node -e \"const c = require('./packages/knowledge-contracts/dist/index.js'); console.log(c.capabilityHash(c.CAPABILITIES))\"` " +
      "and update the constant",
  );
});

test("packages/mcp/src/index.ts schemaVersion literal matches knowledge-core's SCHEMA_VERSION", async () => {
  const source = await readFile(new URL("../packages/mcp/src/index.ts", import.meta.url), "utf8");
  const match = source.match(/schemaVersion:\s*(\d+)/);
  assert.ok(match, "hand-synced schemaVersion literal not found in packages/mcp/src/index.ts");
  assert.equal(
    Number(match[1]),
    SCHEMA_VERSION,
    "packages/mcp/src/index.ts's hand-synced schemaVersion literal is stale — " +
      "update it to match SCHEMA_VERSION in packages/knowledge-core/src/schema.ts",
  );
});
