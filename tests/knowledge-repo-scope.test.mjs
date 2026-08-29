import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, buildContextPack, buildExplorePack, resolveSymbolMatches } from "../packages/knowledge-core/dist/index.js";

// `--repo` reached the answer's scope envelope but never the resolution itself.
// Asking one repo for a name shared across ten returned a ten-way ambiguity
// spanning all ten, and a name that was unique in the target repo could resolve
// silently to a same-named symbol in a different one — empty callers, empty
// calls, no error, and only the trust block naming the repo it actually
// answered from.

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repos = {};
  for (const name of ["alpha", "beta"]) {
    const repoId = store.registerRepo({ name, rootPath: `/${name}` });
    const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
    store.recordBranchIndexed({ branchId, commit: "c0" });
    repos[name] = { repoId, branchId };
  }
  const add = (repo, title, filePath) => {
    const { repoId, branchId } = repos[repo];
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${filePath}::${title}`, title, repoId });
    store.upsertSymbolVersion({
      nodeId, branchId, commitSha: "c0", filePath, lang: "ts", kind: "function",
      contentHash: `h_${repo}_${filePath}_${title}`, status: "fresh", startLine: 1, endLine: 5,
    });
    return nodeId;
  };

  // The same name in both repos — the shape that produced the cross-repo answer.
  const alphaShared = add("alpha", "sharedName", "src/alpha-impl.ts");
  add("beta", "sharedName", "src/beta-impl.ts");
  // A caller in alpha only, so a correct answer has callers and a wrong one does not.
  const alphaCaller = add("alpha", "alphaCaller", "src/alpha-caller.ts");
  store.replaceFileEdges({
    branchId: repos.alpha.branchId, filePath: "src/alpha-caller.ts",
    edges: [{ src: alphaCaller, dst: alphaShared, edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });
  // Two symbols of one name inside alpha: genuine in-repo ambiguity, which must
  // survive scoping — narrowing is not the same as guessing.
  add("alpha", "twiceInAlpha", "src/one.ts");
  add("alpha", "twiceInAlpha", "src/two.ts");
  return { store, repos, alphaShared };
}

test("a repo-scoped name resolves within that repo", () => {
  const { store, repos, alphaShared } = seed();
  const resolution = resolveSymbolMatches(store, "sharedName", { repoId: repos.alpha.repoId });
  assert.equal(resolution.kind, "unique", `expected one match in alpha, got ${JSON.stringify(resolution).slice(0, 200)}`);
  assert.equal(resolution.nodeId, alphaShared);
  store.close();
});

test("the same name without a repo is still ambiguous", () => {
  // Scoping must narrow, not change what ambiguity means.
  const { store } = seed();
  assert.equal(resolveSymbolMatches(store, "sharedName").kind, "ambiguous");
  store.close();
});

test("ambiguity inside the scoped repo is reported, not guessed", () => {
  const { store, repos } = seed();
  const resolution = resolveSymbolMatches(store, "twiceInAlpha", { repoId: repos.alpha.repoId });
  assert.equal(resolution.kind, "ambiguous", "two real definitions in one repo is a real question for the caller");
  assert.equal(resolution.candidates.length, 2);
  store.close();
});

test("a node id from another repo is refused rather than answered", () => {
  // The silent wrong-repo answer: a direct identity hit bypassed the scope
  // entirely and returned another repo's symbol with empty relations.
  const { store, repos, alphaShared } = seed();
  const betaNode = store.db
    .prepare("SELECT id FROM nodes WHERE title='sharedName' AND repo_id=?")
    .get(repos.beta.repoId).id;
  assert.equal(resolveSymbolMatches(store, betaNode, { repoId: repos.alpha.repoId }).kind, "none");
  assert.equal(resolveSymbolMatches(store, alphaShared, { repoId: repos.alpha.repoId }).kind, "unique");
  assert.equal(resolveSymbolMatches(store, betaNode).kind, "unique", "unscoped, the same id still resolves");
  store.close();
});

test("the packs answer from the scoped repo, with its relations", () => {
  const { store, repos } = seed();
  const context = buildContextPack(store, "sharedName", { repoId: repos.alpha.repoId });
  assert.equal(context.focus?.filePath, "src/alpha-impl.ts");
  assert.ok(
    context.callers.some((c) => c.title === "alphaCaller"),
    `the scoped answer must carry alpha's relations, got ${JSON.stringify(context.callers)}`,
  );

  const explore = buildExplorePack(store, "sharedName", { repoId: repos.beta.repoId });
  assert.equal(explore.focus?.filePath, "src/beta-impl.ts");
  assert.deepEqual(explore.callers, [], "beta's copy genuinely has no callers");
  store.close();
});

test("an unscoped pack is unchanged", () => {
  // The default path must not start narrowing on its own.
  const { store } = seed();
  const pack = buildContextPack(store, "alphaCaller");
  assert.equal(pack.focus?.title, "alphaCaller");
  store.close();
});

// An external model evaluating the index reported three defects that all share
// one shape: an answer that does not exist, presented as an answer that does.

