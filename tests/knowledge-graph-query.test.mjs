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

test("graphNeighborhood respects the node limit", () => {
  const { store, caller } = seed();
  const g = graphNeighborhood(store, caller, { depth: 5, limit: 2 });
  assert.equal(g.nodes.length, 2); // focus + 1 before cap
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

test("exploreGraph branch-scope: multi-branch repo does not mix branches (Phase 1)", () => {
  const { store, repoId, branchId, login, caller } = seed();
  // second branch of the SAME repo with a different caller of `login`.
  const featBranch = store.registerBranch({ repoId, name: "feature", status: "live" });
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
  assert.ok(noBranch.includes(caller) && noBranch.includes(featCaller), "no branch filter → both (legacy)");
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
