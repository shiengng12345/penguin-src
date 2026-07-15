import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, search } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-search-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function seed(store) {
  const note = store.upsertNode({
    nodeType: "note", identityKey: "cases/gameurl.md", title: "Brazil GameURL Issue",
  });
  store.indexNoteText({
    nodeId: note, path: "cases/gameurl.md", title: "Brazil GameURL Issue",
    body: "providerId 2043 returns empty gameURL", contentHash: "h1",
  });
  const secret = store.upsertNode({
    nodeType: "note", identityKey: "credentials/github.md", title: "Github Account",
  });
  store.indexNoteText({
    nodeId: secret, path: "credentials/github.md", title: "Github Account",
    body: "recovery codes for gameURL testing", sensitive: true,
    mcpAccess: "denied", contentHash: "h2",
  });
  const sym = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:GetLoginURL", title: "GetLoginURL",
  });
  store.indexSymbolText({
    nodeId: sym, name: "GetLoginURL", signature: "(req: LoginReq) => LoginRes",
  });
  return { note, secret, sym };
}

test("searchText finds notes and symbols", () => {
  const store = openTemp();
  const { note, sym } = seed(store);
  const hits = store.searchText("gameURL");
  const ids = hits.map((h) => h.nodeId);
  assert.ok(ids.includes(note));
  const symHits = store.searchText("GetLoginURL");
  assert.ok(symHits.map((h) => h.nodeId).includes(sym));
  assert.equal(
    symHits.find((h) => h.nodeId === sym)?.snippet,
    "(req: LoginReq) => LoginRes",
    "symbol search results should expose the indexed signature without an extra get_node call",
  );
  store.close();
});

test("searchText excludes stale symbol identities superseded by a rebuild", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "auth", rootPath: "/work/auth" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const stale = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::Service.closeAccount`,
    title: "closeAccount",
    repoId,
  });
  store.upsertSymbolVersion({
    nodeId: stale, branchId, commitSha: "old", filePath: "service.ts", lang: "ts",
    kind: "method", contentHash: "old", status: "stale",
  });
  store.indexSymbolText({ nodeId: stale, name: "closeAccount", signature: "closeAccount(old)" });
  const fresh = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::service.ts::Service.closeAccount`,
    title: "closeAccount",
    repoId,
  });
  store.upsertSymbolVersion({
    nodeId: fresh, branchId, commitSha: "new", filePath: "service.ts", lang: "ts",
    kind: "method", contentHash: "new", status: "fresh",
  });
  store.indexSymbolText({ nodeId: fresh, name: "closeAccount", signature: "closeAccount(current)" });

  assert.deepEqual(store.searchText("closeAccount").map((hit) => hit.nodeId), [fresh]);
  store.close();
});

test("sensitive notes are excluded by default, included on opt-in", () => {
  const store = openTemp();
  const { secret } = seed(store);
  const def = store.searchText("gameURL");
  assert.ok(!def.map((h) => h.nodeId).includes(secret));
  const opted = store.searchText("gameURL", { includeSensitive: true });
  assert.ok(opted.map((h) => h.nodeId).includes(secret));
  store.close();
});

test("type filter narrows results", () => {
  const store = openTemp();
  seed(store);
  const hits = store.searchText("gameURL", { types: ["symbol"] });
  assert.ok(hits.every((h) => h.nodeType === "symbol"));
  store.close();
});

test("searchText: multi-word queries AND-match individual terms (any order), not a strict adjacent phrase", () => {
  // Real bug: the whole query string was wrapped in ONE pair of quotes, which
  // FTS5 treats as a required contiguous PHRASE (exact word order, adjacent).
  // Any realistic multi-word query — including a caller just listing several
  // relevant terms, or the words appearing in a different order than an exact
  // memorized phrase — returned zero results even though every term is
  // genuinely present in the document. The note body is "providerId 2043
  // returns empty gameURL" — "gameURL" comes AFTER "providerId"; a reversed
  // 2-word query must still find it.
  const store = openTemp();
  const { note } = seed(store);
  const hits = store.searchText("gameURL providerId");
  assert.ok(hits.map((h) => h.nodeId).includes(note), "words present anywhere in the doc, any order, must match");
  store.close();
});

test("re-indexing a note replaces its FTS row (no duplicates)", () => {
  const store = openTemp();
  const { note } = seed(store);
  store.indexNoteText({
    nodeId: note, path: "cases/gameurl.md", title: "Brazil GameURL Issue",
    body: "updated body still gameURL", contentHash: "h1b",
  });
  const hits = store.searchText("gameURL").filter((h) => h.nodeId === note);
  assert.equal(hits.length, 1);
  store.close();
});

