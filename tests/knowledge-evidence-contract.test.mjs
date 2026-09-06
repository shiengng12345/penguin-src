import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  affectedByFiles,
  affectedByNode,
  buildContextPack,
  buildFlow,
  exploreGraph,
  searchKnowledge,
} from "../packages/knowledge-core/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-evidence-contract-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "evidence", rootPath: join(dir, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live", headCommit: "c1" });
  const target = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::target`, repoId, title: "target" });
  store.upsertSymbolVersion({ nodeId: target, branchId, commitSha: "c1", filePath: "src/target.ts", lang: "ts", kind: "function", contentHash: "target", status: "fresh" });
  store.indexSymbolText({ nodeId: target, name: "target", signature: "()" });
  return { dir, store, repoId, branchId, target };
}

function assertEnvelope(value, label) {
  assert.ok(value && typeof value === "object", `${label} is an object`);
  const envelope = value.evidence ?? value;
  for (const key of ["coverage", "completeness", "proofStatus", "candidateCount", "returnedCount", "truncated", "cursor"]) {
    assert.ok(Object.hasOwn(envelope, key), `${label}.${key} is present`);
  }
  return envelope;
}

function assertListEnvelope(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not a bare array`);
  for (const key of ["items", "scope", "revision", "freshness", "coverage", "completeness", "proofStatus", "candidateCount", "returnedCount", "totalIsExact", "truncated", "nextCursor", "gaps"]) {
    assert.ok(Object.hasOwn(value, key), `${label}.${key} is present`);
  }
  assert.ok(Array.isArray(value.items), `${label}.items is an array`);
  assert.ok(Array.isArray(value.gaps), `${label}.gaps is an array`);
  return value;
}

async function cliJson(args, dbPath, ledgerPath, cwd) {
  const lines = [];
  const code = await runCli([...args, "--json"], {
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false }),
    storeExists: () => true,
    cwd,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  assert.equal(code, 0, lines.join("\n"));
  return JSON.parse(lines.at(-1));
}

test("missing target is an explicit not_proven evidence envelope", () => {
  const { store } = fixture();
  const result = buildContextPack(store, "missing-target");
  const envelope = assertEnvelope(result, "context");
  assert.equal(envelope.proofStatus, "not_proven");
  assert.equal(envelope.completeness, "unknown");
  store.close();
});

test("no callers is not proven absence and reports returned/candidate counts", () => {
  const { store, target } = fixture();
  const result = exploreGraph(store, "who_calls", `node:${target}`, { limit: 10 });
  const envelope = assertEnvelope(result, "callers");
  assert.equal(result.nodes.length, 0);
  assert.equal(envelope.proofStatus, "not_proven");
  assert.equal(envelope.returnedCount, 0);
  assert.equal(envelope.candidateCount, 0);
  store.close();
});

