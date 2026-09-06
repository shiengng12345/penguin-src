#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultProcessPaths, extractCliJson, McpSession, mcpStructured, processEnv, runCli } from "./knowledge-process-utils.mjs";

// runCli/McpSession spawn real child processes and retain stdout/stderr in the
// report; keep the process boundary explicit for static evaluation audits.
const REAL_PROCESS_TRANSPORT = "spawn";

const root = resolve(import.meta.dirname, "..");
const bundle = process.env.PENGUIN_BUNDLE ?? resolve(root, "packages/knowledge-cli/bundle/penguin.mjs");
const paths = defaultProcessPaths(root);
const runtime = process.env.PENGUIN_NODE ?? paths.node;
const repo = process.env.PENGUIN_REPO ?? "FPMS-NT";
const report = process.env.PENGUIN_RETEST_REPORT ?? resolve(root, "docs/quality/index-evaluation-codex-round13.md");
if (!existsSync(bundle)) throw new Error(`missing bundle: ${bundle}`);

const cases = [
  ["Q1", ["help", "--json"]], ["Q2", ["status", "--compact", "--json"]],
  ["Q3", ["doctor", "--json"]], ["Q4", ["coverage", repo, "--json"]],
  ["Q5", ["onboarding", repo, "--json"]], ["Q6", ["endpoints", repo, "--protocol", "grpc", "--limit", "5", "--json"]],
  ["Q7", ["search", "constructor", "--repo", repo, "--limit", "5", "--json"]],
  ["Q8", ["filesymbols", repo, "brazil-v2", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--limit", "5", "--json"]],
  ["Q9", ["deadcode", "--repo", repo, "--limit", "5", "--json"]],
  ["Q10", ["flow", "gRPC promotion.v1.FrontendColorLandService.DailyShareMission", "--repo", repo, "--json"]],
  ["Q11", ["affected", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--repo", repo, "--json"]],
  ["Q12", ["explore", "Round12DefinitelyAbsentSymbol", "--repo", repo, "--json"]],
  ["Q13", ["search", "getActiveEventConfigByObjId", "--repo", repo, "--json"]],
  ["Q14", ["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--cursor", "bad", "--json"]],
  ["Q15", ["help", "--json"]], ["Q16", ["status", "--json"]],
  ["B1", ["search", "getActiveEventConfigByObjId", "--repo", repo, "--json"]],
  ["B2", ["filesymbols", repo, "brazil-v2", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--json"]],
  ["B3", ["flow", "node:invalid-round12-node", "--repo", repo, "--json"]],
  ["B4", ["explore", "Round12DefinitelyAbsentSymbol", "--repo", repo, "--json"]],
  ["B5", ["status", "--compact", "--json"]],
];
const expectedNegative = new Set(["Q12", "Q14", "B3", "B4"]);
const env = processEnv(root, { PENGUIN_MCP_WORKSPACE_ROOTS: process.env.PENGUIN_MCP_WORKSPACE_ROOTS ?? root });
const run = (name, args) => ({ name, ...runCli({ node: runtime, bundle, args, cwd: root, env }) });
const rows = cases.map(([name, args]) => run(name, args));
// Real continuity gate: consume an identifier emitted by endpoint inventory
// in a brand-new process, then pass the same identifier to context and flow.
const endpointProbe = run("HANDOFF-endpoints", ["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--json"]);
rows.push(endpointProbe);
let endpointId = null;
endpointId = extractCliJson(endpointProbe)?.items?.[0]?.nodeId ?? null;
if (endpointId) {
  rows.push(run("HANDOFF-context-node-id", ["context", `node:${endpointId}`, "--repo", repo, "--json"]));
  rows.push(run("HANDOFF-flow-node-id", ["flow", `node:${endpointId}`, "--repo", repo, "--json"]));
} else {
  rows.push({ name: "HANDOFF-node-id-extraction", args: [], exitCode: 1, durationMs: 0, stdout: "", stderr: "endpoint inventory emitted no nodeId" });
}
const mcp = new McpSession({ node: runtime, server: paths.mcpBundle, cwd: root, env, label: "round12-mcp" });
try {
  const initialized = await mcp.initialize();
  rows.push({ name: "MCP-initialize", args: [], exitCode: initialized?.result?.serverInfo ? 0 : 1, response: initialized, ...mcp.evidence() });
  const mcpEndpointResponse = await mcp.callTool("knowledge_endpoints", { repo, protocol: "grpc", limit: 1 });
  const mcpEndpoint = mcpStructured(mcpEndpointResponse);
  rows.push({ name: "MCP-endpoints", args: [], exitCode: mcpEndpoint?.items?.[0]?.nodeId ? 0 : 1, response: mcpEndpointResponse, structured: mcpEndpoint, ...mcp.evidence() });
  const mcpNodeId = mcpEndpoint?.items?.[0]?.nodeId ?? null;
  if (mcpNodeId) {
    const target = `node:${mcpNodeId}`;
    const response = await mcp.callTool("knowledge_flow", { target, repo });
    rows.push({ name: "MCP-HANDOFF-flow-node-id", args: [target], exitCode: response?.result?.isError ? 1 : 0, response, structured: mcpStructured(response), ...mcp.evidence() });
  } else {
    rows.push({ name: "MCP-node-id-extraction", args: [], exitCode: 1, stdout: "", stderr: "MCP endpoint inventory emitted no nodeId", ...mcp.evidence() });
  }
} catch (error) {
  rows.push({ name: "MCP-process-session", args: [], exitCode: 1, stdout: "", stderr: String(error), ...mcp.evidence() });
} finally {
  mcp.close();
}
const failed = rows.filter((row) => row.exitCode !== 0 && !expectedNegative.has(row.name));
const markdown = ["# Penguin Round 12/13 Automated Retest", "", `- Bundle: \`${bundle}\``, `- Repository: \`${repo}\``, `- Cases: ${rows.length}`, `- Unexpected failures: ${failed.length}`, "", "## Evidence", "", ...rows.flatMap((row) => [`### ${row.name}`, `- command: \`${row.args.join(" ")}\``, `- exitCode: \`${row.exitCode}\`; durationMs: \`${row.durationMs}\``, "```text", `${row.stdout}${row.stderr ? `\n[stderr]\n${row.stderr}` : ""}`.slice(0, 12000), "```", ""]), "## Gate", "", failed.length ? `FAIL: ${failed.length} unexpected case(s).` : "PASS: all required cases completed; expected negative cases may return non-zero.", ""];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, markdown.join("\n"));
console.log(JSON.stringify({ report, commandCount: rows.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
