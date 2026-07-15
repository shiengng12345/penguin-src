#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callPenguinMcpTool } from "./penguin-mcp-client.mjs";

const INSTALLED_MCP_NODE = process.env.PENGUIN_MCP_NODE ?? "/Users/shieng/.penguin/mcp/node";
const INSTALLED_MCP_SERVER = process.env.PENGUIN_MCP_SERVER ?? "/Users/shieng/.penguin/mcp/dist/index.js";
const KNOWLEDGE_DB = process.env.PENGUIN_KNOWLEDGE_DB
  ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
const SHADOW_REPOS = [
  "FPMS",
  "FPMS-CCMS",
  "FPMS-NT-Auth-Player",
  "FPMS-NT",
  "FPMS-NT-CCMS",
  "FPMS-NT-CCMS-Rust",
  "FPMS-NT-Payment",
  "FPMS-NT-Proposal",
  "FPMS-NT-Provider",
  "FPMS-NT-Recommend",
  "FPMS-NT-Risk-Control",
  "FPMS-NT-Shared",
  "FPMS-NT-User-Engagement",
  "FPMS-Proposal-SDK",
  "casino-plus",
  "flyover",
  "casino-plus-app",
  "claude_code",
  "fpmsXcpms",
  "grpc-web-debugger",
  "snsoft-nestjs-temporal",
];
const CLI_VERB_BY_MODE = {
  calls_of: "calls",
  who_calls: "callers",
  backlinks: "backlinks",
};

export const REAL_REPO_CASES = [
  {
    id: "auth-nest-runtime-dispatch",
    repo: "FPMS-NT-Auth-Player",
    mode: "calls_of",
    target: "BpAuthLoginSiteProvider.checkBlacklist",
    expectedTitles: ["checkPhoneBlacklist", "isLoginGateBlocking", "checkRgLifecycle", "checkSigapBlacklist"],
  },
  {
    id: "fpmsnt-controller-service",
    repo: "FPMS-NT",
    mode: "calls_of",
    target: "FPMS-NT::apps/auth/src/auth/auth.controller.ts::AuthController.sendSmsCode",
    expectedTitles: ["transformUnknownToNt", "illegalArgs", "sendSmsCode"],
  },
  {
    id: "ccmsrust-associated-call",
    repo: "FPMS-NT-CCMS-Rust",
    mode: "who_calls",
    target: "filter_service",
    expectedTitles: ["process"],
  },
  {
    id: "flyover-proto-consumers",
    repo: "flyover",
    mode: "backlinks",
    target: "grpc::PlayerService.GetPlayerProfileByJwt",
    // Independent DB/source audit: 13 fresh consumers across FPMS-NT, Auth,
    // CCMS, Payment, Shared and User Engagement currently invoke this RPC.
    expectedTitles: Array.from({ length: 13 }, () => "getPlayerProfileByJwt"),
  },
  {
    id: "casino-react-native-controller",
    repo: "casino-plus-app",
    mode: "calls_of",
    target: "casino-plus-app::AppController.tsx::AppController",
    expectedTitles: [
      "useAppNavigation",
      "usePosthogService",
      "get",
      "setFullScreen",
      "_handleDeepLink",
      "getEntriesByType",
      "getTotalDuration",
      "_refreshPlayerNotify",
      "checkPlayerDepositProposal",
      "_checkMilyonaryoSelfWin",
      "_renderChildren",
      "getAngBaoRainLeaderboard",
      "getMailList",
      "getPageResourceInSlice",
      "getVoucherList",
      "playerGetAnnualProfileBadge",
      "postHogSend",
    ],
  },
];

