import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
  recordSemanticProgressSample,
} from "../packages/knowledge-core/dist/index.js";
import { drainSemanticQueue, enqueueSemanticGeneration } from "../packages/knowledge-indexer/dist/index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-performance-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const identity = embeddingSpaceIdentity({
    providerId: "fixture", modelId: "performance", weightsDigest: "a".repeat(64), tokenizerDigest: "b".repeat(64),
    dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "semantic-chunker-v1",
  });
  const space = createEmbeddingSpace(store, identity);
  const provider = {
    id: "fixture", modelId: "performance", modelHash: identity.identityHash, dimensions: 2, maxTokens: 8_192,
    async embedDocuments(texts) { return texts.map(() => new Float32Array([1, 0])); },
    async embed(texts) { return texts.map(() => new Float32Array([1, 0])); },
    async health() { return { ok: true }; },
  };
  return { store, identity, space, provider };
}

function chunks(store, snapshotId, count, bytes) {
  const sources = new SourceStore(store);
  return Array.from({ length: count }, (_, index) => {
    const text = `${index}:` + "x".repeat(bytes);
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
      repoId: snapshotId,
      snapshotId,
      canonicalFilePath: `${snapshotId}-${index}.ts`,
      chunkerVersion: "semantic-chunker-v1",
      maxChars: Math.max(1_200, bytes + 32),
    })[0];
  });
}

test("adaptive scheduler keeps short batches bounded and reduces long batches", () => {
  const value = fixture();
  const lifecycle = new EmbeddingLifecycle(value.store);
  const short = chunks(value.store, "short", 40, 256);
  const long = chunks(value.store, "long", 40, 32_000);
  const create = (snapshotId, rows) => {
    const generation = lifecycle.createGeneration({ spaceId: value.space.id, snapshotId, scopeKey: `repo:${snapshotId}`, expectedChunks: rows.length });
    for (const row of rows) lifecycle.createJob({ generationId: generation.id, chunkId: row.id });
    return generation;
  };
  const shortGeneration = create("short", short);
  const longGeneration = create("long", long);
  const claim = (generationId, ownerId) => lifecycle.claimJobs({
    ownerId, generationId, limit: 32, minimumBatchSize: 1, paddingBudgetBytes: 32 * 4_096,
    now: "2026-08-31T08:00:00.000Z", leaseExpiresAt: "2026-08-31T08:02:00.000Z",
  });
  const shortBatch = claim(shortGeneration.id, "short-worker");
  const longBatch = claim(longGeneration.id, "long-worker");
  assert.ok(shortBatch.length > longBatch.length, `${shortBatch.length} short vs ${longBatch.length} long`);
  assert.ok(shortBatch.length <= 32 && longBatch.length >= 1);
  value.store.close();
});

