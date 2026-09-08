import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  captureCorpusBaseline,
  captureProtectedAssets,
  createConsistentDatabaseBackup,
  databaseInstanceId,
  readProtectedAssetBundle,
  restoreStructuralMixedAssets,
  type CorpusBaseline,
  type DatabaseBackupReceipt,
  type KnowledgeDatabaseHandle,
  type ProtectedAssetBundle,
  MIXED_ASSET_TABLES,
  PROTECTED_ASSET_TABLES,
  REBUILDABLE_ASSET_TABLES,
  writeCorpusBaseline,
  writeProtectedAssetBundle,
} from "./asset-export.js";
import {
  appendResetManifestPhase,
  consumeResetPlan,
  createFullResetConfirmationToken,
  fullResetManifestPath,
  fullResetPlanDigest,
  readResetManifest,
  type FullResetPlan,
  type FullResetPhase,
  type ResetManifest,
  writeResetManifest,
} from "./reset-manifest.js";
import { recreateCurrentSchemaObjects } from "./schema.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface FullResetPlanOptions {
  rootPath: string;
  databasePath: string;
  backupPath: string;
  manifestPath?: string;
  baseline?: CorpusBaseline;
  protectedAssets?: ProtectedAssetBundle;
  expiresInMs?: number;
  /** Defaults to 10 GiB so a live full-reset backup cannot consume the last
   * usable disk space. */
  minimumFreeBytesAfterBackup?: number;
}

export interface FullResetPlanningResult {
  plan: FullResetPlan;
  baseline: CorpusBaseline;
  protectedAssets: ProtectedAssetBundle;
  backup: DatabaseBackupReceipt;
}

export interface FullResetReissueOptions {
  sourceManifestPath: string;
  manifestPath: string;
  confirmed: boolean;
  expiresInMs?: number;
}

export interface FullResetReissueResult {
  plan: FullResetPlan;
  reusedBackupPath: string;
  reusedBackupBytes: number;
  reissuedFromOperationId: string;
}

export interface FullResetExecutionOptions {
  databasePath: string;
  token: string;
  manifestPath?: string;
  failAt?: "after_fence" | "during_reset" | "after_reset";
  /** Test-only crash boundaries. Production callers leave this unset. */
  testHooks?: {
    afterFence?: (context: { operationId: string; databasePath: string }) => void;
    beforeDelete?: (context: { table: string }) => void;
    afterDelete?: (context: { table: string; changes: number }) => void;
    afterReset?: (context: { operationId: string; deleted: Record<string, number> }) => void;
  };
}

export interface FullResetFinalizeOptions {
  databasePath: string;
  manifestPath: string;
  confirmed: boolean;
}

export interface FullResetReceipt {
  operationId: string;
  phase: FullResetPhase;
  previousDatabaseInstanceId: string;
  databaseInstanceId: string;
  intentionalProtectedAssetChanges: string[];
  deletedRebuildableRows: Record<string, number>;
  droppedRebuildableTables: string[];
  recreatedMixedTables: string[];
  remainingTargetIndexRows: Record<string, number>;
  protectedAssetHashes: Record<string, string>;
  sourceRepositoriesUntouched: boolean;
  rollbackAvailable: boolean;
  gaps: string[];
}

export interface FullResetRollbackReceipt {
  destinationPath: string;
  sourceDatabaseInstanceId: string;
  restoredDatabaseInstanceId: string;
  integrity: "ok";
  sourceBackupPath: string;
}

export interface FullResetCrashRecoveryReceipt {
  operationId: string;
  manifestPhase: FullResetPhase;
  fencePath: string;
  recovered: boolean;
  databaseIntegrity: "ok" | "not_checked";
  rollbackAvailable: boolean;
  gaps: string[];
}

interface ResetScope {
  repoIds: string[];
  branchIds: string[];
  snapshotIds: string[];
  fileFactIds: string[];
  sourceFactIds: string[];
  sourceBlobIds: number[];
  resolutionSetIds: string[];
  nodeIds: string[];
  protectedNodeIds: string[];
  allRepositoriesSelected: boolean;
  allTargetRepositoriesSelected: boolean;
}

interface ResetTargetRepository {
  repoId: string;
  name: string;
  rootPath: string;
  remoteUrl: string | null;
  branches: Array<{ id: string; name: string; headCommit: string | null }>;
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`RESET_IDENTIFIER_INVALID:${value}`);
  return `"${value}"`;
}

function placeholders(values: readonly unknown[]): string {
  return values.length > 0 ? values.map(() => "?").join(",") : "NULL";
}

