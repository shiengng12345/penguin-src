import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  SourceStore,
  setTrigramLane,
  pruneTrigramLane,
  trigramLaneEnabled,
  trigramLaneStatus,
} from "../packages/knowledge-core/dist/index.js";

// The trigram lane is a pure accelerator (~1.1GB for one feature): off must
// mean SLOWER literal search (bounded scan), never missing/wrong results.

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-trigram-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

const blobInput = (text) => ({
  contentHash: `hash-${text.length}-${text.slice(0, 8)}`,
  rawBytes: new TextEncoder().encode(text),
  decodedContent: text,
  encoding: "utf-8",
});

test("new DB defaults to lane OFF and writes no trigram rows", () => {
  const store = openStore();
  assert.equal(trigramLaneEnabled(store), false);
  const sources = new SourceStore(store);
  sources.putBlob(blobInput("const paymentGateway = charge(amount);"));
  assert.equal(trigramLaneStatus(store).rows, 0);
  store.close();
});

test("explicit ON writes trigrams; OFF stops writing; prune clears", () => {
  const store = openStore();
  setTrigramLane(store, true);
  const sources = new SourceStore(store);
  sources.putBlob(blobInput("function alpha() { return beta(); }"));
  const withLane = trigramLaneStatus(store);
  assert.equal(withLane.enabled, true);
  assert.ok(withLane.rows > 0, "trigrams written while on");

  setTrigramLane(store, false);
  sources.putBlob(blobInput("function gamma() { return delta(); }"));
  assert.equal(trigramLaneStatus(store).rows, withLane.rows, "no new rows while off");

  const pruned = pruneTrigramLane(store);
  assert.equal(pruned, withLane.rows);
  assert.equal(trigramLaneStatus(store).rows, 0);
  store.close();
});

test("implicit default: existing trigram rows keep the lane ON (no silent slowdown)", () => {
  const store = openStore();
  setTrigramLane(store, true);
  new SourceStore(store).putBlob(blobInput("legacy corpus with trigrams"));
  // Simulate a pre-flag DB: remove the explicit meta value.
  store.db.prepare("DELETE FROM meta WHERE key='source_trigram_lane'").run();
  assert.equal(trigramLaneEnabled(store), true, "rows present → implicit on");
  store.close();
});
