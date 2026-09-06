import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("CLI and MCP semantic surfaces are required to use the shared persisted hybrid engine", () => {
  // The transport parity gate is intentionally source-based here; the real
  // CLI/MCP process harness exercises the same compiled package in release
  // tests. A transport must not reintroduce semanticSearch's document scan.
  const cli = readFileSync("packages/knowledge-cli/src/command-dispatch.ts", "utf8");
  const mcp = readFileSync("packages/mcp/src/knowledge-tools.ts", "utf8");
  assert.doesNotMatch(cli, /semanticSearch\(/);
  assert.doesNotMatch(mcp, /semanticSearch\(/);
  assert.match(cli, /openBundledEmbeddingProvider/);
  assert.match(mcp, /openBundledEmbeddingProvider/);
  assert.match(cli, /semanticProvider/);
  assert.match(mcp, /semanticProvider/);
  assert.match(cli, /resolveBundledEmbeddingSpaceIdentity/);
  assert.match(mcp, /resolveBundledEmbeddingSpaceIdentity/);
  assert.match(cli, /ensureSemanticWorker/);
  assert.match(mcp, /semantic", "wake/);
});
