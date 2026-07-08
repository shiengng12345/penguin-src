import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, exploreGraph, listSuggestions } from "../packages/knowledge-core/dist/index.js";

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-sugg-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const a = store.upsertNode({ nodeType: "note", identityKey: "a.md", title: "A" });
  const b = store.upsertNode({ nodeType: "note", identityKey: "b.md", title: "B" });
  return { store, a, b };
}

test("suggested edge is pending, excluded from default graph, and shows in the queue", () => {
  const { store, a, b } = seed();
  const ev = store.suggestEdge({ src: a, dst: b, edgeType: "wikilink", confidence: 0.7 });

  // not in default traversal (unconfirmed AI assertion)
  assert.equal(exploreGraph(store, "backlinks", b).nodes.length, 0);
  // but in the suggestion queue
  const q = listSuggestions(store);
  assert.equal(q.length, 1);
  assert.equal(q[0].src, a);
  assert.equal(q[0].dst, b);
  assert.equal(q[0].suggestionEventId, ev.id);
  store.close();
});

test("accepting a suggestion makes the edge active (now traversable)", () => {
  const { store, a, b } = seed();
  const ev = store.suggestEdge({ src: a, dst: b, edgeType: "wikilink" });
  store.acceptSuggestion(ev.id);

  assert.equal(listSuggestions(store).length, 0); // left the queue
  const back = exploreGraph(store, "backlinks", b).nodes;
  assert.ok(back.some((n) => n.nodeId === a), "accepted edge now traversable");
  const edge = store.db.prepare("SELECT status, method FROM edges WHERE id=?").get(`edge_${ev.id}`);
  assert.equal(edge.status, "active");
  assert.equal(edge.method, "ASSERTED");
  store.close();
});

test("rejecting a suggestion drops it from queue and keeps it out of the graph", () => {
  const { store, a, b } = seed();
  const ev = store.suggestEdge({ src: a, dst: b, edgeType: "wikilink" });
  store.rejectSuggestion(ev.id);

  assert.equal(listSuggestions(store).length, 0);
  assert.equal(exploreGraph(store, "backlinks", b).nodes.length, 0);
  const edge = store.db.prepare("SELECT status FROM edges WHERE id=?").get(`edge_${ev.id}`);
  assert.equal(edge.status, "rejected");
  store.close();
});

test("suggestion flow survives a delete+replay rebuild (ledger-backed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-sugg2-"));
  const paths = { dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") };
  const s1 = KnowledgeStore.open(paths);
  const a = s1.upsertNode({ nodeType: "note", identityKey: "a.md", title: "A" });
  const b = s1.upsertNode({ nodeType: "note", identityKey: "b.md", title: "B" });
  const ev = s1.suggestEdge({ src: a, dst: b, edgeType: "wikilink" });
  s1.acceptSuggestion(ev.id);
  s1.close();

  // the suggestion+accept are ledger-backed → after deleting the db, replay
  // rematerializes the accepted edge with the same id/status.
  rmSync(paths.dbPath);
  rmSync(paths.dbPath + "-wal", { force: true });
  rmSync(paths.dbPath + "-shm", { force: true });
  const s2 = KnowledgeStore.open(paths);
  const edge = s2.db.prepare("SELECT status, method FROM edges WHERE id=?").get(`edge_${ev.id}`);
  assert.ok(edge, "edge rematerialized from ledger");
  assert.equal(edge.status, "active");
  s2.close();
});
