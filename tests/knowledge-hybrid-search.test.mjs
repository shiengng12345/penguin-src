import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, embeddingSpaceIdentity, persistSemanticChunks, searchPersistedVectors, fuseHybridHits } from "../packages/knowledge-core/dist/index.js";
import { activateEmbeddingGeneration, backfillEmbeddings } from "../packages/knowledge-indexer/dist/index.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-hybrid-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const texts = new Map();
  const chunks = persistSemanticChunks(store, { text: "alpha business concept", sourceBlobId: 1, repoId: "repo-a", snapshotId: "snap-a", canonicalFilePath: "src/a.ts", chunkerVersion: "v1" });
  for (const chunk of chunks) texts.set(chunk.id, chunk.text);
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "hybrid", weightsDigest: "1".repeat(64), tokenizerDigest: "2".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  let calls = 0;
  const provider = { id: "fixture", modelId: "hybrid", modelHash: space.identityHash, dimensions: 2, maxTokens: 100, async embed(values) { calls += 1; return values.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  const backfill = await backfillEmbeddings({ store, provider, space, snapshotId: "snap-a", scopeKey: "repo:repo-a", textLoader: (id) => texts.get(id) });
  activateEmbeddingGeneration(store, backfill.checkpoint.generationId);
  calls = 0;
  return { store, provider, calls: () => calls };
}

test("persisted hybrid vector lane embeds only the query and enforces active scope", async () => {
  const { store, provider, calls } = await fixture();
  const result = await searchPersistedVectors({ store, provider, query: "meaning", scopes: [{ repoId: "repo-a", snapshotId: "snap-a" }], limit: 10 });
  assert.equal(calls(), 1);
  assert.equal(result.queryEmbeddings, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].lane, "vector");
  assert.equal(result.hits[0].locator.repoId, "repo-a");
  assert.equal(result.hits[0].evidence[0].status, "inference");
  const denied = await searchPersistedVectors({ store, provider, query: "meaning", scopes: [{ repoId: "repo-other", snapshotId: "snap-other" }], limit: 10 });
  assert.deepEqual(denied.hits, []);
  store.close();
});

test("persisted vector search uses the query embedding role when the provider exposes it", async () => {
  const { store, provider } = await fixture();
  let queryCalls = 0;
  const roleAwareProvider = {
    ...provider,
    async embed() {
      throw new Error("GENERIC_EMBED_MUST_NOT_HANDLE_QUERIES");
    },
    async embedQuery(value) {
      queryCalls += 1;
      assert.equal(value, "meaning");
      return new Float32Array([1, 0]);
    },
  };

  const result = await searchPersistedVectors({
    store,
    provider: roleAwareProvider,
    query: "meaning",
    scopes: [{ repoId: "repo-a", snapshotId: "snap-a" }],
    limit: 10,
  });

  assert.equal(queryCalls, 1);
  assert.equal(result.queryEmbeddings, 1);
  assert.equal(result.hits.length, 1);
  store.close();
});

