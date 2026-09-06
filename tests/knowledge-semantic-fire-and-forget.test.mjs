import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EmbeddingLifecycle, KnowledgeStore, VectorStore, embeddingSpaceIdentity, repoGraph, searchSource } from "../packages/knowledge-core/dist/index.js";
import { drainSemanticQueue, indexRepo } from "../packages/knowledge-indexer/dist/index.js";

test("indexRepo publishes graph and durable jobs without awaiting the embedding provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-fire-forget-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "instant.ts"), "export function durableGraphLeaf() { return 'ready'; }\nexport function durableGraphConcept() { return durableGraphLeaf(); }\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.invalid",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.invalid",
  };
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env });
  const directory = mkdtempSync(join(tmpdir(), "penguin-fire-forget-db-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const space = embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "never-resolves",
    weightsDigest: "c".repeat(64),
    tokenizerDigest: "d".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "semantic-chunker-v1",
  });
  let providerCalls = 0;
  const provider = {
    id: "fixture",
    modelId: "never-resolves",
    modelHash: space.identityHash,
    dimensions: 2,
    maxTokens: 128,
    async embed() {
      providerCalls += 1;
      return new Promise(() => {});
    },
  };

  const report = await Promise.race([
    indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, provider, space } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("INDEX_WAITED_FOR_EMBEDDING")), 2_000)),
  ]);

  assert.equal(providerCalls, 0);
  assert.equal(report.semantic.status, "queued");
  assert.ok(report.semantic.generationId);
  assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE branch_id=? AND status='indexed'").get(report.branchId).n > 0);
  assert.equal(store.db.prepare("SELECT state FROM revision_snapshots WHERE id=(SELECT current_snapshot_id FROM branches WHERE id=?)").get(report.branchId).state, "ready");
  assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE generation_id=? AND status='pending'").get(report.semantic.generationId).n > 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key=?").get(`index_lock::${report.branchId}`).n, 0);
  const snapshotId = store.db.prepare("SELECT current_snapshot_id AS snapshotId FROM branches WHERE id=?").get(report.branchId).snapshotId;
  assert.equal(searchSource(store, { repoId: report.repoId, snapshotId }, { query: "durableGraphConcept", mode: "exact", options: { caseSensitive: true, wholeWord: false } }).length, 1);
  assert.ok(repoGraph(store, report.repoId, report.branchId, { limit: 20 }).nodes.length > 0);

  const lifecycle = new EmbeddingLifecycle(store);
  store.acquireIndexMarker(report.branchId);
  assert.deepEqual(lifecycle.claimJobs({
    ownerId: "boundary-worker",
    generationId: report.semantic.generationId,
    limit: 1,
    now: "2026-09-01T08:00:00.000Z",
    leaseExpiresAt: "2026-09-01T08:01:00.000Z",
  }), [], "semantic jobs must remain unclaimable until the graph marker is released");
  store.releaseIndexMarker(report.branchId);
  assert.equal(lifecycle.claimJobs({
    ownerId: "boundary-worker",
    generationId: report.semantic.generationId,
    limit: 1,
    now: "2026-09-01T08:00:00.000Z",
    leaseExpiresAt: "2026-09-01T08:01:00.000Z",
  }).length, 1);
  store.close();
});

test("two independent processes cannot both acquire one branch index marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-marker-race-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const repoId = store.registerRepo({ name: "marker-race", rootPath: directory });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  store.close();
  const barrier = join(directory, "marker.barrier");
  const ready = (id) => join(directory, `marker.${id}.ready`);
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const script = (id) => `
    import { existsSync, writeFileSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(coreUrl)};
    writeFileSync(${JSON.stringify(ready(id))}, "ready");
    while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(dbPath)}, ledgerPath: ${JSON.stringify(ledgerPath)} });
    try {
      store.acquireIndexMarker(${JSON.stringify(branchId)});
      process.stdout.write("acquired");
      await new Promise((resolve) => setTimeout(resolve, 120));
      store.releaseIndexMarker(${JSON.stringify(branchId)});
    } catch (error) {
      process.stdout.write("blocked:" + String(error.message));
    } finally { store.close(); }
  `;
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script(id)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
  const first = run("a");
  const second = run("b");
  const readyDeadline = Date.now() + 5_000;
  while ((!existsSync(ready("a")) || !existsSync(ready("b"))) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(ready("a")), true, "marker child a did not reach the barrier");
  assert.equal(existsSync(ready("b")), true, "marker child b did not reach the barrier");
  assert.equal(existsSync(barrier), false);
  writeFileSync(barrier, "go");
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result === "acquired").length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.startsWith("blocked:index already running")).length, 1, JSON.stringify(results));
});

