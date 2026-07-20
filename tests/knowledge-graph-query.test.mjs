import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  listIndexedFiles,
  listFileSymbols,
  graphNeighborhood,
  repoGraph,
  exploreGraph,
  branchFreshness,
  buildContextPack,
  buildFlow,
  indexStatus,
  graphQuery,
} from "../packages/knowledge-core/dist/index.js";

// Seed a small but realistic graph:
//   repo "auth" / branch "main"
//   files: a.ts (indexed, 2 symbols), b.ts (indexed, 1 symbol), skip.json (skipped)
//   symbols: caller, login (a.ts); helper (b.ts)
//   calls: caller → login, caller → helper, login → helper
function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-gq-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "auth", rootPath: "/auth" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });

  const mk = (name, file) => {
    const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${name}`, title: name, repoId });
    store.upsertSymbolVersion({
      nodeId: id, branchId, commitSha: "c0", filePath: file, lang: "ts", kind: "function",
      contentHash: `h_${name}`, status: "fresh",
    });
    store.indexSymbolText({ nodeId: id, name, signature: null });
    return id;
  };
  const caller = mk("caller", "a.ts");
  const login = mk("login", "a.ts");
  const helper = mk("helper", "b.ts");

  store.upsertFileCheckpoint({ repoId, branchId, filePath: "a.ts", lang: "ts", status: "indexed" });
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "b.ts", lang: "ts", status: "indexed" });
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "skip.json", lang: null, status: "skipped" });

  store.replaceFileEdges({ branchId, filePath: "a.ts", edges: [
    { src: caller, dst: login, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    { src: caller, dst: helper, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    { src: login, dst: helper, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  return { store, repoId, branchId, caller, login, helper };
}

test("listIndexedFiles returns repo/branch files ordered, with status", () => {
  const { store, repoId, branchId } = seed();
  const files = listIndexedFiles(store, repoId, branchId);
  assert.deepEqual(files.map((f) => f.filePath), ["a.ts", "b.ts", "skip.json"]);
  assert.equal(files.find((f) => f.filePath === "skip.json").status, "skipped");
  assert.equal(files.find((f) => f.filePath === "a.ts").lang, "ts");
  store.close();
});

test("listFileSymbols returns the symbols defined in a file", () => {
  const { store, branchId } = seed();
  const aSyms = listFileSymbols(store, branchId, "a.ts").map((s) => s.title);
  assert.deepEqual(aSyms, ["caller", "login"]);
  const bSyms = listFileSymbols(store, branchId, "b.ts").map((s) => s.title);
  assert.deepEqual(bSyms, ["helper"]);
  assert.equal(listFileSymbols(store, branchId, "nope.ts").length, 0);
  store.close();
});

test("graphNeighborhood: focus + 1-hop neighbours (both directions) + internal edges", () => {
  const { store, caller, login, helper } = seed();
  // login: called by caller (in), calls helper (out) → neighbours {caller, helper}
  const g = graphNeighborhood(store, login, { depth: 1 });
  assert.equal(g.focus, login);
  const ids = g.nodes.map((n) => n.nodeId).sort();
  assert.deepEqual(ids, [caller, helper, login].sort());
  // edges among the 3 included nodes: all 3 calls edges qualify
  assert.equal(g.edges.length, 3);
  assert.ok(g.edges.every((e) => e.edgeType === "calls"));
  store.close();
});

test("graph query renders dispatches_to as an explicit dispatch hop", () => {
  const { store, caller, login, branchId } = seed();
  store.replaceFileEdges({ branchId, filePath: "a.ts", edges: [{ src: caller, dst: login, edgeType: "dispatches_to", origin: "parser", method: "EXTRACTED", provenance: { evidence: "type_resolution" } }] });
  const result = graphQuery(store, { start: { nodeIds: [caller] }, traverse: [{ edgeTypes: ["dispatches_to"], direction: "out", minDepth: 1, maxDepth: 1, statuses: ["verified"] }], project: ["nodes", "edges", "paths", "provenance"], limit: 10 });
  assert.equal(result.edges[0].edge_type, "dispatches_to");
  assert.equal(result.edges[0].dispatchHop, true);
  assert.equal(result.provenance[0].hopType, "dispatch");
  store.close();
});

test("graphNeighborhood respects the node limit", () => {
  const { store, caller } = seed();
  const g = graphNeighborhood(store, caller, { depth: 5, limit: 2 });
  assert.equal(g.nodes.length, 2); // focus + 1 before cap
  store.close();
});

test("graphNeighborhood clamps local traversal to depth 1-3", () => {
  const { store, caller } = seed();
  const g = graphNeighborhood(store, caller, { depth: 99, limit: 10 });
  assert.equal(g.nodes.length, 3);
  store.close();
});

test("graphNeighborhood resolves a friendly name and returns empty for unknown", () => {
  const { store, login } = seed();
  assert.equal(graphNeighborhood(store, "login").focus, login);
  assert.deepEqual(graphNeighborhood(store, "does-not-exist"), { focus: null, nodes: [], edges: [] });
  store.close();
});

test("repoGraph returns top nodes by degree + edges among them", () => {
  const { store, repoId, branchId, caller, login, helper } = seed();
  const g = repoGraph(store, repoId, branchId, { limit: 10 });
  assert.equal(g.focus, null);
  const ids = g.nodes.map((n) => n.nodeId).sort();
  assert.deepEqual(ids, [caller, login, helper].sort());
  assert.equal(g.edges.length, 3);
  store.close();
});

test("repoGraph limit keeps the highest-degree hubs", () => {
  const { store, repoId, branchId, caller } = seed();
  // caller has degree 2 (out to login+helper); login degree 2; helper degree 2.
  // With limit 1 we get one hub; edges among a single node = 0.
  const g = repoGraph(store, repoId, branchId, { limit: 1 });
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 0);
  store.close();
});

test("repoGraph excludes generic utility hubs from the ranked view", () => {
  const { store, repoId, branchId, caller, login, helper } = seed();
  const utility = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::Repository.findOne`,
    title: "findOne",
    repoId,
  });
  store.replaceFileEdges({ branchId, filePath: "utility.ts", edges: [caller, login, helper].map((dst) => ({
    src: utility, dst, edgeType: "calls", origin: "parser", method: "INFERRED", confidence: 0.2,
  })) });

  const g = repoGraph(store, repoId, branchId, { limit: 3 });
  assert.ok(!g.nodes.some((node) => node.nodeId === utility), "generic utility must not consume a repoGraph slot");
  assert.deepEqual(g.nodes.map((node) => node.nodeId).sort(), [caller, login, helper].sort());
  store.close();
});

