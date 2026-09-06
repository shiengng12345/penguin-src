import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, affectedByFiles, affectedByNode, exploreGraph, graphQuery } from "../packages/knowledge-core/dist/index.js";
import { extractNestJsFrameworkEdges } from "../packages/knowledge-indexer/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const fixtureSymbols = [
  { qualifiedName: "src/a-handler.ts::BalanceCheckPort", name: "BalanceCheckPort", kind: "interface", startLine: 2, endLine: 4 },
  { qualifiedName: "src/a-handler.ts::BalanceCheckHandler", name: "BalanceCheckHandler", kind: "class", startLine: 6, endLine: 10 },
  { qualifiedName: "src/b-service.ts::WithdrawalCheckService", name: "WithdrawalCheckService", kind: "class", startLine: 3, endLine: 7 },
  { qualifiedName: "src/c-module.ts::WithdrawalModule", name: "WithdrawalModule", kind: "class", startLine: 8, endLine: 10 },
];

const fixtureSource = `import { Injectable } from "@nestjs/common";
export interface BalanceCheckPort { check(): boolean; }

@Injectable()
export class BalanceCheckHandler implements BalanceCheckPort {
  check() { return true; }
}
`;

test("NestJS framework adapter extracts DI, implementation, provider, and dispatch evidence", () => {
  const ids = new Map(fixtureSymbols.map((symbol, index) => [symbol.qualifiedName, `node-${index}`]));
  const result = extractNestJsFrameworkEdges({
    filePath: "src/a-handler.ts",
    source: fixtureSource,
    symbols: fixtureSymbols,
    symbolIds: ids,
    resolveSymbol(name) {
      const symbol = fixtureSymbols.find((item) => item.name === name);
      return symbol ? { nodeId: ids.get(symbol.qualifiedName), filePath: "src/a-handler.ts" } : null;
    },
  });
  assert.ok(result.some((edge) => edge.edgeType === "implements" && edge.method === "INTERFACE_IMPLEMENTATION"));
  assert.ok(result.every((edge) => edge.provenance.frameworkAdapter === "nestjs"));
  assert.ok(result.every((edge) => edge.provenance.filePath === "src/a-handler.ts"));
});