test("the writer marker serializes different branches in one database", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-global-marker-"));
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "global-marker", rootPath: directory });
  const mainId = store.registerBranch({ repoId, name: "main", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature", status: "snapshot" });

  store.acquireIndexMarker(mainId);
  assert.throws(
    () => store.acquireIndexMarker(featureId),
    (error) => error?.code === "INDEX_WRITER_BUSY" && /another repository or branch/.test(error.message),
    "a second branch must receive a typed writer-busy error",
  );
  store.releaseIndexMarker(mainId);
  store.acquireIndexMarker(featureId);
  store.releaseIndexMarker(featureId);
  store.close();
});

test("a child indexer crash after semantic enqueue leaves graph searchable and worker clears the dead marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-index-crash-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "crash.ts"), "export function crashRecoveryLeaf() { return 'ready'; }\nexport function crashRecoveryConcept() { return crashRecoveryLeaf(); }\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.invalid",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.invalid",
  };
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env });

  const directory = mkdtempSync(join(tmpdir(), "penguin-index-crash-db-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const indexerUrl = new URL("../packages/knowledge-indexer/dist/index.js", import.meta.url).href;
  const space = embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "crash-recovery",
    weightsDigest: "9".repeat(64),
    tokenizerDigest: "8".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "semantic-chunker-v1",
  });
  const childScript = `
    import { KnowledgeStore } from ${JSON.stringify(coreUrl)};
    import { indexRepo } from ${JSON.stringify(indexerUrl)};
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(dbPath)}, ledgerPath: ${JSON.stringify(ledgerPath)} });
    await indexRepo({
      store,
      rootPath: ${JSON.stringify(root)},
      mode: "incremental",
      semantic: { enabled: true, space: ${JSON.stringify(space)} },
      testHooks: { afterSemanticEnqueue: () => process.exit(86) },
    });
    store.close();
  `;
  const crash = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  assert.equal(crash.code, 86, crash.stderr || `unexpected child signal ${crash.signal}`);

  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const branch = store.db.prepare("SELECT id,repo_id AS repoId,current_snapshot_id AS snapshotId FROM branches WHERE name='main'").get();
  const generation = store.db.prepare("SELECT id FROM embedding_generations WHERE snapshot_id=? AND status='staging'").get(branch.snapshotId);
  assert.ok(branch);
  assert.ok(generation);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key=?").get(`index_lock::${branch.id}`).n, 1);
  assert.equal(searchSource(store, { repoId: branch.repoId, snapshotId: branch.snapshotId }, { query: "crashRecoveryConcept", mode: "exact", options: { caseSensitive: true, wholeWord: false } }).length, 1);
  assert.ok(repoGraph(store, branch.repoId, branch.id, { limit: 20 }).nodes.length > 0);

  const provider = {
    id: "fixture",
    modelId: "crash-recovery",
    modelHash: space.identityHash,
    dimensions: 2,
    maxTokens: 128,
    async embed(values) { return values.map(() => new Float32Array([1, 0])); },
    async health() { return { ok: true }; },
  };
  const drained = await drainSemanticQueue({ store, provider, ownerId: "crash-recovery-worker", batchSize: 32 });
  assert.equal(drained.activated, 1);
  assert.equal(store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(generation.id).status, "active");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key=?").get(`index_lock::${branch.id}`).n, 0);
  assert.equal(searchSource(store, { repoId: branch.repoId, snapshotId: branch.snapshotId }, { query: "crashRecoveryConcept", mode: "exact", options: { caseSensitive: true, wholeWord: false } }).length, 1);
  assert.ok(repoGraph(store, branch.repoId, branch.id, { limit: 20 }).nodes.length > 0);
  store.close();
});

