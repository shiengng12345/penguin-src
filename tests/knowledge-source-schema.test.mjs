import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-source-schema-"));
  return { dir, store: KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }) };
}

test("fresh database creates schema v10 source corpus tables and indexes", () => {
  const { store } = openStore();
  assert.equal(SCHEMA_VERSION, 13);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "13");
  for (const name of [
    "source_blobs",
    "source_blob_lines",
    "source_facts",
    "file_fact_sources",
    "effective_snapshot_sources",
    "source_fts",
    "source_lexical_fts",
    "source_path_fts",
  ]) {
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), name + " missing");
  }
  store.close();
});

test("v9-labelled database migration preserves existing graph and is idempotent", () => {
  const { dir, store } = openStore();
  const repoId = store.registerRepo({ name: "fixture", rootPath: "/tmp/fixture" });
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: repoId + "::legacy", repoId, title: "legacy" });
  store.db.prepare("INSERT INTO file_facts (id,repo_id,file_path,content_hash,language,parser_version,facts_json,exports_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("legacy-fact", repoId, "src/legacy.ts", "hash", "ts", "parser-v1", "{}", "exports", new Date().toISOString());
  store.db.prepare("UPDATE meta SET value='9' WHERE key='schema_version'").run();
  store.close();

  // Reopen through the current migration ladder.
  const migrated = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  assert.ok(migrated.getNode(nodeId));
  assert.ok(migrated.db.prepare("SELECT 1 FROM file_facts WHERE id='legacy-fact'").get());
  assert.equal(migrated.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "13");
  migrated.close();
  const reopened = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  assert.ok(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_blobs'").get());
  assert.ok(reopened.getNode(nodeId));
  reopened.close();
});

test("source corpus integrity queries remain orphan-free after migration", () => {
  const { store } = openStore();
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_facts sf LEFT JOIN source_blobs b ON b.id=sf.source_blob_id WHERE sf.source_blob_id IS NOT NULL AND b.id IS NULL").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_sources e LEFT JOIN source_facts sf ON sf.id=e.source_fact_id WHERE sf.id IS NULL").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM file_fact_sources f LEFT JOIN file_facts ff ON ff.id=f.file_fact_id LEFT JOIN source_facts sf ON sf.id=f.source_fact_id WHERE ff.id IS NULL OR sf.id IS NULL").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_fts f LEFT JOIN source_blobs b ON b.id=f.rowid WHERE b.id IS NULL").get().n, 0);
  store.close();
});
