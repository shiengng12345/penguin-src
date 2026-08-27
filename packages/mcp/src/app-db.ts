import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export type DesktopProtocol = "grpc-web" | "grpc" | "sdk" | "rest";

export interface MetadataEntry {
  key: string;
  value: string;
  enabled: boolean;
}

export interface StoredRequestSummary {
  id: string;
  name?: string;
  timestamp?: number;
  savedAt?: number;
  protocol: string;
  methodFullName: string;
  serviceName: string;
  packageName: string;
  url: string;
  metadata: MetadataEntry[];
  requestBody: string;
  requestBodyTruncated: boolean;
  restMethod?: string;
  restBodyMode?: string;
}

const APP_VALUE_KEYS = {
  defaultHeaders: "penguin-default-headers",
  history: "penguin-history",
} as const;
const SENSITIVE_APP_VALUE_PREFIXES = ["rest:secret:", "redis:secret:"] as const;

function isSensitiveAppValueKey(key: string): boolean {
  return SENSITIVE_APP_VALUE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const REQUEST_BODY_LIMIT = 4000;
const MAX_LIST_LIMIT = 100;
const SQLITE_MAX_BUFFER = 16 * 1024 * 1024;
// Hard cap on any CLI-fallback read. One pathological query must fail loudly
// instead of wedging the server: reads here run synchronously on the event
// loop, so a hung child once serialized and blocked EVERY tool call
// (including mcp_health) for 14+ minutes.
const SQLITE_CLI_TIMEOUT_MS = 10_000;
const SQLITE_CANDIDATES = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "sqlite3"];

function sqliteBinary(): string {
  return SQLITE_CANDIDATES.find((candidate) => candidate.includes("/") && existsSync(candidate))
    ?? "sqlite3";
}

// Driver-first SQLite access. The packaged server vendors better-sqlite3 (the
// bundle externalizes it and ships a matching prebuild) and the workspace
// resolves it directly; the sqlite3 CLI is only a fallback. The CLI's `-json`
// output mode escapes strings in time quadratic in value length — a single
// multi-MB app_kv row (a desktop tab that cached a large response body) once
// pinned the child at 100% CPU for 14+ minutes per read.
interface SqliteDriverDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
type SqliteDriverCtor = new (
  path: string,
  opts: { readonly: boolean; fileMustExist: boolean },
) => SqliteDriverDb;

let cachedDriver: SqliteDriverCtor | null | undefined;
function sqliteDriver(): SqliteDriverCtor | null {
  if (cachedDriver !== undefined) return cachedDriver;
  try {
    cachedDriver = createRequire(import.meta.url)("better-sqlite3") as SqliteDriverCtor;
  } catch {
    cachedDriver = null;
  }
  return cachedDriver;
}

