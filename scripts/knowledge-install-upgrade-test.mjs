#!/usr/bin/env node
/*
 * Process-level upgrade gate for the stable CLI/MCP launchers.
 * This deliberately uses a temporary HOME and the real bundled MCP entrypoint;
 * no user database, credentials, or source files are touched.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const tempHome = resolve(tmpdir(), `penguin-upgrade-${process.pid}-${Date.now()}`);
const spawned = [];
const runtimeRoot = join(tempHome, ".penguin", "runtimes");
const mcpManifest = join(tempHome, ".penguin", "mcp", "manifest.json");
const launcher = resolve(root, "scripts/knowledge-mcp-launcher.mjs");
const cliLauncher = resolve(root, "scripts/knowledge-cli-launcher.mjs");
const cliBundle = resolve(root, "packages/knowledge-cli/bundle");
const mcpBundle = resolve(root, "packages/mcp/bundle");
const report = process.env.PENGUIN_INSTALL_UPGRADE_REPORT ?? resolve(root, ".superpowers/sdd/2026-08-30-penguin-round13-runtime-sync-complete-fix/task-10-upgrade-evidence.md");
const OUTDATED_RUNTIME = "OUTDATED_RUNTIME";

function manifest(buildId) {
  return { schemaVersion: 1, ready: true, buildId, appVersion: buildId, capabilityHash: "a".repeat(64), contractSchemaVersion: 18, contractVersion: "2", modelHash: "b".repeat(64), cliEntry: "penguin.mjs", mcpEntry: "mcp/dist/index.js", nodePath: "node", wasmPath: "wasm" };
}
function installGeneration(buildId) {
  const dir = join(runtimeRoot, buildId);
  mkdirSync(dir, { recursive: true });
  cpSync(join(cliBundle, "node"), join(dir, "node"));
  cpSync(join(cliBundle, "penguin.mjs"), join(dir, "penguin.mjs"));
  cpSync(join(cliBundle, "wasm"), join(dir, "wasm"), { recursive: true });
  cpSync(mcpBundle, join(dir, "mcp"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(buildId)));
  writeFileSync(join(dir, ".ready"), buildId);
  return dir;
}
function activate(buildId) {
  const pointer = join(runtimeRoot, "current");
  const temp = join(runtimeRoot, `.current-${buildId}`);
  try { symlinkSync(join(runtimeRoot, buildId), temp); } catch (error) { throw new Error(`cannot stage current pointer: ${error.message}`); }
  // The test directory is new, so there is no need to remove an existing
  // pointer; rename is still used to mirror the manager's atomic operation.
  renameSync(temp, pointer);
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify(manifest(buildId)));
  mkdirSync(join(tempHome, ".penguin", "mcp"), { recursive: true });
  writeFileSync(mcpManifest, JSON.stringify({ buildId, appVersion: buildId, syncedAt: new Date().toISOString() }));
}
function startMcp() {
  const child = spawn(process.execPath, [launcher], { cwd: root, env: { ...process.env, HOME: tempHome, PENGUIN_RUNTIME_ROOT: runtimeRoot }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  spawned.push(child);
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => { try { lines.push(JSON.parse(line)); } catch { /* SDK logs are not protocol JSON */ } });
  const request = (id, method, params = {}) => new Promise((resolveRequest, reject) => {
    const deadline = setTimeout(() => reject(new Error(`MCP request ${method} timed out\n${child.stderr.read()?.toString() ?? ""}`)), 10_000);
    const poll = () => {
      const found = lines.find((value) => value.id === id);
      if (found) { clearTimeout(deadline); resolveRequest(found); return; }
      if (child.exitCode != null) { clearTimeout(deadline); reject(new Error(`MCP exited ${child.exitCode}`)); return; }
      setTimeout(poll, 10);
    };
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    poll();
  });
  return { child, request };
}

function parseLastJson(stdout) {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep walking upward until the real JSON payload is found.
    }
  }
  return JSON.parse(stdout);
}

