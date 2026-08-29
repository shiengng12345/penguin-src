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
