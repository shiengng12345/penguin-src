import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-schema-v14-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

test("schema version is 14 and new objects exist", () => {
  const store = freshStore();
  assert.equal(SCHEMA_VERSION, 14);
  const stored = store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coverage_layers'").get();
  assert.ok(table, "coverage_layers table missing");
  const cols = store.db.prepare("PRAGMA table_info(edges)").all().map((c) => c.name);
  assert.ok(cols.includes("evidence_id"), "edges.evidence_id missing");
  assert.ok(cols.includes("boundary"), "edges.boundary missing");
  store.close();
});

test("migration upgrades a v13 store idempotently", () => {
  const store = freshStore();
  // Simulate a pre-bump database: strip the new objects and mark it v13.
  store.db.exec("DROP TABLE coverage_layers");
  store.db.prepare("UPDATE meta SET value='13' WHERE key='schema_version'").run();
  const dbPath = store.db.name;
  store.close();
  const reopened = KnowledgeStore.open({ dbPath, ledgerPath: dbPath.replace(/knowledge\.db$/, "ledger.jsonl") });
  const stored = reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  assert.ok(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='coverage_layers'").get());
  reopened.close();
});