test("one drain pass gives every queued scope a turn", async () => {
  const value = fixture();
  const large = chunks(value.store, "large", 40, 300);
  const small = chunks(value.store, "small", 2, 300);
  const largeGeneration = enqueueSemanticGeneration({ store: value.store, repoId: "large", snapshotId: "large", scopeKey: "repo:large", space: value.identity, chunkIds: large.map((row) => row.id) });
  const smallGeneration = enqueueSemanticGeneration({ store: value.store, repoId: "small", snapshotId: "small", scopeKey: "repo:small", space: value.identity, chunkIds: small.map((row) => row.id) });
  await drainSemanticQueue({ store: value.store, provider: value.provider, ownerId: "fair-worker", batchSize: 8 });
  const ready = value.store.db.prepare("SELECT generation_id AS generationId,COUNT(*) AS n FROM embedding_jobs WHERE status='ready' GROUP BY generation_id").all();
  assert.ok(ready.find((row) => row.generationId === largeGeneration.generationId)?.n > 0);
  assert.equal(ready.find((row) => row.generationId === smallGeneration.generationId)?.n, 2);
  assert.ok(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='pending'").get(largeGeneration.generationId).n > 0);
  assert.equal(value.store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(smallGeneration.generationId).status, "active");
  value.store.close();
});

test("new staging generations are scheduled before older active partial fallbacks", async () => {
  const value = fixture();
  const activeRows = chunks(value.store, "old-active", 2, 300);
  const stagingRows = chunks(value.store, "new-staging", 2, 300);
  const active = enqueueSemanticGeneration({
    store: value.store,
    repoId: "old-active",
    snapshotId: "old-active",
    scopeKey: "repo:old-active",
    space: value.identity,
    chunkIds: activeRows.map((row) => row.id),
  });
  value.store.db.prepare("UPDATE embedding_generations SET status='active' WHERE id=?").run(active.generationId);
  const staging = enqueueSemanticGeneration({
    store: value.store,
    repoId: "new-staging",
    snapshotId: "new-staging",
    scopeKey: "repo:new-staging",
    space: value.identity,
    chunkIds: stagingRows.map((row) => row.id),
  });
  const calls = [];
  const provider = {
    ...value.provider,
    async embedDocuments(texts) {
      calls.push(texts[0]);
      return texts.map(() => new Float32Array([1, 0]));
    },
  };

  await drainSemanticQueue({
    store: value.store,
    provider,
    ownerId: "staging-priority-worker",
    batchSize: 1,
    maxBatchesPerRound: 1,
  });

  assert.match(calls[0], /new-staging/u);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='ready'").get(staging.generationId).n, 1);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='ready'").get(active.generationId).n, 1);
  value.store.close();
});

test("a drain round can process a bounded number of batches per scope", async () => {
  const value = fixture();
  const rows = chunks(value.store, "multi-batch", 10, 300);
  const generation = enqueueSemanticGeneration({
    store: value.store,
    repoId: "multi-batch",
    snapshotId: "multi-batch",
    scopeKey: "repo:multi-batch",
    space: value.identity,
    chunkIds: rows.map((row) => row.id),
  });

  await drainSemanticQueue({
    store: value.store,
    provider: value.provider,
    ownerId: "multi-batch-worker",
    batchSize: 2,
    maxBatchesPerRound: 3,
  });

  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='ready'").get(generation.generationId).n, 6);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='pending'").get(generation.generationId).n, 4);
  value.store.close();
});

test("a poison chunk does not fail its healthy neighbors", async () => {
  const value = fixture();
  const rows = chunks(value.store, "isolation", 4, 300);
  const poison = rows[2];
  value.store.db.prepare("UPDATE source_blobs SET decoded_content=? WHERE id=(SELECT source_blob_id FROM semantic_chunks WHERE id=?)").run("poison chunk", poison.id);
  enqueueSemanticGeneration({
    store: value.store,
    repoId: "isolation",
    snapshotId: "isolation",
    scopeKey: "repo:isolation",
    space: value.identity,
    chunkIds: rows.map((row) => row.id),
  });
  const provider = {
    ...value.provider,
    async embedDocuments(texts) {
      if (texts.some((text) => text.includes("poison chunk"))) throw new Error("POISON_CHUNK");
      return texts.map(() => new Float32Array([1, 0]));
    },
  };

  await drainSemanticQueue({ store: value.store, provider, ownerId: "isolation-worker", batchSize: 4 });

  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='ready'").get().n, 3);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='failed'").get().n, 1);
  assert.equal(value.store.db.prepare("SELECT attempts FROM embedding_jobs WHERE chunk_id=?").get(poison.id).attempts, 1);
  value.store.close();
});

