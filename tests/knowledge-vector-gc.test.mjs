import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, VectorStore, createEmbeddingSpace, embeddingSpaceIdentity, persistSemanticChunks } from "../packages/knowledge-core/dist/index.js";

test("vector deletion removes the ref and both persisted vector representations", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-vector-gc-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const chunk = persistSemanticChunks(store, { text: "gc me", sourceBlobId: 1, repoId: "repo", snapshotId: "snapshot", canonicalFilePath: "gc.ts", chunkerVersion: "v1" })[0];
  const identity = embeddingSpaceIdentity({ providerId: "fixture", modelId: "gc", weightsDigest: "c".repeat(64), tokenizerDigest: "d".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  createEmbeddingSpace(store, identity);
  const provider = { id: "fixture", modelId: "gc", modelHash: identity.identityHash, dimensions: 2, maxTokens: 20, async embed() { return []; }, async health() { return { ok: true }; } };
  const vectors = new VectorStore(store);
  vectors.ensureModel(provider);
  const rowId = vectors.put(provider.modelHash, chunk.id, new Float32Array([1, 0]));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vector_values WHERE vec_rowid=?").get(rowId).n, 1);
  assert.equal(vectors.delete(provider.modelHash, chunk.id), true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs WHERE chunk_id=?").get(chunk.id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vector_values WHERE vec_rowid=?").get(rowId).n, 0);
  store.close();
});

test("garbage collection removes refs whose jobs were deleted and their vector rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-vector-gc-orphan-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const chunk = persistSemanticChunks(store, { text: "orphan me", sourceBlobId: 1, repoId: "repo", snapshotId: "snapshot", canonicalFilePath: "orphan.ts", chunkerVersion: "v1" })[0];
  const identity = embeddingSpaceIdentity({ providerId: "fixture", modelId: "gc-orphan", weightsDigest: "a".repeat(64), tokenizerDigest: "b".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  createEmbeddingSpace(store, identity);
  const provider = { id: "fixture", modelId: "gc-orphan", modelHash: identity.identityHash, dimensions: 2, maxTokens: 20, async embed() { return []; }, async health() { return { ok: true }; } };
  const vectors = new VectorStore(store);
  vectors.ensureModel(provider);
  vectors.put(provider.modelHash, chunk.id, new Float32Array([1, 0]));
  store.db.prepare("DELETE FROM semantic_embedding_refs WHERE model_hash=? AND chunk_id=?").run(provider.modelHash, chunk.id);
  const gc = vectors.garbageCollect(provider.modelHash);
  assert.deepEqual(gc, { refs: 0, vectors: 1 });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vector_values").get().n, 0);
  store.close();
});