function jsonSet(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function within(rootPath: string, candidate: string): boolean {
  const rest = relative(rootPath, candidate);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name=? LIMIT 1").get(table) != null;
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function ids(db: Database.Database, sql: string, args: readonly unknown[]): string[] {
  return (db.prepare(sql).all(...args) as Array<{ id: string }>).map((row) => String(row.id));
}

function numberIds(db: Database.Database, sql: string, args: readonly unknown[]): number[] {
  return (db.prepare(sql).all(...args) as Array<{ id: number }>).map((row) => Number(row.id));
}

export function protectedNodeIdsFromAssets(bundle: ProtectedAssetBundle): string[] {
  const ids = new Set<string>();
  const collect = (tableKey: string, column: string): void => {
    const table = bundle.tables[tableKey];
    if (!table) return;
    const index = table.columns.indexOf(column);
    if (index < 0) return;
    for (const row of table.rows) {
      const value = row[index];
      if (typeof value === "string" && value.length > 0) ids.add(value);
    }
  };
  collect("protected_nodes", "id");
  collect("node_aliases", "node_id");
  collect("notes_index", "node_id");
  collect("credential_entries", "node_id");
  collect("response_samples", "endpoint_id");
  collect("events", "node_id");
  collect("durable_edges", "src");
  collect("durable_edges", "dst");
  return [...ids].sort();
}

export function fullCorpusNodeSelectionMode(
  selectedRepositoryCount: number,
  registeredRepositoryCount: number,
): "all_unprotected_nodes" | "scoped_edge_expansion" {
  return selectedRepositoryCount === registeredRepositoryCount
    ? "all_unprotected_nodes"
    : "scoped_edge_expansion";
}

const REBUILDABLE_ASSET_TABLE_SET = new Set<string>(REBUILDABLE_ASSET_TABLES);

/** A complete-corpus reset must stay inside SQLite. Materializing every node,
 * chunk, source blob, and vector ID in JavaScript makes reset memory scale with
 * corpus size and caused >1 GiB RSS on the real 12 GiB database. The protected
 * node set is deliberately small and comes from the signed asset sidecar. */
export function fullCorpusResetPredicate(
  table: string,
  protectedNodeIds: readonly string[],
): { sql: string; args: unknown[] } | null {
  if (table === "nodes") {
    const protectedIds = [...new Set(protectedNodeIds)].sort();
    return protectedIds.length === 0
      ? { sql: "1", args: [] }
      : { sql: "id NOT IN (SELECT value FROM json_each(?))", args: [jsonSet(protectedIds)] };
  }
  if (table === "edges") return { sql: "origin='parser'", args: [] };
  if (REBUILDABLE_ASSET_TABLE_SET.has(table)) return { sql: "1", args: [] };
  return null;
}

function buildResetScope(
  db: Database.Database,
  repoIds: string[],
  protectedNodeIds: readonly string[],
  options: { allTargetRepositoriesSelected?: boolean } = {},
): ResetScope {
  const registeredRepositoryCount = Number((db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n ?? 0);
  const allRepositoriesSelected = fullCorpusNodeSelectionMode(repoIds.length, registeredRepositoryCount) === "all_unprotected_nodes";
  if (allRepositoriesSelected) {
    return {
      repoIds: [...repoIds].sort(),
      branchIds: [],
      snapshotIds: [],
      fileFactIds: [],
      sourceFactIds: [],
      sourceBlobIds: [],
      resolutionSetIds: [],
      nodeIds: [],
      protectedNodeIds: [...new Set(protectedNodeIds)].sort(),
      allRepositoriesSelected: true,
      allTargetRepositoriesSelected: false,
    };
  }
  // A full-reset plan is rooted at a directory, so every repository selected
  // by that plan is a target even when unrelated repositories are registered
  // elsewhere in the same database. Keep the outside repositories intact,
  // but use SQL relationship predicates instead of materializing their full
  // node ID sets in JavaScript.
  if (options.allTargetRepositoriesSelected) {
    const branches = repoIds.length > 0
      ? ids(db, `SELECT id FROM branches WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
      : [];
    const snapshots = repoIds.length > 0
      ? ids(db, `SELECT id FROM revision_snapshots WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
      : [];
    const fileFacts = repoIds.length > 0
      ? ids(db, `SELECT id FROM file_facts WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
      : [];
    const sourceFacts = repoIds.length > 0
      ? ids(db, `SELECT id FROM source_facts WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
      : [];
    const candidateBlobs = repoIds.length > 0
      ? numberIds(db, `
          SELECT DISTINCT source_blob_id AS id FROM source_facts
           WHERE repo_id IN (${placeholders(repoIds)}) AND source_blob_id IS NOT NULL
          UNION
          SELECT DISTINCT e.source_blob_id AS id
            FROM effective_snapshot_sources e
            JOIN revision_snapshots s ON s.id=e.snapshot_id
           WHERE s.repo_id IN (${placeholders(repoIds)}) AND e.source_blob_id IS NOT NULL
        `, [...repoIds, ...repoIds])
      : [];
    const safeBlobs = candidateBlobs.length > 0
      ? numberIds(db, `
          SELECT b.id AS id FROM source_blobs b
           WHERE b.id IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (
               SELECT 1 FROM source_facts sf
                WHERE sf.source_blob_id=b.id AND sf.repo_id NOT IN (SELECT value FROM json_each(?))
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM effective_snapshot_sources es
                 JOIN revision_snapshots rs ON rs.id=es.snapshot_id
                WHERE es.source_blob_id=b.id AND rs.repo_id NOT IN (SELECT value FROM json_each(?))
             )
        `, [jsonSet(candidateBlobs), jsonSet(repoIds), jsonSet(repoIds)])
      : [];
    const resolutionSets = fileFacts.length > 0
      ? ids(db, "SELECT id FROM resolution_sets WHERE file_fact_id IN (SELECT value FROM json_each(?))", [jsonSet(fileFacts)])
      : [];
    return {
      repoIds: [...repoIds].sort(),
      branchIds: branches.sort(),
      snapshotIds: snapshots.sort(),
      fileFactIds: fileFacts.sort(),
      sourceFactIds: sourceFacts.sort(),
      sourceBlobIds: [...new Set(safeBlobs)].sort((a, b) => a - b),
      resolutionSetIds: resolutionSets.sort(),
      nodeIds: [],
      protectedNodeIds: [...new Set(protectedNodeIds)].sort(),
      allRepositoriesSelected: false,
      allTargetRepositoriesSelected: true,
    };
  }
  const branches = repoIds.length > 0
    ? ids(db, `SELECT id FROM branches WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
    : [];
  const snapshots = repoIds.length > 0
    ? ids(db, `SELECT id FROM revision_snapshots WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
    : [];
  const fileFacts = repoIds.length > 0
    ? ids(db, `SELECT id FROM file_facts WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
    : [];
  const sourceFacts = repoIds.length > 0
    ? ids(db, `SELECT id FROM source_facts WHERE repo_id IN (${placeholders(repoIds)})`, repoIds)
    : [];
  const candidateBlobs = repoIds.length > 0
    ? numberIds(db, `
        SELECT DISTINCT source_blob_id AS id FROM source_facts
         WHERE repo_id IN (${placeholders(repoIds)}) AND source_blob_id IS NOT NULL
        UNION
        SELECT DISTINCT e.source_blob_id AS id
          FROM effective_snapshot_sources e
          JOIN revision_snapshots s ON s.id=e.snapshot_id
         WHERE s.repo_id IN (${placeholders(repoIds)}) AND e.source_blob_id IS NOT NULL
      `, [...repoIds, ...repoIds])
    : [];
  const safeBlobs = candidateBlobs.length > 0
    ? numberIds(db, `
        SELECT b.id AS id FROM source_blobs b
         WHERE b.id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (
             SELECT 1 FROM source_facts sf
              WHERE sf.source_blob_id=b.id AND sf.repo_id NOT IN (SELECT value FROM json_each(?))
           )
           AND NOT EXISTS (
             SELECT 1
               FROM effective_snapshot_sources es
               JOIN revision_snapshots rs ON rs.id=es.snapshot_id
              WHERE es.source_blob_id=b.id AND rs.repo_id NOT IN (SELECT value FROM json_each(?))
           )
      `, [jsonSet(candidateBlobs), jsonSet(repoIds), jsonSet(repoIds)])
    : [];
  const resolutionSets = fileFacts.length > 0
    ? ids(db, "SELECT id FROM resolution_sets WHERE file_fact_id IN (SELECT value FROM json_each(?))", [jsonSet(fileFacts)])
    : [];
  const candidateNodes = new Set<string>();
  if (allRepositoriesSelected) {
    for (const row of db.prepare("SELECT id FROM nodes").all() as Array<{ id: string }>) candidateNodes.add(row.id);
  } else if (repoIds.length > 0) {
    for (const row of db.prepare(`SELECT id FROM nodes WHERE repo_id IN (${placeholders(repoIds)})`).all(...repoIds) as Array<{ id: string }>) candidateNodes.add(row.id);
  }
  if (!allRepositoriesSelected && branches.length > 0) {
    for (const row of db.prepare(`SELECT node_id AS id FROM symbol_versions WHERE branch_id IN (${placeholders(branches)})`).all(...branches) as Array<{ id: string }>) candidateNodes.add(row.id);
    for (const row of db.prepare(`
      SELECT src AS id FROM edges WHERE origin='parser' AND branch_id IN (${placeholders(branches)})
      UNION SELECT dst AS id FROM edges WHERE origin='parser' AND branch_id IN (${placeholders(branches)}) AND dst IS NOT NULL
    `).all(...branches, ...branches) as Array<{ id: string }>) candidateNodes.add(row.id);
  }
  if (!allRepositoriesSelected && repoIds.length > 0) {
    for (const row of db.prepare(`
      SELECT src AS id FROM edges
       WHERE origin='parser' AND branch_id IS NULL AND json_extract(provenance,'$.repo') IN (${placeholders(repoIds)})
      UNION SELECT dst AS id FROM edges
       WHERE origin='parser' AND branch_id IS NULL AND json_extract(provenance,'$.repo') IN (${placeholders(repoIds)}) AND dst IS NOT NULL
    `).all(...repoIds, ...repoIds) as Array<{ id: string }>) candidateNodes.add(row.id);
  }
  const protectedNodes = new Set(protectedNodeIds);
  const nodeIds = [...candidateNodes].filter((id) => !protectedNodes.has(id)).sort();
  return {
    repoIds: [...repoIds].sort(),
    branchIds: branches.sort(),
    snapshotIds: snapshots.sort(),
    fileFactIds: fileFacts.sort(),
    sourceFactIds: sourceFacts.sort(),
    sourceBlobIds: [...new Set(safeBlobs)].sort((a, b) => a - b),
    resolutionSetIds: resolutionSets.sort(),
    nodeIds,
    protectedNodeIds: [...new Set(protectedNodeIds)].sort(),
    allRepositoriesSelected,
    allTargetRepositoriesSelected: false,
  };
}

function inPredicate(column: string, values: readonly unknown[]): { sql: string; args: unknown[] } | null {
  if (values.length === 0) return null;
  return {
    sql: `${quoteIdentifier(column)} IN (SELECT value FROM json_each(?))`,
    args: [jsonSet(values)],
  };
}

/**
 * Delete a complete reset target without first loading every node/chunk/vector
 * ID into V8. All repository/branch/snapshot relationships stay inside
 * SQLite; only the bounded parent-id lists captured during scope planning are
 * passed as JSON parameters.
 */
function targetedFullResetPredicate(
  db: Database.Database,
  table: string,
  scope: ResetScope,
): { sql: string; args: unknown[] } | null {
  if (!tableExists(db, table)) return null;
  const repoIds = jsonSet(scope.repoIds);
  const branchIds = jsonSet(scope.branchIds);
  const snapshotIds = jsonSet(scope.snapshotIds);
  const targetRepo = (column: string): { sql: string; args: unknown[] } => ({
    sql: `${quoteIdentifier(column)} IN (SELECT value FROM json_each(?))`,
    args: [repoIds],
  });
  const targetBranch = (column: string): { sql: string; args: unknown[] } => ({
    sql: `${quoteIdentifier(column)} IN (SELECT value FROM json_each(?))`,
    args: [branchIds],
  });
  const targetSnapshot = (column: string): { sql: string; args: unknown[] } => ({
    sql: `${quoteIdentifier(column)} IN (SELECT value FROM json_each(?))`,
    args: [snapshotIds],
  });
  if (table === "nodes") {
    const target = targetRepo("repo_id");
    if (scope.protectedNodeIds.length === 0) return target;
    return {
      sql: `(${target.sql}) AND id NOT IN (SELECT value FROM json_each(?))`,
      args: [...target.args, jsonSet(scope.protectedNodeIds)],
    };
  }
  if (table === "edges") {
    return {
      sql: `origin='parser' AND (
        branch_id IN (SELECT value FROM json_each(?)) OR
        (branch_id IS NULL AND json_extract(provenance,'$.repo') IN (SELECT value FROM json_each(?)))
      )`,
      args: [branchIds, repoIds],
    };
  }
  if (table === "global_resolved_edges") {
    return { sql: "json_extract(provenance,'$.repo') IN (SELECT value FROM json_each(?))", args: [repoIds] };
  }
  if (table === "source_blobs") return inPredicate("id", scope.sourceBlobIds);
  if (table === "endpoint_aliases") {
    return {
      sql: "endpoint_id IN (SELECT id FROM nodes WHERE repo_id IN (SELECT value FROM json_each(?)))",
      args: [repoIds],
    };
  }
  const available = columns(db, table);
  const relationCandidates: Array<{ sql: string; args: unknown[] }> = [];
  if (available.has("repo_id")) relationCandidates.push(targetRepo("repo_id"));
  if (available.has("branch_id")) relationCandidates.push(targetBranch("branch_id"));
  if (available.has("snapshot_id")) relationCandidates.push(targetSnapshot("snapshot_id"));
  if (available.has("revision_id")) relationCandidates.push(targetSnapshot("revision_id"));
  if (available.has("file_fact_id") && scope.fileFactIds.length > 0) relationCandidates.push(inPredicate("file_fact_id", scope.fileFactIds)!);
  if (available.has("source_fact_id") && scope.sourceFactIds.length > 0) relationCandidates.push(inPredicate("source_fact_id", scope.sourceFactIds)!);
  if (available.has("source_blob_id") && scope.sourceBlobIds.length > 0) relationCandidates.push(inPredicate("source_blob_id", scope.sourceBlobIds)!);
  if (available.has("resolution_set_id") && scope.resolutionSetIds.length > 0) relationCandidates.push(inPredicate("resolution_set_id", scope.resolutionSetIds)!);
  if (available.has("node_id")) {
    relationCandidates.push({
      sql: "node_id IN (SELECT id FROM nodes WHERE repo_id IN (SELECT value FROM json_each(?)))",
      args: [repoIds],
    });
  }
  return relationCandidates.length === 0
    ? null
    : { sql: `(${relationCandidates.map((candidate) => candidate.sql).join(" OR ")})`, args: relationCandidates.flatMap((candidate) => candidate.args) };
}

function resetPredicate(db: Database.Database, table: string, scope: ResetScope): { sql: string; args: unknown[] } | null {
  if (!tableExists(db, table)) return null;
  if (scope.allRepositoriesSelected) return fullCorpusResetPredicate(table, scope.protectedNodeIds);
  if (scope.allTargetRepositoriesSelected) return targetedFullResetPredicate(db, table, scope);
  if (table === "nodes") return inPredicate("id", scope.nodeIds);
  if (table === "edges") {
    const branches = inPredicate("branch_id", scope.branchIds);
    const repoArgs = scope.repoIds.length > 0 ? [...scope.repoIds] : [];
    const repoClause = scope.repoIds.length > 0 ? "branch_id IS NULL AND json_extract(provenance,'$.repo') IN (SELECT value FROM json_each(?))" : "0";
    const nodeClause = scope.nodeIds.length > 0
      ? "(src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?)))"
      : "0";
    return {
      sql: `origin='parser' AND (${branches ? `${branches.sql} OR ` : ""}${repoClause} OR ${nodeClause})`,
      args: [
        ...(branches?.args ?? []),
        ...(repoArgs.length > 0 ? [jsonSet(repoArgs)] : []),
        ...(scope.nodeIds.length > 0 ? [jsonSet(scope.nodeIds), jsonSet(scope.nodeIds)] : []),
      ],
    };
  }
  if (table === "source_backfill_checkpoints") return scope.allRepositoriesSelected ? { sql: "1", args: [] } : null;
  if (table === "global_resolved_edges") {
    return scope.repoIds.length > 0
      ? { sql: "json_extract(provenance,'$.repo') IN (SELECT value FROM json_each(?))", args: [jsonSet(scope.repoIds)] }
      : null;
  }
  const available = columns(db, table);
  const candidates: Array<{ sql: string; args: unknown[] }> = [];
  const byColumn: Array<[string, readonly unknown[]]> = [
    ["repo_id", scope.repoIds],
    ["branch_id", scope.branchIds],
    ["snapshot_id", scope.snapshotIds],
    ["revision_id", scope.snapshotIds],
    ["file_fact_id", scope.fileFactIds],
    ["source_fact_id", scope.sourceFactIds],
    ["source_blob_id", scope.sourceBlobIds],
    ["resolution_set_id", scope.resolutionSetIds],
    ["node_id", scope.nodeIds],
    ["source_node_id", scope.nodeIds],
  ];
  for (const [column, values] of byColumn) if (available.has(column)) {
    const predicate = inPredicate(column, values);
    if (predicate) candidates.push(predicate);
  }
  if (table === "source_blobs" && scope.sourceBlobIds.length > 0) {
    return {
      sql: "id IN (SELECT value FROM json_each(?))",
      args: [jsonSet(scope.sourceBlobIds)],
    };
  }
  if (candidates.length === 0) return null;
  return {
    sql: `(${candidates.map((candidate) => candidate.sql).join(" OR ")})`,
    args: candidates.flatMap((candidate) => candidate.args),
  };
}

function countTargetRows(db: Database.Database, scope: ResetScope): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of [...REBUILDABLE_ASSET_TABLES, "nodes", "edges"]) {
    const predicate = resetPredicate(db, table, scope);
    result[table] = predicate == null
      ? 0
      : Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} WHERE ${predicate.sql}`).get(...predicate.args) as { n: number }).n ?? 0);
  }
  return result;
}

/**
 * In the all-repositories reset lane, every target predicate is executed by
 * the same immediate SQLite transaction immediately before this point. A
 * successful DELETE has already established that no row matching that
 * predicate remains; running COUNT(*) again here needlessly scans every large
 * table (the real database is multi-gigabyte). Keep the exact count path for
 * scoped resets, where shared-row predicates are assembled from materialized
 * ids, but use the transaction result as the proof for the full-corpus lane.
 */
function remainingTargetRowsAfterDelete(scope: ResetScope): Record<string, number> {
  if (!scope.allRepositoriesSelected && !scope.allTargetRepositoriesSelected) return {};
  return Object.fromEntries(
    [...new Set([...REBUILDABLE_ASSET_TABLES, "nodes", "edges"])].map((table) => [table, 0]),
  );
}

interface ResetDeletionResult {
  deleted: Record<string, number>;
  droppedRebuildableTables: string[];
  recreatedMixedTables: string[];
}

function deleteTargetRows(
  db: Database.Database,
  scope: ResetScope,
  protectedAssets: ProtectedAssetBundle,
  failAt?: FullResetExecutionOptions["failAt"],
  testHooks?: FullResetExecutionOptions["testHooks"],
): ResetDeletionResult {
  const trace = (message: string): void => {
    if (process.env.PENGUIN_RESET_TRACE !== "1") return;
    const line = `[reset-trace] ${new Date().toISOString()} ${message}\n`;
    console.error(line.trimEnd());
    const tracePath = process.env.PENGUIN_RESET_TRACE_FILE;
    if (tracePath) appendFileSync(tracePath, line, { mode: 0o600 });
  };
  const order = [
    ...(scope.allTargetRepositoriesSelected ? ["endpoint_aliases", "nodes"] : ["edges"]),
    "parser_edge_sets",
    "fts_symbols",
    "fts_symbol_rows",
    "fts_identifiers",
    "fts_identifier_rows",
    "files_index",
    "coverage_layers",
    "coverage_records",
    "unresolved_reference_coverage",
    "unresolved_reference_items",
    "external_calls",
    "snapshot_resolution_refs",
    "resolved_edges",
    "global_resolved_edges",
    "resolution_sets",
    "revision_references",
    "deployment_revisions",
    "snapshot_overlays",
    "effective_snapshot_files",
    "snapshot_rename_events",
    "revision_snapshots",
    "file_fact_symbols",
    "file_fact_sources",
    "file_facts",
    "source_path_fts",
    "source_blob_line_offsets",
    "source_blob_trigrams",
    "effective_snapshot_sources",
    "source_snapshot_overlays",
    "markdown_sections",
    "source_facts",
    "source_blobs",
    "source_backfill_checkpoints",
    ...(scope.allTargetRepositoriesSelected ? [] : ["nodes"]),
    "git_commits",
    ...(scope.allTargetRepositoriesSelected ? ["edges"] : []),
  ];
  const tables = [...new Set([...order, ...REBUILDABLE_ASSET_TABLES])];
  const deleted: Record<string, number> = {};
  const droppedRebuildableTables: string[] = [];
  const recreatedMixedTables: string[] = [];
  const tx = db.transaction(() => {
    const startedAt = Date.now();
    // `nodes` and `edges` mix durable user/ledger assets with parser output.
    // For the full-corpus lane, drop their B-trees once and restore the
    // signed durable subset from the sidecar instead of scanning/deleting
    // millions of parser rows one by one.
    if (scope.allRepositoriesSelected) {
      for (const table of ["edges", "nodes"] as const) {
        testHooks?.beforeDelete?.({ table });
        const tableWasPresent = tableExists(db, table);
        db.prepare(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`).run();
        recreatedMixedTables.push(table);
        deleted[table] = 0;
        // Test hooks need a positive structural-change signal so crash
        // injection still exercises the same rollback boundary without a
        // full COUNT(*) scan of the dropped table.
        testHooks?.afterDelete?.({ table, changes: tableWasPresent ? 1 : 0 });
        if (failAt === "during_reset") throw new Error("RESET_INJECTED_FAILURE_DURING_RESET");
      }
    }
    for (const table of tables) {
      if (scope.allRepositoriesSelected && (table === "edges" || table === "nodes")) continue;
      trace(`table-start ${table}`);
      testHooks?.beforeDelete?.({ table });
      // A full-corpus reset can structurally clear pure rebuildable tables.
      // Dropping their B-trees/FTS indexes is materially faster than deleting
      // millions of rows one by one; mixed nodes/edges are still handled by
      // their protected predicates below.
      if (
        scope.allRepositoriesSelected &&
        REBUILDABLE_ASSET_TABLE_SET.has(table)
      ) {
        db.prepare(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`).run();
        droppedRebuildableTables.push(table);
        deleted[table] = 0;
        testHooks?.afterDelete?.({ table, changes: 0 });
        trace(`table-dropped ${table}`);
        if (failAt === "during_reset") throw new Error("RESET_INJECTED_FAILURE_DURING_RESET");
        continue;
      }
      const predicate = resetPredicate(db, table, scope);
      if (!predicate) {
        deleted[table] = 0;
        testHooks?.afterDelete?.({ table, changes: 0 });
        continue;
      }
      const changes = db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${predicate.sql}`).run(...predicate.args).changes;
      deleted[table] = changes;
      testHooks?.afterDelete?.({ table, changes });
      trace(`table-end ${table} changes=${changes}`);
      if (failAt === "during_reset" && changes > 0) throw new Error("RESET_INJECTED_FAILURE_DURING_RESET");
    }
    if (droppedRebuildableTables.length > 0 || recreatedMixedTables.length > 0) {
      recreateCurrentSchemaObjects(db);
      restoreStructuralMixedAssets({ db }, protectedAssets);
      // DROP TABLE does not fire row-level delete triggers. Advance the
      // endpoint inventory generation explicitly so endpoint cursors see a
      // new publication revision after a structural reset.
      db.prepare(`
        UPDATE meta
           SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         WHERE key = 'endpoint_inventory_generation'
      `).run();
    }
    trace(`delete-and-recreate elapsedMs=${Date.now() - startedAt} dropped=${droppedRebuildableTables.length} mixed=${recreatedMixedTables.join(",")}`);
    const branchChanges = scope.repoIds.length === 0 ? 0 : db.prepare(`
      UPDATE branches
         SET last_indexed_commit=NULL,
             last_indexed_at=NULL,
             indexed_worktree_state='unknown',
             indexed_worktree_fingerprint=NULL,
             indexed_dirty_files='[]',
             parser_version=NULL,
             resolver_version=NULL,
             indexed_schema_version=NULL,
             stale_reason='full_reset_pending_reindex',
             current_snapshot_id=NULL
       WHERE repo_id IN (SELECT value FROM json_each(?))
    `).run(jsonSet(scope.repoIds)).changes;
    deleted.branches_derived_state = branchChanges;
  });
  tx.immediate();
  return { deleted, droppedRebuildableTables, recreatedMixedTables };
}

function protectedHashes(bundle: ProtectedAssetBundle): Record<string, string> {
  return Object.fromEntries([
    ["protected:bundle", bundle.bundleHash],
    ...Object.values(bundle.tables).map((table) => [`protected:${table.key}`, table.rowHash]),
  ]);
}

const INTENTIONAL_RESET_META_KEYS = new Set(["endpoint_inventory_generation", "index_lock::global"]);
const INTENTIONAL_RESET_BRANCH_COLUMNS = new Set([
  "last_indexed_commit",
  "last_indexed_at",
  "indexed_worktree_state",
  "indexed_worktree_fingerprint",
  "indexed_dirty_files",
  "parser_version",
  "resolver_version",
  "indexed_schema_version",
  "stale_reason",
  "current_snapshot_id",
]);

function projectedRows(table: ProtectedAssetBundle["tables"][string], ignored: ReadonlySet<string>): string[] {
  const indexes = table.columns.flatMap((column, index) => ignored.has(column) ? [] : [index]);
  return table.rows.map((row) => canonicalJson(indexes.map((index) => row[index]))).sort();
}

function branchIntentionalChanges(
  expected: ProtectedAssetBundle["tables"][string],
  actual: ProtectedAssetBundle["tables"][string],
): string[] {
  const expectedId = expected.columns.indexOf("id");
  const actualId = actual.columns.indexOf("id");
  if (expectedId < 0 || actualId < 0) return [];
  const expectedRows = new Map(expected.rows.map((row) => [String(row[expectedId]), row]));
  const actualRows = new Map(actual.rows.map((row) => [String(row[actualId]), row]));
  const changes: string[] = [];
  for (const column of INTENTIONAL_RESET_BRANCH_COLUMNS) {
    const expectedIndex = expected.columns.indexOf(column);
    const actualIndex = actual.columns.indexOf(column);
    if (expectedIndex < 0 || actualIndex < 0) continue;
    const changed = [...new Set([...expectedRows.keys(), ...actualRows.keys()])].some((id) => (
      canonicalJson(expectedRows.get(id)?.[expectedIndex]) !== canonicalJson(actualRows.get(id)?.[actualIndex])
    ));
    if (changed) changes.push(`branches.${column}`);
  }
  return changes;
}

function protectedAssetVerification(
  expected: ProtectedAssetBundle,
  actual: ProtectedAssetBundle,
): { gaps: string[]; intentionalChanges: string[] } {
  const gaps: string[] = [];
  const intentionalChanges: string[] = [];
  const tableKeys = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const key of [...tableKeys].sort()) {
    const expectedTable = expected.tables[key];
    const actualTable = actual.tables[key];
    if (!expectedTable || !actualTable) {
      gaps.push(`PROTECTED_ASSET_CHANGED:protected:${key}`);
      continue;
    }
    if (key === "branches") {
      if (canonicalJson(projectedRows(expectedTable, INTENTIONAL_RESET_BRANCH_COLUMNS)) !== canonicalJson(projectedRows(actualTable, INTENTIONAL_RESET_BRANCH_COLUMNS))) {
        gaps.push("PROTECTED_ASSET_CHANGED:protected:branches");
      } else {
        intentionalChanges.push(...branchIntentionalChanges(expectedTable, actualTable));
      }
      continue;
    }
    if (key !== "meta") {
      if (expectedTable.rowHash !== actualTable.rowHash) gaps.push(`PROTECTED_ASSET_CHANGED:protected:${key}`);
      continue;
    }
    const expectedKeyIndex = expectedTable.columns.indexOf("key");
    const expectedValueIndex = expectedTable.columns.indexOf("value");
    const actualKeyIndex = actualTable.columns.indexOf("key");
    const actualValueIndex = actualTable.columns.indexOf("value");
    if ([expectedKeyIndex, expectedValueIndex, actualKeyIndex, actualValueIndex].some((index) => index < 0)) {
      gaps.push("PROTECTED_ASSET_CHANGED:protected:meta");
      continue;
    }
    const expectedValues = new Map(expectedTable.rows.map((row) => [String(row[expectedKeyIndex]), row[expectedValueIndex]]));
    const actualValues = new Map(actualTable.rows.map((row) => [String(row[actualKeyIndex]), row[actualValueIndex]]));
    const keys = new Set([...expectedValues.keys(), ...actualValues.keys()]);
    for (const metaKey of [...keys].sort()) {
      if (canonicalJson(expectedValues.get(metaKey)) === canonicalJson(actualValues.get(metaKey))) continue;
      if (INTENTIONAL_RESET_META_KEYS.has(metaKey)) intentionalChanges.push(`meta.${metaKey}`);
      else gaps.push(`PROTECTED_ASSET_CHANGED:protected:meta:${metaKey}`);
    }
  }
  return { gaps, intentionalChanges };
}

function targetRepositories(db: Database.Database, rootPath: string): ResetTargetRepository[] {
  const rows = db.prepare("SELECT id,name,root_path AS rootPath,remote_url AS remoteUrl FROM repos ORDER BY id").all() as Array<{ id: string; name: string; rootPath: string; remoteUrl: string | null }>;
  const selected: ResetTargetRepository[] = [];
  const seenRoots = new Set<string>();
  for (const repo of rows) {
    const canonicalRoot = canonicalPath(repo.rootPath);
    if (!within(rootPath, canonicalRoot)) continue;
    if (seenRoots.has(canonicalRoot)) throw new Error(`RESET_DUPLICATE_REPOSITORY_ROOT:${canonicalRoot}`);
    seenRoots.add(canonicalRoot);
    selected.push({
      repoId: repo.id,
      name: repo.name,
      rootPath: canonicalRoot,
      remoteUrl: repo.remoteUrl,
      branches: (db.prepare("SELECT id,name,head_commit AS headCommit FROM branches WHERE repo_id=? ORDER BY name,id").all(repo.id) as Array<{ id: string; name: string; headCommit: string | null }>),
    });
  }
  if (selected.length === 0) throw new Error(`RESET_NO_TARGET_REPOSITORIES:${rootPath}`);
  return selected;
}

function scalarCount(db: Database.Database, sql: string, ...args: unknown[]): number {
  return Number((db.prepare(sql).get(...args) as { n?: number } | undefined)?.n ?? 0);
}

/** Decision-useful per-repository counts must not materialize the complete
 * corpus ID graph in JavaScript. These indexed/direct SQL counts describe the
 * major rebuildable families; executeFullReset still computes the exact
 * shared-row scope once and publishes per-table deleted/remaining receipts. */
function countRepositoryPlanRows(db: Database.Database, repoId: string): Record<string, number> {
  return {
    branches: scalarCount(db, "SELECT COUNT(*) AS n FROM branches WHERE repo_id=?", repoId),
    revision_snapshots: scalarCount(db, "SELECT COUNT(*) AS n FROM revision_snapshots WHERE repo_id=?", repoId),
    files_index: scalarCount(db, "SELECT COUNT(*) AS n FROM files_index WHERE repo_id=?", repoId),
    file_facts: scalarCount(db, "SELECT COUNT(*) AS n FROM file_facts WHERE repo_id=?", repoId),
    source_facts: scalarCount(db, "SELECT COUNT(*) AS n FROM source_facts WHERE repo_id=?", repoId),
    source_blobs_referenced: scalarCount(db, "SELECT COUNT(DISTINCT source_blob_id) AS n FROM source_facts WHERE repo_id=? AND source_blob_id IS NOT NULL", repoId),
    symbol_versions: scalarCount(db, `
      SELECT COUNT(*) AS n FROM symbol_versions sv
       JOIN branches b ON b.id=sv.branch_id
      WHERE b.repo_id=?
    `, repoId),
    nodes: scalarCount(db, "SELECT COUNT(*) AS n FROM nodes WHERE repo_id=?", repoId),
    parser_edges: scalarCount(db, `
      SELECT COUNT(*) AS n FROM edges e
       WHERE e.origin='parser'
         AND (
           e.branch_id IN (SELECT id FROM branches WHERE repo_id=?)
           OR (e.branch_id IS NULL AND json_extract(e.provenance,'$.repo')=?)
         )
    `, repoId, repoId),
    endpoint_memberships: scalarCount(db, "SELECT COUNT(*) AS n FROM endpoint_memberships WHERE repo_id=?", repoId),
    coverage_records: scalarCount(db, "SELECT COUNT(*) AS n FROM coverage_records WHERE repo_id=?", repoId),
  };
}

function baselineDigest(baseline: CorpusBaseline, assets: ProtectedAssetBundle): string {
  return sha256Hex(canonicalJson({
    rootPath: baseline.rootPath,
    databaseInstanceId: baseline.databaseInstanceId,
    databaseDataVersion: baseline.databaseDataVersion,
    counts: baseline.counts,
    immutableAssetHashes: baseline.immutableAssetHashes,
    protectedBundleHash: assets.bundleHash,
    sourceGroundTruthHash: baseline.sourceGroundTruthHash,
  }));
}

function verifyBackup(
  handle: KnowledgeDatabaseHandle,
  backupPath: string,
  options: { integrityCheck?: boolean } = {},
): { bytes: number; databaseInstanceId: string } {
  if (!existsSync(backupPath)) throw new Error(`RESET_BACKUP_MISSING:${backupPath}`);
  const Constructor = handle.db.constructor as unknown as new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => Database.Database;
  const backup = new Constructor(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (options.integrityCheck !== false) {
      const integrity = backup.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") throw new Error(`RESET_BACKUP_INTEGRITY_FAILED:${integrity}`);
    }
    const row = backup.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get() as { value?: string } | undefined;
    if (!row?.value) throw new Error("RESET_BACKUP_INSTANCE_ID_MISSING");
    return { bytes: statSync(backupPath).size, databaseInstanceId: row.value };
  } finally {
    backup.close();
  }
}

/** Create one immutable backup plus baseline/protected-asset sidecars. Existing
 * backups are never reused: an instance ID does not prove that an older backup
 * represents the current contents of that same database instance. */
export async function createFullResetPlan(
  handle: KnowledgeDatabaseHandle,
  options: FullResetPlanOptions,
): Promise<FullResetPlanningResult> {
  const rootPath = canonicalPath(options.rootPath);
  const databasePath = resolve(options.databasePath);
  const backupPath = resolve(options.backupPath);
  if (existsSync(backupPath)) throw new Error(`RESET_BACKUP_PATH_EXISTS:${backupPath}`);
  const initialInstanceId = databaseInstanceId(handle, { ensure: true });
  const operationId = `reset_${Date.now()}_${createHash("sha256").update(`${rootPath}:${initialInstanceId}`).digest("hex").slice(0, 12)}`;
  const planningMarker = acquireResetWriterMarker(handle.db, operationId);
  let planningLock: ReturnType<typeof acquirePlanningDatabaseLock> | undefined;
  try {
    // The marker coordinates Penguin writers, but audit/heartbeat clients may
    // still write through a direct SQLite connection. Hold a real RESERVED
    // lock on a separate connection for the whole backup + baseline window so
    // data_version cannot drift between the copied image and the manifest's
    // baseline. The backup source connection must remain outside this write
    // transaction because SQLite's online backup API cannot copy from its own
    // active write transaction.
    planningLock = acquirePlanningDatabaseLock(handle, databasePath);
    const currentInstanceId = databaseInstanceId(handle, { ensure: false });
    if (currentInstanceId !== initialInstanceId) throw new Error("RESET_DATABASE_INSTANCE_CHANGED");
    const selected = targetRepositories(handle.db, rootPath);
    const backup = await createConsistentDatabaseBackup(handle, backupPath, {
      minimumFreeBytesAfterBackup: options.minimumFreeBytesAfterBackup ?? 10 * 1024 * 1024 * 1024,
    });
    if (verifyBackup(handle, backupPath).databaseInstanceId !== currentInstanceId) throw new Error("RESET_BACKUP_DATABASE_INSTANCE_MISMATCH");
    const protectedAssets = captureProtectedAssets(handle, { ensureDatabaseInstanceId: false });
    const baseline = options.baseline ?? captureCorpusBaseline(handle, {
      rootPath,
      databasePath,
      protectedAssets,
      ensureDatabaseInstanceId: false,
    });
    if (baseline.rootPath !== rootPath) throw new Error("RESET_BASELINE_ROOT_MISMATCH");
    if (baseline.databaseInstanceId !== currentInstanceId) throw new Error("RESET_BASELINE_DATABASE_INSTANCE_MISMATCH");
    if (baseline.databaseDataVersion !== backup.sourceDataVersion) throw new Error("RESET_BASELINE_BACKUP_VERSION_MISMATCH");
    if (!baseline.sourceGroundTruthComplete) throw new Error(`RESET_SOURCE_GROUND_TRUTH_INCOMPLETE:${baseline.sourceGroundTruthGaps.join(",")}`);
    const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 30 * 60_000)).toISOString();
    const repositories = selected.map((repo) => {
      return {
        repoId: repo.repoId,
        canonicalRoot: repo.rootPath,
        branchIds: repo.branches.map((branch) => branch.id).sort(),
        currentHeads: Object.fromEntries(repo.branches.map((branch) => [branch.id, branch.headCommit] as const).sort(([a], [b]) => a.localeCompare(b))),
        rowCounts: countRepositoryPlanRows(handle.db, repo.repoId),
      };
    });
    const manifestPath = resolve(options.manifestPath ?? fullResetManifestPath(databasePath, operationId));
    const baselinePath = `${manifestPath}.baseline.json`;
    const protectedAssetPath = `${manifestPath}.protected-assets.json`;
    const planWithoutDigest: FullResetPlan = {
      formatVersion: 1,
      operationId,
      rootPath,
      databasePath,
      databaseInstanceId: currentInstanceId,
      repositories,
      protectedAssetCounts: Object.fromEntries(Object.values(protectedAssets.tables).map((table) => [table.key, table.rowCount])),
      protectedAssetHashes: protectedHashes(protectedAssets),
      backupPath,
      baselinePath,
      protectedAssetPath,
      baselineDigest: baselineDigest(baseline, protectedAssets),
      sourceGroundTruthHash: baseline.sourceGroundTruthHash,
      risk: "full_corpus_reset",
      mode: "full_corpus_reset",
      confirmationToken: createFullResetConfirmationToken(),
      planDigest: "",
      manifestPath,
      expiresAt,
    };
    const plan = { ...planWithoutDigest, planDigest: fullResetPlanDigest(planWithoutDigest) };
    writeCorpusBaseline(baseline, baselinePath);
    writeProtectedAssetBundle(protectedAssets, protectedAssetPath);
    writeResetManifest(plan);
    appendResetManifestPhase(manifestPath, "backed_up", { backupPath, backupBytes: backup.bytes, databaseInstanceId: currentInstanceId });
    planningLock.commit();
    return { plan, baseline, protectedAssets, backup };
  } finally {
    try {
      planningLock?.close();
    } finally {
      planningMarker.release();
    }
  }
}

/**
 * Reissue a single-use reset after a crash that happened before the delete
 * transaction. The old token remains consumed forever. Reuse is allowed only
 * when the database instance and data_version are unchanged, avoiding a second
 * multi-gigabyte backup while preserving the single-use-token invariant.
 */
export function reissueFullResetPlan(
  handle: KnowledgeDatabaseHandle,
  options: FullResetReissueOptions,
): FullResetReissueResult {
  if (!options.confirmed) throw new Error("RESET_REISSUE_CONFIRMATION_REQUIRED");
  const sourceManifestPath = resolve(options.sourceManifestPath);
  const manifestPath = resolve(options.manifestPath);
  if (sourceManifestPath === manifestPath) throw new Error("RESET_REISSUE_MANIFEST_PATH_MUST_DIFFER");
  const source = readResetManifest(sourceManifestPath);
  if (!source.tokenConsumed) throw new Error("RESET_REISSUE_PLAN_NOT_CONSUMED");
  if (source.phase !== "failed" && source.phase !== "fenced") {
    throw new Error(`RESET_REISSUE_PHASE_INVALID:${source.phase}`);
  }
  if (source.plan.manifestPath !== sourceManifestPath) throw new Error("RESET_REISSUE_MANIFEST_PATH_MISMATCH");
  if (source.phaseRecords.some((record) =>
    record.phase === "reset" ||
    (record.details?.deletedRebuildableRows != null && typeof record.details.deletedRebuildableRows === "object"),
  )) throw new Error("RESET_REISSUE_DELETE_MAY_HAVE_COMMITTED");
  if (existsSync(manifestPath)) throw new Error(`RESET_REISSUE_MANIFEST_EXISTS:${manifestPath}`);

  const plan = source.plan;
  const currentId = databaseInstanceId(handle, { ensure: false });
  if (currentId !== plan.databaseInstanceId) throw new Error("RESET_REISSUE_DATABASE_INSTANCE_CHANGED");
  const baseline = JSON.parse(readFileSync(plan.baselinePath, "utf8")) as CorpusBaseline;
  if (baseline.databaseInstanceId !== currentId) throw new Error("RESET_REISSUE_BASELINE_INSTANCE_MISMATCH");
  const currentDataVersion = Number(handle.db.pragma("data_version", { simple: true }));
  if (currentDataVersion !== baseline.databaseDataVersion) throw new Error("RESET_REISSUE_DATABASE_CHANGED");
  const protectedAssets = readProtectedAssetBundle(plan.protectedAssetPath);
  if (baselineDigest(baseline, protectedAssets) !== plan.baselineDigest) throw new Error("RESET_REISSUE_BASELINE_DIGEST_MISMATCH");
  const backup = verifyBackup(handle, plan.backupPath, { integrityCheck: false });
  if (backup.databaseInstanceId !== currentId) throw new Error("RESET_REISSUE_BACKUP_INSTANCE_MISMATCH");

  const operationId = `reset_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 24 * 60 * 60 * 1000)).toISOString();
  const planWithoutDigest = {
    ...plan,
    operationId,
    confirmationToken: createFullResetConfirmationToken(),
    manifestPath,
    expiresAt,
  };
  const reissuedPlan = { ...planWithoutDigest, planDigest: fullResetPlanDigest(planWithoutDigest) };
  writeResetManifest(reissuedPlan);
  appendResetManifestPhase(manifestPath, "backed_up", {
    backupPath: backup,
    reusedFromOperationId: plan.operationId,
    databaseInstanceId: currentId,
    databaseDataVersion: currentDataVersion,
  });
  return {
    plan: reissuedPlan,
    reusedBackupPath: plan.backupPath,
    reusedBackupBytes: backup.bytes,
    reissuedFromOperationId: plan.operationId,
  };
}

function acquireWriterFence(databasePath: string, operationId: string): { path: string; release: () => void } {
  const path = `${databasePath}.full-reset.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new Error(`RESET_WRITER_FENCE_BUSY:${path}`);
    throw error;
  }
  const body = Buffer.from(JSON.stringify({ formatVersion: 1, operationId, pid: process.pid, createdAt: new Date().toISOString() }) + "\n", "utf8");
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return {
    path,
    release: () => {
      try {
        const current = readFileSync(path, "utf8");
        if (current.includes(`"operationId":"${operationId}"`)) unlinkSync(path);
      } catch {
        // A crash/reaper may already have handled the fence. Never delete an
        // unrelated replacement lock.
      }
    },
  };
}

/** Share the same atomic database-wide owner marker used by index/rebuild and
 * observed by semantic workers. The filesystem fence remains the durable
 * crash/recovery record; this marker is the live mutual-exclusion primitive. */
function acquireResetWriterMarker(
  db: Database.Database,
  operationId: string,
): { release: () => void } {
  const key = "index_lock::global";
  const value = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    kind: "full_corpus_reset",
    operationId,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key, value);
    if (inserted.changes === 1) {
      return {
        release: () => {
          db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(key, value);
        },
      };
    }
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) continue;
    let owner: { pid?: number; startedAt?: string; kind?: string; operationId?: string };
    try { owner = JSON.parse(row.value) as typeof owner; }
    catch { throw new Error("RESET_INDEX_WRITER_STATE_UNKNOWN"); }
    if (typeof owner.pid === "number" && processIsAlive(owner.pid)) {
      throw Object.assign(new Error(`RESET_INDEX_WRITER_BUSY:pid=${owner.pid}:started=${owner.startedAt ?? "unknown"}`), {
        code: "RESET_INDEX_WRITER_BUSY",
        retryable: true,
        details: owner,
      });
    }
    const replaced = db.prepare("UPDATE meta SET value=? WHERE key=? AND value=?").run(value, key, row.value);
    if (replaced.changes === 1) {
      return {
        release: () => {
          db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(key, value);
        },
      };
    }
  }
  throw new Error("RESET_INDEX_WRITER_CHANGED_CONCURRENTLY");
}

function acquirePlanningDatabaseLock(
  handle: KnowledgeDatabaseHandle,
  databasePath: string,
): { commit: () => void; close: () => void } {
  const Constructor = handle.db.constructor as unknown as new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => Database.Database;
  const lockDb = new Constructor(databasePath, { fileMustExist: true });
  try {
    lockDb.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lockDb.close();
    throw error;
  }
  let active = true;
  return {
    commit: () => {
      if (!active) return;
      lockDb.exec("COMMIT");
      active = false;
    },
    close: () => {
      try {
        if (active) lockDb.exec("ROLLBACK");
      } finally {
        active = false;
        lockDb.close();
      }
    },
  };
}

function currentResetDatabaseInstanceId(db: Database.Database, fallback: string): string {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get() as { value?: string } | undefined;
    return row?.value || fallback;
  } catch {
    return fallback;
  }
}

function failedReceipt(plan: FullResetPlan, databasePath: string, gaps: string[], currentInstanceId = plan.databaseInstanceId): FullResetReceipt {
  return {
    operationId: plan.operationId,
    phase: "failed",
    previousDatabaseInstanceId: plan.databaseInstanceId,
    databaseInstanceId: currentInstanceId,
    intentionalProtectedAssetChanges: currentInstanceId === plan.databaseInstanceId ? [] : ["meta.database_instance_id"],
    deletedRebuildableRows: {},
    droppedRebuildableTables: [],
    recreatedMixedTables: [],
    remainingTargetIndexRows: {},
    protectedAssetHashes: plan.protectedAssetHashes,
    sourceRepositoriesUntouched: true,
    rollbackAvailable: existsSync(plan.backupPath),
    gaps,
  };
}

function appendFailure(manifestPath: string, error: unknown): void {
  try { appendResetManifestPhase(manifestPath, "failed", { error: String((error as Error)?.message ?? error) }); } catch { /* preserve original failure */ }
}

export function executeFullReset(
  handle: KnowledgeDatabaseHandle,
  plan: FullResetPlan,
  options: FullResetExecutionOptions,
): FullResetReceipt {
  const manifestPath = resolve(options.manifestPath ?? plan.manifestPath);
  let manifest: ResetManifest;
  try {
    manifest = readResetManifest(manifestPath);
    if (manifest.plan.planDigest !== plan.planDigest || manifest.plan.operationId !== plan.operationId) throw new Error("RESET_PLAN_MANIFEST_MISMATCH");
    if (manifest.tokenConsumed) throw new Error("RESET_PLAN_ALREADY_CONSUMED");
    if (resolve(options.databasePath) !== plan.databasePath) throw new Error("RESET_DATABASE_PATH_MISMATCH");
    const writerMarker = acquireResetWriterMarker(handle.db, plan.operationId);
    let writerMarkerReleased = false;
    let fence: ReturnType<typeof acquireWriterFence> | undefined;
    try {
      fence = acquireWriterFence(options.databasePath, plan.operationId);
      const currentId = databaseInstanceId(handle, { ensure: false });
      if (currentId !== plan.databaseInstanceId) throw new Error("RESET_DATABASE_INSTANCE_CHANGED");
      // The immutable backup was fully integrity-checked while planning. The
      // execute path must not scan the same multi-gigabyte image again; the
      // writer fence, instance identity, WAL checkpoint, and post-delete
      // protected-asset verification provide the execute-time guards.
      const backup = verifyBackup(handle, plan.backupPath, { integrityCheck: false });
      if (backup.databaseInstanceId !== currentId) throw new Error("RESET_BACKUP_DATABASE_INSTANCE_MISMATCH");
      const checkpoint = handle.db.pragma("wal_checkpoint(PASSIVE)") as Array<{ busy?: number }>;
      if (Number(checkpoint?.[0]?.busy ?? 0) > 0) throw new Error("RESET_WAL_BUSY");
      consumeResetPlan(manifestPath, options.token);
      appendResetManifestPhase(manifestPath, "fenced", { fencePath: fence.path, databaseInstanceId: currentId, writerMarker: "index_lock::global" });
      if (options.failAt === "after_fence") throw new Error("RESET_INJECTED_FAILURE_AFTER_FENCE");
      options.testHooks?.afterFence?.({ operationId: plan.operationId, databasePath: options.databasePath });
      const repoIds = plan.repositories.map((repo) => repo.repoId);
      const protectedAssets = readProtectedAssetBundle(plan.protectedAssetPath);
      const scope = buildResetScope(handle.db, repoIds, protectedNodeIdsFromAssets(protectedAssets), { allTargetRepositoriesSelected: true });
      const deleteStartedAt = Date.now();
      const deletion = deleteTargetRows(handle.db, scope, protectedAssets, options.failAt, options.testHooks);
      if (process.env.PENGUIN_RESET_TRACE === "1") console.error(`[reset-trace] deleteTargetRows elapsedMs=${Date.now() - deleteStartedAt}`);
      const deleted = deletion.deleted;
      options.testHooks?.afterReset?.({ operationId: plan.operationId, deleted });
      if (options.failAt === "after_reset") throw new Error("RESET_INJECTED_FAILURE_AFTER_RESET");
      const remaining = scope.allRepositoriesSelected || scope.allTargetRepositoriesSelected
        ? remainingTargetRowsAfterDelete(scope)
        : countTargetRows(handle.db, scope);
      // Keep the durable filesystem fence through verification, but remove the
      // transient meta marker before hashing protected meta rows.
      writerMarker.release();
      writerMarkerReleased = true;
      const afterAssetsStartedAt = Date.now();
      const afterAssets = captureProtectedAssets(handle, {
        ensureDatabaseInstanceId: false,
        protectedNodeIds: protectedNodeIdsFromAssets(protectedAssets),
      });
      if (process.env.PENGUIN_RESET_TRACE === "1") console.error(`[reset-trace] afterAssets elapsedMs=${Date.now() - afterAssetsStartedAt}`);
      const afterBaselineStartedAt = Date.now();
      const afterBaseline = captureCorpusBaseline(handle, {
        rootPath: plan.rootPath,
        databasePath: options.databasePath,
        protectedAssets: afterAssets,
        ensureDatabaseInstanceId: false,
        includeDatabaseMetrics: false,
      });
      if (process.env.PENGUIN_RESET_TRACE === "1") console.error(`[reset-trace] afterBaseline elapsedMs=${Date.now() - afterBaselineStartedAt}`);
      const gaps: string[] = [];
      for (const [table, count] of Object.entries(remaining)) if (count !== 0) gaps.push(`REMAINING_TARGET_ROWS:${table}:${count}`);
      const afterHashes = protectedHashes(afterAssets);
      const protectedVerification = protectedAssetVerification(protectedAssets, afterAssets);
      gaps.push(...protectedVerification.gaps);
      if (afterBaseline.sourceGroundTruthHash !== plan.sourceGroundTruthHash) gaps.push("SOURCE_REPOSITORY_CHANGED");
      if (!afterBaseline.sourceGroundTruthComplete) gaps.push(...afterBaseline.sourceGroundTruthGaps.map((gap) => `SOURCE_GROUND_TRUTH_INCOMPLETE:${gap}`));
      const sourceUntouched = gaps.every((gap) => !gap.startsWith("SOURCE_REPOSITORY_CHANGED") && !gap.startsWith("SOURCE_GROUND_TRUTH_INCOMPLETE"));
      let nextDatabaseInstanceId = plan.databaseInstanceId;
      if (gaps.length === 0) {
        const candidate = `db_${randomUUID()}`;
        const rotated = handle.db.prepare(
          "UPDATE meta SET value=? WHERE key='database_instance_id' AND value=?",
        ).run(candidate, plan.databaseInstanceId);
        if (rotated.changes !== 1) gaps.push("DATABASE_INSTANCE_ROTATION_FAILED");
        else nextDatabaseInstanceId = candidate;
      }
      const receipt: FullResetReceipt = {
        operationId: plan.operationId,
        phase: gaps.length === 0 ? "reset" : "failed",
        previousDatabaseInstanceId: plan.databaseInstanceId,
        databaseInstanceId: nextDatabaseInstanceId,
        intentionalProtectedAssetChanges: [
          ...protectedVerification.intentionalChanges,
          ...(nextDatabaseInstanceId === plan.databaseInstanceId ? [] : ["meta.database_instance_id"]),
        ],
        deletedRebuildableRows: deleted,
        droppedRebuildableTables: deletion.droppedRebuildableTables,
        recreatedMixedTables: deletion.recreatedMixedTables,
        remainingTargetIndexRows: remaining,
        protectedAssetHashes: afterHashes,
        sourceRepositoriesUntouched: sourceUntouched,
        rollbackAvailable: existsSync(plan.backupPath),
        gaps,
      };
      appendResetManifestPhase(manifestPath, receipt.phase, {
        deletedRebuildableRows: deleted,
        droppedRebuildableTables: deletion.droppedRebuildableTables,
        recreatedMixedTables: deletion.recreatedMixedTables,
        remainingTargetIndexRows: remaining,
        gaps,
      });
      if (receipt.phase === "failed") return receipt;
      return receipt;
    } catch (error) {
      appendFailure(manifestPath, error);
      return failedReceipt(plan, options.databasePath, [String((error as Error)?.message ?? error)], currentResetDatabaseInstanceId(handle.db, plan.databaseInstanceId));
    } finally {
      if (!writerMarkerReleased) writerMarker.release();
      fence?.release();
    }
  } catch (error) {
    appendFailure(manifestPath, error);
    return failedReceipt(plan, options.databasePath, [String((error as Error)?.message ?? error)], currentResetDatabaseInstanceId(handle.db, plan.databaseInstanceId));
  }
}

/** Finalize a consumed operation whose delete transaction committed but whose
 * post-delete verification failed or was interrupted. This never deletes a
 * row: it reacquires both writer guards, independently reruns every reset
 * invariant, and rotates the database identity only when they all pass. */
export function finalizeFullReset(
  handle: KnowledgeDatabaseHandle,
  plan: FullResetPlan,
  options: FullResetFinalizeOptions,
): FullResetReceipt {
  if (!options.confirmed) throw new Error("RESET_FINALIZE_CONFIRMATION_REQUIRED");
  const manifestPath = resolve(options.manifestPath);
  const manifest = readResetManifest(manifestPath);
  if (manifest.plan.planDigest !== plan.planDigest || manifest.plan.operationId !== plan.operationId) {
    throw new Error("RESET_PLAN_MANIFEST_MISMATCH");
  }
  if (!manifest.tokenConsumed) throw new Error("RESET_FINALIZE_PLAN_NOT_CONSUMED");
  if (manifest.phase !== "failed") throw new Error(`RESET_FINALIZE_PHASE_INVALID:${manifest.phase}`);
  if (resolve(options.databasePath) !== plan.databasePath) throw new Error("RESET_DATABASE_PATH_MISMATCH");
  const currentId = databaseInstanceId(handle, { ensure: false });
  if (currentId !== plan.databaseInstanceId) throw new Error("RESET_DATABASE_INSTANCE_CHANGED");

  const writerMarker = acquireResetWriterMarker(handle.db, plan.operationId);
  let writerMarkerReleased = false;
  let fence: ReturnType<typeof acquireWriterFence> | undefined;
  try {
    fence = acquireWriterFence(options.databasePath, plan.operationId);
    verifyBackup(handle, plan.backupPath);
    const checkpoint = handle.db.pragma("wal_checkpoint(PASSIVE)") as Array<{ busy?: number }>;
    if (Number(checkpoint?.[0]?.busy ?? 0) > 0) throw new Error("RESET_WAL_BUSY");
    const integrity = handle.db.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") throw new Error(`RESET_DATABASE_INTEGRITY_FAILED:${integrity}`);

    const protectedAssets = readProtectedAssetBundle(plan.protectedAssetPath);
    const scope = buildResetScope(handle.db, plan.repositories.map((repo) => repo.repoId), protectedNodeIdsFromAssets(protectedAssets), { allTargetRepositoriesSelected: true });
    const remaining = countTargetRows(handle.db, scope);
    writerMarker.release();
    writerMarkerReleased = true;
    const afterAssets = captureProtectedAssets(handle, { ensureDatabaseInstanceId: false });
    const afterBaseline = captureCorpusBaseline(handle, {
      rootPath: plan.rootPath,
      databasePath: options.databasePath,
      protectedAssets: afterAssets,
      ensureDatabaseInstanceId: false,
    });
    const gaps: string[] = [];
    for (const [table, count] of Object.entries(remaining)) {
      if (count !== 0) gaps.push(`REMAINING_TARGET_ROWS:${table}:${count}`);
    }
    const protectedVerification = protectedAssetVerification(protectedAssets, afterAssets);
    gaps.push(...protectedVerification.gaps);
    if (afterBaseline.sourceGroundTruthHash !== plan.sourceGroundTruthHash) gaps.push("SOURCE_REPOSITORY_CHANGED");
    if (!afterBaseline.sourceGroundTruthComplete) {
      gaps.push(...afterBaseline.sourceGroundTruthGaps.map((gap) => `SOURCE_GROUND_TRUTH_INCOMPLETE:${gap}`));
    }
    const sourceUntouched = gaps.every((gap) => !gap.startsWith("SOURCE_REPOSITORY_CHANGED") && !gap.startsWith("SOURCE_GROUND_TRUTH_INCOMPLETE"));
    let nextDatabaseInstanceId = plan.databaseInstanceId;
    if (gaps.length === 0) {
      const candidate = `db_${randomUUID()}`;
      const rotated = handle.db.prepare(
        "UPDATE meta SET value=? WHERE key='database_instance_id' AND value=?",
      ).run(candidate, plan.databaseInstanceId);
      if (rotated.changes !== 1) gaps.push("DATABASE_INSTANCE_ROTATION_FAILED");
      else nextDatabaseInstanceId = candidate;
    }
    const previousDelete = [...manifest.phaseRecords].reverse().find((record) => {
      const value = record.details?.deletedRebuildableRows;
      return value != null && typeof value === "object" && !Array.isArray(value);
    })?.details?.deletedRebuildableRows as Record<string, number> | undefined;
    const receipt: FullResetReceipt = {
      operationId: plan.operationId,
      phase: gaps.length === 0 ? "reset" : "failed",
      previousDatabaseInstanceId: plan.databaseInstanceId,
      databaseInstanceId: nextDatabaseInstanceId,
      intentionalProtectedAssetChanges: [
        ...protectedVerification.intentionalChanges,
        ...(nextDatabaseInstanceId === plan.databaseInstanceId ? [] : ["meta.database_instance_id"]),
      ],
      deletedRebuildableRows: previousDelete ?? {},
      droppedRebuildableTables: [],
      recreatedMixedTables: [],
      remainingTargetIndexRows: remaining,
      protectedAssetHashes: protectedHashes(afterAssets),
      sourceRepositoriesUntouched: sourceUntouched,
      rollbackAvailable: existsSync(plan.backupPath),
      gaps,
    };
    appendResetManifestPhase(manifestPath, receipt.phase, {
      finalized: true,
      remainingTargetIndexRows: remaining,
      intentionalProtectedAssetChanges: receipt.intentionalProtectedAssetChanges,
      gaps,
    });
    return receipt;
  } finally {
    if (!writerMarkerReleased) writerMarker.release();
    fence?.release();
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Reap a reset fence left by a dead process after an abrupt termination.
 * This never resumes deletion automatically: a consumed plan is marked
 * failed and the operator must create a new, freshly baselined plan. For a
 * post-delete crash, the immutable backup remains the only rollback source.
 */
export function recoverFullReset(
  handle: KnowledgeDatabaseHandle,
  options: { databasePath: string; manifestPath: string; confirmed: boolean },
): FullResetCrashRecoveryReceipt {
  const manifest = readResetManifest(resolve(options.manifestPath));
  const databasePath = resolve(options.databasePath);
  if (databasePath !== manifest.plan.databasePath) throw new Error("RESET_RECOVERY_DATABASE_PATH_MISMATCH");
  const clearDeadWriterMarker = (expectedPid?: number): boolean => {
    const writerRow = handle.db.prepare("SELECT value FROM meta WHERE key='index_lock::global'").get() as { value: string } | undefined;
    if (!writerRow) return false;
    let owner: { pid?: number; kind?: string; operationId?: string };
    try { owner = JSON.parse(writerRow.value) as typeof owner; }
    catch { throw new Error("RESET_RECOVERY_INDEX_WRITER_STATE_UNKNOWN"); }
    if (owner.kind !== "full_corpus_reset" || owner.operationId !== manifest.plan.operationId) return false;
    if (typeof owner.pid !== "number" || (expectedPid !== undefined && owner.pid !== expectedPid)) return false;
    if (processIsAlive(owner.pid)) return false;
    if (!options.confirmed) throw new Error("RESET_RECOVERY_CONFIRMATION_REQUIRED");
    const removed = handle.db.prepare("DELETE FROM meta WHERE key='index_lock::global' AND value=?").run(writerRow.value);
    if (removed.changes !== 1) throw new Error("RESET_RECOVERY_INDEX_WRITER_CHANGED");
    return true;
  };
  const fencePath = `${databasePath}.full-reset.lock`;
  if (!existsSync(fencePath)) {
    let databaseIntegrity: "ok" | "not_checked" = "not_checked";
    if (manifest.tokenConsumed) {
      const integrity = handle.db.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") throw new Error(`RESET_RECOVERY_DATABASE_INTEGRITY_FAILED:${integrity}`);
      databaseIntegrity = "ok";
    }
    const recoveredMarker = clearDeadWriterMarker();
    if (recoveredMarker) {
      appendResetManifestPhase(resolve(options.manifestPath), "failed", {
        reason: "RESET_CRASH_WRITER_MARKER_RECOVERED",
        previousPhase: manifest.phase,
        rollbackAvailable: existsSync(manifest.plan.backupPath),
      });
    }
    return {
      operationId: manifest.plan.operationId,
      manifestPhase: manifest.phase,
      fencePath,
      recovered: recoveredMarker,
      databaseIntegrity,
      rollbackAvailable: existsSync(manifest.plan.backupPath),
      gaps: recoveredMarker ? ["RESET_PLAN_CONSUMED_CREATE_NEW_PLAN"] : ["RESET_FENCE_NOT_PRESENT"],
    };
  }
  let fence: { formatVersion?: number; operationId?: string; pid?: number };
  try {
    fence = JSON.parse(readFileSync(fencePath, "utf8")) as typeof fence;
  } catch {
    throw new Error("RESET_RECOVERY_FENCE_INVALID");
  }
  if (fence.formatVersion !== 1 || fence.operationId !== manifest.plan.operationId || !Number.isInteger(fence.pid)) {
    throw new Error("RESET_RECOVERY_FENCE_MISMATCH");
  }
  if (processIsAlive(fence.pid as number)) throw new Error("RESET_RECOVERY_FENCE_OWNER_ALIVE");
  if (!options.confirmed) throw new Error("RESET_RECOVERY_CONFIRMATION_REQUIRED");
  // Do not run a full integrity scan here. SQLite makes deleteTargetRows one
  // transaction, so a crash before commit leaves the pre-reset image intact;
  // a crash after commit leaves an atomically reset image. Recovery only reaps
  // the dead fence and reports that integrity remains to be checked by the
  // subsequent reset/index gate. This keeps recovery bounded even for a
  // multi-gigabyte knowledge database.
  clearDeadWriterMarker(fence.pid);
  const currentFence = readFileSync(fencePath, "utf8");
  if (!currentFence.includes(`"operationId":"${manifest.plan.operationId}"`)) throw new Error("RESET_RECOVERY_FENCE_CHANGED");
  unlinkSync(fencePath);
  appendResetManifestPhase(resolve(options.manifestPath), "failed", {
    reason: "RESET_CRASH_RECOVERED",
    previousPhase: manifest.phase,
    deadPid: fence.pid,
    rollbackAvailable: existsSync(manifest.plan.backupPath),
  });
  return {
    operationId: manifest.plan.operationId,
    manifestPhase: manifest.phase,
    fencePath,
    recovered: true,
    databaseIntegrity: "not_checked",
    rollbackAvailable: existsSync(manifest.plan.backupPath),
    gaps: ["RESET_DATABASE_INTEGRITY_NOT_CHECKED", "RESET_PLAN_CONSUMED_CREATE_NEW_PLAN", ...(manifest.phase === "reset" ? ["RESET_POST_DELETE_REQUIRES_ROLLBACK_OR_REINDEX"] : [])],
  };
}

/** Copy a verified pre-reset database to a fresh destination. It is
 * intentionally not an in-place overwrite: recovery must first produce a
 * queryable instance and only then let a separately guarded operator swap it. */
export function rollbackFullReset(
  handle: KnowledgeDatabaseHandle,
  backupPath: string,
  destinationPath: string,
  options: { confirmed: boolean },
): FullResetRollbackReceipt {
  if (!options.confirmed) throw new Error("RESET_ROLLBACK_CONFIRMATION_REQUIRED");
  const source = resolve(backupPath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error("RESET_ROLLBACK_DESTINATION_MUST_BE_FRESH");
  if (existsSync(destination)) throw new Error(`RESET_ROLLBACK_DESTINATION_EXISTS:${destination}`);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, temporary);
  try {
    linkSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  const Constructor = handle.db.constructor as unknown as new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => Database.Database;
  const restored = new Constructor(destination, { fileMustExist: true });
  let sourceDatabaseInstanceId = "";
  let restoredDatabaseInstanceId = "";
  let failure: unknown;
  try {
    const integrity = restored.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") throw new Error(`RESET_ROLLBACK_INTEGRITY_FAILED:${integrity}`);
    const row = restored.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get() as { value?: string } | undefined;
    if (!row?.value) throw new Error("RESET_ROLLBACK_INSTANCE_ID_MISSING");
    sourceDatabaseInstanceId = row.value;
    restoredDatabaseInstanceId = `db_${randomUUID()}`;
    restored.transaction(() => {
      const changed = restored.prepare(
        "UPDATE meta SET value=? WHERE key='database_instance_id' AND value=?",
      ).run(restoredDatabaseInstanceId, sourceDatabaseInstanceId);
      if (changed.changes !== 1) throw new Error("RESET_ROLLBACK_INSTANCE_ID_CHANGED_CONCURRENTLY");
    }).immediate();
    restored.pragma("wal_checkpoint(TRUNCATE)");
    const after = restored.pragma("integrity_check", { simple: true }) as string;
    if (after !== "ok") throw new Error(`RESET_ROLLBACK_INTEGRITY_FAILED:${after}`);
  } catch (error) {
    failure = error;
  } finally {
    restored.close();
  }
  if (failure) {
    rmSync(destination, { force: true });
    rmSync(`${destination}-wal`, { force: true });
    rmSync(`${destination}-shm`, { force: true });
    throw failure;
  }
  return {
    destinationPath: destination,
    sourceDatabaseInstanceId,
    restoredDatabaseInstanceId,
    integrity: "ok",
    sourceBackupPath: source,
  };
}
