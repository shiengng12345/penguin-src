import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  EmbeddingLifecycle, KnowledgeStore, VectorStore, chunkSemanticText, embeddingSpaceIdentity,
  persistSemanticChunks,
} from "../packages/knowledge-core/dist/index.js";
import { activateEmbeddingGeneration, backfillEmbeddings } from "../packages/knowledge-indexer/dist/index.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-embedding-indexer-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const texts = new Map();
  for (const [file, text] of [["a.ts", "alpha concept"], ["b.ts", "beta concept"]]) {
    const chunks = persistSemanticChunks(store, { text, sourceBlobId: file === "a.ts" ? 1 : 2, repoId: "repo", snapshotId: "snapshot-1", canonicalFilePath: file, chunkerVersion: "semantic-chunker-v1" });
    for (const chunk of chunks) texts.set(chunk.id, chunk.text);
  }
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "fixture-v1", weightsDigest: "a".repeat(64), tokenizerDigest: "b".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "semantic-chunker-v1" });
  const provider = { id: "fixture", modelId: "fixture-v1", modelHash: space.identityHash, dimensions: 2, maxTokens: 128, async embed(values) { return values.map((value) => value.includes("alpha") ? new Float32Array([1, 0]) : new Float32Array([0, 1])); }, async health() { return { ok: true }; } };
  return { store, texts, space, provider };
}

test("backfill writes batches into staging and activates only after complete", async () => {
  const { store, texts, space, provider } = setup();
  const result = await backfillEmbeddings({ store, provider, space, snapshotId: "snapshot-1", scopeKey: "repo:repo", batchSize: 1, textLoader: (id) => texts.get(id) });
  assert.equal(result.activated, false);
  assert.equal(result.checkpoint.expectedChunks, 2);
  assert.equal(result.checkpoint.readyChunks, 2);
  assert.equal(result.checkpoint.failedChunks, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_active_spaces").get().n, 0);
  const beforeActivation = new VectorStore(store).search(provider.modelHash, new Float32Array([1, 0]), 10, { activeScopeKey: "repo:repo" });
  assert.deepEqual(beforeActivation, []);
  const activated = activateEmbeddingGeneration(store, result.checkpoint.generationId);
  assert.equal(activated.activated, true);
  const hits = new VectorStore(store).search(provider.modelHash, new Float32Array([1, 0]), 10, { activeScopeKey: "repo:repo" });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((hit) => hit.generationId === result.checkpoint.generationId && hit.spaceId === result.spaceId));
  store.close();
});

test("provider failure leaves a resumable staging generation and no active space", async () => {
  const { store, texts, space, provider } = setup();
  let calls = 0;
  const failing = { ...provider, async embed(values) { calls += 1; if (calls === 1) throw new Error("PROVIDER_DOWN"); return provider.embed(values); } };
  await assert.rejects(() => backfillEmbeddings({ store, provider: failing, space, snapshotId: "snapshot-1", scopeKey: "repo:repo", batchSize: 1, textLoader: (id) => texts.get(id) }), /PROVIDER_DOWN/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_active_spaces").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_generations WHERE status='staging'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='failed'").get().n, 1);
  store.close();
});

