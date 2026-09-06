import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { ensureDatabaseInstanceId, SCHEMA_TABLES } from "./schema.js";

/** A deliberately small interface keeps these capture/restore helpers usable
 * with KnowledgeStore and with a read-only database handle in safety tests. */
export interface KnowledgeDatabaseHandle {
  readonly db: Database.Database;
}

/**
 * Protected means "must survive a parser/index rebuild". Some rows (notably
 * `branches` and `meta`) also contain derived status columns; C2 will reset
 * only those columns while this C1 bundle preserves the exact pre-reset image.
 */
export const PROTECTED_ASSET_TABLES = [
  "meta",
  "repos",
  "branches",
  "events",
  "ledger_state",
  "workspaces",
  "workspace_repos",
  "node_aliases",
  "notes_index",
  "fts_notes",
  "note_properties",
  "note_links",
  "entities",
  "response_samples",
  "credential_entries",
  "why_cards",
  "memory_items",
  "ontology_terms",
  "ontology_links",
  "saved_queries",
  "trust_evidence",
  "validated_findings",
  "finding_evidence",
  "knowledge_audit_events",
  "search_feedback",
  "reflection_suggestions",
  "external_knowledge_sources",
  "knowledge_gc_runs",
  "knowledge_size_samples",
] as const;

/** These tables contain both parser output and durable user/ledger rows. C2
 * must use the selectors below instead of deleting the whole table. */
export const MIXED_ASSET_TABLES = ["nodes", "edges"] as const;

/** Parser, resolver, source-cache, and semantic data can be regenerated from
 * Git plus the model manifest. Keeping this list explicit makes a reset plan
 * auditable and prevents a new table from silently becoming deletable. */
export const REBUILDABLE_ASSET_TABLES = [
  "git_commits",
  "revision_snapshots",
  "deployment_revisions",
  "revision_references",
  "endpoint_aliases",
  "endpoint_memberships",
  "symbol_versions",
  "parser_edge_sets",
  "coverage_layers",
  "files_index",
  "fts_symbols",
  "fts_symbol_rows",
  "fts_identifiers",
  "fts_identifier_rows",
  "file_facts",
  "file_fact_symbols",
  "snapshot_overlays",
  "effective_snapshot_files",
  "snapshot_rename_events",
  "resolution_sets",
  "resolved_edges",
  "snapshot_resolution_refs",
  "global_resolved_edges",
  "source_blobs",
  "source_blob_line_offsets",
  "source_blob_trigrams",
  "source_facts",
  "file_fact_sources",
  "effective_snapshot_sources",
  "source_snapshot_overlays",
  "source_backfill_checkpoints",
  "coverage_records",
  "unresolved_reference_coverage",
  "unresolved_reference_items",
  "markdown_sections",
  "pending_frontend_edges",
  "semantic_chunks",
  "embedding_models",
  "semantic_embedding_refs",
  "semantic_vector_values",
  "embedding_spaces",
  "embedding_generations",
  "embedding_jobs",
  "semantic_worker_leases",
  "semantic_controls",
  "semantic_active_spaces",
  "external_calls",
  "source_path_fts",
] as const;

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function resetTrace(message: string): void {
  if (process.env.PENGUIN_RESET_TRACE === "1") console.error(`[reset-trace] ${message}`);
}

export type ProtectedAssetValue =
  | null
  | string
  | number
  | { type: "blob"; base64: string }
  | { type: "integer"; value: string }
  | { type: "boolean"; value: boolean };
export type ProtectedAssetRow = ProtectedAssetValue[];

export interface ProtectedAssetTable {
  key: string;
  table: string;
  selector: "all" | "durable_edges" | "protected_nodes";
  columns: string[];
  rows: ProtectedAssetRow[];
  rowCount: number;
  rowHash: string;
}

export interface ProtectedAssetBundle {
  formatVersion: 1;
  capturedAt: string;
  databaseInstanceId: string;
  tables: Record<string, ProtectedAssetTable>;
  missingTables: string[];
  bundleHash: string;
}

