import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, embeddingSpaceIdentity, VectorStore } from "../packages/knowledge-core/dist/index.js";
import { drainSemanticQueue, indexRepo } from "../packages/knowledge-indexer/dist/index.js";

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: "Penguin Test", GIT_AUTHOR_EMAIL: "penguin@example.invalid", GIT_COMMITTER_NAME: "Penguin Test", GIT_COMMITTER_EMAIL: "penguin@example.invalid" };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "penguin-pipeline-semantic-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "search.ts"), "export function searchableConcept() { return 'vector'; }\n");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: gitEnv() });
  execFileSync("git", ["-C", root, "add", "."], { env: gitEnv() });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env: gitEnv() });
  const dir = mkdtempSync(join(tmpdir(), "penguin-pipeline-semantic-db-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  return { root, store };
}

test("indexRepo persists revision-scoped semantic chunks without requiring a model", async () => {
  const { root, store } = fixture();
  const report = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true } });
  assert.equal(report.semantic.requested, true);
  assert.equal(report.semantic.status, "disabled");
  assert.equal(report.semantic.reason, "EMBEDDING_SPACE_UNAVAILABLE");
  assert.ok(report.semantic.chunks > 0);
  const row = store.db.prepare("SELECT repo_id,snapshot_id,canonical_file_path,identity_hash FROM semantic_chunks LIMIT 1").get();
  assert.equal(row.repo_id, report.repoId);
  assert.equal(row.snapshot_id, store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(report.branchId).current_snapshot_id);
  assert.equal(row.canonical_file_path, "src/search.ts");
  assert.match(row.identity_hash, /^[a-f0-9]{64}$/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_active_spaces").get().n, 0);
  store.close();
});

test("indexRepo enqueues immediately and a separate drainer atomically activates vectors", async () => {
  const { root, store } = fixture();
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "fixture-v1", weightsDigest: "a".repeat(64), tokenizerDigest: "b".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "semantic-chunker-v1" });
  let graphPublishedBeforeEmbedding = false;
  const provider = { id: "fixture", modelId: "fixture-v1", modelHash: space.identityHash, dimensions: 2, maxTokens: 128, async embed(values) {
    const branch = store.db.prepare("SELECT current_snapshot_id AS snapshotId FROM branches LIMIT 1").get();
    const snapshot = branch?.snapshotId
      ? store.db.prepare("SELECT state FROM revision_snapshots WHERE id=?").get(branch.snapshotId)
      : undefined;
    graphPublishedBeforeEmbedding = snapshot?.state === "ready";
    return values.map((value) => value.includes("searchableConcept") ? new Float32Array([1, 0]) : new Float32Array([0, 1]));
  }, async health() { return { ok: true }; } };
  const progress = [];
  const report = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, provider, space, batchSize: 1 }, onProgress: (event) => progress.push(event) });
  assert.equal(report.semantic.status, "queued", JSON.stringify(report.semantic));
  assert.equal(graphPublishedBeforeEmbedding, false, "indexRepo must not call the provider");
  const drained = await drainSemanticQueue({ store, provider, ownerId: "pipeline-test", batchSize: 1, onProgress: (event) => progress.push({ phase: "embedding", ready: event.readyChunks, total: event.expectedChunks }) });
  assert.equal(drained.activated, 1);
  assert.equal(graphPublishedBeforeEmbedding, true, "graph snapshot must be published before embedding begins");
  assert.ok(progress.some((event) => event.phase === "embedding" && event.ready === event.total));
  assert.ok(report.semantic.generationId);
  assert.equal(store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(report.semantic.generationId).status, "active");
  const hits = new VectorStore(store).search(provider.modelHash, new Float32Array([1, 0]), 5, { activeScopeKey: `repo:${report.repoId}` });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].generationId, report.semantic.generationId);
  store.close();
});

test("indexRepo replaces stale chunker rows and the separate drainer uses normal WAL checkpointing", async () => {
  const { root, store } = fixture();
  await indexRepo({
    store,
    rootPath: root,
    mode: "incremental",
    semantic: { enabled: true, chunkerVersion: "semantic-chunker-old" },
  });
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM semantic_chunks WHERE chunker_version='semantic-chunker-old'").get().n > 0,
    true,
  );

  const chunkerVersion = "semantic-chunker-new";
  const space = embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "fixture-v2",
    weightsDigest: "c".repeat(64),
    tokenizerDigest: "d".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion,
  });
  let walAutoCheckpointDuringEmbedding = -1;
  const provider = {
    id: "fixture",
    modelId: "fixture-v2",
    modelHash: space.identityHash,
    dimensions: 2,
    maxTokens: 128,
    async embed(values) {
      walAutoCheckpointDuringEmbedding = Number(store.db.pragma("wal_autocheckpoint", { simple: true }));
      return values.map(() => new Float32Array([1, 0]));
    },
    async health() { return { ok: true }; },
  };
  const report = await indexRepo({
    store,
    rootPath: root,
    mode: "incremental",
    semantic: { enabled: true, provider, space, batchSize: 1, chunkerVersion },
  });
  assert.equal(report.semantic.status, "queued", JSON.stringify(report.semantic));
  const drained = await drainSemanticQueue({ store, provider, ownerId: "wal-test", batchSize: 1 });
  assert.equal(drained.activated, 1);
  assert.ok(walAutoCheckpointDuringEmbedding > 0, "semantic backfill must not inherit rebuild wal_autocheckpoint=0");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_chunks WHERE chunker_version<>?").get(chunkerVersion).n, 0);
  const chunks = store.db.prepare("SELECT COUNT(*) AS n FROM semantic_chunks").get().n;
  const generation = store.db.prepare("SELECT expected_chunks AS expectedChunks FROM embedding_generations WHERE id=?").get(report.semantic.generationId);
  assert.equal(generation.expectedChunks, chunks);
  store.close();
});
