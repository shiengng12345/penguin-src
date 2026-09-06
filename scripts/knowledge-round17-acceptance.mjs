#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { McpSession } from "./knowledge-process-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const gateMode = argv.includes("--gate");
const fixtureMode = argv.includes("--fixture");
const mcpHarnessProbeMode = argv.includes("--mcp-harness-probe");
const repo = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : "FPMS-NT";
const cliLauncher = resolve(root, "scripts/knowledge-cli-launcher.mjs");
const mcpLauncher = process.env.PENGUIN_ROUND17_MCP_LAUNCHER
  ? resolve(process.env.PENGUIN_ROUND17_MCP_LAUNCHER)
  : resolve(root, "scripts/knowledge-mcp-launcher.mjs");
const frozen = {
  affectedFile: "libs/common/constants.ts",
  affectedSymbol: { query: "PaymentExternalService", symbol: "PaymentExternalService", filePath: "apps/admin/inteceptor/payment-external.service.ts" },
  crossRepoEndpoint: ["grpc::promotion.v1.FrontendColorLandService.RollColorLandDice", "FrontendColorLandService.RollColorLandDice"],
  contextEndpoint: ["grpc::promotion.v1.FrontendColorLandService.RollColorLandDice", "FrontendColorLandService.RollColorLandDice"],
  foreignRepo: "claude_code",
};
const REQUIRED_FIXTURE_TESTS = {
  G1: [
    "Round17 G1: CLI and MCP expose one non-empty build and capability identity",
    "Round17 G1: CLI affected matches MCP affected for changed file",
    "Round17 G1: affected rejects mixed file and node inputs",
    "Round17 G1: indexed file with no symbols is an exact empty CLI/MCP result",
  ],
  G2: [
    "Round17 G2: CLI and MCP return one canonical ownership error and inventory excludes foreign endpoints",
    "Round17 G2: valid non-handler cross-service flow preserves each source revision and marks the boundary",
    "Round17 G2: path rejects an out-of-scope destination identically through CLI and MCP",
    "Round17 G2: repo-scoped endpoint inventory does not leak a foreign provider handler",
    "Round17 G2: endpoint provenance retains the requested feature branch through its locator",
  ],
  G3: [
    "Round17 G3: endpoint aliases collapse to one canonical endpoint and proto-only linkage stays incomplete",
    "Round17 G4: unscoped CLI and MCP inventory preserve every repo membership and provider source",
  ],
  G4: [
    "Round17 G4: context and flow expose the same endpoint first-hop tuples",
    "Round17 G4: repo scope removes a foreign branchless provider handle from inventory, context, and flow",
    "Round17 G4: non-legacy snapshot first hops preserve inferred evidence",
    "Round17 G4: revision context scans snapshot relations at most twice",
  ],
  G5: [
    "Round17 G5: aligned partial coverage is fresh and all read surfaces share one revision",
    "Round17 G5: legacy MCP compatibility results reuse canonical v2 evidence",
  ],
  G6: [
    "Round17 G6: invalid CLI and MCP requests return the exact typed error contract",
  ],
  G7: [
    "Round17 G7: endpoint inventory uses one live scope for provenance and cross-adapter cursors",
    "Round17 G7: endpoint cursors continue, exhaust, reject malformed input, and reject a foreign scope",
    "Round17 G7: endpoints filesymbols and deadcode cursors continue exhaust and reject invalid or wrong scope",
  ],
  G8: [
    "Round17 G8: empty and stale API previews never claim exhaustive or proven evidence",
  ],
};
const CLI_TIMEOUT_MS = boundedTimeout(process.env.PENGUIN_ROUND17_CLI_TIMEOUT_MS, 10_000);
const MCP_TIMEOUT_MS = boundedTimeout(process.env.PENGUIN_ROUND17_MCP_TIMEOUT_MS, 12_000);
// The frozen real packet is intentionally sequential and spans cursor
// lifecycles plus one long-lived MCP session. Keep strict 10s/12s per-call
// limits, but give the whole packet enough room on a cold 20-repository DB.
const TOTAL_TIMEOUT_MS = boundedTimeout(process.env.PENGUIN_ROUND17_TOTAL_TIMEOUT_MS, 120_000);
const deadline = Date.now() + TOTAL_TIMEOUT_MS;
let emitted = false;

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(250, Math.min(parsed, 600_000)) : fallback;
}

function emitOnce(envelope) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(`${JSON.stringify(redacted(envelope))}\n`);
}

function unexpectedFailure(error) {
  emitOnce({
    passed: false,
    gates: [{ id: "HARNESS", hard: true, passed: false, evidence: { error: String(error?.message ?? error) } }],
    failures: [{ id: "HARNESS", evidence: { error: String(error?.message ?? error) } }],
    buildId: null,
    capabilityHash: null,
    revision: null,
  });
  if (gateMode) process.exitCode = 1;
}

function remainingMs() { return deadline - Date.now(); }
function deadlineFailure(kind) {
  return { exitCode: 124, timedOut: true, json: { error: { code: "PROCESS_TIMEOUT", message: `${kind} probe skipped after the ${TOTAL_TIMEOUT_MS}ms acceptance deadline`, retryable: true } } };
}

process.once("uncaughtException", unexpectedFailure);
process.once("unhandledRejection", unexpectedFailure);

function runCli(args) {
  const remaining = remainingMs();
  if (remaining <= 0) return deadlineFailure("CLI");
  try {
    const result = spawnSync(process.execPath, [cliLauncher, ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: Math.min(CLI_TIMEOUT_MS, remaining),
      killSignal: "SIGKILL",
    });
    const timedOut = result.error?.code === "ETIMEDOUT";
    return {
      exitCode: timedOut ? 124 : result.status ?? 1,
      timedOut,
      json: timedOut
        ? { error: { code: "PROCESS_TIMEOUT", message: `CLI probe exceeded ${Math.min(CLI_TIMEOUT_MS, remaining)}ms`, retryable: true } }
        : jsonFromText(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
    };
  } catch (error) {
    return { exitCode: 1, timedOut: false, json: { error: { code: "PROCESS_LAUNCH_FAILED", message: String(error), retryable: true } } };
  }
}

function jsonFromText(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try { return JSON.parse(line); } catch { /* keep looking for the structured envelope */ }
  }
  try { return JSON.parse(text.trim()); } catch { return null; }
}

