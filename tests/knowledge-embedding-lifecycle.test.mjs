import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  AuditStore,
  EmbeddingLifecycle,
  KnowledgeStore,
  createEmbeddingSpace,
  listSemanticStatuses,
} from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-embedding-lifecycle-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const space = createEmbeddingSpace(store, {
    providerId: "fixture",
    modelId: "fixture-v1",
    weightsDigest: "a".repeat(64),
    tokenizerDigest: "b".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "l2",
    chunkerVersion: "chunker-v2",
  });
  const lifecycle = new EmbeddingLifecycle(store);
  return { store, space, lifecycle };
}

function addReadyVector(store, generation, space, chunkId, vecRowId = 1) {
  store.db.prepare(`
    INSERT INTO semantic_chunks
      (id,content_hash,repo_id,snapshot_id,canonical_file_path,identity_hash,chunker_version,start_byte,end_byte,chunk_kind,text_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING
  `).run(chunkId, "c".repeat(64), "repo-a", generation.snapshotId, `src/${chunkId}.ts`, `identity-${chunkId}`, space.chunkerVersion, 0, 4, "paragraph", "c".repeat(64), new Date().toISOString());
  store.db.prepare("INSERT INTO semantic_vector_values(vec_rowid,model_hash,dimensions,vector_json,created_at) VALUES (?,?,?,?,?)")
    .run(vecRowId, space.id, space.dimensions, JSON.stringify([1, 0]), new Date().toISOString());
  store.db.prepare(`
    INSERT INTO semantic_embedding_refs
      (model_hash,chunk_id,vec_rowid,status,error,embedded_at,generation_id,space_id)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(space.id, chunkId, vecRowId, "ready", null, new Date().toISOString(), generation.id, space.id);
}

function addPendingChunk(store, generation, space, chunkId) {
  store.db.prepare(`
    INSERT INTO semantic_chunks
      (id,content_hash,repo_id,snapshot_id,canonical_file_path,identity_hash,chunker_version,start_byte,end_byte,chunk_kind,text_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(chunkId, "c".repeat(64), "repo-a", generation.snapshotId, `src/${chunkId}.ts`, `identity-${chunkId}`, space.chunkerVersion, 0, 4, "paragraph", "c".repeat(64), new Date().toISOString());
}

function completeThroughClaim(lifecycle, generationId, jobId, ownerId) {
  const claimed = lifecycle.claimJobs({
    ownerId,
    generationId,
    limit: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, jobId);
  lifecycle.completeClaimedJob(jobId, ownerId);
}

test("generation and job transitions reject illegal states", () => {
  const { store, space, lifecycle } = fixture();
  const generation = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot-1", scopeKey: "repo-a", expectedChunks: 1 });
  addPendingChunk(store, generation, space, "chunk-1");
  const job = lifecycle.createJob({ generationId: generation.id, chunkId: "chunk-1" });
  assert.throws(() => lifecycle.transitionGeneration(generation.id, "active"), /EMBEDDING_GENERATION_NOT_READY/);
  completeThroughClaim(lifecycle, generation.id, job.id, "transition-test");
  assert.throws(() => lifecycle.transitionJob(job.id, "running"), /EMBEDDING_JOB_INVALID_TRANSITION/);
  lifecycle.transitionGeneration(generation.id, "failed", "fixture failure");
  assert.throws(() => lifecycle.transitionGeneration(generation.id, "active"), /EMBEDDING_GENERATION_INVALID_TRANSITION/);
  store.close();
});

test("activation atomically requires jobs, refs, vector rows, dimensions, and integrity", () => {
  const { store, space, lifecycle } = fixture();
  const generation = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot-1", scopeKey: "repo-a", expectedChunks: 1 });
  addPendingChunk(store, generation, space, "chunk-1");
  const job = lifecycle.createJob({ generationId: generation.id, chunkId: "chunk-1" });
  completeThroughClaim(lifecycle, generation.id, job.id, "activation-test");
  assert.throws(() => lifecycle.activateGeneration(generation.id), /EMBEDDING_GENERATION_INCOMPLETE/);
  addReadyVector(store, generation, space, "chunk-1");
  const active = lifecycle.activateGeneration(generation.id);
  assert.equal(active.status, "active");
  assert.equal(store.db.prepare("SELECT generation_id FROM semantic_active_spaces WHERE scope_key='repo-a'").get().generation_id, generation.id);
  assert.equal(store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(generation.id).status, "active");
  store.close();
});

test("activation keeps the old generation recoverable and rollback restores it", () => {
  const { store, space, lifecycle } = fixture();
  const first = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot-1", scopeKey: "repo-a", expectedChunks: 1 });
  addPendingChunk(store, first, space, "chunk-a");
  const firstJob = lifecycle.createJob({ generationId: first.id, chunkId: "chunk-a" });
  completeThroughClaim(lifecycle, first.id, firstJob.id, "first-generation-test");
  addReadyVector(store, first, space, "chunk-a", 1);
  lifecycle.activateGeneration(first.id);

  const second = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot-2", scopeKey: "repo-a", expectedChunks: 1 });
  addPendingChunk(store, second, space, "chunk-b");
  const secondJob = lifecycle.createJob({ generationId: second.id, chunkId: "chunk-b" });
  completeThroughClaim(lifecycle, second.id, secondJob.id, "second-generation-test");
  addReadyVector(store, second, space, "chunk-b", 2);
  lifecycle.activateGeneration(second.id);
  assert.equal(store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(first.id).status, "retired");
  assert.equal(lifecycle.rollback("repo-a").id, first.id);
  assert.equal(store.db.prepare("SELECT generation_id FROM semantic_active_spaces WHERE scope_key='repo-a'").get().generation_id, first.id);
  assert.equal(store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(first.id).status, "active");
  store.close();
});

test("partial bootstrap activation exposes ready vectors without losing pending jobs", () => {
  const { store, space, lifecycle } = fixture();
  const generation = lifecycle.createGeneration({ spaceId: space.id, snapshotId: "snapshot-bootstrap", scopeKey: "repo-bootstrap", expectedChunks: 2 });
  addPendingChunk(store, generation, space, "chunk-bootstrap-ready");
  addPendingChunk(store, generation, space, "chunk-bootstrap-pending");
  const readyJob = lifecycle.createJob({ generationId: generation.id, chunkId: "chunk-bootstrap-ready" });
  const pendingJob = lifecycle.createJob({ generationId: generation.id, chunkId: "chunk-bootstrap-pending" });
  const claimedReady = lifecycle.claimJobs({
    ownerId: "partial-bootstrap-test",
    generationId: generation.id,
    limit: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(claimedReady.length, 1);
  assert.ok([readyJob.id, pendingJob.id].includes(claimedReady[0].id));
  lifecycle.completeClaimedJob(claimedReady[0].id, "partial-bootstrap-test");
  addReadyVector(store, generation, space, claimedReady[0].chunkId, 11);

  const active = lifecycle.activatePartialGeneration(generation.id, 1);
  assert.equal(active.status, "active");
  assert.equal(store.db.prepare("SELECT generation_id FROM semantic_active_spaces WHERE scope_key='repo-bootstrap'").get().generation_id, generation.id);
  const status = listSemanticStatuses(store, "repo-bootstrap")[0];
  assert.equal(status.state, "active");
  assert.equal(status.reason, "SEMANTIC_PARTIAL_INDEX");
  assert.equal(status.ready, 1);
  assert.equal(status.expected, 2);

  const claimed = lifecycle.claimJobs({
    ownerId: "partial-bootstrap-test",
    generationId: generation.id,
    limit: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(claimed.length, 1);
  assert.notEqual(claimed[0].id, claimedReady[0].id);
  assert.equal(claimed[0].id, pendingJob.id === claimedReady[0].id ? readyJob.id : pendingJob.id);
  store.close();
});

test("semantic controls preserve the global audit hash chain", () => {
  const { store, lifecycle } = fixture();
  const audit = new AuditStore(store);
  audit.append({
    capabilityId: "knowledge.search",
    actorId: "test",
    scopeHash: "scope-before",
    input: { query: "before" },
    resultCode: "ok",
  });

  assert.deepEqual(
    lifecycle.applyControl({ action: "pause", scopeKey: "repo-a", operationToken: "audit-control-pause" }),
    { replayed: false },
  );
  assert.deepEqual(
    lifecycle.applyControl({ action: "resume", scopeKey: "repo-a", operationToken: "audit-control-resume" }),
    { replayed: false },
  );

  audit.append({
    capabilityId: "knowledge.search",
    actorId: "test",
    scopeHash: "scope-after",
    input: { query: "after" },
    resultCode: "ok",
  });
  assert.deepEqual(audit.verify(), { ok: true });
  store.close();
});

test("concurrent semantic control replays serialize across independent connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-semantic-control-race-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  KnowledgeStore.open({ dbPath, ledgerPath }).close();

  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { EmbeddingLifecycle, KnowledgeStore } = await import(workerData.coreUrl);
      const store = KnowledgeStore.open({ dbPath: workerData.dbPath, ledgerPath: workerData.ledgerPath });
      const originalPrepare = store.db.prepare.bind(store.db);
      const gate = new Int32Array(workerData.gateBuffer);
      store.db.prepare = (sql) => {
        const statement = originalPrepare(sql);
        if (!String(sql).includes("FROM knowledge_audit_events WHERE event_id=?")) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property !== "get") {
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args) => {
              const value = target.get(...args);
              Atomics.add(gate, 0, 1);
              const deadline = Date.now() + 250;
              while (Atomics.load(gate, 0) < 2 && Date.now() < deadline) Atomics.wait(gate, 1, 0, 10);
              Atomics.store(gate, 1, 1);
              Atomics.notify(gate, 1);
              return value;
            };
          },
        });
      };
      try {
        const result = new EmbeddingLifecycle(store).applyControl({
          action: "pause",
          scopeKey: "repo:race",
          operationToken: "concurrent-operation-token",
        });
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code, message: error.message });
      } finally {
        store.close();
      }
    })();
  `;
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { coreUrl, dbPath, ledgerPath, gateBuffer },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
  });

  const outcomes = await Promise.all([run(), run()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
  assert.deepEqual(outcomes.map((outcome) => outcome.result.replayed).sort(), [false, true]);

  const verifyStore = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(verifyStore.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit_events WHERE capability_id='knowledge.semantic_control'").get().count, 1);
  assert.deepEqual(new AuditStore(verifyStore).verify(), { ok: true });
  verifyStore.close();
});

test("generic audit append and semantic control serialize on one global chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-audit-semantic-race-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  KnowledgeStore.open({ dbPath, ledgerPath }).close();

  // The generic writer pauses immediately after reading the chain tail. With
  // no write lock, the semantic writer can commit against that same tail and
  // deterministically create a fork. Under BEGIN IMMEDIATE it must wait.
  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { AuditStore, EmbeddingLifecycle, KnowledgeStore } = await import(workerData.coreUrl);
      const store = KnowledgeStore.open({ dbPath: workerData.dbPath, ledgerPath: workerData.ledgerPath });
      const gate = new Int32Array(workerData.gateBuffer);
      try {
        if (workerData.kind === "generic") {
          const originalPrepare = store.db.prepare.bind(store.db);
          store.db.prepare = (sql) => {
            const statement = originalPrepare(sql);
            if (!String(sql).includes("SELECT event_hash FROM knowledge_audit_events")) return statement;
            return new Proxy(statement, {
              get(target, property) {
                if (property !== "get") {
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                }
                return (...args) => {
                  const value = target.get(...args);
                  Atomics.store(gate, 0, 1);
                  Atomics.notify(gate, 0);
                  Atomics.wait(gate, 1, 0, 500);
                  return value;
                };
              },
            });
          };
          new AuditStore(store).append({
            capabilityId: "knowledge.search",
            actorId: "generic-worker",
            scopeHash: "generic-scope",
            input: { query: "race" },
            resultCode: "ok",
          });
        } else {
          while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0, 500);
          new EmbeddingLifecycle(store).applyControl({
            action: "pause",
            scopeKey: "repo:race",
            operationToken: "generic-semantic-race-token",
          });
          Atomics.store(gate, 1, 1);
          Atomics.notify(gate, 1);
        }
        parentPort.postMessage({ ok: true });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code, message: error.message });
      } finally {
        store.close();
      }
    })();
  `;
  const run = (kind) => new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { kind, coreUrl, dbPath, ledgerPath, gateBuffer },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
  });

  const outcomes = await Promise.all([run("generic"), run("semantic")]);
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
  const verifyStore = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(verifyStore.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit_events").get().count, 2);
  assert.deepEqual(new AuditStore(verifyStore).verify(), { ok: true });
  verifyStore.close();
});
