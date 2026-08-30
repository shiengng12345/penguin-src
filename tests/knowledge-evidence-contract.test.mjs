import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  affectedByFiles,
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