function mcpHarnessFailure(calls, reason, details = {}, exitCode = 1, timedOut = false) {
  const error = { code: "HARNESS", message: `MCP harness failure: ${reason}`, retryable: true, details: { reason, ...details } };
  return {
    ok: false,
    error,
    rows: calls.map((call) => ({ name: call.name, exitCode, timedOut, value: { error }, harnessError: error })),
  };
}

function runMcpBatch(calls) {
  const remaining = remainingMs();
  if (remaining <= 0) {
    return mcpHarnessFailure(calls, "TOTAL_DEADLINE_EXCEEDED", { timeoutMs: TOTAL_TIMEOUT_MS }, 124, true);
  }
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "round17-acceptance", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    ...calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: call.name, arguments: call.arguments } })),
  ];
  let result;
  try {
    result = spawnSync(process.execPath, [mcpLauncher], {
      cwd: root,
      encoding: "utf8",
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      maxBuffer: 8 * 1024 * 1024,
      timeout: Math.min(MCP_TIMEOUT_MS, remaining),
      killSignal: "SIGKILL",
    });
  } catch (error) {
    return mcpHarnessFailure(calls, "PROCESS_LAUNCH_FAILED", { message: String(error) });
  }
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut) return mcpHarnessFailure(calls, "PROCESS_TIMEOUT", { timeoutMs: Math.min(MCP_TIMEOUT_MS, remaining) }, 124, true);
  if (result.error) return mcpHarnessFailure(calls, "PROCESS_LAUNCH_FAILED", { message: String(result.error.message ?? result.error) });
  if (result.status !== 0) return mcpHarnessFailure(calls, "PROCESS_NONZERO_EXIT", { exitCode: result.status, signal: result.signal ?? null }, result.status ?? 1, false);

  const messages = [];
  for (const [lineIndex, line] of String(result.stdout ?? "").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || parsed.jsonrpc !== "2.0") {
        return mcpHarnessFailure(calls, "MALFORMED_JSONRPC", { line: lineIndex + 1 });
      }
      messages.push(parsed);
    } catch {
      return mcpHarnessFailure(calls, "MALFORMED_JSON", { line: lineIndex + 1 });
    }
  }
  const responses = messages.filter((message) => Object.hasOwn(message, "id"));
  const ids = responses.map((response) => response.id);
  if (new Set(ids).size !== ids.length) return mcpHarnessFailure(calls, "DUPLICATE_RESPONSE_ID", { ids });
  const expectedIds = [1, ...calls.map((_, index) => index + 2)];
  const unexpectedIds = ids.filter((id) => !expectedIds.includes(id));
  const missingIds = expectedIds.filter((id) => !ids.includes(id));
  if (unexpectedIds.length || missingIds.length) return mcpHarnessFailure(calls, "RESPONSE_ID_MISMATCH", { missingIds, unexpectedIds, ids });
  const initialize = responses.find((response) => response.id === 1);
  if (!initialize?.result || initialize.error) return mcpHarnessFailure(calls, "INITIALIZE_FAILED", { error: initialize?.error ?? null });

  const rows = calls.map((call, index) => ({
    name: call.name,
    exitCode: 0,
    timedOut: false,
    value: mcpValue(responses.find((response) => response.id === index + 2)),
  }));
  if (rows.some((row) => errorCode(row.value) === "MCP_NON_JSON")) return mcpHarnessFailure(calls, "MALFORMED_TOOL_CONTENT");
  return { ok: true, error: null, rows };
}

async function closeMcpSession(session) {
  session.close();
  if (session.child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => session.child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (session.child.exitCode === null) session.child.kill("SIGKILL");
}

// The gate verifies semantic parity, not synthetic saturation. A real Claude
// or Codex MCP client keeps one stdio session and waits for each response; it
// does not send the entire packet concurrently or wait for the server to exit
// after every response. Mirror that lifecycle and then close the launcher,
// whose signal forwarding terminates the selected runtime child as well.
async function runMcp(calls) {
  const remaining = remainingMs();
  if (remaining <= 0) {
    return mcpHarnessFailure(calls, "TOTAL_DEADLINE_EXCEEDED", { timeoutMs: TOTAL_TIMEOUT_MS }, 124, true);
  }
  const session = new McpSession({
    command: process.execPath,
    args: [mcpLauncher],
    cwd: root,
    env: process.env,
    label: "round17-mcp",
    timeoutMs: Math.min(MCP_TIMEOUT_MS, remaining),
  });
  const rows = [];
  try {
    const initialize = await session.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "round17-acceptance", version: "1" },
    }, Math.min(MCP_TIMEOUT_MS, remainingMs()));
    if (!initialize?.result || initialize.error) {
      return mcpHarnessFailure(calls, "INITIALIZE_FAILED", { error: initialize?.error ?? null });
    }
    session.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    for (const call of calls) {
      const callRemaining = remainingMs();
      if (callRemaining <= 0) {
        const failure = mcpHarnessFailure([call], "TOTAL_DEADLINE_EXCEEDED", { timeoutMs: TOTAL_TIMEOUT_MS }, 124, true);
        rows.push(failure.rows[0]);
        continue;
      }
      try {
        const response = await session.request("tools/call", {
          name: call.name,
          arguments: call.arguments,
        }, Math.min(MCP_TIMEOUT_MS, callRemaining));
        const value = mcpValue(response);
        rows.push({ name: call.name, exitCode: 0, timedOut: false, value });
      } catch (error) {
        const timedOut = /timed out/i.test(String(error?.message ?? error));
        const failure = mcpHarnessFailure(
          [call],
          timedOut ? "PROCESS_TIMEOUT" : "PROCESS_LAUNCH_FAILED",
          { tool: call.name, message: String(error?.message ?? error), stderr: session.stderr.slice(-2_000) },
          timedOut ? 124 : 1,
          timedOut,
        );
        rows.push(failure.rows[0]);
      }
    }
    const firstHarnessError = rows.find((row) => row.harnessError)?.harnessError ?? null;
    if (firstHarnessError) return { ok: false, error: firstHarnessError, rows };
    if (rows.some((row) => errorCode(row.value) === "MCP_NON_JSON")) {
      return mcpHarnessFailure(calls, "MALFORMED_TOOL_CONTENT");
    }
    return { ok: true, error: null, rows };
  } catch (error) {
    const timedOut = /timed out/i.test(String(error?.message ?? error));
    return mcpHarnessFailure(calls, timedOut ? "PROCESS_TIMEOUT" : "PROCESS_LAUNCH_FAILED", {
      message: String(error?.message ?? error),
      stderr: session.stderr.slice(-2_000),
    }, timedOut ? 124 : 1, timedOut);
  } finally {
    await closeMcpSession(session);
  }
}

