import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EmbeddingLifecycle, KnowledgeStore, createEmbeddingSpace, embeddingSpaceIdentity, listSemanticStatuses, persistSemanticChunks } from "../packages/knowledge-core/dist/index.js";
import { validateCapabilityOutput } from "../packages/knowledge-contracts/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { runKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";

test("CLI and MCP semantic status return the same canonical payload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-parity-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const seed = KnowledgeStore.open({ dbPath, ledgerPath });
  const chunk = persistSemanticChunks(seed, { text: "parity", repoId: "repo", snapshotId: "snapshot", canonicalFilePath: "parity.ts", chunkerVersion: "v1" })[0];
  const space = createEmbeddingSpace(seed, embeddingSpaceIdentity({ providerId: "fixture", modelId: "parity", weightsDigest: "3".repeat(64), tokenizerDigest: "4".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" }));
  const lifecycle = new EmbeddingLifecycle(seed);
  const generation = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot", scopeKey: "repo:repo", expectedChunks: 1 });
  lifecycle.createJob({ generationId: generation.id, chunkId: chunk.id });
  lifecycle.requestPause("repo:repo");
  seed.close();

  const lines = [];
  const exitCode = await runCli(["semantic", "status", "--scope", "repo:repo", "--json"], {
    cwd: directory,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    storeExists: () => true,
    openStore: (options) => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: options?.allowSchemaMutation }),
  });
  assert.equal(exitCode, 0);
  const cli = JSON.parse(lines.at(-1));
  const mcpStore = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
  const mcp = await runKnowledgeTool("knowledge_semantic_status", { scopeKey: "repo:repo" }, { store: mcpStore });
  assert.deepEqual(validateCapabilityOutput("knowledge.semantic_status", mcp), cli);
  assert.equal(cli.statuses[0].state, "paused");
  mcpStore.close();
});

test("MCP semantic status exposes an outdated long-lived runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-restart-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const chunk = persistSemanticChunks(store, { text: "restart", repoId: "repo", snapshotId: "snapshot", canonicalFilePath: "restart.ts", chunkerVersion: "v1" })[0];
  const space = createEmbeddingSpace(store, embeddingSpaceIdentity({ providerId: "fixture", modelId: "restart", weightsDigest: "5".repeat(64), tokenizerDigest: "6".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" }));
  const lifecycle = new EmbeddingLifecycle(store);
  const generation = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot", scopeKey: "repo:repo", expectedChunks: 1 });
  lifecycle.createJob({ generationId: generation.id, chunkId: chunk.id });

  const result = await runKnowledgeTool(
    "knowledge_semantic_status",
    { scopeKey: "repo:repo" },
    { store, restartRequired: true },
  );
  assert.equal(result.statuses[0].restartRequired, true);
  store.close();
});

test("semantic status retains model dimensions and the last worker lease after the worker becomes idle", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-idle-worker-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const space = createEmbeddingSpace(store, embeddingSpaceIdentity({ providerId: "fixture", modelId: "idle-worker", weightsDigest: "b".repeat(64), tokenizerDigest: "c".repeat(64), dimensions: 384, pooling: "mean", normalization: "none", chunkerVersion: "v1" }));
  const lifecycle = new EmbeddingLifecycle(store);
  lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot", scopeKey: "repo:repo", expectedChunks: 1 });
  assert.equal(lifecycle.acquireWorkerLease({
    ownerId: "worker-idle",
    ownerPid: 4242,
    buildId: "build-idle",
    now: "2026-09-01T00:00:00.000Z",
    leaseExpiresAt: "2026-09-01T00:01:00.000Z",
  }), true);
  assert.equal(lifecycle.releaseWorkerLease("worker-idle", "semantic-drain", "2026-09-01T00:00:10.000Z"), true);

  const status = listSemanticStatuses(store, "repo:repo", "2026-09-01T00:00:20.000Z")[0];
  assert.equal(status.dimensions, 384);
  assert.equal(status.workerBuildId, "build-idle");
  assert.equal(status.lastHeartbeatAt, "2026-09-01T00:00:10.000Z");
  assert.deepEqual(status.lease, {
    active: false,
    ownerId: "worker-idle",
    ownerPid: 4242,
    expiresAt: "2026-09-01T00:00:10.000Z",
  });
  store.close();
});

test("MCP semantic status accepts a repository display name and echoes the resolved scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-repo-name-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "FPMS-NT", rootPath: join(directory, "FPMS-NT") });
  const chunk = persistSemanticChunks(store, { text: "repo-name", repoId, snapshotId: "snapshot", canonicalFilePath: "repo.ts", chunkerVersion: "v1" })[0];
  const space = createEmbeddingSpace(store, embeddingSpaceIdentity({ providerId: "fixture", modelId: "repo-name", weightsDigest: "9".repeat(64), tokenizerDigest: "a".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" }));
  const generation = new EmbeddingLifecycle(store).createGeneration({ spaceId: space.id, snapshotId: "snapshot", scopeKey: `repo:${repoId}`, expectedChunks: 1 });
  new EmbeddingLifecycle(store).createJob({ generationId: generation.id, chunkId: chunk.id });

  const result = await runKnowledgeTool("knowledge_semantic_status", { scopeKey: "FPMS-NT" }, { store });
  assert.equal(result.requestedScopeKey, "FPMS-NT");
  assert.equal(result.resolvedScopeKey, `repo:${repoId}`);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].repoId, repoId);
  store.close();
});

test("MCP semantic status rejects an unknown scope with valid scope forms", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-unknown-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "KnownRepo", rootPath: join(directory, "KnownRepo") });

  const result = await runKnowledgeTool("knowledge_semantic_status", { scopeKey: "missing-repo" }, { store });
  assert.equal(result.error.code, "SCOPE_NOT_FOUND");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.details.requestedScopeKey, "missing-repo");
  assert.ok(result.error.details.validScopeKeys.includes(`repo:${repoId}`));
  assert.ok(result.error.details.validRepositoryNames.includes("KnownRepo"));
  store.close();
});

