import type { KnowledgeStore } from "./store.js";

export type SourceSnapshotOverlayEntry =
  | { op: "add" | "modify"; path: string; sourceFactId: string; renamedFrom?: string }
  | { op: "delete"; path: string; sourceFactId: null };

type SnapshotRow = { id: string; base_snapshot_id: string | null; state: string };

/** Revision-aware source mapping. Blobs and source facts are immutable-ish;
 * snapshots only own small path-to-fact overlays and materialized read views. */
export class SourceSnapshotStore {
  constructor(private readonly store: KnowledgeStore) {}

  replaceOverlay(snapshotId: string, entries: SourceSnapshotOverlayEntry[]): void {
    const snapshot = this.snapshot(snapshotId);
    if (snapshot.state !== "building") throw new Error(`snapshot ${snapshotId} must be building`);
    const factExists = this.store.db.prepare("SELECT 1 FROM source_facts WHERE id=?");
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM source_snapshot_overlays WHERE snapshot_id=?").run(snapshotId);
      const insert = this.store.db.prepare(
        "INSERT INTO source_snapshot_overlays(snapshot_id,file_path,operation,source_fact_id,renamed_from) VALUES (?,?,?,?,?)",
      );
      for (const entry of entries) {
        if (entry.op !== "delete" && !factExists.get(entry.sourceFactId)) {
          throw new Error(`source fact not found: ${entry.sourceFactId}`);
        }
        insert.run(snapshotId, entry.path, entry.op, entry.op === "delete" ? null : entry.sourceFactId,
          entry.op === "delete" ? null : entry.renamedFrom ?? null);
      }
      this.store.db.prepare("DELETE FROM effective_snapshot_sources WHERE snapshot_id=?").run(snapshotId);
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
        "SELECT file_path, operation, source_fact_id FROM source_snapshot_overlays WHERE snapshot_id=? ORDER BY file_path",
      ).all(id) as Array<{ file_path: string; operation: "add" | "modify" | "delete"; source_fact_id: string | null }>;
      for (const row of rows) {
        if (row.operation === "delete") result.delete(row.file_path);
        else if (row.source_fact_id) result.set(row.file_path, row.source_fact_id);
      }
      visiting.delete(id);
    };
    visit(snapshotId);
    return result;
  }

  materializeManifest(snapshotId: string): number {
    const manifest = this.effectiveManifest(snapshotId);
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM effective_snapshot_sources WHERE snapshot_id=?").run(snapshotId);
      const insert = this.store.db.prepare(
        "INSERT INTO effective_snapshot_sources(snapshot_id,file_path,source_fact_id,source_blob_id) SELECT ?,?,?,source_blob_id FROM source_facts WHERE id=?",
      );
      for (const [path, factId] of manifest) insert.run(snapshotId, path, factId, factId);
    });
    tx();
    return manifest.size;
  }

  assertManifestMatches(snapshotId: string, expected: Map<string, string>): void {
    const actual = this.effectiveManifest(snapshotId);
    if (actual.size !== expected.size) throw new Error(`source snapshot ${snapshotId} manifest mismatch`);
    for (const [path, factId] of expected) {
      if (actual.get(path) !== factId) throw new Error(`source snapshot ${snapshotId} mismatch at ${path}`);
    }
  }

  private snapshot(snapshotId: string): SnapshotRow {
    const row = this.store.db.prepare(
      "SELECT id, base_snapshot_id, state FROM revision_snapshots WHERE id=? OR snapshot_key=?",
    ).get(snapshotId, snapshotId) as SnapshotRow | undefined;
    if (!row) throw new Error(`snapshot not found: ${snapshotId}`);
    return row;
  }
}
