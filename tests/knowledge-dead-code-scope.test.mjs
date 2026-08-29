import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, deadCode } from "../packages/knowledge-core/dist/index.js";

// find_dead_code advertised only `limit` while agents naturally passed `repo`
// and `path`. Nothing rejected them and nothing used them, so a question about
// one repo was answered from all 25 — and the answer looked scoped.

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-dead-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });

  const repos = {};
  for (const name of ["alpha", "beta"]) {
    const repoId = store.registerRepo({ name, rootPath: `/${name}` });
    const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
    store.recordBranchIndexed({ branchId, commit: "c0" });
    repos[name] = { repoId, branchId };
  }

  const add = (repo, name, filePath, { status = "fresh", branchId } = {}) => {
    const { repoId } = repos[repo];
    const nodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${repoId}::${filePath}::${name}`,
      title: name,
      repoId,
    });
    store.upsertSymbolVersion({
      nodeId,
      branchId: branchId ?? repos[repo].branchId,
      filePath,
      startLine: 1,
      endLine: 5,
      kind: "function",
      status,
      commitSha: "c0",
      lang: "ts",
      contentHash: `h-${name}`,
    });
    return nodeId;
  };

  // alpha: one unreferenced symbol under apps/, one under libs/, and one that
  // IS called (so it must never be a candidate).
  const orphanApp = add("alpha", "orphanInApp", "apps/promotion/src/orphan.ts");
  add("alpha", "orphanInLib", "libs/shared/src/orphan.ts");
  const livingTarget = add("alpha", "livingTarget", "apps/promotion/src/living.ts");
  const caller = add("alpha", "caller", "apps/promotion/src/caller.ts");
  store.replaceFileEdges({
    branchId: repos.alpha.branchId,
    filePath: "apps/promotion/src/caller.ts",
    edges: [{ src: caller, dst: livingTarget, edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });

  // beta: its own orphan, which an alpha-scoped question must not return.
  add("beta", "orphanInBeta", "src/orphan.ts");

  return { store, repos, orphanApp };
}

test("without a repo the result says so instead of implying a scope", () => {
  const { store } = seed();
  const result = deadCode(store);
  assert.equal(result.scope.repo, null);
  assert.match(result.note, /every indexed repo/, "an unscoped answer must admit it is unscoped");
  const titles = result.candidates.map((c) => c.title);
  assert.ok(titles.includes("orphanInApp"));
  assert.ok(titles.includes("orphanInBeta"), "unscoped really does span repos");
  store.close();
});

test("repo scopes the candidates and is reported back", () => {
  const { store } = seed();
  const result = deadCode(store, { repo: "alpha" });
  const titles = result.candidates.map((c) => c.title);
  assert.ok(titles.includes("orphanInApp"));
  assert.ok(titles.includes("orphanInLib"));
  assert.ok(!titles.includes("orphanInBeta"), `beta leaked into an alpha query: ${JSON.stringify(titles)}`);
  assert.equal(result.scope.repo, "alpha");
  assert.match(result.note, /repo alpha/);
  store.close();
});

test("path narrows to a prefix", () => {
  const { store } = seed();
  const titles = deadCode(store, { repo: "alpha", path: "apps/promotion" }).candidates.map((c) => c.title);
  // `caller` belongs here too: nothing calls IT, so it is a candidate on the
  // same rule. What must not appear is anything outside the prefix.
  assert.deepEqual(titles.sort(), ["caller", "orphanInApp"]);
  store.close();
});

test("a path prefix is matched literally, not as a LIKE pattern", () => {
  // A real path containing _ or % would otherwise act as a wildcard.
  const { store } = seed();
  const result = deadCode(store, { repo: "alpha", path: "apps/pro_otion" });
  assert.deepEqual(result.candidates, [], "_ must not match any character");
  store.close();
});

test("a called symbol is never a candidate", () => {
  const { store } = seed();
  const titles = deadCode(store, { repo: "alpha" }).candidates.map((c) => c.title);
  assert.ok(!titles.includes("livingTarget"), "a symbol with an inbound call edge is not dead");
  store.close();
});

test("a superseded symbol version is not reported as dead", () => {
  // Stale rows have no inbound edges, so counting them makes every symbol that
  // ever moved look dead forever. This is the same trap that made a fake-symbol
  // measurement read 623 when the real number was 1.
  const { store, repos } = seed();
  const nodeId = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repos.alpha.repoId}::moved`,
    title: "movedAway",
    repoId: repos.alpha.repoId,
  });
  store.upsertSymbolVersion({
    nodeId,
    branchId: repos.alpha.branchId,
    filePath: "apps/promotion/src/old.ts",
    startLine: 1,
    endLine: 5,
    kind: "function",
    status: "stale",
    commitSha: "c0",
    lang: "ts",
    contentHash: "h-moved",
  });
  const titles = deadCode(store, { repo: "alpha" }).candidates.map((c) => c.title);
  assert.ok(!titles.includes("movedAway"), "stale versions must not count as dead code");
  store.close();
});

