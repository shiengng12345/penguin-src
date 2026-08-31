#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const gateMode = argv.includes("--gate");
const fixturesOnly = argv.includes("--fixtures-only");
const repo = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : "FPMS-NT";

const briefPath = resolve(root, "docs/quality/index-evaluation-brief-round19.md");
const contractPath = resolve(root, "tests/fixtures/knowledge-round19/expected-contract.json");

function computeBriefSha256() {
  const content = readFileSync(briefPath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

function runCli(args, opts = {}) {
  const launcher = resolve(root, "scripts/knowledge-cli-launcher.mjs");
  const result = spawnSync(process.execPath, [launcher, ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 10_000,
    ...opts,
  });
  let json = null;
  if (result.stdout || result.stderr) {
    const lines = (result.stdout + result.stderr).split("\n");
    for (const line of lines) {
      try {
        json = JSON.parse(line);
        break;
      } catch {}
    }
  }
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    json,
    timedOut: result.signal === "SIGTERM",
  };
}

const gates = [];
let passed = true;

function gate(id, description, fn) {
  const start = Date.now();
  let gateResult = { id, description, passed: false, evidence: {}, duration: 0 };
  try {
    const evidence = fn();
    gateResult.evidence = evidence ?? {};
    // FIXED: Explicitly check evidence.passed === false and propagate as gate failure
    if (evidence && evidence.passed === false) {
      gateResult.passed = false;
      passed = false;
    } else {
      gateResult.passed = true;
    }
  } catch (error) {
    gateResult.passed = false;
    gateResult.evidence = { error: error.message, stack: error.stack };
    passed = false;
  }
  gateResult.duration = Date.now() - start;
  gates.push(gateResult);
  return gateResult;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// Gate G0: Contract identity
gate("G0", "Contract identity verification", () => {
  const caps = runCli(["capabilities", "--json"]);
  assert(caps.exitCode === 0, `capabilities failed: ${caps.stderr}`);
  assert(caps.json, "capabilities did not return JSON");
  assert(typeof caps.json.buildId === "string" && caps.json.buildId.length > 0, "buildId missing or empty");
  assert(typeof caps.json.capabilityHash === "string" && caps.json.capabilityHash.length > 0, "capabilityHash missing or empty");
  const schemaVersion = typeof caps.json.schemaVersion === "string" ? parseInt(caps.json.schemaVersion, 10) : caps.json.schemaVersion;
  assert(typeof schemaVersion === "number" && !isNaN(schemaVersion), "schemaVersion not numeric");
  assert(caps.json.contractVersion === "2", `contractVersion is ${caps.json.contractVersion}, expected "2"`);

  return {
    buildId: caps.json.buildId,
    capabilityHash: caps.json.capabilityHash,
    schemaVersion,
    contractVersion: caps.json.contractVersion,
  };
});

if (fixturesOnly) {
  // Fixture-only mode: just validate contract and exit
  const briefSha256 = computeBriefSha256();
  const expectedContract = JSON.parse(readFileSync(contractPath, "utf8"));
  const result = {
    mode: "fixtures-only",
    passed: gates.every((g) => g.passed),
    briefSha256,
    gates,
    expectedContract,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.passed ? 0 : 1;
} else {
  // Full acceptance mode
  const briefSha256 = computeBriefSha256();
  const header = {
    briefVersion: "Round19",
    briefSha256,
    buildId: gates.find((g) => g.id === "G0")?.evidence?.buildId ?? null,
    capabilityHash: gates.find((g) => g.id === "G0")?.evidence?.capabilityHash ?? null,
    schemaVersion: gates.find((g) => g.id === "G0")?.evidence?.schemaVersion ?? null,
    contractVersion: gates.find((g) => g.id === "G0")?.evidence?.contractVersion ?? null,
    runtimePath: process.execPath,
    clientSessionId: `round19-${Date.now()}`,
    startedAt: new Date().toISOString(),
  };

  // Gate G1: Basic operations
  let searchNodeId = null;
  let searchFilePath = null;

  gate("G1.1", "Search with results", () => {
    const result = runCli(["search", "constructor", "--repo", repo, "--json"]);
    assert(result.exitCode === 0, `search failed: ${result.stderr}`);
    assert(result.json, "search did not return JSON");
    const hits = result.json.hits ?? result.json.results;
    assert(Array.isArray(hits), "hits is not an array");
    assert(hits.length > 0, "hits array is empty");
    const first = hits[0];
    assert(first.nodeId, "first hit missing nodeId");
    assert(first.title, "first hit missing title");
    assert(first.kind, "first hit missing kind");
    assert(first.locator?.filePath, "first hit missing locator.filePath");
    searchNodeId = first.nodeId;
    searchFilePath = first.locator.filePath;
    return { nodeId: searchNodeId, filePath: searchFilePath, hitCount: hits.length };
  });

  gate("G1.2", "File symbols", () => {
    assert(searchFilePath, "searchFilePath not available from G1.1");
    const result = runCli(["filesymbols", repo, "brazil-v2", searchFilePath, "--json"]);
    // Allow failure if branch doesn't exist, but record it
    if (result.exitCode !== 0 && result.json?.error?.code === "BRANCH_NOT_FOUND") {
      // Try without branch
      const result2 = runCli(["filesymbols", repo, "main", searchFilePath, "--json"]);
      if (result2.exitCode === 0 && result2.json) {
        assert(Array.isArray(result2.json.items), "items is not an array");
        return { itemCount: result2.json.items.length, usedBranch: "main", candidateCount: result2.json.candidateCount };
      }
    }
    assert(result.exitCode === 0, `filesymbols failed: ${result.stderr}`);
    assert(result.json, "filesymbols did not return JSON");
    assert(Array.isArray(result.json.items), "items is not an array");
    assert(result.json.candidateCount >= 1, "candidateCount < 1");
    assert(typeof result.json.totalIsExact === "boolean", "totalIsExact is not boolean");
    return { itemCount: result.json.items.length, candidateCount: result.json.candidateCount };
  });

  gate("G1.3", "Context from node", () => {
    assert(searchNodeId, "searchNodeId not available from G1.1");
    const result = runCli(["context", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    assert(result.exitCode === 0, `context failed: ${result.stderr}`);
    assert(result.json, "context did not return JSON");

    // Check both focus and node field names as per contract
    const focus = result.json.focus ?? result.json.node;
    assert(focus, "focus/node object missing from response");
    assert(focus.nodeId, "focus.nodeId missing");
    assert(focus.title, "focus.title missing");
    assert(focus.kind, "focus.kind missing");

    // Check first-hop relations: either firstHopRelations array OR separate edge arrays
    const hasFirstHopRelations = Array.isArray(result.json.firstHopRelations);
    const hasEdgeArrays = Array.isArray(result.json.callers) || Array.isArray(result.json.calls) ||
                          Array.isArray(result.json.renders) || Array.isArray(result.json.renderedBy);
    assert(hasFirstHopRelations || hasEdgeArrays, "No first-hop relation arrays found (neither firstHopRelations nor edge arrays)");

    // Require at least one relation field to be non-empty for connectivity
    const relationCount = (result.json.callers?.length ?? 0) + (result.json.calls?.length ?? 0) +
                          (result.json.renders?.length ?? 0) + (result.json.renderedBy?.length ?? 0) +
                          (result.json.firstHopRelations?.length ?? 0);
    assert(relationCount > 0, "At least one relation field must be non-empty to demonstrate connectivity");

    const usedFields = {
      focusField: result.json.focus ? "focus" : "node",
      relationField: hasFirstHopRelations ? "firstHopRelations" : "edge arrays",
    };

    return { nodeId: focus.nodeId, relationCount, usedFields };
  });

  // Gate G2: Pagination
  let endpointId = null;
  let endpointCursor = null;

  gate("G2.1", "Endpoints page 1", () => {
    const result = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--json"]);
    assert(result.exitCode === 0, `endpoints failed: ${result.stderr}`);
    assert(result.json, "endpoints did not return JSON");
    assert(Array.isArray(result.json.items), "items is not an array");
    assert(result.json.items.length === 1, "items length must be exactly 1");
    assert(result.json.candidateCount >= 1, "candidateCount must be >= 1");
    endpointId = result.json.items[0].nodeId;
    endpointCursor = result.json.nextCursor;
    // G2.2 requires cursor from G2.1, so nextCursor must be non-empty string
    assert(typeof endpointCursor === "string" && endpointCursor.length > 0, "Required upstream data for G2.2: nextCursor must be non-empty string");
    return { endpointId, hasCursor: true, candidateCount: result.json.candidateCount };
  });

  gate("G2.2", "Endpoints page 2", () => {
    assert(endpointCursor, "Required upstream data missing: no cursor from G2.1");
    const result = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--cursor", endpointCursor, "--json"]);
    assert(result.exitCode === 0, `endpoints page 2 failed: ${result.stderr}`);
    assert(result.json, "endpoints did not return JSON");
    assert(result.json.items && result.json.items.length > 0, "page 2 must have items");
    assert(result.json.items[0].nodeId !== endpointId, "page 2 returned same nodeId as page 1");
    return { differentNode: true, candidateCount: result.json.candidateCount };
  });

  // G2.3: Actual cursor exhaustion
  gate("G2.3", "Cursor exhaustion", () => {
    let cursor = null;
    let page = 0;
    const pages = [];
    const allIds = new Set();
    let lastResult = null;

    // Start from page 1
    const firstPage = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--json"]);
    assert(firstPage.exitCode === 0, `endpoints command failed: ${firstPage.stderr}`);
    assert(firstPage.json, "endpoints did not return JSON");
    assert(Array.isArray(firstPage.json.items) && firstPage.json.items.length > 0, "Required upstream data missing: G2.3 requires at least one item in first page");

    cursor = firstPage.json.nextCursor;
    page = 1;
    const firstPageIds = (firstPage.json.items ?? []).map(item => item.nodeId);
    firstPageIds.forEach(id => allIds.add(id));
    pages.push({
      page: 1,
      itemCount: firstPageIds.length,
      cursor: cursor,
      ids: firstPageIds,
    });
    lastResult = firstPage.json;

    // Continue until cursor is null
    const safetyPageCap = 50;
    while (cursor !== null && cursor !== undefined && page < safetyPageCap) {
      const result = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--cursor", cursor, "--json"]);
      assert(result.exitCode === 0, `cursor continuation failed at page ${page + 1}`);
      assert(result.json, `no JSON at page ${page + 1}`);

      page++;
      const pageIds = (result.json.items ?? []).map(item => item.nodeId);
      pageIds.forEach(id => allIds.add(id));
      pages.push({
        page,
        itemCount: pageIds.length,
        cursor: result.json.nextCursor,
        ids: pageIds,
      });

      cursor = result.json.nextCursor;
      lastResult = result.json;
    }

    // FIXED: Fail if safety page cap is reached
    assert(page < safetyPageCap, `safety page cap ${safetyPageCap} reached without cursor exhaustion`);

    // Assert actual cursor exhaustion: final page has no cursor and truncated is false
    assert(cursor === null || cursor === undefined, "Required evidence missing: final page still has cursor, pagination not exhausted");
    const truncated = lastResult.truncated ?? false;
    assert(truncated === false, `Required evidence missing: final page has truncated=${truncated}, expected false for complete exhaustion`);

    // Check for duplicates
    const totalItems = pages.reduce((sum, p) => sum + p.itemCount, 0);
    const duplicateCount = totalItems - allIds.size;

    return {
      totalPages: pages.length,
      totalItems,
      uniqueItems: allIds.size,
      duplicateCount,
      finalTruncated: truncated,
      pagesDetail: pages.map(p => ({page: p.page, itemCount: p.itemCount, hasCursor: !!p.cursor})),
    };
  });

  // Gate G3: Scope errors
  gate("G3.1", "Missing repository", () => {
    const result = runCli(["search", "test", "--repo", "NONEXISTENT-REPO", "--json"]);
    assert(result.exitCode !== 0, "search should fail for nonexistent repo");
    assert(result.json?.error?.code === "REPOSITORY_NOT_FOUND", `expected REPOSITORY_NOT_FOUND, got ${result.json?.error?.code}`);
    return { errorCode: result.json.error.code };
  });

  gate("G3.2", "Invalid node ID", () => {
    const result = runCli(["context", "node:invalid-node-id", "--repo", repo, "--json"]);
    assert(result.exitCode !== 0, "context should fail for invalid node ID");
    assert(result.json?.error?.code === "INVALID_TARGET", `expected INVALID_TARGET, got ${result.json?.error?.code}`);
    return { errorCode: result.json.error.code };
  });

  gate("G3.3", "Malformed cursor", () => {
    const result = runCli(["endpoints", repo, "--cursor", "malformed", "--json"]);
    assert(result.exitCode !== 0, "endpoints should fail for malformed cursor");
    assert(result.json?.error?.code === "CURSOR_INVALID", `expected CURSOR_INVALID, got ${result.json?.error?.code}`);
    return { errorCode: result.json.error.code };
  });

  // Gate G4: Freshness and coverage
  gate("G4", "Freshness and coverage", () => {
    const status = runCli(["status", "--compact", "--json", "--repo", repo]);
    const coverage = runCli(["coverage", "--repo", repo, "--json"]);

    // Both commands must succeed
    assert(status.exitCode === 0, `status command failed with exit ${status.exitCode}: ${status.stderr}`);
    assert(coverage.exitCode === 0, `coverage command failed with exit ${coverage.exitCode}: ${coverage.stderr}`);

    const statusJson = status.json;
    const coverageJson = coverage.json;

    assert(statusJson || coverageJson, "neither status nor coverage returned JSON");

    // Extract freshness from either command
    const freshness = statusJson?.freshness ?? coverageJson?.freshness;
    assert(freshness, "freshness field missing from both status and coverage");
    assert(freshness.status, "freshness.status missing");
    assert(["fresh", "stale", "partial"].includes(freshness.status), `invalid freshness.status: ${freshness.status}`);

    // Extract coverage
    assert(coverageJson, "coverage command did not return JSON");
    assert(typeof coverageJson.indexed === "number", `coverage.indexed is not numeric: ${typeof coverageJson.indexed}`);
    assert(coverageJson.indexed >= 0, `coverage.indexed is negative: ${coverageJson.indexed}`);

    return {
      statusExitCode: status.exitCode,
      coverageExitCode: coverage.exitCode,
      freshness: freshness.status,
      indexed: coverageJson.indexed,
    };
  });

  // Gate G5: Affected
  gate("G5", "Affected analysis", () => {
    assert(searchFilePath, "Required upstream data missing: no file from G1.2");
    const result = runCli(["affected", searchFilePath, "--repo", repo, "--json"]);
    assert(result.exitCode === 0, `affected failed: ${result.stderr}, error code: ${result.json?.error?.code}`);
    assert(result.json, "affected did not return JSON");
    assert(Array.isArray(result.json.changed), "changed must be an array");
    assert(Array.isArray(result.json.impacted), "impacted must be an array");
    assert(result.json.revision && result.json.revision.revisionId, "revision.revisionId missing");
    return { hasRevision: true, changed: result.json.changed.length, impacted: result.json.impacted.length };
  });

  // Gate G6: Endpoint identity
  gate("G6", "Endpoint identity forms", () => {
    assert(endpointId, "Required upstream data missing: no endpoint from G2.1");
    const byNodeId = runCli(["context", `node:${endpointId}`, "--repo", repo, "--json"]);
    assert(byNodeId.exitCode === 0, `context by node ID failed: ${byNodeId.stderr}`);
    assert(byNodeId.json, "context did not return JSON");
    const focus = byNodeId.json.focus ?? byNodeId.json.node;
    assert(focus && focus.nodeId, "focus/node with nodeId missing");
    return { endpointId, resolvedNodeId: focus.nodeId };
  });

  // Gate G7: Flow
  gate("G7", "Flow tracing", () => {
    assert(endpointId, "Required upstream data missing: no endpoint from G2.1");
    const result = runCli(["flow", `node:${endpointId}`, "--repo", repo, "--json"]);
    assert(result.exitCode === 0, `flow failed: ${result.stderr}, error code: ${result.json?.error?.code}`);
    assert(result.json, "flow did not return JSON");
    assert(Array.isArray(result.json.steps), "Required upstream data missing: steps array not present");
    // FIXED: Fail when steps is empty
    assert(result.json.steps.length > 0, "steps array must not be empty");
    // FIXED: Require a depth-0 root and its via field
    const root = result.json.steps.find((s) => s.depth === 0);
    assert(root, "Required upstream data missing: non-empty steps array must have at least one step with depth 0");
    assert(typeof root.via === "string" || root.via === null, "root.via must be string or null");
    return { stepCount: result.json.steps.length, hasRoot: true };
  });

  // Gate G8: Callers and callees
  gate("G8", "Callers and callees", () => {
    assert(searchNodeId, "Required upstream data missing: no node from G1.1");
    const callers = runCli(["callers", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    const callees = runCli(["callees", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    assert(callers.exitCode === 0, `callers failed: ${callers.stderr}`);
    assert(callees.exitCode === 0, `callees failed: ${callees.stderr}`);
    assert(callers.json, "callers did not return JSON");
    assert(callees.json, "callees did not return JSON");
    assert(callers.json.revision, "callers missing revision");
    assert(callees.json.revision, "callees missing revision");
    return {
      callersExitCode: callers.exitCode,
      calleesExitCode: callees.exitCode,
      callersHasRevision: true,
      calleesHasRevision: true,
    };
  });

  // Gate G9: Deadcode
  gate("G9", "Deadcode listing", () => {
    const result = runCli(["deadcode", "--repo", repo, "--limit", "5", "--json"]);

    // Allow either success OR structured error indicating deadcode unavailable
    if (result.exitCode !== 0) {
      if (result.json?.error?.code) {
        // Structured error is acceptable (feature unavailable, etc.)
        return {
          exitCode: result.exitCode,
          errorCode: result.json.error.code,
          note: "deadcode command returned structured error (acceptable per brief)",
        };
      }
      // Unstructured error fails the gate
      assert(false, `deadcode failed without structured error: ${result.stderr}`);
    }

    assert(result.json, "Required upstream data missing: deadcode did not return JSON");
    assert(Array.isArray(result.json.items), "Required upstream data missing: items is not array");
    assert(result.json.proofStatus, "Required upstream data missing: proofStatus field missing");
    const proofStatus = result.json.proofStatus;
    assert(proofStatus === "candidate" || proofStatus === "not_proven", `Required upstream data invalid: proofStatus is ${proofStatus}, must be "candidate" or "not_proven" (never "proven")`);
    return { itemCount: result.json.items.length, proofStatus };
  });

  // Gate G10: MCP/CLI parity
  gate("G10", "MCP/CLI parity", () => {
    // FIXED: Real MCP availability probe required before reporting N/A
    const mcpLauncher = resolve(root, "scripts/knowledge-mcp-launcher.mjs");
    const mcpProbe = spawnSync(process.execPath, [mcpLauncher, "--help"], {
      encoding: "utf8",
      timeout: 5000,
    });

    // FIXED: Explicit N/A/not_proven only after launcher probe
    if (mcpProbe.error || mcpProbe.status !== 0) {
      // MCP unavailable after probe - return explicit N/A evidence as non-passing
      return {
        status: "not_proven",
        reason: `MCP server connection failed after probe: ${mcpProbe.error?.message ?? mcpProbe.stderr ?? "launcher not found"}`,
        probe: {
          launcherPath: mcpLauncher,
          exitCode: mcpProbe.status,
          error: mcpProbe.error?.message,
        },
        passed: false,
      };
    }

    // MCP launcher available but full parity test requires separate MCP client session
    // FIXED: Must remain non-passing until actual MCP parity runs
    return {
      status: "not_proven",
      reason: "MCP launcher available but full parity test requires separate MCP client session (beyond CLI runner scope)",
      probe: {
        launcherPath: mcpLauncher,
        exitCode: mcpProbe.status,
        available: true,
      },
      note: "Actual MCP parity verification required: compare knowledge_capabilities/knowledge_search/knowledge_context with CLI equivalents in live MCP session",
      passed: false,
    };
  });

  // Gate G11: Evidence provenance
  gate("G11", "Evidence provenance", () => {
    assert(searchNodeId, "Required upstream data missing: no node from G1.1");
    const result = runCli(["context", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    assert(result.exitCode === 0, `context failed: ${result.stderr}`);
    assert(result.json, "context did not return JSON");

    // Response-level provenance required (revision/trust checks)
    const trust = result.json.trust ?? result.json.revision;
    assert(trust, "Required upstream data missing: trust/revision object missing from response");
    assert(trust.schemaVersion !== undefined, "Required upstream data missing: trust.schemaVersion missing");
    assert(trust.repoId, "Required upstream data missing: trust.repoId missing");
    assert(trust.indexedCommit, "Required upstream data missing: trust.indexedCommit missing");

    // Collect all edge arrays
    const allEdges = [...(result.json.callers ?? []), ...(result.json.calls ?? []),
                      ...(result.json.renders ?? []), ...(result.json.renderedBy ?? []),
                      ...(result.json.firstHopRelations ?? [])];

    // Require at least one relation for edge-level provenance check
    assert(allEdges.length > 0, "Required upstream data missing: at least one relation required for edge-level provenance verification");

    // For at least one relation, verify complete provenance metadata
    const firstEdge = allEdges[0];

    // Edge type/kind (string indicating relation type)
    const hasEdgeType = !!(firstEdge.type || firstEdge.kind || firstEdge.edgeType);
    assert(hasEdgeType, "Required upstream data missing: edge type/kind missing (relation type)");

    // Evidence state/confidence (proven, candidate, inferred, not_proven)
    const hasConfidence = !!(firstEdge.confidence || firstEdge.state || firstEdge.evidence || firstEdge.proofStatus);
    assert(hasConfidence, "Required upstream data missing: evidence state/confidence missing (proven/candidate/inferred/not_proven)");

    // Source attribution (repository ID, file path, or location evidence)
    const hasSource = !!(firstEdge.repoId || firstEdge.filePath || firstEdge.location || firstEdge.sourceFile);
    assert(hasSource, "Required upstream data missing: source attribution missing (repository ID, file path, or location)");

    return {
      hasRevisionEvidence: true,
      schemaVersion: trust.schemaVersion,
      hasRepoId: !!trust.repoId,
      hasIndexedCommit: !!trust.indexedCommit,
      edgeCount: allEdges.length,
      edgeProvenance: {
        hasType: hasEdgeType,
        hasConfidence: hasConfidence,
        hasSource: hasSource,
      },
    };
  });

  // Gate G12: Deterministic target selection
  gate("G12", "Deterministic target selection", () => {
    const result = runCli(["search", "payment external service", "--repo", repo, "--json"]);
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, error: result.json?.error?.code };
    }
    const hits = result.json.hits ?? result.json.results;
    assert(hits, "hits missing");
    const symbolHits = hits.filter((r) => r.kind && r.kind !== "note" && r.kind !== "file");
    if (symbolHits.length === 0) {
      // Apply deterministic sort fallback
      const sorted = [...hits].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.identityKey && b.identityKey && a.identityKey !== b.identityKey) {
          return a.identityKey.localeCompare(b.identityKey);
        }
        return a.nodeId.localeCompare(b.nodeId);
      });
      if (sorted.length === 0) {
        return { deterministic: true, selectedNodeId: null, note: "zero hits after deterministic sort" };
      }
      return { deterministic: true, selectedNodeId: sorted[0].nodeId, fallbackUsed: true };
    }
    return { deterministic: true, selectedNodeId: symbolHits[0].nodeId, symbolHitCount: symbolHits.length };
  });

  const result = {
    header,
    passed: gates.every((g) => g.passed),
    gates,
    gatesSummary: {
      total: gates.length,
      passed: gates.filter((g) => g.passed).length,
      failed: gates.filter((g) => !g.passed).length,
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.passed && !gateMode ? 0 : (result.passed ? 0 : 1);
}
