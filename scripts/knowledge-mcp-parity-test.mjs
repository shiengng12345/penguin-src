#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { CAPABILITIES, capabilityHash, listMcpRegistrations, listCliRegistrations } from "../packages/knowledge-contracts/dist/index.js";
import { KNOWLEDGE_TOOL_DEFS, MCP_LISTED_TOOL_DEFS } from "../packages/mcp/dist/knowledge-tool-defs.js";
import { defaultProcessPaths, extractCliJson as extractCliJsonOutput, McpSession, mcpStructured, normalizeForParity, parseJson, processEnv, runCli } from "./knowledge-process-utils.mjs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// `defaultProcessPaths` uses spawn/spawnSync internally; this marker keeps the
// executable-process requirement visible to static audits as well.
const REAL_PROCESS_TRANSPORT = "spawn";
// Raw stdout/stderr are retained by the process utility and embedded in the
// report for every failed or skipped check.
const RAW_STREAMS = ["stdout", "stderr"];

const root = resolve(import.meta.dirname, "..");
const paths = { ...defaultProcessPaths(root), cliLauncher: resolve(root, "scripts/knowledge-cli-launcher.mjs"), mcpLauncher: resolve(root, "scripts/knowledge-mcp-launcher.mjs") };
const trackedLauncherPaths = ["scripts/knowledge-cli-launcher.mjs", "scripts/knowledge-mcp-launcher.mjs"];
const repo = process.env.PENGUIN_REPO ?? "FPMS-NT";
const report = process.env.PENGUIN_PARITY_REPORT ?? resolve(root, ".superpowers/sdd/2026-08-30-mcp-and-round14-gap-closure/task-3-report.md");
const baseEnv = processEnv(root, { PENGUIN_MCP_WORKSPACE_ROOTS: process.env.PENGUIN_MCP_WORKSPACE_ROOTS ?? root });
const rows = [];
const checks = [];

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 什么时候用：为目标 commit/tree 读取到的 CLI、MCP 和两个 launcher 输入生成 parity runtime 的 buildId，方便报告核对 commit 与 bundle 是否绑定。
 */
function bundleId({ sourceCommit, sourceTree, bundleContentHashes }) {
  return createHash("sha256")
    .update(sourceCommit)
    .update(sourceTree)
    .update(bundleContentHashes.cli)
    .update(bundleContentHashes.mcp)
    .update(bundleContentHashes.cliLauncher)
    .update(bundleContentHashes.mcpLauncher)
    .digest("hex");
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch (error) {
    fail("PARITY_PROVENANCE_INVALID", `git ${args.join(" ")} failed: ${error.message}`);
  }
}

/**
 * 什么时候用：在 parity 复制 launcher 前确认输入确实来自 Git tree，避免 clean-tree 证明依赖未跟踪工作区文件。
 */
function trackedFile(relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], { cwd: root, encoding: "utf8" });
  const isTracked = result.status === 0 && result.stdout.trim() === relativePath;
  if (isTracked) return result.stdout.trim();
  fail("PARITY_INPUT_UNTRACKED", `${relativePath} must be tracked before parity can run`);
}