test("candidates carry their coordinates", () => {
  const { store } = seed();
  const candidates = deadCode(store, { repo: "alpha", path: "apps/promotion" }).candidates;
  const candidate = candidates.find((c) => c.title === "orphanInApp");
  assert.equal(candidate.filePath, "apps/promotion/src/orphan.ts");
  assert.equal(candidate.startLine, 1);
  assert.equal(candidate.endLine, 5);
  store.close();
});

test("truncation is reported, not silent", () => {
  const { store } = seed();
  const result = deadCode(store, { repo: "alpha", limit: 1 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.truncated, true);
  assert.match(result.note, /raise limit/);
  store.close();
});

test("an unknown repo is an empty answer that names the problem", () => {
  const { store } = seed();
  const result = deadCode(store, { repo: "no-such-repo" });
  assert.deepEqual(result.candidates, []);
  assert.match(result.note, /no indexed repo matches/);
  assert.equal(result.truncated, false);
  store.close();
});

// A reviewer found a live NestJS interceptor — imported by two controllers,
// wired by a decorator so it has no call edge — presented as dead code with
// nothing to distinguish it from a symbol nothing references at all. The
// generic "DI and reflection are false positives" note in the prose is not
// evidence a caller can act on per candidate.
test("a candidate says how many files import the file it lives in", () => {
  const { store, repos } = seed();
  const repoId = repos.alpha.repoId;
  // A file node carries its repo-relative path as its title, and something
  // imports it — the shape of a DI-wired provider.
  const fileNode = store.db.prepare(
    "SELECT id FROM nodes WHERE node_type='file' AND title=? AND repo_id=?",
  ).get("apps/promotion/src/orphan.ts", repoId)?.id
    ?? store.upsertNode({
      nodeType: "file", identityKey: `${repoId}::file::apps/promotion/src/orphan.ts`,
      title: "apps/promotion/src/orphan.ts", repoId,
    });
  const importer = store.upsertNode({
    nodeType: "file", identityKey: `${repoId}::file::apps/promotion/src/module.ts`,
    title: "apps/promotion/src/module.ts", repoId,
  });
  store.replaceFileEdges({
    branchId: repos.alpha.branchId, filePath: "apps/promotion/src/module.ts",
    edges: [{ src: importer, dst: fileNode, edgeType: "imports", origin: "parser", method: "EXTRACTED" }],
  });

  const candidates = deadCode(store, { repo: "alpha" }).candidates;
  const wired = candidates.find((c) => c.filePath === "apps/promotion/src/orphan.ts");
  assert.ok(wired, "the symbol is still a candidate — an import is not a call");
  assert.equal(wired.fileImportedBy, 1, "but the caller can now see something pulls its file in");

  const untouched = candidates.find((c) => c.filePath === "libs/shared/src/orphan.ts");
  assert.equal(untouched.fileImportedBy, 0, "while a file nobody imports reads zero — the strong case");
  store.close();
});