function mcpValue(response) {
  const result = response?.result;
  if (!result) return response ?? null;
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item?.type === "text")?.text;
  return typeof text === "string" ? jsonFromText(text) ?? { error: { code: "MCP_NON_JSON", message: text, retryable: false } } : result;
}

function errorCode(value) { return value?.error?.code ?? null; }
function revisionOf(value) { return value?.revision?.snapshotId ?? value?.revision?.commitSha ?? value?.revision?.id ?? value?.revision?.revisionId ?? value?.locator?.snapshotId ?? value?.locator?.commitSha ?? value?.locator?.revisionId ?? null; }
function topLevelRevisionOf(value) { return value?.revision?.snapshotId ?? value?.revision?.commitSha ?? value?.revision?.id ?? value?.revision?.revisionId ?? null; }
function scopeOf(value) { return value?.scope ?? value?.locator?.repoId ?? value?.revision?.repoId ?? null; }
function ids(items) { return (items ?? []).map((item) => item?.nodeId ?? item?.id ?? item).filter(Boolean).sort(); }
function affected(value) {
  return {
    changed: ids(value?.changed), impacted: ids(value?.impacted), tests: ids(value?.tests), routes: [...(value?.routes ?? [])].map((route) => typeof route === "string" ? route : route?.route ?? route?.nodeId).filter(Boolean).sort(),
    proofStatus: value?.proofStatus ?? null, scope: scopeOf(value), revision: revisionOf(value),
  };
}
function firstHop(value, context = false) {
  if (context) return (value?.firstHopRelations ?? []).map((item) => [item?.edgeType ?? null, item?.nodeId ?? item?.id ?? null, item?.source?.repoId ?? item?.repoId ?? null, item?.source?.revisionId ?? item?.revisionId ?? null, item?.evidenceState ?? value?.proofStatus ?? null]).sort();
  return (value?.steps ?? []).filter((step) => step.depth === 1).map((step) => [step.via, step.nodeId, step.source?.repoId ?? null, step.source?.revisionId ?? null, step.evidenceState ?? value?.proofStatus ?? null]).sort();
}
function typedFailure(row) { return row.exitCode !== 0 && typeof errorCode(row.json) === "string"; }
function cliProbeProjection(row) {
  return {
    exitCode: row?.exitCode ?? null,
    timedOut: row?.timedOut === true,
    error: errorCode(row?.json),
  };
}
const TRANSPORT_ERROR_CODES = new Set(["PROCESS_TIMEOUT", "PROCESS_LAUNCH_FAILED", "MCP_NON_JSON", "HARNESS"]);
function isProductErrorCode(code, expected) { return typeof code === "string" && !TRANSPORT_ERROR_CODES.has(code) && expected.includes(code); }
function endpointProjection(value) {
  const items = (value?.items ?? []).map((item) => ({ nodeId: item?.nodeId ?? null, identityKey: item?.identityKey ?? null, title: item?.title ?? null, protocol: item?.protocol ?? item?.meta?.protocol ?? null, handlerStatus: item?.handlerStatus ?? null }));
  return {
    count: items.length, fingerprint: createHash("sha256").update(JSON.stringify(items)).digest("hex"), sample: items.slice(0, 3),
    scope: scopeOf(value), revision: revisionOf(value), hasMore: typeof value?.nextCursor === "string", error: errorCode(value),
  };
}
function capabilityProjection(value) {
  return {
    buildId: typeof value?.buildId === "string" ? value.buildId : null,
    capabilityHash: typeof value?.capabilityHash === "string" ? value.capabilityHash : null,
    schemaVersion: typeof value?.schemaVersion === "string" ? value.schemaVersion : null,
    contractVersion: typeof value?.contractVersion === "string" ? value.contractVersion : null,
  };
}
function equalNonEmptyCapabilities(left, right) {
  const a = capabilityProjection(left);
  const b = capabilityProjection(right);
  return Object.values(a).every((value) => typeof value === "string" && value.length > 0)
    && JSON.stringify(a) === JSON.stringify(b);
}
function endpointHandlerTruth(pages) {
  const items = pages.flatMap((page) => page.json?.items ?? []);
  return items.every((item) => {
    const providerMembership = (item.memberships ?? []).some((membership) => membership.role === "provider");
    const hasHandler = (item.handlers ?? []).length > 0 || (item.firstHopRelations ?? []).some((relation) => relation.edgeType === "handles");
    if (!providerMembership && item.handlerStatus === "handled") return false;
    if (["proto_only", "incomplete"].includes(item.handlerStatus) && hasHandler) return false;
    return true;
  });
}
function listProjection(value) {
  if (Array.isArray(value)) return { shape: "bare_array", count: value.length, error: null };
  const items = value?.items ?? value?.previews ?? value?.notes ?? null;
  return {
    shape: Array.isArray(items) ? "envelope" : "other",
    count: Array.isArray(items) ? items.length : null,
    error: errorCode(value),
    scope: scopeOf(value),
    revision: revisionOf(value),
    freshness: value?.freshness?.status ?? null,
    coverage: value?.coverage?.status ?? null,
    completeness: value?.completeness ?? null,
    proofStatus: value?.proofStatus ?? null,
    candidateCount: value?.candidateCount ?? null,
    returnedCount: value?.returnedCount ?? null,
    totalIsExact: value?.totalIsExact ?? null,
    gaps: Array.isArray(value?.gaps) ? value.gaps : null,
  };
}
function honestList(value) {
  if (typeof errorCode(value) === "string") return false;
  const projection = listProjection(value);
  if (projection.shape !== "envelope") return false;
  const explicitHonesty = ["proven", "candidate", "not_proven"].includes(projection.proofStatus)
    && ["exact", "lower_bound", "partial", "unknown"].includes(projection.completeness)
    && Object.hasOwn(value, "candidateCount")
    && typeof projection.returnedCount === "number"
    && typeof projection.totalIsExact === "boolean"
    && Array.isArray(projection.gaps);
  if (!explicitHonesty) return false;
  if (projection.scope || projection.revision) return Boolean(projection.freshness || projection.coverage);
  return projection.gaps.length > 0 || projection.proofStatus !== "proven" || projection.totalIsExact;
}
function endpointCursorLifecycle() {
  const pages = [];
  let current = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "500", "--json"]);
  pages.push(current);
  const seen = new Set(ids(current.json?.items));
  let normal = false;
  let exhausted = current.exitCode === 0 && current.json?.nextCursor === null;
  for (let page = 0; page < 20 && current.exitCode === 0 && current.json?.nextCursor; page += 1) {
    const next = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "500", "--cursor", current.json.nextCursor, "--json"]);
    const nextIds = ids(next.json?.items);
    normal ||= next.exitCode === 0 && nextIds.every((id) => !seen.has(id));
    nextIds.forEach((id) => seen.add(id));
    pages.push(next);
    current = next;
    exhausted ||= next.exitCode === 0 && next.json?.nextCursor === null;
  }
  const firstCursor = pages[0]?.json?.nextCursor;
  const invalid = runCli(["endpoints", repo, "--protocol", "grpc", "--cursor", "round17-malformed-cursor", "--json"]);
  const wrongScope = typeof firstCursor === "string"
    ? runCli(["endpoints", frozen.foreignRepo, "--protocol", "grpc", "--cursor", firstCursor, "--json"])
    : { exitCode: 1, timedOut: false, json: { error: { code: "CURSOR_MISSING", message: "first page emitted no cursor", retryable: false } } };
  return { pages, normal, exhausted, invalid, wrongScope, uniqueIds: seen.size, capped: current.json?.nextCursor != null };
}