test("a bounded bootstrap lane becomes queryable while the worker keeps draining", async () => {
  const value = fixture();
  const rows = chunks(value.store, "bootstrap", 8, 300);
  const generation = enqueueSemanticGeneration({
    store: value.store,
    repoId: "bootstrap",
    snapshotId: "bootstrap",
    scopeKey: "repo:bootstrap",
    space: value.identity,
    chunkIds: rows.map((row) => row.id),
  });

  const first = await drainSemanticQueue({
    store: value.store,
    provider: value.provider,
    ownerId: "bootstrap-worker",
    batchSize: 2,
    bootstrapReadyChunks: 2,
  });
  assert.equal(first.activated, 1);
  assert.equal(value.store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(generation.generationId).status, "active");
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='ready'").get(generation.generationId).n, 2);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='pending'").get(generation.generationId).n, 6);

  const second = await drainSemanticQueue({
    store: value.store,
    provider: value.provider,
    ownerId: "bootstrap-worker",
    batchSize: 6,
    bootstrapReadyChunks: 2,
  });
  assert.equal(second.activated, 0, "an already-active partial generation is not re-published");
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='ready'").get(generation.generationId).n, 8);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='pending'").get(generation.generationId).n, 0);
  value.store.close();
});

test("real semantic worker uses a throughput-oriented default embedding batch", async () => {
  const value = fixture();
  const rows = chunks(value.store, "default-batch", 256, 300);
  enqueueSemanticGeneration({
    store: value.store,
    repoId: "default-batch",
    snapshotId: "default-batch",
    scopeKey: "repo:default-batch",
    space: value.identity,
    chunkIds: rows.map((row) => row.id),
  });
  let largestBatch = 0;
  const provider = {
    ...value.provider,
    async embedDocuments(texts) {
      largestBatch = Math.max(largestBatch, texts.length);
      return texts.map(() => new Float32Array([1, 0]));
    },
  };

  await drainSemanticQueue({ store: value.store, provider, ownerId: "default-batch-worker" });

  assert.equal(largestBatch, 128);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='ready'").get().n, 128);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='pending'").get().n, 128);
  value.store.close();
});

test("one drain round reuses its lease watchdog across fair scope turns", async () => {
  const value = fixture();
  const first = chunks(value.store, "watchdog-a", 5, 300);
  const second = chunks(value.store, "watchdog-b", 5, 300);
  enqueueSemanticGeneration({ store: value.store, repoId: "watchdog-a", snapshotId: "watchdog-a", scopeKey: "repo:watchdog-a", space: value.identity, chunkIds: first.map((row) => row.id) });
  enqueueSemanticGeneration({ store: value.store, repoId: "watchdog-b", snapshotId: "watchdog-b", scopeKey: "repo:watchdog-b", space: value.identity, chunkIds: second.map((row) => row.id) });
  const watchdog = { begins: [], ends: 0, closes: 0,
    async begin(jobIds) { this.begins.push([...jobIds]); },
    async end() { this.ends += 1; },
    error() { return null; },
    async close() { this.closes += 1; },
  };

  await drainSemanticQueue({ store: value.store, provider: value.provider, ownerId: "watchdog-worker", batchSize: 2, leaseWatchdog: watchdog });

  assert.equal(watchdog.closes, 1);
  assert.equal(watchdog.begins.length, 2, "each fair scope turn still gets its own lease heartbeat");
  assert.equal(watchdog.ends, 2);
  value.store.close();
});

test("the eighth committed batch checkpoints across repeated fair drain rounds", async () => {
  const value = fixture();
  const first = chunks(value.store, "checkpoint-a", 5, 300);
  const second = chunks(value.store, "checkpoint-b", 5, 300);
  enqueueSemanticGeneration({ store: value.store, repoId: "checkpoint-a", snapshotId: "checkpoint-a", scopeKey: "repo:checkpoint-a", space: value.identity, chunkIds: first.map((row) => row.id) });
  enqueueSemanticGeneration({ store: value.store, repoId: "checkpoint-b", snapshotId: "checkpoint-b", scopeKey: "repo:checkpoint-b", space: value.identity, chunkIds: second.map((row) => row.id) });

  const schedulerState = { completedBatches: 0 };
  const originalPragma = value.store.db.pragma.bind(value.store.db);
  let passiveCheckpoints = 0;
  value.store.db.pragma = (statement, ...args) => {
    if (statement === "wal_checkpoint(PASSIVE)") passiveCheckpoints += 1;
    return originalPragma(statement, ...args);
  };

  for (let round = 0; round < 4; round += 1) {
    await drainSemanticQueue({
      store: value.store,
      provider: value.provider,
      ownerId: "checkpoint-worker",
      batchSize: 1,
      schedulerState,
    });
  }

  assert.equal(schedulerState.completedBatches, 8);
  assert.equal(passiveCheckpoints, 1, "batch 8 performs the periodic PASSIVE checkpoint");
  value.store.db.pragma = originalPragma;
  value.store.close();
});

