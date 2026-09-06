import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  buildEvidenceEnvelope,
  listCoverageDebt,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-coverage-items-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "FPMS-NT", rootPath: join(dir, "fpms-nt") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const source = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::caller`, title: "caller", repoId });
  store.db.prepare(`
    INSERT INTO coverage_records
      (repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(repoId, ".env.production", "tracked", "excluded", "secret_policy", "secret", 42, "secret path excluded by policy", new Date().toISOString());
  store.db.prepare(`
    INSERT INTO coverage_records
      (repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(repoId, "broken.ts", "tracked", "failed", "read_error", "unknown", 0, "read failed", new Date().toISOString());
  store.db.prepare(`
    INSERT INTO coverage_records
      (repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(repoId, "stale.ts", "tracked", "stale", "worktree_changed", "source", 12, "indexed content is stale", new Date().toISOString());
  for (const [filePath, line, rawTarget] of [
    ["src/a.ts", 10, "MissingBalance"],
    ["src/b.ts", 20, "MissingWithdrawal"],
    ["src/c.ts", 30, "MissingPlayer"],
  ]) {
    store.db.prepare(`
      INSERT INTO unresolved_reference_items
        (id,repo_id,branch_id,revision_id,file_path,start_line,source_node_id,raw_target,reason_code,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(`unresolved-${rawTarget}`, repoId, branchId, "branch:c1", filePath, line, source, rawTarget, "unresolved_reference", "no indexed target", new Date().toISOString());
  }
  for (const filePath of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    store.db.prepare(`
      INSERT INTO unresolved_reference_coverage
        (repo_id,branch_id,file_path,revision_id,resolved,total,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(repoId, branchId, filePath, "branch:c1", 0, 1, new Date().toISOString());
  }
  return { dir, store, repoId, branchId };
}

test("coverage debt lists excluded, failed, and stale files with reasons", () => {
  const { store, repoId } = fixture();
  const result = listCoverageDebt(store, { repo: "FPMS-NT" });
  assert.deepEqual(result.items.slice(0, 3).map((item) => item.filePath), [".env.production", "broken.ts", "stale.ts"]);
  assert.deepEqual(result.items.slice(0, 3).map((item) => item.kind), ["excluded", "failed", "stale"]);
  assert.equal(result.items.filter((item) => item.kind === "unresolved").length, 3);
  assert.equal(result.items[0].reasonCode, "secret_policy");
  assert.equal(result.coverage.excluded, 1);
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.coverage.stale, 1);
  assert.equal(result.coverage.reconciliation.status, "reconciled");
  assert.equal(result.coverage.reconciliation.delta, 0);
  assert.equal(result.scope.repoId, repoId);
  store.close();
});

test("unresolved debt is concrete, revision-scoped, and HMAC-paginated", () => {
  const { store, repoId, branchId } = fixture();
  const pageOne = listCoverageDebt(store, { repo: repoId, kind: "unresolved", limit: 2 });
  assert.equal(pageOne.items.length, 2);
  assert.equal(pageOne.candidateCount, 3);
  assert.equal(pageOne.totalIsExact, true);
  assert.ok(pageOne.nextCursor);
  assert.equal(pageOne.items[0].branchId, branchId);
  assert.equal(pageOne.items[0].snapshotId, "branch:c1");
  assert.equal(pageOne.coverage.reconciliation.revisionId, "branch:c1");
  const pageTwo = listCoverageDebt(store, { repo: repoId, kind: "unresolved", limit: 2, cursor: pageOne.nextCursor });
  assert.equal(pageTwo.items.length, 1);
  assert.notEqual(pageTwo.items[0].filePath, pageOne.items[0].filePath);
  assert.equal(pageTwo.nextCursor, null);
  assert.throws(() => listCoverageDebt(store, { repo: repoId, kind: "unresolved", limit: 2, cursor: pageOne.nextCursor, path: "other/" }), /CURSOR_SCOPE_MISMATCH/);
  store.close();
});

test("CLI and MCP coverage requests expose the same concrete work queue", async () => {
  const { dir, store, repoId } = fixture();
  store.close();
  const lines = [];
  const deps = {
    cwd: dir,
    out: (line) => lines.push(line),
    err: () => {},
    storeExists: () => true,
    openStore: () => KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }),
  };
  assert.equal(await runCli(["coverage", "--repo", "FPMS-NT", "--kind", "unresolved", "--limit", "2", "--json"], deps), 0);
  const cli = JSON.parse(lines.at(-1));
  assert.equal(cli.items.length, 2);
  assert.equal(cli.items[0].repoId, repoId);
  const mcp = handleKnowledgeTool("knowledge_coverage", { repo: "FPMS-NT", kind: "unresolved", limit: 2 }, deps.openStore());
  assert.deepEqual(mcp.items.map((item) => item.filePath), cli.items.map((item) => item.filePath));
  assert.equal(mcp.items[0].reasonCode, "unresolved_reference");
});

test("unknown coverage repository fails closed", () => {
  const { store } = fixture();
  assert.throws(() => listCoverageDebt(store, { repo: "missing" }), (error) => error.code === "REPOSITORY_NOT_FOUND");
  store.close();
});

test("coverage aggregate drift is explicit instead of silently accepted", () => {
  const { store, repoId } = fixture();
  store.db.prepare("DELETE FROM unresolved_reference_items WHERE id=?").run("unresolved-MissingPlayer");
  const result = listCoverageDebt(store, { repo: repoId, kind: "unresolved" });
  assert.equal(result.coverage.reconciliation.status, "mismatch");
  assert.equal(result.coverage.reconciliation.itemCount, 2);
  assert.equal(result.coverage.reconciliation.aggregateUnresolved, 3);
  assert.equal(result.coverage.reconciliation.delta, -1);
  assert.ok(result.gaps.includes("coverage_reconciliation_mismatch"));
  const evidence = buildEvidenceEnvelope(store, { repoId, branchId: result.items[0].branchId });
  assert.equal(evidence.coverage.unresolvedReferences, 2, "public evidence uses the concrete item queue as its authoritative count");
  store.close();
});

test("legacy aggregate without concrete items uses the current layer once and reports detail unavailable", () => {
  const { store, repoId, branchId } = fixture();
  store.db.prepare("DELETE FROM unresolved_reference_items WHERE repo_id=?").run(repoId);
  store.db.prepare("UPDATE unresolved_reference_coverage SET total=32556,resolved=0 WHERE repo_id=?").run(repoId);
  store.db.prepare("INSERT OR REPLACE INTO coverage_layers(repo_id,branch_id,layer,resolved,total,updated_at) VALUES (?,?,?,?,?,?)")
    .run(repoId, branchId, "references", 930, 1000, new Date().toISOString());

  const result = listCoverageDebt(store, { repo: repoId, kind: "unresolved" });
  const evidence = buildEvidenceEnvelope(store, { repoId, branchId });
  assert.equal(result.coverage.unresolvedReferences, 70);
  assert.equal(evidence.coverage.unresolvedReferences, 70);
  assert.equal(result.coverage.reconciliation.status, "unavailable");
  assert.equal(result.coverage.reconciliation.aggregateUnresolved, 70);
  assert.equal(result.coverage.reconciliation.itemCount, 0);
  assert.equal(result.coverage.reconciliation.delta, null);
  assert.ok(result.gaps.includes("unresolved_reference_coverage_unavailable"));
  store.close();
});

test("index pipeline persists the deduplicated unresolved count", () => {
  const source = readFileSync(new URL("../packages/knowledge-indexer/src/pipeline.ts", import.meta.url), "utf8");
  assert.match(source, /UPDATE coverage_records SET unresolved_references=\?, updated_at=\?/);
  assert.ok((source.match(/insertedUnresolvedIds\.size/g) ?? []).length >= 3, "all public coverage aggregates must use the deduplicated work queue");
  assert.doesNotMatch(source, /\.run\(resolved\.unresolvedItems\.length,/, "raw parser-lane duplicates must not inflate coverage");
  assert.doesNotMatch(source, /resolved\.edges\.length \+ resolved\.unresolvedItems\.length/, "reference aggregates must not persist raw parser-lane duplicates");
});

test("indexer persists unresolved references and removes them on the next file replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-coverage-indexer-"));
  const repoRoot = join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const filePath = join(repoRoot, "src.ts");
  writeFileSync(filePath, "export function caller() { return MissingBalance(); }\n");
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  await indexRepo({ store, rootPath: repoRoot, mode: "incremental" });
  // indexRepo stores the canonical Git worktree root (macOS may expose the
  // same directory as /var or /private/var). Exercise the public resolver
  // instead of coupling this regression test to one spelling of the path.
  const repoId = store.resolveRepoIds(repoRoot)[0];
  assert.ok(repoId);
  const unresolved = listCoverageDebt(store, { repo: repoId, kind: "unresolved" });
  assert.equal(unresolved.items.length, 1);
  assert.equal(unresolved.items[0].filePath, "src.ts");
  assert.equal(unresolved.items[0].rawTarget, "MissingBalance");
  assert.equal(unresolved.items[0].reasonCode, "no_candidate");
  assert.ok(unresolved.items[0].sourceNodeId);
  assert.equal(unresolved.coverage.reconciliation.status, "reconciled");
  assert.equal(unresolved.coverage.reconciliation.aggregateUnresolved, unresolved.candidateCount);

  store.db.prepare("UPDATE unresolved_reference_coverage SET total=total+5 WHERE repo_id=?").run(repoId);
  assert.equal(listCoverageDebt(store, { repo: repoId, kind: "unresolved" }).coverage.reconciliation.status, "mismatch");
  await indexRepo({ store, rootPath: repoRoot, mode: "incremental" });
  const repairedWithoutChanges = listCoverageDebt(store, { repo: repoId, kind: "unresolved" });
  assert.equal(repairedWithoutChanges.coverage.reconciliation.status, "reconciled", "a no-change incremental index repairs historical aggregate drift");
  assert.equal(repairedWithoutChanges.coverage.reconciliation.aggregateUnresolved, repairedWithoutChanges.candidateCount);

  writeFileSync(filePath, "export function caller() { return 1; }\n");
  await indexRepo({ store, rootPath: repoRoot, mode: "incremental" });
  const resolved = listCoverageDebt(store, { repo: repoId, kind: "unresolved" });
  assert.equal(resolved.items.length, 0);
  assert.equal(resolved.coverage.reconciliation.status, "reconciled");
  assert.equal(resolved.coverage.reconciliation.aggregateUnresolved, 0);
  store.close();
});
