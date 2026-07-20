import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { EvidenceStore, ExternalSourceStore, KnowledgeStore, syncPostgresSchema } from "../packages/knowledge-core/dist/index.js";

function open() {
  const dir = mkdtempSync(join(tmpdir(), "pk-pg-schema-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("Postgres source introspects schema metadata only and creates immutable revisions", async () => {
  const store = open();
  const credentialNode = store.upsertNode({ nodeType: "credential", identityKey: "credential:test-pg", title: "test postgres" });
  store.putCredential({ nodeId: credentialNode, title: "test postgres", kind: "postgres", body: "never returned" });
  const source = new ExternalSourceStore(store).register({ type: "postgres_schema", location: "postgres://schema-only", config: { credentialEntryId: credentialNode, schemas: ["public"] } });
  const seen = [];
  const firstClient = { query: async (sql) => { seen.push(sql); if (sql.includes("information_schema.columns")) return { rows: [{ table_schema: "public", table_name: "players", column_name: "cpf", data_type: "text", is_nullable: "NO", ordinal_position: 1 }] }; if (sql.includes("information_schema.table_constraints")) return { rows: [{ table_schema: "public", table_name: "players", constraint_name: "players_pkey", constraint_type: "PRIMARY KEY" }] }; return { rows: [{ routine_schema: "public", routine_name: "find_player", routine_type: "FUNCTION", data_type: "record" }] }; } };
  const first = await syncPostgresSchema(store, source.id, firstClient);
  assert.equal(first.tables, 1);
  assert.equal(first.columns, 1);
  assert.equal(first.functions, 1);
  assert.ok(seen.every((sql) => sql.includes("information_schema")));
  assert.ok(seen.every((sql) => !/\bSELECT\s+\*\s+FROM\s+(?!information_schema)/i.test(sql)));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM revision_snapshots WHERE repo_id=?").get(first.repoId).n, 1);
  const evidence = new EvidenceStore(store);
  evidence.put({ id: "pg-evidence", status: "reviewed", sourceType: "code", locator: "postgres-schema.json", contentHash: first.source.contentHash, redactionPolicy: "metadata-only", claimIds: [] });
  const second = await syncPostgresSchema(store, source.id, { query: async (sql) => sql.includes("columns") ? { rows: [{ table_schema: "public", table_name: "players", column_name: "display_name", data_type: "text", is_nullable: "YES", ordinal_position: 1 }] } : { rows: [] } });
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(evidence.get("pg-evidence").status, "stale");
  store.close();
});

test("Postgres source requires a credential entry reference", () => {
  const store = open();
  assert.throws(() => new ExternalSourceStore(store).register({ type: "postgres_schema", location: "postgres://schema-only", config: {} }), /POSTGRES_CREDENTIAL_ENTRY_REQUIRED/);
  store.close();
});
