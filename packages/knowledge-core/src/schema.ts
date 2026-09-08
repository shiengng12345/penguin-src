import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

// Lazy, `require()`-based load — deliberately NOT a static `import` of this
// native module. A static ESM import of an external package is hoisted and
// resolved at module-LINK time, before any code runs; that crashes the whole
// process in a bundle that ships with zero node_modules (e.g. the MCP
// server's release package) even when openDatabase() is never called there.
// A plain function call has no such hoisting — it only resolves (and can only
// fail) at the moment a DB is actually opened.
let DatabaseCtor: typeof Database | null = null;
function loadDatabaseCtor(): typeof Database {
  if (!DatabaseCtor) {
    DatabaseCtor = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
  }
  return DatabaseCtor;
}

const EDGE_REPLACEMENT_INDEX_NAMES = [
  "idx_edges_parser_branch_file",
  "idx_edges_parser_global_repo_file",
  "idx_symbol_versions_branch_file_status",
  "idx_nodes_log_site_repo_file",
  "idx_nodes_identity",
  "idx_nodes_identity_nocase",
  "idx_resolved_edges_set_type_src",
  "idx_resolved_edges_set_type_dst",
  "idx_resolved_edges_src_type_set",
  "idx_resolved_edges_dst_type_set",
  "idx_revision_endpoint_occurrences_filter",
  "idx_revision_endpoint_occurrences_page",
  "idx_unresolved_reference_items_revision_reason",
] as const;

// replaceFileEdges() deletes parser output by the exact JSON provenance
// expressions below once per indexed file. Without matching expression and
// partial indexes, each delete walks millions of edges during a full rebuild.
const EDGE_REPLACEMENT_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_parser_branch_file
  ON edges(branch_id, json_extract(provenance, '$.file'))
  WHERE origin = 'parser';

CREATE INDEX IF NOT EXISTS idx_edges_parser_global_repo_file
  ON edges(
    json_extract(provenance, '$.repo'),
    json_extract(provenance, '$.file')
  )
  WHERE branch_id IS NULL AND origin = 'parser';

-- priorSymbols() and markFileSymbolsStale() run once per rebuilt file. The
-- node/branch uniqueness index starts with node_id, so it cannot serve this
-- branch+file access path and otherwise forces a full symbol_versions scan.
CREATE INDEX IF NOT EXISTS idx_symbol_versions_branch_file_status
  ON symbol_versions(branch_id, file_path, status);

-- clearLogSitesForFile() replaces parser-owned log nodes once per file. Match
-- its exact JSON expression so SQLite does not scan every log site in a repo.
CREATE INDEX IF NOT EXISTS idx_nodes_log_site_repo_file
  ON nodes(repo_id, json_extract(meta, '$.filePath'))
  WHERE node_type = 'log_site';

-- Symbol and endpoint identity resolution is a hot path for graph traversal.
-- Keep both the normal and compatibility case-insensitive lookups indexed;
-- a NOCASE predicate on an unindexed identity column turns every node hop into
-- a full-table scan on a multi-repository database.
CREATE INDEX IF NOT EXISTS idx_nodes_identity
  ON nodes(identity_key);

CREATE INDEX IF NOT EXISTS idx_nodes_identity_nocase
  ON nodes(identity_key COLLATE NOCASE);

-- Endpoint inventory traverses immutable publication edges in both
-- directions. The old resolution_set-only index still scanned every edge in
-- a large snapshot before applying edge type and endpoint identity.
CREATE INDEX IF NOT EXISTS idx_resolved_edges_set_type_src
  ON resolved_edges(resolution_set_id, edge_type, src_identity_key);

CREATE INDEX IF NOT EXISTS idx_resolved_edges_set_type_dst
  ON resolved_edges(resolution_set_id, edge_type, dst_identity_key);

-- Scoped revision readers filter by one endpoint identity first, while the
-- snapshot contributes thousands of resolution sets. The set-first indexes
-- above are ideal for publication materialization, but make this read path
-- fall back to a full resolved_edges scan on a large snapshot.
CREATE INDEX IF NOT EXISTS idx_resolved_edges_src_type_set
  ON resolved_edges(src_identity_key, edge_type, resolution_set_id);

CREATE INDEX IF NOT EXISTS idx_resolved_edges_dst_type_set
  ON resolved_edges(dst_identity_key, edge_type, resolution_set_id);

CREATE INDEX IF NOT EXISTS idx_revision_endpoint_occurrences_filter
  ON revision_endpoint_occurrences(snapshot_id, provenance_kind, protocol, endpoint_identity_key, file_path);

CREATE INDEX IF NOT EXISTS idx_revision_endpoint_occurrences_page
  ON revision_endpoint_occurrences(snapshot_id, endpoint_identity_key, endpoint_node_id);

-- Endpoint publication receipts filter ambiguous references by repository,
-- exact revision and reason. The older scope index has branch_id between
-- repo_id and revision_id, so it cannot serve this read path.
CREATE INDEX IF NOT EXISTS idx_unresolved_reference_items_revision_reason
  ON unresolved_reference_items(repo_id, revision_id, reason_code, file_path, start_line, id);
