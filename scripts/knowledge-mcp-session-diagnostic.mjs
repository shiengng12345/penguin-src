#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { McpSession, mcpStructured, processEnv } from "./knowledge-process-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const home = homedir();
const configuredCommand = process.env.PENGUIN_MCP_COMMAND ?? join(home, ".penguin", "bin", "penguin-mcp");
const configuredArgs = (() => {
  const encoded = process.env.PENGUIN_MCP_COMMAND_ARGS;
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
})();
const reportPath = process.env.PENGUIN_MCP_DIAGNOSTIC_REPORT ?? resolve(root, ".superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-1-report.md");
const timeoutMs = Number(process.env.PENGUIN_MCP_DIAGNOSTIC_TIMEOUT_MS ?? 15_000);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return value
      .replaceAll(home, "~")
      .replaceAll(root, "<workspace>")
      .replace(/(authorization|cookie|password|secret|token|api[_-]?key)([=:]\s*)([^\s,;]+)/giu, "$1$2<redacted>");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const isSensitiveKey = /authorization|cookie|password|secret|token|api[_-]?key/iu.test(key);
    return [key, isSensitiveKey ? "<redacted>" : redact(item)];
  }));
}

function bounded(value, limit = 30_000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function launcherTarget(command) {
  if (!existsSync(command)) return null;
  try {
    const resolved = realpathSync(command);
    const source = readFileSync(command, "utf8");
    const target = source.match(/(?:exec|node)\s+[^\n]*?(?:\$HOME|\$\{HOME\})([^\s"']*penguin-mcp-launcher\.mjs)/u)?.[1];
    return target ? resolve(home, target.replace(/^\//u, "")) : resolved;
  } catch {
    return command;
  }
}

function streamEvidence(session) {
  const evidence = session.evidence();
  return redact({
    command: evidence.command,
    args: evidence.args,
    pid: evidence.pid,
    stdout: bounded(evidence.stdout),
    stderr: bounded(evidence.stderr),
    protocolLines: evidence.protocolLines,
    messages: evidence.messages,
    spawnError: evidence.spawnError,
    exitCode: evidence.exitCode,
    exitSignal: evidence.exitSignal,
  });
}

function errorText(error) {
  return error ? String(error.message ?? error) : null;
}

function isTimeout(error) {
  return /timed out/iu.test(errorText(error) ?? "");
}

function classifyInitialize({ error, response, session }) {
  if (isTimeout(error)) return "INITIALIZE_TIMEOUT";
  const evidence = session.evidence();
  const hasProcessExitFailure = evidence.exitCode !== null && evidence.exitCode !== 0 && evidence.messages.length === 0;
  if (hasProcessExitFailure) return "LAUNCHER_EXECUTION_FAILED";
  const hasStdout = evidence.stdout.trim().length > 0;
  if (!hasStdout) return "INITIALIZE_MISSING_STDOUT";
  const hasJsonResponse = evidence.messages.length > 0;
  if (!hasJsonResponse) return "INITIALIZE_NON_JSON_STDOUT";
  const hasServerInfo = Boolean(response?.result?.serverInfo);
  if (!hasServerInfo) return "INITIALIZE_MISSING_SERVER_INFO";
  return "HOST_SESSION_FAILED";
}

function requestEvidence(response, error) {
  return {
    ok: !error && response !== null,
    response: redact(response),
    error: redact(errorText(error)),
  };
}

function markdown(record) {
  return [
    "# Task 1 — 真实 MCP session 边界诊断",
    "",
    `- ` + "failureClass: `" + record.failureClass + "`",
    `- configuredCommand: \`${record.configuredCommand}\``,
    `- launcherTarget: \`${record.launcherTarget ?? "未解析"}\``,
    `- capabilityHash: \`${record.capabilityHash ?? "未取得"}\``,
    `- runningBuildId: \`${record.runningBuildId ?? "未取得"}\``,
    `- availableBuildId: \`${record.availableBuildId ?? "未取得"}\``,
    "",
    "## Redacted diagnostic record",
    "",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
    "",
  ].join("\n");
}

function discoveryFailure() {
  const target = launcherTarget(configuredCommand);
  const isConfiguredCommandMissing = !existsSync(configuredCommand);
  const failureClass = isConfiguredCommandMissing ? "CONFIG_DISCOVERY_FAILED" : null;
  return { target, failureClass };
}

async function diagnose() {
  const discovery = discoveryFailure();
  const record = {
    generatedAt: new Date().toISOString(),
    configuredCommand: redact(configuredCommand),
    launcherTarget: redact(discovery.target),
    initialize: null,
    "tools/list": null,
    mcp_health: null,
    knowledge_capabilities: null,
    capabilityHash: null,
    runningBuildId: null,
    availableBuildId: null,
    failureClass: discovery.failureClass,
    session: null,
  };
  if (record.failureClass) return record;

  const session = new McpSession({
    command: configuredCommand,
    args: configuredArgs,
    cwd: root,
    env: processEnv(root),
    label: "mcp-session-diagnostic",
    timeoutMs,
  });
  record.session = null;
  try {
    let initialized = null;
    let initializeError = null;
    try {
      initialized = await session.initialize();
    } catch (error) {
      initializeError = error;
    }
    record.initialize = requestEvidence(initialized, initializeError);
    if (initializeError || !initialized?.result?.serverInfo) {
      const hasSpawnError = Boolean(session.evidence().spawnError);
      record.failureClass = hasSpawnError ? "LAUNCHER_EXECUTION_FAILED" : classifyInitialize({ error: initializeError, response: initialized, session });
      return record;
    }
    const hasExpectedServerName = initialized.result.serverInfo.name === "penguin-mcp";
    if (!hasExpectedServerName) {
      record.failureClass = "INITIALIZE_SERVER_INFO_MISMATCH";
      return record;
    }

    let toolsResponse = null;
    let toolsError = null;
    try {
      toolsResponse = await session.request("tools/list");
    } catch (error) {
      toolsError = error;
    }
    const tools = toolsResponse?.result?.tools;
    record["tools/list"] = {
      ...requestEvidence(toolsResponse, toolsError),
      toolCount: Array.isArray(tools) ? tools.length : null,
      nonEmpty: Array.isArray(tools) && tools.length > 0,
    };
    if (toolsError) {
      record.failureClass = isTimeout(toolsError) ? "TOOLS_LIST_TIMEOUT" : "HOST_SESSION_FAILED";
      return record;
    }
    const hasRegisteredTools = Array.isArray(tools) && tools.length > 0;
    if (!hasRegisteredTools) {
      record.failureClass = "TOOLS_LIST_EMPTY";
      return record;
    }

    let healthResponse = null;
    let healthError = null;
    try {
      healthResponse = await session.callTool("mcp_health");
    } catch (error) {
      healthError = error;
    }
    const health = healthResponse ? mcpStructured(healthResponse) : null;
    record.mcp_health = { ...requestEvidence(healthResponse, healthError), structured: redact(health) };
    const hasHealthResult = health !== null && typeof health === "object";
    if (healthError || healthResponse?.result?.isError === true || !hasHealthResult) {
      record.failureClass = isTimeout(healthError) ? "MCP_HEALTH_TIMEOUT" : "MCP_HEALTH_FAILED";
      return record;
    }
    record.runningBuildId = health?.serverGeneration?.runningBuildId ?? null;
    record.availableBuildId = health?.serverGeneration?.availableBuildId ?? null;

    let capabilityResponse = null;
    let capabilityError = null;
    try {
      capabilityResponse = await session.callTool("knowledge_capabilities");
    } catch (error) {
      capabilityError = error;
    }
    const capabilities = capabilityResponse ? mcpStructured(capabilityResponse) : null;
    record.knowledge_capabilities = { ...requestEvidence(capabilityResponse, capabilityError), structured: redact(capabilities) };
    if (capabilityError || capabilityResponse?.result?.isError === true || !capabilities?.capabilityHash) {
      record.failureClass = isTimeout(capabilityError) ? "CAPABILITY_TIMEOUT" : "CAPABILITY_NEGOTIATION_FAILED";
      return record;
    }
    record.capabilityHash = capabilities.capabilityHash;
    record.failureClass = "NONE";
    return record;
  } finally {
    record.session = streamEvidence(session);
    session.close();
  }
}

let record;
try {
  record = await diagnose();
} catch (error) {
  record = {
    configuredCommand: redact(configuredCommand),
    launcherTarget: redact(launcherTarget(configuredCommand)),
    initialize: null,
    "tools/list": null,
    mcp_health: null,
    knowledge_capabilities: null,
    capabilityHash: null,
    runningBuildId: null,
    availableBuildId: null,
    failureClass: "HOST_SESSION_FAILED",
    error: redact(errorText(error)),
    session: null,
  };
}
writeFileSync(reportPath, markdown(redact(record)));
process.stdout.write(`${JSON.stringify(redact(record), null, 2)}\n`);
process.exitCode = record.failureClass === "NONE" ? 0 : 1;
