import { statSync } from "node:fs";
import type { KnowledgeStore } from "./store.js";
import { trigramLaneEnabled } from "./trigram-lane.js";
import {
  DEFAULT_REVISION_RETENTION,
  planRevisionCollection,
  applyRevisionCollection,
} from "./revision-retention.js";

// Storage visibility for the Wiki Storage page. Everything here is
// best-effort observability: any sub-section that cannot be computed (file
// unreadable, dbstat unavailable, no history yet) degrades to null for that
// section — the report itself never throws.

export interface StorageFileSizes {
  dbBytes: number | null;
  walBytes: number | null;
  shmBytes: number | null;
  totalBytes: number;
}

export type StorageHealthLevel = "ok" | "warn" | "critical";

export interface StorageHealth {
  level: StorageHealthLevel;
  // Machine keys the UI translates ("wal_ratio", "growth_rate"); empty when ok.
  reasons: string[];
  walRatio: number | null;
  weeklyDeltaBytes: number | null;
}

export type StorageTableCategory =
  | "graph_edges"
  | "source_content"
  | "fts"
  | "vectors"
  | "symbols"
  | "other";

export interface StorageTablesSection {
  computedAt: string;
  categories: Array<{ key: StorageTableCategory; bytes: number }>;
}

export interface GcRunRecord {
  repoId: string | null;
  triggerKind: string;
  startedAt: string;
  finishedAt: string;
  cooledSnapshots: number;
  collectedSnapshots: number;
  collectedResolutionSets: number;
  collectedFacts: number;
  collectedSourceFacts: number;
  collectedSourceBlobs: number;
  skipped: number;
  error: string | null;
}

export interface StorageRepoRow {
  repoId: string;
  repoName: string;
  snapshots: number;
  files: number;
  lastIndexedAt: string | null;
}

export interface MaintenanceState {
  running: boolean;
  action: "collect" | "vacuum" | null;
  startedAt: string | null;
}

export interface StorageReport {
  computedAt: string;
  files: StorageFileSizes;
  health: StorageHealth;
  growth: { weeklyDeltaBytes: number | null; samples: Array<{ date: string; totalBytes: number; walBytes: number }> };
  tables: StorageTablesSection | null;
  gc: {
    lastRun: GcRunRecord | null;
    hotFeatureLimit: number;
    trigramEnabled: boolean;
  };
  maintenance: MaintenanceState & { lastResult: MaintenanceResult | null };
  repos: StorageRepoRow[];
}

// Health thresholds. Ratio-based (not absolute size): the 25GB incident was a
// 16GB WAL against a ~5GB main DB — a ratio rule flags that in its first
// hours, an absolute-GB rule only after days of growth. The absolute WAL
// floor keeps small databases from warning on a perfectly normal 20MB WAL.
const WAL_RATIO_WARN = 0.05;
const WAL_RATIO_CRITICAL = 0.15;
const WAL_FLOOR_BYTES = 256 * 1024 * 1024;
const WEEKLY_DELTA_WARN_BYTES = 500 * 1024 * 1024;
const WEEKLY_DELTA_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;

const MAINTENANCE_LOCK_KEY = "knowledge_maintenance_lock";
const MAINTENANCE_LAST_KEY = "knowledge_maintenance_last";
const MAINTENANCE_LOCK_MAX_AGE_MS = 60 * 60_000;
const INDEX_LOCK_MAX_AGE_MS = 30 * 60_000;
const TABLES_CACHE_TTL_MS = 10 * 60_000;

function statBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function mainDbPath(store: KnowledgeStore): string | null {
  try {
    const row = store.db
      .prepare("SELECT file FROM pragma_database_list WHERE name='main'")
      .get() as { file?: string } | undefined;
    return row?.file ? row.file : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readStorageFileSizes(store: KnowledgeStore): StorageFileSizes {
  const dbPath = mainDbPath(store);
  const dbBytes = dbPath ? statBytes(dbPath) : null;
  const walBytes = dbPath ? statBytes(`${dbPath}-wal`) : null;
  const shmBytes = dbPath ? statBytes(`${dbPath}-shm`) : null;
  return {
    dbBytes,
    walBytes,
    shmBytes,
    totalBytes: (dbBytes ?? 0) + (walBytes ?? 0) + (shmBytes ?? 0),
  };
}

// One row per calendar day, updated in place on later calls the same day —
// the sample always reflects the day's latest observation. Sampling happens
// as a side effect of building the report (no background timer), so the
// history is only as dense as actual usage; the delta query below tolerates
// gaps by taking the newest sample at least 7 days old.
function recordDailySample(store: KnowledgeStore, files: StorageFileSizes): void {
  if (files.dbBytes == null) return;
  try {
    store.db
      .prepare(
        `INSERT INTO knowledge_size_samples(sample_date,total_bytes,wal_bytes,recorded_at) VALUES (?,?,?,?)
         ON CONFLICT(sample_date) DO UPDATE SET total_bytes=excluded.total_bytes, wal_bytes=excluded.wal_bytes, recorded_at=excluded.recorded_at`,
      )
      .run(new Date().toISOString().slice(0, 10), files.totalBytes, files.walBytes ?? 0, new Date().toISOString());
  } catch {
    // Missing table on an old DB — sampling is optional.
  }
}

function weeklyDelta(store: KnowledgeStore, files: StorageFileSizes): number | null {
  if (files.dbBytes == null) return null;
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const row = store.db
      .prepare("SELECT total_bytes AS totalBytes FROM knowledge_size_samples WHERE sample_date <= ? ORDER BY sample_date DESC LIMIT 1")
      .get(cutoff) as { totalBytes: number } | undefined;
    if (!row) return null;
    return files.totalBytes - row.totalBytes;
  } catch {
    return null;
  }
}

function recentSamples(store: KnowledgeStore): Array<{ date: string; totalBytes: number; walBytes: number }> {
  try {
    return (
      store.db
        .prepare("SELECT sample_date AS date, total_bytes AS totalBytes, wal_bytes AS walBytes FROM knowledge_size_samples ORDER BY sample_date DESC LIMIT 30")
        .all() as Array<{ date: string; totalBytes: number; walBytes: number }>
    ).reverse();
  } catch {
    return [];
  }
}

export function evaluateStorageHealth(files: StorageFileSizes, weeklyDeltaBytes: number | null): StorageHealth {
  const reasons: string[] = [];
  let level: StorageHealthLevel = "ok";
  const escalate = (target: StorageHealthLevel, reason: string) => {
    reasons.push(reason);
    if (target === "critical" || (target === "warn" && level === "ok")) level = target;
  };
  const walRatio = files.dbBytes && files.dbBytes > 0 && files.walBytes != null ? files.walBytes / files.dbBytes : null;
  if (walRatio != null && files.walBytes != null && files.walBytes >= WAL_FLOOR_BYTES) {
    if (walRatio >= WAL_RATIO_CRITICAL) escalate("critical", "wal_ratio");
    else if (walRatio >= WAL_RATIO_WARN) escalate("warn", "wal_ratio");
  }
  if (weeklyDeltaBytes != null) {
    if (weeklyDeltaBytes >= WEEKLY_DELTA_CRITICAL_BYTES) escalate("critical", "growth_rate");
    else if (weeklyDeltaBytes >= WEEKLY_DELTA_WARN_BYTES) escalate("warn", "growth_rate");
  }
  return { level, reasons, walRatio, weeklyDeltaBytes };
}

function categorizeTable(name: string): StorageTableCategory {
  if (name.startsWith("vec_") || name.startsWith("semantic_") || name.startsWith("embedding_")) return "vectors";
  if (name.includes("_fts") || name.startsWith("fts_")) return "fts";
  if (name.startsWith("source_")) return "source_content";
  if (
    name === "edges" || name === "resolved_edges" || name === "resolution_sets"
    || name === "parser_edge_sets" || name === "snapshot_resolution_refs"
  ) return "graph_edges";
  if (
    name === "nodes" || name === "node_aliases" || name === "symbol_versions"
    || name.startsWith("file_fact") || name.startsWith("effective_snapshot") || name.startsWith("snapshot_")
  ) return "symbols";
  return "other";
}

// dbstat walks every page of a multi-GB database (1-3s) — cache per DB file
// so footer-adjacent polling never pays it twice inside the TTL.
const tablesCache = new Map<string, { at: number; section: StorageTablesSection | null }>();

function tablesSection(store: KnowledgeStore, ttlMs: number): StorageTablesSection | null {
  const key = store.db.name;
  const cached = tablesCache.get(key);
  if (cached && Date.now() - cached.at < ttlMs) return cached.section;
  let section: StorageTablesSection | null = null;
  try {
    // Join through sqlite_master so an index's pages are attributed to its
    // parent table's category — otherwise the ~1GB of idx_edges_* pages all
    // land in "other" and the breakdown lies about where the bytes are.
    const rows = store.db
      .prepare(
        `SELECT COALESCE(m.tbl_name, s.name) AS name, SUM(s.pgsize) AS bytes
           FROM dbstat s LEFT JOIN sqlite_master m ON m.name = s.name
          WHERE s.name NOT LIKE 'sqlite_%' GROUP BY COALESCE(m.tbl_name, s.name)`,
      )
      .all() as Array<{ name: string; bytes: number }>;
    const byCategory = new Map<StorageTableCategory, number>();
    for (const row of rows) {
      const category = categorizeTable(row.name);
      byCategory.set(category, (byCategory.get(category) ?? 0) + row.bytes);
    }
    section = {
      computedAt: new Date().toISOString(),
      categories: [...byCategory.entries()]
        .map(([categoryKey, bytes]) => ({ key: categoryKey, bytes }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  } catch {
    section = null;
  }
  tablesCache.set(key, { at: Date.now(), section });
  return section;
}

function lastGcRun(store: KnowledgeStore): GcRunRecord | null {
  try {
    const row = store.db
      .prepare(
        `SELECT repo_id AS repoId, trigger_kind AS triggerKind, started_at AS startedAt, finished_at AS finishedAt,
                cooled_snapshots AS cooledSnapshots, collected_snapshots AS collectedSnapshots,
                collected_resolution_sets AS collectedResolutionSets, collected_facts AS collectedFacts,
                collected_source_facts AS collectedSourceFacts, collected_source_blobs AS collectedSourceBlobs,
                skipped, error
           FROM knowledge_gc_runs ORDER BY id DESC LIMIT 1`,
      )
      .get() as GcRunRecord | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function repoRows(store: KnowledgeStore): StorageRepoRow[] {
  try {
    return store.db
      .prepare(
        `SELECT r.id AS repoId, r.name AS repoName,
                (SELECT COUNT(*) FROM revision_snapshots s WHERE s.repo_id=r.id AND s.state IN ('ready','cold')) AS snapshots,
                (SELECT COUNT(*) FROM coverage_records c WHERE c.repo_id=r.id AND c.coverage_status='admitted') AS files,
                (SELECT MAX(b.last_indexed_at) FROM branches b WHERE b.repo_id=r.id) AS lastIndexedAt
           FROM repos r ORDER BY lastIndexedAt DESC`,
      )
      .all() as StorageRepoRow[];
  } catch {
    return [];
  }
}

interface MaintenanceLock {
  pid?: number;
  action?: string;
  startedAt?: string;
}

export function maintenanceState(store: KnowledgeStore): MaintenanceState {
  try {
    const row = store.db.prepare("SELECT value FROM meta WHERE key=?").get(MAINTENANCE_LOCK_KEY) as { value: string } | undefined;
    if (!row) return { running: false, action: null, startedAt: null };
    const lock = JSON.parse(row.value) as MaintenanceLock;
    const age = Date.now() - Date.parse(lock.startedAt ?? "");
    const alive = typeof lock.pid === "number" && pidAlive(lock.pid);
    if (alive && Number.isFinite(age) && age < MAINTENANCE_LOCK_MAX_AGE_MS) {
      return {
        running: true,
        action: lock.action === "vacuum" ? "vacuum" : "collect",
        startedAt: lock.startedAt ?? null,
      };
    }
    return { running: false, action: null, startedAt: null };
  } catch {
    return { running: false, action: null, startedAt: null };
  }
}

export interface MaintenanceResult {
  action: "collect" | "vacuum";
  startedAt: string;
  finishedAt: string;
  // collect: aggregate counts across repos. vacuum: bytes reclaimed.
  collected?: { snapshots: number; resolutionSets: number; sourceBlobs: number; facts: number };
  reclaimedBytes?: number;
  error: string | null;
}

function lastMaintenanceResult(store: KnowledgeStore): MaintenanceResult | null {
  try {
    const row = store.db.prepare("SELECT value FROM meta WHERE key=?").get(MAINTENANCE_LAST_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as MaintenanceResult) : null;
  } catch {
    return null;
  }
}

function activeIndexLock(store: KnowledgeStore): boolean {
  try {
    const rows = store.db.prepare("SELECT value FROM meta WHERE key LIKE 'index_lock::%'").all() as Array<{ value: string }>;
    for (const row of rows) {
      try {
        const lock = JSON.parse(row.value) as { pid?: number; startedAt?: string };
        const age = Date.now() - Date.parse(lock.startedAt ?? "");
        if (typeof lock.pid === "number" && pidAlive(lock.pid) && Number.isFinite(age) && age < INDEX_LOCK_MAX_AGE_MS) return true;
      } catch {
        // unparseable marker → stale
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface BuildStorageReportOptions {
  // Test hook: dbstat cache TTL (default 10 minutes).
  tablesTtlMs?: number;
}

export function buildStorageReport(store: KnowledgeStore, options: BuildStorageReportOptions = {}): StorageReport {
  const files = readStorageFileSizes(store);
  recordDailySample(store, files);
  const weeklyDeltaBytes = weeklyDelta(store, files);
  return {
    computedAt: new Date().toISOString(),
    files,
    health: evaluateStorageHealth(files, weeklyDeltaBytes),
    growth: { weeklyDeltaBytes, samples: recentSamples(store) },
    tables: tablesSection(store, options.tablesTtlMs ?? TABLES_CACHE_TTL_MS),
    gc: {
      lastRun: lastGcRun(store),
      hotFeatureLimit: DEFAULT_REVISION_RETENTION.maxHotFeatureViews,
      trigramEnabled: trigramLaneEnabled(store),
    },
    maintenance: { ...maintenanceState(store), lastResult: lastMaintenanceResult(store) },
    repos: repoRows(store),
  };
}

// Manual maintenance from the Storage page. Runs synchronously inside the
// resident runtime (its single-threaded dispatch already serializes DB
// maintenance against queries); the meta lock additionally excludes other
// processes (CLI, MCP) and refuses to run while an index is in flight.
export function runStorageMaintenance(store: KnowledgeStore, action: "collect" | "vacuum"): MaintenanceResult {
  if (action !== "collect" && action !== "vacuum") {
    throw Object.assign(new Error("MAINTENANCE_ACTION_INVALID"), { code: "MAINTENANCE_ACTION_INVALID" });
  }
  if (activeIndexLock(store)) {
    throw Object.assign(new Error("INDEX_IN_PROGRESS"), { code: "INDEX_IN_PROGRESS" });
  }
  if (maintenanceState(store).running) {
    throw Object.assign(new Error("MAINTENANCE_IN_PROGRESS"), { code: "MAINTENANCE_IN_PROGRESS" });
  }
  const startedAt = new Date().toISOString();
  store.db
    .prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(MAINTENANCE_LOCK_KEY, JSON.stringify({ pid: process.pid, action, startedAt } satisfies MaintenanceLock));
  let result: MaintenanceResult;
  try {
    if (action === "collect") {
      const totals = { snapshots: 0, resolutionSets: 0, sourceBlobs: 0, facts: 0 };
      const repos = store.db.prepare("SELECT id FROM repos").all() as Array<{ id: string }>;
      for (const repo of repos) {
        const applied = applyRevisionCollection(store, planRevisionCollection(store, repo.id), { trigger: "maintenance" });
        totals.snapshots += applied.collectedSnapshotIds.length;
        totals.resolutionSets += applied.collectedResolutionSetIds.length;
        totals.sourceBlobs += applied.collectedSourceBlobIds.length;
        totals.facts += applied.collectedFactIds.length;
      }
      result = { action, startedAt, finishedAt: new Date().toISOString(), collected: totals, error: null };
    } else {
      const before = readStorageFileSizes(store).totalBytes;
      // Fold the WAL first: VACUUM rewrites the main file but leaves a huge
      // WAL huge. TRUNCATE fails soft under active readers — surface that as
      // a typed error instead of letting VACUUM stall on the write lock.
      const checkpoint = store.db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
      if (checkpoint[0]?.busy) {
        throw Object.assign(new Error("ACTIVE_READERS"), { code: "ACTIVE_READERS" });
      }
      store.db.exec("VACUUM");
      const after = readStorageFileSizes(store).totalBytes;
      result = { action, startedAt, finishedAt: new Date().toISOString(), reclaimedBytes: Math.max(0, before - after), error: null };
    }
  } catch (error) {
    const failed: MaintenanceResult = {
      action,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: String((error as Error).message ?? error),
    };
    persistMaintenanceResult(store, failed);
    releaseMaintenanceLock(store);
    throw error;
  }
  persistMaintenanceResult(store, result);
  releaseMaintenanceLock(store);
  // Sizes just changed; refresh the day's sample and invalidate the tables
  // cache so the next report reflects the new layout immediately.
  tablesCache.delete(store.db.name);
  recordDailySample(store, readStorageFileSizes(store));
  return result;
}

function persistMaintenanceResult(store: KnowledgeStore, result: MaintenanceResult): void {
  try {
    store.db
      .prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(MAINTENANCE_LAST_KEY, JSON.stringify(result));
  } catch {
    // observability only
  }
}

function releaseMaintenanceLock(store: KnowledgeStore): void {
  try {
    store.db.prepare("DELETE FROM meta WHERE key=?").run(MAINTENANCE_LOCK_KEY);
  } catch {
    // lock rows self-expire via pid liveness; leaking one is recoverable
  }
}
