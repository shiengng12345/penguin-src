import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callPenguinMcpTool, parseMcpStructuredResult } from "../scripts/penguin-mcp-client.mjs";

test("MCP client invokes a knowledge tool through stdio JSON-RPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-mcp-client-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  const nodePath = join(root, "node");
  writeFileSync(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(nodePath, 0o755);
  const serverPath = join(dist, "index.js");
  writeFileSync(
    serverPath,
    `import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "penguin-mcp", version: "test" } } }));
  }
  if (request.method === "tools/call") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ name: request.params.name, args: request.params.arguments }) }] } }));
  }
});
`,
  );

  const result = await callPenguinMcpTool({
    nodePath,
    serverPath,
    toolName: "explore_graph",
    arguments: { mode: "calls_of", node: "checkBlacklist" },
    timeoutMs: 2_000,
  });

  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.toolName, "explore_graph");
  assert.deepEqual(JSON.parse(result.content[0].text), {
    name: "explore_graph",
    args: { mode: "calls_of", node: "checkBlacklist" },
  });
  rmSync(root, { recursive: true, force: true });
});

test("MCP client result parser prefers structuredContent and rejects summaries", () => {
  assert.deepEqual(
    parseMcpStructuredResult({
      healthy: true,
      isError: false,
      structuredContent: { nodes: [{ title: "node" }] },
      content: [{ type: "text", text: "1 hit · lanes source" }],
    }),
    { nodes: [{ title: "node" }] },
  );
  assert.throws(
    () => parseMcpStructuredResult({ healthy: true, isError: false, content: [{ type: "text", text: "1 hit · lanes source" }] }),
    /structured JSON content/,
  );
});