test("a newer snapshot supersedes only the older staging generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-supersede-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const source = join(root, "src", "version.ts");
  writeFileSync(source, "export const semanticVersion = 1;\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.invalid",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.invalid",
  };
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "v1"], { env });
  const directory = mkdtempSync(join(tmpdir(), "penguin-supersede-db-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const space = embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "supersede",
    weightsDigest: "e".repeat(64),
    tokenizerDigest: "f".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "semantic-chunker-v1",
  });

  const first = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, space } });
  writeFileSync(source, "export const semanticVersion = 2;\n");
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "v2"], { env });
  const second = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, space } });

  assert.notEqual(first.semantic.generationId, second.semantic.generationId);
  assert.deepEqual(store.db.prepare("SELECT status,failure_reason AS failureReason FROM embedding_generations WHERE id=?").get(first.semantic.generationId), {
    status: "failed",
    failureReason: "SUPERSEDED_BY_NEWER_SNAPSHOT",
  });
  assert.equal(store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(second.semantic.generationId).status, "staging");
  store.close();
});

test("a newer snapshot reuses ready vectors from a superseded staging generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-supersede-reuse-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const stable = join(root, "src", "stable.ts");
  const changing = join(root, "src", "changing.ts");
  writeFileSync(stable, "export const stableSemanticConcept = 'same';\n");
  writeFileSync(changing, "export const changingSemanticConcept = 'v1';\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "Penguin Test", GIT_AUTHOR_EMAIL: "penguin@example.invalid", GIT_COMMITTER_NAME: "Penguin Test", GIT_COMMITTER_EMAIL: "penguin@example.invalid" };
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "v1"], { env });
  const directory = mkdtempSync(join(tmpdir(), "penguin-supersede-reuse-db-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const space = embeddingSpaceIdentity({ providerId: "fixture", modelId: "reuse", weightsDigest: "1".repeat(64), tokenizerDigest: "2".repeat(64), dimensions: 2, pooling: "mean", normalization: "none", chunkerVersion: "semantic-chunker-v1" });
  const provider = { id: "fixture", modelId: "reuse", modelHash: space.identityHash, dimensions: 2, maxTokens: 128, async embed(values) { return values.map(() => new Float32Array([1, 0])); }, async health() { return { ok: true }; } };
  const first = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, space } });
  const lifecycle = new EmbeddingLifecycle(store);
  const jobs = lifecycle.claimJobs({ ownerId: "seed-worker", generationId: first.semantic.generationId, limit: 100, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  const vectorStore = new VectorStore(store);
  vectorStore.ensureModel(provider);
  const firstGeneration = lifecycle.getGeneration(first.semantic.generationId);
  for (const job of jobs) {
    vectorStore.put(provider.modelHash, job.chunkId, new Float32Array([1, 0]), { generationId: first.semantic.generationId, spaceId: firstGeneration.spaceId });
    lifecycle.completeClaimedJob(job.id, "seed-worker");
  }

  writeFileSync(changing, "export const changingSemanticConcept = 'v2';\n");
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "v2"], { env });
  const second = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, space } });
  assert.equal(lifecycle.getGeneration(first.semantic.generationId).failureReason, "SUPERSEDED_BY_NEWER_SNAPSHOT");
  let providerCalls = 0;
  const countingProvider = { ...provider, async embed(values) { providerCalls += values.length; return provider.embed(values); } };
  const drained = await drainSemanticQueue({ store, provider: countingProvider, ownerId: "reuse-worker", batchSize: 32 });
  assert.equal(drained.activated, 1);
  assert.equal(providerCalls, 1, "only the changed chunk should require a new embedding");
  assert.equal(lifecycle.getGeneration(second.semantic.generationId).status, "active");
  store.close();
});