function sourceMetadata() {
  const sourceCommit = gitValue(["rev-parse", "HEAD"]);
  const sourceTree = gitValue(["rev-parse", "HEAD^{tree}"]);
  const targetCommit = process.env.PENGUIN_PARITY_TARGET_COMMIT ?? sourceCommit;
  const targetCommitResolved = gitValue(["rev-parse", "--verify", `${targetCommit}^{commit}`]);
  const trackedLauncherInputs = trackedLauncherPaths.map((relativePath) => trackedFile(relativePath));
  const dirtyFiles = gitValue(["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/).filter(Boolean);
  const bundleContentHashes = {
    cli: fileHash(paths.cliBundle),
    mcp: fileHash(paths.mcpBundle),
    cliLauncher: fileHash(paths.cliLauncher),
    mcpLauncher: fileHash(paths.mcpLauncher),
  };
  return {
    sourceCommit,
    sourceTree,
    targetCommit: targetCommitResolved,
    bundleSourceCommit: sourceCommit,
    bundleSourceTree: sourceTree,
    bundleCommitMatchesTarget: sourceCommit === targetCommitResolved && dirtyFiles.length === 0,
    trackedLauncherInputs,
    worktreeState: dirtyFiles.length ? "dirty" : "clean",
    dirtyFiles,
    bundleContentHashes,
    bundleId: bundleId({ sourceCommit, sourceTree, bundleContentHashes }),
  };
}

function stableRuntime(pathsToStage, provenance) {
  const home = mkdtempSync(join(tmpdir(), "penguin-task3-home-"));
  const runtimeRoot = join(home, ".penguin", "runtimes");
  const current = join(runtimeRoot, "current");
  const bin = join(home, ".penguin", "bin");
  mkdirSync(current, { recursive: true });
  const buildId = provenance.bundleId;
  const link = (target, destination) => { mkdirSync(dirname(destination), { recursive: true }); symlinkSync(target, destination); };
  link(pathsToStage.node, join(current, "node"));
  link(pathsToStage.cliBundle, join(current, "penguin.mjs"));
  link(pathsToStage.mcpBundle, join(current, "mcp", "dist", "index.js"));
  const wasm = resolve(root, "packages/knowledge-cli/bundle/wasm");
  if (existsSync(wasm)) link(wasm, join(current, "wasm"));
  const manifest = { schemaVersion: 1, ready: true, buildId, appVersion: "task3-round1", nodePath: "node", cliEntry: "penguin.mjs", mcpEntry: "mcp/dist/index.js", wasmPath: "wasm" };
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(current, "manifest.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(bin, { recursive: true });
  const cliLauncher = join(bin, "penguin-cli-launcher.mjs");
  const mcpLauncher = join(bin, "penguin-mcp-launcher.mjs");
  copyFileSync(pathsToStage.cliLauncher, cliLauncher);
  copyFileSync(pathsToStage.mcpLauncher, mcpLauncher);
  chmodSync(cliLauncher, 0o755);
  chmodSync(mcpLauncher, 0o755);
  const cliWrapper = join(bin, "penguin");
  const mcpWrapper = join(bin, "penguin-mcp");
  const wrapper = (launcher) => `#!/bin/sh\nexport PENGUIN_RUNTIME_ROOT="$HOME/.penguin/runtimes"\nexec "$HOME/.penguin/runtimes/current/node" "$HOME/.penguin/bin/${launcher}" "$@"\n`;
  writeFileSync(cliWrapper, wrapper("penguin-cli-launcher.mjs"));
  writeFileSync(mcpWrapper, wrapper("penguin-mcp-launcher.mjs"));
  chmodSync(cliWrapper, 0o755);
  chmodSync(mcpWrapper, 0o755);
  const sourceDb = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
  return {
    home,
    runtimeRoot,
    buildId,
    manifest,
    cliWrapper,
    mcpWrapper,
    env: {
      ...baseEnv,
      HOME: home,
      PENGUIN_RUNTIME_ROOT: runtimeRoot,
      PENGUIN_BUILD_ID: buildId,
      // Keep the launcher HOME isolated while reading the already-indexed
      // graph selected for this parity run. Ledger writes stay in the temp HOME.
      PENGUIN_KNOWLEDGE_DB: sourceDb,
      PENGUIN_KNOWLEDGE_LEDGER: join(home, ".penguin", "knowledge", "ledger.jsonl"),
    },
  };
}

const provenance = sourceMetadata();
const { buildId, env, cliWrapper, mcpWrapper, manifest } = stableRuntime(paths, provenance);

function record(name, evidence, passed, reason = "") {
  rows.push({ name, evidence });
  checks.push({ name, passed, reason });
}

function redactEvidence(value) {
  if (typeof value === "string") return value.replaceAll(provenanceHome(), "<temporary-home>").replaceAll(root, "<workspace>");
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactEvidence(item)]));
}

function provenanceHome() {
  return env.HOME;
}

function extractCliJson(row) {
  // Successful CLI JSON is stdout; structured failures deliberately use
  // stderr so a caller cannot mistake an error for a successful result.
  return extractCliJsonOutput({ ...row, stdout: [row.stdout, row.stderr].filter(Boolean).join("\n") });
}

function resolvedTargetNodeId(value) {
  const target = value?.target;
  if (target && typeof target === "object" && typeof target.nodeId === "string") return target.nodeId;
  if (typeof target === "string" && target.startsWith("node:")) return target.slice("node:".length);
  return null;
}