const TEST_MAPPING_CASES = [
  ["BpAuthLoginSiteProvider.checkBlacklist", "apps/auth/test/unit/spi/login/auth-login-site-spi-resolution.spec.ts"],
  ["CpAuthLoginSiteProvider.checkBlacklist", "apps/auth/test/unit/spi/login/auth-login-site-spi-resolution.spec.ts"],
  ["BpAuthLoginSiteProvider.normalizePhoneNumberForStorage", "apps/auth/test/unit/spi/login/auth-login-site-spi-resolution.spec.ts"],
  ["BpAuthLoginSiteProvider.getPhoneNumberLookupCandidates", "apps/auth/test/unit/spi/login/auth-login-site-spi-resolution.spec.ts"],
  ["LoginFailureRecordService.record", "apps/auth/test/unit/spi/login/record-login-failure-site-spi.spec.ts"],
  ["BpAuthLoginSiteProvider.recordLoginFailure", "apps/auth/test/unit/spi/login/record-login-failure-site-spi.spec.ts"],
  ["CpAuthLoginSiteProvider.recordLoginFailure", "apps/auth/test/unit/spi/login/record-login-failure-site-spi.spec.ts"],
  ["CpNationalIdPasswordLoginProvider.login", "apps/auth/test/unit/spi/login/national-id-password-login-site-spi.spec.ts"],
  ["BpNationalIdPasswordLoginProvider.login", "apps/auth/test/unit/spi/login/national-id-password-login-site-spi.spec.ts"],
  ["FPMS-NT-Auth-Player::AppFaceIdService.login", "apps/auth/src/face-id/services/app-face-id.service.spec.ts"],
  ["FPMS-NT-Auth-Player::H5FaceIdService.login", "apps/auth/src/face-id/services/h5-face-id.service.spec.ts"],
].map(([target, expectedTest], index) => ({ id: `test-map-${index + 1}`, target, expectedTest }));

export const CLAUDE_DEBUG_CASES = [
  "update-account-status-caller",
  "auth-risk-close-account-flow",
  "frontend-rg-handler",
  "close-account-search-quality",
  "log-literal-to-enclosing-method",
];

export const FUTURE_ACCEPTANCE = [
  "account-status-field-writes",
  "player-additional-detail-mongo-collection",
];

// Relations can share a title across repos, so score counts rather than
// collapsing to a Set and accidentally hiding missing duplicate consumers.
export function scoreRelationTitles(expectedTitles, actualTitles) {
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const title of expectedTitles) expectedCounts.set(title, (expectedCounts.get(title) ?? 0) + 1);
  for (const title of actualTitles) actualCounts.set(title, (actualCounts.get(title) ?? 0) + 1);
  let tp = 0;
  for (const [title, expectedCount] of expectedCounts) {
    tp += Math.min(expectedCount, actualCounts.get(title) ?? 0);
  }
  const fp = actualTitles.length - tp;
  const fn = expectedTitles.length - tp;
  return {
    tp,
    fp,
    fn,
    precision: actualTitles.length === 0 ? (expectedTitles.length === 0 ? 1 : 0) : tp / actualTitles.length,
    recall: expectedTitles.length === 0 ? 1 : tp / expectedTitles.length,
    expectedTitles: [...expectedTitles].sort(),
    actualTitles: [...actualTitles].sort(),
  };
}

// MCP wraps each tool's structured JSON in a text content item; reject error
// envelopes so schema/runtime failures cannot be mistaken for empty graphs.
export function parseMcpGraphResult(result) {
  if (!result.healthy || result.isError) {
    throw new Error(result.error ?? result.content?.map((item) => item.text ?? "").join("\n") ?? "MCP query failed");
  }
  const textItem = result.content.find((item) => item.type === "text");
  if (!textItem) throw new Error("MCP graph result has no text content");
  return JSON.parse(textItem.text);
}

export function scoreShadowParity(cliGraph, mcpGraph) {
  const relationKey = (node) => `${node.nodeId}\0${node.nodeType}\0${node.title}`;
  const cliKeys = (cliGraph.nodes ?? []).map(relationKey).sort();
  const mcpKeys = (mcpGraph.nodes ?? []).map(relationKey).sort();
  const parity = JSON.stringify(cliKeys) === JSON.stringify(mcpKeys);
  return {
    parity,
    cliCount: cliKeys.length,
    mcpCount: mcpKeys.length,
    materialMiss: !parity || cliKeys.length === 0 || mcpKeys.length === 0,
  };
}

