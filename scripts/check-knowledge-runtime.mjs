#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 5_000;
const KNOWLEDGE_STATUS_TOOLS = ["index_status", "penguin_index_status"];

function normalizedTarget(target) {
  if (!target) return null;
  return {
    command: String(target.command ?? "").trim(),
    server: String(target.server ?? "").trim(),
  };
}

function normalizedSurface(probe) {
  if (!probe || probe.serverName !== "penguin-mcp" || !Array.isArray(probe.tools)) {
    return null;
  }
  return [...new Set(probe.tools.map(String))].sort();
}

export function classifyMcpDuplicate(canonical, legacy, probes = {}) {
  if (!legacy) {
    return {
      name: "pengvi",
      classification: "none",
      safeToMigrate: false,
      reason: "legacy alias is not configured",
    };
  }
  const canonicalTarget = normalizedTarget(canonical);
  const legacyTarget = normalizedTarget(legacy);
  if (
    canonicalTarget
    && legacyTarget
    && canonicalTarget.command === legacyTarget.command
    && canonicalTarget.server === legacyTarget.server
  ) {
    return {
      name: String(legacy.name ?? "pengvi"),
      classification: "legacy_alias_same_target",
      safeToMigrate: true,
      reason: "legacy alias points to the canonical command and server",
    };
  }
  const canonicalSurface = normalizedSurface(probes.canonical);
  const legacySurface = normalizedSurface(probes.legacy);
  if (
    canonicalSurface
    && legacySurface
    && JSON.stringify(canonicalSurface) === JSON.stringify(legacySurface)
  ) {
    return {
      name: String(legacy.name ?? "pengvi"),
      classification: "legacy_alias_same_surface",
      safeToMigrate: true,
      reason: "legacy alias exposes the canonical penguin-mcp tool surface",
    };
  }
  return {
    name: String(legacy.name ?? "pengvi"),
    classification: "name_collision",
    safeToMigrate: false,
    reason: "legacy name exists but ownership could not be proven",
  };
}

// Turn the runtime probe into one stable result code that CI and the desktop
// installer can act on without scraping a native-module stack trace.
export function validateRuntimeManifest(manifest) {
  const abiKnown = Number.isInteger(manifest.nativeAbi);
  const abiMismatch = abiKnown && manifest.nodeAbi !== manifest.nativeAbi;
  if (abiMismatch) {
    return { healthy: false, code: "native_abi_mismatch" };
  }
  if (!manifest.nativeLoaded) {
    return { healthy: false, code: "native_load_failed" };
  }
  return { healthy: true, code: "ok" };
}

// Run a tiny process under the exact Node binary and NODE_PATH that the MCP
// configuration will use. Constructing an in-memory DB forces the native addon
// to load, which is stronger than checking that better_sqlite3.node exists.
function probeNativeRuntime(nodePath, modulePath) {
  const source = [
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "if (typeof db.close === 'function') db.close();",
    "process.stdout.write(JSON.stringify({nodeVersion:process.version,nodeAbi:Number(process.versions.modules)}));",
  ].join("");
  const probe = spawnSync(nodePath, ["-e", source], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: modulePath },
  });
  if (probe.status === 0) {
    const parsed = JSON.parse(probe.stdout);
    return {
      nodeVersion: parsed.nodeVersion,
      nodeAbi: parsed.nodeAbi,
      nativeAbi: parsed.nodeAbi,
      nativeLoaded: true,
      error: null,
    };
  }
  const message = (probe.stderr || probe.stdout || "native module probe failed").trim();
  const abiMatch = message.match(/NODE_MODULE_VERSION\s+(\d+)/);
  const nodeProbe = spawnSync(nodePath, ["-p", "JSON.stringify({nodeVersion:process.version,nodeAbi:Number(process.versions.modules)})"], {
    encoding: "utf8",
  });
  const node = nodeProbe.status === 0
    ? JSON.parse(nodeProbe.stdout)
    : { nodeVersion: "unknown", nodeAbi: -1 };
  return {
    ...node,
    nativeAbi: abiMatch ? Number(abiMatch[1]) : null,
    nativeLoaded: false,
    error: message,
  };
}

