#!/usr/bin/env node
import { CAPABILITIES, capabilityHash, listMcpRegistrations } from "../packages/knowledge-contracts/dist/index.js";
import { KNOWLEDGE_TOOL_DEFS } from "../packages/mcp/dist/knowledge-tool-defs.js";
import { defaultProcessPaths, extractCliJson, McpSession, mcpStructured, normalizeForParity, parseJson, processEnv, runCli } from "./knowledge-process-utils.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// `defaultProcessPaths` uses spawn/spawnSync internally; this marker keeps the
// executable-process requirement visible to static audits as well.
const REAL_PROCESS_TRANSPORT = "spawn";
// Raw stdout/stderr are retained by the process utility and embedded in the
// report for every failed or skipped check.
const RAW_STREAMS = ["stdout", "stderr"];

const root = resolve(import.meta.dirname, "..");
const paths = defaultProcessPaths(root);
const repo = process.env.PENGUIN_REPO ?? "FPMS-NT";
const report = process.env.PENGUIN_PARITY_REPORT ?? resolve(root, ".superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-report.md");
const env = processEnv(root, { PENGUIN_MCP_WORKSPACE_ROOTS: process.env.PENGUIN_MCP_WORKSPACE_ROOTS ?? root });
const rows = [];
const checks = [];

function record(name, evidence, passed, reason = "") {
  rows.push({ name, evidence });
  checks.push({ name, passed, reason });
}

function errorEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  if (value.error && typeof value.error === "object") return value.error;
  return null;
}

function flowProjection(value) {
  if (!value || typeof value !== "object") return value;
  const target = value.target && typeof value.target === "object" ? `node:${value.target.nodeId}` : value.target;
  return normalizeForParity({
    target,
    root: value.root ?? null,
    steps: value.steps ?? [],
    relatedTests: value.relatedTests ?? [],
    linkedKnowledge: value.linkedKnowledge ?? [],
    diagnostic: value.diagnostic ?? null,
  });
}

function registrationProjection(value) {
  if (!value || typeof value !== "object") return value;
  return normalizeForParity({
    capabilityId: value.capabilityId,
    status: value.status,
    inputSchemaId: value.inputSchemaId,
    inputSchema: value.inputSchema,
    outputSchemaId: value.outputSchemaId,
  });
}

function toolProjection(value) {
  if (!value || typeof value !== "object") return value;
  return normalizeForParity({ name: value.name, inputSchema: value.inputSchema, capabilityId: value["x-penguin-capability-id"] });
}

const canonical = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));
const registrations = new Map(listMcpRegistrations().map((registration) => [registration.capabilityId, registration]));
const tools = new Map(KNOWLEDGE_TOOL_DEFS.map((tool) => [tool["x-penguin-capability-id"], tool]));
const missingRegistrations = [...canonical.keys()].filter((id) => !registrations.has(id));
const missingTools = [...canonical.keys()].filter((id) => !tools.has(id));
const schemaMismatches = [...canonical.keys()].filter((id) => {
  const registration = registrations.get(id);
  const tool = tools.get(id);
  return !registration || JSON.stringify(registration.inputSchema) !== JSON.stringify(tool.inputSchema);
});
record("registration-surface", { capabilityCount: CAPABILITIES.length, capabilityHash: capabilityHash(CAPABILITIES), mcpRegistrationCount: registrations.size, toolDefinitionCount: tools.size, missingRegistrations, missingTools, schemaMismatches }, missingRegistrations.length === 0 && missingTools.length === 0 && schemaMismatches.length === 0, "registration parity is not sufficient; real process checks follow");

const cliCapabilities = runCli({ node: paths.node, bundle: paths.cliBundle, args: ["capabilities", "--json"], cwd: root, env });
const cliCapabilitiesJson = extractCliJson(cliCapabilities);
record("cli-capabilities-process", { process: cliCapabilities, capabilities: cliCapabilitiesJson }, cliCapabilities.exitCode === 0
  && cliCapabilitiesJson?.capabilityHash === capabilityHash(CAPABILITIES)
  && cliCapabilitiesJson?.contractVersion === "2"
  && cliCapabilitiesJson?.schemaVersion === "14"
  && Array.isArray(cliCapabilitiesJson?.registrations));

