#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundle = process.env.PENGUIN_BUNDLE ?? resolve(root, "packages/knowledge-cli/bundle/penguin.mjs");
const bundledNode = resolve(root, "packages/knowledge-cli/bundle/node");
const runtime = process.env.PENGUIN_NODE ?? (existsSync(bundledNode) ? bundledNode : process.execPath);
const repo = process.env.PENGUIN_REPO ?? "FPMS-NT";
const report = process.env.PENGUIN_RETEST_REPORT ?? resolve(root, "docs/quality/index-evaluation-codex-round14.md");
if (!existsSync(bundle)) throw new Error(`missing bundle: ${bundle}`);
const mcpEntry = resolve(root, "packages/mcp/bundle/dist/index.js");

const env = { ...process.env, PENGUIN_WASM_DIR: process.env.PENGUIN_WASM_DIR ?? resolve(root, "packages/knowledge-cli/bundle/wasm") };
const rows = [];
function run(name, args) {
  const started = Date.now();
  const result = spawnSync(runtime, [bundle, ...args], { cwd: root, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const row = { name, args, exitCode: result.status ?? 1, durationMs: Date.now() - started, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  rows.push(row);
  return row;
}
function json(row) { try { return JSON.parse(row.stdout); } catch { return null; } }
function runMcp(name, requests) {
  if (!existsSync(mcpEntry)) {
    rows.push({ name, args: [mcpEntry], exitCode: 1, durationMs: 0, stdout: "", stderr: "MCP bundle missing" });
    return null;
  }
  const started = Date.now();
  const result = spawnSync(runtime, [mcpEntry], { cwd: root, env, input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const lines = (result.stdout ?? "").split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  rows.push({ name, args: ["MCP", ...requests.map((request) => request.method)], exitCode: result.status ?? 1, durationMs: Date.now() - started, stdout: JSON.stringify(lines), stderr: result.stderr ?? "" });
  return lines;
}

run("Q1-help", ["help", "--json"]);
run("Q1-capabilities", ["capabilities", "--json"]);
run("Q1-status", ["status", "--compact", "--json"]);
run("Q1-doctor", ["doctor", "--json"]);
run("Q1-coverage", ["coverage", "--repo", repo, "--json"]);
run("Q1-onboarding", ["onboarding", repo, "--json"]);
run("Q4-search", ["search", "constructor", "--repo", repo, "--limit", "5", "--json"]);
const symbols = json(rows.at(-1));
const symbolId = symbols?.hits?.[0]?.nodeId ?? symbols?.[0]?.nodeId ?? null;
const symbolFile = symbols?.hits?.[0]?.locator?.filePath ?? "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts";
const symbolBranch = symbols?.hits?.[0]?.locator?.branch ?? "brazil-v2";
if (symbolId) {
  run("Q3-context-symbol", ["context", `node:${symbolId}`, "--repo", repo, "--json"]);
  run("Q3-flow-symbol", ["flow", `node:${symbolId}`, "--repo", repo, "--json"]);
  run("Q3-callers-symbol", ["callers", `node:${symbolId}`, "--repo", repo, "--json"]);
  run("Q3-callees-symbol", ["callees", `node:${symbolId}`, "--repo", repo, "--json"]);
  run("Q3-affected-symbol", ["affected", `node:${symbolId}`, "--repo", repo, "--json"]);
} else {
  rows.push({ name: "Q3-symbol-extraction", args: [], exitCode: 1, durationMs: 0, stdout: "", stderr: "search emitted no nodeId" });
}
const fileSymbolsPage1 = run("Q12-filesymbols-page1", ["filesymbols", repo, symbolBranch, symbolFile, "--limit", "3", "--json"]);
const fileSymbols = json(fileSymbolsPage1);
if (fileSymbols?.nextCursor) run("Q12-filesymbols-page2", ["filesymbols", repo, symbolBranch, symbolFile, "--limit", "3", "--cursor", fileSymbols.nextCursor, "--json"]);

const endpointPage1 = run("Q5-endpoints-page1", ["endpoints", repo, "--protocol", "grpc", "--limit", "3", "--json"]);
const page1 = json(endpointPage1);
const endpointPage2 = page1?.nextCursor
  ? run("Q5-endpoints-page2", ["endpoints", repo, "--protocol", "grpc", "--limit", "3", "--cursor", page1.nextCursor, "--json"])
  : null;
const page2 = endpointPage2 ? json(endpointPage2) : null;
const endpoint = page2?.items?.[0] ?? page1?.items?.[0] ?? null;
if (endpoint?.nodeId) {
  run("Q6-endpoint-identity", ["endpoint-identity", endpoint.title, endpoint.identityKey, endpoint.nodeId, "--json"]);
  run("Q6-context-endpoint", ["context", `node:${endpoint.nodeId}`, "--repo", repo, "--json"]);
  run("Q6-flow-endpoint", ["flow", `node:${endpoint.nodeId}`, "--repo", repo, "--json"]);
  run("Q7-callees-endpoint", ["callees", `node:${endpoint.nodeId}`, "--repo", repo, "--json"]);
} else {
  rows.push({ name: "Q5-endpoint-extraction", args: [], exitCode: 1, durationMs: 0, stdout: "", stderr: "endpoint inventory emitted no nodeId" });
}

run("Q12-endpoints-invalid-cursor", ["endpoints", repo, "--protocol", "grpc", "--cursor", "bad", "--json"]);
run("Q12-filesymbols-invalid-cursor", ["filesymbols", repo, "brazil-v2", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--cursor", "bad", "--json"]);
run("Q12-deadcode-page", ["deadcode", "--repo", repo, "--limit", "3", "--json"]);
const dead = json(rows.at(-1));
if (dead?.nextCursor) run("Q12-deadcode-page2", ["deadcode", "--repo", repo, "--limit", "3", "--cursor", dead.nextCursor, "--json"]);
run("Q16-invalid-node", ["context", "node:round14-invalid", "--repo", repo, "--json"]);
run("Q16-invalid-endpoint", ["flow", "grpc::Round14InvalidService.invalid", "--repo", repo, "--json"]);
run("Q17-help-callees", ["callees", symbolId ? `node:${symbolId}` : "round14-invalid", "--repo", repo, "--json"]);
const mcpRequests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "round14", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "knowledge_capabilities", arguments: {} } },
];
runMcp("Q14-MCP-fresh-session", mcpRequests);
runMcp("Q17-MCP-second-fresh-session", mcpRequests);

const expectedNonZero = new Set(["Q12-endpoints-invalid-cursor", "Q12-filesymbols-invalid-cursor", "Q16-invalid-node", "Q16-invalid-endpoint"]);
const unexpected = rows.filter((row) => row.exitCode !== 0 && !expectedNonZero.has(row.name));
const markdown = [
  "# Penguin Round 14 Automated Retest", "", `- Bundle: \`${bundle}\``, `- Runtime: \`${runtime}\``, `- Repository: \`${repo}\``, `- Cases: ${rows.length}`, `- Unexpected failures: ${unexpected.length}`, "",
  "## Evidence", "", ...rows.flatMap((row) => [
    `### ${row.name}`, `- command: \`${row.args.join(" ")}\``, `- exitCode: \`${row.exitCode}\`; durationMs: \`${row.durationMs}\``, "```text", `${row.stdout}${row.stderr ? `\n[stderr]\n${row.stderr}` : ""}`.slice(0, 12000), "```", "",
  ]), "## Gate", "", unexpected.length ? `FAIL: ${unexpected.length} unexpected case(s).` : "PASS: repaired CLI contract and dynamic handoffs completed; expected negative cases may return non-zero.", "",
];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, markdown.join("\n"));
console.log(JSON.stringify({ report, commandCount: rows.length, unexpectedFailures: unexpected.length }, null, 2));
process.exit(unexpected.length ? 1 : 0);
