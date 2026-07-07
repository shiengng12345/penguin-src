import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../packages/knowledge-core/dist/index.js";

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), "pk-db-")), "knowledge.db");
}

const EXPECTED_TABLES = [
  "repos", "branches", "nodes", "node_aliases", "symbol_versions",
  "edges", "events", "ledger_state", "workspaces", "workspace_repos",
  "notes_index", "entities", "meta",
];

test("openDatabase creates all tables and FTS virtual tables", () => {
  const db = openDatabase(tempDbPath());
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r) => r.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  assert.ok(names.includes("fts_notes"), "missing fts_notes");
  assert.ok(names.includes("fts_symbols"), "missing fts_symbols");
  db.close();
});

test("openDatabase is idempotent and seeds ledger_state", () => {
  const path = tempDbPath();
  openDatabase(path).close();
  const db = openDatabase(path);
  const row = db.prepare("SELECT * FROM ledger_state WHERE id = 'main'").get();
  assert.equal(row.materialized_seq, 0);
  db.close();
});

test("openDatabase enables WAL", () => {
  const db = openDatabase(tempDbPath());
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  db.close();
});

test("events table has origin, method, ledger_seq, workspace_id columns", () => {
  const db = openDatabase(tempDbPath());
  const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  for (const c of ["origin", "method", "ledger_seq", "workspace_id"]) {
    assert.ok(cols.includes(c), `events missing column: ${c}`);
  }
  db.close();
});

test("foreign_keys is explicitly OFF — ledger replay may write edges before nodes exist", () => {
  const db = openDatabase(tempDbPath());
  assert.equal(db.pragma("foreign_keys", { simple: true }), 0);
  db.prepare(
    "INSERT INTO edges (id, src, dst, edge_type, origin, method) VALUES ('e1','no-such-node',NULL,'wikilink','user','ASSERTED')",
  ).run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM edges").get().n, 1);
  db.close();
});