export function summarizeShadowCases(cases, minimumQueries = 100) {
  const parityFailures = cases.filter((item) => !item.parity).length;
  const materialMisses = cases.filter((item) => item.materialMiss).length;
  return {
    queries: cases.length,
    parityFailures,
    materialMisses,
    passed: cases.length >= minimumQueries && parityFailures === 0 && materialMisses === 0,
  };
}

export function summarizeTestMappings(cases) {
  const found = cases.filter((item) => item.found).length;
  const parityFailures = cases.filter((item) => !item.parity).length;
  const recall = cases.length === 0 ? 0 : found / cases.length;
  return {
    expected: cases.length,
    found,
    recall,
    parityFailures,
    passed: cases.length > 0 && recall >= 0.9 && parityFailures === 0,
  };
}

export function summarizeClaudeDebugCases(cases) {
  const passedCases = cases.filter((item) => item.passed).length;
  const parityFailures = cases.filter((item) => !item.parity).length;
  return {
    expected: cases.length,
    passedCases,
    parityFailures,
    passed: cases.length > 0 && passedCases === cases.length && parityFailures === 0,
  };
}

export function hasOrderedNodeIds(steps, expectedNodeIds) {
  let cursor = 0;
  for (const step of steps ?? []) {
    if (step.nodeId === expectedNodeIds[cursor]) cursor += 1;
    if (cursor === expectedNodeIds.length) return true;
  }
  return expectedNodeIds.length === 0;
}