export interface DatabaseBackupReceipt {
  backupPath: string;
  bytes: number;
  integrity: "ok";
  sourceDataVersion: number;
  estimatedBytes: number;
  availableBytesBefore: number | null;
  minimumFreeBytesAfterBackup: number;
  availableBytesAfterEstimate: number | null;
}

export interface DatabaseBackupOptions {
  /** Fail before creating the backup when this much free space would not
   * remain after the estimated copy. Reset/baseline callers use a stronger
   * reserve than the library default. */
  minimumFreeBytesAfterBackup?: number;
}

export class DatabaseBackupInsufficientSpaceError extends Error {
  readonly code = "DATABASE_BACKUP_INSUFFICIENT_SPACE";

  constructor(
    readonly availableBytes: number,
    readonly requiredBytes: number,
    readonly estimatedBytes: number,
    readonly minimumFreeBytesAfterBackup: number,
  ) {
    super(
      `DATABASE_BACKUP_INSUFFICIENT_SPACE:available=${availableBytes}:required=${requiredBytes}:estimated=${estimatedBytes}:reserve=${minimumFreeBytesAfterBackup}`,
    );
    this.name = "DatabaseBackupInsufficientSpaceError";
  }
}

export interface CorpusBaselineRepositoryBranch {
  branchId: string;
  name: string;
  headCommit: string | null;
  indexedCommit: string | null;
  currentSnapshotId: string | null;
}

export interface CorpusBaselineRepository {
  repoId: string;
  name: string;
  rootPath: string;
  remoteUrl: string | null;
  branches: CorpusBaselineRepositoryBranch[];
}

export interface CorpusBaseline {
  formatVersion: 1;
  capturedAt: string;
  rootPath: string;
  databaseInstanceId: string;
  databaseDataVersion: number;
  repositories: CorpusBaselineRepository[];
  counts: Record<string, number>;
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  ledgerBytes: number;
  immutableAssetHashes: Record<string, string>;
  sourceGroundTruthHash: string;
  sourceGroundTruthComplete: boolean;
  sourceGroundTruthGaps: string[];
}

export interface CorpusBaselineOptions {
  rootPath: string;
  databasePath: string;
  ledgerPath?: string;
  protectedAssets?: ProtectedAssetBundle;
  ensureDatabaseInstanceId?: boolean;
  /** Skip full-table database metrics for post-mutation identity checks. */
  includeDatabaseMetrics?: boolean;
}

export interface ProtectedAssetRestoreOptions {
  confirmed: boolean;
  replaceExisting?: boolean;
  backupPath?: string | null;
}

export interface AssetRestoreReceipt {
  backupPath: string | null;
  restoredDatabaseInstanceId: string;
  restoredAssetHashes: Record<string, string>;
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  exact: boolean;
  gaps: string[];
}