function cliCursorLifecycle({ name, firstArgs, nextArgs, invalidArgs, wrongScopeArgs, maxPages = 30 }) {
  const pages = [];
  let current = runCli(firstArgs);
  pages.push(current);
  const firstCursor = current.json?.nextCursor;
  const seen = new Set(ids(current.json?.items));
  let normal = false;
  for (let page = 0; page < maxPages && current.exitCode === 0 && current.json?.nextCursor; page += 1) {
    const next = runCli(nextArgs(current.json.nextCursor));
    const nextIds = ids(next.json?.items);
    if (pages.length === 1) normal = next.exitCode === 0 && nextIds.length > 0 && nextIds.every((id) => !seen.has(id));
    nextIds.forEach((id) => seen.add(id));
    pages.push(next);
    current = next;
  }
  const invalid = runCli(invalidArgs);
  const wrongScope = typeof firstCursor === "string"
    ? runCli(wrongScopeArgs(firstCursor))
    : { exitCode: 1, timedOut: false, json: { error: { code: "CURSOR_MISSING", message: `${name} first page emitted no cursor`, retryable: false } } };
  return {
    name,
    pages,
    normal,
    exhausted: current.exitCode === 0 && current.json?.nextCursor === null && current.json?.truncated === false,
    capped: current.json?.nextCursor != null,
    invalid,
    wrongScope,
    uniqueIds: seen.size,
  };
}

function apiPreviewHonesty(value) {
  if (!honestList(value)) return false;
  const items = value?.items ?? value?.previews ?? [];
  if (items.length === 0 && (value?.proofStatus === "proven" || value?.completeness === "exact" || value?.coverage?.status === "exhaustive")) return false;
  return items.every((item) => {
    if (!["stale", "empty"].includes(item?.evidenceState)) return true;
    return item?.proofStatus === "not_proven" && item?.coverage !== "exhaustive";
  });
}

function semanticKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function semanticLocatorFailure(code, message, details = {}) {
  return {
    ok: false,
    row: { exitCode: 1, timedOut: false, json: { error: { code, message, retryable: false, details } } },
  };
}

function selectSearchNode(locator, hits) {
  const matches = hits.filter((hit) => hit?.nodeId
    && semanticKey(hit?.symbol ?? hit?.name) === semanticKey(locator.symbol)
    && String(hit?.locator?.filePath ?? hit?.filePath ?? "") === locator.filePath);
  const nodeIds = [...new Set(matches.map((hit) => hit.nodeId))];
  if (nodeIds.length === 0) {
    return semanticLocatorFailure("SEMANTIC_LOCATOR_NOT_FOUND", "the frozen symbol locator is absent from the selected revision", locator);
  }
  if (nodeIds.length > 1) {
    return semanticLocatorFailure("SEMANTIC_LOCATOR_AMBIGUOUS", "the frozen symbol locator resolved to multiple public node IDs", { ...locator, candidateCount: nodeIds.length });
  }
  return { ok: true, nodeId: nodeIds[0], target: `node:${nodeIds[0]}` };
}

