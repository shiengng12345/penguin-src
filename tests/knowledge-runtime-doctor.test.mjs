import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyMcpDuplicate,
  inspectConfiguredClaudeDuplicates,
  inspectConfiguredCodexDuplicates,
  inspectConfiguredCodexRuntime,
  inspectKnowledgeRuntime,
  readClaudeMcpTargets,
  validateRuntimeManifest,
} from "../scripts/check-knowledge-runtime.mjs";

test("runtime doctor classifies legacy aliases by target and tool surface", () => {
  const canonical = {
    name: "penguin",
    command: "/Users/u/.penguin/mcp/node",
    server: "/Users/u/.penguin/mcp/dist/index.js",
  };
  assert.equal(
    classifyMcpDuplicate(canonical, {
      name: "pengvi",
      command: canonical.command,
      server: canonical.server,
    }).classification,
    "legacy_alias_same_target",
  );

  const sameSurface = classifyMcpDuplicate(
    canonical,
    {
      name: "pengvi",
      command: "/Users/u/.nvm/node",
      server: "/Users/u/Desktop/Pengvi/packages/mcp/dist/index.js",
    },
    {
      canonical: {
        serverName: "penguin-mcp",
        tools: ["index_status", "knowledge_explore"],
      },
      legacy: {
        serverName: "penguin-mcp",
        tools: ["knowledge_explore", "index_status"],
      },
    },
  );
  assert.equal(sameSurface.classification, "legacy_alias_same_surface");
  assert.equal(sameSurface.safeToMigrate, true);
});

test("runtime doctor preserves ambiguous name collisions without leaking config", () => {
  const result = classifyMcpDuplicate(
    {
      name: "penguin",
      command: "/Users/u/.penguin/mcp/node",
      server: "/Users/u/.penguin/mcp/dist/index.js",
    },
    {
      name: "pengvi",
      command: "/opt/custom/server",
      server: "serve",
    },
  );
  assert.equal(result.classification, "name_collision");
  assert.equal(result.safeToMigrate, false);
  assert.deepEqual(Object.keys(result).sort(), [
    "classification",
    "name",
    "reason",
    "safeToMigrate",
  ]);
});

test("runtime doctor reads only canonical and legacy Claude targets", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-claude-config-"));
  const configPath = join(root, ".claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      oauthAccount: { accessToken: "must-not-appear" },
      mcpServers: {
        unrelated: { command: "other", env: { SECRET: "must-not-appear" } },
        penguin: { command: "/u/.penguin/mcp/node", args: ["/u/.penguin/mcp/dist/index.js"] },
        pengvi: { command: "/u/old/node", args: ["/u/Pengvi/packages/mcp/dist/index.js"] },
      },
    }),
  );
  const targets = readClaudeMcpTargets(configPath);
  assert.deepEqual(targets, {
    penguin: {
      name: "penguin",
      command: "/u/.penguin/mcp/node",
      server: "/u/.penguin/mcp/dist/index.js",
    },
    pengvi: {
      name: "pengvi",
      command: "/u/old/node",
      server: "/u/Pengvi/packages/mcp/dist/index.js",
    },
  });
  assert.equal(JSON.stringify(targets).includes("must-not-appear"), false);
  rmSync(root, { recursive: true, force: true });
});

test("runtime doctor reports a same-target Claude duplicate without launching it", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-claude-duplicate-"));
  const configPath = join(root, ".claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        penguin: { command: "/missing/node", args: ["/missing/server.js"] },
        pengvi: { command: "/missing/node", args: ["/missing/server.js"] },
      },
    }),
  );
  const result = await inspectConfiguredClaudeDuplicates({
    configPath,
    smoke: true,
    timeoutMs: 50,
  });
  assert.equal(result.classification, "legacy_alias_same_target");
  assert.equal(result.safeToMigrate, true);
  rmSync(root, { recursive: true, force: true });
});