// SQL string literal for the CLI fallback, where parameters can't be bound.
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function defaultPenguinRoot(): string {
  const home = homedir();
  const next = join(home, ".penguin");
  const legacy = join(home, ".pengvi");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

export function penguinDbPath(root = defaultPenguinRoot()): string {
  return join(root, "penguin.sqlite3");
}

function sqliteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSqliteRows(
  dbPath: string,
  sql: string,
  params: string[] = [],
  cliTimeoutMs = SQLITE_CLI_TIMEOUT_MS,
): Record<string, unknown>[] {
  if (!existsSync(dbPath)) return [];

  const Driver = sqliteDriver();
  if (Driver) {
    let db: SqliteDriverDb | undefined;
    try {
      db = new Driver(dbPath, { readonly: true, fileMustExist: true });
      return db
        .prepare(sql)
        .all(...params)
        .filter((item): item is Record<string, unknown> => isRecord(item));
    } catch (error) {
      throw new Error(`SQLite read failed for ${dbPath}: ${sqliteErrorMessage(error)}`);
    } finally {
      db?.close();
    }
  }

  // CLI fallback: inline parameters positionally and enforce a hard timeout
  // so a slow child kills itself instead of the server. Split-and-join, NOT
  // sequential String.replace: a parameter VALUE containing "?" would swallow
  // the next placeholder, and replace() would expand $-patterns in values.
  const sqlParts = sql.split("?");
  if (sqlParts.length - 1 !== params.length) {
    throw new Error(
      `SQLite read failed for ${dbPath}: placeholder/parameter count mismatch (${sqlParts.length - 1} vs ${params.length})`,
    );
  }
  const inlined = sqlParts
    .map((part, i) => (i === 0 ? part : sqlQuote(params[i - 1]) + part))
    .join("");
  try {
    const raw = execFileSync(sqliteBinary(), ["-json", dbPath, inlined], {
      encoding: "utf8",
      maxBuffer: SQLITE_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: cliTimeoutMs,
      killSignal: "SIGKILL",
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
  } catch (error) {
    throw new Error(`SQLite read failed for ${dbPath}: ${sqliteErrorMessage(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asMetadata(value: unknown): MetadataEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      key: asString(item.key),
      value: asString(item.value),
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
    }))
    .filter((item) => item.key.trim().length > 0);
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit as number)));
}

function parseJsonArray(raw: string | null | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
  } catch {
    return [];
  }
}

function requestBodyText(entry: Record<string, unknown>): string {
  const value = entry.requestBody;
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function parseDefaultHeadersValue(
  raw: string | null | undefined,
  protocol?: DesktopProtocol,
): Partial<Record<DesktopProtocol, MetadataEntry[]>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: Partial<Record<DesktopProtocol, MetadataEntry[]>> = {};
    if (protocol) {
      out[protocol] = asMetadata(parsed[protocol]);
      return out;
    }
    for (const p of ["grpc-web", "grpc", "sdk", "rest"] as DesktopProtocol[]) {
      if (Object.prototype.hasOwnProperty.call(parsed, p)) {
        out[p] = asMetadata(parsed[p]);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function summarizeStoredRequest(entry: Record<string, unknown>): StoredRequestSummary {
  const body = requestBodyText(entry);
  const truncated = body.length > REQUEST_BODY_LIMIT;
  const summary: StoredRequestSummary = {
    id: asString(entry.id),
    protocol: asString(entry.protocol),
    methodFullName: asString(entry.methodFullName),
    serviceName: asString(entry.serviceName),
    packageName: asString(entry.packageName),
    url: asString(entry.url),
    metadata: asMetadata(entry.metadata),
    requestBody: truncated ? body.slice(0, REQUEST_BODY_LIMIT) : body,
    requestBodyTruncated: truncated,
  };

  const name = asString(entry.name);
  if (name) summary.name = name;
  const timestamp = asOptionalNumber(entry.timestamp);
  if (timestamp !== undefined) summary.timestamp = timestamp;
  const savedAt = asOptionalNumber(entry.savedAt);
  if (savedAt !== undefined) summary.savedAt = savedAt;
  const restMethod = asString(entry.restMethod);
  if (restMethod) summary.restMethod = restMethod;
  const restBodyMode = asString(entry.restBodyMode);
  if (restBodyMode) summary.restBodyMode = restBodyMode;

  return summary;
}

function matchesQuery(entry: Record<string, unknown>, query: string | undefined): boolean {
  if (!query?.trim()) return true;
  const q = query.trim().toLowerCase();
  const haystack = [
    entry.id,
    entry.name,
    entry.protocol,
    entry.methodFullName,
    entry.serviceName,
    entry.packageName,
    entry.url,
    entry.requestBody,
  ]
    .map((value) => asString(value).toLowerCase())
    .join("\n");
  return haystack.includes(q);
}

export function filterStoredRequests(
  entries: Record<string, unknown>[],
  options: {
    protocol?: DesktopProtocol;
    query?: string;
    limit?: number;
  } = {},
): StoredRequestSummary[] {
  const limit = clampLimit(options.limit);
  return entries
    .filter((entry) => !options.protocol || entry.protocol === options.protocol)
    .filter((entry) => matchesQuery(entry, options.query))
    .slice(0, limit)
    .map((entry) => summarizeStoredRequest(entry));
}

// Values are read ONLY for explicitly named keys — never the whole table.
// app_kv rows can reach several MB (tab state, registry caches), and pulling
// every value to answer a single-key question is what made desktop-state
// reads pathologically slow.
export function readAppValues(
  dbPath = penguinDbPath(),
  keys: readonly string[],
  cliTimeoutMs?: number,
): Record<string, string> {
  const wanted = keys.filter((key) => key && !isSensitiveAppValueKey(key));
  if (wanted.length === 0) return {};
  const placeholders = wanted.map(() => "?").join(", ");
  const rows = readSqliteRows(
    dbPath,
    `SELECT key, value FROM app_kv WHERE key IN (${placeholders})`,
    [...wanted],
    cliTimeoutMs,
  );
  const values: Record<string, string> = {};
  for (const row of rows) {
    const key = asString(row.key);
    const value = asString(row.value);
    if (key && !isSensitiveAppValueKey(key)) values[key] = value;
  }
  return values;
}

/** Key names only — values are never loaded, so giant rows cost nothing. */
export function listAppValueKeys(dbPath = penguinDbPath()): string[] {
  return readSqliteRows(dbPath, "SELECT key FROM app_kv")
    .map((row) => asString(row.key))
    .filter((key) => key && !isSensitiveAppValueKey(key));
}

export function readDefaultHeaders(options: {
  dbPath?: string;
  protocol?: DesktopProtocol;
} = {}): Partial<Record<DesktopProtocol, MetadataEntry[]>> {
  const values = readAppValues(options.dbPath, [APP_VALUE_KEYS.defaultHeaders]);
  return parseDefaultHeadersValue(values[APP_VALUE_KEYS.defaultHeaders], options.protocol);
}

// v1.9+ desktop versions keep history as rows in request_history (full
// response archived per row); older versions used a single app_kv blob.
function readHistoryEntries(dbPath: string): Record<string, unknown>[] {
  try {
    const rows = readSqliteRows(
      dbPath,
      "SELECT entry_json FROM request_history ORDER BY timestamp DESC LIMIT 500",
    );
    const entries = rows
      .map((row) => asString(row.entry_json))
      .flatMap((raw) => parseJsonArray(`[${raw}]`));
    if (entries.length > 0) return entries;
  } catch {
    // Table missing (pre-v1.9 desktop) — fall through to the legacy blob.
  }
  // Legacy pre-v1.9 blob: the whole history is ONE app_kv value that can run
  // to several MB. Through the CLI fallback that's the known quadratic-escape
  // hot spot, so give this specific read a longer leash than the 10s default —
  // slow-but-finishes beats a hard SIGKILL for a migration-era read.
  const values = readAppValues(dbPath, [APP_VALUE_KEYS.history], 30_000);
  return parseJsonArray(values[APP_VALUE_KEYS.history]);
}

export function readRequestHistory(options: {
  dbPath?: string;
  protocol?: DesktopProtocol;
  query?: string;
  limit?: number;
} = {}): StoredRequestSummary[] {
  const entries = readHistoryEntries(options.dbPath ?? penguinDbPath());
  return filterStoredRequests(entries, options);
}

export function readSavedRequests(options: {
  dbPath?: string;
  protocol?: DesktopProtocol;
  query?: string;
  limit?: number;
} = {}): StoredRequestSummary[] {
  const dbPath = options.dbPath ?? penguinDbPath();
  const rows = readSqliteRows(
    dbPath,
    "SELECT entry_json FROM saved_requests ORDER BY saved_at DESC LIMIT 500",
  );
  const entries = rows
    .map((row) => asString(row.entry_json))
    .flatMap((raw) => parseJsonArray(`[${raw}]`));
  return filterStoredRequests(entries, options);
}

export function desktopStateStatus(dbPath = penguinDbPath()): {
  dbPath: string;
  exists: boolean;
  ok: boolean;
  error?: string;
  appValueKeys: string[];
  historyCount: number;
  savedRequestCount: number;
  sqliteBinary: string;
} {
  const base = {
    dbPath,
    exists: existsSync(dbPath),
    sqliteBinary: sqliteBinary(),
  };

  try {
    const appValueKeys = listAppValueKeys(dbPath).sort();
    const savedRows = readSqliteRows(dbPath, "SELECT COUNT(*) AS count FROM saved_requests");
    const count = savedRows[0]?.count;
    let historyCount = 0;
    try {
      const historyRows = readSqliteRows(dbPath, "SELECT COUNT(*) AS count FROM request_history");
      const tableCount = historyRows[0]?.count;
      if (typeof tableCount === "number") historyCount = tableCount;
    } catch {
      // Table missing (pre-v1.9 desktop) — fall back to the legacy blob.
    }
    if (historyCount === 0 && appValueKeys.includes(APP_VALUE_KEYS.history)) {
      const values = readAppValues(dbPath, [APP_VALUE_KEYS.history]);
      historyCount = parseJsonArray(values[APP_VALUE_KEYS.history]).length;
    }
    return {
      ...base,
      ok: true,
      appValueKeys,
      historyCount,
      savedRequestCount: typeof count === "number" ? count : 0,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: sqliteErrorMessage(error),
      appValueKeys: [],
      historyCount: 0,
      savedRequestCount: 0,
    };
  }
}