// Exercise the real stdio JSON-RPC surface instead of treating a successful
// process spawn as proof that the MCP server and knowledge tools are usable.
async function runMcpSmoke({ nodePath, serverPath, modulePath, timeoutMs }) {
  const child = spawn(nodePath, [serverPath], {
    env: { ...process.env, NODE_PATH: modulePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let nextId = 1;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      waiter(response);
    }
  });

  const request = (method, params) => new Promise((resolveRequest) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolveRequest({ error: { message: `${method} timed out after ${timeoutMs}ms` } });
    }, timeoutMs);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolveRequest(response);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "penguin-runtime-doctor", version: "1.0.0" },
    });
    if (initialized.error) {
      return { healthy: false, code: "mcp_initialize_failed", error: initialized.error.message, stderr };
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const listed = await request("tools/list", {});
    if (listed.error) {
      return { healthy: false, code: "mcp_tools_list_failed", error: listed.error.message, stderr };
    }
    const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
    const knowledgeTool = KNOWLEDGE_STATUS_TOOLS.find((name) => tools.includes(name));
    if (!knowledgeTool) {
      return { healthy: false, code: "knowledge_tool_missing", error: "index_status tool is not exposed", tools, stderr };
    }
    const called = await request("tools/call", { name: knowledgeTool, arguments: {} });
    if (called.error) {
      return { healthy: false, code: "knowledge_tool_failed", error: called.error.message, tools, stderr };
    }
    if (called.result?.isError === true) {
      const toolError = (called.result.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return {
        healthy: false,
        code: "knowledge_tool_failed",
        error: toolError || "knowledge tool returned an error result",
        tools,
        stderr,
      };
    }
    return {
      healthy: true,
      code: "ok",
      serverName: initialized.result?.serverInfo?.name ?? null,
      serverVersion: initialized.result?.serverInfo?.version ?? null,
      tools,
      knowledgeTool,
    };
  } finally {
    lines.close();
    child.kill();
  }
}

