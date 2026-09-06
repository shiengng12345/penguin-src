import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  chunkIdentity,
  embeddingSpaceIdentity,
} from "../packages/knowledge-core/dist/index.js";

const chunkBase = {
  repoId: "repo-a",
  snapshotId: "snapshot-1",
  canonicalFilePath: "src/payment.ts",
  nodeId: "node:payment",
  startByte: 0,
  endByte: 48,
  contentHash: "a".repeat(64),
  chunkerVersion: "chunker-v2",
};

const spaceBase = {
  providerId: "local-onnx",
  modelId: "bge-small",
  weightsDigest: "b".repeat(64),
  tokenizerDigest: "c".repeat(64),
  dimensions: 384,
  pooling: "mean",
  normalization: "l2",
  chunkerVersion: "chunker-v2",
  preprocessingDigest: "d".repeat(64),
};

test("chunk identity includes repository, revision, path, range, content, and chunker", () => {
  const first = chunkIdentity(chunkBase);
  const otherFile = chunkIdentity({ ...chunkBase, canonicalFilePath: "src/refund.ts" });
  const otherRepo = chunkIdentity({ ...chunkBase, repoId: "repo-b" });
  const otherRange = chunkIdentity({ ...chunkBase, startByte: 49, endByte: 97 });

  assert.match(first.id, /^chunk_[a-f0-9]{64}$/);
  assert.equal(first.id, chunkIdentity({ ...chunkBase }).id);
  assert.notEqual(first.id, otherFile.id);
  assert.notEqual(first.id, otherRepo.id);
  assert.notEqual(first.id, otherRange.id);
  assert.deepEqual(first.provenance, {
    repoId: "repo-a",
    snapshotId: "snapshot-1",
    canonicalFilePath: "src/payment.ts",
    nodeId: "node:payment",
    startByte: 0,
    endByte: 48,
    contentHash: "a".repeat(64),
    chunkerVersion: "chunker-v2",
  });
});

test("embedding space identity changes for every model/tokenizer/pooling dimension input", () => {
  const first = embeddingSpaceIdentity(spaceBase);
  assert.match(first.id, /^space_[a-f0-9]{64}$/);
  for (const change of [
    { modelId: "bge-base" },
    { weightsDigest: "d".repeat(64) },
    { tokenizerDigest: "e".repeat(64) },
    { dimensions: 768 },
    { pooling: "cls" },
    { normalization: "none" },
    { chunkerVersion: "chunker-v3" },
    { preprocessingDigest: "e".repeat(64) },
  ]) {
    assert.notEqual(first.id, embeddingSpaceIdentity({ ...spaceBase, ...change }).id, JSON.stringify(change));
  }
});

test("current schema retains v17 lifecycle tables and old semantic rows are not served as ready", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-semantic-identity-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "18");
  for (const table of ["embedding_spaces", "embedding_generations", "embedding_jobs", "semantic_active_spaces"]) {
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} missing`);
  }
  for (const column of ["repo_id", "snapshot_id", "canonical_file_path", "identity_hash", "chunker_version"]) {
    assert.ok(store.db.prepare("SELECT 1 FROM pragma_table_info('semantic_chunks') WHERE name=?").get(column), `${column} missing`);
  }
  store.db.prepare("INSERT INTO semantic_chunks(id,content_hash,source_blob_id,node_id,start_byte,end_byte,chunk_kind,text_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("legacy-chunk", "a".repeat(64), null, null, 0, 4, "paragraph", "a".repeat(64), new Date().toISOString());
  store.db.prepare("INSERT INTO embedding_models(model_hash,provider_id,model_id,dimensions,vec_table_name,installed_at) VALUES (?,?,?,?,?,?)")
    .run("legacy-model", "legacy", "legacy", 2, "vec_legacy", new Date().toISOString());
  store.db.prepare("INSERT INTO semantic_embedding_refs(model_hash,chunk_id,vec_rowid,status,error,embedded_at) VALUES (?,?,?,?,?,?)")
    .run("legacy-model", "legacy-chunk", 1, "ready", null, new Date().toISOString());
  store.db.prepare("UPDATE meta SET value='16' WHERE key='schema_version'").run();
  store.close();

  const reopened = KnowledgeStore.open({ dbPath, ledgerPath });
  const legacy = reopened.db.prepare("SELECT status,generation_id,space_id FROM semantic_embedding_refs WHERE chunk_id='legacy-chunk'").get();
  assert.equal(legacy.status, "legacy");
  assert.equal(legacy.generation_id, null);
  assert.equal(legacy.space_id, null);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM semantic_active_spaces").get().n, 0);
  reopened.close();
});
