import type Database from "better-sqlite3";
import { createRequire } from "node:module";

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
    };

export interface OpenDatabaseOptions {
  allowSchemaMutation?: boolean;
  onSchemaMaintenance?: (event: SchemaMaintenanceEvent) => void;
}

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
  indexed_worktree_state TEXT NOT NULL DEFAULT 'unknown',
  indexed_worktree_fingerprint TEXT,
  indexed_dirty_files TEXT NOT NULL DEFAULT '[]',
  parser_version TEXT,
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
CREATE TABLE IF NOT EXISTS snapshot_resolution_refs (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  resolution_set_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file_path)
);
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
  raw_bytes BLOB NOT NULL,
  decoded_content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_blob_lines (
  source_blob_id INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  start_char INTEGER NOT NULL,
  end_char INTEGER NOT NULL,
  PRIMARY KEY (source_blob_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_source_blob_lines_byte ON source_blob_lines(source_blob_id, start_byte, end_byte);
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
  PRIMARY KEY (repo_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_coverage_records_path ON coverage_records(repo_id, file_path);
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
CREATE TABLE IF NOT EXISTS semantic_chunks (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  source_blob_id INTEGER,
  node_id TEXT,
  start_byte INTEGER,
  end_byte INTEGER,
  chunk_kind TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embedding_models (
  model_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vec_table_name TEXT NOT NULL UNIQUE,
  installed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS semantic_embedding_refs (
  model_hash TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  vec_rowid INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  embedded_at TEXT,
  PRIMARY KEY (model_hash, chunk_id)
);
CREATE TABLE IF NOT EXISTS semantic_vector_values (
  vec_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  model_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_semantic_vector_values_model ON semantic_vector_values(model_hash);
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
CREATE INDEX IF NOT EXISTS idx_effective_snapshot_sources_fact ON effective_snapshot_sources(source_fact_id);
CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(content, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS source_lexical_fts USING fts5(content, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS source_path_fts USING fts5(file_path, source_fact_id UNINDEXED, tokenize='unicode61');
`;

export const SCHEMA_VERSION = 14;

/** Canonical schema history consumed by generated operator documentation. */
export const SCHEMA_MIGRATIONS = [
  { version: 10, name: "source-snapshots", summary: "content-addressed source blobs, snapshot overlays, coverage and resolver metadata" },
  { version: 11, name: "markdown-vault", summary: "Markdown sections, properties, wikilinks, evidence and saved-query records" },
  { version: 12, name: "semantic-and-memory", summary: "memory, ontology, semantic chunks, embeddings and reflection records" },
  { version: 13, name: "trust-and-external-sources", summary: "validated findings, audit events, external sources and revision-safe evidence" },
  { version: 14, name: "coverage-layers-and-edge-boundaries", summary: "coverage_layers table; edges.evidence_id + edges.boundary; forced rebuild on schema bump" },
] as const;

// Idempotent additive migrations for schemas that predate SCHEMA_VERSION.
// Each step guards on actual schema state (column presence) rather than the
// stored version, so a mislabeled version can't corrupt an already-migrated
// DB — and CREATE TABLE/INDEX IF NOT EXISTS in DDL already covers new *tables*.
// `from` is the version read from meta; gate future NON-idempotent steps on it
// (e.g. `if (from < 5) { ...backfill... }`). Additive column adds stay in the
// idempotent guards below and need no version gate.
function migrate(db: Database.Database, _from: number): void {
  const evidenceCols = (db.prepare("PRAGMA table_info(trust_evidence)").all() as { name: string }[]).map((c) => c.name);
  if (!evidenceCols.includes("query_hash")) db.exec("ALTER TABLE trust_evidence ADD COLUMN query_hash TEXT");
  const coverageCols = (db.prepare("PRAGMA table_info(coverage_records)").all() as { name: string }[]).map((c) => c.name);
  for (const [column, definition] of [
    ["parser_status", "TEXT NOT NULL DEFAULT 'not_applicable'"],
    ["parser_language", "TEXT"],
    ["parser_version", "TEXT"],
    ["parser_error", "TEXT"],
  ] as const) {
    if (!coverageCols.includes(column)) db.exec(`ALTER TABLE coverage_records ADD COLUMN ${column} ${definition}`);
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
  const savedQueryCols = (db.prepare("PRAGMA table_info(saved_queries)").all() as { name: string }[]).map((c) => c.name);
  if (!savedQueryCols.includes("contract_version")) return false;
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

export function openDatabase(
  path: string,
  options?: OpenDatabaseOptions,
): Database.Database {
  const db = new (loadDatabaseCtor())(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // WAL hygiene: long-lived readers (MCP workers, watcher, desktop) starve
  // checkpoints, and without a size limit the WAL once grew to 16GB against a
  // 6GB main DB. The limit auto-truncates at checkpoint time; the passive
  // checkpoint folds whatever the last writer left behind — best-effort, a
  // busy moment just means the next open gets it.
  db.pragma("journal_size_limit = 268435456"); // 256MB
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch {
    // read-only filesystems / concurrent writers — never block an open on this
  }
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

  const currentSchema = preexisting && storedVersion === SCHEMA_VERSION && isSchemaCurrent(db);
  const readableSchema = currentSchema || (
    preexisting &&
    storedVersion === SCHEMA_VERSION &&
    isSchemaCurrent(db, { allowMissingMaintenanceObjects: true })
  );

  // Fail loud on a DB written by a newer build — operating on it with an older
  // schema would silently drop/misread columns (§9 绝不静默降级).
  if (storedVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `knowledge.db schema_version ${storedVersion} is newer than this build ` +
        `supports (${SCHEMA_VERSION}); upgrade Penguin before opening it.`,
    );
  }

  // Steady state (schema already current): return WITHOUT a single write once
  // the optional performance indexes are installed. Read-only callers may use
  // a current DB while those indexes are still missing; the next write command
  // performs the one-time optimization instead of breaking status/search.
  if (currentSchema) {
    const missingIndexes = missingEdgeReplacementIndexes(db);
    if (missingIndexes.length > 0 && options?.allowSchemaMutation !== false) {
      installEdgeReplacementIndexes(db, missingIndexes, options?.onSchemaMaintenance);
    }
    return db;
  }

  if (readableSchema && options?.allowSchemaMutation === false) return db;

  // Read-only callers (CLI read verbs) must never take the write lock or run
  // DDL/migrations against a stale DB — fail loud instead (Task 4, §9 绝不静默降级).
  if (options?.allowSchemaMutation === false) {
    db.close();
    throw Object.assign(
      new Error(
        `knowledge database schema is outdated (stored=${storedVersion}, supported=${SCHEMA_VERSION}); ` +
          "run `penguin index` (or any write command) to upgrade",
      ),
      { code: "SCHEMA_OUTDATED" },
    );
  }

  const ftsMapStartedAt = needsFtsRowMapBackfill ? Date.now() : null;
  if (ftsMapStartedAt != null) {
    options?.onSchemaMaintenance?.({ operation: "fts-row-maps", phase: "start" });
  }

  db.exec(DDL);

  migrate(db, storedVersion);
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
  // Existing large DBs get a visible callback; fresh empty DBs create the same
  // indexes silently as part of initialization.
  installEdgeReplacementIndexes(
    db,
    missingEdgeReplacementIndexes(db),
    preexisting ? options?.onSchemaMaintenance : undefined,
  );

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
