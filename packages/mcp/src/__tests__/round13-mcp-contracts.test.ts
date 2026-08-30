import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";
import { KnowledgeStore } from "@penguin/knowledge-core";
import { KNOWLEDGE_TOOL_DEFS } from "../knowledge-tool-defs.js";
import { handleKnowledgeTool, runKnowledgeTool } from "../knowledge-tools.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-round13-mcp-"));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  const repo = "round13-mcp";
  const repoId = store.registerRepo({ name: repo, rootPath: dir });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "round13-mcp-commit", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("round13-mcp-commit", branchId);
  const target = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::round13McpTarget`, title: "round13McpTarget", repoId });
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::round13McpCaller`, title: "round13McpCaller", repoId });
  const callee = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::round13McpCallee`, title: "round13McpCallee", repoId });
  for (const [nodeId, filePath, title] of [[target, "src/target.ts", "round13McpTarget"], [caller, "src/caller.ts", "round13McpCaller"], [callee, "src/callee.ts", "round13McpCallee"]] as const) {
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: "round13-mcp-commit", filePath, lang: "typescript", kind: "function", signature: `${title}()`, contentHash: `round13-${title}`, status: "fresh" });
  }
  store.replaceFileEdges({ branchId, filePath: "src/target.ts", edges: [{ src: target, dst: callee, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "src/caller.ts", edges: [{ src: caller, dst: target, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  return { store, repo, target };
}

function tool(name: string) {
  return KNOWLEDGE_TOOL_DEFS.find((candidate) => candidate.name === name);
}

function diagnosticRoot() {
  return resolve(process.cwd());
}

function diagnosticFixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-round13-mcp-diagnostic-"));
  const launcher = join(dir, "penguin-mcp");
  const launcherTarget = join(dir, "penguin-mcp-launcher.mjs");
  writeFileSync(launcherTarget, `#!${process.execPath}
import { createInterface } from "node:readline";
const mode = process.env.PENGUIN_DIAGNOSTIC_CASE ?? "success";
if (mode === "missing-stdout") process.exit(0);
if (mode === "non-json") { process.stdout.write("launcher log\\n"); process.exit(0); }
if (mode === "sensitive") process.stderr.write("Authorization: Bearer abc123\\n");
if (mode === "large-stream") process.stderr.write("x".repeat(300_000));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (mode === "timeout") continue;
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: mode === "missing-server-info" ? {} : { serverInfo: { name: "penguin-mcp", version: "test" } } }) + "\\n");
  } else if (request.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "mcp_health" }] } }) + "\\n");
  } else if (request.method === "tools/call" && request.params.name === "mcp_health") {
    const health = { status: "ok", serverGeneration: { runningBuildId: "running-test", availableBuildId: "available-test" }, ...(mode === "sensitive" ? { headers: [{ name: "Authorization", value: "Bearer abc123" }, { name: "x-api-key", value: "json-secret-456" }] } : {}) };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(health) }] } }) + "\\n");
  } else if (request.method === "tools/call" && request.params.name === "knowledge_capabilities") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { capabilityHash: "test-capability-hash" } } }) + "\\n");
  }
}
`);
  writeFileSync(launcher, `#!/bin/sh
