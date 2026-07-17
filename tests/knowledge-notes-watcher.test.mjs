import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { createNote, startNotesWatcher } from "../packages/knowledge-indexer/dist/index.js";

test("external Obsidian Markdown edits are reindexed without rewriting the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-notes-watch-"));
  const notesDir = join(dir, "notes");
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  createNote({ store, notesDir, title: "External Note", body: "before" });
  const reports = [];
  const watcher = startNotesWatcher({ store, notesDir, debounceMs: 30, onReindexed: (report) => reports.push(report) });
  try {
    writeFileSync(join(notesDir, "external-note.md"), "---\nid: external-note\ntitle: External Note\n---\n\nafter-from-obsidian\n");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !store.searchText("after-from-obsidian").length) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(store.searchText("after-from-obsidian").length > 0);
    assert.ok(reports.length > 0);
    assert.equal(watcher.status().watching, true);
  } finally {
    watcher.close();
    assert.equal(watcher.status().watching, false);
    store.close();
  }
});
