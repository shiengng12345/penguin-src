import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, graphQuery } from "../packages/knowledge-core/dist/index.js";

test("typed graph query is bounded, directional and provenance-aware", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-graph-query-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: "r::a", title: "a", repoId: "r" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: "r::b", title: "b", repoId: "r" });
  const branch = store.registerBranch({ repoId: "r", name: "main", status: "live" });
  store.replaceFileEdges({ repoId: "r", branchId: branch, filePath: "a.ts", edges: [{ src: a, dst: b, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  const result = graphQuery(store, { start: { nodeIds: [a] }, traverse: [{ edgeTypes: ["calls"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["verified"] }], project: ["nodes", "edges", "paths", "provenance"], limit: 10 });
  assert.equal(result.edges.length, 1);
  assert.equal(result.paths[0].at(-1), b);
  assert.throws(() => graphQuery(store, { start: {}, traverse: [], project: ["nodes"], limit: 501 }), /GRAPH_QUERY_LIMIT_INVALID/);
  store.close();
});

test("graph DSL exposes compact source locators and only includes candidate edges when requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-graph-query-source-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "fixture", rootPath: dir });
  const branch = store.registerBranch({ repoId, name: "main", status: "live" });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::a`, title: "a", repoId });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::b`, title: "b", repoId });
  store.upsertSymbolVersion({ nodeId: a, branchId: branch, commitSha: "c0", filePath: "src/a.ts", lang: "ts", kind: "function", contentHash: "a" });
  store.upsertSymbolVersion({ nodeId: b, branchId: branch, commitSha: "c0", filePath: "vendor/b.ts", lang: "ts", kind: "function", contentHash: "b" });
  store.replaceFileEdges({ repoId, branchId: branch, filePath: "src/a.ts", edges: [{ src: a, dst: b, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.suggestEdge({ src: b, dst: a, edgeType: "calls" });

  const verified = graphQuery(store, { start: { nodeIds: [a] }, traverse: [{ edgeTypes: ["calls"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["verified"] }], where: { pathPrefixes: ["src/"] }, project: ["nodes", "source", "paths"], limit: 10 });
  assert.equal(verified.edges.length, 0, "path filter excludes the vendor target from node expansion");
  assert.ok(verified.source.some((item) => item.filePath === "src/a.ts" && item.hydration === "knowledge_get_hit"));

  const candidates = graphQuery(store, { start: { nodeIds: [b] }, traverse: [{ edgeTypes: ["calls"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["candidate"] }], project: ["edges"], limit: 10 });
  assert.equal(candidates.edges.length, 1);
  assert.equal(candidates.edges[0].status, "candidate");
  store.close();
});

test("inferred graph edges remain candidates and do not enter verified traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-graph-query-inferred-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "fixture", rootPath: dir });
  const branch = store.registerBranch({ repoId, name: "main", status: "live" });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::a`, title: "a", repoId });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::b`, title: "b", repoId });
  store.replaceFileEdges({ repoId, branchId: branch, filePath: "a.ts", edges: [{ src: a, dst: b, edgeType: "calls", origin: "parser", method: "INFERRED", confidence: 0.5 }] });
  const verified = graphQuery(store, { start: { nodeIds: [a] }, traverse: [{ edgeTypes: ["calls"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["verified"] }], project: ["edges"], limit: 10 });
  assert.equal(verified.edges.length, 0);
  const candidates = graphQuery(store, { start: { nodeIds: [a] }, traverse: [{ edgeTypes: ["calls"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["candidate"] }], project: ["edges"], limit: 10 });
  assert.equal(candidates.edges.length, 1);
  assert.equal(candidates.edges[0].status, "candidate");
  assert.equal(candidates.coverage.unresolved, 0);
  store.close();
});