test("persisted vector search uses bounded code-token affinity to diversify natural-language code queries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-hybrid-code-token-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const texts = new Map();
  for (const [sourceBlobId, path, text] of [
    [1, "src/provider.ts", "export function provideUser() { return null; }"],
    [2, "src/users-grpc.controller.ts", "class UsersGrpcController { @GrpcMethod() getUser() {} }"],
  ]) {
    for (const chunk of persistSemanticChunks(store, { text, sourceBlobId, repoId: "repo-a", snapshotId: "snap-a", canonicalFilePath: path, chunkerVersion: "v1" })) texts.set(chunk.id, chunk.text);
  }
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "hybrid-code", weightsDigest: "3".repeat(64), tokenizerDigest: "4".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  const provider = { id: "fixture", modelId: "hybrid-code", modelHash: space.identityHash, dimensions: 2, maxTokens: 100, async embed(values) { return values.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  const backfill = await backfillEmbeddings({ store, provider, space, snapshotId: "snap-a", scopeKey: "repo:repo-a", textLoader: (id) => texts.get(id) });
  activateEmbeddingGeneration(store, backfill.checkpoint.generationId);

  const result = await searchPersistedVectors({ store, provider, query: "Which RPC user endpoint owns this request?", scopes: [{ repoId: "repo-a", snapshotId: "snap-a" }], limit: 2 });

  assert.equal(result.hits[0].locator.filePath, "src/users-grpc.controller.ts");
  assert.ok(result.hits[0].rankReasons.some((reason) => reason.includes("code-token affinity")));
  assert.match(result.hits[0].rankReasons[0], /^persisted vector similarity /);
  store.close();
});

test("semantic reranking canonicalizes natural-language concepts and uses a distinctive path tie-breaker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-hybrid-path-rerank-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const texts = new Map();
  for (const [sourceBlobId, path, text] of [
    [1, "src/graph-evidence.ts", "export const edgeEvidence = true;"],
    [2, "src/unrelated.ts", "export const helper = true;"],
  ]) {
    for (const chunk of persistSemanticChunks(store, { text, sourceBlobId, repoId: "repo-a", snapshotId: "snap-a", canonicalFilePath: path, chunkerVersion: "v1" })) texts.set(chunk.id, chunk.text);
  }
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "hybrid-path-rerank", weightsDigest: "5".repeat(64), tokenizerDigest: "6".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  const provider = { id: "fixture", modelId: "hybrid-path-rerank", modelHash: space.identityHash, dimensions: 2, maxTokens: 100, async embed(values) { return values.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  const backfill = await backfillEmbeddings({ store, provider, space, snapshotId: "snap-a", scopeKey: "repo:repo-a", textLoader: (id) => texts.get(id) });
  activateEmbeddingGeneration(store, backfill.checkpoint.generationId);

  const result = await searchPersistedVectors({
    store,
    provider,
    query: "Where is authoritative call relationship information kept?",
    scopes: [{ repoId: "repo-a", snapshotId: "snap-a" }],
    limit: 2,
  });

  assert.equal(result.hits[0].locator.filePath, "src/graph-evidence.ts");
  assert.ok(result.hits[0].rankReasons.includes("distinctive path affinity used for bounded candidate reranking"));
  store.close();
});

test("persisted vector search hydrates an over-fetched candidate page in one source query", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-hybrid-bulk-hydration-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const texts = new Map();
  const chunks = [];
  for (let index = 0; index < 70; index += 1) {
    const row = persistSemanticChunks(store, {
      text: `bulk candidate ${index}`,
      sourceBlobId: index + 1,
      repoId: "repo-a",
      snapshotId: "snap-a",
      canonicalFilePath: `src/bulk-${index}.ts`,
      chunkerVersion: "v1",
    })[0];
    chunks.push(row);
    texts.set(row.id, row.text);
  }
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "bulk-hydration", weightsDigest: "6".repeat(64), tokenizerDigest: "7".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  const provider = { id: "fixture", modelId: "bulk-hydration", modelHash: space.identityHash, dimensions: 2, maxTokens: 100, async embed(values) { return values.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  const backfill = await backfillEmbeddings({ store, provider, space, snapshotId: "snap-a", scopeKey: "repo:repo-a", textLoader: (id) => texts.get(id) });
  activateEmbeddingGeneration(store, backfill.checkpoint.generationId);

  const originalPrepare = store.db.prepare.bind(store.db);
  let hydrationQueries = 0;
  store.db.prepare = (sql, ...args) => {
    if (String(sql).includes("LEFT JOIN source_blobs b") && String(sql).includes("c.id IN (")) hydrationQueries += 1;
    return originalPrepare(sql, ...args);
  };
  const result = await searchPersistedVectors({ store, provider, query: "bulk candidate", scopes: [{ repoId: "repo-a", snapshotId: "snap-a" }], limit: 50 });

  assert.equal(result.hits.length, 50);
  assert.equal(hydrationQueries, 1);
  store.db.prepare = originalPrepare;
  store.close();
});

test("hybrid fusion pins deterministic hits and applies deterministic RRF", () => {
  const locator = { repoId: "repo", repoName: "Repo", revisionId: "snap", revisionKind: "commit", filePath: "a.ts" };
  const deterministic = [{ hitId: "exact", kind: "source_occurrence", lane: "source", title: "a.ts", locator, score: 1, rankReasons: ["exact"], evidence: [] }];
  const vectors = [{ hitId: "vector", kind: "source_occurrence", lane: "vector", title: "b.ts", locator: { ...locator, filePath: "b.ts" }, score: 0.99, rankReasons: ["vector"], evidence: [] }];
  const fused = fuseHybridHits(deterministic, vectors, { rrfK: 60, lexicalLimit: 10, vectorLimit: 10, exactPin: true, rankerVersion: "test" });
  assert.deepEqual(fused.map((hit) => hit.hitId), ["exact", "vector"]);
  assert.ok(fused[0].rankReasons.some((reason) => reason.includes("rrf(60)")));
  assert.deepEqual(fused[0].retrievalProvenance.lanes, [{ lane: "source", rank: 1, score: 1 }]);
  assert.deepEqual(fused[1].retrievalProvenance.lanes, [{ lane: "vector", rank: 1, score: 0.99 }]);
  assert.equal(typeof fused[0].retrievalProvenance.retrievalFingerprint, "string");
  assert.equal(typeof fused[1].retrievalProvenance.retrievalFingerprint, "string");
});