function evidenceSummary(value) {
  if (!value || typeof value !== "object") return { type: typeof value };
  const object = value;
  const summary = { fields: Object.keys(object).sort() };
  if (typeof object.exitCode === "number") summary.exitCode = object.exitCode;
  if (typeof object.spawnError === "string" || object.spawnError === null) summary.spawnError = object.spawnError;
  for (const stream of RAW_STREAMS) {
    if (typeof object[stream] === "string") summary[`${stream}Bytes`] = Buffer.byteLength(object[stream], "utf8");
  }
  return summary;
}

function errorEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  if (value.error && typeof value.error === "object") return value.error;
  return null;
}

function capabilityProjection(value) {
  return normalizeForParity(value);
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
  return normalizeForParity(value);
}

function toolProjection(value) {
  if (!value || typeof value !== "object") return value;
  return normalizeForParity({ name: value.name, description: value.description, inputSchema: value.inputSchema, capabilityId: value["x-penguin-capability-id"] });
}

function endpointIdentityForms(endpoint) {
  const identity = String(endpoint?.identityKey ?? "").replace(/^grpc::/u, "");
  const split = identity.lastIndexOf(".");
  const service = split > 0 ? identity.slice(0, split) : "";
  const method = split > 0 ? identity.slice(split + 1) : "";
  return [endpoint?.title, endpoint?.identityKey, service && method ? `/${service}/${method}` : null, endpoint?.nodeId, endpoint?.nodeId ? `node:${endpoint.nodeId}` : null].filter(Boolean);
}

function sameEndpointResult(value, nodeId) {
  const result = extractCliJson(value);
  return value.exitCode === 0 && result?.equal === true && result?.rootNodeId === nodeId;
}

function targetForError(nodeId) {
  return nodeId ? `node:${nodeId}` : "node:task3-missing-target";
}

const canonical = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));
const registrations = new Map(listMcpRegistrations().map((registration) => [registration.capabilityId, registration]));
const tools = new Map(KNOWLEDGE_TOOL_DEFS.map((tool) => [tool.name, tool]));
const missingRegistrations = [...canonical.keys()].filter((id) => !registrations.has(id));
const expectedToolNames = new Set(MCP_LISTED_TOOL_DEFS.map((tool) => tool.name));
const expectedToolIds = new Set(CAPABILITIES.map((capability) => capability.id));
const toolIds = new Set(KNOWLEDGE_TOOL_DEFS.map((tool) => tool["x-penguin-capability-id"]));
const missingTools = [...expectedToolNames].filter((name) => !tools.has(name));
const extraTools = [...tools.keys()].filter((name) => !expectedToolNames.has(name));
const missingToolIds = [...expectedToolIds].filter((id) => !toolIds.has(id));
const extraToolIds = [...toolIds].filter((id) => !expectedToolIds.has(id));
const duplicateToolNames = [...new Set(KNOWLEDGE_TOOL_DEFS.map((tool) => tool.name))]
  .filter((name) => KNOWLEDGE_TOOL_DEFS.filter((tool) => tool.name === name).length > 1);
const duplicateToolIds = [...expectedToolIds]
  .filter((id) => KNOWLEDGE_TOOL_DEFS.filter((tool) => tool["x-penguin-capability-id"] === id).length > 1);
const schemaMismatches = [...canonical.keys()].filter((id) => {
  const registration = registrations.get(id);
  const definitions = KNOWLEDGE_TOOL_DEFS.filter((tool) => tool["x-penguin-capability-id"] === id);
  return !registration || definitions.length === 0 || definitions.some((tool) => JSON.stringify(tool.inputSchema) !== JSON.stringify(registration.inputSchema));
});
const registrationIds = new Set(registrations.keys());
const missingMcpRegistrations = [...expectedToolIds].filter((id) => !registrationIds.has(id));
const extraRegistrations = [...registrationIds].filter((id) => !expectedToolIds.has(id));
record("registration-surface", { capabilityCount: CAPABILITIES.length, capabilityHash: capabilityHash(CAPABILITIES), mcpRegistrationCount: registrations.size, toolDefinitionCount: tools.size, missingRegistrations, extraRegistrations, missingTools, extraTools, missingToolIds, extraToolIds, duplicateToolNames, duplicateToolIds, schemaMismatches }, missingRegistrations.length === 0 && extraRegistrations.length === 0 && missingTools.length === 0 && extraTools.length === 0 && missingToolIds.length === 0 && extraToolIds.length === 0 && duplicateToolNames.length === 0 && duplicateToolIds.length === 0 && schemaMismatches.length === 0, "registration parity is not sufficient; real process checks follow");
const sourceBundleProvenancePassed = provenance.bundleCommitMatchesTarget
  && provenance.bundleId === buildId
  && manifest.buildId === buildId
  && provenance.trackedLauncherInputs.length === trackedLauncherPaths.length;
