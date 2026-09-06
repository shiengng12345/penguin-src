import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EmbeddingLifecycle,
  KnowledgeStore,
  SourceStore,
  createEmbeddingSpace,
  embeddingSpaceIdentity,
  listSemanticStatuses,
  persistSemanticChunks,
} from "../packages/knowledge-core/dist/index.js";
import { drainSemanticQueue, enqueueSemanticGeneration } from "../packages/knowledge-indexer/dist/index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-fairness-"));
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const identity = embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "fairness",
    weightsDigest: "a".repeat(64),
    tokenizerDigest: "b".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "semantic-chunker-v1",
  });
  createEmbeddingSpace(store, identity);
  const provider = {
    id: "fixture",
    modelId: "fairness",
    modelHash: identity.identityHash,
    dimensions: 2,
    maxTokens: 128,
    async embedDocuments(values) { return values.map(() => new Float32Array([1, 0])); },
    async embed(values) { return values.map(() => new Float32Array([1, 0])); },
    async health() { return { ok: true }; },
  };
  return { store, identity, provider };
}

function chunks(store, repoId, snapshotId, count = 4) {
  const sources = new SourceStore(store);
  return Array.from({ length: count }, (_, index) => {
    const text = `${repoId}:${snapshotId}:${index} ` + "x".repeat(256);
    const rawBytes = Buffer.from(text);
    const sourceBlobId = sources.putBlob({
      contentHash: createHash("sha256").update(rawBytes).digest("hex"),
      rawBytes,
      decodedContent: text,
      encoding: "utf-8",
    });
    return persistSemanticChunks(store, {
      text,
      sourceBlobId,
      repoId,
      snapshotId,
      canonicalFilePath: `${repoId}/${snapshotId}-${index}.ts`,
      chunkerVersion: "semantic-chunker-v1",
      maxChars: 1_200,
    })[0];
  });
}

function enqueue(value, repoId, snapshotId, count = 4) {
  const rows = chunks(value.store, repoId, snapshotId, count);
  return enqueueSemanticGeneration({
    store: value.store,
    repoId,
    snapshotId,
    scopeKey: `repo:${repoId}`,
    space: value.identity,
    chunkIds: rows.map((row) => row.id),
  });
}

test("semantic claims remain quiesced for the durable full-reset fence", () => {
  const value = fixture();
  const generation = enqueue(value, "reset-fence", "snapshot-reset-fence", 1);
  const lifecycle = new EmbeddingLifecycle(value.store);
  const fencePath = `${value.store.db.name}.full-reset.lock`;
  const claim = () => lifecycle.claimJobs({
    ownerId: "reset-fence-worker",
    generationId: generation.generationId,
    limit: 1,
    now: "2026-09-01T00:00:00.000Z",
    leaseExpiresAt: "2026-09-01T00:01:00.000Z",
  });

  writeFileSync(fencePath, JSON.stringify({ operationId: "reset-fixture" }), { mode: 0o600 });
  assert.deepEqual(claim(), []);
  assert.equal(lifecycle.getGeneration(generation.generationId)?.status, "staging");
  assert.equal(value.store.db.prepare(
    "SELECT COUNT(*) AS count FROM embedding_jobs WHERE generation_id=? AND status='pending'",
  ).get(generation.generationId).count, 1);

  unlinkSync(fencePath);
  assert.equal(claim().length, 1);
});

test("semantic scheduler gives every eligible scope a turn and pause does not starve peers", async () => {
  const value = fixture();
  const generations = [
    enqueue(value, "fair-a", "snapshot-a"),
    enqueue(value, "fair-b", "snapshot-b"),
    enqueue(value, "fair-c", "snapshot-c"),
  ];

  const schedulerState = { completedBatches: 0 };
  await drainSemanticQueue({
    store: value.store,
    provider: value.provider,
    ownerId: "fairness-worker",
    batchSize: 1,
    schedulerState,
  });
  const firstRound = listSemanticStatuses(value.store);
  for (const generation of generations) {
    const status = firstRound.find((row) => row.generationId === generation.generationId);
    assert.equal(status?.ready, 1, `scope ${generation.generationId} did not receive its first turn`);
    assert.ok((status?.pending ?? 0) > 0);
  }

  new EmbeddingLifecycle(value.store).requestPause("repo:fair-b");
  await drainSemanticQueue({
    store: value.store,
    provider: value.provider,
    ownerId: "fairness-worker",
    batchSize: 1,
    schedulerState,
  });
  const pausedRound = listSemanticStatuses(value.store);
  assert.equal(pausedRound.find((row) => row.scopeKey === "repo:fair-b")?.state, "paused");
  assert.equal(pausedRound.find((row) => row.scopeKey === "repo:fair-a")?.ready, 2);
  assert.equal(pausedRound.find((row) => row.scopeKey === "repo:fair-c")?.ready, 2);

  new EmbeddingLifecycle(value.store).resumeScope("repo:fair-b");
  for (let round = 0; round < 4; round += 1) {
    await drainSemanticQueue({
      store: value.store,
      provider: value.provider,
      ownerId: "fairness-worker",
      batchSize: 1,
      schedulerState,
    });
  }
  const finished = listSemanticStatuses(value.store);
  for (const generation of generations) {
    const status = finished.find((row) => row.generationId === generation.generationId);
    assert.equal(status?.state, "active", `scope ${generation.generationId} was not drained after resume`);
    assert.equal(status?.ready, status?.expected);
  }
  assert.equal(schedulerState.completedBatches, 12, "scheduler accounting must include every fair batch");
  value.store.close();
});

test("a superseded semantic generation is explicit and its old jobs cannot remain eligible", () => {
  const value = fixture();
  const first = enqueue(value, "supersede-fair", "snapshot-old", 2);
  const second = enqueue(value, "supersede-fair", "snapshot-new", 2);
  const lifecycle = new EmbeddingLifecycle(value.store);
  assert.equal(second.supersededGenerations, 1);
  assert.equal(lifecycle.getGeneration(first.generationId)?.failureReason, "SUPERSEDED_BY_NEWER_SNAPSHOT");
  assert.equal(
    value.store.db.prepare(`
      SELECT COUNT(*) AS count FROM embedding_jobs j
      JOIN embedding_generations g ON g.id=j.generation_id
      WHERE g.id=? AND j.status IN ('pending','running')
    `).get(first.generationId).count,
    0,
  );
  const oldStatus = listSemanticStatuses(value.store).find((row) => row.generationId === first.generationId);
  const newStatus = listSemanticStatuses(value.store).find((row) => row.generationId === second.generationId);
  assert.equal(oldStatus?.state, "superseded");
  assert.equal(newStatus?.state, "queued");
  value.store.close();
});