`;

export type SchemaMaintenanceEvent =
  | {
      operation: "edge-replacement-indexes";
      phase: "start" | "complete";
      indexes: readonly string[];
      elapsedMs?: number;
    }
  | {
      operation: "fts-row-maps";
      phase: "start" | "complete";
      symbolRows?: number;
      identifierRows?: number;
      elapsedMs?: number;
    }
  | {
      operation: "schema-migration-backup";
      phase: "start" | "after-vacuum-before-identity" | "after-vacuum" | "before-publish" | "before-backup-retry" | "before-remove" | "after-backup-quarantine" | "before-orphan-attempt-quarantine" | "complete";
      path: string;
      fromVersion: number;
      toVersion: number;
      elapsedMs?: number;
    };

export interface OpenDatabaseOptions {
  allowSchemaMutation?: boolean;
  /**
   * Open an existing current database for a guarded maintenance operation
   * without normal write-path housekeeping. Reset/recovery must not turn a
   * control-plane command into a multi-gigabyte startup scan.
   */
  skipMaintenance?: boolean;
  /** Compatibility probe used by older bundled runtimes before any persistent
   * SQLite PRAGMA or DDL. Production callers normally use SCHEMA_VERSION. */
  supportedSchemaVersion?: number;
  onSchemaMaintenance?: (event: SchemaMaintenanceEvent) => void;
}

// spec §3.2 全量表。核心关系模型不用 SQLite 专有特性（D4）；
// FTS5 虚表是可随时 drop 重建的加速索引，不属于核心模型。
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value)
VALUES ('endpoint_inventory_generation', '0');

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
  indexed_worktree_state TEXT NOT NULL DEFAULT 'unknown',
  indexed_worktree_fingerprint TEXT,
  indexed_dirty_files TEXT NOT NULL DEFAULT '[]',
  parser_version TEXT,
  resolver_version TEXT,
  indexed_schema_version INTEGER,
  stale_reason TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  default_branch INTEGER NOT NULL DEFAULT 0,
  base_branch_name TEXT,
  merge_base_commit TEXT,
  current_snapshot_id TEXT,
  last_accessed_at TEXT,
  deleted_at TEXT,
  recover_until TEXT,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS git_commits (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree_hash TEXT,
  parent_shas TEXT NOT NULL DEFAULT '[]',
  committed_at TEXT,
  history_state TEXT NOT NULL DEFAULT 'complete',
  PRIMARY KEY (repo_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS revision_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_key TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  commit_sha TEXT,
  worktree_fingerprint TEXT,
  parser_version TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  base_snapshot_id TEXT,
  merge_base_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('building','ready','failed','cold')),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  last_accessed_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_revision_snapshots_repo_commit
  ON revision_snapshots(repo_id, commit_sha);

CREATE TABLE IF NOT EXISTS deployment_revisions (
  target_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  deployed_from TEXT NOT NULL,
  deployed_to TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (target_id, repo_id, deployed_from)
);

CREATE TABLE IF NOT EXISTS revision_references (
  ref_type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  snapshot_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ref_type, ref_key, repo_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_revision_references_snapshot
  ON revision_references(snapshot_id);

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
-- Hot path for parser resolution: every call/type reference looks up symbols
-- by exact bare title inside one repo. Without this, suffix identity_key LIKE
-- scans make full rebuild second-pass resolution quadratic on large repos.
CREATE INDEX IF NOT EXISTS idx_nodes_repo_type_title ON nodes(repo_id, node_type, title);

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

-- Parser-derived aliases are rebuildable index data. They must not share the
-- ledger-materialized node_aliases table, whose rows represent durable user/
-- AI knowledge events rather than endpoint extraction facts.
CREATE TABLE IF NOT EXISTS endpoint_aliases (
  endpoint_id TEXT NOT NULL REFERENCES nodes(id),
  alias_key TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, alias_key)
);
CREATE INDEX IF NOT EXISTS idx_endpoint_aliases_lookup
  ON endpoint_aliases(alias_key COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS endpoint_memberships (
  endpoint_id TEXT NOT NULL REFERENCES nodes(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  role TEXT NOT NULL CHECK (role IN ('provider','consumer','declaration')),
  file_path TEXT NOT NULL,
  locator_node_id TEXT REFERENCES nodes(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, repo_id, role, file_path)
);
CREATE INDEX IF NOT EXISTS idx_endpoint_memberships_repo_role
  ON endpoint_memberships(repo_id, role, endpoint_id);
CREATE INDEX IF NOT EXISTS idx_endpoint_memberships_endpoint
  ON endpoint_memberships(endpoint_id, repo_id, role);

-- Repo-less endpoint inventory cursors need a truthful O(1) publication
-- revision. These are required schema objects: a current-version database
-- without them is unsafe for cursor reads until a writable open installs the
-- additive metadata migration.
CREATE TRIGGER IF NOT EXISTS trg_endpoint_inventory_nodes_insert
AFTER INSERT ON nodes WHEN NEW.node_type = 'endpoint'
BEGIN
  UPDATE meta
     SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
   WHERE key = 'endpoint_inventory_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_endpoint_inventory_nodes_update
AFTER UPDATE ON nodes WHEN OLD.node_type = 'endpoint' OR NEW.node_type = 'endpoint'
BEGIN
  UPDATE meta
     SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
   WHERE key = 'endpoint_inventory_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_endpoint_inventory_nodes_delete
AFTER DELETE ON nodes WHEN OLD.node_type = 'endpoint'
BEGIN
  UPDATE meta
     SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
   WHERE key = 'endpoint_inventory_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_endpoint_inventory_memberships_insert
AFTER INSERT ON endpoint_memberships
BEGIN
  UPDATE meta
     SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
   WHERE key = 'endpoint_inventory_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_endpoint_inventory_memberships_update
AFTER UPDATE ON endpoint_memberships
BEGIN
  UPDATE meta
     SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
   WHERE key = 'endpoint_inventory_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_endpoint_inventory_memberships_delete
AFTER DELETE ON endpoint_memberships
BEGIN
  UPDATE meta
     SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
   WHERE key = 'endpoint_inventory_generation';
END;

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
  status TEXT NOT NULL DEFAULT 'active',  -- active | suggested (pending AI edge) | rejected
  source_type TEXT,                       -- e.g. frontend_web/frontend_mobile provenance tag
  evidence_id TEXT,                       -- links to trust_evidence backing this edge
  boundary TEXT                           -- di | interface | callback | event, or NULL
);
-- Composite indexes for the hot traversal shapes (who_calls/calls_of/backlinks
-- filter by endpoint + edge_type + status; repoGraph by branch + status).
-- Single-column idx_edges_src/idx_edges_dst were dropped (2026-08-28): the
-- composite indexes below serve bare src=?/dst=? lookups via their prefix
-- (EXPLAIN-verified SEARCH, not SCAN) and the pair cost 220MB of pure overlap.
CREATE INDEX IF NOT EXISTS idx_edges_dst_type_status ON edges(dst, edge_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_src_type_status ON edges(src, edge_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_branch_status ON edges(branch_id, status);
-- serviceGraph filters edges by edge_type + status alone (handles/invokes/
-- depends_on, no src/dst anchor). The composite indexes above lead with src/dst
-- so they can't serve it — without this the query full-scans the whole edges
-- table (~240k rows → the "服务图" froze for ~2.7s). Leads with edge_type.
CREATE INDEX IF NOT EXISTS idx_edges_type_status ON edges(edge_type, status);

-- Content-addressed summary of one parser-owned file edge set. Rebuild still
-- parses every file, but unchanged graph output can avoid deleting/reinserting
-- thousands of identical edges and updating every secondary edge index.
CREATE TABLE IF NOT EXISTS parser_edge_sets (
  repo_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  edge_count INTEGER NOT NULL,
  edge_fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch_id, file_path)
);
CREATE TRIGGER IF NOT EXISTS trg_parser_edge_sets_insert
AFTER INSERT ON edges WHEN NEW.origin = 'parser'
BEGIN
  DELETE FROM parser_edge_sets
   WHERE file_path = json_extract(NEW.provenance, '$.file')
     AND (
       (NEW.branch_id IS NOT NULL AND branch_id = NEW.branch_id)
       OR
       (NEW.branch_id IS NULL AND repo_id = json_extract(NEW.provenance, '$.repo'))
     );
END;
CREATE TRIGGER IF NOT EXISTS trg_parser_edge_sets_delete
AFTER DELETE ON edges WHEN OLD.origin = 'parser'
BEGIN
  DELETE FROM parser_edge_sets
   WHERE file_path = json_extract(OLD.provenance, '$.file')
     AND (
       (OLD.branch_id IS NOT NULL AND branch_id = OLD.branch_id)
       OR
       (OLD.branch_id IS NULL AND repo_id = json_extract(OLD.provenance, '$.repo'))
     );
END;
CREATE TRIGGER IF NOT EXISTS trg_parser_edge_sets_update
AFTER UPDATE ON edges WHEN OLD.origin = 'parser' OR NEW.origin = 'parser'
BEGIN
  DELETE FROM parser_edge_sets
   WHERE (
     file_path = json_extract(OLD.provenance, '$.file')
     AND (
       (OLD.branch_id IS NOT NULL AND branch_id = OLD.branch_id)
       OR
       (OLD.branch_id IS NULL AND repo_id = json_extract(OLD.provenance, '$.repo'))
     )
   ) OR (
     file_path = json_extract(NEW.provenance, '$.file')
     AND (
       (NEW.branch_id IS NOT NULL AND branch_id = NEW.branch_id)
       OR
       (NEW.branch_id IS NULL AND repo_id = json_extract(NEW.provenance, '$.repo'))
     )
   );
END;

-- Per-repo/branch coverage tallies by graph layer (file/symbol/edge/route/di/
-- test): resolved-vs-total counts backing trust/coverage reporting.
CREATE TABLE IF NOT EXISTS coverage_layers (
  repo_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch_id, layer)
);

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

-- Frontend->gRPC edges whose target endpoint node doesn't exist yet at parse
-- time (frontend and backend repos index independently/out of order). Held
-- here until the endpoint node appears, then replayed into edges and
-- deleted (see KnowledgeStore.replayPendingFrontendEdges).
CREATE TABLE IF NOT EXISTS pending_frontend_edges (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  src_node_id TEXT NOT NULL,
  service TEXT NOT NULL,
  function_name TEXT NOT NULL,
  source_type TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
  node_id UNINDEXED, title, body
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
  node_id UNINDEXED, name, signature
);
-- FTS5 UNINDEXED columns cannot support equality deletes. Keep the virtual
-- rowid in ordinary indexed tables so per-symbol/per-file replacement never
-- scans the entire FTS corpus during rebuild.
CREATE TABLE IF NOT EXISTS fts_symbol_rows (
  fts_rowid INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fts_symbol_rows_node
  ON fts_symbol_rows(node_id, fts_rowid);
-- Lightweight, non-graph identifier index: object-literal property keys,
-- interface/type-alias member names, class field names — none of these are
-- symbol nodes (they'd explode node/edge count for no real graph value), but
-- an agent searching for a real field name (e.g. "suspensionPeriod") deserves
-- SOMETHING better than a bare empty result. file:line only, on purpose.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_identifiers USING fts5(
  name, repo_id UNINDEXED, file_path UNINDEXED, start_line UNINDEXED, kind UNINDEXED
);
CREATE TABLE IF NOT EXISTS fts_identifier_rows (
  fts_rowid INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fts_identifier_rows_scope
  ON fts_identifier_rows(repo_id, file_path, fts_rowid);

CREATE TABLE IF NOT EXISTS file_facts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  exports_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, file_path, content_hash, language, parser_version)
);
CREATE TABLE IF NOT EXISTS file_fact_symbols (
  file_fact_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (file_fact_id, identity_key)
);
CREATE INDEX IF NOT EXISTS idx_file_fact_symbols_identity
  ON file_fact_symbols(identity_key, file_fact_id);
CREATE TABLE IF NOT EXISTS snapshot_overlays (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add','modify','delete')),
  file_fact_id TEXT,
  renamed_from TEXT,
  PRIMARY KEY (snapshot_id, file_path),
  CHECK ((operation = 'delete' AND file_fact_id IS NULL) OR
         (operation IN ('add','modify') AND file_fact_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS effective_snapshot_files (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_fact_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_effective_snapshot_files_snapshot_fact
  ON effective_snapshot_files(snapshot_id, file_fact_id);
CREATE TABLE IF NOT EXISTS snapshot_rename_events (
  snapshot_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  file_fact_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, from_path, to_path)
);

CREATE TABLE IF NOT EXISTS resolution_sets (
  id TEXT PRIMARY KEY,
  file_fact_id TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (file_fact_id, context_fingerprint, resolver_version)
);
CREATE TABLE IF NOT EXISTS resolved_edges (
  id TEXT PRIMARY KEY,
  resolution_set_id TEXT NOT NULL,
  src_identity_key TEXT NOT NULL,
  dst_identity_key TEXT,
  raw_target TEXT,
  edge_type TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_resolved_edges_set ON resolved_edges(resolution_set_id);
CREATE INDEX IF NOT EXISTS idx_resolved_edges_set_type_src
  ON resolved_edges(resolution_set_id, edge_type, src_identity_key);
CREATE INDEX IF NOT EXISTS idx_resolved_edges_set_type_dst
  ON resolved_edges(resolution_set_id, edge_type, dst_identity_key);
CREATE TABLE IF NOT EXISTS snapshot_resolution_refs (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  resolution_set_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file_path)
);
CREATE TABLE IF NOT EXISTS revision_endpoint_publications (
  snapshot_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL,
  materialized_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revision_endpoint_occurrences (
  snapshot_id TEXT NOT NULL,
  endpoint_node_id TEXT NOT NULL,
  endpoint_identity_key TEXT NOT NULL,
  protocol TEXT,
  locator_node_id TEXT,
  locator_identity_key TEXT NOT NULL DEFAULT '',
  edge_type TEXT NOT NULL,
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('definition','client','handler','test')),
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER,
  method TEXT NOT NULL,
  confidence REAL NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, endpoint_node_id, edge_type, provenance_kind, file_path, start_line, locator_identity_key)
);
CREATE INDEX IF NOT EXISTS idx_revision_endpoint_occurrences_filter
  ON revision_endpoint_occurrences(snapshot_id, provenance_kind, protocol, endpoint_identity_key, file_path);
CREATE INDEX IF NOT EXISTS idx_revision_endpoint_occurrences_page
  ON revision_endpoint_occurrences(snapshot_id, endpoint_identity_key, endpoint_node_id);
CREATE TABLE IF NOT EXISTS global_resolved_edges (
  id TEXT PRIMARY KEY,
  producer_key TEXT NOT NULL,
  src_identity_key TEXT NOT NULL,
  dst_identity_key TEXT,
  raw_target TEXT,
  edge_type TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}',
  UNIQUE (producer_key, src_identity_key, dst_identity_key, edge_type)
);

-- Content-addressed universal source corpus. Parser facts remain separately
-- rebuildable; these tables preserve admitted text even when no grammar exists.
CREATE TABLE IF NOT EXISTS source_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  -- Null whenever the decode round-trips (every UTF-8 file, which is all but two
  -- blobs here): those bytes are exactly decoded_content re-encoded, and storing
  -- both put every source file in the database twice.
  raw_bytes BLOB,
  decoded_content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- One row per BLOB, not per line. The row-per-line form cost six integers, a
-- two-column primary key and a secondary index for every line of every indexed
-- file — 5.3 GB of a 16 GB database — to answer "which line is this offset in".
-- Both end offsets are derivable (the next line's start, minus its newline), so
-- two packed uint32 arrays hold the same information at 8 bytes per line, and a
-- binary search over them is no slower than descending the B-tree was.
CREATE TABLE IF NOT EXISTS source_blob_line_offsets (
  source_blob_id INTEGER PRIMARY KEY,
  line_count INTEGER NOT NULL,
  total_chars INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  start_chars BLOB NOT NULL,
  start_bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS source_blob_trigrams (
  source_blob_id INTEGER NOT NULL,
  trigram TEXT NOT NULL,
  PRIMARY KEY (source_blob_id, trigram)
);
CREATE INDEX IF NOT EXISTS idx_source_blob_trigrams_lookup ON source_blob_trigrams(trigram, source_blob_id);
CREATE TABLE IF NOT EXISTS source_facts (
  source_fact_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fact_fingerprint TEXT NOT NULL,
  content_hash TEXT,
  source_blob_id INTEGER,
  coverage_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, file_path, fact_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_source_facts_scope ON source_facts(repo_id, file_path);
CREATE TABLE IF NOT EXISTS file_fact_sources (
  file_fact_id TEXT NOT NULL,
  source_fact_id TEXT NOT NULL,
  PRIMARY KEY (file_fact_id, source_fact_id)
);
CREATE TABLE IF NOT EXISTS effective_snapshot_sources (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_fact_id TEXT NOT NULL,
  source_blob_id INTEGER,
  PRIMARY KEY (snapshot_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_effective_snapshot_sources_snapshot_blob
  ON effective_snapshot_sources(snapshot_id, source_blob_id);
CREATE TABLE IF NOT EXISTS source_snapshot_overlays (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add','modify','delete')),
  source_fact_id TEXT,
  renamed_from TEXT,
  PRIMARY KEY (snapshot_id, file_path),
  CHECK ((operation = 'delete' AND source_fact_id IS NULL) OR
         (operation IN ('add','modify') AND source_fact_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_source_snapshot_overlays_fact ON source_snapshot_overlays(source_fact_id);
CREATE TABLE IF NOT EXISTS source_backfill_checkpoints (
  scope TEXT PRIMARY KEY,
  last_key TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  unavailable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coverage_records (
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  git_state TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  classification TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  reason TEXT NOT NULL,
  parser_status TEXT NOT NULL DEFAULT 'not_applicable',
  parser_language TEXT,
  parser_version TEXT,
  parser_error TEXT,
  updated_at TEXT NOT NULL,
  unresolved_references INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_coverage_records_path ON coverage_records(repo_id, file_path);
-- Reference resolution is revision-scoped.  coverage_records is deliberately
-- kept repo/file keyed for file-discovery compatibility; this table preserves
-- the per-branch/per-snapshot readback needed for trustworthy negative graph
-- answers.
CREATE TABLE IF NOT EXISTS unresolved_reference_coverage (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  file_path TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch_id, file_path, revision_id)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_reference_coverage_scope
  ON unresolved_reference_coverage(repo_id, branch_id, revision_id);
-- Concrete revision-scoped unresolved references.  The aggregate coverage
-- table above is intentionally retained for cheap health/status reads; this
-- queue makes every unresolved/ambiguous/external reference actionable.
CREATE TABLE IF NOT EXISTS unresolved_reference_items (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  revision_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  source_node_id TEXT REFERENCES nodes(id),
  raw_target TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'missing_internal',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unresolved_reference_items_scope
  ON unresolved_reference_items(repo_id, branch_id, revision_id, file_path, start_line, id);
CREATE TABLE IF NOT EXISTS markdown_sections (
  source_fact_id TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  heading TEXT NOT NULL,
  level INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  PRIMARY KEY (source_fact_id, heading_path)
);
CREATE TABLE IF NOT EXISTS note_properties (
  note_node_id TEXT NOT NULL,
  property_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_boolean INTEGER,
  value_date TEXT,
  source_line INTEGER NOT NULL,
  PRIMARY KEY (note_node_id, property_key, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_note_properties_lookup ON note_properties(property_key, value_text, value_number, value_date);
CREATE TABLE IF NOT EXISTS note_links (
  source_node_id TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  raw_target TEXT NOT NULL,
  target_node_id TEXT,
  target_anchor TEXT,
  display_text TEXT,
  embedded INTEGER NOT NULL,
  resolution_status TEXT NOT NULL,
  PRIMARY KEY (source_node_id, source_line, raw_target, target_anchor)
);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_node_id, source_node_id);
CREATE TABLE IF NOT EXISTS why_cards (
  id TEXT PRIMARY KEY,
  subject_json TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  decision TEXT NOT NULL,
  alternatives_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  consequences_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  gaps_json TEXT NOT NULL,
  status TEXT NOT NULL,
  revision_id TEXT,
  owners_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  source_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  retention TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_scope_status ON memory_items(class,status,expires_at);
CREATE TABLE IF NOT EXISTS ontology_terms (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  term_type TEXT NOT NULL,
  definition TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ontology_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (from_id,to_id,relation)
);
CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  contract_version TEXT NOT NULL DEFAULT '2',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_queries_name ON saved_queries(name);
CREATE TABLE IF NOT EXISTS trust_evidence (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  locator TEXT NOT NULL,
  revision_id TEXT,
  environment TEXT,
  content_hash TEXT,
  query_hash TEXT,
  observed_at TEXT,
  expires_at TEXT,
  redaction_policy TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validated_findings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  claim TEXT NOT NULL,
  affected_scopes_json TEXT NOT NULL,
  reproduction_json TEXT NOT NULL,
  status TEXT NOT NULL,
  gaps_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finding_evidence (
  finding_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL,
  PRIMARY KEY (finding_id,evidence_id,evidence_role)
);
CREATE TABLE IF NOT EXISTS knowledge_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_feedback (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  correction_json TEXT,
  scope_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reflection_suggestions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reproduction_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS external_knowledge_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  location TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT,
  final_url TEXT,
  content_type TEXT,
  retrieved_at TEXT,
  license_warning TEXT,
  created_at TEXT NOT NULL
);
-- Calls that provably leave the repo (an imported external package), so no
-- in-repo edge can exist for them. Dropping the edge is right; dropping the
-- fact is not — a caller once received a tidy 10-item callee list for a method
-- whose two most important calls went to an external SDK, reported at "high"
-- confidence with no gap. Recorded per file so a file's re-index replaces its
-- own rows, exactly like edge replacement.
CREATE TABLE IF NOT EXISTS external_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  src_node_id TEXT,
  callee TEXT NOT NULL,
  receiver TEXT,
  specifier TEXT NOT NULL,
  reason TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_external_calls_src ON external_calls(src_node_id);
CREATE INDEX IF NOT EXISTS idx_external_calls_file ON external_calls(repo_id, branch_id, file_path);
CREATE TABLE IF NOT EXISTS knowledge_gc_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT,
  trigger_kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  cooled_snapshots INTEGER NOT NULL DEFAULT 0,
  collected_snapshots INTEGER NOT NULL DEFAULT 0,
  collected_resolution_sets INTEGER NOT NULL DEFAULT 0,
  collected_facts INTEGER NOT NULL DEFAULT 0,
  collected_source_facts INTEGER NOT NULL DEFAULT 0,
  collected_source_blobs INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_gc_runs_finished ON knowledge_gc_runs(finished_at);
CREATE TABLE IF NOT EXISTS knowledge_size_samples (
  sample_date TEXT PRIMARY KEY,
  total_bytes INTEGER NOT NULL,
  wal_bytes INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effective_snapshot_sources_fact ON effective_snapshot_sources(source_fact_id);
CREATE VIRTUAL TABLE IF NOT EXISTS source_path_fts USING fts5(file_path, source_fact_id UNINDEXED, tokenize='unicode61');
`;

