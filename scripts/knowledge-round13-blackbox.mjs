#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE = resolve(ROOT, process.env.PENGUIN_BUNDLE ?? "packages/knowledge-cli/bundle/penguin.mjs");
const DEFAULT_NODE = resolve(ROOT, "packages/knowledge-cli/bundle/node");
const RUNTIME = resolve(process.env.PENGUIN_NODE ?? (existsSync(DEFAULT_NODE) ? DEFAULT_NODE : process.execPath));
const MCP_ENTRY = resolve(ROOT, process.env.PENGUIN_MCP_ENTRY ?? "packages/mcp/bundle/dist/index.js");
const REPO = process.env.PENGUIN_REPO ?? "FPMS-NT";
const BASELINE_REPORT = resolve(
  ROOT,
  process.env.PENGUIN_ROUND13_REPORT ?? ".superpowers/sdd/2026-08-30-penguin-round13-runtime-sync-complete-fix/round13-blackbox-postfix.md",
);

if (!existsSync(BUNDLE)) throw new Error(`missing CLI bundle: ${BUNDLE}`);
if (!existsSync(MCP_ENTRY)) throw new Error(`missing MCP bundle: ${MCP_ENTRY}`);

// A valid node ID must always come from the response immediately before the
// follow-up command. This source-level guard catches accidental fixture edits
// that paste a stable UUID from a previous evaluation round.
const source = readFileSync(new URL(import.meta.url), "utf8");
assert.equal(/node_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(source), false, "black-box harness contains a manually supplied node ID");

const env = {
  ...process.env,
  PENGUIN_WASM_DIR: process.env.PENGUIN_WASM_DIR ?? resolve(ROOT, "packages/knowledge-cli/bundle/wasm"),
};
const rows = [];

function parseJsonLines(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((value) => value !== null);
}

function lastJson(row) {
  return [...parseJsonLines(`${row.stdout}\n${row.stderr}`)].at(-1) ?? null;
}

