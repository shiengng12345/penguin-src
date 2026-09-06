import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

function callHealthTwice() {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health-identity-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_health", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_health", arguments: {} } },
  ];
  const result = spawnSync(process.execPath, [resolve("packages/mcp/dist/index.js")], {
    input: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const frames = result.stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return [2, 3].map((id) => {
    const frame = frames.find((candidate) => candidate.id === id);
    assert.ok(frame?.result?.content?.[0]?.text, result.stdout);
    return JSON.parse(frame.result.content[0].text);
  });
}

function listHealthTool() {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health-annotation-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = spawnSync(process.execPath, [resolve("packages/mcp/dist/index.js")], {
    input: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const frames = result.stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const frame = frames.find((candidate) => candidate.id === 2);
  const tool = frame?.result?.tools?.find((candidate) => candidate.name === "mcp_health");
  assert.ok(tool, result.stdout);
  return tool;
}

test("mcp_health exposes stable fresh-session identity and server clock", () => {
  const [first, second] = callHealthTwice();
  assert.equal(first.configured, true);
  assert.equal(typeof first.launcherHealthy, "boolean");
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.clientConnectedAt, first.clientConnectedAt);
  assert.ok(Number.isFinite(Date.parse(first.clientConnectedAt)));
  assert.ok(Number.isFinite(Date.parse(first.serverTimeUtc)));
  assert.ok(Date.parse(second.serverTimeUtc) >= Date.parse(first.serverTimeUtc));
  assert.equal(first.cursorTtlSeconds, 900);
});

test("mcp_health is advertised as safe read-only and idempotent", () => {
  const tool = listHealthTool();
  assert.deepEqual(tool.annotations, {
    title: "Penguin MCP health",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});
