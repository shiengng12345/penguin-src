import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { createNote, writeNoteBody, appendNote } from "../packages/knowledge-indexer/dist/index.js";

test("note writes preserve frontmatter, use the hash guard, and round-trip atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-note-atomic-"));
  const notesDir = join(dir, "notes");
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const note = createNote({ store, notesDir, title: "Atomic", body: "before", frontmatter: { owner: "team-a", custom_key: "preserve" } });
  const before = readFileSync(note.path, "utf8");
  assert.throws(() => writeNoteBody({ store, notesDir, slug: note.slug, body: "blocked", expectedContentHash: "wrong" }), /NOTE_CONTENT_HASH_MISMATCH/);
  writeNoteBody({ store, notesDir, slug: note.slug, body: "after", expectedContentHash: createHash("sha256").update(before).digest("hex") });
  appendNote({ store, notesDir, slug: note.slug, text: "tail" });
  const source = readFileSync(note.path, "utf8");
  assert.match(source, /owner: team-a/);
  assert.match(source, /custom_key: preserve/);
  assert.match(source, /after/);
  assert.match(source, /tail/);
  store.close();
});