test("runtime doctor reports a same-target Codex duplicate without launching it", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-codex-duplicate-"));
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[mcp_servers.penguin]\ncommand = "/missing/node"\nargs = ["/missing/server.js"]\n\n[mcp_servers.pengvi]\ncommand = "/missing/node"\nargs = ["/missing/server.js"]\n`,
  );
  const result = await inspectConfiguredCodexDuplicates({
    configPath,
    smoke: true,
    timeoutMs: 50,
  });
  assert.equal(result.classification, "legacy_alias_same_target");
  assert.equal(result.safeToMigrate, true);
  rmSync(root, { recursive: true, force: true });
});

test("runtime manifest rejects mismatched native ABI", () => {
  const result = validateRuntimeManifest({
    nodeVersion: "v24.0.0",
    nodeAbi: 137,
    nativeAbi: 127,
    nativeLoaded: false,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "native_abi_mismatch");
});

test("runtime doctor classifies a missing vendored node", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-missing-"));
  const result = await inspectKnowledgeRuntime({
    nodePath: join(root, "node"),
    serverPath: join(root, "dist", "index.js"),
    modulePath: join(root, "node_modules"),
    smoke: false,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "node_missing");
  rmSync(root, { recursive: true, force: true });
});

test("runtime doctor performs initialize, tools/list, and knowledge tool smoke", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-smoke-"));
  const dist = join(root, "dist");
  const modules = join(root, "node_modules", "better-sqlite3");
  mkdirSync(dist, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  const nodePath = join(root, "node");
  writeFileSync(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(nodePath, 0o755);
  writeFileSync(
    join(modules, "index.js"),
    "module.exports = function Database() { this.close = function () {}; };\n",
  );
  writeFileSync(
    join(dist, "index.js"),
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "penguin-mcp", version: "test" } } }));
  } else if (req.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "penguin_index_status" }] } }));
  } else if (req.method === "tools/call") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "ok" }] } }));
  }
});
`,
  );

  const result = await inspectKnowledgeRuntime({
    nodePath,
    serverPath: join(dist, "index.js"),
    modulePath: join(root, "node_modules"),
    smoke: true,
    timeoutMs: 2_000,
  });
  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.smoke?.serverName, "penguin-mcp");
  assert.ok(result.smoke?.tools.includes("penguin_index_status"));
  assert.equal(result.smoke?.knowledgeTool, "penguin_index_status");
  rmSync(root, { recursive: true, force: true });
});

test("runtime doctor validates the Penguin runtime configured in Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-configured-"));
  const stableRoot = join(root, ".penguin", "mcp");
  const dist = join(stableRoot, "dist");
  const modules = join(stableRoot, "node_modules", "better-sqlite3");
  mkdirSync(dist, { recursive: true });
  mkdirSync(modules, { recursive: true });
  const nodePath = join(stableRoot, "node");
  writeFileSync(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(nodePath, 0o755);
  writeFileSync(join(modules, "index.js"), "module.exports = function Database() { this.close = function () {}; };\n");
  writeFileSync(join(dist, "index.js"), "process.exit(0);\n");

  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[mcp_servers.unrelated.env]\nSECRET = "must-not-appear"\n\n[mcp_servers.penguin]\ncommand = "${nodePath}"\nargs = ["${join(dist, "index.js")}"]\n`,
  );

  const result = await inspectConfiguredCodexRuntime({ configPath, smoke: false });
  assert.equal(result.configured, true);
  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.nodePath, nodePath);
  assert.equal(result.serverPath, join(dist, "index.js"));
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
  rmSync(root, { recursive: true, force: true });
});

test("runtime doctor reports when Codex points Penguin at a missing runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-configured-missing-"));
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[mcp_servers.penguin]\ncommand = "${join(root, "missing-node")}"\nargs = ["${join(root, "missing-server.js")}"]\n`,
  );

  const result = await inspectConfiguredCodexRuntime({ configPath, smoke: false });
  assert.equal(result.configured, true);
  assert.equal(result.healthy, false);
  assert.equal(result.code, "node_missing");
  rmSync(root, { recursive: true, force: true });
});

test("runtime doctor rejects an MCP knowledge tool result marked as an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-runtime-tool-error-"));
  const dist = join(root, "dist");
  const modules = join(root, "node_modules", "better-sqlite3");
  mkdirSync(dist, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  const nodePath = join(root, "node");
  writeFileSync(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(nodePath, 0o755);
  writeFileSync(join(modules, "index.js"), "module.exports = function Database() { this.close = function () {}; };\n");
  writeFileSync(
    join(dist, "index.js"),
    `import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "penguin-mcp", version: "test" } } }));
  }
  if (request.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "index_status" }] } }));
  }
  if (request.method === "tools/call") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "schema mismatch" }] } }));
  }
});
`,
  );

  const result = await inspectKnowledgeRuntime({
    nodePath,
    serverPath: join(dist, "index.js"),
    modulePath: join(root, "node_modules"),
    smoke: true,
    timeoutMs: 2_000,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "knowledge_tool_failed");
  assert.equal(result.smoke?.error, "schema mismatch");
  rmSync(root, { recursive: true, force: true });
});