function runCli(name, args) {
  const started = Date.now();
  const result = spawnSync(RUNTIME, [BUNDLE, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const row = {
    name,
    surface: "cli",
    args,
    exitCode: result.status ?? 1,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  rows.push(row);
  return row;
}

async function runMcp(requests) {
  const started = Date.now();
  const responses = [];
  let stdout = "";
  let stderr = "";
  let settled = false;
  let child;
  const lastRequestId = [...requests].reverse().find((request) => request.id !== undefined)?.id;
  const result = await new Promise((resolveRequest) => {
    const finish = (exitCode = null, termination = "process_exit") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && !child.killed) child.kill();
      resolveRequest({ exitCode, termination });
    };
    const timer = setTimeout(() => finish(1, "timeout"), 10_000);
    child = spawn(RUNTIME, [MCP_ENTRY], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const parsed = parseJsonLines(stdout);
      while (responses.length < parsed.length) responses.push(parsed[responses.length]);
      // The harness owns this one-shot session. Close it after the final
      // response instead of waiting for an MCP server to infer EOF.
      if (responses.some((response) => response.id === lastRequestId)) finish(0, "harness_closed_after_last_response");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", () => finish(1, "spawn_error"));
    child.on("close", (code) => finish(code, "process_exit"));
    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
  const row = {
    name: "MCP-fresh-session",
    surface: "mcp",
    args: requests.map((request) => request.method),
    exitCode: result.exitCode ?? (responses.length ? 0 : 1),
    termination: result.termination,
    durationMs: Date.now() - started,
    stdout: JSON.stringify(responses),
    stderr,
  };
  rows.push(row);
  return { row, responses };
}

function responseById(responses, id) {
  return responses.find((response) => response.id === id) ?? null;
}

function mcpStructured(response) {
  return response?.result?.structuredContent
    ?? [...(response?.result?.content ?? [])].reverse().map((item) => {
      try { return JSON.parse(item.text); } catch { return null; }
    }).find(Boolean)
    ?? null;
}

function nodeIds(value) {
  const ids = [];
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    if (typeof item.nodeId === "string" && /^node_[0-9a-f-]+$/iu.test(item.nodeId)) ids.push(item.nodeId);
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return [...new Set(ids)];
}

function freshNodeId(response, label) {
  const id = nodeIds(response)[0];
  assert.ok(id, `${label} did not emit a nodeId; IDs must come from the immediately preceding response`);
  return id;
}

function check(name, row, predicate, expected) {
  let pass = false;
  let failure = null;
  try {
    pass = Boolean(predicate(row));
    if (!pass) failure = expected;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  row.contract = { pass, expected, failure };
  return pass;
}

const capabilitiesRow = runCli("Q1-capabilities", ["capabilities", "--json"]);
const capabilities = lastJson(capabilitiesRow);
const statusRow = runCli("Q1-status", ["status", "--json"]);
const coverageRow = runCli("Q1-coverage", ["coverage", "--repo", REPO, "--json"]);
const searchRow = runCli("Q2-search-id-source", ["search", "constructor", "--repo", REPO, "--limit", "5", "--json"]);
const searchPayload = lastJson(searchRow);
const symbolId = freshNodeId(searchPayload, "search");
const firstHit = searchPayload?.hits?.find((hit) => hit.nodeId === symbolId) ?? searchPayload?.hits?.[0] ?? null;

const runtimeCapabilities = capabilities ?? {};
const resolvedRevision = searchPayload?.diagnostics?.resolvedScopes?.[0] ?? null;
const indexedRevision = firstHit?.locator
  ? {
      repoId: firstHit.locator.repoId ?? resolvedRevision?.repoId ?? null,
      repoName: firstHit.locator.repoName ?? REPO,
      branch: firstHit.locator.branch ?? resolvedRevision?.branch ?? null,
      commitSha: firstHit.locator.commitSha ?? resolvedRevision?.commitSha ?? null,
      revisionId: firstHit.locator.revisionId ?? resolvedRevision?.snapshotId ?? null,
    }
  : resolvedRevision;
const identity = {
  buildId: runtimeCapabilities.buildId ?? null,
  capabilityHash: runtimeCapabilities.capabilityHash ?? null,
  schemaVersion: runtimeCapabilities.schemaVersion ?? null,
  runtimePath: RUNTIME,
  bundlePath: BUNDLE,
  indexedRevision,
};

const mcpRequests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "round13-blackbox", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "knowledge_capabilities", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "knowledge_context", arguments: { target: `node:${symbolId}`, repo: REPO } } },
];
const mcp = await runMcp(mcpRequests);
const mcpInit = responseById(mcp.responses, 1);
const mcpCapabilities = mcpStructured(responseById(mcp.responses, 3));
const mcpIdentity = {
  buildId: mcpCapabilities?.buildId ?? null,
  capabilityHash: mcpCapabilities?.capabilityHash ?? null,
  schemaVersion: mcpCapabilities?.schemaVersion ?? JSON.parse(mcpInit?.result?.instructions ?? "null")?.schemaVersion ?? null,
};
assert.equal(mcpIdentity.buildId, identity.buildId, "CLI and MCP must expose the same buildId");
assert.equal(mcpIdentity.capabilityHash, identity.capabilityHash, "CLI and MCP must expose the same capabilityHash");
assert.equal(String(mcpIdentity.schemaVersion), String(identity.schemaVersion), "CLI and MCP must expose the same schemaVersion");

check("Q1-runtime-identity", capabilitiesRow, () => (
  typeof identity.buildId === "string"
  && typeof identity.capabilityHash === "string"
  && identity.capabilityHash.length === 64
  && identity.schemaVersion !== null
  && identity.runtimePath.length > 0
  && identity.bundlePath.length > 0
  && identity.indexedRevision !== null
), "buildId, capabilityHash, schemaVersion, runtimePath, bundlePath, and indexedRevision must all be captured");

const missingCalleesRow = runCli("Q3-callees-missing-target", ["callees", "--repo", REPO, "--json"]);
check("Q3-callees-missing-target", missingCalleesRow, () => missingCalleesRow.exitCode !== 0 && /target|usage|resolve/iu.test(`${missingCalleesRow.stdout}\n${missingCalleesRow.stderr}`), "callees without a target must fail with an actionable error");

// The context selector is obtained from a search response immediately before
// the context command. This makes the continuation chain test the same
// hand-off discipline an agent uses in a fresh session.
const contextSeedRow = runCli("Q3-context-seed", ["search", "constructor", "--repo", REPO, "--limit", "5", "--json"]);
const contextSeedPayload = lastJson(contextSeedRow);
const contextSeedId = freshNodeId(contextSeedPayload, "context seed search");
const contextRow = runCli("Q3-context-node", ["context", `node:${contextSeedId}`, "--repo", REPO, "--json"]);
const contextPayload = lastJson(contextRow);
check("Q3-context-node", contextRow, () => contextRow.exitCode === 0 && contextPayload?.focus?.nodeId === contextSeedId, "node:<id> context must resolve the ID emitted by the immediately preceding search response");
const flowInputId = freshNodeId(contextPayload, "context");
const contextId = flowInputId;

const flowRow = runCli("Q3-flow-node", ["flow", `node:${contextId}`, "--repo", REPO, "--json"]);
const flowPayload = lastJson(flowRow);
check("Q3-flow-node", flowRow, () => flowRow.exitCode === 0 && Boolean(flowPayload?.root?.nodeId), "node:<id> must continue into flow with a resolved root");

const callersInputId = freshNodeId(flowPayload, "flow");
const callersRow = runCli("Q3-callers-node", ["callers", `node:${callersInputId}`, "--repo", REPO, "--json"]);
const callersPayload = lastJson(callersRow);
check("Q3-callers-node", callersRow, () => callersRow.exitCode === 0 && callersPayload && !callersPayload.error, "node:<id> must continue into callers without an error-shaped response");

const calleesInputId = freshNodeId(callersPayload, "callers");
const calleesRow = runCli("Q3-callees-node", ["callees", `node:${calleesInputId}`, "--repo", REPO, "--json"]);
const calleesPayload = lastJson(calleesRow);
check("Q3-callees-node", calleesRow, () => calleesRow.exitCode === 0 && calleesPayload && !calleesPayload.error, "callees must be a real runnable CLI continuation");

const affectedInputId = freshNodeId(calleesPayload, "callees");
const affectedRow = runCli("Q3-affected-node", ["affected", `node:${affectedInputId}`, "--repo", REPO, "--json"]);
const affectedPayload = lastJson(affectedRow);
check("Q3-affected-node", affectedRow, () => affectedRow.exitCode === 0 && affectedPayload?.target?.nodeId === affectedInputId && !affectedPayload.files?.includes(`node:${affectedInputId}`), "affected node:<id> must resolve a node and must not treat the selector as a filename");

const endpointRow = runCli("Q6-endpoint-source", ["endpoints", REPO, "--protocol", "grpc", "--limit", "1", "--json"]);
const endpointPayload = lastJson(endpointRow);
const endpoint = endpointPayload?.items?.[0];
check("Q6-endpoint-source", endpointRow, () => Boolean(endpoint?.nodeId && endpoint?.identityKey), "endpoint inventory must emit a nodeId and canonical identity from the current response");

if (endpoint) {
  const identityRow = runCli("Q6-canonical-grpc-identity", ["endpoint-identity", endpoint.title, endpoint.identityKey, endpoint.nodeId, "--json"]);
  const identityPayload = lastJson(identityRow);
  check("Q6-canonical-grpc-identity", identityRow, () => identityRow.exitCode === 0 && identityPayload?.equal === true, "canonical gRPC identity must resolve to the endpoint ID emitted by the immediately preceding inventory response");
}

const wrongRevisionSeedRow = runCli("Q10-wrong-revision-seed", ["search", "constructor", "--repo", REPO, "--limit", "5", "--json"]);
const wrongRevisionSeed = lastJson(wrongRevisionSeedRow);
const wrongRevisionTargetId = freshNodeId(wrongRevisionSeed, "wrong-revision seed search");
const wrongRevision = `round13-invalid-${randomUUID()}`;
const wrongRevisionRow = runCli("Q10-wrong-revision", ["context", `node:${wrongRevisionTargetId}`, "--repo", REPO, "--commit", wrongRevision, "--json"]);
const wrongRevisionPayload = lastJson(wrongRevisionRow);
check("Q10-wrong-revision", wrongRevisionRow, () => wrongRevisionRow.exitCode !== 0 && JSON.stringify(wrongRevisionPayload).includes(wrongRevision), "explicit wrong revision must fail closed and name the requested revision");

const invalidNode = `node:round13-missing-${randomUUID()}`;
const invalidNodeRow = runCli("Q16-invalid-node", ["context", invalidNode, "--repo", REPO, "--json"]);
const invalidNodePayload = lastJson(invalidNodeRow);
check("Q16-invalid-node", invalidNodeRow, () => invalidNodeRow.exitCode !== 0 && invalidNodePayload?.error?.code === "NODE_NOT_FOUND", "invalid node must return a structured NODE_NOT_FOUND error");

const deadSeedRow = runCli("Q12-deadcode-seed", ["deadcode", "--repo", REPO, "--limit", "3", "--json"]);
const deadSeed = lastJson(deadSeedRow);
const deadPath = deadSeed?.candidates?.[0]?.filePath ?? null;
const deadRows = [];
let deadCursor = null;
let deadTerminal = false;
let deadDuplicate = false;
const deadIds = new Set();
if (deadPath) {
  for (let page = 0; page < 20; page += 1) {
    const args = ["deadcode", "--repo", REPO, "--path", deadPath, "--limit", "1", "--json"];
    if (deadCursor) args.push("--cursor", deadCursor);
    const row = runCli(page === 0 ? "Q12-deadcode-page1" : `Q12-deadcode-page${page + 1}`, args);
    deadRows.push(row);
    const payload = lastJson(row);
    for (const candidate of payload?.candidates ?? []) {
      if (deadIds.has(candidate.nodeId)) deadDuplicate = true;
      deadIds.add(candidate.nodeId);
    }
    deadCursor = payload?.nextCursor ?? null;
    if (!deadCursor) {
      deadTerminal = payload?.truncated === false && payload?.totalIsExact === true;
      break;
    }
  }
}
const deadLast = deadRows.at(-1);
check("Q12-deadcode-exhaustion", deadLast ?? deadSeedRow, () => Boolean(deadPath) && deadLast?.exitCode === 0 && deadTerminal && !deadDuplicate, "deadcode continuation must reach nextCursor:null with truncated:false and totalIsExact:true within a path selected from the preceding response");

const humanNegativeRow = runCli("Q16-human-not-proven", ["search", `round13-definitely-absent-${randomUUID()}`, "--repo", REPO]);
check("Q16-human-not-proven", humanNegativeRow, () => humanNegativeRow.exitCode === 0 && /not proven/iu.test(`${humanNegativeRow.stdout}\n${humanNegativeRow.stderr}`), "human negative output must explicitly say not proven");

const listedTools = responseById(mcp.responses, 2)?.result?.tools ?? [];
const mcpContext = mcpStructured(responseById(mcp.responses, 4));
check("MCP-tools-list", mcp.row, () => ["knowledge_callees", "knowledge_affected", "knowledge_capabilities"].every((name) => listedTools.some((tool) => tool.name === name)), "MCP tools/list must expose the continuation and identity tools");
check("MCP-node-continuation", mcp.row, () => mcp.row.exitCode === 0 && mcpContext && !mcpContext.error, "a fresh MCP session must consume the node ID emitted by the preceding CLI response");

const failures = rows.filter((row) => row.contract?.pass === false);
const markdown = [
  "# Penguin Round 13 Black-box Baseline",
  "",
  `- Captured: ${new Date().toISOString()}`,
  `- Repository: \`${REPO}\``,
  `- Runtime: \`${RUNTIME}\``,
  `- CLI bundle: \`${BUNDLE}\``,
  `- MCP bundle: \`${MCP_ENTRY}\``,
  `- Cases: ${rows.filter((row) => row.contract).length}`,
  `- Passed: ${rows.filter((row) => row.contract?.pass === true).length}`,
  `- Failed: ${failures.length}`,
  "",
  "## Runtime identity fixture",
  "",
  "```json",
  JSON.stringify(identity, null, 2),
  "```",
  "",
  "## Failure matrix",
  "",
  "| Case | Surface | Exit | Contract | Failure |",
  "|---|---|---:|---|---|",
  ...rows.filter((row) => row.contract).map((row) => `| ${row.name} | ${row.surface} | ${row.exitCode} | ${row.contract.pass ? "PASS" : "FAIL"} | ${(row.contract.failure ?? "").replaceAll("|", "\\|")} |`),
  "",
  "## Raw evidence",
  "",
  ...rows.map((row) => [
    `### ${row.name}`,
    `- surface: \`${row.surface}\``,
    `- command: \`${row.args.join(" ")}\``,
    `- exitCode: \`${row.exitCode}\`; durationMs: \`${row.durationMs}\``,
    "```text",
    `${row.stdout}${row.stderr ? `\n[stderr]\n${row.stderr}` : ""}`.slice(0, 16000),
    "```",
    "",
  ].join("\n")),
  "## Gate",
  "",
  failures.length === 0 ? "PASS: all Round 13 black-box contracts passed." : `BASELINE: ${failures.length} contract(s) still reproduce a Round 13 mismatch; later plan tasks must make these pass.`,
  "",
].join("\n");
mkdirSync(dirname(BASELINE_REPORT), { recursive: true });
writeFileSync(BASELINE_REPORT, markdown);

console.log(JSON.stringify({
  report: BASELINE_REPORT,
  runtimeIdentity: identity,
  commandCount: rows.length,
  contractCount: rows.filter((row) => row.contract).length,
  passed: rows.filter((row) => row.contract?.pass === true).length,
  failed: failures.length,
}, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
