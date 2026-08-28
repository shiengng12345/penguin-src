import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

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

test("fresh DB records the current schema_version", () => {
  const db = openDatabase(tempDbPath());
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(row.value, String(SCHEMA_VERSION));
  db.close();
});

test("reopening an older DB advances the stored schema_version", () => {
  const path = tempDbPath();
  // Simulate a DB written by an older build: stamp an earlier version.
  const first = openDatabase(path);
  first.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  first.close();
  // Reopen: migrate() runs (idempotent) and the version must be bumped, not
  // left lying at 1 (the bug this hardening fixes).
  const db = openDatabase(path);
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(row.value, String(SCHEMA_VERSION));
  // Data-bearing tables survive the reopen (additive migration, no rebuild).
  assert.ok(
    db.prepare("PRAGMA table_info(edges)").all().some((c) => c.name === "status"),
    "edges.status must remain after migration",
  );
  db.close();
});

test("steady-state open is read-only: succeeds while another connection holds the write lock", () => {
  const path = tempDbPath();
  openDatabase(path).close(); // create + migrate to current schema
  // A long-running writer (e.g. a multi-minute rebuild transaction) holds THE
  // write lock. Opening for a read command (status/search) must not need a
  // single write in steady state — otherwise every CLI open dies with
  // SQLITE_BUSY after busy_timeout, which is exactly the reported failure.
  const writer = openDatabase(path);
  writer.exec("BEGIN IMMEDIATE");
  let db;
  try {
    db = openDatabase(path);
    assert.ok(db.prepare("SELECT 1 FROM ledger_state WHERE id='main'").get(), "opened and readable");
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  db.close();
});

test("opening a DB from a newer build fails loud instead of silently downgrading", () => {
  const path = tempDbPath();
  const first = openDatabase(path);
  first.prepare("UPDATE meta SET value = '9999' WHERE key = 'schema_version'").run();
  first.close();
  assert.throws(() => openDatabase(path), /newer than this build/);
});

// A column added to the branches DDL but not to isSchemaCurrent's required
// list makes the whole migration block unreachable: openDatabase declares the
// schema current, the ALTER never runs, and existing databases silently keep
// the old shape. That happened with resolver_version — this pins the general
// case by dropping each migrated column and checking it comes back.
test("reopening a database restores any dropped branches column", () => {
  const path = tempDbPath();
  const migrated = [
    "pinned",
    "indexed_worktree_state",
    "indexed_worktree_fingerprint",
    "indexed_dirty_files",
    "parser_version",
    "resolver_version",
    "indexed_schema_version",
    "stale_reason",
  ];
  for (const column of migrated) {
    const before = openDatabase(path);
    before.exec(`ALTER TABLE branches DROP COLUMN ${column}`);
    before.close();

    const after = openDatabase(path);
    const columns = after.prepare("PRAGMA table_info(branches)").all().map((c) => c.name);
    after.close();
    assert.ok(
      columns.includes(column),
      `${column} was dropped and openDatabase did not restore it — it is missing from isSchemaCurrent's required list, so the migration block is skipped`,
    );
  }
});
