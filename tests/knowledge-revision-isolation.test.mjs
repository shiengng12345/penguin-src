import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeStore,
  resolveRevisionContext,
  exploreGraph,
  getNodeDetail,
  search,
  legacyRevisionScope,
} from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-revision-isolation-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "isolated", rootPath: join(dir, "repo") });
  const mainId = store.registerBranch({ repoId, name: "main", headCommit: "main-sha", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature", headCommit: "feature-sha", status: "snapshot" });
  const shared = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Shared`, repoId, title: "Shared" });
  const mainOnly = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::callerMain`, repoId, title: "callerMain" });
  const featureOnly = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::callerFeature`, repoId, title: "callerFeature" });
  const featureSearch = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::featureOnly`, repoId, title: "featureOnly" });
  for (const [nodeId, branchId, commitSha, filePath, signature] of [
    [shared, mainId, "main-sha", "src/shared.ts", "main Shared()"],
    [shared, featureId, "feature-sha", "src/shared.ts", "feature Shared()"],
    [mainOnly, mainId, "main-sha", "src/main.ts", "callerMain()"],
    [featureOnly, featureId, "feature-sha", "src/feature.ts", "callerFeature()"],
    [featureSearch, featureId, "feature-sha", "src/feature-only.ts", "featureOnly()"],
  ]) {
    store.upsertSymbolVersion({ nodeId, branchId, commitSha, filePath, lang: "typescript", kind: "function", signature, contentHash: `${branchId}:${nodeId}` });
    store.indexSymbolText({ nodeId, name: nodeId === featureSearch ? "featureOnly" : signature, signature });
  }
  store.db.prepare(
    `INSERT INTO edges (id, src, dst, edge_type, branch_id, origin, method, status)
     VALUES (?, ?, ?, 'calls', ?, 'parser', 'EXTRACTED', 'active')`,
  ).run("edge-main", mainOnly, shared, mainId);
  store.db.prepare(
    `INSERT INTO edges (id, src, dst, edge_type, branch_id, origin, method, status)
     VALUES (?, ?, ?, 'calls', ?, 'parser', 'EXTRACTED', 'active')`,
  ).run("edge-feature", featureOnly, shared, featureId);
  return {
    store,
    repoId,
    shared,
    main: resolveRevisionContext(store, { repoId, branch: "main" }).context,
    feature: resolveRevisionContext(store, { repoId, branch: "feature" }).context,
  };
}

test("revision scope keeps graph, node versions, and search isolated by branch", () => {
  const { store, shared, main, feature } = fixture();
  const mainGraph = exploreGraph(store, "who_calls", shared, { revision: main });
  const featureGraph = exploreGraph(store, "who_calls", shared, { revision: feature });
  assert.deepEqual(mainGraph.nodes.map((node) => node.title), ["callerMain"]);
  assert.deepEqual(featureGraph.nodes.map((node) => node.title), ["callerFeature"]);
  assert.equal(getNodeDetail(store, shared, { revision: main }).versions.length, 1);
  assert.equal(getNodeDetail(store, shared, { revision: feature }).versions[0].signature, "feature Shared()");
  assert.equal(search(store, "featureOnly", { revision: main }).length, 0);
  assert.equal(search(store, "featureOnly", { revision: feature }).length, 1);
  store.close();
});

test("legacy revision scope admits only branch edges plus explicitly global edges", () => {
  const { store, main } = fixture();
  const scope = legacyRevisionScope(main);
  assert.match(scope.edgeSql("e").sql, /e\.branch_id = \? OR e\.branch_id IS NULL/);
  assert.deepEqual(scope.edgeSql("e").params, [main.branchId]);
  assert.deepEqual(scope.symbolSql("sv").params, [main.branchId]);
  assert.deepEqual(scope.fileSql("f").params, [main.branchId]);
  store.close();
});
