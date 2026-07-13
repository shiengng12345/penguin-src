// tests/knowledge-notes-prune.test.mjs
// Audit F-3 follow-ups (Codex round 2):
// 1. reindexNotesDir must PURGE DB rows for note files deleted from disk —
//    otherwise a DB-only note survives until the next wipe loses it forever.
// 2. resolveIdentity must not return an alias pointing at a dead node id
//    (post-wipe ledger aliases all do) — getNodeDetail dereferences it with `!`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { createNote, reindexNotesDir } from "../packages/knowledge-indexer/dist/notes-fs.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-np-"));
  return {
    store: KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }),
    dir,
  };
}

test("reindexNotesDir purges notes whose markdown file was deleted", () => {
  const { store, dir } = openStore();
  const notesDir = join(dir, "notes");
  const a = createNote({ store, notesDir, title: "Keep Me", body: "stays" });
  const b = createNote({ store, notesDir, title: "Delete Me", body: "goes" });
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM notes_index").get().c, 2);

  rmSync(b.path);
  const r = reindexNotesDir({ store, notesDir });
  assert.equal(r.indexed, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM notes_index").get().c, 1, "stale notes_index row purged");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE node_type='note' AND id=?").get(b.nodeId).c,
    0, "stale note node purged",
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM fts_notes WHERE node_id=?").get(b.nodeId).c,
    0, "stale fts row purged",
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM notes_index WHERE node_id=?").get(a.nodeId).c,
    1, "surviving note untouched",
  );
  store.close();
});

test("resolveIdentity ignores aliases that point at dead nodes", () => {
  const { store } = openStore();
  // Ledger-replayed alias whose target node no longer exists (post-wipe state).
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system",
    method: "EXTRACTED",
    actor: { type: "system", id: "test" },
    target: { node_id: "node_dead_after_wipe" },
    payload: { alias_key: "repo::OldName", alias_type: "qualified_name", reason: "rename" },
  });
  const hit = store.resolveIdentity("repo::OldName");
  assert.equal(hit, null, "alias to a dead node must not resolve");

  // A live node's alias still resolves.
  const live = store.upsertNode({ nodeType: "symbol", identityKey: "repo::NewName", title: "NewName" });
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system",
    method: "EXTRACTED",
    actor: { type: "system", id: "test" },
    target: { node_id: live },
    payload: { alias_key: "repo::OldName2", alias_type: "qualified_name", reason: "rename" },
  });
  assert.deepEqual(store.resolveIdentity("repo::OldName2"), { nodeId: live, via: "alias" });
  store.close();
});