function quoteIdentifier(value: string): string {
  if (!TABLE_NAME.test(value)) throw new Error(`ASSET_TABLE_NAME_INVALID:${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

interface ProtectedAssetSpec {
  key: string;
  table: string;
  selector: ProtectedAssetTable["selector"];
}

const PROTECTED_ASSET_SPECS: readonly ProtectedAssetSpec[] = [
  ...PROTECTED_ASSET_TABLES.map((table) => ({ key: table, table, selector: "all" as const })),
  { key: "durable_edges", table: "edges", selector: "durable_edges" },
  { key: "protected_nodes", table: "nodes", selector: "protected_nodes" },
];
const PROTECTED_ASSET_SPEC_BY_KEY = new Map(PROTECTED_ASSET_SPECS.map((spec) => [spec.key, spec]));

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name=? LIMIT 1").get(table) != null;
}

function encodeValue(value: unknown): ProtectedAssetValue {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") return { type: "integer", value: value.toString(10) };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("ASSET_VALUE_NON_FINITE");
    return value;
  }
  throw new Error(`ASSET_VALUE_UNSUPPORTED:${Object.prototype.toString.call(value)}`);
}

function decodeValue(value: ProtectedAssetValue): null | string | number | Buffer | bigint | boolean {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (value.type === "blob") return Buffer.from(value.base64, "base64");
  if (value.type === "integer") return BigInt(value.value);
  return value.value;
}

/** Decode one signed sidecar value for an in-transaction structural restore. */
export function decodeProtectedAssetValue(value: ProtectedAssetValue): null | string | number | Buffer | bigint | boolean {
  return decodeValue(value);
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function assetWhere(spec: ProtectedAssetSpec): string {
  if (spec.selector === "all") return "";
  if (spec.selector === "durable_edges") return " WHERE origin <> 'parser'";
  return ` WHERE id IN (
    SELECT node_id FROM node_aliases
    UNION SELECT node_id FROM notes_index
    UNION SELECT node_id FROM credential_entries
    UNION SELECT endpoint_id FROM response_samples
    UNION SELECT node_id FROM events WHERE node_id IS NOT NULL
    UNION SELECT src FROM edges WHERE origin <> 'parser'
    UNION SELECT dst FROM edges WHERE origin <> 'parser' AND dst IS NOT NULL
  )`;
}

function readAssetTable(
  db: Database.Database,
  spec: ProtectedAssetSpec,
  options: { protectedNodeIds?: readonly string[] } = {},
): ProtectedAssetTable | null {
  if (!tableExists(db, spec.table)) return null;
  const columns = tableColumns(db, spec.table);
  if (columns.length === 0) return null;
  const select = columns.map(quoteIdentifier).join(",");
  const protectedNodeIds = options.protectedNodeIds;
  // Do not hand SQLite `id IN (json_each('[]'))` for a large mixed table:
  // the planner may still walk the whole B-tree before proving the set is
  // empty. The sidecar already proves that there are no protected nodes, so
  // construct the empty capture directly after the cheap PRAGMA lookup.
  if (spec.selector === "protected_nodes" && protectedNodeIds?.length === 0) {
    const rows: ProtectedAssetRow[] = [];
    return {
      key: spec.key,
      table: spec.table,
      selector: spec.selector,
      columns,
      rows,
      rowCount: 0,
      rowHash: sha256Hex(canonicalJson({ key: spec.key, table: spec.table, selector: spec.selector, columns, rows })),
    };
  }
  const where = spec.selector === "protected_nodes" && protectedNodeIds !== undefined
    ? { sql: " WHERE id IN (SELECT value FROM json_each(?))", args: [JSON.stringify([...new Set(protectedNodeIds)].sort())] }
    : { sql: assetWhere(spec), args: [] as unknown[] };
  const rawRows = db.prepare(`SELECT ${select} FROM ${quoteIdentifier(spec.table)}${where.sql}`).all(...where.args) as Array<Record<string, unknown>>;
  const rows = rawRows
    .map((row) => columns.map((column) => encodeValue(row[column])))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    key: spec.key,
    table: spec.table,
    selector: spec.selector,
    columns,
    rows,
    rowCount: rows.length,
    rowHash: sha256Hex(canonicalJson({ key: spec.key, table: spec.table, selector: spec.selector, columns, rows })),
  };
}

function bundlePayload(bundle: Omit<ProtectedAssetBundle, "bundleHash">): unknown {
  return {
    formatVersion: bundle.formatVersion,
    databaseInstanceId: bundle.databaseInstanceId,
    tables: bundle.tables,
    missingTables: bundle.missingTables,
  };
}

function assertBundle(bundle: ProtectedAssetBundle): void {
  if (bundle.formatVersion !== 1 || typeof bundle.databaseInstanceId !== "string" || bundle.databaseInstanceId.length === 0) {
    throw new Error("PROTECTED_ASSET_BUNDLE_INVALID");
  }
  if (!bundle.tables || typeof bundle.tables !== "object" || !Array.isArray(bundle.missingTables)) {
    throw new Error("PROTECTED_ASSET_BUNDLE_INVALID");
  }
  const expected = sha256Hex(canonicalJson(bundlePayload(bundle)));
  if (expected !== bundle.bundleHash) throw new Error("PROTECTED_ASSET_BUNDLE_CHECKSUM_MISMATCH");
  for (const [name, table] of Object.entries(bundle.tables)) {
    const spec = PROTECTED_ASSET_SPEC_BY_KEY.get(name);
    if (!spec || table.key !== name || table.table !== spec.table || table.selector !== spec.selector || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new Error("PROTECTED_ASSET_BUNDLE_INVALID");
    }
    if (table.rowCount !== table.rows.length || table.columns.some((column) => !TABLE_NAME.test(column))) {
      throw new Error(`PROTECTED_ASSET_TABLE_INVALID:${name}`);
    }
    const rowHash = sha256Hex(canonicalJson({ key: name, table: spec.table, selector: spec.selector, columns: table.columns, rows: table.rows }));
    if (rowHash !== table.rowHash) throw new Error(`PROTECTED_ASSET_TABLE_CHECKSUM_MISMATCH:${name}`);
  }
}

function readDatabaseInstanceId(db: Database.Database): string | null {
  if (!tableExists(db, "meta")) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get() as { value?: unknown } | undefined;
  return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
}

/** Resolve the identity without silently inventing one for a read-only DB. */
export function databaseInstanceId(handle: KnowledgeDatabaseHandle, options: { ensure?: boolean } = {}): string {
  const existing = readDatabaseInstanceId(handle.db);
  if (existing) return existing;
  if (options.ensure !== false) return ensureDatabaseInstanceId(handle.db);
  throw new Error("DATABASE_INSTANCE_ID_MISSING");
}

export function captureProtectedAssets(
  handle: KnowledgeDatabaseHandle,
  options: { ensureDatabaseInstanceId?: boolean; protectedNodeIds?: readonly string[] } = {},
): ProtectedAssetBundle {
  const instanceId = databaseInstanceId(handle, { ensure: options.ensureDatabaseInstanceId !== false });
  const tables: Record<string, ProtectedAssetTable> = {};
  const missingTables: string[] = [];
  for (const spec of PROTECTED_ASSET_SPECS) {
    const startedAt = Date.now();
    const captured = readAssetTable(handle.db, spec, { protectedNodeIds: options.protectedNodeIds });
    resetTrace(`capture ${spec.key} rows=${captured?.rowCount ?? 0} elapsedMs=${Date.now() - startedAt}`);
    if (captured) tables[spec.key] = captured;
    else missingTables.push(spec.key);
  }
  const bundleWithoutHash = {
    formatVersion: 1 as const,
    capturedAt: new Date().toISOString(),
    databaseInstanceId: instanceId,
    tables,
    missingTables,
  };
  return { ...bundleWithoutHash, bundleHash: sha256Hex(canonicalJson(bundlePayload(bundleWithoutHash))) };
}

function writeNoClobber(path: string, bytes: Uint8Array, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  try {
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeProtectedAssetBundle(bundle: ProtectedAssetBundle, path: string): string {
  assertBundle(bundle);
  writeNoClobber(path, Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8"), 0o600);
  return path;
}

export function readProtectedAssetBundle(path: string): ProtectedAssetBundle {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ProtectedAssetBundle;
  assertBundle(parsed);
  return parsed;
}

/**
 * Restore only the two mixed tables that are structurally rebuilt by a full
 * corpus reset. The caller owns the surrounding SQLite transaction and has
 * already recreated the schema, so this helper never opens a nested
 * transaction or performs a second full-table verification scan.
 */
export function restoreStructuralMixedAssets(
  handle: KnowledgeDatabaseHandle,
  bundle: ProtectedAssetBundle,
): Record<string, number> {
  assertBundle(bundle);
  const restored: Record<string, number> = {};
  for (const key of ["protected_nodes", "durable_edges"] as const) {
    const asset = bundle.tables[key];
    if (!asset) {
      restored[key] = 0;
      continue;
    }
    if (!tableExists(handle.db, asset.table)) throw new Error(`PROTECTED_ASSET_TARGET_TABLE_MISSING:${key}`);
    const existing = Number((handle.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(asset.table)}`).get() as { count: number }).count ?? 0);
    if (existing !== 0) throw new Error(`PROTECTED_ASSET_TARGET_TABLE_NOT_EMPTY:${key}`);
    const columns = asset.columns.map(quoteIdentifier).join(",");
    const values = asset.columns.map(() => "?").join(",");
    const insert = handle.db.prepare(`INSERT INTO ${quoteIdentifier(asset.table)} (${columns}) VALUES (${values})`);
    for (const row of asset.rows) insert.run(...row.map(decodeValue));
    restored[key] = asset.rows.length;
  }
  return restored;
}