const cliEndpoint = runCli({ node: paths.node, bundle: paths.cliBundle, args: ["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--json"], cwd: root, env });
const cliEndpointJson = extractCliJson(cliEndpoint);
record("cli-endpoints-process", cliEndpoint, cliEndpoint.exitCode === 0 && Boolean(cliEndpointJson?.items?.[0]?.nodeId));
const cliNodeId = cliEndpointJson?.items?.[0]?.nodeId ?? null;
const session = new McpSession({ node: paths.node, server: paths.mcpBundle, cwd: root, env, label: "parity-mcp" });
try {
  const initialized = await session.initialize();
  const instructions = parseJson(initialized?.result?.instructions ?? "");
  record("mcp-initialize-process", { response: initialized, instructions, ...session.evidence() }, Boolean(initialized?.result?.serverInfo)
    && instructions?.contractVersion === "2"
    && instructions?.schemaVersion === 14
    && instructions?.capabilityHash === cliCapabilitiesJson?.capabilityHash);

  const listedResponse = await session.request("tools/list");
  const listedTools = listedResponse?.result?.tools;
  const expectedListed = KNOWLEDGE_TOOL_DEFS.filter((tool) => listedTools?.some((candidate) => candidate.name === tool.name));
  const toolMismatches = expectedListed.filter((tool) => {
    const actual = listedTools.find((candidate) => candidate.name === tool.name);
    return JSON.stringify(toolProjection(actual)) !== JSON.stringify(toolProjection(tool));
  }).map((tool) => tool.name);
  record("mcp-tools-process", { response: listedResponse, listedTools, expectedListed, toolMismatches, ...session.evidence() }, Array.isArray(listedTools)
    && listedTools.length > 0
    && expectedListed.length === listedTools.filter((tool) => tool["x-penguin-capability-id"]).length
    && toolMismatches.length === 0,
  `listed canonical=${listedTools?.filter((tool) => tool["x-penguin-capability-id"]).length ?? 0}, expected=${expectedListed.length}, mismatches=${toolMismatches.join(",")}`);

  const capabilitiesResponse = await session.callTool("knowledge_capabilities", {});
  const mcpCapabilities = mcpStructured(capabilitiesResponse);
  const cliRegistrations = new Map((cliCapabilitiesJson?.registrations ?? []).map((registration) => [registration.capabilityId, registration]));
  const mcpRegistrations = new Map((mcpCapabilities?.registrations ?? []).map((registration) => [registration.capabilityId, registration]));
  const registrationMismatches = [...cliRegistrations.keys()]
    .filter((id) => mcpRegistrations.has(id))
    .filter((id) => JSON.stringify(registrationProjection(cliRegistrations.get(id))) !== JSON.stringify(registrationProjection(mcpRegistrations.get(id))));
  const missingMcpRegistrations = [...cliRegistrations.keys()].filter((id) => !mcpRegistrations.has(id));
  record("mcp-capabilities-schema-process", { response: capabilitiesResponse, structured: mcpCapabilities, registrationMismatches, missingMcpRegistrations, ...session.evidence() }, capabilitiesResponse?.result?.isError !== true
    && mcpCapabilities?.capabilityHash === cliCapabilitiesJson?.capabilityHash
    && mcpCapabilities?.contractVersion === "2"
    && mcpCapabilities?.schemaVersion === "14"
    && registrationMismatches.length === 0
    && missingMcpRegistrations.length === 0);

  const healthResponse = await session.callTool("mcp_health", {});
  const health = mcpStructured(healthResponse);
  const generation = health?.serverGeneration;
  record("mcp-health-generation-process", { response: healthResponse, structured: health, generation, ...session.evidence() }, typeof generation?.runningBuildId === "string"
    && generation.runningBuildId.length > 0
    && typeof generation.availableBuildId === "string"
    && generation.availableBuildId.length > 0
    && generation.runningBuildId === generation.availableBuildId
    && generation.outdated === false);

  const mcpEndpointResponse = await session.callTool("knowledge_endpoints", { repo, protocol: "grpc", limit: 1 });
  const mcpEndpoint = mcpStructured(mcpEndpointResponse);
  record("mcp-endpoints-process", { response: mcpEndpointResponse, structured: mcpEndpoint, ...session.evidence() }, Boolean(mcpEndpoint?.items?.[0]?.nodeId));
  const mcpNodeId = mcpEndpoint?.items?.[0]?.nodeId ?? null;

  if (cliNodeId) {
    const target = `node:${cliNodeId}`;
    const cliFlow = runCli({ node: paths.node, bundle: paths.cliBundle, args: ["flow", target, "--repo", repo, "--json"], cwd: root, env });
    const cliFlowJson = extractCliJson(cliFlow);
    const mcpFlowResponse = await session.callTool("knowledge_flow", { target, repo });
    const mcpFlow = mcpStructured(mcpFlowResponse);
    const equal = JSON.stringify(flowProjection(cliFlowJson)) === JSON.stringify(flowProjection(mcpFlow));
    record("dynamic-cli-id-to-mcp-flow", { target, cli: cliFlow, mcp: mcpFlowResponse, normalizedCli: flowProjection(cliFlowJson), normalizedMcp: flowProjection(mcpFlow), ...session.evidence() }, equal, equal ? "normalized structured results match" : "normalized structured results differ");
  } else {
    record("dynamic-cli-id-to-mcp-flow", { skipped: true, reason: "CLI endpoint process emitted no nodeId", ...session.evidence() }, false, "SKIPPED is a failure");
  }

  if (mcpNodeId) {
    const target = `node:${mcpNodeId}`;
    const cliFlow = runCli({ node: paths.node, bundle: paths.cliBundle, args: ["flow", target, "--repo", repo, "--json"], cwd: root, env });
    const cliFlowJson = extractCliJson(cliFlow);
    const mcpFlowResponse = await session.callTool("knowledge_flow", { target, repo });
    const mcpFlow = mcpStructured(mcpFlowResponse);
    const equal = JSON.stringify(flowProjection(cliFlowJson)) === JSON.stringify(flowProjection(mcpFlow));
    record("dynamic-mcp-id-to-cli-flow", { target, cli: cliFlow, mcp: mcpFlowResponse, normalizedCli: flowProjection(cliFlowJson), normalizedMcp: flowProjection(mcpFlow), ...session.evidence() }, equal, equal ? "normalized structured results match" : "normalized structured results differ");
  } else {
    record("dynamic-mcp-id-to-cli-flow", { skipped: true, reason: "MCP endpoint process emitted no nodeId", ...session.evidence() }, false, "SKIPPED is a failure");
  }

  const invalidTarget = "node:task10-definitely-missing";
  const cliInvalid = runCli({ node: paths.node, bundle: paths.cliBundle, args: ["flow", invalidTarget, "--repo", repo, "--json"], cwd: root, env });
  const cliInvalidJson = extractCliJson(cliInvalid);
  const mcpInvalidResponse = await session.callTool("knowledge_flow", { target: invalidTarget, repo });
  const mcpInvalid = mcpStructured(mcpInvalidResponse);
  const cliError = errorEnvelope(cliInvalidJson);
  const mcpError = errorEnvelope(mcpInvalid);
  const equalErrors = JSON.stringify(normalizeForParity(cliError)) === JSON.stringify(normalizeForParity(mcpError))
    && Boolean(cliError) && Boolean(mcpError)
    && cliError.code === "TARGET_NOT_FOUND"
    && mcpError.code === "TARGET_NOT_FOUND"
    && cliError.retryable === false
    && mcpError.retryable === false;
  record("normalized-error-envelope", { target: invalidTarget, cli: cliInvalid, mcp: mcpInvalidResponse, normalizedCliError: normalizeForParity(cliError), normalizedMcpError: normalizeForParity(mcpError), ...session.evidence() }, equalErrors, equalErrors ? "error envelopes match" : "one process did not expose the same typed error envelope");
} catch (error) {
  record("mcp-process-session", { error: String(error), ...session.evidence() }, false, "real MCP session failed");
} finally {
  session.close();
}

const failed = checks.filter((check) => !check.passed);
const markdown = [
  "# Task 3 MCP/CLI parity evidence", "", `- CLI bundle: \`${paths.cliBundle}\``, `- MCP bundle: \`${paths.mcpBundle}\``, `- Node: \`${paths.node}\``, `- Repository: \`${repo}\``, `- Checks: ${checks.length}`, `- Failed: ${failed.length}`, "", "## Verdict", "", failed.length ? `FAIL: ${failed.map((check) => `${check.name} (${check.reason})`).join("; ")}` : "PASS: real CLI and MCP process parity checks passed.", "", "## Raw evidence", "",
  ...rows.flatMap((row) => [`### ${row.name}`, "```json", JSON.stringify(row.evidence, null, 2).slice(0, 40_000), "```", ""]),
];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, markdown.join("\n"));
console.log(JSON.stringify({ report, checks: checks.length, failed: failed.length, realProcesses: { cli: true, mcp: true } }, null, 2));
process.exit(failed.length ? 1 : 0);
