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
  buildExplorePack,
  compareBranches,
  compactIndexStatus,
  indexStatus,
  resolveSymbolMatches,
} from "../packages/knowledge-core/dist/index.js";

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-query-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const main = store.registerBranch({ repoId, name: "main", status: "live" });
  const feat = store.registerBranch({ repoId, name: "feature", status: "snapshot" });

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

test("bare symbol lookup uses the repo/type/title index instead of suffix LIKE scans", () => {
  const { store, repoId } = seed();
  const indexes = store.db.prepare("PRAGMA index_list('nodes')").all().map((row) => row.name);
  assert.ok(indexes.includes("idx_nodes_repo_type_title"));
  const plan = store.db.prepare(
    "EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE repo_id=? AND node_type='symbol' AND title=?",
  ).all(repoId, "login");
  assert.ok(plan.some((row) => String(row.detail).includes("idx_nodes_repo_type_title")), JSON.stringify(plan));
  store.close();
});

test("friendly symbol lookup ignores stale identities left behind by a rebuild", () => {
  const { store, repoId, main } = seed();
  const stale = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::Service.run`,
    title: "run",
    repoId,
  });
  store.upsertSymbolVersion({
    nodeId: stale,
    branchId: main,
    commitSha: "c0",
    filePath: "service.ts",
    lang: "ts",
    kind: "method",
    contentHash: "old",
    status: "stale",
  });
  const fresh = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::service.ts::Service.run`,
    title: "run",
    repoId,
  });
  store.upsertSymbolVersion({
    nodeId: fresh,
    branchId: main,
    commitSha: "c1",
    filePath: "service.ts",
    lang: "ts",
    kind: "method",
    contentHash: "new",
    status: "fresh",
  });

  assert.deepEqual(resolveSymbolMatches(store, "Service.run"), { kind: "unique", nodeId: fresh });
  store.close();
});