// Inspect a complete vendored runtime without writing configuration or state.
export async function inspectKnowledgeRuntime(input) {
  const nodeExists = existsSync(input.nodePath);
  if (!nodeExists) {
    return { healthy: false, code: "node_missing", nodePath: input.nodePath };
  }
  const serverExists = existsSync(input.serverPath);
  if (!serverExists) {
    return { healthy: false, code: "server_missing", serverPath: input.serverPath };
  }
  const runtime = probeNativeRuntime(input.nodePath, input.modulePath);
  const validation = validateRuntimeManifest(runtime);
  if (!validation.healthy) {
    return { ...validation, runtime, nodePath: input.nodePath, serverPath: input.serverPath };
  }
  const shouldSmoke = input.smoke !== false;
  if (!shouldSmoke) {
    return {
      healthy: true,
      code: "ok",
      runtime,
      smoke: null,
      nodePath: input.nodePath,
      serverPath: input.serverPath,
    };
  }
  const smoke = await runMcpSmoke({
    nodePath: input.nodePath,
    serverPath: input.serverPath,
    modulePath: input.modulePath,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    healthy: smoke.healthy,
    code: smoke.code,
    runtime,
    smoke,
    nodePath: input.nodePath,
    serverPath: input.serverPath,
  };
}

export function readClaudeMcpTargets(configPath) {
  if (!existsSync(configPath)) {
    return { penguin: null, pengvi: null };
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : null;
  const readTarget = (name) => {
    const value = servers && typeof servers === "object" ? servers[name] : null;
    const command = value && typeof value.command === "string" ? value.command : null;
    const server = value && Array.isArray(value.args) && typeof value.args[0] === "string"
      ? value.args[0]
      : null;
    return command && server ? { name, command, server } : null;
  };
  return {
    penguin: readTarget("penguin"),
    pengvi: readTarget("pengvi"),
  };
}

export async function inspectConfiguredClaudeDuplicates(input) {
  const targets = readClaudeMcpTargets(input.configPath);
  const direct = classifyMcpDuplicate(targets.penguin, targets.pengvi);
  if (
    direct.classification === "none"
    || direct.classification === "legacy_alias_same_target"
    || !targets.penguin
    || !targets.pengvi
  ) {
    return direct;
  }
  const probe = async (target) => {
    const result = await inspectKnowledgeRuntime({
      nodePath: target.command,
      serverPath: target.server,
      modulePath: join(dirname(dirname(target.server)), "node_modules"),
      smoke: input.smoke,
      timeoutMs: input.timeoutMs,
    });
    return result.healthy ? result.smoke : null;
  };
  const [canonical, legacy] = await Promise.all([
    probe(targets.penguin),
    probe(targets.pengvi),
  ]);
  return classifyMcpDuplicate(targets.penguin, targets.pengvi, {
    canonical,
    legacy,
  });
}

// Read only Codex's Penguin MCP table so runtime diagnostics never echo other
// server settings or credentials from the user's global configuration.
function readCodexMcpTarget(configPath, name) {
  if (!existsSync(configPath)) return null;
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === `[mcp_servers.${name}]`);
  if (sectionStart < 0) return null;
  const section = [];
  for (const line of lines.slice(sectionStart + 1)) {
    if (line.trim().startsWith("[")) break;
    section.push(line.trim());
  }
  const commandLine = section.find((line) => line.startsWith("command ="));
  const argsLine = section.find((line) => line.startsWith("args ="));
  if (!commandLine || !argsLine) {
    return { error: "Penguin MCP config must define command and args" };
  }
  try {
    const command = JSON.parse(commandLine.slice(commandLine.indexOf("=") + 1).trim());
    const args = JSON.parse(argsLine.slice(argsLine.indexOf("=") + 1).trim());
    const hasValidTarget = typeof command === "string" && Array.isArray(args) && typeof args[0] === "string";
    if (!hasValidTarget) return { error: "Penguin MCP command and first arg must be paths" };
    return { nodePath: command, serverPath: args[0] };
  } catch (error) {
    return { error: `Penguin MCP config is not parseable: ${String(error)}` };
  }
}

function readCodexPenguinTarget(configPath) {
  return readCodexMcpTarget(configPath, "penguin");
}

export async function inspectConfiguredCodexDuplicates(input) {
  const canonical = readCodexMcpTarget(input.configPath, "penguin");
  const legacy = readCodexMcpTarget(input.configPath, "pengvi");
  const direct = classifyMcpDuplicate(canonical, legacy);
  if (
    direct.classification === "none"
    || direct.classification === "legacy_alias_same_target"
    || !canonical
    || !legacy
    || canonical.error
    || legacy.error
  ) {
    return direct;
  }
  const probe = async (target) => {
    const result = await inspectKnowledgeRuntime({
      nodePath: target.command,
      serverPath: target.server,
      modulePath: join(dirname(dirname(target.server)), "node_modules"),
      smoke: input.smoke,
      timeoutMs: input.timeoutMs,
    });
    return result.healthy ? result.smoke : null;
  };
  const [canonicalProbe, legacyProbe] = await Promise.all([
    probe(canonical),
    probe(legacy),
  ]);
  return classifyMcpDuplicate(canonical, legacy, {
    canonical: canonicalProbe,
    legacy: legacyProbe,
  });
}

// Validate the runtime Codex will actually launch, rather than assuming a
// healthy release bundle means every already-configured client is healthy.
export async function inspectConfiguredCodexRuntime(input) {
  const target = readCodexPenguinTarget(input.configPath);
  if (target === null) {
    return { configured: false, healthy: true, code: "not_configured" };
  }
  if (target.error) {
    return { configured: true, healthy: false, code: "config_invalid", error: target.error };
  }
  const result = await inspectKnowledgeRuntime({
    nodePath: target.nodePath,
    serverPath: target.serverPath,
    modulePath: join(dirname(dirname(target.serverPath)), "node_modules"),
    smoke: input.smoke,
    timeoutMs: input.timeoutMs,
  });
  return { configured: true, ...result };
}

// Resolve the repository bundle layout used by both local builds and release
// resources, then print one machine-readable record for CI or support bundles.
async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundle = await inspectKnowledgeRuntime({
    nodePath: join(repoRoot, "packages/mcp/bundle/node"),
    serverPath: join(repoRoot, "packages/mcp/bundle/dist/index.js"),
    modulePath: join(repoRoot, "packages/mcp/bundle/node_modules"),
    smoke: !process.argv.includes("--no-smoke"),
  });
  const codexConfigPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  const configuredCodex = process.argv.includes("--bundle-only")
    ? { configured: false, healthy: true, code: "skipped" }
    : await inspectConfiguredCodexRuntime({
      configPath: codexConfigPath,
      smoke: !process.argv.includes("--no-smoke"),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  const claudeDuplicate = process.argv.includes("--bundle-only")
    ? {
        name: "pengvi",
        classification: "none",
        safeToMigrate: false,
        reason: "skipped",
      }
    : await inspectConfiguredClaudeDuplicates({
        configPath: join(homedir(), ".claude.json"),
        smoke: !process.argv.includes("--no-smoke"),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
  const duplicateFree = claudeDuplicate.classification === "none";
  const result = {
    healthy: bundle.healthy && configuredCodex.healthy && duplicateFree,
    code: !bundle.healthy
      ? bundle.code
      : !configuredCodex.healthy
        ? configuredCodex.code
        : duplicateFree
          ? configuredCodex.code
          : "duplicate_mcp_server",
    bundle,
    configuredCodex,
    duplicates: {
      claudeCode: claudeDuplicate,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.healthy ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedDirectly) {
  await main();
}