function writeNestFixture(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a-handler.ts"), `import { Injectable } from "@nestjs/common";
export interface BalanceCheckPort { check(): boolean; }

@Injectable()
export class BalanceCheckHandler implements BalanceCheckPort {
  check() { return true; }
}
`);
  writeFileSync(join(root, "src", "b-service.ts"), `import { Injectable } from "@nestjs/common";
import { BalanceCheckHandler } from "./a-handler";

@Injectable()
export class WithdrawalCheckService {
  constructor(private readonly balanceCheckHandler: BalanceCheckHandler) {}
  validate() { return this.balanceCheckHandler.check(); }
}
`);
  writeFileSync(join(root, "src", "c-module.ts"), `import { Module } from "@nestjs/common";
import { BalanceCheckHandler } from "./a-handler";
import { BalanceCheckPort } from "./a-handler";
import { WithdrawalCheckService } from "./b-service";

@Module({
  providers: [
    BalanceCheckHandler,
    WithdrawalCheckService,
    { provide: BalanceCheckPort, useClass: BalanceCheckHandler },
  ],
})
export class WithdrawalModule {}
`);
}

test("indexRepo persists NestJS dispatch edges and affected traverses handler to service/module", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-nestjs-affected-"));
  const dbDir = mkdtempSync(join(tmpdir(), "pk-nestjs-db-"));
  writeNestFixture(root);
  const store = KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "rebuild" });
    const handler = store.db.prepare("SELECT n.id FROM nodes n WHERE n.title='BalanceCheckHandler' AND n.node_type='symbol' LIMIT 1").get();
    assert.ok(handler, `handler node missing after index: ${JSON.stringify(report)}`);
    const edgeRows = store.db.prepare(`SELECT e.edge_type AS edgeType, e.method, e.provenance, ns.title AS srcTitle, nd.title AS dstTitle
      FROM edges e JOIN nodes ns ON ns.id=e.src LEFT JOIN nodes nd ON nd.id=e.dst
      WHERE e.edge_type IN ('injects','provides','implements','dispatches_to')
      ORDER BY e.edge_type, ns.title, nd.title`).all();
    assert.ok(edgeRows.some((row) => row.edgeType === "injects" && row.srcTitle === "WithdrawalCheckService" && row.dstTitle === "BalanceCheckHandler"), JSON.stringify(edgeRows));
    assert.ok(edgeRows.some((row) => row.edgeType === "provides" && row.srcTitle === "WithdrawalModule"), JSON.stringify(edgeRows));
    assert.ok(edgeRows.some((row) => row.edgeType === "implements" && row.srcTitle === "BalanceCheckHandler" && row.dstTitle === "BalanceCheckPort"), JSON.stringify(edgeRows));
    assert.ok(edgeRows.some((row) => row.edgeType === "dispatches_to" && row.dstTitle === "BalanceCheckHandler"), JSON.stringify(edgeRows));

    const graph = graphQuery(store, {
      start: { nodeIds: [handler.id] },
      // Framework DI registration is source-grounded but still an inferred
      // runtime boundary, so the public graph contract exposes it as a
      // candidate rather than pretending static analysis observed execution.
      traverse: [{ edgeTypes: ["injects"], direction: "in", minDepth: 1, maxDepth: 1, statuses: ["candidate"] }],
      project: ["nodes", "edges", "provenance"],
      limit: 20,
    });
    assert.ok(graph.nodes.some((node) => node.title === "WithdrawalCheckService"), JSON.stringify(graph));
    assert.equal(graph.edges[0].frameworkBoundary, true, JSON.stringify(graph));
    assert.equal(graph.provenance[0].frameworkEdgeType, "injects", JSON.stringify(graph));

    const callers = exploreGraph(store, "who_calls", handler.id, { branchId: report.branchId, repoId: report.repoId });
    assert.ok(callers.nodes.some((node) => node.title === "WithdrawalCheckService"), JSON.stringify(callers));
    const service = store.db.prepare("SELECT n.id FROM nodes n WHERE n.title='WithdrawalCheckService' AND n.node_type='symbol' LIMIT 1").get();
    const callees = exploreGraph(store, "calls_of", service.id, { branchId: report.branchId, repoId: report.repoId });
    assert.ok(callees.nodes.some((node) => node.title === "BalanceCheckHandler"), JSON.stringify(callees));

    const nodeAffected = affectedByNode(store, `node:${handler.id}`, { repoId: report.repoId, revision: { repoId: report.repoId, branchId: report.branchId, snapshotId: `legacy:${report.branchId}`, commitSha: "(worktree)", trust: "fallback_live" } });
    assert.ok(nodeAffected?.impacted.some((item) => item.title === "WithdrawalCheckService"), JSON.stringify(nodeAffected));
    assert.ok(nodeAffected?.impacted.some((item) => item.title === "WithdrawalModule"), JSON.stringify(nodeAffected));
    assert.ok(nodeAffected?.impactEdges?.some((edge) => edge.edgeType === "injects" && edge.method === "DI_MODULE_PROVIDER"));

    const fileAffected = affectedByFiles(store, ["src/a-handler.ts"], { branchId: report.branchId });
    assert.ok(fileAffected.impacted.some((item) => item.title === "WithdrawalCheckService"), JSON.stringify(fileAffected));
    assert.ok(fileAffected.impacted.some((item) => item.title === "WithdrawalModule"), JSON.stringify(fileAffected));

    writeFileSync(join(root, "src", "c-module.ts"), `import { Module } from "@nestjs/common";
export class WithdrawalModule {}
`);
    await indexRepo({ store, rootPath: root, mode: "rebuild" });
    const staleProviderCount = store.db.prepare("SELECT COUNT(*) AS count FROM edges WHERE edge_type IN ('provides','dispatches_to') AND json_extract(provenance, '$.file')='src/c-module.ts'").get().count;
    assert.equal(staleProviderCount, 0, "re-index must remove old module provider/dispatch edges");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