test("search's repo filter accepts the repo's display NAME, not just its internal id", () => {
  // Real bug: an MCP caller has no way to know the internal repo_id (a UUID)
  // without first calling index_status — passing the human-readable name
  // shown everywhere else in the UI/CLI (e.g. "fpms") silently filtered
  // every result away instead of scoping to that repo.
  const { store, repoId, login } = seed();
  const otherRepoId = store.registerRepo({ name: "auth", rootPath: "/work/auth" });
  const otherLogin = store.upsertNode({ nodeType: "symbol", identityKey: `${otherRepoId}::login`, title: "login", repoId: otherRepoId });
  store.indexSymbolText({ nodeId: otherLogin, name: "login", signature: null });

  // unscoped: both repos' "login" come back
  const unscoped = search(store, "login");
  assert.ok(unscoped.some((h) => h.nodeId === login));
  assert.ok(unscoped.some((h) => h.nodeId === otherLogin));

  // by internal id — already worked, must keep working
  const byId = search(store, "login", { repo: repoId });
  assert.deepEqual(byId.map((h) => h.nodeId), [login]);

  // by display name — this is the fix; case-insensitive too
  const byName = search(store, "login", { repo: "fpms" });
  assert.deepEqual(byName.map((h) => h.nodeId), [login]);
  const byNameCasedDifferently = search(store, "login", { repo: "FPMS" });
  assert.deepEqual(byNameCasedDifferently.map((h) => h.nodeId), [login]);

  // a name matching no repo at all is a real miss — stays empty, not an error
  assert.deepEqual(search(store, "login", { repo: "nonexistent-repo" }), []);
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

test("graph diagnostics distinguish no match from a resolved node with no static edge", () => {
  const { store, caller } = seed();
  const missing = exploreGraph(store, "who_calls", "does-not-exist");
  assert.equal(missing.diagnostics.resolutionStatus, "no_match");
  assert.equal(missing.diagnostics.resultStatus, "query_error");
  assert.equal(missing.diagnostics.target.resolvedNodeId, null);

  const isolated = exploreGraph(store, "who_calls", caller);
  assert.equal(isolated.diagnostics.resolutionStatus, "resolved");
  assert.equal(isolated.diagnostics.resultStatus, "no_static_edge");
  assert.equal(isolated.diagnostics.target.resolvedNodeId, caller);
  assert.equal(isolated.diagnostics.evidence.incomingByType.calls ?? 0, 0);
  assert.ok(
    isolated.diagnostics.coverageGaps.includes(
      "unresolved_reference_counts_not_persisted",
    ),
  );
  store.close();
});

test("graph diagnostics distinguish ambiguous and stale-only targets", () => {
  const { store, repoId, main } = seed();
  const otherRepoId = store.registerRepo({ name: "auth", rootPath: "/work/auth" });
  const otherMain = store.registerBranch({
    repoId: otherRepoId,
    name: "main",
    status: "live",
  });
  const duplicateA = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::a.ts::Service.run`,
    title: "run",
    repoId,
  });
  const duplicateB = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${otherRepoId}::b.ts::Service.run`,
    title: "run",
    repoId: otherRepoId,
  });
  store.upsertSymbolVersion({
    nodeId: duplicateA,
    branchId: main,
    commitSha: "c0",
    filePath: "a.ts",
    lang: "ts",
    kind: "method",
    contentHash: "a",
  });
  store.upsertSymbolVersion({
    nodeId: duplicateB,
    branchId: otherMain,
    commitSha: "c0",
    filePath: "b.ts",
    lang: "ts",
    kind: "method",
    contentHash: "b",
  });
  assert.equal(
    exploreGraph(store, "who_calls", "Service.run").diagnostics.resolutionStatus,
    "ambiguous",
  );

  const stale = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::StaleService.run`,
    title: "StaleService.run",
    repoId,
  });
  store.upsertSymbolVersion({
    nodeId: stale,
    branchId: main,
    commitSha: "c0",
    filePath: "stale.ts",
    lang: "ts",
    kind: "method",
    contentHash: "old",
    status: "stale",
  });
  assert.equal(
    exploreGraph(store, "who_calls", "StaleService.run").diagnostics.resolutionStatus,
    "stale_target",
  );
  store.close();
});

test("buildExplorePack returns one trust-aware editing payload", () => {
  const { store, login, helper, caller } = seed();
  const pack = buildExplorePack(store, login);
  assert.equal(pack.focus?.nodeId, login);
  assert.ok(pack.calls.some((node) => node.nodeId === helper));
  assert.ok(pack.callPath.some((step) => step.nodeId === helper));
  assert.ok(pack.blastRadius.some((node) => node.nodeId === caller));
  assert.equal(pack.confidence.level, "high");
  assert.equal(pack.provenance.some((item) => item.method === "EXTRACTED"), true);
  assert.ok(Array.isArray(pack.tests));
  assert.ok(Array.isArray(pack.routes));
  assert.ok(Array.isArray(pack.freshness.coverageGaps));
  assert.equal(pack.queryDiagnostics.resolutionStatus, "resolved");
  assert.equal(pack.queryDiagnostics.resultStatus, "has_results");
  store.close();
});

test("buildExplorePack reports a missing target without disguising it as an empty graph", () => {
  const { store } = seed();
  const pack = buildExplorePack(store, "does-not-exist");
  assert.equal(pack.focus, null);
  assert.equal(pack.queryDiagnostics.resolutionStatus, "no_match");
  assert.equal(pack.queryDiagnostics.resultStatus, "query_error");
  store.close();
});

test("buildExplorePack surfaces ambiguous candidates instead of just a match count", () => {
  const { store, repoId, main } = seed();
  const otherRepoId = store.registerRepo({ name: "auth", rootPath: "/work/auth" });
  const otherMain = store.registerBranch({ repoId: otherRepoId, name: "main", status: "live" });
  const duplicateA = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::a.ts::Service.run`,
    title: "run",
    repoId,
  });
  const duplicateB = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${otherRepoId}::b.ts::Service.run`,
    title: "run",
    repoId: otherRepoId,
  });
  store.upsertSymbolVersion({
    nodeId: duplicateA,
    branchId: main,
    commitSha: "c0",
    filePath: "a.ts",
    lang: "ts",
    kind: "method",
    contentHash: "a",
  });
  store.upsertSymbolVersion({
    nodeId: duplicateB,
    branchId: otherMain,
    commitSha: "c0",
    filePath: "b.ts",
    lang: "ts",
    kind: "method",
    contentHash: "b",
  });

  const pack = buildExplorePack(store, "Service.run");
  assert.ok(
    pack.diagnostics.some((message) => message.includes("ambiguous target: 2 matches")),
    "keeps the human-readable diagnostic",
  );
  // The caller needs the actual candidates to disambiguate and retry
  // directly — a bare count forces a guess-and-recheck loop.
  assert.ok(Array.isArray(pack.ambiguousCandidates));
  assert.equal(pack.ambiguousCandidates.length, 2);
  assert.deepEqual(
    new Set(pack.ambiguousCandidates.map((candidate) => candidate.nodeId)),
    new Set([duplicateA, duplicateB]),
  );
  assert.deepEqual(
    new Set(pack.ambiguousCandidates.map((candidate) => candidate.filePath)),
    new Set(["a.ts", "b.ts"]),
  );
  store.close();
});

test("buildExplorePack promotes an endpoint handler as the source-bearing implementation", () => {
  const { store, main, login } = seed();
  const endpoint = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::AuthService.Login",
    title: "gRPC AuthService.Login",
  });
  store.replaceFileEdges({ branchId: main, filePath: "route.ts", edges: [
    { src: endpoint, dst: login, edgeType: "handles", origin: "parser", method: "EXTRACTED" },
  ] });

  const pack = buildExplorePack(store, endpoint);
  assert.equal(pack.focus?.nodeId, endpoint, "focus remains the requested endpoint");
  assert.equal(pack.implementation?.nodeId, login, "handler supplies editable source context");
  assert.equal(pack.trust?.branchId, main, "freshness follows the handler repo/branch");
  assert.ok(pack.routes.some((route) => route.route === "gRPC AuthService.Login" && route.via === "direct"));
  assert.equal(pack.routes.filter((route) => route.route === "gRPC AuthService.Login").length, 1);
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

test("compactIndexStatus keeps one bounded row per repo", () => {
  const { store } = seed();
  const compact = compactIndexStatus(store);
  assert.equal(compact.summary.totalRepos, 1);
  assert.equal(compact.repos.length, 1);
  assert.deepEqual(Object.keys(compact.repos[0]).sort(), [
    "dirtyFileCount",
    "freshness",
    "headCommit",
    "indexErrorCount",
    "indexedCommit",
    "liveBranch",
    "parserVersion",
    "repo",
  ]);
  assert.equal(compact.repos[0].repo, "fpms");
  assert.equal(compact.repos[0].liveBranch, "main");
  store.close();
});