test("backfill resumes failed jobs in the same staging generation", async () => {
  const { store, texts, space, provider } = setup();
  const failing = { ...provider, async embed() { throw new Error("PROVIDER_INTERRUPTED"); } };
  await assert.rejects(
    () => backfillEmbeddings({ store, provider: failing, space, snapshotId: "snapshot-1", scopeKey: "repo:repo", batchSize: 1, textLoader: (id) => texts.get(id) }),
    /PROVIDER_INTERRUPTED/,
  );
  const firstGeneration = store.db.prepare("SELECT id FROM embedding_generations WHERE status='staging'").get().id;
  new EmbeddingLifecycle(store).retryFailures(firstGeneration);

  const resumed = await backfillEmbeddings({
    store,
    provider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 1,
    textLoader: (id) => texts.get(id),
  });

  assert.equal(resumed.checkpoint.generationId, firstGeneration);
  assert.equal(resumed.checkpoint.readyChunks, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_generations").get().n, 1);
  store.close();
});

test("backfill reports durable ready progress after each completed batch", async () => {
  const { store, texts, space, provider } = setup();
  const progress = [];
  const timings = [];
  await backfillEmbeddings({
    store,
    provider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 1,
    textLoader: (id) => texts.get(id),
    onProgress: (event) => progress.push(event),
    onBatchTiming: (timing) => timings.push(timing),
  });
  assert.deepEqual(progress.map(({ readyChunks, expectedChunks }) => [readyChunks, expectedChunks]), [[0, 2], [1, 2], [2, 2]]);
  assert.equal(timings.length, 2);
  assert.ok(timings.every((timing) => timing.outcome === "committed" && timing.committedChunks === 1));
  assert.ok(timings.every((timing) => timing.totalMs >= timing.inferenceMs));
  assert.ok(timings.every((timing) => timing.claimWaitMs >= 0 && timing.vectorWriteMs >= 0 && timing.commitMs >= 0));
  store.close();
});

test("a slow provider is kept alive by heartbeat and commits before the renewed lease expires", async () => {
  const { store, texts, space, provider } = setup();
  const slow = {
    ...provider,
    async embed(values) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return provider.embed(values);
    },
  };
  const result = await backfillEmbeddings({
    store,
    provider: slow,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 2,
    leaseDurationMs: 50,
    heartbeatIntervalMs: 15,
    textLoader: (id) => texts.get(id),
  });
  assert.equal(result.checkpoint.readyChunks, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE lease_owner IS NOT NULL").get().n, 0);
  store.close();
});

test("lease watchdog renews ownership while the provider blocks the event loop", async () => {
  const { store, texts, space, provider } = setup();
  const blocking = {
    ...provider,
    async embed(values) {
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waiter, 0, 0, 120);
      return provider.embed(values);
    },
  };
  const result = await backfillEmbeddings({
    store,
    provider: blocking,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 2,
    leaseDurationMs: 50,
    heartbeatIntervalMs: 15,
    textLoader: (id) => texts.get(id),
  });
  assert.equal(result.checkpoint.readyChunks, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE lease_owner IS NOT NULL").get().n, 0);
  store.close();
});

test("lease loss during a slow provider call prevents vector and ready-job commits", async () => {
  const { store, texts, space, provider } = setup();
  const losing = {
    ...provider,
    async embed(values) {
      setTimeout(() => {
        store.db.prepare("UPDATE embedding_jobs SET lease_owner='replacement-worker',lease_expires_at=? WHERE status='running'").run(
          new Date(Date.now() + 1_000).toISOString(),
        );
      }, 20);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return provider.embed(values);
    },
  };
  await assert.rejects(() => backfillEmbeddings({
    store,
    provider: losing,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 2,
    leaseDurationMs: 60,
    heartbeatIntervalMs: 10,
    textLoader: (id) => texts.get(id),
  }), /EMBEDDING_JOB_OWNERSHIP_LOST/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='ready'").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs WHERE status='ready'").get().n, 0);
  store.close();
});

test("backfill reuses an unchanged vector across snapshot generations without calling the provider", async () => {
  const { store, texts, space, provider } = setup();
  const first = await backfillEmbeddings({ store, provider, space, snapshotId: "snapshot-1", scopeKey: "repo:repo", batchSize: 1, textLoader: (id) => texts.get(id) });
  activateEmbeddingGeneration(store, first.checkpoint.generationId);
  const source = [...texts.values()][0];
  const nextChunks = persistSemanticChunks(store, { text: source, sourceBlobId: 1, repoId: "repo", snapshotId: "snapshot-2", canonicalFilePath: "a.ts", chunkerVersion: "semantic-chunker-v1" });
  const nextTexts = new Map(nextChunks.map((chunk) => [chunk.id, chunk.text]));
  let calls = 0;
  const countingProvider = { ...provider, async embed(values) { calls += 1; return provider.embed(values); } };
  const second = await backfillEmbeddings({ store, provider: countingProvider, space, snapshotId: "snapshot-2", scopeKey: "repo:repo", textLoader: (id) => nextTexts.get(id) });
  assert.equal(calls, 0);
  assert.equal(second.checkpoint.readyChunks, nextChunks.length);
  activateEmbeddingGeneration(store, second.checkpoint.generationId);
  store.close();
});

test("reusable vector copy rolls back when its claimed job lease expires before completion", async () => {
  const { store, texts, space, provider } = setup();
  const first = await backfillEmbeddings({
    store,
    provider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 2,
    textLoader: (id) => texts.get(id),
  });
  activateEmbeddingGeneration(store, first.checkpoint.generationId);

  const source = [...texts.values()][0];
  const nextChunks = persistSemanticChunks(store, {
    text: source,
    sourceBlobId: 1,
    repoId: "repo",
    snapshotId: "snapshot-2",
    canonicalFilePath: "a.ts",
    chunkerVersion: "semantic-chunker-v1",
  });
  const nextTexts = new Map(nextChunks.map((chunk) => [chunk.id, chunk.text]));
  const refsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs").get().n;
  const vectorsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vector_values").get().n;
  const originalCopy = VectorStore.prototype.copy;
  VectorStore.prototype.copy = function expireLeaseAfterCopy(...args) {
    const result = originalCopy.apply(this, args);
    const until = Date.now() + 35;
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    return result;
  };

  try {
    await assert.rejects(() => backfillEmbeddings({
      store,
      provider,
      space,
      snapshotId: "snapshot-2",
      scopeKey: "repo:repo",
      leaseDurationMs: 20,
      heartbeatIntervalMs: 5,
      textLoader: (id) => nextTexts.get(id),
    }), /EMBEDDING_JOB_OWNERSHIP_LOST/);
  } finally {
    VectorStore.prototype.copy = originalCopy;
  }

  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs").get().n, refsBefore);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vector_values").get().n, vectorsBefore);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_embedding_refs WHERE chunk_id=?").get(nextChunks[0].id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='ready' AND generation_id<>?").get(first.checkpoint.generationId).n, 0);
  store.close();
});

