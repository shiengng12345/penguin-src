import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, embeddingSpaceIdentity, persistSemanticChunks, searchPersistedVectors } from "../packages/knowledge-core/dist/index.js";
import { activateEmbeddingGeneration, backfillEmbeddings } from "../packages/knowledge-indexer/dist/index.js";

test("vector result cannot cross repository or snapshot scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-vector-acl-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const text = new Map();
  for (const [repoId, snapshotId, file, blob] of [["repo-a", "snap-a", "a.ts", 1], ["repo-b", "snap-b", "b.ts", 2]]) {
    for (const chunk of persistSemanticChunks(store, { text: `${repoId} private`, sourceBlobId: blob, repoId, snapshotId, canonicalFilePath: file, chunkerVersion: "v1" })) text.set(chunk.id, chunk.text);
  }
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "acl", weightsDigest: "3".repeat(64), tokenizerDigest: "4".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  const provider = { id: "fixture", modelId: "acl", modelHash: space.identityHash, dimensions: 2, maxTokens: 100, async embed(values) { return values.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  const generation = await backfillEmbeddings({ store, provider, space, snapshotId: "snap-a", scopeKey: "repo:repo-a", chunkIds: [...text.keys()].filter((id) => text.get(id).includes("repo-a")), textLoader: (id) => text.get(id) });
  activateEmbeddingGeneration(store, generation.checkpoint.generationId);
  const result = await searchPersistedVectors({ store, provider, query: "private", scopes: [{ repoId: "repo-a", snapshotId: "snap-a" }], limit: 10 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].locator.repoId, "repo-a");
  assert.equal(result.hits[0].locator.filePath, "a.ts");
  store.close();
});