test("excluded coverage makes an empty search explicitly not proven", () => {
  const { store, repoId } = fixture();
  store.db.prepare(`INSERT INTO coverage_records
    (repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(repoId, "secret.env", "tracked", "excluded", "secret_policy", "secret", 10, "secret path excluded", new Date().toISOString());
  const result = searchKnowledge({ query: "secret.env", mode: "path", scope: { revisions: [{ repoId }] }, page: { limit: 10 } }, { store });
  const envelope = assertEnvelope(result, "search");
  assert.equal(result.diagnostics.queryStatus, "NO_MATCH_INCOMPLETE");
  assert.equal(envelope.proofStatus, "not_proven");
  assert.equal(envelope.coverage.excluded, 1);
  store.close();
});

test("unresolved references persist by repo, branch, file and indexing revision and read back", () => {
  const { store, repoId, branchId } = fixture();
  store.db.prepare(`INSERT INTO unresolved_reference_coverage
    (repo_id,branch_id,file_path,revision_id,resolved,total,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(repoId, branchId, "src/target.ts", "snapshot-c1", 2, 5, new Date().toISOString());
  const row = store.db.prepare(`SELECT repo_id AS repoId,branch_id AS branchId,file_path AS filePath,
    revision_id AS revisionId,resolved,total FROM unresolved_reference_coverage
    WHERE repo_id=? AND branch_id=? AND file_path=? AND revision_id=?`).get(repoId, branchId, "src/target.ts", "snapshot-c1");
  assert.deepEqual(row, { repoId, branchId, filePath: "src/target.ts", revisionId: "snapshot-c1", resolved: 2, total: 5 });
  store.close();
});

test("coverage envelope falls back to branch coverage layers when per-file rows are absent", () => {
  const { store, repoId, branchId, target } = fixture();
  store.db.prepare(`INSERT INTO coverage_layers
    (repo_id,branch_id,layer,resolved,total,updated_at)
    VALUES (?,?,?,?,?,?)`).run(repoId, branchId, "references", 7, 10, new Date().toISOString());
  const result = buildContextPack(store, `node:${target}`, { repoId, branchId });
  const envelope = assertEnvelope(result, "context coverage fallback");
  assert.equal(envelope.coverage.unresolvedReferences, 3);
  store.close();
});

test("unresolved reference coverage is null when neither ledger rows nor layer evidence exists", () => {
  const { store, repoId, branchId, target } = fixture();
  const result = buildContextPack(store, `node:${target}`, { repoId, branchId });
  const envelope = assertEnvelope(result, "context unresolved coverage");
  assert.equal(envelope.coverage.unresolvedReferences, null);
  assert.ok(envelope.gaps.includes("unresolved_reference_coverage_unavailable"));
  store.close();
});

test("relation presence does not claim proof for a lower-bound context pack or graph", () => {
  const { store, repoId, branchId, target } = fixture();
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::caller`, repoId, title: "caller" });
  store.upsertSymbolVersion({ nodeId: caller, branchId, commitSha: "c1", filePath: "src/caller.ts", lang: "ts", kind: "function", contentHash: "caller", status: "fresh" });
  store.indexSymbolText({ nodeId: caller, name: "caller", signature: "()" });
  store.db.prepare(`INSERT INTO edges (id,src,dst,edge_type,branch_id,origin,method,status)
    VALUES (?,?,?,?,?,?,?,?)`).run("e-caller-target", caller, target, "calls", branchId, "parser", "EXTRACTED", "active");

  const context = buildContextPack(store, `node:${target}`, { repoId, branchId });
  assert.equal(assertEnvelope(context, "context with relation").proofStatus, "not_proven");
  const graph = exploreGraph(store, "who_calls", `node:${target}`, { repoId, branchId, limit: 10 });
  assert.equal(assertEnvelope(graph, "graph with relation").proofStatus, "not_proven");
  const affected = affectedByNode(store, `node:${target}`, { repoId });
  assert.ok(affected);
  assert.equal(assertEnvelope(affected, "node affected").proofStatus, "candidate");
  store.close();
});

test("partial flow and MCP response preserve the evidence envelope", async () => {
  const { store, target } = fixture();
  const flow = buildFlow(store, `node:${target}`, { limit: 10 });
  const flowEnvelope = assertEnvelope(flow, "flow");
  assert.equal(flowEnvelope.proofStatus, "not_proven");
  assert.equal(flowEnvelope.completeness, "partial");
  const mcp = handleKnowledgeTool("knowledge_context", { target: `node:${target}` }, store);
  const mcpEnvelope = assertEnvelope(mcp, "mcp context");
  assert.equal(mcpEnvelope.proofStatus, "not_proven");
  const lines = [];
  const code = await runCli(["search", "missing-evidence-term"], {
    openStore: () => store,
    storeExists: () => true,
    cwd: join(store.db.prepare("SELECT root_path AS rootPath FROM repos LIMIT 1").get().rootPath),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /not proven/i);
  store.close();
});

test("affected file result also carries the shared evidence fields", () => {
  const { store } = fixture();
  const result = affectedByFiles(store, ["src/target.ts"]);
  assertEnvelope(result, "affected");
  assert.equal(result.returnedCount, result.changed.length + result.impacted.length);
  store.close();
});

test("CLI and MCP read-only lists share one honest envelope", async () => {
  const { store, repoId, branchId, dir } = fixture();
  store.createSnapshot({ name: "fixture-snapshot", nodeIds: [] });
  const dbPath = store.db.name;
  const ledgerPath = join(dir, "ledger.jsonl");
  store.close();

  for (const [cliArgs, mcpName, mcpArgs] of [
    [["tags"], "knowledge_tag_list", {}],
    [["snapshot", "list"], "knowledge_snapshot_list", {}],
    [["coverage", "--repo", repoId], "knowledge_coverage", { repo: repoId }],
  ]) {
    const mcpStore = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
    const mcp = assertListEnvelope(handleKnowledgeTool(mcpName, mcpArgs, mcpStore), `MCP ${mcpName}`);
    mcpStore.close();
    const cli = assertListEnvelope(await cliJson(cliArgs, dbPath, ledgerPath, dir), `CLI ${cliArgs[0]}`);
    assert.deepEqual(mcp.items, cli.items, `${mcpName} items parity`);
    for (const key of ["freshness", "coverage", "completeness", "proofStatus", "candidateCount", "returnedCount", "totalIsExact", "truncated", "nextCursor", "gaps"]) {
      assert.deepEqual(mcp[key], cli[key], `${mcpName}.${key} parity`);
    }
    assert.equal(cli.coverage.unresolvedReferences, null);
    assert.ok(cli.gaps.includes("unresolved_reference_coverage_unavailable"));
  }

  const coverage = await cliJson(["coverage", "--repo", repoId], dbPath, ledgerPath, dir);
  assert.equal(coverage.coverage.status, "unknown");
  assert.equal(coverage.coverage.admitted, null);
  assert.equal(coverage.proofStatus, "not_proven");
  assert.ok(coverage.gaps.includes("coverage_records_empty"));
  assert.equal(coverage.revision?.branchId, branchId);
});

test("endpoints, filesymbols and deadcode expose the same list evidence fields", async () => {
  const { store, repoId, dir } = fixture();
  const dbPath = store.db.name;
  const ledgerPath = join(dir, "ledger.jsonl");
  store.close();
  for (const [cliArgs, mcpName, mcpArgs] of [
    [["endpoints", "--repo", repoId], "knowledge_endpoints", { repo: repoId }],
    [["filesymbols", repoId, "main", "src/target.ts"], "knowledge_file_symbols", { repo: repoId, branch: "main", file_path: "src/target.ts" }],
    [["deadcode", "--repo", repoId], "knowledge_dead_code", { repo: repoId }],
  ]) {
    const mcpStore = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
    const mcp = assertListEnvelope(handleKnowledgeTool(mcpName, mcpArgs, mcpStore), `MCP ${mcpName}`);
    mcpStore.close();
    const cli = assertListEnvelope(await cliJson(cliArgs, dbPath, ledgerPath, dir), `CLI ${cliArgs[0]}`);
    assert.equal(mcp.returnedCount, mcp.items.length);
    assert.equal(cli.returnedCount, cli.items.length);
    for (const key of ["freshness", "coverage", "completeness", "proofStatus", "totalIsExact", "truncated", "gaps"]) {
      assert.deepEqual(mcp[key], cli[key], `${mcpName}.${key} parity`);
    }
  }
});