test("completeness never claims to be complete", async () => {
  const { buildContextPack: build } = await import("../packages/knowledge-core/dist/index.js");
  const { store } = seed();
  // "complete" was never true. The resolver models direct calls and not
  // constructor invocation, interface dispatch, static calls or calls inside
  // callbacks, so the list is a lower bound and saying otherwise told agents
  // "this function calls nothing" about functions with five visible calls.
  const pack = build(store, "alphaCaller");
  assert.notEqual(pack.completeness.status, "complete");
  assert.equal(pack.completeness.status, "lower_bound");
  assert.match(pack.completeness.note, /lower bound/i, "and it says so in words, not just a status");
  store.close();
});

test("a target that does not resolve is not complete and not high confidence", async () => {
  const { buildExplorePack: explore } = await import("../packages/knowledge-core/dist/index.js");
  const { store } = seed();
  // `explore <name-not-in-the-index>` returned completeness "complete" beside
  // confidence "high" for an empty pack — the index at its most confident
  // about nothing at all.
  const pack = explore(store, "definitelyNotIndexedAnywhere");
  assert.equal(pack.focus, null);
  assert.equal(pack.completeness.status, "unknown");
  assert.notEqual(pack.confidence.level, "high", "no answer cannot be a high-confidence answer");
  store.close();
});

test("graph queries honour the repo scope", async () => {
  const { exploreGraph } = await import("../packages/knowledge-core/dist/index.js");
  const { store, repos, alphaShared } = seed();
  const scoped = exploreGraph(store, "who_calls", "sharedName", { repoId: repos.alpha.repoId });
  assert.equal(scoped.diagnostics.resolutionStatus, "resolved", "the scope settles the name");
  assert.ok(
    scoped.nodes.some((n) => n.title === "alphaCaller"),
    `and returns that repo's callers, got ${JSON.stringify(scoped.nodes)}`,
  );
  const unscoped = exploreGraph(store, "who_calls", "sharedName");
  assert.equal(unscoped.diagnostics.resolutionStatus, "ambiguous", "unscoped, the name is still ambiguous");
  assert.deepEqual(unscoped.nodes, [], "and an ambiguous lookup returns nothing — which the CLI must not print as (none)");
  store.close();
});

test("architecture narrows to one repo when asked", async () => {
  const { architecture } = await import("../packages/knowledge-core/dist/index.js");
  const { store, repos } = seed();
  // --repo was accepted and ignored, so "tell me about this service" answered
  // with the whole 26-repo estate.
  const scoped = architecture(store, { repoId: repos.alpha.repoId });
  assert.deepEqual(scoped.repos.map((r) => r.name), ["alpha"]);
  assert.ok(scoped.nodeCounts.symbol > 0, "and still reports that repo's own counts");

  const all = architecture(store);
  assert.deepEqual(all.repos.map((r) => r.name).sort(), ["alpha", "beta"], "unscoped is unchanged");
  store.close();
});

test("repoGraph ranks on architectural edges and reports the degree it ranked on", async () => {
  const { repoGraph } = await import("../packages/knowledge-core/dist/index.js");
  const { store, repos } = seed();
  const graph = repoGraph(store, repos.alpha.repoId, repos.alpha.branchId);
  assert.ok(graph.nodes.length > 0);
  // degree was in the result shape and always null, so a caller could not see
  // why a node ranked where it did — and the ranking counted imports and
  // defines, which put .spec.ts files at the top of "top hubs".
  assert.ok(
    graph.nodes.every((n) => typeof n.degree === "number"),
    `every node carries the number it was ranked by, got ${JSON.stringify(graph.nodes.slice(0, 3))}`,
  );
  const degrees = graph.nodes.map((n) => n.degree);
  assert.deepEqual(degrees, [...degrees].sort((a, b) => b - a), "and the list is ordered by it");
  store.close();
});

test("a graph result at the limit says it was capped", async () => {
  const { exploreGraph } = await import("../packages/knowledge-core/dist/index.js");
  const { store, repos, alphaShared } = seed();
  // `callers` on a symbol with 450 callers returned exactly 100 rows with
  // nothing to say more existed — a capped list read as the whole answer.
  const extra = [];
  for (let i = 0; i < 5; i += 1) {
    const id = store.upsertNode({
      nodeType: "symbol", identityKey: `${repos.alpha.repoId}::caller${i}`, title: `caller${i}`, repoId: repos.alpha.repoId,
    });
    store.upsertSymbolVersion({
      nodeId: id, branchId: repos.alpha.branchId, commitSha: "c0", filePath: `src/c${i}.ts`,
      lang: "ts", kind: "function", contentHash: `h${i}`, status: "fresh", startLine: 1, endLine: 2,
    });
    extra.push({ src: id, dst: alphaShared, edgeType: "calls", origin: "parser", method: "EXTRACTED" });
  }
  extra.forEach((edge, i) => store.replaceFileEdges({
    branchId: repos.alpha.branchId, filePath: `src/c${i}.ts`, edges: [edge],
  }));

  const capped = exploreGraph(store, "who_calls", alphaShared, { limit: 3 });
  assert.equal(capped.nodes.length, 3);
  assert.ok(capped.truncated, "a result at the cap must say so");
  assert.equal(capped.truncated.limit, 3);

  const whole = exploreGraph(store, "who_calls", alphaShared, { limit: 50 });
  assert.equal(whole.truncated, undefined, "and a complete list must not claim truncation");
  store.close();
});