function runCliJson(args) {
  const result = spawnSync("penguin", [...args, "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `CLI failed: penguin ${args.join(" ")}`);
  }
  return JSON.parse(result.stdout);
}

async function runMcpJson(toolName, args) {
  return parseMcpGraphResult(await callPenguinMcpTool({
    nodePath: INSTALLED_MCP_NODE,
    serverPath: INSTALLED_MCP_SERVER,
    toolName,
    arguments: args,
    timeoutMs: 15_000,
  }));
}

function stableSearchKeys(hits) {
  return hits
    .map((hit) => `${hit.nodeId}\0${hit.identityKey}\0${hit.snippet ?? ""}`)
    .sort();
}

function findNodeId(hits, identitySuffix) {
  return hits.find((hit) => hit.identityKey?.endsWith(identitySuffix))?.nodeId ?? null;
}

async function runClaudeDebugCorpus() {
  const cliSearch = runCliJson(["search", "closeAccount"]);
  const mcpSearch = (await runMcpJson("knowledge_search", {
    query: "closeAccount",
    limit: 200,
  })).results ?? [];
  const searchParity = JSON.stringify(stableSearchKeys(cliSearch))
    === JSON.stringify(stableSearchKeys(mcpSearch));

  const bpClose = findNodeId(cliSearch, "::BpAccountClosureService.closeAccount");
  const riskClient = findNodeId(cliSearch, "::RiskControlClientGrpc.closeAccount");
  const riskEndpoint = findNodeId(cliSearch, "grpc::ResponsibleGamingInternalService.closeaccount");
  const riskHandler = findNodeId(cliSearch, "::ResponsibleGamingController.closeAccount");
  const frontendEndpoint = findNodeId(cliSearch, "grpc::FrontendRgAccountService.closeaccount");
  const frontendHandler = findNodeId(cliSearch, "::FrontendRgAccountController.closeAccount");

  const cliCallers = runCliJson(["callers", "updateAccountStatus"]);
  const mcpCallers = await runMcpJson("explore_graph", {
    mode: "who_calls",
    node: "updateAccountStatus",
    depth: 1,
    limit: 200,
  });
  const callerParity = JSON.stringify((cliCallers.nodes ?? []).map((node) => node.nodeId).sort())
    === JSON.stringify((mcpCallers.nodes ?? []).map((node) => node.nodeId).sort());

  const cliRiskFlow = runCliJson(["flow", "RiskControlClientGrpc.closeAccount"]);
  const mcpRiskFlow = await runMcpJson("knowledge_explore", {
    target: "RiskControlClientGrpc.closeAccount",
    depth: 6,
    limit: 200,
  });
  const riskIds = [riskClient, riskEndpoint, riskHandler].filter(Boolean);
  const riskCliPassed = riskIds.length === 3 && hasOrderedNodeIds(cliRiskFlow.steps, riskIds);
  const riskMcpPassed = riskIds.length === 3 && hasOrderedNodeIds(mcpRiskFlow.callPath, riskIds);

  const cliFrontendFlow = runCliJson(["flow", "grpc::FrontendRgAccountService.closeaccount"]);
  const mcpFrontendFlow = await runMcpJson("knowledge_explore", {
    target: "grpc::FrontendRgAccountService.closeaccount",
    depth: 2,
    limit: 100,
  });
  const frontendIds = [frontendEndpoint, frontendHandler].filter(Boolean);
  const frontendCliPassed = frontendIds.length === 2 && hasOrderedNodeIds(cliFrontendFlow.steps, frontendIds);
  const frontendMcpPassed = frontendIds.length === 2 && hasOrderedNodeIds(mcpFrontendFlow.callPath, frontendIds);

  const logQuery = "[BpAccountClosureService] closeAccount started";
  const cliLogHits = runCliJson(["search", logQuery]);
  const mcpLogHits = (await runMcpJson("knowledge_search", { query: logQuery, limit: 20 })).results ?? [];
  const cliLog = cliLogHits.find((hit) => hit.nodeType === "log_site");
  const mcpLog = mcpLogHits.find((hit) => hit.nodeType === "log_site");
  const cliLogBacklinks = cliLog ? runCliJson(["backlinks", cliLog.nodeId]) : { nodes: [] };
  const mcpLogBacklinks = mcpLog ? await runMcpJson("explore_graph", {
    mode: "backlinks", node: mcpLog.nodeId, depth: 1, limit: 20,
  }) : { nodes: [] };
  const cliLogLinked = !!bpClose && (cliLogBacklinks.nodes ?? []).some((node) => node.nodeId === bpClose);
  const mcpLogLinked = !!bpClose && (mcpLogBacklinks.nodes ?? []).some((node) => node.nodeId === bpClose);

  const duplicateIdentities = cliSearch.length - new Set(cliSearch.map((hit) => hit.identityKey)).size;
  const symbolsHaveSnippets = cliSearch
    .filter((hit) => hit.nodeType === "symbol")
    .every((hit) => typeof hit.snippet === "string" && hit.snippet.trim().length > 0);
  const cases = [
    {
      id: "update-account-status-caller",
      passed: !!bpClose
        && (cliCallers.nodes ?? []).some((node) => node.nodeId === bpClose)
        && (mcpCallers.nodes ?? []).some((node) => node.nodeId === bpClose),
      parity: callerParity,
    },
    {
      id: "auth-risk-close-account-flow",
      passed: riskCliPassed && riskMcpPassed,
      parity: riskCliPassed === riskMcpPassed,
    },
    {
      id: "frontend-rg-handler",
      passed: frontendCliPassed && frontendMcpPassed,
      parity: frontendCliPassed === frontendMcpPassed,
    },
    {
      id: "close-account-search-quality",
      passed: cliSearch.length > 0 && duplicateIdentities === 0 && symbolsHaveSnippets,
      parity: searchParity,
    },
    {
      id: "log-literal-to-enclosing-method",
      passed: !!cliLog && !!mcpLog && cliLogLinked && mcpLogLinked,
      parity: cliLog?.nodeId === mcpLog?.nodeId && cliLogLinked === mcpLogLinked,
    },
  ];
  return {
    summary: summarizeClaudeDebugCases(cases),
    cases,
    futureAcceptance: FUTURE_ACCEPTANCE,
  };
}

// Run one exact query through the installed CLI and installed MCP server, then
// score both against a human-reviewed relation list and against each other.
export async function runCase(benchmarkCase) {
  const cli = spawnSync("penguin", [CLI_VERB_BY_MODE[benchmarkCase.mode], benchmarkCase.target, "--json"], {
    encoding: "utf8",
  });
  if (cli.status !== 0) throw new Error(cli.stderr || cli.stdout || `CLI failed for ${benchmarkCase.id}`);
  const cliGraph = JSON.parse(cli.stdout);
  const mcpEnvelope = await callPenguinMcpTool({
    nodePath: INSTALLED_MCP_NODE,
    serverPath: INSTALLED_MCP_SERVER,
    toolName: "explore_graph",
    arguments: { mode: benchmarkCase.mode, node: benchmarkCase.target, depth: 1, limit: 200 },
  });
  const mcpGraph = parseMcpGraphResult(mcpEnvelope);
  const cliTitles = cliGraph.nodes.map((node) => node.title);
  const mcpTitles = mcpGraph.nodes.map((node) => node.title);
  return {
    id: benchmarkCase.id,
    repo: benchmarkCase.repo,
    mode: benchmarkCase.mode,
    target: benchmarkCase.target,
    cli: scoreRelationTitles(benchmarkCase.expectedTitles, cliTitles),
    mcp: scoreRelationTitles(benchmarkCase.expectedTitles, mcpTitles),
    parity: JSON.stringify([...cliTitles].sort()) === JSON.stringify([...mcpTitles].sort()),
  };
}

function loadShadowCases(perRepo = 20) {
  const quotedRepos = SHADOW_REPOS.map((repo) => `'${repo.replaceAll("'", "''")}'`).join(",");
  const sql = `
    WITH ranked AS (
      SELECT r.name AS repo, n.identity_key AS target, COUNT(*) AS source_relations,
             ROW_NUMBER() OVER (PARTITION BY r.name ORDER BY COUNT(*) DESC, n.identity_key) AS rank
        FROM nodes n
        JOIN repos r ON r.id=n.repo_id
        JOIN edges e ON e.src=n.id AND e.edge_type='calls' AND e.status='active'
        JOIN branches b ON b.id=e.branch_id AND b.status='live'
       WHERE r.name IN (${quotedRepos})
       GROUP BY r.name, n.id
    )
    SELECT repo, target, source_relations AS sourceRelations
      FROM ranked WHERE rank <= ${Number(perRepo)} ORDER BY repo, rank`;
  const selected = spawnSync("sqlite3", ["-json", KNOWLEDGE_DB, sql], { encoding: "utf8" });
  if (selected.status !== 0) throw new Error(selected.stderr || "failed to select shadow benchmark cases");
  const rows = JSON.parse(selected.stdout || "[]");
  return rows.map((row, index) => ({
    id: `shadow-${String(index + 1).padStart(3, "0")}`,
    repo: row.repo,
    target: row.target,
    sourceRelations: Number(row.sourceRelations),
  }));
}

async function runShadowCase(benchmarkCase) {
  try {
    const cli = spawnSync("penguin", ["calls", benchmarkCase.target, "--json"], { encoding: "utf8" });
    if (cli.status !== 0) throw new Error(cli.stderr || cli.stdout || "CLI query failed");
    const cliGraph = JSON.parse(cli.stdout);
    const mcpGraph = parseMcpGraphResult(await callPenguinMcpTool({
      nodePath: INSTALLED_MCP_NODE,
      serverPath: INSTALLED_MCP_SERVER,
      toolName: "explore_graph",
      arguments: { mode: "calls_of", node: benchmarkCase.target, depth: 1, limit: 200 },
      timeoutMs: 15_000,
    }));
    return { ...benchmarkCase, ...scoreShadowParity(cliGraph, mcpGraph) };
  } catch (error) {
    return {
      ...benchmarkCase,
      parity: false,
      cliCount: 0,
      mcpCount: 0,
      materialMiss: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runShadowCorpus() {
  const selected = loadShadowCases();
  const cases = [];
  const batchSize = 5;
  for (let offset = 0; offset < selected.length; offset += batchSize) {
    cases.push(...await Promise.all(selected.slice(offset, offset + batchSize).map(runShadowCase)));
  }
  const coveredRepos = [...new Set(selected.map((item) => item.repo))].sort();
  const missingRepos = SHADOW_REPOS.filter((repo) => !coveredRepos.includes(repo));
  const base = summarizeShadowCases(cases, selected.length);
  return {
    summary: {
      ...base,
      repos: coveredRepos.length,
      expectedRepos: SHADOW_REPOS.length,
      missingRepos,
      passed: base.passed && missingRepos.length === 0,
    },
    cases,
  };
}

async function runTestMappingCase(benchmarkCase) {
  try {
    const cli = spawnSync("penguin", ["explore", benchmarkCase.target, "--json"], { encoding: "utf8" });
    if (cli.status !== 0) throw new Error(cli.stderr || cli.stdout || "CLI explore failed");
    const cliPack = JSON.parse(cli.stdout);
    const mcpPack = parseMcpGraphResult(await callPenguinMcpTool({
      nodePath: INSTALLED_MCP_NODE,
      serverPath: INSTALLED_MCP_SERVER,
      toolName: "knowledge_explore",
      arguments: { target: benchmarkCase.target, depth: 2, limit: 100 },
      timeoutMs: 15_000,
    }));
    const cliTests = (cliPack.tests ?? []).map((test) => test.title).sort();
    const mcpTests = (mcpPack.tests ?? []).map((test) => test.title).sort();
    const cliFound = cliTests.includes(benchmarkCase.expectedTest);
    const mcpFound = mcpTests.includes(benchmarkCase.expectedTest);
    return {
      ...benchmarkCase,
      found: cliFound && mcpFound,
      parity: JSON.stringify(cliTests) === JSON.stringify(mcpTests),
      cliTests,
      mcpTests,
      provenance: (cliPack.provenance ?? []).filter((edge) => edge.edgeType === "tests"),
    };
  } catch (error) {
    return {
      ...benchmarkCase,
      found: false,
      parity: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runTestMappingCorpus() {
  const cases = [];
  for (const benchmarkCase of TEST_MAPPING_CASES) cases.push(await runTestMappingCase(benchmarkCase));
  return { summary: summarizeTestMappings(cases), cases };
}

// Keep real-repo validation opt-in because it depends on the user's local
// indexed corpus; unit tests only exercise the deterministic scoring helpers.
export async function runRealRepoBenchmark() {
  const cases = [];
  for (const benchmarkCase of REAL_REPO_CASES) cases.push(await runCase(benchmarkCase));
  const truthPassed = cases.every((item) =>
    item.parity
    && item.cli.precision >= 0.95
    && item.cli.recall >= 0.90
    && item.mcp.precision >= 0.95
    && item.mcp.recall >= 0.90);
  const shadow = await runShadowCorpus();
  const testMappings = await runTestMappingCorpus();
  const claudeDebug = await runClaudeDebugCorpus();
  return {
    benchmarkVersion: 3,
    corpus: "local-real-repos",
    cases,
    truthPassed,
    shadow,
    testMappings,
    claudeDebug,
    passed: truthPassed && shadow.summary.passed && testMappings.summary.passed && claudeDebug.summary.passed,
  };
}

const invokedDirectly = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedDirectly) {
  const result = await runRealRepoBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}