export const SCHEMA_VERSION = 18;

/** Version of parser-derived graph/snapshot data. Additive operational tables
 * and worker metadata must not make every repository parse from scratch. */
export const INDEX_FORMAT_VERSION = 17;

export function schemaMigrationBackupPath(path: string, fromVersion: number, toVersion: number): string {
  return `${path}.schema-v${fromVersion}-to-v${toVersion}.bak`;
}

/** Shared downgrade guard. Every compiled runtime calls this before DDL, so a
 * runtime whose supported version is older than the database fails without
 * attempting to interpret or mutate newer job semantics. */
export function assertSchemaVersionSupported(storedVersion: number, supportedVersion = SCHEMA_VERSION): void {
  if (storedVersion <= supportedVersion) return;
  throw Object.assign(
    new Error(
      `knowledge.db schema_version ${storedVersion} is newer than this build supports (${supportedVersion}); ` +
        "upgrade Penguin before opening it.",
    ),
    { code: "SCHEMA_VERSION_MISMATCH", storedVersion, supportedVersion },
  );
}

function validateSchemaMigrationBackup(path: string, expectedVersion: number): void {
  const backup = new (loadDatabaseCtor())(path, { readonly: true, fileMustExist: true });
  try {
    const version = Number((backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined)?.value ?? NaN);
    const integrity = backup.pragma("quick_check", { simple: true });
    if (version !== expectedVersion || integrity !== "ok") {
      throw new Error(`expected schema ${expectedVersion}, found ${version}; quick_check=${String(integrity)}`);
    }
  } finally {
    backup.close();
  }
}

type SchemaBackupIdentity = {
  path: string;
  schemaVersion: number;
  logicalDigest: string;
  files: Array<{
    suffix: string;
    size: number;
    mtimeMs: number;
    device: number;
    ino: number;
    birthtimeMs: number;
  }>;
};

type SchemaBackupManifest = {
  format: 2 | 3;
  attemptId?: string;
  publisherPid?: number;
  publisherProcessStartToken?: unknown;
  fromVersion: number;
  toVersion: number;
  source: SchemaBackupIdentity;
  backup: SchemaBackupIdentity;
  createdAt: string;
};

type SchemaMigrationBackup = {
  path: string;
  manifestPath: string;
  attemptId: string;
  createdByThisAttempt: boolean;
  sourceIdentity: SchemaBackupIdentity;
  sourceDataVersion: number;
};

type SchemaBackupCleanupClaim = {
  format: 1 | 2;
  ownerPid: number;
  ownerProcessStartToken?: unknown;
  ownerToken: string;
  attemptId: string;
  manifestDigest: string;
};

type SchemaBackupAttemptOwner = {
  format: 1 | 2 | 3;
  ownerPid: number;
  ownerProcessStartToken?: unknown;
  attemptId: string;
  sourcePath: string;
  fromVersion: number;
  toVersion: number;
  sourceIdentity: SchemaBackupIdentity;
  createdAt: string;
  backupIdentity?: SchemaBackupIdentity;
  manifestIdentity?: {
    path: string;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    birthtimeMs: number;
    sha256: string;
  };
};

function schemaBackupManifestPath(path: string): string {
  return `${path}.manifest.json`;
}

function schemaBackupCleanupClaimPath(manifestPath: string): string {
  return `${manifestPath}.cleanup-claim.json`;
}

function databaseLogicalDigest(db: Database.Database): string {
  const schema = db.prepare(
    `SELECT type,name,tbl_name,COALESCE(sql,'') AS sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type,name`,
  ).all();
  const tables = new Set(
    (schema as Array<{ type: string; name: string }>).filter((row) => row.type === "table").map((row) => row.name),
  );
  const meta = tables.has("meta")
    ? db.prepare("SELECT key,value FROM meta ORDER BY key").all()
    : [];
  const repos = tables.has("repos")
    ? db.prepare("SELECT id,name,root_path,remote_url,created_at FROM repos ORDER BY id").all()
    : [];
  return createHash("sha256")
    .update(JSON.stringify({ schema, meta, repos }))
    .digest("hex");
}

function databaseIdentity(db: Database.Database, path: string, schemaVersion: number): SchemaBackupIdentity {
  const files = ["", "-wal"]
    .filter((suffix) => existsSync(`${path}${suffix}`))
    .map((suffix) => {
      const stat = statSync(`${path}${suffix}`);
      return {
        suffix,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        device: stat.dev,
        ino: stat.ino,
        birthtimeMs: stat.birthtimeMs,
      };
    });
  return {
    path: resolve(path),
    schemaVersion,
    logicalDigest: databaseLogicalDigest(db),
    files,
  };
}

function backupSourceMismatch(message: string): Error {
  return Object.assign(new Error(`SCHEMA_BACKUP_SOURCE_MISMATCH: ${message}`), {
    code: "SCHEMA_BACKUP_SOURCE_MISMATCH",
  });
}

function identitiesEqual(left: SchemaBackupIdentity, right: SchemaBackupIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileStatsMatch(
  left: { size: number; mtimeMs: number; dev: number; ino: number; birthtimeMs: number },
  right: { size: number; mtimeMs: number; dev: number; ino: number; birthtimeMs: number },
): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function restoreQuarantinedPath(quarantinePath: string, fixedPath: string): void {
  try {
    // Hard-link restore is atomic and no-clobber. If another path appeared, it
    // wins and the quarantined file remains preserved for manual inspection.
    linkSync(quarantinePath, fixedPath);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw backupSourceMismatch(`cannot restore replaced artifact; preserved at ${quarantinePath}`);
    }
    throw error;
  }
  rmSync(quarantinePath);
}

function quarantineOwnedPath(
  fixedPath: string,
  quarantinePath: string,
  validate: (path: string) => void,
): void {
  if (existsSync(quarantinePath)) {
    throw backupSourceMismatch(`attempt quarantine already exists: ${quarantinePath}`);
  }
  renameSync(fixedPath, quarantinePath);
  try {
    validate(quarantinePath);
  } catch (error) {
    restoreQuarantinedPath(quarantinePath, fixedPath);
    throw error;
  }
}

function sourceFileProvenanceUsable(identity: SchemaBackupIdentity): boolean {
  const mainFiles = Array.isArray(identity.files) ? identity.files.filter((file) => file.suffix === "") : [];
  if (mainFiles.length !== 1 || resolve(identity.path) !== identity.path) return false;
  const [file] = mainFiles;
  return Number.isSafeInteger(file.device)
    && file.device >= 0
    && Number.isSafeInteger(file.ino)
    && file.ino > 0
    && Number.isFinite(file.birthtimeMs)
    && file.birthtimeMs > 0;
}

/** Mutable size/mtime/logical digest identify one snapshot. Device, inode, and
 * birth time identify the source database file across ordinary SQLite commits.
 * Only that stable provenance permits replacing an existing stale backup. */
function sourceFileProvenanceMatches(left: SchemaBackupIdentity, right: SchemaBackupIdentity): boolean {
  const leftFile = Array.isArray(left.files) ? left.files.find((file) => file.suffix === "") : undefined;
  const rightFile = Array.isArray(right.files) ? right.files.find((file) => file.suffix === "") : undefined;
  return sourceFileProvenanceUsable(left)
    && sourceFileProvenanceUsable(right)
    && left.path === right.path
    && left.schemaVersion === right.schemaVersion
    && leftFile !== undefined
    && rightFile !== undefined
    && leftFile.device === rightFile.device
    && leftFile.ino === rightFile.ino
    && leftFile.birthtimeMs === rightFile.birthtimeMs;
}

function manifestAttemptId(manifest: SchemaBackupManifest, rawManifest: string): string {
  if (manifest.format === 3 && typeof manifest.attemptId === "string" && manifest.attemptId.length > 0) {
    return manifest.attemptId;
  }
  // Format-2 manifests predate explicit attempt ownership. Their immutable
  // serialized bytes still provide a stable CAS token for safe cleanup.
  return createHash("sha256").update(rawManifest).digest("hex");
}

type ProcessOwnerState = "alive" | "dead" | "unknown";

function processLiveness(pid: number): ProcessOwnerState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EPERM") return "alive";
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function processExists(pid: number): boolean {
  return processLiveness(pid) === "alive";
}

type DarwinProcessStartIdentity = {
  format: 1;
  startedAt: string;
  elapsedSeconds: number;
  observedAtMs: number;
  commandSha256: string;
};

function parsePsElapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (![days, hours, minutes, seconds].every(Number.isSafeInteger) || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  return (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
}

function readDarwinProcessStartIdentity(pid: number): DarwinProcessStartIdentity | null {
  try {
    const ps = (field: string): string => execFileSync(
      "/bin/ps",
      ["-o", `${field}=`, "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // Read lstart on both sides of the other observations. If the PID is
    // recycled between ps calls, the sample is ambiguous and must not prove
    // ownership.
    const startedAtBefore = ps("lstart");
    const elapsedSeconds = parsePsElapsedSeconds(ps("etime"));
    const command = ps("command");
    const startedAtAfter = ps("lstart");
    if (!startedAtBefore || startedAtBefore !== startedAtAfter || elapsedSeconds === null || !command) return null;
    return {
      format: 1,
      startedAt: startedAtBefore,
      elapsedSeconds,
      observedAtMs: Date.now(),
      commandSha256: createHash("sha256").update(command).digest("hex"),
    };
  } catch {
    return null;
  }
}

function encodeDarwinProcessStartIdentity(identity: DarwinProcessStartIdentity): string {
  return `darwin-v2:${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
}

function decodeDarwinProcessStartIdentity(token: unknown): DarwinProcessStartIdentity | null {
  if (typeof token !== "string" || !token.startsWith("darwin-v2:")) return null;
  try {
    const identity = JSON.parse(Buffer.from(token.slice("darwin-v2:".length), "base64url").toString("utf8")) as DarwinProcessStartIdentity;
    if (
      identity.format !== 1 ||
      typeof identity.startedAt !== "string" ||
      identity.startedAt.length === 0 ||
      !Number.isSafeInteger(identity.elapsedSeconds) ||
      identity.elapsedSeconds < 0 ||
      !Number.isSafeInteger(identity.observedAtMs) ||
      identity.observedAtMs <= 0 ||
      !/^[0-9a-f]{64}$/.test(identity.commandSha256)
    ) return null;
    return identity;
  } catch {
    return null;
  }
}

function persistedProcessStartTokenIsComparable(
  token: unknown,
  platform = process.platform,
): token is string {
  if (typeof token !== "string" || token.length === 0) return false;
  if (platform === "darwin") {
    if (token.startsWith("darwin-v2:")) {
      const identity = decodeDarwinProcessStartIdentity(token);
      return identity !== null
        && Number.isFinite(Date.parse(identity.startedAt))
        && identity.observedAtMs <= Date.now();
    }
    if (!token.startsWith("darwin:")) return false;
    const startedAt = token.slice("darwin:".length);
    return startedAt.length > 0 && Number.isFinite(Date.parse(startedAt));
  }
  if (platform === "linux") {
    return /^linux:[^:]+:[1-9][0-9]*$/.test(token);
  }
  if (platform === "win32") {
    return /^win32:[1-9][0-9]*$/.test(token);
  }
  const prefix = `${platform}:`;
  if (!token.startsWith(prefix)) return false;
  const startedAt = token.slice(prefix.length);
  return startedAt.length > 0 && Number.isFinite(Date.parse(startedAt));
}

function darwinProcessIdentityMatches(pid: number, expectedToken: unknown): boolean | null {
  if (!persistedProcessStartTokenIsComparable(expectedToken, "darwin")) return null;
  const actual = readDarwinProcessStartIdentity(pid);
  if (!actual) return null;
  if (expectedToken.startsWith("darwin:") && !expectedToken.startsWith("darwin-v2:")) {
    const expectedStartedAt = expectedToken.slice("darwin:".length);
    if (!expectedStartedAt || !Number.isFinite(Date.parse(expectedStartedAt))) return null;
    return expectedStartedAt === actual.startedAt;
  }
  const expected = decodeDarwinProcessStartIdentity(expectedToken);
  if (!expected) return null;
  if (expected.startedAt !== actual.startedAt || expected.commandSha256 !== actual.commandSha256) return false;
  const expectedElapsedNow = expected.elapsedSeconds + ((actual.observedAtMs - expected.observedAtMs) / 1_000);
  // BSD ps reports etime in whole seconds. A two-second bound covers sampling
  // phase and scheduling jitter while elapsed progression distinguishes a PID
  // recycled inside lstart's one-second timestamp granularity.
  return Math.abs(actual.elapsedSeconds - expectedElapsedNow) <= 2;
}

function processStartTokensMatch(left: unknown, right: unknown): boolean {
  if (!persistedProcessStartTokenIsComparable(left) || !persistedProcessStartTokenIsComparable(right)) {
    return false;
  }
  if (left === right) return true;
  const leftDarwin = decodeDarwinProcessStartIdentity(left);
  const rightDarwin = decodeDarwinProcessStartIdentity(right);
  if (!leftDarwin || !rightDarwin) return false;
  if (leftDarwin.startedAt !== rightDarwin.startedAt || leftDarwin.commandSha256 !== rightDarwin.commandSha256) {
    return false;
  }
  const expectedRightElapsed = leftDarwin.elapsedSeconds + ((rightDarwin.observedAtMs - leftDarwin.observedAtMs) / 1_000);
  return Math.abs(rightDarwin.elapsedSeconds - expectedRightElapsed) <= 2;
}

function processStartToken(pid: number): string | null {
  if (!processExists(pid)) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      if (!startTicks) return null;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return `linux:${bootId}:${startTicks}`;
    }
    if (process.platform === "win32") {
      const ticks = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return ticks ? `win32:${ticks}` : null;
    }
    if (process.platform === "darwin") {
      const identity = readDarwinProcessStartIdentity(pid);
      return identity ? encodeDarwinProcessStartIdentity(identity) : null;
    }
    const startedAt = execFileSync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
}

function currentProcessStartToken(): string {
  const token = processStartToken(process.pid);
  if (!token) throw backupSourceMismatch("current process start identity is unavailable");
  return token;
}

function processOwnerState(pid: number, expectedStartToken?: unknown): ProcessOwnerState {
  if (expectedStartToken !== undefined && !persistedProcessStartTokenIsComparable(expectedStartToken)) {
    return "unknown";
  }
  const liveness = processLiveness(pid);
  if (liveness !== "alive") return liveness;
  // Legacy owners did not persist a non-reusable identity. Preserve their
  // fail-closed behavior while new owners can distinguish a reused PID.
  if (expectedStartToken === undefined) return "alive";
  if (process.platform === "darwin") {
    const matches = darwinProcessIdentityMatches(pid, expectedStartToken);
    return matches === null ? "unknown" : matches ? "alive" : "dead";
  }
  const actualStartToken = processStartToken(pid);
  if (actualStartToken === null || !persistedProcessStartTokenIsComparable(actualStartToken)) return "unknown";
  return actualStartToken === expectedStartToken ? "alive" : "dead";
}

function acquireSchemaBackupCleanupClaim(
  manifestPath: string,
  attemptId: string,
  rawManifest: string,
): { path: string; raw: string; ownerToken: string } {
  const claimPath = schemaBackupCleanupClaimPath(manifestPath);
  const manifestDigest = createHash("sha256").update(rawManifest).digest("hex");
  for (let claimAttempt = 0; claimAttempt < 2; claimAttempt += 1) {
    const claim: SchemaBackupCleanupClaim = {
      format: 2,
      ownerPid: process.pid,
      ownerProcessStartToken: currentProcessStartToken(),
      ownerToken: randomUUID(),
      attemptId,
      manifestDigest,
    };
    const raw = `${JSON.stringify(claim, null, 2)}\n`;
    try {
      writeFileSync(claimPath, raw, { flag: "wx" });
      return { path: claimPath, raw, ownerToken: claim.ownerToken };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      let existingRaw: string;
      let existing: SchemaBackupCleanupClaim;
      try {
        existingRaw = readFileSync(claimPath, "utf8");
        existing = JSON.parse(existingRaw) as SchemaBackupCleanupClaim;
      } catch {
        throw backupSourceMismatch("existing backup cleanup claim is unreadable");
      }
      if (
        (existing.format !== 1 && existing.format !== 2) ||
        (existing.format === 2 && existing.ownerProcessStartToken === undefined) ||
        processOwnerState(existing.ownerPid, existing.ownerProcessStartToken) !== "dead"
      ) throw migrationSourceChanged();
      // Reap only the exact dead-owner claim we inspected. A concurrently
      // replaced claim belongs to another attempt and must remain untouched.
      const reapPath = `${claimPath}.reap-${randomUUID()}`;
      quarantineOwnedPath(claimPath, reapPath, (path) => {
        if (readFileSync(path, "utf8") !== existingRaw) throw migrationSourceChanged();
      });
      rmSync(reapPath);
    }
  }
  throw migrationSourceChanged();
}

function releaseSchemaBackupCleanupClaim(claim: { path: string; raw: string; ownerToken: string }): void {
  if (!existsSync(claim.path)) return;
  const releasePath = `${claim.path}.release-${claim.ownerToken}`;
  quarantineOwnedPath(claim.path, releasePath, (path) => {
    if (readFileSync(path, "utf8") !== claim.raw) {
      throw backupSourceMismatch("cleanup claim ownership changed before release");
    }
  });
  rmSync(releasePath);
}

function databaseDataVersion(db: Database.Database): number {
  return Number(db.pragma("data_version", { simple: true }));
}

function migrationSourceChanged(): Error {
  return Object.assign(
    new Error("SCHEMA_MIGRATION_SOURCE_CHANGED: source changed between backup and migration locking"),
    { code: "SCHEMA_MIGRATION_SOURCE_CHANGED" },
  );
}

function schemaBackupAttemptPaths(backupPath: string, manifestPath: string, attemptId: string): {
  backup: string;
  manifest: string;
  owner: string;
} {
  return {
    backup: `${backupPath}.attempt-${attemptId}.tmp`,
    manifest: `${manifestPath}.attempt-${attemptId}.tmp`,
    owner: `${backupPath}.attempt-${attemptId}.owner.json`,
  };
}

function attemptManifestIdentity(path: string): NonNullable<SchemaBackupAttemptOwner["manifestIdentity"]> {
  const stat = statSync(path);
  return {
    path: resolve(path),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function attemptManifestIdentityMatches(
  expected: NonNullable<SchemaBackupAttemptOwner["manifestIdentity"]>,
  path: string,
): boolean {
  const actual = attemptManifestIdentity(path);
  return actual.path === resolve(path)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs
    && expected.sha256 === actual.sha256;
}

function persistAttemptOwner(path: string, owner: SchemaBackupAttemptOwner): string {
  const raw = `${JSON.stringify(owner, null, 2)}\n`;
  const updatePath = `${path}.update-${randomUUID()}`;
  writeFileSync(updatePath, raw, { flag: "wx" });
  renameSync(updatePath, path);
  return raw;
}

function removeOwnedPublishedLink(fixedPath: string, ownedPath: string, ownerToken: string): void {
  const ownedStat = statSync(ownedPath);
  const quarantinePath = `${fixedPath}.rollback-${ownerToken}`;
  quarantineOwnedPath(fixedPath, quarantinePath, (path) => {
    if (!fileStatsMatch(statSync(path), ownedStat)) {
      throw backupSourceMismatch("published path no longer belongs to the current backup attempt");
    }
  });
  rmSync(quarantinePath);
}

const SCHEMA_BACKUP_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function recoverInterruptedSchemaBackupCleanup(
  sourcePath: string,
  backupPath: string,
  manifestPath: string,
  fromVersion: number,
  toVersion: number,
): void {
  const claimPath = schemaBackupCleanupClaimPath(manifestPath);
  if (!existsSync(claimPath)) return;
  let rawClaim: string;
  let claim: SchemaBackupCleanupClaim;
  try {
    rawClaim = readFileSync(claimPath, "utf8");
    claim = JSON.parse(rawClaim) as SchemaBackupCleanupClaim;
  } catch {
    throw backupSourceMismatch("interrupted cleanup claim is unreadable");
  }
  if (
    (claim.format !== 1 && claim.format !== 2) ||
    !Number.isSafeInteger(claim.ownerPid) ||
    claim.ownerPid <= 0 ||
    (claim.format === 2 && claim.ownerProcessStartToken === undefined) ||
    !SCHEMA_BACKUP_ATTEMPT_ID.test(claim.ownerToken) ||
    typeof claim.attemptId !== "string" ||
    claim.attemptId.length === 0 ||
    !/^[0-9a-f]{64}$/i.test(claim.manifestDigest)
  ) {
    throw backupSourceMismatch("interrupted cleanup claim has invalid ownership metadata");
  }
  if (processOwnerState(claim.ownerPid, claim.ownerProcessStartToken) !== "dead") throw migrationSourceChanged();

  const backupQuarantinePath = `${backupPath}.cleanup-${claim.ownerToken}`;
  const manifestQuarantinePath = `${manifestPath}.cleanup-${claim.ownerToken}`;
  const fixedBackupExists = existsSync(backupPath);
  const fixedManifestExists = existsSync(manifestPath);
  const backupQuarantineExists = existsSync(backupQuarantinePath);
  const manifestQuarantineExists = existsSync(manifestQuarantinePath);
  if ((fixedBackupExists && backupQuarantineExists) || (fixedManifestExists && manifestQuarantineExists)) {
    throw backupSourceMismatch("interrupted cleanup has conflicting fixed and quarantined artifacts");
  }

  const manifestCandidate = manifestQuarantineExists
    ? manifestQuarantinePath
    : fixedManifestExists
      ? manifestPath
      : undefined;
  let rawManifest: string | undefined;
  let manifest: SchemaBackupManifest | undefined;
  if (manifestCandidate) {
    try {
      rawManifest = readFileSync(manifestCandidate, "utf8");
      manifest = JSON.parse(rawManifest) as SchemaBackupManifest;
    } catch {
      throw backupSourceMismatch("interrupted cleanup manifest is unreadable");
    }
    if (
      createHash("sha256").update(rawManifest).digest("hex") !== claim.manifestDigest ||
      manifestAttemptId(manifest, rawManifest) !== claim.attemptId ||
      manifest.fromVersion !== fromVersion ||
      manifest.toVersion !== toVersion ||
      manifest.source?.path !== resolve(sourcePath)
    ) {
      throw backupSourceMismatch("interrupted cleanup manifest does not match its ownership claim");
    }
  }

  if (backupQuarantineExists) {
    if (!manifest) throw backupSourceMismatch("quarantined backup has no ownership-proven manifest");
    validateSchemaMigrationBackup(backupQuarantinePath, fromVersion);
    const quarantinedBackup = new (loadDatabaseCtor())(backupQuarantinePath, { readonly: true, fileMustExist: true });
    try {
      const identity = databaseIdentity(quarantinedBackup, backupQuarantinePath, fromVersion);
      if (!identitiesEqual({ ...identity, path: resolve(backupPath) }, manifest.backup)) {
        throw backupSourceMismatch("cleanup quarantine does not belong to the claimed backup attempt");
      }
    } finally {
      quarantinedBackup.close();
    }
  }

  if (backupQuarantineExists && fixedManifestExists && !manifestQuarantineExists) {
    restoreQuarantinedPath(backupQuarantinePath, backupPath);
  } else if (backupQuarantineExists && manifestQuarantineExists && !fixedBackupExists && !fixedManifestExists) {
    restoreQuarantinedPath(manifestQuarantinePath, manifestPath);
    restoreQuarantinedPath(backupQuarantinePath, backupPath);
  } else if (!backupQuarantineExists && manifestQuarantineExists && !fixedBackupExists && !fixedManifestExists) {
    if (!rawManifest || createHash("sha256").update(rawManifest).digest("hex") !== claim.manifestDigest) {
      throw backupSourceMismatch("cleanup manifest quarantine lost ownership proof");
    }
    rmSync(manifestQuarantinePath);
  } else if (
    backupQuarantineExists ||
    manifestQuarantineExists ||
    fixedBackupExists !== fixedManifestExists
  ) {
    throw backupSourceMismatch("interrupted cleanup artifacts are incomplete or ambiguous");
  }

  releaseSchemaBackupCleanupClaim({ path: claimPath, raw: rawClaim, ownerToken: claim.ownerToken });
}

function scavengeDeadSchemaBackupAttempts(
  sourcePath: string,
  backupPath: string,
  manifestPath: string,
  fromVersion: number,
  toVersion: number,
  currentSourceIdentity: SchemaBackupIdentity,
): void {
  const directory = dirname(backupPath);
  const ownerPrefix = `${basename(backupPath)}.attempt-`;
  const ownerSuffix = ".owner.json";
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(ownerPrefix) || !name.endsWith(ownerSuffix)) continue;
    const attemptId = name.slice(ownerPrefix.length, -ownerSuffix.length);
    if (!SCHEMA_BACKUP_ATTEMPT_ID.test(attemptId)) continue;
    const ownerPath = join(directory, name);
    let rawOwner: string;
    let owner: SchemaBackupAttemptOwner;
    try {
      rawOwner = readFileSync(ownerPath, "utf8");
      owner = JSON.parse(rawOwner) as SchemaBackupAttemptOwner;
    } catch {
      throw backupSourceMismatch(`dead attempt owner metadata is unreadable: ${ownerPath}`);
    }
    const createdAt = Date.parse(owner.createdAt);
    if (
      (owner.format !== 1 && owner.format !== 2 && owner.format !== 3) ||
      owner.attemptId !== attemptId ||
      !Number.isSafeInteger(owner.ownerPid) ||
      owner.ownerPid <= 0 ||
      (owner.format === 3 && owner.ownerProcessStartToken === undefined) ||
      owner.sourcePath !== resolve(sourcePath) ||
      owner.fromVersion !== fromVersion ||
      owner.toVersion !== toVersion ||
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() + 60_000 ||
      !sourceFileProvenanceMatches(owner.sourceIdentity, currentSourceIdentity)
    ) {
      throw backupSourceMismatch(`attempt owner metadata does not match this migration: ${ownerPath}`);
    }
    const ownerState = processOwnerState(owner.ownerPid, owner.ownerProcessStartToken);
    if (ownerState === "alive") continue;
    if (ownerState === "unknown") throw migrationSourceChanged();
    const attemptPaths = schemaBackupAttemptPaths(backupPath, manifestPath, attemptId);
    const provenBackupIdentity = owner.backupIdentity;
    if (!provenBackupIdentity) {
      // There is no durable physical identity for anything at the candidate
      // paths. Never inspect, adopt, move, or delete those files: a different
      // process may have replaced them with byte-distinct data that happens to
      // share our deliberately bounded logical digest. Retire only the exact
      // dead-owner sidecar; the preserved UUID-scoped candidate cannot collide
      // with the independent retry that follows.
      const ownerQuarantinePath = `${ownerPath}.scavenge-${randomUUID()}`;
      quarantineOwnedPath(ownerPath, ownerQuarantinePath, (path) => {
        if (readFileSync(path, "utf8") !== rawOwner) {
          throw backupSourceMismatch(`attempt owner sidecar changed during cleanup: ${ownerPath}`);
        }
      });
      rmSync(ownerQuarantinePath);
      continue;
    }
    for (const artifactPath of [attemptPaths.backup, attemptPaths.manifest]) {
      if (!existsSync(artifactPath)) continue;
      const quarantinePath = `${artifactPath}.scavenge-${randomUUID()}`;
      quarantineOwnedPath(artifactPath, quarantinePath, (path) => {
        if (artifactPath === attemptPaths.backup) {
          validateSchemaMigrationBackup(path, fromVersion);
          const backup = new (loadDatabaseCtor())(path, { readonly: true, fileMustExist: true });
          try {
            const actual = databaseIdentity(backup, path, fromVersion);
            const normalizedActual = { ...actual, path: resolve(artifactPath) };
            if (
              provenBackupIdentity.path !== resolve(artifactPath) ||
              !identitiesEqual(normalizedActual, provenBackupIdentity)
            ) {
              throw backupSourceMismatch(`attempt backup identity changed before cleanup: ${artifactPath}`);
            }
          } finally {
            backup.close();
          }
        } else {
          if (
            !owner.manifestIdentity ||
            owner.manifestIdentity.path !== resolve(artifactPath) ||
            !attemptManifestIdentityMatches(owner.manifestIdentity, path)
          ) {
            throw backupSourceMismatch(`attempt manifest identity changed before cleanup: ${artifactPath}`);
          }
        }
      });
      rmSync(quarantinePath);
    }
    const ownerQuarantinePath = `${ownerPath}.scavenge-${randomUUID()}`;
    quarantineOwnedPath(ownerPath, ownerQuarantinePath, (path) => {
      if (readFileSync(path, "utf8") !== rawOwner) {
        throw backupSourceMismatch(`attempt owner sidecar changed during cleanup: ${ownerPath}`);
      }
    });
    rmSync(ownerQuarantinePath);
  }
}

function recoverOrphanedAttemptManifest(
  sourcePath: string,
  backupPath: string,
  manifestPath: string,
  fromVersion: number,
  toVersion: number,
  onSchemaMaintenance?: (event: SchemaMaintenanceEvent) => void,
): void {
  if (existsSync(backupPath) || !existsSync(manifestPath)) return;
  let rawManifest: string;
  let manifest: SchemaBackupManifest;
  try {
    rawManifest = readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(rawManifest) as SchemaBackupManifest;
  } catch {
    throw backupSourceMismatch("orphan provenance manifest is unreadable");
  }
  if (
    manifest.format !== 3 ||
    typeof manifest.attemptId !== "string" ||
    manifest.attemptId.length === 0 ||
    !Number.isSafeInteger(manifest.publisherPid) ||
    manifest.publisherPid == null ||
    manifest.publisherPid <= 0 ||
    manifest.fromVersion !== fromVersion ||
    manifest.toVersion !== toVersion ||
    manifest.source?.path !== resolve(sourcePath)
  ) {
    throw backupSourceMismatch("orphan provenance manifest has no verifiable publication owner");
  }
  const publisherState: ProcessOwnerState = manifest.publisherProcessStartToken === undefined
    ? "unknown"
    : processOwnerState(manifest.publisherPid, manifest.publisherProcessStartToken);
  if (publisherState !== "dead") throw migrationSourceChanged();
  const attemptPaths = schemaBackupAttemptPaths(backupPath, manifestPath, manifest.attemptId);
  if (!existsSync(attemptPaths.manifest) || !existsSync(attemptPaths.owner)) {
    throw backupSourceMismatch("orphan provenance manifest has no complete attempt ownership proof");
  }
  let owner: SchemaBackupAttemptOwner;
  try {
    owner = JSON.parse(readFileSync(attemptPaths.owner, "utf8")) as SchemaBackupAttemptOwner;
  } catch {
    throw backupSourceMismatch("orphan provenance manifest owner sidecar is unreadable");
  }
  if (
    owner.format !== 3 ||
    owner.attemptId !== manifest.attemptId ||
    owner.ownerPid !== manifest.publisherPid ||
    (manifest.publisherProcessStartToken !== undefined &&
      !processStartTokensMatch(owner.ownerProcessStartToken, manifest.publisherProcessStartToken)) ||
    owner.sourcePath !== resolve(sourcePath) ||
    owner.fromVersion !== fromVersion ||
    owner.toVersion !== toVersion ||
    !owner.manifestIdentity ||
    owner.manifestIdentity.path !== resolve(attemptPaths.manifest) ||
    !attemptManifestIdentityMatches(owner.manifestIdentity, attemptPaths.manifest)
  ) {
    throw backupSourceMismatch("orphan provenance manifest does not match its persisted attempt owner identity");
  }
  const ownedStat = statSync(attemptPaths.manifest);
  if (!fileStatsMatch(statSync(manifestPath), ownedStat) || readFileSync(attemptPaths.manifest, "utf8") !== rawManifest) {
    throw backupSourceMismatch("orphan provenance manifest is not owned by its recorded publication attempt");
  }
  removeOwnedPublishedLink(manifestPath, attemptPaths.manifest, manifest.attemptId);
  onSchemaMaintenance?.({
    operation: "schema-migration-backup",
    phase: "before-orphan-attempt-quarantine",
    path: attemptPaths.manifest,
    fromVersion,
    toVersion,
  });
  const attemptQuarantinePath = `${attemptPaths.manifest}.orphan-${randomUUID()}`;
  quarantineOwnedPath(attemptPaths.manifest, attemptQuarantinePath, (path) => {
    if (
      !owner.manifestIdentity ||
      owner.manifestIdentity.path !== resolve(attemptPaths.manifest) ||
      !attemptManifestIdentityMatches(owner.manifestIdentity, path)
    ) {
      throw backupSourceMismatch("orphan attempt manifest changed before quarantine");
    }
  });
  rmSync(attemptQuarantinePath);
}

/** Create one retained pre-migration image with SQLite's own snapshot engine.
 * VACUUM INTO sees one transactionally consistent database including committed
 * WAL frames, even while an older reader keeps an earlier WAL snapshot open. */
function ensureSchemaMigrationBackup(
  db: Database.Database,
  path: string,
  fromVersion: number,
  toVersion: number,
  onSchemaMaintenance?: (event: SchemaMaintenanceEvent) => void,
): SchemaMigrationBackup {
  const backupPath = schemaMigrationBackupPath(path, fromVersion, toVersion);
  const manifestPath = schemaBackupManifestPath(backupPath);
  const sourceDataVersion = databaseDataVersion(db);
  const sourceIdentity = databaseIdentity(db, path, fromVersion);
  if (!sourceFileProvenanceUsable(sourceIdentity)) {
    throw backupSourceMismatch("source database file identity is unavailable or unsafe for migration backup provenance");
  }
  let backupStartedAt: number | undefined;
  const notifyBackupStart = () => {
    if (backupStartedAt !== undefined) return;
    backupStartedAt = Date.now();
    onSchemaMaintenance?.({ operation: "schema-migration-backup", phase: "start", path: backupPath, fromVersion, toVersion });
  };
  recoverInterruptedSchemaBackupCleanup(path, backupPath, manifestPath, fromVersion, toVersion);
  recoverOrphanedAttemptManifest(path, backupPath, manifestPath, fromVersion, toVersion, onSchemaMaintenance);
  scavengeDeadSchemaBackupAttempts(path, backupPath, manifestPath, fromVersion, toVersion, sourceIdentity);
  if (existsSync(backupPath)) {
    if (!existsSync(manifestPath)) {
      throw backupSourceMismatch(`existing backup ${backupPath} has no provenance manifest`);
    }
    let manifest: SchemaBackupManifest;
    let rawManifest: string;
    try {
      rawManifest = readFileSync(manifestPath, "utf8");
      manifest = JSON.parse(rawManifest) as SchemaBackupManifest;
    } catch (error) {
      throw backupSourceMismatch(`cannot read provenance manifest: ${String((error as Error).message ?? error)}`);
    }
    if (
      (manifest.format !== 2 && manifest.format !== 3) ||
      (manifest.format === 3 && (typeof manifest.attemptId !== "string" || manifest.attemptId.length === 0)) ||
      manifest.fromVersion !== fromVersion ||
      manifest.toVersion !== toVersion ||
      !manifest.source ||
      !manifest.backup ||
      !sourceFileProvenanceUsable(manifest.source)
    ) {
      throw backupSourceMismatch("existing backup does not belong to the current pre-migration database image");
    }
    const attemptId = manifestAttemptId(manifest, rawManifest);
    validateSchemaMigrationBackup(backupPath, fromVersion);
    const backup = new (loadDatabaseCtor())(backupPath, { readonly: true, fileMustExist: true });
    let backupIdentity: SchemaBackupIdentity;
    try {
      backupIdentity = databaseIdentity(backup, backupPath, fromVersion);
      if (!identitiesEqual(manifest.backup, backupIdentity)) {
        throw backupSourceMismatch("existing backup changed after it was created");
      }
      // A legitimate post-publication source commit changes only the current
      // source snapshot. The published source digest must still be corroborated
      // by the independently re-read backup, otherwise the manifest was edited.
      if (manifest.source.logicalDigest !== backupIdentity.logicalDigest) {
        throw backupSourceMismatch("source logical identity is not corroborated by the retained backup");
      }
    } finally {
      backup.close();
    }
    if (identitiesEqual(manifest.source, sourceIdentity)) {
      return { path: backupPath, manifestPath, attemptId, createdByThisAttempt: false, sourceIdentity, sourceDataVersion };
    }
    if (!sourceFileProvenanceMatches(manifest.source, sourceIdentity)) {
      throw backupSourceMismatch("existing backup does not belong to the current pre-migration database image");
    }
    // The source is the same physical database and the retained backup proves
    // the manifest's old logical digest, so this is a post-backup commit rather
    // than manifest tampering. Notify before the final check so deterministic
    // tests (and real races) cannot hide a path replacement in the gap.
    notifyBackupStart();
    const claim = acquireSchemaBackupCleanupClaim(manifestPath, attemptId, rawManifest);
    try {
      if (!existsSync(backupPath) || !existsSync(manifestPath)) throw migrationSourceChanged();
      if (readFileSync(manifestPath, "utf8") !== rawManifest) {
        throw backupSourceMismatch("provenance manifest changed immediately before stale-backup cleanup");
      }
      const currentSourceIdentity = databaseIdentity(db, path, fromVersion);
      if (
        !sourceFileProvenanceUsable(currentSourceIdentity) ||
        !sourceFileProvenanceMatches(manifest.source, currentSourceIdentity) ||
        identitiesEqual(manifest.source, currentSourceIdentity)
      ) {
        throw backupSourceMismatch("source identity changed immediately before stale-backup cleanup");
      }
      validateSchemaMigrationBackup(backupPath, fromVersion);
      const currentBackup = new (loadDatabaseCtor())(backupPath, { readonly: true, fileMustExist: true });
      try {
        const currentBackupIdentity = databaseIdentity(currentBackup, backupPath, fromVersion);
        if (
          !identitiesEqual(manifest.backup, currentBackupIdentity) ||
          manifest.source.logicalDigest !== currentBackupIdentity.logicalDigest
        ) {
          throw backupSourceMismatch("backup identity changed immediately before stale-backup cleanup");
        }
      } finally {
        currentBackup.close();
      }
      const expectedBackupFile = manifest.backup.files.find((file) => file.suffix === "");
      const finalBackupStat = statSync(backupPath);
      if (
        expectedBackupFile === undefined ||
        finalBackupStat.size !== expectedBackupFile.size ||
        finalBackupStat.mtimeMs !== expectedBackupFile.mtimeMs ||
        finalBackupStat.dev !== expectedBackupFile.device ||
        finalBackupStat.ino !== expectedBackupFile.ino ||
        finalBackupStat.birthtimeMs !== expectedBackupFile.birthtimeMs ||
        readFileSync(manifestPath, "utf8") !== rawManifest ||
        readFileSync(claim.path, "utf8") !== claim.raw
      ) {
        throw backupSourceMismatch("backup ownership changed immediately before stale-backup deletion");
      }
      onSchemaMaintenance?.({ operation: "schema-migration-backup", phase: "before-remove", path: backupPath, fromVersion, toVersion });
      // Never unlink a shared fixed path. Atomically move each candidate into
      // this claim's unique namespace, validate again after the move, and only
      // then unlink the attempt-owned quarantine path. A replacement that wins
      // after the final stat is moved, detected, restored with no-clobber link,
      // and preserved.
      const backupQuarantinePath = `${backupPath}.cleanup-${claim.ownerToken}`;
      const manifestQuarantinePath = `${manifestPath}.cleanup-${claim.ownerToken}`;
      quarantineOwnedPath(backupPath, backupQuarantinePath, (quarantinePath) => {
        validateSchemaMigrationBackup(quarantinePath, fromVersion);
        const quarantinedBackup = new (loadDatabaseCtor())(quarantinePath, { readonly: true, fileMustExist: true });
        try {
          const quarantinedIdentity = databaseIdentity(quarantinedBackup, quarantinePath, fromVersion);
          if (!identitiesEqual({ ...quarantinedIdentity, path: resolve(backupPath) }, manifest.backup)) {
            throw backupSourceMismatch("backup path was replaced after its final identity check");
          }
        } finally {
          quarantinedBackup.close();
        }
      });
      onSchemaMaintenance?.({ operation: "schema-migration-backup", phase: "after-backup-quarantine", path: backupPath, fromVersion, toVersion });
      try {
        quarantineOwnedPath(manifestPath, manifestQuarantinePath, (quarantinePath) => {
          if (readFileSync(quarantinePath, "utf8") !== rawManifest) {
            throw backupSourceMismatch("provenance manifest changed before quarantine");
          }
        });
      } catch (error) {
        restoreQuarantinedPath(backupQuarantinePath, backupPath);
        throw error;
      }
      rmSync(backupQuarantinePath);
      rmSync(manifestQuarantinePath);
    } finally {
      releaseSchemaBackupCleanupClaim(claim);
    }
  }

  const attemptId = randomUUID();
  const attemptPaths = schemaBackupAttemptPaths(backupPath, manifestPath, attemptId);
  const tempPath = attemptPaths.backup;
  const manifestTempPath = attemptPaths.manifest;
  let manifestLinked = false;
  let backupLinked = false;
  let attemptOwner: SchemaBackupAttemptOwner = {
    format: 3,
    ownerPid: process.pid,
    ownerProcessStartToken: currentProcessStartToken(),
    attemptId,
    sourcePath: resolve(path),
    fromVersion,
    toVersion,
    sourceIdentity,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(attemptPaths.owner, `${JSON.stringify(attemptOwner, null, 2)}\n`, { flag: "wx" });
  notifyBackupStart();
  let attemptBackupIdentity: SchemaBackupIdentity | null = null;
  try {
    db.prepare("VACUUM INTO ?").run(tempPath);
    onSchemaMaintenance?.({ operation: "schema-migration-backup", phase: "after-vacuum-before-identity", path: backupPath, fromVersion, toVersion });
    validateSchemaMigrationBackup(tempPath, fromVersion);
    const attemptBackup = new (loadDatabaseCtor())(tempPath, { readonly: true, fileMustExist: true });
    try {
      attemptBackupIdentity = databaseIdentity(attemptBackup, tempPath, fromVersion);
      if (attemptBackupIdentity.logicalDigest !== sourceIdentity.logicalDigest) {
        throw backupSourceMismatch("SQLite snapshot does not match the source logical identity");
      }
    } finally {
      attemptBackup.close();
    }
    attemptOwner = { ...attemptOwner, backupIdentity: attemptBackupIdentity };
    persistAttemptOwner(attemptPaths.owner, attemptOwner);
    onSchemaMaintenance?.({ operation: "schema-migration-backup", phase: "after-vacuum", path: backupPath, fromVersion, toVersion });
  } catch (error) {
    rmSync(tempPath, { force: true });
    rmSync(attemptPaths.owner, { force: true });
    throw error;
  }

  try {
    validateSchemaMigrationBackup(tempPath, fromVersion);
    const backup = new (loadDatabaseCtor())(tempPath, { readonly: true, fileMustExist: true });
    let backupIdentity: SchemaBackupIdentity;
    try {
      backupIdentity = databaseIdentity(backup, tempPath, fromVersion);
      if (!attemptBackupIdentity || !identitiesEqual(backupIdentity, attemptBackupIdentity)) {
        throw backupSourceMismatch("attempt backup changed after its ownership identity was recorded");
      }
    } finally {
      backup.close();
    }
    if (databaseDataVersion(db) !== sourceDataVersion) throw migrationSourceChanged();
    backupIdentity = {
      ...backupIdentity,
      path: resolve(backupPath),
    };
    const manifest: SchemaBackupManifest = {
      format: 3,
      attemptId,
      publisherPid: process.pid,
      publisherProcessStartToken: currentProcessStartToken(),
      fromVersion,
      toVersion,
      source: sourceIdentity,
      backup: backupIdentity,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    attemptOwner = { ...attemptOwner, manifestIdentity: attemptManifestIdentity(manifestTempPath) };
    persistAttemptOwner(attemptPaths.owner, attemptOwner);
    onSchemaMaintenance?.({ operation: "schema-migration-backup", phase: "before-publish", path: backupPath, fromVersion, toVersion });
    // The preflight check is intentionally repeated after the callback and
    // immediately before publication. Hard links publish complete files with
    // atomic no-clobber semantics; rename() is forbidden here because POSIX
    // rename silently overwrites a concurrent winner or unrelated artifact.
    if (existsSync(backupPath)) {
      if (!existsSync(manifestPath)) {
        throw backupSourceMismatch(`backup path appeared without provenance before publication: ${backupPath}`);
      }
      throw migrationSourceChanged();
    }
    if (existsSync(manifestPath)) throw migrationSourceChanged();
    try {
      linkSync(manifestTempPath, manifestPath);
      manifestLinked = true;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") throw migrationSourceChanged();
      throw error;
    }
    try {
      linkSync(tempPath, backupPath);
      backupLinked = true;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        removeOwnedPublishedLink(manifestPath, manifestTempPath, attemptId);
        manifestLinked = false;
        throw backupSourceMismatch(`backup path was claimed by another file during publication: ${backupPath}`);
      }
      throw error;
    }
    rmSync(manifestTempPath);
    rmSync(tempPath);
    rmSync(attemptPaths.owner);
  } catch (error) {
    if (manifestLinked && !backupLinked && existsSync(manifestTempPath)) {
      removeOwnedPublishedLink(manifestPath, manifestTempPath, attemptId);
      manifestLinked = false;
    }
    // Fixed paths are never removed here. Only this attempt's UUID-scoped
    // files can be cleaned without risking a concurrent winner/unrelated file.
    rmSync(tempPath, { force: true });
    rmSync(manifestTempPath, { force: true });
    rmSync(attemptPaths.owner, { force: true });
    if (
      (error as { code?: string }).code === "SCHEMA_BACKUP_SOURCE_MISMATCH" ||
      (error as { code?: string }).code === "SCHEMA_MIGRATION_SOURCE_CHANGED"
    ) throw error;
    throw Object.assign(new Error(`SCHEMA_BACKUP_INVALID: ${String((error as Error).message ?? error)}`), { code: "SCHEMA_BACKUP_INVALID" });
  }
  onSchemaMaintenance?.({
    operation: "schema-migration-backup",
    phase: "complete",
    path: backupPath,
    fromVersion,
    toVersion,
    elapsedMs: Date.now() - (backupStartedAt ?? Date.now()),
  });
  return { path: backupPath, manifestPath, attemptId, createdByThisAttempt: true, sourceIdentity, sourceDataVersion };
}

/** Canonical schema history consumed by generated operator documentation. */
export const SCHEMA_MIGRATIONS = [
  { version: 10, name: "source-snapshots", summary: "content-addressed source blobs, snapshot overlays, coverage and resolver metadata" },
  { version: 11, name: "markdown-vault", summary: "Markdown sections, properties, wikilinks, evidence and saved-query records" },
  { version: 12, name: "semantic-and-memory", summary: "memory, ontology, semantic chunks, embeddings and reflection records" },
  { version: 13, name: "trust-and-external-sources", summary: "validated findings, audit events, external sources and revision-safe evidence" },
  { version: 14, name: "coverage-layers-and-edge-boundaries", summary: "coverage_layers table; edges.evidence_id + edges.boundary; forced rebuild on schema bump" },
  { version: 15, name: "canonical-endpoints-and-membership", summary: "parser-derived endpoint aliases and explicit provider/consumer/declaration repository membership" },
  { version: 16, name: "concrete-coverage-debt", summary: "revision-scoped unresolved reference work queue alongside aggregate coverage" },
  { version: 17, name: "semantic-identities-and-lifecycle", summary: "provenance-complete chunk identities and atomic embedding space/generation/job lifecycle" },
  { version: 18, name: "semantic-background-worker", summary: "durable semantic worker leases, pause controls, and retry scheduling without changing parser-derived graph format" },
] as const;

/**
 * Return the durable identity of one knowledge database, creating it exactly
 * once for writable opens. The identity lives in `meta` instead of being
 * derived from a path or inode so backups and restores can prove which
 * logical store they came from.
 */
export function ensureDatabaseInstanceId(db: Database.Database): string {
  const existing = db
    .prepare("SELECT value FROM meta WHERE key='database_instance_id'")
    .get() as { value?: string } | undefined;
  if (typeof existing?.value === "string" && existing.value.length > 0) return existing.value;
  const generated = `db_${randomUUID()}`;
  db.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('database_instance_id', ?)",
  ).run(generated);
  const persisted = db
    .prepare("SELECT value FROM meta WHERE key='database_instance_id'")
    .get() as { value?: string } | undefined;
  if (typeof persisted?.value !== "string" || persisted.value.length === 0) {
    throw new Error("DATABASE_INSTANCE_ID_UNAVAILABLE");
  }
  return persisted.value;
}

// Idempotent additive migrations for schemas that predate SCHEMA_VERSION.
// Each step guards on actual schema state (column presence) rather than the
// stored version, so a mislabeled version can't corrupt an already-migrated
// DB — and CREATE TABLE/INDEX IF NOT EXISTS in DDL already covers new *tables*.
// `from` is the version read from meta; gate future NON-idempotent steps on it
// (e.g. `if (from < 5) { ...backfill... }`). Additive column adds stay in the
// idempotent guards below and need no version gate.
// Retired write-only FTS mirrors (~0.78GB on a 26-repo DB): every blob was
// indexed into source_fts + source_lexical_fts, but no query path ever
// MATCHed them — search runs on fts_symbols/fts_identifiers and the
// verified source scan. Content stays intact in source_blobs, so a future
// reader could rebuild them; the pages return to the freelist here and to
// the OS on the next VACUUM. Idempotent: DROP IF EXISTS.
function dropRetiredTables(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS source_fts");
  db.exec("DROP TABLE IF EXISTS source_lexical_fts");
}

function migrate(db: Database.Database, _from: number): void {
  dropRetiredTables(db);
  const evidenceCols = (db.prepare("PRAGMA table_info(trust_evidence)").all() as { name: string }[]).map((c) => c.name);
  if (!evidenceCols.includes("query_hash")) db.exec("ALTER TABLE trust_evidence ADD COLUMN query_hash TEXT");
  const coverageCols = (db.prepare("PRAGMA table_info(coverage_records)").all() as { name: string }[]).map((c) => c.name);
  for (const [column, definition] of [
    ["parser_status", "TEXT NOT NULL DEFAULT 'not_applicable'"],
    ["parser_language", "TEXT"],
    ["parser_version", "TEXT"],
    ["parser_error", "TEXT"],
    ["unresolved_references", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!coverageCols.includes(column)) db.exec(`ALTER TABLE coverage_records ADD COLUMN ${column} ${definition}`);
  }
  const unresolvedItemCols = (db.prepare("PRAGMA table_info(unresolved_reference_items)").all() as { name: string }[]).map((c) => c.name);
  if (unresolvedItemCols.length > 0 && !unresolvedItemCols.includes("classification")) {
    db.exec("ALTER TABLE unresolved_reference_items ADD COLUMN classification TEXT NOT NULL DEFAULT 'missing_internal'");
  }
  const edgeCols = (db.prepare("PRAGMA table_info(edges)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!edgeCols.includes("status")) {
    db.exec("ALTER TABLE edges ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!edgeCols.includes("source_type")) {
    db.exec("ALTER TABLE edges ADD COLUMN source_type TEXT");
  }
  if (!edgeCols.includes("evidence_id")) db.exec("ALTER TABLE edges ADD COLUMN evidence_id TEXT");
  if (!edgeCols.includes("boundary")) db.exec("ALTER TABLE edges ADD COLUMN boundary TEXT");
  // coverage_layers is CREATE TABLE IF NOT EXISTS in the DDL, and openDatabase
  // runs db.exec(DDL) BEFORE calling migrate() (see openDatabase below) — so
  // the table already exists by the time this function runs on an upgrade.
  // No CREATE TABLE needed here.
  const branchCols = (db.prepare("PRAGMA table_info(branches)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const externalCols = (db.prepare("PRAGMA table_info(external_knowledge_sources)").all() as { name: string }[]).map((c) => c.name);
  if (externalCols.length > 0 && !externalCols.includes("content_type")) db.exec("ALTER TABLE external_knowledge_sources ADD COLUMN content_type TEXT");
  if (!branchCols.includes("pinned")) {
    // Pinned branches are exempt from every automatic retention mechanism.
    db.exec("ALTER TABLE branches ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!branchCols.includes("indexed_worktree_state")) {
    db.exec("ALTER TABLE branches ADD COLUMN indexed_worktree_state TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!branchCols.includes("indexed_worktree_fingerprint")) {
    db.exec("ALTER TABLE branches ADD COLUMN indexed_worktree_fingerprint TEXT");
  }
  if (!branchCols.includes("indexed_dirty_files")) {
    db.exec("ALTER TABLE branches ADD COLUMN indexed_dirty_files TEXT NOT NULL DEFAULT '[]'");
  }
  if (!branchCols.includes("parser_version")) {
    db.exec("ALTER TABLE branches ADD COLUMN parser_version TEXT");
  }
  // Fold the row-per-line index into one packed row per blob. The old table is
  // 5.3 GB of a 16 GB database; every value in it is reconstructible from two
  // uint32 arrays, so this is a pure representation change with no answer
  // changing. Done in one pass per blob so a large index does not need the old
  // and new forms in memory at once.
  const hasLegacyLines = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_blob_lines'")
    .get() != null;
  if (hasLegacyLines) {
    db.exec(`CREATE TABLE IF NOT EXISTS source_blob_line_offsets (
      source_blob_id INTEGER PRIMARY KEY,
      line_count INTEGER NOT NULL,
      total_chars INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      start_chars BLOB NOT NULL,
      start_bytes BLOB NOT NULL
    )`);
    const blobs = db.prepare(`
      SELECT source_blob_id AS id, COUNT(*) AS lines FROM source_blob_lines
       WHERE source_blob_id NOT IN (SELECT source_blob_id FROM source_blob_line_offsets)
       GROUP BY source_blob_id
    `).all() as Array<{ id: number; lines: number }>;
    const readLines = db.prepare(
      "SELECT start_char AS startChar, start_byte AS startByte, end_char AS endChar, end_byte AS endByte FROM source_blob_lines WHERE source_blob_id=? ORDER BY line_number",
    );
    const insert = db.prepare(
      "INSERT OR REPLACE INTO source_blob_line_offsets(source_blob_id,line_count,total_chars,total_bytes,start_chars,start_bytes) VALUES (?,?,?,?,?,?)",
    );
    for (const blob of blobs) {
      const rows = readLines.all(blob.id) as Array<{ startChar: number; startByte: number; endChar: number; endByte: number }>;
      if (rows.length === 0) continue;
      const startChars = Buffer.allocUnsafe(rows.length * 4);
      const startBytes = Buffer.allocUnsafe(rows.length * 4);
      for (let i = 0; i < rows.length; i += 1) {
        startChars.writeUInt32LE(rows[i].startChar, i * 4);
        startBytes.writeUInt32LE(rows[i].startByte, i * 4);
      }
      const last = rows[rows.length - 1];
      insert.run(blob.id, rows.length, last.endChar, last.endByte, startChars, startBytes);
    }
    db.exec("DROP TABLE source_blob_lines");
  }

  // Reclaim the duplicate copy of every source file. raw_bytes was NOT NULL and
  // held the exact UTF-8 encoding of decoded_content, so an existing index
  // carries both — 3.49 GB of it here. Nulling the redundant ones is safe in
  // place: the round-trip is verified per row, so a blob whose bytes do not
  // re-derive keeps them. The space returns on the next VACUUM.
  const blobCols = (db.prepare("PRAGMA table_info(source_blobs)").all() as { name: string; notnull: number }[]);
  if (blobCols.some((column) => column.name === "raw_bytes" && column.notnull === 1)) {
    db.exec("ALTER TABLE source_blobs RENAME TO source_blobs_pre_nullable");
    db.exec(`CREATE TABLE source_blobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash TEXT NOT NULL UNIQUE,
      byte_size INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      raw_bytes BLOB,
      decoded_content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO source_blobs (id, content_hash, byte_size, encoding, raw_bytes, decoded_content, created_at)
      SELECT id, content_hash, byte_size, encoding,
             CASE WHEN encoding = 'utf8' AND CAST(decoded_content AS BLOB) = raw_bytes THEN NULL ELSE raw_bytes END,
             decoded_content, created_at
        FROM source_blobs_pre_nullable`);
    db.exec("DROP TABLE source_blobs_pre_nullable");
  } else if (blobCols.length > 0) {
    // Column already nullable: clear any rows a previous build wrote redundantly.
    db.exec(`UPDATE source_blobs SET raw_bytes = NULL
              WHERE raw_bytes IS NOT NULL AND encoding = 'utf8'
                AND CAST(decoded_content AS BLOB) = raw_bytes`);
  }
  if (!branchCols.includes("resolver_version")) {
    // Left null on existing branches on purpose: resolveIndexMode reads null
    // as "unknown resolver" and rebuilds once, which re-derives edges with the
    // current resolver. Backfilling the current version instead would declare
    // old edges up to date and skip the rebuild that fixes them.
    db.exec("ALTER TABLE branches ADD COLUMN resolver_version TEXT");
  }
  if (!branchCols.includes("indexed_schema_version")) {
    db.exec("ALTER TABLE branches ADD COLUMN indexed_schema_version INTEGER");
  }
  if (!branchCols.includes("stale_reason")) {
    db.exec("ALTER TABLE branches ADD COLUMN stale_reason TEXT");
  }
  for (const [column, definition] of [
    ["default_branch", "INTEGER NOT NULL DEFAULT 0"],
    ["base_branch_name", "TEXT"],
    ["merge_base_commit", "TEXT"],
    ["current_snapshot_id", "TEXT"],
    ["last_accessed_at", "TEXT"],
    ["deleted_at", "TEXT"],
    ["recover_until", "TEXT"],
  ] as const) {
    if (!branchCols.includes(column)) db.exec(`ALTER TABLE branches ADD COLUMN ${column} ${definition}`);
  }
  const savedQueryCols = (db.prepare("PRAGMA table_info(saved_queries)").all() as { name: string }[]).map((c) => c.name);
  if (!savedQueryCols.includes("contract_version")) db.exec("ALTER TABLE saved_queries ADD COLUMN contract_version TEXT NOT NULL DEFAULT '2'");
  ensureOneDefaultBranchIndex(db);
}

function backfillFtsRowMaps(db: Database.Database): { symbolRows: number; identifierRows: number } {
  const symbolRows = db.prepare(
    `INSERT OR IGNORE INTO fts_symbol_rows(fts_rowid, node_id)
     SELECT rowid, node_id FROM fts_symbols`,
  ).run().changes;
  const identifierRows = db.prepare(
    `INSERT OR IGNORE INTO fts_identifier_rows(fts_rowid, repo_id, file_path)
     SELECT rowid, repo_id, file_path FROM fts_identifiers`,
  ).run().changes;
  return { symbolRows, identifierRows };
}

function hasFtsRowMaps(db: Database.Database): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name IN ('fts_symbol_rows', 'fts_identifier_rows')`,
    )
    .all() as Array<{ name: string }>;
  return rows.length === 2;
}

function ensureOneDefaultBranchIndex(db: Database.Database): void {
  const defaults = db.prepare(
    `SELECT id, repo_id AS repoId
       FROM branches
      WHERE default_branch=1
        AND name NOT IN ('(detached)', '(workdir)')
      ORDER BY repo_id, last_indexed_at DESC, name ASC`,
  ).all() as Array<{ id: string; repoId: string }>;
  const keep = new Set<string>();
  for (const row of defaults) {
    if (keep.has(row.repoId)) db.prepare("UPDATE branches SET default_branch=0 WHERE id=?").run(row.id);
    else keep.add(row.repoId);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_default_per_repo ON branches(repo_id) WHERE default_branch=1");
}

// Object names DDL creates (tables/indexes/triggers/views), parsed from the
// DDL text itself so the steady-state probe below can verify completeness
// without a hand-maintained list that would drift from the real schema.
const DDL_OBJECT_NAMES: string[] = [
  ...DDL.matchAll(
    /CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)/gi,
  ),
].map((m) => m[1]);

// These structures were added as same-version maintenance accelerators. They
// are only touched by indexing/write paths, so an already-current database
// remains safe to query while they are absent. A writable open installs and
// backfills them before any writer uses them.
const OPTIONAL_MAINTENANCE_OBJECT_NAMES = new Set([
  "parser_edge_sets",
  "trg_parser_edge_sets_insert",
  "trg_parser_edge_sets_delete",
  "trg_parser_edge_sets_update",
  "fts_symbol_rows",
  "idx_fts_symbol_rows_node",
  "fts_identifier_rows",
  "idx_fts_identifier_rows_scope",
  // Storage observability (GC history + daily size samples): read paths in
  // storage-report.ts degrade to null/empty when these are absent, and every
  // write to them is best-effort — so a pre-existing current DB must stay
  // readable (resident runtime, read verbs) until the next write command's
  // DDL pass creates them.
  "knowledge_gc_runs",
  "idx_knowledge_gc_runs_finished",
  "knowledge_size_samples",
  "external_calls",
  "idx_external_calls_src",
  "idx_external_calls_file",
  // Revision-scoped unresolved-reference ledger. Reads can remain honest with
  // an empty ledger on an older current DB; the next write/index pass creates
  // it through the canonical DDL before persisting new rows.
  "unresolved_reference_coverage",
  "idx_unresolved_reference_coverage_scope",
]);

/** Tables are derived from the same DDL used by openDatabase. */
export const SCHEMA_TABLES: readonly string[] = [
  ...DDL.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_]\w*)/gi),
].map((m) => m[1]);

