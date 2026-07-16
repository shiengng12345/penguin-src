import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

export interface ResolvedEdgeFact {
  srcIdentityKey: string;
  dstIdentityKey?: string;
  rawTarget?: string;
  edgeType: string;
  method: string;
  confidence: number;
  provenance: Record<string, unknown>;
}
export interface ResolutionSetRecord { id: string; fileFactId: string; contextFingerprint: string; resolverVersion: string }

export class ResolutionStore {
  constructor(private readonly store: KnowledgeStore) {}
  findReusableSet(input: { fileFactId: string; contextFingerprint: string; resolverVersion: string }): ResolutionSetRecord | null {
    const row = this.store.db.prepare("SELECT id, file_fact_id, context_fingerprint, resolver_version FROM resolution_sets WHERE file_fact_id=? AND context_fingerprint=? AND resolver_version=?").get(input.fileFactId, input.contextFingerprint, input.resolverVersion) as { id: string; file_fact_id: string; context_fingerprint: string; resolver_version: string } | undefined;
    return row ? { id: row.id, fileFactId: row.file_fact_id, contextFingerprint: row.context_fingerprint, resolverVersion: row.resolver_version } : null;
  }
  replaceResolutionSet(input: { fileFactId: string; contextFingerprint: string; resolverVersion: string; edges: ResolvedEdgeFact[] }): ResolutionSetRecord {
    const existing = this.findReusableSet(input); const id = existing?.id ?? `resolution_${randomUUID()}`;
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO resolution_sets (id,file_fact_id,context_fingerprint,resolver_version,created_at) VALUES (?,?,?,?,?) ON CONFLICT(file_fact_id,context_fingerprint,resolver_version) DO UPDATE SET created_at=excluded.created_at").run(id, input.fileFactId, input.contextFingerprint, input.resolverVersion, new Date().toISOString());
      this.store.db.prepare("DELETE FROM resolved_edges WHERE resolution_set_id=?").run(id);
      const insert = this.store.db.prepare("INSERT INTO resolved_edges (id,resolution_set_id,src_identity_key,dst_identity_key,raw_target,edge_type,method,confidence,provenance) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const edge of input.edges) insert.run(`resolved_edge_${randomUUID()}`, id, edge.srcIdentityKey, edge.dstIdentityKey ?? null, edge.rawTarget ?? null, edge.edgeType, edge.method, edge.confidence, JSON.stringify(edge.provenance));
    }); tx();
    return { id, fileFactId: input.fileFactId, contextFingerprint: input.contextFingerprint, resolverVersion: input.resolverVersion };
  }
  attachSnapshotResolution(input: { snapshotId: string; filePath: string; resolutionSetId: string }): void {
    this.store.db.prepare("INSERT INTO snapshot_resolution_refs (snapshot_id,file_path,resolution_set_id) VALUES (?,?,?) ON CONFLICT(snapshot_id,file_path) DO UPDATE SET resolution_set_id=excluded.resolution_set_id").run(input.snapshotId, input.filePath, input.resolutionSetId);
  }
  replaceGlobalProducerEdges(producerKey: string, edges: ResolvedEdgeFact[]): void {
    const tx = this.store.db.transaction(() => { this.store.db.prepare("DELETE FROM global_resolved_edges WHERE producer_key=?").run(producerKey); const insert = this.store.db.prepare("INSERT INTO global_resolved_edges (id,producer_key,src_identity_key,dst_identity_key,raw_target,edge_type,method,confidence,provenance) VALUES (?,?,?,?,?,?,?,?,?)"); for (const edge of edges) insert.run(`global_edge_${randomUUID()}`, producerKey, edge.srcIdentityKey, edge.dstIdentityKey ?? null, edge.rawTarget ?? null, edge.edgeType, edge.method, edge.confidence, JSON.stringify(edge.provenance)); }); tx();
  }
  deleteUnreferencedResolutionSets(olderThan: Date): string[] {
    const rows = this.store.db.prepare("SELECT rs.id FROM resolution_sets rs LEFT JOIN snapshot_resolution_refs rr ON rr.resolution_set_id=rs.id WHERE rr.resolution_set_id IS NULL AND rs.created_at < ?").all(olderThan.toISOString()) as Array<{ id: string }>;
    const tx = this.store.db.transaction(() => { for (const row of rows) { this.store.db.prepare("DELETE FROM resolved_edges WHERE resolution_set_id=?").run(row.id); this.store.db.prepare("DELETE FROM resolution_sets WHERE id=?").run(row.id); } }); tx(); return rows.map((row) => row.id);
  }
}