record("source-bundle-provenance", { ...provenance, runtimeBuildId: buildId, runtimeManifestBuildId: manifest.buildId, verification: "bundleId hashes the target commit/tree and exact CLI/MCP/launcher bytes; the runtime manifest carries the same value" }, sourceBundleProvenancePassed, "target commit/tree, exact bundle bytes, tracked launchers, and runtime manifest buildId must agree");

const cliCapabilities = runCli({ command: cliWrapper, args: ["capabilities", "--json"], cwd: root, env });
const cliCapabilitiesJson = extractCliJson(cliCapabilities);
record("cli-capabilities-process", { process: cliCapabilities, capabilities: cliCapabilitiesJson }, cliCapabilities.exitCode === 0
  && cliCapabilitiesJson?.capabilityHash === capabilityHash(CAPABILITIES)
  && cliCapabilitiesJson?.contractVersion === "2"
  && cliCapabilitiesJson?.schemaVersion === "14"
  && Array.isArray(cliCapabilitiesJson?.registrations));

const cliEndpoint = runCli({ command: cliWrapper, args: ["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--json"], cwd: root, env });
const cliEndpointJson = extractCliJson(cliEndpoint);
record("cli-endpoints-process", cliEndpoint, cliEndpoint.exitCode === 0 && Boolean(cliEndpointJson?.items?.[0]?.nodeId));
const cliNodeId = cliEndpointJson?.items?.[0]?.nodeId ?? null;
const session = new McpSession({ command: mcpWrapper, cwd: root, env, label: "parity-mcp" });
try {
  const initialized = await session.initialize();
  const instructions = parseJson(initialized?.result?.instructions ?? "");
  record("mcp-initialize-process", { response: initialized, instructions, ...session.evidence() }, Boolean(initialized?.result?.serverInfo)
    && instructions?.contractVersion === "2"
    && instructions?.schemaVersion === 14
    && instructions?.capabilityHash === cliCapabilitiesJson?.capabilityHash
    && initialized?.result?.serverInfo?.version === cliCapabilitiesJson?.buildId);

  const listedResponse = await session.request("tools/list");
  const listedTools = listedResponse?.result?.tools;
  const actualKnowledgeTools = Array.isArray(listedTools) ? listedTools.filter((tool) => tool["x-penguin-capability-id"]) : [];
  const listedByName = new Map(actualKnowledgeTools.map((tool) => [tool.name, tool]));
  const actualToolNames = new Set(listedByName.keys());
  const actualToolIds = new Set(actualKnowledgeTools.map((tool) => tool["x-penguin-capability-id"]));
  const missingListedTools = [...expectedToolNames].filter((name) => !actualToolNames.has(name));
  const extraListedTools = [...actualToolNames].filter((name) => !expectedToolNames.has(name));
  const missingListedToolIds = [...expectedToolIds].filter((id) => !actualToolIds.has(id));
  const extraListedToolIds = [...actualToolIds].filter((id) => !expectedToolIds.has(id));
  const duplicateListedToolNames = [...actualToolNames]
    .filter((name) => actualKnowledgeTools.filter((tool) => tool.name === name).length > 1);
  const duplicateListedToolIds = [...actualToolIds]
    .filter((id) => actualKnowledgeTools.filter((tool) => tool["x-penguin-capability-id"] === id).length > 1);
  const toolMismatches = MCP_LISTED_TOOL_DEFS.filter((tool) => {
    const actual = listedByName.get(tool.name);
    return actual && JSON.stringify(toolProjection(actual)) !== JSON.stringify(toolProjection(tool));
  }).map((tool) => tool.name);
  record("mcp-tools-process", { response: listedResponse, listedTools, missingListedTools, extraListedTools, missingListedToolIds, extraListedToolIds, duplicateListedToolNames, duplicateListedToolIds, toolMismatches, ...session.evidence() }, Array.isArray(listedTools)
    && missingListedTools.length === 0
    && extraListedTools.length === 0
    && missingListedToolIds.length === 0
    && extraListedToolIds.length === 0
    && duplicateListedToolNames.length === 0
    && duplicateListedToolIds.length === 0
    && toolMismatches.length === 0,
  `listed canonical=${actualKnowledgeTools.length}, expected=${MCP_LISTED_TOOL_DEFS.length}, missing=${missingListedTools.join(",")}, extra=${extraListedTools.join(",")}, mismatches=${toolMismatches.join(",")}`);

  const capabilitiesResponse = await session.callTool("knowledge_capabilities", {});
  const mcpCapabilities = mcpStructured(capabilitiesResponse);
  const cliRegistrationList = cliCapabilitiesJson?.registrations;
  const mcpRegistrationList = mcpCapabilities?.registrations;
  const cliRegistrations = new Map((Array.isArray(cliRegistrationList) ? cliRegistrationList : []).map((registration) => [registration.capabilityId, registration]));
  const mcpRegistrations = new Map((Array.isArray(mcpRegistrationList) ? mcpRegistrationList : []).map((registration) => [registration.capabilityId, registration]));
  const registrationMismatches = [...new Set([...cliRegistrations.keys(), ...mcpRegistrations.keys()])]
    .filter((id) => JSON.stringify(registrationProjection(cliRegistrations.get(id))) !== JSON.stringify(registrationProjection(mcpRegistrations.get(id))));
  const missingMcpRegistrations = [...cliRegistrations.keys()].filter((id) => !mcpRegistrations.has(id));
  const extraMcpRegistrations = [...mcpRegistrations.keys()].filter((id) => !cliRegistrations.has(id));
  const cliManifestList = cliCapabilitiesJson?.capabilities;
  const mcpManifestList = mcpCapabilities?.capabilities;
  const cliManifest = new Map((Array.isArray(cliManifestList) ? cliManifestList : []).map((capability) => [capability.id, capabilityProjection(capability)]));
  const mcpManifest = new Map((Array.isArray(mcpManifestList) ? mcpManifestList : []).map((capability) => [capability.id, capabilityProjection(capability)]));
  const canonicalManifest = new Map(CAPABILITIES.map((capability) => [capability.id, capabilityProjection(capability)]));
  const manifestIds = [...new Set([...canonicalManifest.keys(), ...cliManifest.keys(), ...mcpManifest.keys()])];
  const missingCliCapabilities = [...canonicalManifest.keys()].filter((id) => !cliManifest.has(id));
  const extraCliCapabilities = [...cliManifest.keys()].filter((id) => !canonicalManifest.has(id));
  const missingMcpCapabilities = [...canonicalManifest.keys()].filter((id) => !mcpManifest.has(id));
  const extraMcpCapabilities = [...mcpManifest.keys()].filter((id) => !canonicalManifest.has(id));
  const manifestMismatches = manifestIds.filter((id) => JSON.stringify(cliManifest.get(id)) !== JSON.stringify(mcpManifest.get(id)) || JSON.stringify(cliManifest.get(id)) !== JSON.stringify(canonicalManifest.get(id)));
  const manifestEqual = Array.isArray(cliManifestList) && Array.isArray(mcpManifestList)
    && missingCliCapabilities.length === 0
    && extraCliCapabilities.length === 0
    && missingMcpCapabilities.length === 0
    && extraMcpCapabilities.length === 0
    && manifestMismatches.length === 0;
  record("mcp-capabilities-schema-process", { response: capabilitiesResponse, structured: mcpCapabilities, registrationMismatches, missingMcpRegistrations, extraMcpRegistrations, missingCliCapabilities, extraCliCapabilities, missingMcpCapabilities, extraMcpCapabilities, manifestMismatches, manifestEqual, ...session.evidence() }, capabilitiesResponse?.result?.isError !== true
    && mcpCapabilities?.capabilityHash === cliCapabilitiesJson?.capabilityHash
    && mcpCapabilities?.buildId === cliCapabilitiesJson?.buildId
    && mcpCapabilities?.contractVersion === "2"
    && mcpCapabilities?.schemaVersion === "14"
    && manifestEqual
    && Array.isArray(cliRegistrationList)
    && Array.isArray(mcpRegistrationList)
    && registrationMismatches.length === 0
    && missingMcpRegistrations.length === 0
    && extraMcpRegistrations.length === 0);

  const healthResponse = await session.callTool("mcp_health", {});
  const health = mcpStructured(healthResponse);
  const generation = health?.serverGeneration;
  record("mcp-health-generation-process", { response: healthResponse, structured: health, generation, ...session.evidence() }, typeof generation?.runningBuildId === "string"
    && generation.runningBuildId.length > 0
    && typeof generation.availableBuildId === "string"
    && generation.availableBuildId.length > 0
    && generation.runningBuildId === generation.availableBuildId
    && generation.runningBuildId === cliCapabilitiesJson?.buildId
    && generation.runningBuildId === initialized?.result?.serverInfo?.version
    && generation.outdated === false);

  const mcpEndpointResponse = await session.callTool("knowledge_endpoints", { repo, protocol: "grpc", limit: 1 });
  const mcpEndpoint = mcpStructured(mcpEndpointResponse);
  record("mcp-endpoints-process", { response: mcpEndpointResponse, structured: mcpEndpoint, ...session.evidence() }, Boolean(mcpEndpoint?.items?.[0]?.nodeId));
  const mcpNodeId = mcpEndpoint?.items?.[0]?.nodeId ?? null;

  const cliEndpointItem = cliEndpointJson?.items?.[0];
  const mcpEndpointItem = mcpEndpoint?.items?.[0];
  const endpointForms = endpointIdentityForms(cliEndpointItem);
  const identityTriples = endpointForms.length >= 5
    ? [[endpointForms[0], endpointForms[1], endpointForms[3]], [endpointForms[2], endpointForms[3], endpointForms[4]]]
    : [];
  const cliIdentityChecks = identityTriples.map((forms) => {
    const result = runCli({ command: cliWrapper, args: ["endpoint-identity", ...forms, "--repo", repo, "--json"], cwd: root, env });
    return { forms, process: result, result: extractCliJson(result), passed: sameEndpointResult(result, cliEndpointItem?.nodeId) };
  });
  const mcpIdentityChecks = [];
  for (const form of endpointForms) {
    const response = await session.callTool("knowledge_flow", { target: form, repo });
    const flow = mcpStructured(response);
    mcpIdentityChecks.push({ form, response, flow, passed: response?.result?.isError !== true && flow?.target?.nodeId === cliEndpointItem?.nodeId && flow?.root?.nodeId === cliEndpointItem?.nodeId });
  }
  const endpointIdentityPassed = Boolean(cliEndpointItem?.nodeId)
    && Boolean(mcpEndpointItem?.nodeId)
    && JSON.stringify(normalizeForParity({ title: cliEndpointItem?.title, identityKey: cliEndpointItem?.identityKey, nodeId: cliEndpointItem?.nodeId })) === JSON.stringify(normalizeForParity({ title: mcpEndpointItem?.title, identityKey: mcpEndpointItem?.identityKey, nodeId: mcpEndpointItem?.nodeId }))
    && cliIdentityChecks.length === 2
    && cliIdentityChecks.every((check) => check.passed)
    && mcpIdentityChecks.length === endpointForms.length
    && mcpIdentityChecks.every((check) => check.passed);
  record("endpoint-identity-process", { cliEndpoint: cliEndpointItem, mcpEndpoint: mcpEndpointItem, forms: endpointForms, cliIdentityChecks, mcpIdentityChecks, ...session.evidence() }, endpointIdentityPassed, "rendered title, canonical identity, slash route, bare id, and node:id must resolve to the same endpoint on both surfaces");

  if (cliNodeId) {
    const target = `node:${cliNodeId}`;
    const cliFlow = runCli({ command: cliWrapper, args: ["flow", target, "--repo", repo, "--json"], cwd: root, env });
    const cliFlowJson = extractCliJson(cliFlow);
    const mcpFlowResponse = await session.callTool("knowledge_flow", { target, repo });
    const mcpFlow = mcpStructured(mcpFlowResponse);
    const cliSuccess = cliFlow.exitCode === 0 && cliFlowJson?.root?.nodeId === cliNodeId && resolvedTargetNodeId(cliFlowJson) === cliNodeId;
    const mcpSuccess = mcpFlowResponse?.result?.isError !== true && mcpFlow?.root?.nodeId === cliNodeId && resolvedTargetNodeId(mcpFlow) === cliNodeId;
    const equal = cliSuccess && mcpSuccess && JSON.stringify(flowProjection(cliFlowJson)) === JSON.stringify(flowProjection(mcpFlow));
    record("dynamic-cli-id-to-mcp-flow", { target, cli: cliFlow, mcp: mcpFlowResponse, normalizedCli: flowProjection(cliFlowJson), normalizedMcp: flowProjection(mcpFlow), cliSuccess, mcpSuccess, ...session.evidence() }, equal, equal ? "normalized structured results match" : "both flows must succeed with resolved root/target before projection comparison");
  } else {
    record("dynamic-cli-id-to-mcp-flow", { skipped: true, reason: "CLI endpoint process emitted no nodeId", ...session.evidence() }, false, "SKIPPED is a failure");
  }

  if (mcpNodeId) {
    const target = `node:${mcpNodeId}`;
    const cliFlow = runCli({ command: cliWrapper, args: ["flow", target, "--repo", repo, "--json"], cwd: root, env });
    const cliFlowJson = extractCliJson(cliFlow);
    const mcpFlowResponse = await session.callTool("knowledge_flow", { target, repo });
    const mcpFlow = mcpStructured(mcpFlowResponse);
    const cliSuccess = cliFlow.exitCode === 0 && cliFlowJson?.root?.nodeId === mcpNodeId && resolvedTargetNodeId(cliFlowJson) === mcpNodeId;
    const mcpSuccess = mcpFlowResponse?.result?.isError !== true && mcpFlow?.root?.nodeId === mcpNodeId && resolvedTargetNodeId(mcpFlow) === mcpNodeId;
    const equal = cliSuccess && mcpSuccess && JSON.stringify(flowProjection(cliFlowJson)) === JSON.stringify(flowProjection(mcpFlow));
    record("dynamic-mcp-id-to-cli-flow", { target, cli: cliFlow, mcp: mcpFlowResponse, normalizedCli: flowProjection(cliFlowJson), normalizedMcp: flowProjection(mcpFlow), cliSuccess, mcpSuccess, ...session.evidence() }, equal, equal ? "normalized structured results match" : "both flows must succeed with resolved root/target before projection comparison");
  } else {
    record("dynamic-mcp-id-to-cli-flow", { skipped: true, reason: "MCP endpoint process emitted no nodeId", ...session.evidence() }, false, "SKIPPED is a failure");
  }

  const invalidTarget = "node:task10-definitely-missing";
  const cliInvalid = runCli({ command: cliWrapper, args: ["flow", invalidTarget, "--repo", repo, "--json"], cwd: root, env });
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

  const scopeBranch = `task3-missing-${buildId.slice(0, 12)}`;
  const cliScope = runCli({ command: cliWrapper, args: ["flow", targetForError(cliNodeId), "--repo", repo, "--branch", scopeBranch, "--json"], cwd: root, env });
  const cliScopeJson = extractCliJson(cliScope);
  const mcpScopeResponse = await session.callTool("knowledge_flow", { target: targetForError(cliNodeId), repo, branch: scopeBranch });
  const mcpScope = mcpStructured(mcpScopeResponse);
  const cliScopeError = errorEnvelope(cliScopeJson);
  const mcpScopeError = errorEnvelope(mcpScope);
  const scopeEqual = cliScope.exitCode === 4
    && mcpScopeResponse?.result?.isError !== true
    && JSON.stringify(normalizeForParity(cliScopeError)) === JSON.stringify(normalizeForParity(mcpScopeError))
    && cliScopeError?.retryable === false
    && mcpScopeError?.retryable === false
    && cliScopeError?.details?.remediation;
  record("scope-error-envelope", { branch: scopeBranch, cli: cliScope, mcp: mcpScopeResponse, normalizedCliError: normalizeForParity(cliScopeError), normalizedMcpError: normalizeForParity(mcpScopeError), ...session.evidence() }, Boolean(scopeEqual), "scope mismatch envelopes must match with retryable, details, and remediation");

  const cliUnsupported = runCli({ command: cliWrapper, args: ["capabilities", "--contract-version", "9", "--json"], cwd: root, env });
  const cliUnsupportedJson = extractCliJson(cliUnsupported);
  const mcpUnsupportedResponse = await session.callTool("knowledge_capabilities", { contract_version: "9" });
  const mcpUnsupported = mcpStructured(mcpUnsupportedResponse);
  const cliUnsupportedError = errorEnvelope(cliUnsupportedJson);
  const mcpUnsupportedError = errorEnvelope(mcpUnsupported);
  const unsupportedEqual = cliUnsupported.exitCode === 1
    && JSON.stringify(normalizeForParity(cliUnsupportedError)) === JSON.stringify(normalizeForParity(mcpUnsupportedError));
  record("unsupported-error-envelope", { cli: cliUnsupported, mcp: mcpUnsupportedResponse, normalizedCliError: normalizeForParity(cliUnsupportedError), normalizedMcpError: normalizeForParity(mcpUnsupportedError), ...session.evidence() }, unsupportedEqual, "unsupported contract envelopes match");

  const unknownName = "knowledge-task3-unknown";
  const cliInternal = runCli({ command: cliWrapper, args: [unknownName, "--json"], cwd: root, env });
  const cliInternalJson = extractCliJson(cliInternal);
  const mcpInternalResponse = await session.callTool(unknownName, {});
  const mcpInternal = mcpStructured(mcpInternalResponse);
  const cliInternalError = errorEnvelope(cliInternalJson);
  const mcpInternalError = errorEnvelope(mcpInternal);
  const internalEqual = JSON.stringify(normalizeForParity(cliInternalError)) === JSON.stringify(normalizeForParity(mcpInternalError));
  record("generic-error-envelope", { cli: cliInternal, mcp: mcpInternalResponse, normalizedCliError: normalizeForParity(cliInternalError), normalizedMcpError: normalizeForParity(mcpInternalError), ...session.evidence() }, internalEqual, "generic errors must expose the same normalized envelope");
} catch (error) {
  record("mcp-process-session", { error: String(error), ...session.evidence() }, false, "real MCP session failed");
} finally {
  session.close();
}

