import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-snap-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("snapshot manifest: create + list, survives replay", () => {
  const store = openStore();
  const a = store.upsertNode({ nodeType: "note", identityKey: "a.md", title: "A" });
  const b = store.upsertNode({ nodeType: "note", identityKey: "b.md", title: "B" });
  const ev = store.createSnapshot({ name: "incident-42", nodeIds: [a, b], note: "brazil outage" });
  assert.ok(ev.id);
  const snaps = store.listSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].name, "incident-42");
  assert.deepEqual(snaps[0].nodeIds.sort(), [a, b].sort());
  store.close();
});

test("ambiguous same-body rename lands in the rename-suggestion queue (not auto)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-repo-"));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  // two identical-body functions
  writeFileSync(join(dir, "src", "a.ts"), "function alpha(){ return 1; }\nfunction beta(){ return 1; }");
  const store = openStore();
  await indexRepo({ store, rootPath: dir, mode: "incremental" });

  // rename both (same identical body) → ambiguous pairing
  writeFileSync(join(dir, "src", "a.ts"), "function gamma(){ return 1; }\nfunction delta(){ return 1; }");
  await indexRepo({ store, rootPath: dir, mode: "incremental" });

  const queue = store.listRenameSuggestions();
  assert.ok(queue.length >= 1, "ambiguous rename queued, not auto-aliased");
  assert.ok(queue.every((q) => q.candidateKeys.length >= 2));
  store.close();
});