exec "${launcherTarget}"
`);
  chmodSync(launcherTarget, 0o755);
  chmodSync(launcher, 0o755);
  return { dir, launcher, launcherTarget };
}

function runDiagnostic(launcher: string, mode = "success") {
  const report = join(tmpdir(), `penguin-round13-diagnostic-${process.pid}-${Date.now()}-${mode}.md`);
  const result = spawnSync(process.execPath, [join(diagnosticRoot(), "scripts/knowledge-mcp-session-diagnostic.mjs")], {
    cwd: diagnosticRoot(),
    env: { ...process.env, PENGUIN_MCP_COMMAND: launcher, PENGUIN_DIAGNOSTIC_CASE: mode, PENGUIN_MCP_DIAGNOSTIC_REPORT: report, PENGUIN_MCP_DIAGNOSTIC_TIMEOUT_MS: "3000" },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { result, record: JSON.parse(result.stdout), report: readFileSync(report, "utf8"), reportPath: report };
}

function runBuiltMcpHealth() {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "round13", version: "1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_health", arguments: {} } }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10);
  const result = spawnSync(process.execPath, [resolve(diagnosticRoot(), "packages/mcp/dist/index.js")], {
    cwd: diagnosticRoot(),
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
  const frame = result.stdout
    .split(String.fromCharCode(10))
    .map((line) => { try { return JSON.parse(line) as Record<string, any>; } catch { return null; } })
    .find((candidate) => candidate?.id === 2);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(frame?.result, result.stdout);
  return JSON.parse(frame.result.content[0].text) as Record<string, any>;
}

test("MCP definitions list every Round 13 continuation tool", () => {
  for (const capability of ["knowledge.callees", "knowledge.affected", "knowledge.context", "knowledge.flow"]) {
    const name = capability.replaceAll(".", "_");
    const definition = tool(name);
    assert.ok(definition, `missing MCP definition ${name}`);
    assert.equal(definition?.["x-penguin-capability-id"], capability);
  }
});

test("MCP capability negotiation records build, hash, and schema identity through the real route", async () => {
  const { store } = fixture();
  const result = await runKnowledgeTool("knowledge_capabilities", {}, { store }) as Record<string, unknown>;
  assert.equal(typeof result.buildId, "string");
  assert.equal(result.capabilityHash, capabilityHash(CAPABILITIES));
  assert.equal(typeof result.schemaVersion, "string");
  assert.equal(result.contractVersion, "2");
  assert.equal(result.schemaVersion, "14");
  store.close();
});

test("MCP accepts node:<id> for callees, affected, and flow continuation", async () => {
  const { store, repo, target } = fixture();
  const selector = `node:${target}`;
  const callees = await runKnowledgeTool("knowledge_callees", { target: selector, repo }, { store }) as Record<string, any>;
  const affected = await runKnowledgeTool("knowledge_affected", { target: selector, repo }, { store }) as Record<string, any>;
  const flow = await runKnowledgeTool("knowledge_flow", { target: selector, repo }, { store }) as Record<string, any>;

  assert.equal(callees.error, undefined, JSON.stringify(callees));
  assert.equal(affected.error, undefined, JSON.stringify(affected));
  assert.equal(flow.error, undefined, JSON.stringify(flow));
  assert.equal(affected.target.nodeId, target);
  assert.equal(flow.root.nodeId, target);
  store.close();
});

test("MCP invalid node is not a success-shaped empty context", async () => {
  const { store, repo } = fixture();
  const result = await runKnowledgeTool("knowledge_context", { target: "node:round13-missing-node", repo }, { store }) as Record<string, any>;

  assert.deepEqual(result.error, {
    code: "TARGET_NOT_FOUND",
    message: "target was not found: node:round13-missing-node",
    retryable: false,
    details: { target: "node:round13-missing-node" },
  });
  store.close();
});

test("real MCP session diagnostic records initialize, tools, health, and capability boundary", () => {
  const { launcher } = diagnosticFixture();
  const { result, record, report } = runDiagnostic(launcher);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(record.failureClass, "NONE");
  assert.equal(record.initialize.response.result.serverInfo.name, "penguin-mcp");
  assert.equal(record["tools/list"].nonEmpty, true);
  assert.equal(record.mcp_health.structured.status, "ok");
  assert.equal(record.capabilityHash, "test-capability-hash");
  assert.equal(record.runningBuildId, "running-test");
  assert.equal(record.availableBuildId, "available-test");
  assert.match(report, /failureClass: `NONE`/);
});

test("MCP health keeps local initialize and client restart status separate", () => {
  // index.ts starts the stdio server as a module side effect, so keep this
  // contract assertion focused on the production health response shape.
  const source = readFileSync(resolve(diagnosticRoot(), "packages/mcp/src/index.ts"), "utf8");
  assert.match(source, /initializeHealthy:\s*true/);
  assert.match(source, /clientRestartRequired:\s*generationState\.outdated/);
  assert.match(source, /runtimeOutdated:\s*generationState\.outdated/);
  assert.match(source, /serverGeneration:\s*\{/);
  assert.match(source, /action:\s*generationNotice\(generationState\)/);
});

test("built MCP health reports local initialize and runtime generation separately", () => {
  const health = runBuiltMcpHealth();
  assert.equal(health.configured, null);
  assert.equal(health.launcherHealthy, null);
  assert.equal(health.initializeHealthy, true);
  assert.equal(health.clientRestartRequired, false);
  assert.equal(health.runtimeOutdated, false);
  assert.equal(health.serverGeneration.outdated, false);
  assert.equal(health.serverGeneration.runningBuildId, health.serverGeneration.availableBuildId);
});

test("Settings keeps config, local checks, restart, and outdated state distinct", () => {
  const source = readFileSync(resolve(diagnosticRoot(), "src/components/settings/SettingsDialog.tsx"), "utf8");
  assert.match(source, /configured:\s*boolean/);
  assert.match(source, /launcherHealthy:\s*boolean/);
  assert.match(source, /initializeHealthy:\s*boolean\s*\|\s*null/);
  assert.match(source, /clientRestartRequired:\s*boolean/);
  assert.match(source, /runtimeOutdated:\s*boolean\s*\|\s*null/);
  assert.match(source, /Fully quit and restart/);
  assert.match(source, /does not prove.*reloaded/i);
  assert.match(source, /Outdated.*reconfigure|reconfigure.*Outdated/i);
  assert.doesNotMatch(source, /MCP Ready/);
});

test("Settings snippets use the stable launcher as the only canonical command", () => {
  const source = readFileSync(resolve(diagnosticRoot(), "src/components/settings/SettingsDialog.tsx"), "utf8");
  assert.match(source, /launcher_path/);
  assert.match(source, /command:\s*mcpLauncherPath/);
  assert.match(source, /args:\s*\[\]/);
  assert.doesNotMatch(source, /command:\s*mcpNodePath/);
  assert.doesNotMatch(source, /mcpClaudeCliCommand\s*=.*mcpNodePath/);
  assert.doesNotMatch(source, /mcpCodexCliCommand\s*=.*mcpNodePath/);
});

test("real MCP session diagnostic covers launcher execute permissions", () => {
  const { launcher, launcherTarget } = diagnosticFixture();
  const success = runDiagnostic(launcher);
  assert.equal(success.result.status, 0, success.result.stderr || success.result.stdout);
  assert.equal(success.record.failureClass, "NONE");

  chmodSync(launcherTarget, 0o644);
  const failure = runDiagnostic(launcher);
  assert.equal(failure.record.session.exitCode, 126, JSON.stringify(failure.record));
  assert.equal(failure.record.failureClass, "LAUNCHER_EXECUTION_FAILED");
});

test("diagnostic report redacts bearer and nested JSON header secrets", () => {
  const { launcher } = diagnosticFixture();
  const { record, report } = runDiagnostic(launcher, "sensitive");

  assert.equal(record.failureClass, "NONE");
  assert.doesNotMatch(report, /abc123|json-secret-456/);
  assert.match(report, /Bearer <redacted>/);
  assert.match(report, /"name": "x-api-key"/);
  assert.match(report, /"value": "<redacted>"/);
});

test("diagnostic report preserves complete large streams in a safe readable sidecar", () => {
  const { launcher } = diagnosticFixture();
  const { record, report, reportPath } = runDiagnostic(launcher, "large-stream");
  const streamEvidencePath = `${reportPath}.streams.json`;
  const streamEvidence = readFileSync(streamEvidencePath, "utf8");

  assert.equal(record.failureClass, "NONE");
  assert.match(report, /streamEvidenceFile/);
  assert.match(report, /完整安全流证据见/);
  const parsedStreamEvidence = JSON.parse(streamEvidence) as { stderr: string };
  assert.equal(parsedStreamEvidence.stderr, "x".repeat(300_000));
});

test("real MCP session diagnostic separates stdout, JSON, timeout, and server-info failures", () => {
  const { launcher } = diagnosticFixture();
  const expected = new Map([
    ["missing-stdout", "INITIALIZE_MISSING_STDOUT"],
    ["non-json", "INITIALIZE_NON_JSON_STDOUT"],
    ["timeout", "INITIALIZE_TIMEOUT"],
    ["missing-server-info", "INITIALIZE_MISSING_SERVER_INFO"],
  ]);
  for (const [mode, failureClass] of expected) {
    const { record } = runDiagnostic(launcher, mode);
    assert.equal(record.failureClass, failureClass, `${mode}: ${JSON.stringify(record)}`);
  }
});
