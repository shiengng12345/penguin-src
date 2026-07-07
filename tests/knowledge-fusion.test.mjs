import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { parseNote, indexNote, resolveNoteLinks } from "../packages/knowledge-indexer/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-fusion-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}
function addNote(store, path, source) {
  const parsed = parseNote({ path, source });
  const { nodeId } = indexNote({ store, repoRelPath: path, parsed });
  const stats = resolveNoteLinks({
    store, noteNodeId: nodeId, noteTitle: parsed.title, noteIdentityKey: parsed.identityKey, parsed,
  });
  return { nodeId, parsed, stats };
}

test("wikilink resolves to a note title (linked)", () => {
  const store = openStore();
  addNote(store, "b.md", "---\nid: b\ntitle: Beta\n---\nbody");
  const a = addNote(store, "a.md", "---\nid: a\ntitle: Alpha\n---\nsee [[Beta]]");
  assert.equal(a.stats.linked, 1);
  const edge = store.db.prepare("SELECT * FROM edges WHERE src=? AND edge_type='wikilink'").get(a.nodeId);
  assert.ok(edge.dst, "wikilink dst resolved");
  store.close();
});

test("wikilink to a symbol name resolves via priority ladder", () => {
  const store = openStore();
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::GetLoginURL`, title: "GetLoginURL", repoId });
  const a = addNote(store, "a.md", "---\nid: a\ntitle: A\n---\ncalls [[GetLoginURL]]");
  assert.equal(a.stats.linked, 1);
  store.close();
});

test("unresolved wikilink keeps raw_target and backfills when target appears", () => {
  const store = openStore();
  const a = addNote(store, "a.md", "---\nid: a\ntitle: Alpha\n---\nlink [[Gamma]]");
  assert.equal(a.stats.unresolved, 1);
  let edge = store.db.prepare("SELECT * FROM edges WHERE src=? AND edge_type='wikilink'").get(a.nodeId);
  assert.equal(edge.dst, null);
  assert.equal(edge.raw_target, "Gamma");

  // create Gamma → backfill links the earlier edge
  const g = addNote(store, "g.md", "---\nid: g\ntitle: Gamma\n---\nhi");
  edge = store.db.prepare("SELECT * FROM edges WHERE src=? AND edge_type='wikilink'").get(a.nodeId);
  assert.equal(edge.dst, g.nodeId, "unresolved link backfilled to Gamma");
  store.close();
});

test("ambiguous wikilink (two notes same title) does not guess", () => {
  const store = openStore();
  addNote(store, "l1.md", "---\nid: l1\ntitle: Login\n---\none");
  addNote(store, "l2.md", "---\nid: l2\ntitle: Login\n---\ntwo");
  const a = addNote(store, "a.md", "---\nid: a\ntitle: A\n---\nsee [[Login]]");
  assert.equal(a.stats.ambiguous, 1);
  const edge = store.db.prepare("SELECT * FROM edges WHERE src=? AND edge_type='wikilink'").get(a.nodeId);
  assert.equal(edge.dst, null, "ambiguous → not auto-picked");
  store.close();
});

test("entity mentions create entity nodes + edges (deduped)", () => {
  const store = openStore();
  const a = addNote(store, "a.md", "---\nid: a\ntitle: A\n---\nplayerId: 12345 seen on prod");
  const mentions = store.db.prepare("SELECT * FROM edges WHERE src=? AND edge_type='entity_mention'").all(a.nodeId);
  assert.ok(mentions.length >= 2, "player_id + env entity mentions");
  assert.ok(mentions.every((m) => m.dst));
  store.close();
});

test("credential_entries: body stored via API but never in FTS or meta list", () => {
  const store = openStore();
  const nodeId = store.upsertNode({ nodeType: "credential", identityKey: "cred:gh", title: "Github Token" });
  store.putCredential({ nodeId, title: "Github Token", kind: "token", body: "ghp_supersecret" });
  assert.equal(store.getCredential(nodeId).body, "ghp_supersecret");
  const meta = store.listCredentialMeta();
  assert.ok(meta.some((m) => m.nodeId === nodeId && m.title === "Github Token"));
  assert.ok(!("body" in meta[0]), "meta list carries no body");
  assert.ok(!store.searchText("ghp_supersecret", { includeSensitive: true }).length, "body not in FTS");
  store.close();
});
