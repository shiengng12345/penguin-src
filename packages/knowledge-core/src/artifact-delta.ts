import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore } from "./store.js";

type SqlValue = null | number | string | Uint8Array;
type EncodedValue = null | number | string | { __blob: string };
export interface LogicalDeltaOperation {
  table: string;
  keyColumns: string[];
  key: EncodedValue[];
  kind: "upsert" | "delete";
  row?: Record<string, EncodedValue>;
}
export interface LogicalDelta {
  algorithm: "logical-row-v1";
  baseDatabaseHash: string;
  operations: LogicalDeltaOperation[];
  tableCount: number;
  createTables: Array<{ name: string; sql: string }>;
}

function encode(value: SqlValue): EncodedValue {
  return value instanceof Uint8Array ? { __blob: Buffer.from(value).toString("base64") } : value;
}
function decode(value: EncodedValue): SqlValue {
  return value && typeof value === "object" && "__blob" in value ? new Uint8Array(Buffer.from(value.__blob, "base64")) : value;
}
function stable(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify({ __blob: Buffer.from(value).toString("base64") });
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function tableRows(db: any, table: string, keyColumns: string[]): Array<Record<string, SqlValue>> {
  const select = keyColumns.length === 1 && keyColumns[0] === "rowid" ? "rowid, *" : "*";
  return db.prepare(`SELECT ${select} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, SqlValue>>;
}

/** Compute row-level changes for ordinary SQLite tables. Virtual FTS tables
 * are intentionally excluded: their source tables are included and SQLite
 * rebuilds the derived index on import/open. */
export function buildLogicalDelta(baseBytes: Uint8Array, currentDb: any): LogicalDelta {
  const dir = mkdtempSync(join(tmpdir(), "penguin-logical-delta-"));
  const path = join(dir, "base.sqlite");
  writeFileSync(path, Buffer.from(baseBytes), { flag: "wx", mode: 0o600 });
  const base = new currentDb.constructor(path);
  const operations: LogicalDeltaOperation[] = [];
  const createTables: Array<{ name: string; sql: string }> = [];
  let tableCount = 0;
  try {
    const tables = currentDb.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").all() as Array<{ name: string; sql: string }>;
    for (const { name: table } of tables) {
      const columns = currentDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>;
      if (!columns.length) continue;
      const keyColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      const keys = keyColumns.length ? keyColumns : ["rowid"];
      const afterRows = tableRows(currentDb, table, keys);
      let beforeRows: Array<Record<string, SqlValue>> = [];
      try { beforeRows = tableRows(base, table, keys); } catch { /* table was added in target */ }
      if (!base.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        const sql = currentDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
        if (sql?.sql) createTables.push({ name: table, sql: sql.sql });
      }
      const before = new Map(beforeRows.map((row) => [stable(keys.map((key) => row[key])), row]));
      const after = new Map(afterRows.map((row) => [stable(keys.map((key) => row[key])), row]));
      for (const [keyHash, row] of before) if (!after.has(keyHash)) operations.push({ table, keyColumns: keys, key: keys.map((column) => encode(row[column])), kind: "delete" });
      for (const [keyHash, row] of after) {
        const old = before.get(keyHash);
        if (old && stable(old) === stable(row)) continue;
        const encoded: Record<string, EncodedValue> = {};
        for (const column of columns) encoded[column.name] = encode(row[column.name]);
        if (keys[0] === "rowid") encoded.rowid = encode(row.rowid);
        operations.push({ table, keyColumns: keys, key: keys.map((column) => encode(row[column])), kind: "upsert", row: encoded });
      }
      tableCount += 1;
    }
  } finally {
    base.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { algorithm: "logical-row-v1", baseDatabaseHash: createHash("sha256").update(baseBytes).digest("hex"), operations, tableCount, createTables };
}

/** Apply a logical delta to a verified base and serialize the resulting DB. */
export function applyLogicalDelta(baseBytes: Uint8Array, delta: LogicalDelta): Uint8Array {
  const actual = createHash("sha256").update(baseBytes).digest("hex");
  if (actual !== delta.baseDatabaseHash) throw new Error("ARTIFACT_BASE_MISMATCH");
  const dir = mkdtempSync(join(tmpdir(), "penguin-logical-restore-"));
  const path = join(dir, "knowledge.sqlite");
  const ledgerPath = join(dir, "ledger.jsonl");
  writeFileSync(path, Buffer.from(baseBytes), { flag: "wx", mode: 0o600 });
  const store = KnowledgeStore.open({ dbPath: path, ledgerPath });
  try {
    store.db.pragma("foreign_keys = OFF");
    const tx = store.db.transaction(() => {
      for (const table of delta.createTables ?? []) {
        if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name)) store.db.exec(table.sql);
      }
      for (const operation of delta.operations) {
        const table = quoteIdentifier(operation.table);
        const predicates = operation.keyColumns.map((column) => `${quoteIdentifier(column)}=?`).join(" AND ");
        if (operation.kind === "delete") {
          store.db.prepare(`DELETE FROM ${table} WHERE ${predicates}`).run(...operation.key.map(decode));
          continue;
        }
        const row = operation.row ?? {};
        const columns = Object.keys(row);
        const values = columns.map((column) => decode(row[column]));
        const placeholders = columns.map(() => "?").join(",");
        const keyColumns = operation.keyColumns.filter((column) => column !== "rowid");
        const conflict = keyColumns.length ? ` ON CONFLICT (${keyColumns.map(quoteIdentifier).join(",")}) DO UPDATE SET ${columns.filter((column) => !keyColumns.includes(column)).map((column) => `${quoteIdentifier(column)}=excluded.${quoteIdentifier(column)}`).join(",")}` : "";
        if (operation.keyColumns[0] === "rowid") {
          store.db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.map(quoteIdentifier).join(",")}) VALUES (${placeholders})`).run(...values);
        } else {
          store.db.prepare(`INSERT INTO ${table} (${columns.map(quoteIdentifier).join(",")}) VALUES (${placeholders})${conflict}`).run(...values);
        }
      }
    });
    tx();
    return new Uint8Array(store.db.serialize());
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