test("a periodic checkpoint IO failure is sanitized and reported without undoing committed batches", async () => {
  const value = fixture();
  const first = chunks(value.store, "checkpoint-io-a", 5, 300);
  const second = chunks(value.store, "checkpoint-io-b", 5, 300);
  enqueueSemanticGeneration({ store: value.store, repoId: "checkpoint-io-a", snapshotId: "checkpoint-io-a", scopeKey: "repo:checkpoint-io-a", space: value.identity, chunkIds: first.map((row) => row.id) });
  enqueueSemanticGeneration({ store: value.store, repoId: "checkpoint-io-b", snapshotId: "checkpoint-io-b", scopeKey: "repo:checkpoint-io-b", space: value.identity, chunkIds: second.map((row) => row.id) });

  const schedulerState = { completedBatches: 0 };
  const failures = [];
  const originalPragma = value.store.db.pragma.bind(value.store.db);
  value.store.db.pragma = (statement, ...args) => {
    if (statement === "wal_checkpoint(PASSIVE)") throw new Error("SQLITE_IOERR token=must-not-leak");
    return originalPragma(statement, ...args);
  };

  for (let round = 0; round < 4; round += 1) {
    await drainSemanticQueue({
      store: value.store,
      provider: value.provider,
      ownerId: "checkpoint-io-worker",
      batchSize: 1,
      schedulerState,
      onCheckpointFailure: (failure) => failures.push(failure),
    });
  }

  assert.equal(schedulerState.completedBatches, 8);
  assert.deepEqual(failures, [{ code: "WAL_CHECKPOINT_FAILED", completedBatches: 8 }]);
  assert.doesNotMatch(JSON.stringify(failures), /SQLITE_IOERR|must-not-leak/);
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='ready'").get().n, 8, "committed vector batches stay committed");
  value.store.db.pragma = originalPragma;
  value.store.close();
});

test("semantic rate and ETA are persisted instead of reset by a new client", () => {
  const value = fixture();
  const rows = chunks(value.store, "metric", 10, 128);
  const generation = new EmbeddingLifecycle(value.store).createGeneration({ spaceId: value.space.id, snapshotId: "metric", scopeKey: "repo:metric", expectedChunks: 10 });
  for (const row of rows) new EmbeddingLifecycle(value.store).createJob({ generationId: generation.id, chunkId: row.id });
  const firstFour = value.store.db.prepare("SELECT id FROM embedding_jobs WHERE generation_id=? ORDER BY id LIMIT 4").all(generation.id);
  const markReady = value.store.db.prepare("UPDATE embedding_jobs SET status='ready' WHERE id=?");
  for (const row of firstFour) markReady.run(row.id);
  recordSemanticProgressSample(value.store, generation.id, 0, "2026-08-31T08:00:00.000Z");
  recordSemanticProgressSample(value.store, generation.id, 4, "2026-08-31T08:00:02.000Z");
  const status = listSemanticStatuses(value.store, "repo:metric", "2026-08-31T08:00:03.000Z")[0];
  assert.equal(status.ratePerSecond, 2);
  assert.equal(status.etaSeconds, 3);
  value.store.close();
});