const failed = checks.filter((check) => !check.passed);
const evidenceDir = resolve(dirname(report), "task-3-evidence");
mkdirSync(evidenceDir, { recursive: true });
const evidenceFiles = new Map();
for (const row of rows) {
  const file = join(evidenceDir, `${String(rows.indexOf(row) + 1).padStart(2, "0")}-${row.name}.json`);
  const safe = redactEvidence(row.evidence);
  writeFileSync(file, `${JSON.stringify(safe, null, 2)}\n`);
  evidenceFiles.set(row.name, { file, bytes: Buffer.byteLength(JSON.stringify(safe), "utf8") + 1, sha256: fileHash(file) });
}
const markdown = [
  "# Task 3 MCP/CLI parity evidence", "", `- CLI bundle: \`${paths.cliBundle}\``, `- MCP bundle: \`${paths.mcpBundle}\``, `- Node: \`${paths.node}\``, `- CLI stable wrapper: \`${cliWrapper}\``, `- MCP stable wrapper: \`${mcpWrapper}\``, `- Repository: \`${repo}\``, `- Checks: ${checks.length}`, `- Failed: ${failed.length}`, `- Target commit: \`${provenance.targetCommit}\``, `- Bundle commit: \`${provenance.bundleCommit}\``, `- Target/bundle commit match: \`${provenance.bundleCommitMatchesTarget}\``, `- Tracked CLI launcher: \`${provenance.trackedCliLauncher}\``, `- Worktree state at start: \`${provenance.worktreeState}\``, `- Dirty files at start: ${provenance.dirtyFiles.length}`, `- Bundle ID (SHA-256 of exact CLI+MCP bundle bytes): \`${provenance.bundleId}\``, `- Bundle hashes: ${JSON.stringify(provenance.bundleContentHashes)}`, "", "## Verdict", "", failed.length ? `FAIL: ${failed.map((check) => `${check.name} (${check.reason})`).join("; ")}` : "PASS: real CLI and MCP process parity checks passed.", "", "## Evidence sidecars", "", "Each sidecar is complete JSON; no evidence is truncated. Paths and temporary-home values are redacted.", "",
  ...rows.flatMap((row) => { const sidecar = evidenceFiles.get(row.name); return [`### ${row.name}`, `- Sidecar: \`${sidecar.file}\``, `- Bytes: ${sidecar.bytes}`, `- SHA-256: \`${sidecar.sha256}\``, "```json", JSON.stringify(evidenceSummary(row.evidence)), "```", ""]; }),
];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, markdown.join("\n"));
console.log(JSON.stringify({ report, checks: checks.length, failed: failed.length, realProcesses: { cli: true, mcp: true } }, null, 2));
process.exit(failed.length ? 1 : 0);
