import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-schema-v15-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

test("schema version is 18 and endpoint identity objects exist", () => {
  const store = freshStore();
  assert.equal(SCHEMA_VERSION, 18);
  const stored = store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 18);
  const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coverage_layers'").get();
  assert.ok(table, "coverage_layers table missing");
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='endpoint_aliases'").get(), "endpoint_aliases table missing");
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='endpoint_memberships'").get(), "endpoint_memberships table missing");
  const cols = store.db.prepare("PRAGMA table_info(edges)").all().map((c) => c.name);
  assert.ok(cols.includes("evidence_id"), "edges.evidence_id missing");
  assert.ok(cols.includes("boundary"), "edges.boundary missing");
  store.close();
});

test("schema installs semantic reuse performance indexes without a version bump", () => {
  const store = freshStore();
  const indexes = new Set(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name),
  );
  assert.ok(indexes.has("idx_semantic_chunks_snapshot"));
  assert.ok(indexes.has("idx_semantic_chunks_reuse"));
  assert.ok(indexes.has("idx_semantic_embedding_refs_reuse"));
  assert.equal(Number(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  store.close();
});

test("migration upgrades an empty v13 store idempotently", () => {
  const store = freshStore();
  // Simulate a pre-bump database: strip the new objects and mark it v13.
  store.db.exec("DROP TABLE coverage_layers");
  // Also strip the two new edges columns so the reopen genuinely exercises
  // the `ALTER TABLE edges ADD COLUMN` guards in migrate(), not just the
  // CREATE TABLE IF NOT EXISTS path (a v14-built store already has both
  // columns, so without this the ADD COLUMN branches never run).
  store.db.exec("ALTER TABLE edges DROP COLUMN evidence_id");
  store.db.exec("ALTER TABLE edges DROP COLUMN boundary");
  store.db.prepare("UPDATE meta SET value='13' WHERE key='schema_version'").run();
  const dbPath = store.db.name;
  store.close();
  const reopened = KnowledgeStore.open({ dbPath, ledgerPath: dbPath.replace(/knowledge\.db$/, "ledger.jsonl") });
  const stored = reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 18);
  assert.ok(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='coverage_layers'").get());
  const cols = reopened.db.prepare("PRAGMA table_info(edges)").all().map((c) => c.name);
  assert.ok(cols.includes("evidence_id"), "edges.evidence_id missing after migration");
  assert.ok(cols.includes("boundary"), "edges.boundary missing after migration");
  reopened.close();
});

test("migration upgrades v14 repository and branch metadata without requiring reindex", () => {
  const store = freshStore();
  const repoId = store.registerRepo({ name: "metadata-only", rootPath: "/fixture/metadata-only" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  store.db.exec("DROP TABLE endpoint_memberships; DROP TABLE endpoint_aliases;");
  store.db.prepare("UPDATE meta SET value='14' WHERE key='schema_version'").run();
  const dbPath = store.db.name;
  store.close();

  const reopened = KnowledgeStore.open({
    dbPath,
    ledgerPath: dbPath.replace(/knowledge\.db$/, "ledger.jsonl"),
  });
  assert.equal(Number(reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  assert.deepEqual(reopened.db.prepare("SELECT id FROM repos").all(), [{ id: repoId }]);
  assert.deepEqual(reopened.db.prepare("SELECT id FROM branches").all(), [{ id: branchId }]);
  assert.ok(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='endpoint_aliases'").get());
  assert.ok(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='endpoint_memberships'").get());
  reopened.close();
});

test("migration adds v17 semantic reference columns before creating their index", () => {
  const store = freshStore();
  // Reproduce a real v15 table: semantic_embedding_refs already exists, but
  // the v17 generation/space columns and their composite index do not.
  store.db.exec("DROP INDEX idx_semantic_embedding_refs_generation");
  store.db.exec("DROP INDEX idx_semantic_embedding_refs_reuse");
  store.db.exec("ALTER TABLE semantic_embedding_refs DROP COLUMN generation_id");
  store.db.exec("ALTER TABLE semantic_embedding_refs DROP COLUMN space_id");
  store.db.prepare("UPDATE meta SET value='15' WHERE key='schema_version'").run();
  const dbPath = store.db.name;
  store.close();

  const reopened = KnowledgeStore.open({
    dbPath,
    ledgerPath: dbPath.replace(/knowledge\.db$/, "ledger.jsonl"),
  });
  const columns = reopened.db.prepare("PRAGMA table_info(semantic_embedding_refs)").all().map((column) => column.name);
  assert.ok(columns.includes("generation_id"));
  assert.ok(columns.includes("space_id"));
  assert.ok(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_semantic_embedding_refs_generation'").get());
  assert.equal(Number(reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  reopened.close();
});

test("opening a v14 index with indexed data reports REINDEX_REQUIRED", () => {
  const store = freshStore();
  const repoId = store.registerRepo({ name: "old-index", rootPath: "/fixture/old-index" });
  store.registerBranch({ repoId, name: "main", status: "live" });
  store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::Inventory.getthing",
    repoId: null,
    title: "gRPC Inventory.GetThing",
  });
  store.db.prepare("UPDATE meta SET value='14' WHERE key='schema_version'").run();
  const dbPath = store.db.name;
  store.close();

  assert.throws(
    () => KnowledgeStore.open({ dbPath, ledgerPath: dbPath.replace(/knowledge\.db$/, "ledger.jsonl") }),
    (error) => error?.code === "REINDEX_REQUIRED" && /REINDEX_REQUIRED/.test(error.message),
  );
});