// Read-only probe: does this DB already contain everything the write path of
// openDatabase would create? Mirrors migrate()'s idempotent guards (which add
// columns WITHOUT a SCHEMA_VERSION bump, so version equality alone doesn't
// prove completeness). Keep the two in sync: a new guard in migrate() needs
// its column check added here.
function isSchemaCurrent(
  db: Database.Database,
  options?: { allowMissingMaintenanceObjects?: boolean },
): boolean {
  const have = new Set(
    (db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name),
  );
  if (!DDL_OBJECT_NAMES.every((name) =>
    have.has(name) || (options?.allowMissingMaintenanceObjects && OPTIONAL_MAINTENANCE_OBJECT_NAMES.has(name))
  )) return false;
  if (!db.prepare("SELECT 1 FROM meta WHERE key='endpoint_inventory_generation'").get()) return false;
  const edgeCols = (db.prepare("PRAGMA table_info(edges)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (
    !edgeCols.includes("status") ||
    !edgeCols.includes("source_type") ||
    !edgeCols.includes("evidence_id") ||
    !edgeCols.includes("boundary")
  ) {
    return false;
  }
  const branchCols = (db.prepare("PRAGMA table_info(branches)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const requiredBranchColumns = [
    "pinned",
    "indexed_worktree_state",
    "indexed_worktree_fingerprint",
    "indexed_dirty_files",
    "parser_version",
    "resolver_version",
    "indexed_schema_version",
    "stale_reason",
    "pinned",
    "default_branch",
    "base_branch_name",
    "merge_base_commit",
    "current_snapshot_id",
    "last_accessed_at",
    "deleted_at",
    "recover_until",
  ];
  if (!requiredBranchColumns.every((column) => branchCols.includes(column))) return false;
  const externalCols = (db.prepare("PRAGMA table_info(external_knowledge_sources)").all() as { name: string }[]).map((c) => c.name);
  if (!externalCols.includes("content_type")) return false;
  const evidenceCols = (db.prepare("PRAGMA table_info(trust_evidence)").all() as { name: string }[]).map((c) => c.name);
  if (!evidenceCols.includes("query_hash")) return false;
  const coverageCols = (db.prepare("PRAGMA table_info(coverage_records)").all() as { name: string }[]).map((c) => c.name);
  if (!["parser_status", "parser_language", "parser_version", "parser_error"].every((column) => coverageCols.includes(column))) return false;
  const unresolvedItemCols = (db.prepare("PRAGMA table_info(unresolved_reference_items)").all() as { name: string }[]).map((c) => c.name);
  if (!unresolvedItemCols.includes("classification")) return false;
  const savedQueryCols = (db.prepare("PRAGMA table_info(saved_queries)").all() as { name: string }[]).map((c) => c.name);
  if (!savedQueryCols.includes("contract_version")) return false;
  // A NOT NULL raw_bytes is the old shape that stored every source file twice.
  // Without this the migration block below is unreachable and the duplicate
  // stays forever — the same way a missing column check once made the whole
  // branches migration dead code.
  const blobColumns = db.prepare("PRAGMA table_info(source_blobs)").all() as { name: string; notnull: number }[];
  if (blobColumns.some((column) => column.name === "raw_bytes" && column.notnull === 1)) return false;
  // The row-per-line table still being present is the old shape.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_blob_lines'").get()) return false;
  if (!have.has("idx_branches_one_default_per_repo")) return false;
  return db.prepare("SELECT 1 FROM ledger_state WHERE id='main'").get() != null;
}

function missingEdgeReplacementIndexes(db: Database.Database): string[] {
  const have = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  return EDGE_REPLACEMENT_INDEX_NAMES.filter((name) => !have.has(name));
}

function installEdgeReplacementIndexes(
  db: Database.Database,
  missingIndexes: readonly string[],
  onSchemaMaintenance?: (event: SchemaMaintenanceEvent) => void,
): void {
  if (missingIndexes.length === 0) return;
  const indexes = [...missingIndexes];
  const startedAt = Date.now();
  onSchemaMaintenance?.({
    operation: "edge-replacement-indexes",
    phase: "start",
    indexes,
  });
  db.transaction(() => db.exec(EDGE_REPLACEMENT_INDEX_DDL))();
  onSchemaMaintenance?.({
    operation: "edge-replacement-indexes",
    phase: "complete",
    indexes,
    elapsedMs: Date.now() - startedAt,
  });
}

/** Recreate the current schema after a guarded structural reset. This is kept
 * separate from openDatabase so reset can drop only rebuildable tables inside
 * its own transaction without reopening the database or running startup
 * maintenance. */
export function recreateCurrentSchemaObjects(db: Database.Database): void {
  db.exec(DDL);
  db.exec(EDGE_REPLACEMENT_INDEX_DDL);
  ensureDatabaseInstanceId(db);
}

export function openDatabase(
  path: string,
  options?: OpenDatabaseOptions,
): Database.Database {
  const db = new (loadDatabaseCtor())(path);
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
  const needsFtsRowMapBackfill = preexisting && !hasFtsRowMaps(db);

  const storedVersion = preexisting
    ? Number(
        (
          db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
            | { value: string }
            | undefined
        )?.value ?? 1,
      )
    : SCHEMA_VERSION;

  const supportedSchemaVersion = options?.supportedSchemaVersion ?? SCHEMA_VERSION;
  try {
    assertSchemaVersionSupported(storedVersion, supportedSchemaVersion);
  } catch (error) {
    db.close();
    throw error;
  }

  if (options?.skipMaintenance) {
    if (!preexisting || storedVersion !== SCHEMA_VERSION) {
      db.close();
      throw Object.assign(
        new Error(
          `guarded maintenance requires an existing current knowledge schema (stored=${storedVersion}, supported=${SCHEMA_VERSION})`,
        ),
        { code: "RESET_DATABASE_SCHEMA_UNSUPPORTED", storedVersion, supportedVersion: SCHEMA_VERSION },
      );
    }
    return db;
  }

  // Read-only opens and incompatible runtimes stop here, before journal_mode,
  // checkpoint, DDL, index maintenance, or any other persistent database write.
  if (options?.allowSchemaMutation === false) {
    const currentSchema = preexisting && storedVersion === SCHEMA_VERSION && isSchemaCurrent(db);
    const readableSchema = currentSchema || (
      preexisting &&
      storedVersion === SCHEMA_VERSION &&
      isSchemaCurrent(db, { allowMissingMaintenanceObjects: true })
    );
    if (readableSchema) return db;
    db.close();
    throw Object.assign(
      new Error(
        `knowledge database schema is outdated (stored=${storedVersion}, supported=${SCHEMA_VERSION}); ` +
          "the owner must call knowledge_index (or another write capability) to upgrade",
      ),
      { code: "SCHEMA_OUTDATED" },
    );
  }

  // v15 changes the meaning of persisted endpoint rows, not just their table
  // shape. Migrating an already-indexed DB in place would leave its old
  // unqualified/package-qualified twins traversable beside new memberships.
  // Empty databases can still take the additive migration path below; a real
  // index must be rebuilt into a fresh generation so readers never mix both
  // identity families.
  if (preexisting && storedVersion < 15) {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const indexedNodes = tables.has("nodes")
      ? (db.prepare(
          `SELECT 1 FROM nodes
            WHERE node_type IN ('endpoint','symbol','file','service','route','log_site','field','topic','websocket_event')
            LIMIT 1`,
        ).get() != null)
      : false;
    const derivedIndexTables = [
      "symbol_versions",
      "files_index",
      "edges",
      "parser_edge_sets",
      "revision_snapshots",
      "file_facts",
      "source_facts",
      "resolution_sets",
      "coverage_records",
      "coverage_layers",
      "unresolved_reference_coverage",
      "unresolved_reference_items",
      "external_calls",
      "pending_frontend_edges",
    ];
    const indexedRows = derivedIndexTables.some((table) =>
      tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() != null,
    );
    if (indexedNodes || indexedRows) {
      db.close();
      throw Object.assign(
        new Error(
          `REINDEX_REQUIRED: knowledge endpoint index schema ${storedVersion} cannot be mixed with canonical endpoint schema ${SCHEMA_VERSION}; build a fresh index generation`,
        ),
        { code: "REINDEX_REQUIRED", storedVersion, supportedVersion: SCHEMA_VERSION },
      );
    }
  }

  const configureWritablePragmas = () => {
    db.pragma("journal_mode = WAL");
    // synchronous=NORMAL avoids an fsync per indexing commit. This is a
    // rebuildable index, while WAL still preserves database consistency.
    db.pragma("synchronous = NORMAL");
    db.pragma("journal_size_limit = 268435456"); // 256MB
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // concurrent readers may defer the checkpoint until the next writer
    }
  };

  const currentSchema = preexisting && storedVersion === SCHEMA_VERSION && isSchemaCurrent(db);

  // Steady state (schema already current): return WITHOUT a single write once
  // the optional performance indexes are installed. Read-only callers may use
  // a current DB while those indexes are still missing; the next write command
  // performs the one-time optimization instead of breaking status/search.
  if (currentSchema) {
    configureWritablePragmas();
    db.exec("DROP INDEX IF EXISTS idx_edges_src; DROP INDEX IF EXISTS idx_edges_dst;");
    const currentCoverageColumns = new Set((db.prepare("PRAGMA table_info(coverage_records)").all() as { name: string }[]).map((column) => column.name));
    if (!currentCoverageColumns.has("unresolved_references")) {
      db.exec("ALTER TABLE coverage_records ADD COLUMN unresolved_references INTEGER NOT NULL DEFAULT 0");
    }
    const missingIndexes = missingEdgeReplacementIndexes(db);
    if (missingIndexes.length > 0) {
      installEdgeReplacementIndexes(db, missingIndexes, options?.onSchemaMaintenance);
    }
    // Retired tables are EXTRA objects, so isSchemaCurrent stays true and
    // migrate() never runs for this DB — the cleanup must happen here on the
    // write path, same contract as the performance indexes above.
    dropRetiredTables(db);
    ensureDatabaseInstanceId(db);
    return db;
  }

  const ftsMapStartedAt = needsFtsRowMapBackfill ? Date.now() : null;
  // DDL, additive migration, backfills, indexes, and the version advance are
  // one atomic unit. If a process or callback fails anywhere, SQLite rolls the
  // schema back to the exact image represented by the retained backup, so the
  // next launch can safely and idempotently retry.
  const runMigrationAttempt = (backup?: SchemaMigrationBackup, attemptFromVersion = storedVersion): void => {
    const migration = db.transaction(() => {
      // BEGIN IMMEDIATE has already excluded every other writer. Validate the
      // snapshot under that lock, so a commit after VACUUM INTO forces a fresh
      // backup instead of falling through to migration with a stale preimage.
      if (
        backup &&
        (
          databaseDataVersion(db) !== backup.sourceDataVersion ||
          !identitiesEqual(databaseIdentity(db, path, attemptFromVersion), backup.sourceIdentity)
        )
      ) {
        throw migrationSourceChanged();
      }

      if (ftsMapStartedAt != null) {
        options?.onSchemaMaintenance?.({ operation: "fts-row-maps", phase: "start" });
      }

      // These legacy indexes belong to the pre-migration image. Dropping them in
      // this transaction ensures a failed migration can retry against the exact
      // source identity recorded by the retained backup.
      db.exec("DROP INDEX IF EXISTS idx_edges_src; DROP INDEX IF EXISTS idx_edges_dst;");
      db.exec(DDL);
      ensureDatabaseInstanceId(db);

      migrate(db, attemptFromVersion);
      const ftsRows = backfillFtsRowMaps(db);
      if (ftsMapStartedAt != null) {
        options?.onSchemaMaintenance?.({
          operation: "fts-row-maps",
          phase: "complete",
          ...ftsRows,
          elapsedMs: Date.now() - ftsMapStartedAt,
        });
      }

      // Performance-only migration: no SCHEMA_VERSION bump, because changing the
      // indexed schema version would incorrectly force every branch to rebuild.
      installEdgeReplacementIndexes(
        db,
        missingEdgeReplacementIndexes(db),
        preexisting ? options?.onSchemaMaintenance : undefined,
      );

      // Advance only as the final statement in the same migration transaction.
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(SCHEMA_VERSION));
      db.prepare(
        "INSERT OR IGNORE INTO ledger_state (id, materialized_seq) VALUES ('main', 0)",
      ).run();
    });
    migration.immediate();
  };

  if (preexisting && storedVersion < SCHEMA_VERSION) {
    const maxBackupAttempts = 3;
    for (let attempt = 1; attempt <= maxBackupAttempts; attempt += 1) {
      const attemptFromVersion = Number(
        (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined)?.value ?? 0,
      );
      assertSchemaVersionSupported(attemptFromVersion, supportedSchemaVersion);
      if (attemptFromVersion === SCHEMA_VERSION) {
        if (isSchemaCurrent(db)) {
          // A concurrent publisher completed before this retry observed the
          // source. Never create or validate a backup labelled with the stale
          // version captured when this connection first opened.
          break;
        }
        // Preserve the existing repair behavior for a current-version file
        // whose additive schema objects are incomplete, without fabricating a
        // current-to-current retained migration backup.
        runMigrationAttempt(undefined, attemptFromVersion);
        break;
      }
      try {
        const backup = ensureSchemaMigrationBackup(
          db,
          path,
          attemptFromVersion,
          SCHEMA_VERSION,
          options?.onSchemaMaintenance,
        );
        runMigrationAttempt(backup, attemptFromVersion);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "SCHEMA_MIGRATION_SOURCE_CHANGED") throw error;
        if (attempt === maxBackupAttempts) {
          const finalObservedVersion = Number(
            (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined)?.value ?? 0,
          );
          assertSchemaVersionSupported(finalObservedVersion, supportedSchemaVersion);
          if (finalObservedVersion === SCHEMA_VERSION && isSchemaCurrent(db)) break;
          throw Object.assign(
            new Error("SCHEMA_BACKUP_BUSY: source kept changing before migration could acquire its write lock"),
            { code: "SCHEMA_BACKUP_BUSY" },
          );
        }
        options?.onSchemaMaintenance?.({
          operation: "schema-migration-backup",
          phase: "before-backup-retry",
          path: schemaMigrationBackupPath(path, attemptFromVersion, SCHEMA_VERSION),
          fromVersion: attemptFromVersion,
          toVersion: SCHEMA_VERSION,
        });
      }
    }
  } else {
    runMigrationAttempt();
  }
  // Persistent journal changes happen only after the migration transaction
  // commits successfully; a failed attempt leaves the source image untouched.
  configureWritablePragmas();
  return db;
}
