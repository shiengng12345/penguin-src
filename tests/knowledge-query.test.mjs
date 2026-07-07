import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  search,
  getNodeDetail,
  exploreGraph,
  compareBranches,
  indexStatus,
} from "../packages/knowledge-core/dist/index.js";

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-query-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const main = store.registerBranch({ repoId, name: "main", status: "live" });
  const feat = store.registerBranch({ repoId, name: "feature", status: "live" });

  const login = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::login`, title: "login", repoId });
  const helper = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::helper`, title: "helper", repoId });
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::caller`, title: "caller", repoId });
  for (const [id, hashMain] of [[login, "L1"], [helper, "H1"], [caller, "C1"]]) {
    store.upsertSymbolVersion({ nodeId: id, branchId: main, commitSha: "c0", filePath: "a.ts", lang: "ts", kind: "function", contentHash: hashMain });
  }
  // feature: login changed, helper same
  store.upsertSymbolVersion({ nodeId: login, branchId: feat, commitSha: "c1", filePath: "a.ts", lang: "ts", kind: "function", contentHash: "L2" });
  store.upsertSymbolVersion({ nodeId: helper, branchId: feat, commitSha: "c1", filePath: "a.ts", lang: "ts", kind: "function", contentHash: "H1" });

  store.indexSymbolText({ nodeId: login, name: "login", signature: "(req)" });
  // edges: caller → login → helper (calls)
  store.replaceFileEdges({ branchId: main, filePath: "a.ts", edges: [
    { src: caller, dst: login, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    { src: login, dst: helper, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  return { store, repoId, main, feat, login, helper, caller };
}

test("search finds a symbol by FTS", () => {
  const { store, login } = seed();
  assert.ok(search(store, "login").some((h) => h.nodeId === login));
  store.close();
});

test("getNodeDetail returns node + versions + aliases", () => {
  const { store, login } = seed();
  const d = getNodeDetail(store, login);
  assert.equal(d.node.title, "login");
  assert.ok(d.versions.length >= 2); // main + feature
  store.close();
});

test("exploreGraph who_calls / calls_of / backlinks / impact / path", () => {
  const { store, login, helper, caller } = seed();
  assert.deepEqual(exploreGraph(store, "who_calls", login).nodes.map((n) => n.nodeId), [caller]);
  assert.deepEqual(exploreGraph(store, "calls_of", login).nodes.map((n) => n.nodeId), [helper]);
  assert.ok(exploreGraph(store, "backlinks", helper).nodes.some((n) => n.nodeId === login));
  // impact of helper = transitive who_calls → login, caller
  const impact = exploreGraph(store, "impact", helper).nodes.map((n) => n.nodeId).sort();
  assert.deepEqual(impact, [caller, login].sort());
  // path caller → helper
  const path = exploreGraph(store, "path", caller, { to: helper }).nodes.map((n) => n.nodeId);
  assert.deepEqual(path, [caller, login, helper]);
  store.close();
});

test("compareBranches: differing hash not identical, same hash identical", () => {
  const { store, login, helper, main, feat } = seed();
  assert.equal(compareBranches(store, login, main, feat).identical, false); // L1 vs L2
  assert.equal(compareBranches(store, helper, main, feat).identical, true); // H1 vs H1
  store.close();
});

test("indexStatus lists repos, branches, staleness", () => {
  const { store, repoId, main } = seed();
  store.markFileSymbolsStale({ branchId: main, filePath: "a.ts" });
  const st = indexStatus(store);
  const repo = st.repos.find((r) => r.repoId === repoId);
  assert.equal(repo.name, "fpms");
  assert.ok(repo.branches.some((b) => b.name === "main" && b.staleSymbols >= 1));
  store.close();
});