/**
 * SQLite's online backup API copies committed pages plus the WAL without
 * copying a live `-wal` file by hand. We verify source data_version before and
 * after the copy and publish with no-clobber semantics so a concurrent writer
 * becomes an explicit retry, never a falsely-labelled baseline.
 */
export async function createConsistentDatabaseBackup(
  handle: KnowledgeDatabaseHandle,
  backupPath: string,
  options: DatabaseBackupOptions = {},
): Promise<DatabaseBackupReceipt> {
  if (existsSync(backupPath)) throw new Error(`DATABASE_BACKUP_EXISTS:${backupPath}`);
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  const minimumFreeBytesAfterBackup = options.minimumFreeBytesAfterBackup ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(minimumFreeBytesAfterBackup) || minimumFreeBytesAfterBackup < 0) {
    throw new Error(`DATABASE_BACKUP_INVALID_MINIMUM_FREE_BYTES:${minimumFreeBytesAfterBackup}`);
  }
  const pageCount = Number(handle.db.pragma("page_count", { simple: true }));
  const pageSize = Number(handle.db.pragma("page_size", { simple: true }));
  if (!Number.isSafeInteger(pageCount) || pageCount < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error(`DATABASE_BACKUP_INVALID_SIZE_ESTIMATE:page_count=${pageCount}:page_size=${pageSize}`);
  }
  const logicalBytes = pageCount * pageSize;
  const databaseName = handle.db.name;
  const sourceFileBytes = databaseName && databaseName !== ":memory:" && existsSync(databaseName)
    ? statSync(databaseName).size
    : 0;
  // SQLite online backup copies database pages, not the live WAL. Keep a 5%
  // plus 16 MiB margin for page growth and filesystem allocation rounding.
  const estimatedBytes = Math.ceil(Math.max(logicalBytes, sourceFileBytes) * 1.05 + 16 * 1024 * 1024);
  const filesystem = statfsSync(dirname(backupPath));
  const availableBytesBefore = filesystem.bavail * filesystem.bsize;
  const requiredBytes = estimatedBytes + minimumFreeBytesAfterBackup;
  if (availableBytesBefore < requiredBytes) {
    throw new DatabaseBackupInsufficientSpaceError(
      availableBytesBefore,
      requiredBytes,
      estimatedBytes,
      minimumFreeBytesAfterBackup,
    );
  }
  const temporary = `${backupPath}.tmp-${process.pid}-${Date.now()}`;
  const before = Number(handle.db.pragma("data_version", { simple: true }));
  const integrity = handle.db.pragma("integrity_check", { simple: true }) as string;
  if (integrity !== "ok") throw new Error(`DATABASE_INTEGRITY_FAILED:${integrity}`);
  try {
    await handle.db.backup(temporary);
    const after = Number(handle.db.pragma("data_version", { simple: true }));
    if (before !== after) throw new Error("DATABASE_CHANGED_DURING_BACKUP");
    const DatabaseConstructor = handle.db.constructor as unknown as new (
      path: string,
      options?: { readonly?: boolean; fileMustExist?: boolean },
    ) => Database.Database;
    const backup = new DatabaseConstructor(temporary, { readonly: true, fileMustExist: true });
    try {
      const backupIntegrity = backup.pragma("integrity_check", { simple: true }) as string;
      if (backupIntegrity !== "ok") throw new Error(`DATABASE_BACKUP_INTEGRITY_FAILED:${backupIntegrity}`);
    } finally {
      backup.close();
    }
    const bytes = statSync(temporary).size;
    try {
      linkSync(temporary, backupPath);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") throw new Error(`DATABASE_BACKUP_EXISTS:${backupPath}`);
      throw error;
    }
    return {
      backupPath,
      bytes,
      integrity: "ok",
      sourceDataVersion: after,
      estimatedBytes,
      availableBytesBefore,
      minimumFreeBytesAfterBackup,
      availableBytesAfterEstimate: availableBytesBefore - estimatedBytes,
    };
  } finally {
    rmSync(temporary, { force: true });
  }
}

