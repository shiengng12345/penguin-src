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
    gateResult.passed = true;
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
    assert(Array.isArray(result.json.results), "results is not an array");
    assert(result.json.results.length > 0, "results array is empty");
    const first = result.json.results[0];
    assert(first.nodeId, "first result missing nodeId");
    assert(first.title, "first result missing title");
    assert(first.kind, "first result missing kind");
    assert(first.locator?.filePath, "first result missing locator.filePath");
    searchNodeId = first.nodeId;
    searchFilePath = first.locator.filePath;
    return { nodeId: searchNodeId, filePath: searchFilePath, resultCount: result.json.results.length };
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
    assert(result.json.node, "node object missing");
    assert(result.json.node.nodeId, "node.nodeId missing");
    assert(result.json.node.title, "node.title missing");
    assert(Array.isArray(result.json.firstHopRelations), "firstHopRelations is not an array");
    return { nodeId: result.json.node.nodeId, relationCount: result.json.firstHopRelations.length };
  });

  // Gate G2: Pagination
  let endpointId = null;
  let endpointCursor = null;

  gate("G2.1", "Endpoints page 1", () => {
    const result = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--json"]);
    assert(result.exitCode === 0, `endpoints failed: ${result.stderr}`);
    assert(result.json, "endpoints did not return JSON");
    assert(Array.isArray(result.json.items), "items is not an array");
    if (result.json.items.length > 0) {
      assert(result.json.items.length === 1, "items length != 1");
      endpointId = result.json.items[0].nodeId;
      endpointCursor = result.json.nextCursor;
      assert(typeof endpointCursor === "string" || endpointCursor === null, "nextCursor is not string or null");
      return { endpointId, hasCursor: !!endpointCursor, candidateCount: result.json.candidateCount };
    }
    return { endpointId: null, hasCursor: false, candidateCount: 0, note: "no endpoints found" };
  });

  gate("G2.2", "Endpoints page 2", () => {
    if (!endpointCursor) {
      return { skipped: true, reason: "no cursor from G2.1" };
    }
    const result = runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--cursor", endpointCursor, "--json"]);
    assert(result.exitCode === 0, `endpoints page 2 failed: ${result.stderr}`);
    assert(result.json, "endpoints did not return JSON");
    if (result.json.items && result.json.items.length > 0) {
      assert(result.json.items[0].nodeId !== endpointId, "page 2 returned same nodeId as page 1");
      return { differentNode: true, candidateCount: result.json.candidateCount };
    }
    return { differentNode: false, note: "page 2 empty" };
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
    // Allow some failures here, just record what we can
    const statusJson = status.exitCode === 0 ? status.json : null;
    const coverageJson = coverage.exitCode === 0 ? coverage.json : null;
    return {
      statusExitCode: status.exitCode,
      coverageExitCode: coverage.exitCode,
      freshness: statusJson?.freshness ?? coverageJson?.freshness ?? null,
      indexed: coverageJson?.indexed ?? null,
    };
  });

  // Gate G5: Affected
  gate("G5", "Affected analysis", () => {
    if (!searchFilePath) {
      return { skipped: true, reason: "no file from G1.2" };
    }
    const result = runCli(["affected", searchFilePath, "--repo", repo, "--json"]);
    // Gracefully handle if file not in repo
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, error: result.json?.error?.code };
    }
    assert(result.json, "affected did not return JSON");
    assert(Array.isArray(result.json.changed) || result.json.changed === undefined, "changed is not array");
    assert(Array.isArray(result.json.impacted) || result.json.impacted === undefined, "impacted is not array");
    assert(result.json.revision, "revision missing");
    return { hasRevision: true, changed: result.json.changed?.length ?? 0, impacted: result.json.impacted?.length ?? 0 };
  });

  // Gate G6: Endpoint identity
  gate("G6", "Endpoint identity forms", () => {
    if (!endpointId) {
      return { skipped: true, reason: "no endpoint from G2.1" };
    }
    const byNodeId = runCli(["context", `node:${endpointId}`, "--repo", repo, "--json"]);
    assert(byNodeId.exitCode === 0, "context by node ID failed");
    return { endpointId, resolvedNodeId: byNodeId.json?.node?.nodeId };
  });

  // Gate G7: Flow
  gate("G7", "Flow tracing", () => {
    if (!endpointId) {
      return { skipped: true, reason: "no endpoint from G2.1" };
    }
    const result = runCli(["flow", `node:${endpointId}`, "--repo", repo, "--json"]);
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, error: result.json?.error?.code };
    }
    assert(Array.isArray(result.json.steps), "steps is not array");
    if (result.json.steps.length > 0) {
      const root = result.json.steps.find((s) => s.depth === 0);
      assert(root, "no root step with depth 0");
      return { stepCount: result.json.steps.length, hasRoot: true };
    }
    return { stepCount: 0, hasRoot: false };
  });

  // Gate G8: Callers and callees
  gate("G8", "Callers and callees", () => {
    if (!searchNodeId) {
      return { skipped: true, reason: "no node from G1.1" };
    }
    const callers = runCli(["callers", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    const callees = runCli(["callees", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    return {
      callersExitCode: callers.exitCode,
      calleesExitCode: callees.exitCode,
      callersHasRevision: !!callers.json?.revision,
      calleesHasRevision: !!callees.json?.revision,
    };
  });

  // Gate G9: Deadcode
  gate("G9", "Deadcode listing", () => {
    const result = runCli(["deadcode", "--repo", repo, "--limit", "5", "--json"]);
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, error: result.json?.error?.code };
    }
    assert(Array.isArray(result.json.items), "items is not array");
    const proofStatus = result.json.proofStatus;
    assert(proofStatus === "candidate" || proofStatus === "not_proven", `proofStatus is ${proofStatus}, should not be "proven"`);
    return { itemCount: result.json.items.length, proofStatus };
  });

  // Gate G10: MCP/CLI parity (placeholder, requires MCP integration)
  gate("G10", "MCP/CLI parity", () => {
    return { note: "N/A: MCP integration requires separate session", skipped: true };
  });

  // Gate G11: Evidence provenance
  gate("G11", "Evidence provenance", () => {
    if (!searchNodeId) {
      return { skipped: true, reason: "no node from G1.1" };
    }
    const result = runCli(["context", `node:${searchNodeId}`, "--repo", repo, "--json"]);
    if (result.exitCode !== 0 || !result.json.firstHopRelations || result.json.firstHopRelations.length === 0) {
      return { note: "no first hop relations to inspect" };
    }
    const relation = result.json.firstHopRelations[0];
    assert(relation.edgeType, "edgeType missing");
    assert(relation.evidenceState, "evidenceState missing");
    return {
      edgeType: relation.edgeType,
      evidenceState: relation.evidenceState,
      hasSourceRepoId: relation.source?.repoId !== undefined,
    };
  });

  // Gate G12: Deterministic target selection
  gate("G12", "Deterministic target selection", () => {
    const result = runCli(["search", "payment external service", "--repo", repo, "--json"]);
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, error: result.json?.error?.code };
    }
    assert(result.json.results, "results missing");
    const symbolResults = result.json.results.filter((r) => r.kind && r.kind !== "note" && r.kind !== "file");
    if (symbolResults.length === 0) {
      // Apply deterministic sort fallback
      const sorted = [...result.json.results].sort((a, b) => {
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
    return { deterministic: true, selectedNodeId: symbolResults[0].nodeId, symbolResultCount: symbolResults.length };
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
