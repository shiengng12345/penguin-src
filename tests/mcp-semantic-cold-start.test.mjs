import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("a fresh MCP-only session wakes semantic work without blocking initialize", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-mcp-semantic-wake-"));
  const dbPath = join(directory, "knowledge.db");
  const wakeFile = join(directory, "wake-args");
  const launcher = join(directory, "penguin");
  writeFileSync(dbPath, "queued fixture marker");
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$*" > "${wakeFile}"\n`);
  chmodSync(launcher, 0o755);
  const child = spawn(process.execPath, ["packages/mcp/dist/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PENGUIN_KNOWLEDGE_DB: dbPath,
      PENGUIN_CLI_LAUNCHER: launcher,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  try {
    const startedAt = Date.now();
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cold-start-test", version: "1" } },
    })}\n`);
    const deadline = Date.now() + 2_000;
    while ((!stdout.includes('"id":1') || !existsSync(wakeFile)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(stdout, /"id":1/);
    assert.ok(Date.now() - startedAt < 2_000, "MCP initialize must not wait for semantic draining");
    assert.equal(existsSync(wakeFile), true);
    assert.equal(readFileSync(wakeFile, "utf8"), "semantic wake --json");
  } finally {
    child.kill("SIGTERM");
  }
});
