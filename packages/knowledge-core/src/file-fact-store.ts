import { sha256Hex, canonicalJson } from "./canonical.js";
import type { KnowledgeStore } from "./store.js";

export interface FileFactSymbol {
  identityKey: string;
  title: string;
  kind: string;
  signature?: string;
  startLine?: number;
  endLine?: number;
  contentHash: string;
}

export interface ParsedImportFact {
  specifier: string;
  importedNames: string[];
  kind: "static" | "dynamic" | "type_only";
}

export interface ParsedReferenceFact {
  rawTarget: string;
  edgeType: string;
  sourceIdentityKey?: string;
  line?: number;
}

export interface ParsedEndpointFact {
  endpointKey: string;
  protocol: string;
  service?: string;
  method?: string;
  route?: string;
  sourceIdentityKey?: string;
}

export interface ParsedLogSiteFact {
  level?: string;
  template: string;
  sourceIdentityKey?: string;
  line?: number;
}

export interface ParsedFileFact {
  repoId: string;
  filePath: string;
  contentHash: string;
  language: string;
  parserVersion: string;
  exportsHash: string;
  symbols: FileFactSymbol[];
  imports: ParsedImportFact[];
  unresolvedReferences: ParsedReferenceFact[];
  endpoints: ParsedEndpointFact[];
  logSites: ParsedLogSiteFact[];
}

export type SnapshotOverlayEntry =
  | { op: "add" | "modify"; path: string; fileFactId: string; renamedFrom?: string }
  | { op: "delete"; path: string; fileFactId: null };

export interface SnapshotRenameEvent {
  snapshotId: string;
  fromPath: string;
  toPath: string;
  fileFactId: string;
  contentHash: string;
}

type SnapshotRow = { id: string; base_snapshot_id: string | null; state: string };

export function fileFactId(fact: Pick<ParsedFileFact, "repoId" | "filePath" | "contentHash" | "language" | "parserVersion">): string {
  return `filefact_${sha256Hex(canonicalJson([fact.repoId, fact.filePath, fact.contentHash, fact.language, fact.parserVersion]))}`;
}

export class FileFactStore {
  constructor(private readonly store: KnowledgeStore) {}

  upsertFileFact(fact: ParsedFileFact): string {
    const id = fileFactId(fact);
    const now = new Date().toISOString();
    const insert = this.store.db.prepare(`
      INSERT INTO file_facts (id, repo_id, file_path, content_hash, language, parser_version, facts_json, exports_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, file_path, content_hash, language, parser_version) DO UPDATE SET
        facts_json=excluded.facts_json, exports_hash=excluded.exports_hash
    `);
    const symbols = this.store.db.prepare(`
      INSERT INTO file_fact_symbols (file_fact_id, identity_key, title, kind, signature, start_line, end_line, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_fact_id, identity_key) DO UPDATE SET
        title=excluded.title, kind=excluded.kind, signature=excluded.signature,
        start_line=excluded.start_line, end_line=excluded.end_line, content_hash=excluded.content_hash
    `);
    const tx = this.store.db.transaction(() => {
      insert.run(id, fact.repoId, fact.filePath, fact.contentHash, fact.language, fact.parserVersion,
        JSON.stringify(fact), fact.exportsHash, now);
      for (const symbol of fact.symbols) {
        symbols.run(id, symbol.identityKey, symbol.title, symbol.kind, symbol.signature ?? null,
          symbol.startLine ?? null, symbol.endLine ?? null, symbol.contentHash);
      }
    });
    tx();
    return id;
  }

  replaceOverlay(snapshotId: string, entries: SnapshotOverlayEntry[]): void {
    const snapshot = this.snapshot(snapshotId);
    if (snapshot.state !== "building") throw new Error(`snapshot ${snapshotId} must be building`);
    const factExists = this.store.db.prepare("SELECT 1 FROM file_facts WHERE id=?");
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM snapshot_overlays WHERE snapshot_id=?").run(snapshotId);
      const insert = this.store.db.prepare(
        "INSERT INTO snapshot_overlays (snapshot_id,file_path,operation,file_fact_id,renamed_from) VALUES (?,?,?,?,?)",
      );
      for (const entry of entries) {
        if (entry.op !== "delete" && !factExists.get(entry.fileFactId)) throw new Error(`file fact not found: ${entry.fileFactId}`);
        insert.run(snapshotId, entry.path, entry.op, entry.fileFactId, entry.op === "delete" ? null : entry.renamedFrom ?? null);
      }
      this.store.db.prepare("DELETE FROM effective_snapshot_files WHERE snapshot_id=?").run(snapshotId);
    });
    tx();
  }

  replaceRenameEvents(snapshotId: string, events: SnapshotRenameEvent[]): void {
    const snapshot = this.snapshot(snapshotId);
    if (snapshot.state !== "building") throw new Error(`snapshot ${snapshotId} must be building`);
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM snapshot_rename_events WHERE snapshot_id=?").run(snapshotId);
      const insert = this.store.db.prepare(
        "INSERT INTO snapshot_rename_events (snapshot_id,from_path,to_path,file_fact_id,content_hash) VALUES (?,?,?,?,?)",
      );
      for (const event of events) insert.run(event.snapshotId, event.fromPath, event.toPath, event.fileFactId, event.contentHash);
    });
    tx();
  }

  effectiveManifest(snapshotId: string): Map<string, string> {
    const result = new Map<string, string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`snapshot base cycle detected at ${id}`);
      visiting.add(id);
      const snapshot = this.snapshot(id);
      if (snapshot.base_snapshot_id) visit(snapshot.base_snapshot_id);
      const rows = this.store.db.prepare(
        "SELECT file_path, operation, file_fact_id FROM snapshot_overlays WHERE snapshot_id=? ORDER BY file_path",
      ).all(id) as Array<{ file_path: string; operation: "add" | "modify" | "delete"; file_fact_id: string | null }>;
      for (const row of rows) {
        if (row.operation === "delete") result.delete(row.file_path);
        else if (row.file_fact_id) result.set(row.file_path, row.file_fact_id);
      }
      visiting.delete(id);
    };
    visit(snapshotId);
    return result;
  }

  materializeManifest(snapshotId: string): number {
    const manifest = this.effectiveManifest(snapshotId);
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM effective_snapshot_files WHERE snapshot_id=?").run(snapshotId);
      const insert = this.store.db.prepare("INSERT INTO effective_snapshot_files (snapshot_id,file_path,file_fact_id) VALUES (?,?,?)");
      for (const [path, factId] of manifest) insert.run(snapshotId, path, factId);
    });
    tx();
    return manifest.size;
  }

  assertManifestMatches(snapshotId: string, expected: Map<string, string>): void {
    const actual = this.effectiveManifest(snapshotId);
    if (actual.size !== expected.size) throw new Error(`snapshot ${snapshotId} manifest mismatch: expected ${expected.size} files, got ${actual.size}`);
    for (const [path, factId] of expected) {
      if (actual.get(path) !== factId) throw new Error(`snapshot ${snapshotId} manifest mismatch at ${path}`);
    }
  }

  private snapshot(snapshotId: string): SnapshotRow {
    const row = this.store.db.prepare("SELECT id, base_snapshot_id, state FROM revision_snapshots WHERE id=? OR snapshot_key=?").get(snapshotId, snapshotId) as SnapshotRow | undefined;
    if (!row) throw new Error(`snapshot not found: ${snapshotId}`);
    return row;
  }
}
