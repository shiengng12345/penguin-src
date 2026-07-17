import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, VectorStore, chunkSemanticText, inspectLocalModelDirectory, persistSemanticChunks, semanticSearch } from "../packages/knowledge-core/dist/index.js";

test("semantic chunks are deterministic and bounded with overlap", () => {
  const text = "# One\nalpha\n\n# Two\nbeta\n";
  const chunks = chunkSemanticText(text, 8, 2);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].id, chunkSemanticText(text, 8, 2)[0].id);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 8));
});

test("comments and docstrings form independent semantic chunks while persistence keeps symbol association", () => {
  const chunks = chunkSemanticText("// explains the parser\nfunction parse() { return true; }\n", 80, 8);
  assert.equal(chunks[0].chunkKind, "comment");
  const dir = mkdtempSync(join(tmpdir(), "pk-semantic-comment-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  persistSemanticChunks(store, { text: "// explains the parser\nfunction parse() { return true; }\n", nodeId: "symbol:parse" });
  assert.equal(store.db.prepare("SELECT node_id FROM semantic_chunks WHERE chunk_kind='comment' LIMIT 1").get().node_id, "symbol:parse");
  store.close();
});

test("sqlite fallback vector store keys models and ranks vectors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-vector-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const vectors = new VectorStore(store);
  const provider = { id: "fixture", modelId: "fixture-v1", modelHash: "a".repeat(64), dimensions: 2, maxTokens: 100, async embed() { return []; }, async health() { return { ok: true }; } };
  vectors.ensureModel(provider);
  vectors.put(provider.modelHash, "chunk-a", new Float32Array([1, 0]));
  vectors.put(provider.modelHash, "chunk-b", new Float32Array([0, 1]));
  assert.equal(vectors.search(provider.modelHash, new Float32Array([1, 0]), 1)[0].chunkId, "chunk-a");
  const health = vectors.health(provider.modelHash);
  assert.ok(["sqlite-fallback", "sqlite-vec"].includes(health.backend));
  const doctor = vectors.doctor(provider.modelHash, { sampleQuery: new Float32Array([1, 0]) });
  assert.equal(doctor.degraded, health.backend !== "sqlite-vec");
  if (health.backend === "sqlite-vec") assert.equal(vectors.doctor(provider.modelHash, { semanticRequired: true, sampleQuery: new Float32Array([1, 0]) }).ok, true);
  else assert.throws(() => vectors.doctor(provider.modelHash, { semanticRequired: true }), /SEMANTIC_EXTENSION_REQUIRED/);
  store.close();
});

test("semantic chunks persist content hashes and byte locators and replace changed source", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-semantic-chunks-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const first = persistSemanticChunks(store, { text: "# 标题\n\nalpha needle\nsecond", sourceBlobId: 1, maxChars: 12, overlap: 2 });
  assert.ok(first.length > 0);
  const row = store.db.prepare("SELECT content_hash,start_byte,end_byte,chunk_kind FROM semantic_chunks WHERE id=?").get(first[0].id);
  assert.equal(row.content_hash, first[0].contentHash);
  assert.equal(typeof row.start_byte, "number");
  const second = persistSemanticChunks(store, { text: "changed content", sourceBlobId: 1, maxChars: 12, overlap: 2 });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_chunks WHERE source_blob_id=1").get().n, second.length);
  store.close();
});

test("semantic query embedding cache is keyed by model hash and normalized query", async () => {
  let calls = 0;
  const provider = { id: "cache-test", modelId: "cache-v1", modelHash: "b".repeat(64), dimensions: 2, maxTokens: 100, async embed(texts) { calls += 1; return texts.map((_, index) => new Float32Array(index === 0 ? [1, 0] : [0, 1])); }, async health() { return { ok: true }; } };
  await semanticSearch(provider, "  same   query ", [{ id: "a", text: "alpha", locator: {} }]);
  await semanticSearch(provider, "same query", [{ id: "a", text: "alpha", locator: {} }]);
  assert.equal(calls, 2);
});

test("semantic provider never receives high-confidence secret tokens from document text", async () => {
  const seen = [];
  const provider = { id: "redaction-test", modelId: "redaction-v1", modelHash: "c".repeat(64), dimensions: 2, maxTokens: 100, async embed(texts) { seen.push(...texts); return texts.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  await semanticSearch(provider, "find secret", [{ id: "secret", text: "api_key=abcdefghijklmnop", locator: {} }]);
  assert.equal(seen.some((text) => text.includes("abcdefghijklmnop")), false);
  assert.ok(seen.some((text) => text.includes("REDACTED_SECRET")));
});

test("local semantic model requires an explicit directory and verified file hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-local-model-"));
  const model = Buffer.from("deterministic model fixture", "utf8");
  const hash = createHash("sha256").update(model).digest("hex");
  writeFileSync(join(dir, "model.bin"), model);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ modelId: "fixture-v1", modelFile: "model.bin", sha256: hash, dimensions: 2, maxTokens: 128 }));
  const descriptor = inspectLocalModelDirectory(dir);
  assert.equal(descriptor.modelHash, hash);
  assert.equal(descriptor.dimensions, 2);
  writeFileSync(join(dir, "model.bin"), Buffer.from("changed", "utf8"));
  assert.throws(() => inspectLocalModelDirectory(dir), /LOCAL_MODEL_HASH_MISMATCH/);
});