function resolveSearchNode(locator) {
  const search = runCli(["search", locator.query, "--repo", repo, "--json"]);
  if (search.exitCode !== 0 || errorCode(search.json)) {
    return semanticLocatorFailure("SEMANTIC_LOCATOR_UNAVAILABLE", "semantic symbol locator query failed", {
      query: locator.query,
      productError: errorCode(search.json),
      exitCode: search.exitCode,
    });
  }
  const hits = search.json?.hits ?? search.json?.results ?? [];
  const selected = selectSearchNode(locator, hits);
  return selected.ok
    ? { ...selected, evidence: { locator, emittedBy: "search", revision: revisionOf(search.json) } }
    : selected;
}

function resolveEndpointNode(aliases, pages) {
  const aliasKeys = aliases.map(semanticKey);
  const matches = [];
  for (const page of pages) {
    for (const item of page.json?.items ?? []) {
      if (!item?.nodeId) continue;
      const forms = [item.identityKey, item.canonicalIdentity, item.title, item.route, ...(item.aliases ?? [])]
        .map(semanticKey)
        .filter(Boolean);
      if (forms.some((form) => aliasKeys.some((alias) => form === alias || form.endsWith(alias) || alias.endsWith(form)))) matches.push(item);
    }
  }
  const nodeIds = [...new Set(matches.map((item) => item.nodeId))];
  if (nodeIds.length === 0) {
    return semanticLocatorFailure("SEMANTIC_LOCATOR_NOT_FOUND", "the frozen endpoint identity is absent from the selected revision", { aliases });
  }
  if (nodeIds.length > 1) {
    return semanticLocatorFailure("SEMANTIC_LOCATOR_AMBIGUOUS", "the frozen endpoint identity resolved to multiple canonical endpoint IDs", { aliases, candidateCount: nodeIds.length });
  }
  return { ok: true, nodeId: nodeIds[0], target: `node:${nodeIds[0]}`, evidence: { aliases, emittedBy: "endpoints" } };
}
function redacted(value, key = "") {
  if (/(source|body|content|snippet|stdout|stderr)/iu.test(key)) return "<redacted>";
  if (typeof value === "string") return value.replaceAll(root, "<workspace>").replace(/\/Users\/[^/]+/gu, "<home>");
  if (Array.isArray(value)) return value.map((item) => redacted(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redacted(childValue, childKey)]));
  return value;
}

function parseFixtureTap(stdout) {
  const results = [];
  const numbers = new Set();
  let duplicate = false;
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.match(/^(ok|not ok)\s+(\d+)\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)(?:\s+.*)?)?$/u);
    if (!match) continue;
    const number = Number(match[2]);
    const name = match[3];
    if (numbers.has(number) || results.some((item) => item.name === name)) duplicate = true;
    numbers.add(number);
    results.push({
      number,
      name,
      status: match[4]?.toLowerCase() ?? (match[1] === "ok" ? "passed" : "failed"),
    });
  }
  const planMatches = [...String(stdout ?? "").matchAll(/^1\.\.(\d+)$/gmu)];
  const summary = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map((key) => {
    const matches = [...String(stdout ?? "").matchAll(new RegExp(`^# ${key}\\s+(\\d+)$`, "gmu"))];
    return [key, matches.length === 1 ? Number(matches[0][1]) : null];
  }));
  const expectedNames = Object.values(REQUIRED_FIXTURE_TESTS).flat();
  const observedNames = results.map((item) => item.name);
  const missing = expectedNames.filter((name) => !observedNames.includes(name));
  const unexpected = observedNames.filter((name) => !expectedNames.includes(name));
  const structurallyValid = planMatches.length === 1
    && Number(planMatches[0][1]) === results.length
    && Object.values(summary).every((value) => Number.isInteger(value))
    && summary.tests === results.length
    && summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo === summary.tests;
  return { results, summary, duplicate, missing, unexpected, structurallyValid };
}

function runFixtureAcceptance() {
  const fixtureTest = process.env.PENGUIN_ROUND17_FIXTURE_TEST ?? "tests/knowledge-round17-closure.test.mjs";
  const timeout = boundedTimeout(process.env.PENGUIN_ROUND17_FIXTURE_TIMEOUT_MS, 30_000);
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.NODE_TEST_CONTEXT;
  let result;
  try {
    result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixtureTest], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      killSignal: "SIGKILL",
      env: fixtureEnv,
    });
  } catch (error) {
    result = { status: 1, stdout: "", stderr: String(error), error };
  }
  const timedOut = result.error?.code === "ETIMEDOUT";
  const parsed = parseFixtureTap(result.stdout);
  const hasInvalidStatus = parsed.summary.cancelled > 0 || parsed.summary.skipped > 0 || parsed.summary.todo > 0
    || parsed.results.some((item) => item.status === "skip" || item.status === "todo");
  const reporterCode = timedOut
    ? "PROCESS_TIMEOUT"
    : result.error
      ? "PROCESS_LAUNCH_FAILED"
      : !parsed.structurallyValid
        ? "FIXTURE_REPORT_UNPARSEABLE"
        : hasInvalidStatus
          ? "FIXTURE_TEST_STATUS_INVALID"
          : parsed.duplicate || parsed.missing.length > 0 || parsed.unexpected.length > 0
            ? "FIXTURE_TEST_SET_MISMATCH"
            : result.status !== 0 && parsed.summary.fail === 0
              ? "FIXTURE_PROCESS_FAILED"
              : null;
  const gates = Object.entries(REQUIRED_FIXTURE_TESTS).map(([id, names]) => {
    const tests = names.map((name) => parsed.results.find((item) => item.name === name) ?? { name, status: "missing" });
    const passed = reporterCode == null && tests.every((item) => item.status === "passed");
    return {
    id,
    hard: true,
      passed,
      evidence: reporterCode == null
        ? { fixtureTest, tests }
        : { fixtureTest, tests, error: { code: reporterCode, exitCode: timedOut ? 124 : result.status ?? 1, missing: parsed.missing, unexpected: parsed.unexpected, duplicate: parsed.duplicate, summary: parsed.summary } },
    };
  });
  const failures = gates.filter((gate) => !gate.passed).map((gate) => ({ id: gate.id, evidence: gate.evidence }));
  const capabilityHash = failures.length === 0
    ? createHash("sha256").update(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).digest("hex")
    : null;
  return {
    passed: failures.length === 0,
    gates,
    failures,
    buildId: failures.length === 0 ? "round17-deterministic-fixture" : null,
    capabilityHash,
    revision: failures.length === 0 ? "round17-fixture-v1" : null,
  };
}

