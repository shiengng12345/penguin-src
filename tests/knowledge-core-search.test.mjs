import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

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