function toolPayload(response) {
  if (response?.result?.structuredContent && typeof response.result.structuredContent === "object") {
    return response.result.structuredContent;
  }
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

function currentRuntimePath() {
  return realpathSync(join(runtimeRoot, "current"));
}

function generationRuntimePath(buildId) {
  return realpathSync(join(runtimeRoot, buildId));
}

function cliCapabilities() {
  const result = spawnSync(process.execPath, [cliLauncher, "capabilities", "--json"], {
    cwd: root,
    env: { ...process.env, HOME: tempHome, PENGUIN_RUNTIME_ROOT: runtimeRoot },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`CLI capability probe failed: ${result.stderr || result.stdout}`);
  }
  const payload = parseLastJson(result.stdout);
  if (!payload?.buildId || !payload?.capabilityHash) {
    throw new Error(`CLI capability probe returned no identity payload: ${readFileSync(mcpManifest, "utf8")}`);
  }
  return payload;
}

const evidence = { started: new Date().toISOString(), tempHome, runtimeRoot, launcher, sessions: [] };
try {
  assert.ok(existsSync(cliBundle) && existsSync(mcpBundle), "build bundles are required");
  mkdirSync(runtimeRoot, { recursive: true });
  installGeneration("runtime-A");
  activate("runtime-A");
  const runtimePathBeforeUpgrade = currentRuntimePath();
  const session = startMcp();
  const initialized = await session.request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "upgrade-test", version: "1" } });
  session.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const first = await session.request(2, "tools/call", { name: "mcp_health", arguments: {} });
  const firstText = JSON.parse(first.result.content[0].text);
  assert.equal(firstText.status, "ok");
  assert.equal(firstText.serverGeneration.runningBuildId, "runtime-A");
  const capabilities = await session.request(20, "tools/call", { name: "knowledge_capabilities", arguments: {} });
  const firstCapabilities = toolPayload(capabilities);
  assert.ok(capabilities.result, "knowledge_capabilities must be callable in a fresh MCP process");
  assert.equal(firstCapabilities?.buildId, "runtime-A");
  const nodeId = firstCapabilities?.capabilities?.[0]?.id ?? "runtime-A";
  installGeneration("runtime-B");
  activate("runtime-B");
  const runtimePathAfterUpgrade = currentRuntimePath();
  assert.equal(runtimePathAfterUpgrade, generationRuntimePath("runtime-B"));
  assert.notEqual(runtimePathAfterUpgrade, runtimePathBeforeUpgrade);
  const oldSessionHealth = await session.request(3, "tools/call", { name: "mcp_health", arguments: {} });
  const oldText = JSON.parse(oldSessionHealth.result.content[0].text);
  assert.equal(oldText.status, "outdated", OUTDATED_RUNTIME);
  assert.equal(oldText.serverGeneration.availableBuildId, "runtime-B");
  assert.match(String(oldText.serverGeneration.action), /restart/i);
  assert.equal(oldSessionHealth.result._meta["penguin/serverOutdated"], true);
  assert.equal(oldSessionHealth.result.error.code, OUTDATED_RUNTIME);
  assert.equal(oldSessionHealth.result.action, "restart_mcp_session");
  session.child.kill("SIGTERM");
  await new Promise((resolveExit) => session.child.once("exit", resolveExit));
  const newSession = startMcp();
  await newSession.request(10, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "upgrade-test-new", version: "1" } });
  newSession.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const newHealth = await newSession.request(11, "tools/call", { name: "mcp_health", arguments: {} });
  const newText = JSON.parse(newHealth.result.content[0].text);
  const newCapabilitiesResponse = await newSession.request(12, "tools/call", { name: "knowledge_capabilities", arguments: {} });
  const newCapabilities = toolPayload(newCapabilitiesResponse);
  const cliAfterUpgrade = cliCapabilities();
  assert.equal(newText.status, "ok");
  assert.equal(newText.serverGeneration.runningBuildId, "runtime-B");
  assert.equal(newCapabilities?.buildId, "runtime-B");
  assert.equal(cliAfterUpgrade.buildId, "runtime-B");
  assert.equal(cliAfterUpgrade.capabilityHash, newCapabilities?.capabilityHash);
  assert.equal(currentRuntimePath(), generationRuntimePath("runtime-B"));
  evidence.sessions.push({
    nodeId,
    old: {
      initialized: Boolean(initialized.result),
      selectedRuntimePath: runtimePathBeforeUpgrade,
      runningBuildId: firstText.serverGeneration.runningBuildId,
      capabilityHash: firstCapabilities?.capabilityHash ?? null,
      afterUpgrade: oldText.serverGeneration,
      outdatedContract: {
        meta: oldSessionHealth.result._meta["penguin/serverOutdated"],
        errorCode: oldSessionHealth.result.error.code,
        action: oldSessionHealth.result.action,
      },
    },
    fresh: {
      runningBuildId: newText.serverGeneration.runningBuildId,
      status: newText.status,
      selectedRuntimePath: currentRuntimePath(),
      cli: {
        buildId: cliAfterUpgrade.buildId,
        capabilityHash: cliAfterUpgrade.capabilityHash,
        schemaVersion: cliAfterUpgrade.schemaVersion ?? null,
      },
      mcp: {
        buildId: newCapabilities?.buildId ?? null,
        capabilityHash: newCapabilities?.capabilityHash ?? null,
        schemaVersion: newCapabilities?.schemaVersion ?? null,
      },
    },
    reconfigure: {
      manifestBuildId: JSON.parse(readFileSync(mcpManifest, "utf8")).buildId,
      currentRuntimePathBeforeUpgrade: runtimePathBeforeUpgrade,
      currentRuntimePathAfterUpgrade: runtimePathAfterUpgrade,
    },
    stableLauncher: launcher,
  });
  newSession.child.kill("SIGTERM");
  await new Promise((resolveExit) => newSession.child.once("exit", resolveExit));
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  // A failed assertion skips the SIGTERM calls above, which would leave MCP
  // processes running out of tempHome and the temp home itself on disk.
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  rmSync(tempHome, { recursive: true, force: true });
}
mkdirSync(resolve(report, ".."), { recursive: true });
writeFileSync(report, `# Knowledge runtime upgrade evidence\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`);
console.log(JSON.stringify({ report, ok: evidence.ok, stableLauncher: launcher, runtimeRoot }));