test("repoGraph: a node whose edges all lose the edge cap still shows its in-set edges", () => {
  const { store, repoId, branchId, caller } = seed();
  // A file node whose ONLY edge is a low-priority `imports` to an in-set node.
  const f = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::f.ts`, title: "f.ts", repoId });
  store.replaceFileEdges({ branchId, filePath: "f.ts", edges: [
    { src: f, dst: caller, edgeType: "imports", origin: "parser", method: "EXTRACTED" },
  ] });
  // edgeLimit 3: the three `calls` edges outrank the single `imports` edge and
  // fill the cap. Without backfill the file node renders as a false isolate —
  // shown in the view but with zero of its real in-set edges.
  const g = repoGraph(store, repoId, branchId, { limit: 10, edgeLimit: 3 });
  assert.ok(g.nodes.some((n) => n.nodeId === f), "file node is in the view");
  assert.ok(
    g.edges.some((e) => e.src === f || e.dst === f),
    "file node keeps at least one of its in-set edges",
  );
  store.close();
});

test("exploreGraph branch-scope: default uses the live branch and never mixes snapshots", () => {
  const { store, repoId, branchId, login, caller } = seed();
  // second branch of the SAME repo with a different caller of `login`.
  const featBranch = store.registerBranch({ repoId, name: "feature", status: "snapshot" });
  const featCaller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::featCaller`, title: "featCaller", repoId });
  store.upsertSymbolVersion({ nodeId: featCaller, branchId: featBranch, commitSha: "c1", filePath: "f.ts", lang: "ts", kind: "function", contentHash: "h_f", status: "fresh" });
  store.replaceFileEdges({ branchId: featBranch, filePath: "f.ts", edges: [
    { src: featCaller, dst: login, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });

  const onMain = exploreGraph(store, "who_calls", login, { branchId }).nodes.map((n) => n.nodeId);
  const onFeat = exploreGraph(store, "who_calls", login, { branchId: featBranch }).nodes.map((n) => n.nodeId);
  const noBranch = exploreGraph(store, "who_calls", login, {}).nodes.map((n) => n.nodeId);

  assert.ok(onMain.includes(caller) && !onMain.includes(featCaller), "main branch → only main's caller");
  assert.ok(onFeat.includes(featCaller) && !onFeat.includes(caller), "feature branch → only feature's caller");
  assert.ok(noBranch.includes(caller) && !noBranch.includes(featCaller), "default → only live branch");
  store.close();
});

