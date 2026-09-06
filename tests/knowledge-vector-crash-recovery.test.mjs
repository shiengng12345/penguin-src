import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, EmbeddingLifecycle, createEmbeddingSpace, embeddingSpaceIdentity, persistSemanticChunks } from "../packages/knowledge-core/dist/index.js";
import { recoverEmbeddingWorker } from "../packages/knowledge-indexer/dist/index.js";

test("a killed worker's expired lease is reclaimed without touching live work", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-vector-recovery-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const chunk = persistSemanticChunks(store, { text: "recover me", sourceBlobId: 1, repoId: "repo", snapshotId: "snapshot", canonicalFilePath: "recover.ts", chunkerVersion: "v1" })[0];
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "recovery", weightsDigest: "e".repeat(64), tokenizerDigest: "f".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" });
  const spaceRow = createEmbeddingSpace(store, space);
  const lifecycle = new EmbeddingLifecycle(store);
  const generation = lifecycle.createGeneration({ spaceId: spaceRow.id, snapshotId: "snapshot", scopeKey: "repo:repo", expectedChunks: 1 });
  const job = lifecycle.createJob({ generationId: generation.id, chunkId: chunk.id });
  lifecycle.claimJobs({
    ownerId: "killed-worker",
    generationId: generation.id,
    limit: 1,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  });
  assert.equal(recoverEmbeddingWorker(store, generation.id, "2026-08-31T08:00:30.000Z"), 0);
  assert.equal(recoverEmbeddingWorker(store, generation.id, "2026-08-31T08:02:00.000Z"), 1);
  const recovered = store.db.prepare("SELECT status,error,lease_owner AS leaseOwner FROM embedding_jobs WHERE id=?").get(job.id);
  assert.deepEqual(recovered, { status: "pending", error: "EMBEDDING_WORKER_LEASE_EXPIRED", leaseOwner: null });
  store.close();
});
