import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("semantic chunks group contiguous code instead of embedding every source line", () => {
  const text = Array.from(
    { length: 120 },
    (_, index) => `export const value${index} = ${index};\n\n`,
  ).join("");
  const chunks = chunkSemanticText(text, 1200, 180);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.length <= 12, `expected bounded code windows, received ${chunks.length}`);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1200));
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

test("vector store persists a batch atomically through the same public path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-vector-batch-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const vectors = new VectorStore(store);
  const provider = { id: "fixture", modelId: "fixture-v1", modelHash: "d".repeat(64), dimensions: 2, maxTokens: 100, async embed() { return []; }, async health() { return { ok: true }; } };
  vectors.ensureModel(provider);
  const rowIds = vectors.putBatch(provider.modelHash, [
    { chunkId: "chunk-a", vector: new Float32Array([1, 0]) },
    { chunkId: "chunk-b", vector: new Float32Array([0, 1]) },
  ]);
  assert.equal(rowIds.length, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs WHERE model_hash=? AND status='ready'").get(provider.modelHash).n, 2);
  assert.equal(vectors.search(provider.modelHash, new Float32Array([0, 1]), 1)[0].chunkId, "chunk-b");
  store.close();
});

test("generation-scoped vectors use a partitioned vec0 table and remain searchable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-vector-generation-partition-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const vectors = new VectorStore(store);
  const provider = { id: "fixture", modelId: "fixture-partition-v1", modelHash: "e".repeat(64), dimensions: 2, maxTokens: 100, async embed() { return []; }, async health() { return { ok: true }; } };
  vectors.ensureModel(provider);
  const generationId = "generation-partitioned-1";
  store.db.prepare("INSERT INTO embedding_generations(id,space_id,snapshot_id,scope_key,status,expected_chunks,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(generationId, "space-partitioned", "snapshot-partitioned", "repo:partitioned", "staging", 2, new Date().toISOString());
  vectors.putBatch(provider.modelHash, [
    { chunkId: "partition-a", vector: new Float32Array([1, 0]) },
    { chunkId: "partition-b", vector: new Float32Array([0, 1]) },
  ], { generationId, spaceId: "space-partitioned" });
  const partition = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_%_g%' AND sql LIKE '%USING vec0%' LIMIT 1").get();
  assert.ok(partition?.name, "generation writes must create a dedicated vec0 table");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vector_values WHERE vector_table_name=?").get(partition.name).n, 2);
  const hits = vectors.search(provider.modelHash, new Float32Array([1, 0]), 1, { generationId });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkId, "partition-a");
  assert.equal(hits[0].generationId, generationId);
  vectors.delete(provider.modelHash, "partition-a");
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${partition.name}`).get().n, 1);
  store.close();
});

test("legacy global vectors remain deletable after generation partition migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-vector-legacy-global-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const vectors = new VectorStore(store);
  const provider = { id: "fixture", modelId: "fixture-legacy-v1", modelHash: "f".repeat(64), dimensions: 2, maxTokens: 100, async embed() { return []; }, async health() { return { ok: true }; } };
  vectors.ensureModel(provider);
  const [vecRowId] = vectors.putBatch(provider.modelHash, [
    { chunkId: "legacy-chunk", vector: new Float32Array([1, 0]) },
  ]);

  // Simulate a pre-partition database after the schema adds vector_table_name:
  // the ref has a generation but the physical vector is still in global vec0.
  store.db.prepare("UPDATE semantic_vector_values SET vector_table_name=NULL WHERE vec_rowid=?").run(vecRowId);
  store.db.prepare("UPDATE semantic_embedding_refs SET generation_id=? WHERE model_hash=? AND chunk_id=?")
    .run("legacy-generation", provider.modelHash, "legacy-chunk");
  assert.equal(vectors.delete(provider.modelHash, "legacy-chunk"), true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs WHERE model_hash=?").get(provider.modelHash).n, 0);
  if (vectors.health(provider.modelHash).backend === "sqlite-vec") {
    const table = `vec_${provider.modelHash.slice(0, 16)}`;
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE rowid=?`).get(vecRowId).n, 0);
  }
  store.close();
});

test("sqlite-vec materializes nearest neighbours before metadata joins", () => {
  const source = readFileSync(
    new URL("../packages/knowledge-core/src/vector-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /WITH nearest AS MATERIALIZED[\s\S]*FROM \$\{tableName\}[\s\S]*FROM nearest JOIN semantic_embedding_refs/,
    "joining refs before the vec0 top-K scan makes SQLite execute the KNN scan once per ref",
  );
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