async function runRealAcceptance() {
  const cliCapabilities = runCli(["capabilities", "--json"]);
  const cursor = endpointCursorLifecycle();
  const cliRepoEndpoints = cursor.pages[0] ?? deadlineFailure("CLI endpoint inventory");
  const affectedLocator = resolveSearchNode(frozen.affectedSymbol);
  const contextLocator = resolveEndpointNode(frozen.contextEndpoint, cursor.pages);
  const crossRepoLocator = resolveEndpointNode(frozen.crossRepoEndpoint, cursor.pages);
  const cliAffectedFile = runCli(["affected", frozen.affectedFile, "--repo", repo, "--json"]);
  const cliAffectedNode = affectedLocator.ok
    ? runCli(["affected", affectedLocator.target, "--repo", repo, "--json"])
    : affectedLocator.row;
  const cliCrossFlow = crossRepoLocator.ok
    ? runCli(["flow", crossRepoLocator.target, "--repo", frozen.foreignRepo, "--json"])
    : crossRepoLocator.row;
  const cliForeignEndpoints = runCli(["endpoints", frozen.foreignRepo, "--protocol", "grpc", "--limit", "100", "--json"]);
  const cliContext = contextLocator.ok
    ? runCli(["context", contextLocator.target, "--repo", repo, "--json"])
    : contextLocator.row;
  const cliFlow = contextLocator.ok
    ? runCli(["flow", contextLocator.target, "--repo", repo, "--json"])
    : contextLocator.row;
  const cliFreshness = runCli(["search", "constructor", "--repo", repo, "--json"]);
  const branchName = cliFreshness.json?.revision?.branch ?? cliFreshness.json?.locator?.branchName ?? null;
  const fileSymbolsCursor = cliCursorLifecycle({
    name: "filesymbols",
    firstArgs: ["filesymbols", repo, branchName ?? "", frozen.affectedSymbol.filePath, "--limit", "1", "--json"],
    nextArgs: (cursorValue) => ["filesymbols", repo, branchName ?? "", frozen.affectedSymbol.filePath, "--limit", "1", "--cursor", cursorValue, "--json"],
    invalidArgs: ["filesymbols", repo, branchName ?? "", frozen.affectedSymbol.filePath, "--cursor", "round17-malformed-cursor", "--json"],
    wrongScopeArgs: (cursorValue) => ["filesymbols", repo, branchName ?? "", frozen.affectedFile, "--limit", "1", "--cursor", cursorValue, "--json"],
  });
  const deadCodeCursor = cliCursorLifecycle({
    name: "deadcode",
    firstArgs: ["deadcode", "--repo", repo, "--limit", "1000", "--json"],
    nextArgs: (cursorValue) => ["deadcode", "--repo", repo, "--limit", "1000", "--cursor", cursorValue, "--json"],
    invalidArgs: ["deadcode", "--repo", repo, "--cursor", "round17-malformed-cursor", "--json"],
    wrongScopeArgs: (cursorValue) => ["deadcode", "--repo", frozen.foreignRepo, "--limit", "1000", "--cursor", cursorValue, "--json"],
    maxPages: 10,
  });
  const errorProbes = [
    { id: "empty-query", expected: ["INVALID_QUERY"], cliArgs: ["search", "", "--repo", repo, "--json"], mcp: { name: "knowledge_search", arguments: { query: "", repo } } },
    { id: "unknown-repo", expected: ["REPOSITORY_NOT_FOUND"], cliArgs: ["search", "constructor", "--repo", "ROUND17_UNKNOWN_REPO", "--json"], mcp: { name: "knowledge_search", arguments: { query: "constructor", repo: "ROUND17_UNKNOWN_REPO" } } },
    { id: "unknown-branch", expected: ["BRANCH_NOT_FOUND"], cliArgs: ["search", "constructor", "--repo", repo, "--branch", "round17-missing-branch", "--json"], mcp: { name: "knowledge_search", arguments: { query: "constructor", repo, branch: "round17-missing-branch" } } },
    { id: "unknown-file", expected: ["FILE_NOT_FOUND"], cliArgs: ["filesymbols", repo, branchName ?? "", "missing.ts", "--json"], mcp: { name: "knowledge_file_symbols", arguments: { repo, branch: branchName ?? "", file_path: "missing.ts" } } },
    { id: "invalid-node", expected: ["INVALID_TARGET"], cliArgs: ["context", "node:round17-invalid-node", "--repo", repo, "--json"], mcp: { name: "knowledge_context", arguments: { repo, target: "node:round17-invalid-node" } } },
    { id: "malformed-cursor", expected: ["CURSOR_INVALID"], cliArgs: ["endpoints", repo, "--cursor", "round17-malformed-cursor", "--json"], mcp: { name: "knowledge_endpoints", arguments: { repo, protocol: "grpc", page: { cursor: "round17-malformed-cursor" } } } },
  ];
  for (const probe of errorProbes) probe.cli = runCli(probe.cliArgs);

  const mcpCalls = [];
  const addMcp = (key, name, args) => mcpCalls.push({ key, name, arguments: args });
  addMcp("capabilities", "knowledge_capabilities", { compact: true });
  addMcp("affected-file", "knowledge_affected", { repo, files: [frozen.affectedFile] });
  if (affectedLocator.ok) addMcp("affected-node", "knowledge_affected", { repo, target: affectedLocator.target });
  if (crossRepoLocator.ok) addMcp("cross-flow", "knowledge_flow", { repo: frozen.foreignRepo, target: crossRepoLocator.target });
  addMcp("endpoints", "knowledge_endpoints", { repo, protocol: "grpc", page: { limit: 500 } });
  if (contextLocator.ok) {
    addMcp("context", "knowledge_context", { repo, target: contextLocator.target });
    addMcp("flow", "knowledge_flow", { repo, target: contextLocator.target });
  }
  addMcp("freshness", "knowledge_search", { query: "constructor", repo });
  for (const probe of errorProbes) addMcp(`error:${probe.id}`, probe.mcp.name, probe.mcp.arguments);
  addMcp("api-doc-list", "api_doc_list", { limit: 3 });
  addMcp("note-list", "knowledge_note_list", {});
  const mcpRun = await runMcp(mcpCalls);
  const mcpRows = mcpRun.rows;
  const mcpByKey = new Map(mcpCalls.map((call, index) => [call.key, mcpRows[index]]));
  const mcpValueFor = (key, locator) => mcpByKey.get(key)?.value ?? locator?.row?.json ?? { error: { code: "MCP_RESULT_MISSING", message: `${key} result missing`, retryable: true } };
  const mcpCapabilities = mcpValueFor("capabilities");
  const mcpAffectedFile = mcpValueFor("affected-file");
  const mcpAffectedNode = mcpValueFor("affected-node", affectedLocator);
  const mcpCrossFlow = mcpValueFor("cross-flow", crossRepoLocator);
  const mcpEndpoints = mcpValueFor("endpoints");
  const mcpContext = mcpValueFor("context", contextLocator);
  const mcpFlow = mcpValueFor("flow", contextLocator);
  const mcpFreshness = mcpValueFor("freshness");
  const mcpErrors = errorProbes.map((probe) => mcpValueFor(`error:${probe.id}`));
  const mcpApiDocList = mcpValueFor("api-doc-list");
  const mcpNoteList = mcpValueFor("note-list");
  const cliApiDocList = runCli(["api-doc", "list", "--json"]);
  const cliNoteList = runCli(["note", "list", "--json"]);
  const emittedEndpointId = cliRepoEndpoints.json?.items?.[0]?.nodeId ?? null;
  const mcpIdFollowupRun = emittedEndpointId
    ? await runMcp([{ name: "knowledge_context", arguments: { repo, target: `node:${emittedEndpointId}` } }])
    : null;
  const mcpIdFollowup = mcpIdFollowupRun?.rows[0]
    ?? { exitCode: 1, timedOut: false, value: { error: { code: "ID_MISSING", message: "endpoint inventory emitted no nodeId", retryable: false } } };

  const gates = [];
  function record(id, passed, evidence, hard = true) { gates.push({ id, hard, passed: Boolean(passed), evidence: redacted(evidence) }); }

  if (!mcpRun.ok) record("HARNESS", false, { error: mcpRun.error });
  if (mcpIdFollowupRun && !mcpIdFollowupRun.ok) record("HARNESS", false, { error: mcpIdFollowupRun.error, phase: "emitted-id-followup" });

  const capabilityParity = equalNonEmptyCapabilities(cliCapabilities.json, mcpCapabilities);

  record("G1-affected-parity", mcpRun.ok && capabilityParity && affectedLocator.ok && cliAffectedFile.exitCode === 0 && cliAffectedNode.exitCode === 0
    && JSON.stringify(affected(cliAffectedFile.json)) === JSON.stringify(affected(mcpAffectedFile))
    && JSON.stringify(affected(cliAffectedNode.json)) === JSON.stringify(affected(mcpAffectedNode)), {
    capabilities: { cli: capabilityProjection(cliCapabilities.json), mcp: capabilityProjection(mcpCapabilities), equalNonEmpty: capabilityParity },
    locator: affectedLocator.ok ? affectedLocator.evidence : affectedLocator.row.json.error,
    cli: { file: affected(cliAffectedFile.json), node: affected(cliAffectedNode.json), exits: [cliAffectedFile.exitCode, cliAffectedNode.exitCode] },
    mcp: { file: affected(mcpAffectedFile), node: affected(mcpAffectedNode) },
  });
  record("G2-cross-repository-scope", mcpRun.ok && crossRepoLocator.ok && errorCode(cliCrossFlow.json) === "SCOPE_MISMATCH" && errorCode(mcpCrossFlow) === "SCOPE_MISMATCH", {
    locator: crossRepoLocator.ok ? crossRepoLocator.evidence : crossRepoLocator.row.json.error,
    cli: { exitCode: cliCrossFlow.exitCode, error: errorCode(cliCrossFlow.json) }, mcp: { error: errorCode(mcpCrossFlow) },
  });
  const repoEndpointIds = ids(cliRepoEndpoints.json?.items);
  const foreignEndpointIds = ids(cliForeignEndpoints.json?.items);
  const cliHandlerTruth = endpointHandlerTruth(cursor.pages);
  const mcpHandlerTruth = endpointHandlerTruth([{ json: mcpEndpoints }]);
  record("G3-endpoint-parity-and-membership", mcpRun.ok && contextLocator.ok && crossRepoLocator.ok && cliRepoEndpoints.exitCode === 0 && cliForeignEndpoints.exitCode === 0
    && JSON.stringify(endpointProjection(cliRepoEndpoints.json)) === JSON.stringify(endpointProjection(mcpEndpoints))
    && cliHandlerTruth && mcpHandlerTruth
    && !repoEndpointIds.some((id) => foreignEndpointIds.includes(id)), {
    locators: [contextLocator, crossRepoLocator].map((locator) => locator.ok ? locator.evidence : locator.row.json.error),
    cli: { ...endpointProjection(cliRepoEndpoints.json), handlerTruth: cliHandlerTruth }, mcp: { ...endpointProjection(mcpEndpoints), handlerTruth: mcpHandlerTruth }, foreign: { count: foreignEndpointIds.length, fingerprint: createHash("sha256").update(JSON.stringify(foreignEndpointIds)).digest("hex"), sample: foreignEndpointIds.slice(0, 3) },
  });
  const firstHopProjections = [firstHop(cliContext.json, true), firstHop(cliFlow.json), firstHop(mcpContext, true), firstHop(mcpFlow)];
  record("G4-context-flow-first-hop", mcpRun.ok && contextLocator.ok && cliContext.exitCode === 0 && cliFlow.exitCode === 0
    && firstHopProjections.every((projection) => JSON.stringify(projection) === JSON.stringify(firstHopProjections[0])), {
    locator: contextLocator.ok ? contextLocator.evidence : contextLocator.row.json.error,
    cli: {
      context: firstHop(cliContext.json, true),
      flow: firstHop(cliFlow.json),
      transport: { context: cliProbeProjection(cliContext), flow: cliProbeProjection(cliFlow) },
    },
    mcp: { context: firstHop(mcpContext, true), flow: firstHop(mcpFlow) },
  });
  const readRevisions = [cliFreshness.json, cliRepoEndpoints.json, cliContext.json, cliFlow.json, cliAffectedFile.json, mcpFreshness, mcpEndpoints, mcpContext, mcpFlow, mcpAffectedFile].map(topLevelRevisionOf);
  const sameReadRevision = readRevisions.every((revision) => typeof revision === "string" && revision.length > 0) && new Set(readRevisions).size === 1;
  record("G5-freshness", mcpRun.ok && sameReadRevision && cliFreshness.exitCode === 0 && cliFreshness.json?.freshness?.status === "fresh"
    && Boolean(cliFreshness.json?.coverage) && cliFreshness.json?.coverage?.status !== "exhaustive"
    && cliFreshness.json?.freshness?.status === mcpFreshness?.freshness?.status, {
    revisions: readRevisions, sameRevision: sameReadRevision,
    cli: { freshness: cliFreshness.json?.freshness ?? null, coverage: cliFreshness.json?.coverage ?? null, revision: topLevelRevisionOf(cliFreshness.json), endpointsRevision: topLevelRevisionOf(cliRepoEndpoints.json) }, mcp: { freshness: mcpFreshness?.freshness ?? null, coverage: mcpFreshness?.coverage ?? null, revision: topLevelRevisionOf(mcpFreshness), endpointsRevision: topLevelRevisionOf(mcpEndpoints) },
  });
  record("G6-typed-error-parity", mcpRun.ok && errorProbes.every((probe, index) => {
    const cliCode = errorCode(probe.cli.json);
    const mcpCode = errorCode(mcpErrors[index]);
    return typedFailure(probe.cli) && isProductErrorCode(cliCode, probe.expected) && isProductErrorCode(mcpCode, probe.expected) && cliCode === mcpCode;
  }), errorProbes.map((probe, index) => ({ id: probe.id, expected: probe.expected, cli: { exitCode: probe.cli.exitCode, error: errorCode(probe.cli.json) }, mcp: { error: errorCode(mcpErrors[index]) } })));
  const cursorSurfaces = [cursor, fileSymbolsCursor, deadCodeCursor];
  const cursorSurfacesPass = cursorSurfaces.every((surface) => surface.normal && surface.exhausted && !surface.capped
    && errorCode(surface.invalid.json) === "CURSOR_INVALID" && errorCode(surface.wrongScope.json) === "CURSOR_SCOPE_MISMATCH");
  record("G7-id-and-cursor-continuity", mcpRun.ok && mcpIdFollowupRun?.ok === true && cursorSurfacesPass && Boolean(emittedEndpointId) && mcpIdFollowup.exitCode === 0
    && mcpIdFollowup.value?.target?.nodeId === emittedEndpointId && cursor.normal && cursor.exhausted && !cursor.capped
    && errorCode(cursor.invalid.json) === "CURSOR_INVALID" && errorCode(cursor.wrongScope.json) === "CURSOR_SCOPE_MISMATCH", {
    endpointId: emittedEndpointId, mcpFollowup: { exitCode: mcpIdFollowup.exitCode, error: errorCode(mcpIdFollowup.value), target: mcpIdFollowup.value?.target?.nodeId ?? null }, cursors: cursorSurfaces.map((surface) => ({ name: surface.name ?? "endpoints", pages: surface.pages.length, uniqueIds: surface.uniqueIds, normal: surface.normal, exhausted: surface.exhausted, capped: surface.capped, invalid: errorCode(surface.invalid.json), wrongScope: errorCode(surface.wrongScope.json) })),
  });
  record("G8-api-doc-and-list-honesty", mcpRun.ok && apiPreviewHonesty(cliApiDocList.json) && honestList(cliNoteList.json)
    && apiPreviewHonesty(mcpApiDocList) && honestList(mcpNoteList), {
    cli: { apiDoc: listProjection(cliApiDocList.json), notes: listProjection(cliNoteList.json) }, mcp: { apiDoc: listProjection(mcpApiDocList), notes: listProjection(mcpNoteList) },
  });
  const failures = gates.filter((gate) => gate.hard && !gate.passed).map(({ id, evidence }) => ({ id, evidence }));
  const envelope = {
    passed: failures.length === 0,
    gates,
    failures,
    buildId: cliCapabilities.json?.buildId ?? mcpCapabilities?.buildId ?? null,
    capabilityHash: cliCapabilities.json?.capabilityHash ?? mcpCapabilities?.capabilityHash ?? null,
    revision: revisionOf(cliFreshness.json) ?? revisionOf(cliContext.json) ?? null,
  };
  emitOnce(envelope);
  if (gateMode && !envelope.passed) process.exitCode = 1;
}

if (mcpHarnessProbeMode) {
  const probe = runMcpBatch([{ name: "knowledge_capabilities", arguments: { compact: true } }]);
  emitOnce({ passed: probe.ok, error: probe.error, rows: probe.rows.map((row) => ({ name: row.name, exitCode: row.exitCode, timedOut: row.timedOut, error: row.value?.error ?? null })) });
  if (gateMode && !probe.ok) process.exitCode = 1;
} else if (fixtureMode) {
  const envelope = runFixtureAcceptance();
  emitOnce(envelope);
  if (gateMode && !envelope.passed) process.exitCode = 1;
} else {
  await runRealAcceptance();
}