function countTables(db: Database.Database, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (!tableExists(db, table)) {
      counts[table] = 0;
      continue;
    }
    counts[table] = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number }).count ?? 0);
  }
  return counts;
}

function assetHashes(bundle: ProtectedAssetBundle): Record<string, string> {
  return Object.fromEntries([
    ["protected:bundle", bundle.bundleHash],
    ...Object.values(bundle.tables).map((table) => [`protected:${table.key}`, table.rowHash]),
  ]);
}

function canonicalExistingPath(path: string): string {
  try {
    // macOS may expose the same temporary path as /tmp and /private/tmp.
    // Git truth and reset scope must use one identity or a valid multi-repo
    // baseline is incorrectly reduced to the root fallback.
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const rootPath = canonicalExistingPath(root);
  const candidatePath = canonicalExistingPath(candidate);
  const rest = relative(rootPath, candidatePath);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function gitText(rootPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", rootPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function gitBytes(rootPath: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", ["-C", rootPath, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashUntrackedFile(rootPath: string, relativePath: string): string {
  const path = join(rootPath, relativePath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return hashBytes(Buffer.from(`symlink:${readlinkSync(path)}`, "utf8"));
  if (!stat.isFile()) return hashBytes(Buffer.from(`special:${stat.mode}:${stat.size}`, "utf8"));
  return hashBytes(readFileSync(path));
}

interface GitGroundTruth {
  repoId: string;
  rootPath: string;
  head: string | null;
  branch: string | null;
  trackedManifestHash: string | null;
  statusHash: string | null;
  worktreeDiffHash: string | null;
  untracked: Array<{ path: string; hash: string }>;
  error?: string;
}

function gitGroundTruth(repoId: string, rootPath: string): GitGroundTruth {
  const canonicalRoot = canonicalExistingPath(rootPath);
  const topLevel = gitText(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return { repoId, rootPath: canonicalRoot, head: null, branch: null, trackedManifestHash: null, statusHash: null, worktreeDiffHash: null, untracked: [], error: "NOT_A_GIT_REPOSITORY" };
  const head = gitText(canonicalRoot, ["rev-parse", "HEAD"]);
  const branch = gitText(canonicalRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const tracked = gitBytes(canonicalRoot, ["ls-files", "-s", "-z"]);
  const status = gitBytes(canonicalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const diff = gitBytes(canonicalRoot, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  const untrackedBytes = gitBytes(canonicalRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = (untrackedBytes ? untrackedBytes.toString("utf8").split("\0") : [])
    .filter(Boolean)
    .sort()
    .map((path) => ({ path, hash: hashUntrackedFile(canonicalRoot, path) }));
  return {
    repoId,
    rootPath: canonicalRoot,
    head,
    branch,
    trackedManifestHash: tracked ? hashBytes(tracked) : null,
    statusHash: status ? hashBytes(status) : null,
    worktreeDiffHash: diff ? hashBytes(diff) : null,
    untracked,
  };
}

function sourceGroundTruth(
  rootPath: string,
  repositories: CorpusBaselineRepository[],
): { hash: string; complete: boolean; gaps: string[] } {
  const roots = repositories.filter((repo) => pathWithin(rootPath, repo.rootPath));
  const candidates = roots.length > 0 ? roots : [{ repoId: "root", rootPath: canonicalExistingPath(rootPath) } as CorpusBaselineRepository];
  const oracle: GitGroundTruth[] = candidates.map((repo) => gitGroundTruth(repo.repoId, repo.rootPath));
  const gaps = oracle.filter((item) => item.error).map((item) => `${item.repoId}:${item.error}`);
  return { hash: sha256Hex(canonicalJson(oracle)), complete: gaps.length === 0, gaps };
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function ledgerHash(path: string | undefined): { bytes: number; hash: string | null } {
  if (!path || !existsSync(path)) return { bytes: 0, hash: null };
  const bytes = readFileSync(path);
  return { bytes: bytes.byteLength, hash: hashBytes(bytes) };
}

export function captureCorpusBaseline(handle: KnowledgeDatabaseHandle, options: CorpusBaselineOptions): CorpusBaseline {
  const includeDatabaseMetrics = options.includeDatabaseMetrics !== false;
  const bundle = options.protectedAssets ?? captureProtectedAssets(handle, { ensureDatabaseInstanceId: options.ensureDatabaseInstanceId !== false });
  const rows = handle.db.prepare(
    "SELECT id,name,root_path AS rootPath,remote_url AS remoteUrl FROM repos ORDER BY id",
  ).all() as Array<{ id: string; name: string; rootPath: string; remoteUrl: string | null }>;
  const repositories = rows.map((repo) => ({
    repoId: repo.id,
    name: repo.name,
    rootPath: canonicalExistingPath(repo.rootPath),
    remoteUrl: repo.remoteUrl,
    branches: (handle.db.prepare(
      "SELECT id,name,head_commit AS headCommit,last_indexed_commit AS indexedCommit,current_snapshot_id AS currentSnapshotId FROM branches WHERE repo_id=? ORDER BY name,id",
    ).all(repo.id) as Array<{ id: string; name: string; headCommit: string | null; indexedCommit: string | null; currentSnapshotId: string | null }>).map((branch) => ({
      branchId: branch.id,
      name: branch.name,
      headCommit: branch.headCommit,
      indexedCommit: branch.indexedCommit,
      currentSnapshotId: branch.currentSnapshotId,
    })),
  }));
  const truth = sourceGroundTruth(options.rootPath, repositories);
  const ledger = includeDatabaseMetrics ? ledgerHash(options.ledgerPath) : { bytes: 0, hash: null };
  const hashes = {
    ...assetHashes(bundle),
    "source-ground-truth": truth.hash,
    ...(ledger.hash ? { ledger: ledger.hash } : {}),
  };
  return {
    formatVersion: 1,
    capturedAt: new Date().toISOString(),
    rootPath: canonicalExistingPath(options.rootPath),
    databaseInstanceId: bundle.databaseInstanceId,
    databaseDataVersion: Number(handle.db.pragma("data_version", { simple: true })),
    repositories,
    counts: includeDatabaseMetrics
      ? countTables(handle.db, [...new Set([...SCHEMA_TABLES, ...PROTECTED_ASSET_TABLES, ...REBUILDABLE_ASSET_TABLES])])
      : {},
    databaseBytes: includeDatabaseMetrics ? fileBytes(options.databasePath) : 0,
    walBytes: includeDatabaseMetrics ? fileBytes(`${options.databasePath}-wal`) : 0,
    shmBytes: includeDatabaseMetrics ? fileBytes(`${options.databasePath}-shm`) : 0,
    ledgerBytes: ledger.bytes,
    immutableAssetHashes: hashes,
    sourceGroundTruthHash: truth.hash,
    sourceGroundTruthComplete: truth.complete,
    sourceGroundTruthGaps: truth.gaps,
  };
}

export function writeCorpusBaseline(baseline: CorpusBaseline, path: string): string {
  writeNoClobber(path, Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`, "utf8"), 0o600);
  return path;
}

function currentAssetSpecs(db: Database.Database): ProtectedAssetSpec[] {
  return PROTECTED_ASSET_SPECS.filter((spec) => tableExists(db, spec.table));
}

function countAssetRows(db: Database.Database, spec: ProtectedAssetSpec): number {
  if (!tableExists(db, spec.table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(spec.table)}${assetWhere(spec)}`).get() as { count: number }).count ?? 0);
}

function countsMatch(expected: Record<string, number>, actual: Record<string, number>): boolean {
  return Object.keys(expected).every((key) => expected[key] === actual[key]);
}

/** Restore only into an explicitly confirmed destination. `replaceExisting`
 * is separate from `confirmed` so a caller cannot accidentally erase a
 * destination merely by acknowledging the operation. */
export function restoreProtectedAssets(
  handle: KnowledgeDatabaseHandle,
  bundle: ProtectedAssetBundle,
  options: ProtectedAssetRestoreOptions,
): AssetRestoreReceipt {
  assertBundle(bundle);
  if (!options.confirmed) throw new Error("PROTECTED_ASSET_RESTORE_CONFIRMATION_REQUIRED");
  const targetSpecs = currentAssetSpecs(handle.db);
  const bundleTables = Object.keys(bundle.tables);
  const countsBefore = Object.fromEntries(targetSpecs.map((spec) => [spec.key, countAssetRows(handle.db, spec)]));
  if (!options.replaceExisting && Object.values(countsBefore).some((count) => count > 0)) {
    throw new Error("PROTECTED_ASSET_RESTORE_DESTINATION_NOT_EMPTY");
  }
  const gaps: string[] = [];
  for (const key of bundleTables) if (!targetSpecs.some((spec) => spec.key === key)) gaps.push(`TARGET_TABLE_MISSING:${key}`);
  for (const key of bundle.missingTables) if (targetSpecs.some((spec) => spec.key === key)) gaps.push(`SOURCE_TABLE_MISSING:${key}`);
  const restoreSpecs = bundleTables
    .map((key) => PROTECTED_ASSET_SPEC_BY_KEY.get(key))
    .filter((spec): spec is ProtectedAssetSpec => spec !== undefined && targetSpecs.some((target) => target.key === spec.key));
  const tx = handle.db.transaction(() => {
    if (options.replaceExisting) {
      for (const spec of restoreSpecs) handle.db.prepare(`DELETE FROM ${quoteIdentifier(spec.table)}${assetWhere(spec)}`).run();
    }
    for (const spec of restoreSpecs) {
      const asset = bundle.tables[spec.key];
      const columns = asset.columns.map(quoteIdentifier).join(",");
      const values = asset.columns.map(() => "?").join(",");
      const insert = handle.db.prepare(`INSERT INTO ${quoteIdentifier(spec.table)} (${columns}) VALUES (${values})`);
      for (const row of asset.rows) insert.run(...row.map(decodeValue));
    }
  });
  tx.immediate();
  const restoredBundle = captureProtectedAssets(handle, { ensureDatabaseInstanceId: false });
  const countsAfter = Object.fromEntries(targetSpecs.map((spec) => [spec.key, countAssetRows(handle.db, spec)]));
  const restoredAssetHashes = assetHashes(restoredBundle);
  for (const [key, expected] of Object.entries(assetHashes(bundle))) {
    if (restoredAssetHashes[key] !== expected) gaps.push(`HASH_MISMATCH:${key}`);
  }
  for (const [key, expected] of Object.entries(bundle.tables)) {
    if (countsAfter[key] !== expected.rowCount) gaps.push(`COUNT_MISMATCH:${key}`);
  }
  if (restoredBundle.databaseInstanceId !== bundle.databaseInstanceId) gaps.push("DATABASE_INSTANCE_ID_MISMATCH");
  return {
    backupPath: options.backupPath ?? null,
    restoredDatabaseInstanceId: restoredBundle.databaseInstanceId,
    restoredAssetHashes,
    countsBefore,
    countsAfter,
    exact: gaps.length === 0 && countsMatch(
      Object.fromEntries(Object.entries(bundle.tables).map(([table, value]) => [table, value.rowCount])),
      countsAfter,
    ),
    gaps: [...new Set(gaps)],
  };
}