test("searchIdentifiers: finds object-literal keys / interface fields / class fields — real gap, no symbol node covers these", () => {
  // Real bug reported from actual MCP usage: a field name like
  // "suspensionPeriod" (an interface member or object-literal key) has no
  // symbol node at all, so knowledge_search always returned empty for it —
  // the reporting session's longest-stuck point in a whole debugging
  // session, resolved only by `find`, never by penguin.
  const store = openTemp();
  store.indexIdentifiers({
    repoId: "repo1",
    filePath: "src/types.ts",
    entries: [
      { name: "suspensionPeriod", startLine: 3, kind: "field" },
      { name: "effectiveTime", startLine: 4, kind: "field" },
    ],
  });
  const hits = store.searchIdentifiers("suspensionPeriod");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].filePath, "src/types.ts");
  assert.equal(hits[0].startLine, 3);
  assert.equal(hits[0].repoId, "repo1");
  store.close();
});

test("searchIdentifiers: re-indexing a file replaces its prior entries (no duplicates)", () => {
  const store = openTemp();
  store.indexIdentifiers({
    repoId: "repo1", filePath: "src/types.ts",
    entries: [{ name: "oldField", startLine: 1, kind: "field" }],
  });
  store.indexIdentifiers({
    repoId: "repo1", filePath: "src/types.ts",
    entries: [{ name: "newField", startLine: 1, kind: "field" }],
  });
  assert.equal(store.searchIdentifiers("oldField").length, 0, "stale entry from the prior parse must not survive");
  assert.equal(store.searchIdentifiers("newField").length, 1);
  store.close();
});

test("search(): a field name with no symbol/note match automatically falls back to fts_identifiers", () => {
  // Real bug: knowledge_search returned a bare empty result for a real field
  // name (an interface member / object-literal key), indistinguishable from
  // "this doesn't exist in the code at all" — this is exactly the reporting
  // session's longest-stuck point.
  const store = openTemp();
  store.indexIdentifiers({
    repoId: "repo1", filePath: "src/types.ts",
    entries: [{ name: "suspensionPeriod", startLine: 5, kind: "field" }],
  });
  const hits = search(store, "suspensionPeriod");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].nodeType, "field");
  assert.equal(hits[0].nodeId, null, "a field hit has no real graph node id");
  assert.equal(hits[0].filePath, "src/types.ts");
  assert.equal(hits[0].startLine, 5);
  store.close();
});

test("search(): a real symbol match does NOT trigger the field fallback", () => {
  const store = openTemp();
  const { sym } = seed(store);
  store.indexIdentifiers({
    repoId: "repo1", filePath: "src/unrelated.ts",
    entries: [{ name: "GetLoginURL", startLine: 1, kind: "field" }],
  });
  const hits = search(store, "GetLoginURL");
  assert.ok(hits.every((h) => h.nodeType !== "field"), "a real symbol hit must suppress the empty-result field fallback");
  assert.ok(hits.some((h) => h.nodeId === sym));
  store.close();
});

test("search(): type: [\"field\"] explicitly searches fields only, even when a symbol/note match also exists", () => {
  const store = openTemp();
  seed(store);
  store.indexIdentifiers({
    repoId: "repo1", filePath: "src/types.ts",
    entries: [{ name: "GetLoginURL", startLine: 9, kind: "object_key" }],
  });
  const hits = search(store, "GetLoginURL", { type: ["field"] });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.nodeType === "field"), "explicit type=[field] must exclude the real symbol match");
  store.close();
});

test("search(): an explicit non-field type filter with zero hits does NOT trigger the field fallback", () => {
  const store = openTemp();
  store.indexIdentifiers({
    repoId: "repo1", filePath: "src/types.ts",
    entries: [{ name: "onlyAField", startLine: 1, kind: "field" }],
  });
  const hits = search(store, "onlyAField", { type: ["symbol"] });
  assert.equal(hits.length, 0, "an explicit type filter opts OUT of the automatic fallback — caller asked for symbols only");
  store.close();
});

test("search(): repo-scoped lookup finds a global gRPC endpoint through its provider service", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "flyover", rootPath: "/tmp/flyover" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const serviceId = store.upsertNode({
    nodeType: "service",
    identityKey: `grpc-module::${repoId}::player`,
    title: "player",
    repoId,
  });
  const endpointId = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::PlayerService.getplayerprofilebyjwt",
    title: "PlayerService.GetPlayerProfileByJwt",
  });
  store.replaceFileEdges({
    repoId,
    branchId,
    filePath: "apps/player/player.proto",
    edges: [{
      src: endpointId,
      dst: serviceId,
      edgeType: "handles",
      origin: "parser",
      method: "EXTRACTED",
      branchless: true,
    }],
  });

  const hits = search(store, "GetPlayerProfileByJwt", { repo: "flyover" });
  assert.ok(hits.some((hit) => hit.nodeId === endpointId), JSON.stringify(hits));
  store.close();
});
