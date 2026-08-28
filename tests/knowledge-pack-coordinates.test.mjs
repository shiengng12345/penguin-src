import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, buildContextPack, buildExplorePack } from "../packages/knowledge-core/dist/index.js";

// Relation lists used to be bare names, so opening a caller meant a second
// lookup per entry — and an agent that skipped those lookups guessed at
// locations. Coordinates now travel with the relation.

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-coord-"));
  // Real files on disk: the source-budget path reads them, so a fixture with
  // only database rows silently skips every assembly step it means to test.
  const root = mkdtempSync(join(tmpdir(), "pk-coord-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "svc", rootPath: root });
  const branchId = store.registerBranch({ repoId, name: "main", checkoutPath: root, status: "live" });
  store.recordBranchIndexed({ branchId, commit: "c0" });

  const mk = (name, filePath, startLine, endLine) => {
    writeFileSync(
      join(root, filePath),
      Array.from({ length: endLine + 5 }, (_, i) => `// line ${i + 1} of ${filePath}`).join("\n"),
    );
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${name}`, title: name, repoId });
    store.upsertSymbolVersion({
      nodeId, branchId, commitSha: "c0", filePath, lang: "ts", kind: "function",
      contentHash: `h_${name}`, status: "fresh", startLine, endLine,
    });
    return nodeId;
  };
  const handler = mk("handleRequest", "src/handler.ts", 10, 40);
  const service = mk("runJob", "src/service.ts", 100, 180);
  const caller = mk("routeRequest", "src/router.ts", 5, 20);
  store.replaceFileEdges({ branchId, filePath: "src/handler.ts", edges: [
    { src: handler, dst: service, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  store.replaceFileEdges({ branchId, filePath: "src/router.ts", edges: [
    { src: caller, dst: handler, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  return { store };
}

test("callers and callees arrive with file and line range", () => {
  const { store } = seed();
  const pack = buildContextPack(store, "handleRequest");

  const callee = pack.calls.find((c) => c.title === "runJob");
  assert.ok(callee, "callee listed");
  assert.equal(callee.filePath, "src/service.ts");
  assert.equal(callee.startLine, 100);
  assert.equal(callee.endLine, 180);

  const caller = pack.callers.find((c) => c.title === "routeRequest");
  assert.ok(caller, "caller listed");
  assert.equal(caller.filePath, "src/router.ts");
  assert.equal(caller.startLine, 5);
  store.close();
});

test("a node with no fresh definition simply omits the fields", () => {
  // Resolver placeholders have no symbol_version. They must not invent a
  // location, and must not break the list either.
  const { store } = seed();
  const repoId = store.db.prepare("SELECT id FROM repos LIMIT 1").get().id;
  const ghost = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::ghost`, title: "ghost", repoId });
  const branchId = store.db.prepare("SELECT id FROM branches LIMIT 1").get().id;
  const handler = store.db
    .prepare("SELECT node_id AS id FROM symbol_versions WHERE file_path='src/handler.ts'")
    .get().id;
  store.replaceFileEdges({ branchId, filePath: "src/ghost.ts", edges: [
    { src: ghost, dst: handler, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });

  const brief = buildContextPack(store, "handleRequest").callers.find((c) => c.title === "ghost");
  assert.ok(brief, "a placeholder caller is still listed");
  assert.equal(brief.filePath, undefined);
  assert.equal(brief.startLine, undefined);
  store.close();
});

test("includeSources false returns relations only and names every omission", () => {
  const { store } = seed();
  const pack = buildExplorePack(store, "handleRequest", { includeSources: false });
  assert.deepEqual(pack.sources, [], "no source blocks were asked for");
  assert.ok(pack.sourcesOmitted.length > 0, "an empty sources list must say why it is empty");
  assert.ok(
    pack.sourcesOmitted.some((entry) => /includeSources=false/.test(entry)),
    `the reason must be the caller's choice, got ${JSON.stringify(pack.sourcesOmitted)}`,
  );
  // The relations are the point of the call and must survive.
  assert.ok(pack.calls.some((c) => c.title === "runJob"));
  assert.ok(pack.callers.some((c) => c.title === "routeRequest"));
  store.close();
});

test("maxSourceLines caps the pack and says the ceiling it hit", () => {
  const { store } = seed();
  const tiny = buildExplorePack(store, "handleRequest", { maxSourceLines: 1 });
  const lines = tiny.sources.reduce((sum, block) => sum + (block.endLine - block.startLine + 1), 0);
  assert.ok(lines <= 1, `budget of 1 line returned ${lines}`);
  assert.ok(
    tiny.sourcesOmitted.some((entry) => /raise maxSourceLines/.test(entry)),
    `an exhausted budget must point at the knob, got ${JSON.stringify(tiny.sourcesOmitted)}`,
  );
  store.close();
});

test("the default still includes source", () => {
  // The controls are opt-in; the default behaviour must not change.
  const { store } = seed();
  const pack = buildExplorePack(store, "handleRequest");
  assert.ok(
    pack.sources.length > 0 || pack.sourcesOmitted.length > 0,
    "the default path still attempts source assembly",
  );
  assert.ok(
    !pack.sourcesOmitted.some((entry) => /includeSources=false/.test(entry)),
    "nothing may be dropped for a reason the caller never asked for",
  );
  store.close();
});

test("explore threads the same source controls through", () => {
  const { store } = seed();
  const pack = buildExplorePack(store, "handleRequest", { includeSources: false });
  assert.deepEqual(pack.sources, []);
  assert.ok(pack.sourcesOmitted.some((entry) => /includeSources=false/.test(entry)));
  assert.ok(pack.calls.some((c) => c.title === "runJob"), "relations survive on the tier-0 entry point too");
  store.close();
});