test("backfill does not probe reusable vectors once per pending chunk and batch", async () => {
  const { store, texts, space, provider } = setup();
  for (let index = 2; index < 64; index += 1) {
    const file = `file-${index}.ts`;
    const chunks = persistSemanticChunks(store, {
      text: `unique concept ${index}`,
      sourceBlobId: index + 1,
      repoId: "repo",
      snapshotId: "snapshot-1",
      canonicalFilePath: file,
      chunkerVersion: "semantic-chunker-v1",
    });
    for (const chunk of chunks) texts.set(chunk.id, chunk.text);
  }

  let individualReuseProbes = 0;
  const originalPrepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (String(sql).includes("SELECT old.id")) {
      const originalGet = statement.get.bind(statement);
      statement.get = (...args) => {
        individualReuseProbes += 1;
        return originalGet(...args);
      };
    }
    return statement;
  };

  const result = await backfillEmbeddings({
    store,
    provider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 8,
    textLoader: (id) => texts.get(id),
  });

  assert.equal(result.checkpoint.readyChunks, 64);
  assert.ok(individualReuseProbes <= 8, `expected bounded reuse probes, received ${individualReuseProbes}`);
  store.close();
});

test("backfill uses the document embedding role when the provider exposes it", async () => {
  const { store, texts, space, provider } = setup();
  let documentCalls = 0;
  const roleAwareProvider = {
    ...provider,
    async embed() {
      throw new Error("GENERIC_EMBED_MUST_NOT_HANDLE_DOCUMENTS");
    },
    async embedDocuments(values) {
      documentCalls += 1;
      return provider.embed(values);
    },
  };

  const result = await backfillEmbeddings({
    store,
    provider: roleAwareProvider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    textLoader: (id) => texts.get(id),
  });

  assert.equal(result.checkpoint.readyChunks, 2);
  assert.equal(documentCalls, 1);
  store.close();
});

test("backfill groups similarly sized chunks so ONNX batches avoid excessive padding", async () => {
  const { store, texts, space, provider } = setup();
  for (const [index, length] of [900, 1100].entries()) {
    const chunks = persistSemanticChunks(store, {
      text: "x".repeat(length),
      sourceBlobId: index + 10,
      repoId: "repo",
      snapshotId: "snapshot-1",
      canonicalFilePath: `long-${index}.ts`,
      chunkerVersion: "semantic-chunker-v1",
    });
    for (const chunk of chunks) texts.set(chunk.id, chunk.text);
  }
  const batches = [];
  const measuringProvider = {
    ...provider,
    async embed(values) {
      batches.push(values.map((value) => value.length));
      return provider.embed(values);
    },
  };

  await backfillEmbeddings({
    store,
    provider: measuringProvider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    batchSize: 2,
    textLoader: (id) => texts.get(id),
  });

  assert.deepEqual(batches.map((batch) => batch.map(Number).sort((a, b) => a - b)), [
    [12, 13],
    [900, 1100],
  ]);
  store.close();
});

test("default backfill expands batches for tiny chunks within a bounded padding budget", async () => {
  const { store, texts, space, provider } = setup();
  for (let index = 2; index < 64; index += 1) {
    const chunks = persistSemanticChunks(store, {
      text: `tiny-${index}`,
      sourceBlobId: index + 1,
      repoId: "repo",
      snapshotId: "snapshot-1",
      canonicalFilePath: `tiny-${index}.ts`,
      chunkerVersion: "semantic-chunker-v1",
    });
    for (const chunk of chunks) texts.set(chunk.id, chunk.text);
  }
  let calls = 0;
  const measuringProvider = {
    ...provider,
    async embed(values) {
      calls += 1;
      return provider.embed(values);
    },
  };

  await backfillEmbeddings({
    store,
    provider: measuringProvider,
    space,
    snapshotId: "snapshot-1",
    scopeKey: "repo:repo",
    textLoader: (id) => texts.get(id),
  });

  assert.equal(calls, 2, "64 tiny chunks are drained in two bounded batches of at most 32");
  store.close();
});
