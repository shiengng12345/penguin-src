import Database from "better-sqlite3";

// spec §3.2 全量表。核心关系模型不用 SQLite 专有特性（D4）；
// FTS5 虚表是可随时 drop 重建的加速索引，不属于核心模型。
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  head_commit TEXT,
  last_indexed_commit TEXT,
  last_indexed_at TEXT,
  checkout_path TEXT,
  status TEXT NOT NULL,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  repo_id TEXT,
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (node_type, identity_key)
);

CREATE TABLE IF NOT EXISTS node_aliases (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  alias_key TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  current_identity_key TEXT,
  valid_from TEXT,
  valid_to TEXT,
  reason TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  UNIQUE (node_id, alias_key, alias_type)
);

CREATE TABLE IF NOT EXISTS symbol_versions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  commit_sha TEXT NOT NULL,
  file_path TEXT NOT NULL,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  UNIQUE (node_id, branch_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL REFERENCES nodes(id),
  dst TEXT REFERENCES nodes(id),
  raw_target TEXT,
  edge_type TEXT NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  origin TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  provenance TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'   -- active | suggested (pending AI edge) | rejected
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
-- Composite indexes for the hot traversal shapes (who_calls/calls_of/backlinks
-- filter by endpoint + edge_type + status; repoGraph by branch + status).
CREATE INDEX IF NOT EXISTS idx_edges_dst_type_status ON edges(dst, edge_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_src_type_status ON edges(src, edge_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_branch_status ON edges(branch_id, status);
-- serviceGraph filters edges by edge_type + status alone (handles/invokes/
-- depends_on, no src/dst anchor). The composite indexes above lead with src/dst
-- so they can't serve it — without this the query full-scans the whole edges
-- table (~240k rows → the "服务图" froze for ~2.7s). Leads with edge_type.
CREATE INDEX IF NOT EXISTS idx_edges_type_status ON edges(edge_type, status);

CREATE TABLE IF NOT EXISTS files_index (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  file_path TEXT NOT NULL,
  lang TEXT,
  mtime_ms INTEGER,
  size_bytes INTEGER,
  content_hash TEXT,
  indexed_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  UNIQUE (repo_id, branch_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_files_index_scope ON files_index(repo_id, branch_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ledger_seq INTEGER,
  ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id),
  edge_id TEXT REFERENCES edges(id),
  branch_id TEXT REFERENCES branches(id),
  repo_id TEXT REFERENCES repos(id),
  workspace_id TEXT REFERENCES workspaces(id),
  origin TEXT NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS ledger_state (
  id TEXT PRIMARY KEY,
  materialized_seq INTEGER NOT NULL DEFAULT 0,
  materialized_at TEXT,
  ledger_checksum TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  PRIMARY KEY (workspace_id, repo_id)
);

CREATE TABLE IF NOT EXISTS notes_index (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  path TEXT NOT NULL UNIQUE,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  sensitive INTEGER NOT NULL DEFAULT 0,
  ai_access TEXT NOT NULL DEFAULT 'allowed',
  mcp_access TEXT NOT NULL DEFAULT 'allowed',
  content_hash TEXT NOT NULL
);

-- NOTE (model decision): entities are modelled as ordinary nodes rows
-- (node_type=entity) created by fusion when a note mentions one — that is the
-- canonical representation used by search/graph. This standalone table is NOT
-- written or read by any code path; it is kept only to avoid a destructive
-- migration on existing DBs. Do not add new dependencies on it.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  UNIQUE (entity_type, normalized_value)
);

-- Runtime response samples captured for an endpoint (Penguin is itself a
-- REST/gRPC client, so it can feed REAL responses back into the graph). Not
-- parser-derivable → written only via the ledger (response_sample_captured),
-- materialized here; survives a parser rebuild like notes/manual edges.
CREATE TABLE IF NOT EXISTS response_samples (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  endpoint_key TEXT NOT NULL,
  status TEXT,
  content_type TEXT,
  sample TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_response_samples_endpoint ON response_samples(endpoint_id);

CREATE TABLE IF NOT EXISTS credential_entries (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
  node_id UNINDEXED, title, body
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
  node_id UNINDEXED, name, signature
);
`;

export const SCHEMA_VERSION = 5;

// Idempotent additive migrations for schemas that predate SCHEMA_VERSION.
// Each step guards on actual schema state (column presence) rather than the
// stored version, so a mislabeled version can't corrupt an already-migrated
// DB — and CREATE TABLE/INDEX IF NOT EXISTS in DDL already covers new *tables*.
// `from` is the version read from meta; gate future NON-idempotent steps on it
// (e.g. `if (from < 5) { ...backfill... }`). Additive column adds stay in the
// idempotent guards below and need no version gate.
function migrate(db: Database.Database, _from: number): void {
  const edgeCols = (db.prepare("PRAGMA table_info(edges)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!edgeCols.includes("status")) {
    db.exec("ALTER TABLE edges ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
}

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // 有意不开 foreign_keys：删库后 Ledger 先重放（§2.1 三源重建），
  // 此时被引用的 nodes 尚未由上层索引器重建——引用完整性由
  // 「账本 + 全量重建流程」保证，不靠 SQLite 外键（D4）。
  db.pragma("foreign_keys = OFF");

  // A fresh DB has no tables yet — DDL below builds it at the current schema,
  // so only a PRE-EXISTING DB needs the migration ladder. Detect that before
  // DDL creates `meta`.
  const preexisting =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'")
      .get() != null;

  db.exec(DDL);

  const storedVersion = preexisting
    ? Number(
        (
          db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
            | { value: string }
            | undefined
        )?.value ?? 1,
      )
    : SCHEMA_VERSION;

  // Fail loud on a DB written by a newer build — operating on it with an older
  // schema would silently drop/misread columns (§9 绝不静默降级).
  if (storedVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `knowledge.db schema_version ${storedVersion} is newer than this build ` +
        `supports (${SCHEMA_VERSION}); upgrade Penguin before opening it.`,
    );
  }

  migrate(db, storedVersion);

  // Upsert (NOT INSERT OR IGNORE): after a successful migration the stored
  // version must actually advance to the code's version, so future opens gate
  // correctly instead of the number lying forever.
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
  db.prepare(
    "INSERT OR IGNORE INTO ledger_state (id, materialized_seq) VALUES ('main', 0)",
  ).run();
  return db;
}
