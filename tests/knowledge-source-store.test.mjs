import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, SourceStore } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-source-store-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

test("SourceStore deduplicates content-addressed blobs and indexes source facts atomically", () => {
  const store = openStore();
  const sourceStore = new SourceStore(store);
  const raw = Buffer.from("export const uniqueSourceNeedle = true;\n", "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const first = sourceStore.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString("utf8"), encoding: "utf8" });
  const second = sourceStore.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString("utf8"), encoding: "utf8" });
  assert.equal(first, second);
  const factId = sourceStore.putSourceFact({
    repoId: "repo-1",
    filePath: "src/fixture.ts",
    factFingerprint: "fact-1",
    contentHash: hash,
    sourceBlobId: first,
    coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" },
  });
  assert.equal(typeof factId, "string");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_fts").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_path_fts").get().n, 1);
  store.close();
});

test("SourceStore rejects a content-hash collision instead of reusing corrupted bytes", () => {
  const store = openStore();
  const sourceStore = new SourceStore(store);
  const hash = "a".repeat(64);
  sourceStore.putBlob({ contentHash: hash, rawBytes: Buffer.from("first"), decodedContent: "first", encoding: "utf8" });
  assert.throws(() => sourceStore.putBlob({ contentHash: hash, rawBytes: Buffer.from("different"), decodedContent: "different", encoding: "utf8" }), /CONTENT_HASH_COLLISION/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n, 1);
  store.close();
});