test("a generation whose chunk set was replaced is historical superseded state, not a stalled worker", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-replaced-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const space = createEmbeddingSpace(store, embeddingSpaceIdentity({ providerId: "fixture", modelId: "replaced", weightsDigest: "7".repeat(64), tokenizerDigest: "8".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" }));
  const generation = new EmbeddingLifecycle(store).createGeneration({ spaceId: space.id, snapshotId: "snapshot", scopeKey: "repo:repo", expectedChunks: 1 });
  store.db.prepare("UPDATE embedding_generations SET status='failed',failure_reason='SEMANTIC_CHUNK_SET_REPLACED' WHERE id=?").run(generation.id);

  const status = listSemanticStatuses(store, "repo:repo")[0];
  assert.equal(status.state, "superseded");
  assert.equal(status.reason, "SEMANTIC_CHUNK_SET_REPLACED");
  store.close();
});

test("superseded generation failures are historical and not runnable retry backlog", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-superseded-counts-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const chunk = persistSemanticChunks(store, { text: "old", repoId: "repo", snapshotId: "old", canonicalFilePath: "old.ts", chunkerVersion: "v1" })[0];
  const space = createEmbeddingSpace(store, embeddingSpaceIdentity({ providerId: "fixture", modelId: "superseded-counts", weightsDigest: "c".repeat(64), tokenizerDigest: "d".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "v1" }));
  const lifecycle = new EmbeddingLifecycle(store);
  const generation = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "old", scopeKey: "repo:repo", expectedChunks: 1 });
  lifecycle.createJob({ generationId: generation.id, chunkId: chunk.id });
  store.db.prepare("UPDATE embedding_jobs SET status='failed',error='SUPERSEDED_BY_NEWER_SNAPSHOT' WHERE generation_id=?").run(generation.id);
  store.db.prepare("UPDATE embedding_generations SET status='failed',failure_reason='SUPERSEDED_BY_NEWER_SNAPSHOT' WHERE id=?").run(generation.id);

  const status = listSemanticStatuses(store, "repo:repo")[0];
  assert.equal(status.state, "superseded");
  assert.equal(status.retryableFailed, 0);
  assert.equal(status.terminalFailed, 0);
  store.close();
});
