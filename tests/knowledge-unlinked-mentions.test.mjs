import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { createNote, findUnlinkedMentions, acceptUnlinkedMention } from "../packages/knowledge-indexer/dist/index.js";

test("unlinked mentions suggest titles/aliases outside code fences and accept with a content hash guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-unlinked-"));
  const notesDir = join(dir, "notes");
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  createNote({ store, notesDir, title: "Login Blacklist", body: "## Guard\nblocks risky login" });
  createNote({ store, notesDir, title: "Runbook", body: "The Login Blacklist protects this flow.\n\n```\nLogin Blacklist\n```\n" });
  const mentions = findUnlinkedMentions({ store, notesDir, limit: 20 });
  const mention = mentions.find((item) => item.candidate === "Login Blacklist");
  assert.ok(mention);
  assert.equal(mention.notePath, "runbook.md");
  assert.throws(() => acceptUnlinkedMention({ store, notesDir, mention, expectedContentHash: "wrong" }), /NOTE_CONTENT_HASH_MISMATCH/);
  acceptUnlinkedMention({ store, notesDir, mention });
  assert.equal(findUnlinkedMentions({ store, notesDir, limit: 20 }).some((item) => item.notePath === "runbook.md" && item.candidate === "Login Blacklist"), false);
  store.close();
});