test("context, flow, and index status expose one persisted trust envelope", () => {
  const { store, branchId, login } = seed();
  store.recordBranchIndexed({
    branchId,
    commit: null,
    worktreeState: "dirty",
    worktreeFingerprint: "fingerprint-1",
    dirtyFiles: ["a.ts"],
    parserVersion: "parser-1",
    schemaVersion: 6,
    staleReason: "worktree_dirty",
  });

  const context = buildContextPack(store, login);
  const flow = buildFlow(store, login);
  const status = indexStatus(store);
  assert.equal(context.trust.branchId, branchId);
  assert.equal(flow.trust.branchId, branchId);
  assert.equal(context.trust.worktreeState, "dirty");
  assert.deepEqual(context.trust.dirtyFiles, ["a.ts"]);
  assert.equal(context.trust.staleReason, "worktree_dirty");
  assert.deepEqual(flow.trust, context.trust);
  assert.equal(status.repos[0].branches[0].trust.worktreeFingerprint, "fingerprint-1");
  store.close();
});

test("branchFreshness: fresh when HEAD matches indexed, stale when it advanced (Phase 1)", () => {
  const { store, branchId } = seed();
  store.recordBranchIndexed({ branchId, commit: "c0" });
  const fresh = branchFreshness(store, branchId, "c0");
  assert.equal(fresh.stale, false);
  const stale = branchFreshness(store, branchId, "c9newhead");
  assert.equal(stale.stale, true);
  assert.match(stale.reason, /branch advanced/);
  store.close();
});

test("repoGraph on unknown repo is empty", () => {
  const { store, branchId } = seed();
  assert.deepEqual(repoGraph(store, "repo_nope", branchId), { focus: null, nodes: [], edges: [] });
  store.close();
});

test("who_injects: NestJS constructor-parameter DI dependencies are discoverable, resolved to the CLASS not the constructor method", () => {
  // Real gap reported from actual MCP usage: `who_calls CpmsRedisService` came
  // back empty because it's DI-injected, never directly "called". The
  // underlying data already existed — a constructor parameter's type
  // annotation was already extracted as a `references` edge from
  // `<Class>.constructor` to the injected class — `who_calls` just never
  // looked at that edge type. who_injects does, and resolves the constructor
  // symbol back to its enclosing class so the result reads "AppleLoginProcessor
  // depends on CpmsRedisService", not "...constructor depends on...".
  const dir = mkdtempSync(join(tmpdir(), "pk-di-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "auth", rootPath: "/auth" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });

  const cpmsRedis = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::CpmsRedisService`, title: "CpmsRedisService", repoId });
  const processorClass = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::AppleLoginProcessor`, title: "AppleLoginProcessor", repoId });
  const processorCtor = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::AppleLoginProcessor.constructor`, title: "constructor", repoId });
  // A plain (non-DI) type reference elsewhere must NOT be mistaken for injection.
  const randomFn = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::randomFn`, title: "randomFn", repoId });

  for (const [id, name] of [[cpmsRedis, "CpmsRedisService"], [processorClass, "AppleLoginProcessor"], [processorCtor, "constructor"], [randomFn, "randomFn"]]) {
    store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: "x.ts", lang: "ts", kind: "class", contentHash: `h_${name}`, status: "fresh" });
  }
  store.replaceFileEdges({ branchId, filePath: "x.ts", edges: [
    { src: processorCtor, dst: cpmsRedis, edgeType: "references", origin: "parser", method: "EXTRACTED" },
    { src: randomFn, dst: cpmsRedis, edgeType: "references", origin: "parser", method: "EXTRACTED" },
  ] });

  const nodes = exploreGraph(store, "who_injects", cpmsRedis, {}).nodes;
  assert.equal(nodes.length, 1, "only the constructor-shaped reference counts as injection, not the stray one from randomFn");
  assert.equal(nodes[0].nodeId, processorClass, "resolved to the CLASS, not AppleLoginProcessor.constructor");
  assert.equal(nodes[0].title, "AppleLoginProcessor");
  store.close();
});
