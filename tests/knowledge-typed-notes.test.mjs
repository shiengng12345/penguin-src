import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, getNodeDetail } from "../packages/knowledge-core/dist/index.js";
import { createNote, createIncident } from "../packages/knowledge-indexer/dist/index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pk-tn-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  return { store, notesDir: join(dir, "notes") };
}

test("createNote with type/status → getNodeDetail surfaces note metadata (Phase 3)", () => {
  const { store, notesDir } = setup();
  const r = createNote({ store, notesDir, title: "Brazil KYC Rule", frontmatter: { type: "compliance", status: "active", owner: "shieng" } });
  const d = getNodeDetail(store, r.nodeId);
  assert.ok(d.note, "note metadata present");
  assert.equal(d.note.type, "compliance");
  assert.equal(d.note.status, "active");
  assert.equal(d.note.owner, "shieng");
  store.close();
});

test("createIncident → typed incident note with structured body (Phase 4)", () => {
  const { store, notesDir } = setup();
  const r = createIncident({ store, notesDir, title: "Redis ClusterAllFailedError", fields: { service: "auth", environment: "UAT" } });
  const d = getNodeDetail(store, r.nodeId);
  assert.equal(d.note.type, "incident");
  assert.equal(d.note.status, "open");
  assert.match(d.body, /Root cause/);
  assert.match(d.body, /Retest/);
  store.close();
});

test("plain note has type 'note' (no frontmatter type)", () => {
  const { store, notesDir } = setup();
  const r = createNote({ store, notesDir, title: "Scratch" });
  assert.equal(getNodeDetail(store, r.nodeId).note.type, "note");
  store.close();
});
