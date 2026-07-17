import type { KnowledgeStore } from "./store.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

export interface VectorHit { chunkId: string; modelHash: string; similarity: number; vecRowId: number; snapshotId?: string; filePath?: string; }
export interface VectorDoctorResult { ok: boolean; backend: "sqlite-fallback" | "sqlite-vec"; degraded: boolean; modelHash: string; dimensions?: number; reason?: string; }

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** Local vector persistence with an explicit SQLite fallback. */
export class VectorStore {
  constructor(private readonly store: KnowledgeStore) {}
  ensureModel(provider: EmbeddingProvider): void {
    if (!provider.modelHash || !/^[a-f0-9]{8,128}$/i.test(provider.modelHash)) throw new Error("SEMANTIC_MODEL_HASH_INVALID");
    if (!Number.isInteger(provider.dimensions) || provider.dimensions <= 0) throw new Error("SEMANTIC_DIMENSIONS_INVALID");
    const tableName = `vec_${provider.modelHash.slice(0, 16).toLowerCase()}`;
    this.store.db.prepare("INSERT INTO embedding_models(model_hash,provider_id,model_id,dimensions,vec_table_name,installed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(model_hash) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,dimensions=excluded.dimensions,vec_table_name=excluded.vec_table_name")
      .run(provider.modelHash, provider.id, provider.modelId, provider.dimensions, tableName, new Date().toISOString());
  }
  put(modelHash: string, chunkId: string, vector: Float32Array): number {
    const model = this.store.db.prepare("SELECT dimensions FROM embedding_models WHERE model_hash=?").get(modelHash) as { dimensions: number } | undefined;
    if (!model) throw new Error("SEMANTIC_MODEL_NOT_REGISTERED");
    if (model.dimensions !== vector.length) throw new Error("SEMANTIC_DIMENSIONS_MISMATCH");
    const tx = this.store.db.transaction(() => {
      const old = this.store.db.prepare("SELECT vec_rowid FROM semantic_embedding_refs WHERE model_hash=? AND chunk_id=?").get(modelHash, chunkId) as { vec_rowid: number } | undefined;
      if (old) this.store.db.prepare("DELETE FROM semantic_vector_values WHERE vec_rowid=?").run(old.vec_rowid);
      const row = this.store.db.prepare("INSERT INTO semantic_vector_values(model_hash,dimensions,vector_json,created_at) VALUES (?,?,?,?)").run(modelHash, vector.length, JSON.stringify([...vector]), new Date().toISOString());
      const vecRowId = Number(row.lastInsertRowid);
      this.store.db.prepare("INSERT INTO semantic_embedding_refs(model_hash,chunk_id,vec_rowid,status,error,embedded_at) VALUES (?,?,?,?,?,?) ON CONFLICT(model_hash,chunk_id) DO UPDATE SET vec_rowid=excluded.vec_rowid,status=excluded.status,error=NULL,embedded_at=excluded.embedded_at").run(modelHash, chunkId, vecRowId, "ready", null, new Date().toISOString());
      return vecRowId;
    });
    return tx() as number;
  }
  search(modelHash: string, query: Float32Array, limit = 50, options: { snapshotIds?: string[] } = {}): VectorHit[] {
    const params: unknown[] = [modelHash];
    let sql = `SELECT r.chunk_id AS chunkId,r.model_hash AS modelHash,r.vec_rowid AS vecRowId,v.vector_json AS vectorJson,e.snapshot_id AS snapshotId,e.file_path AS filePath
      FROM semantic_embedding_refs r JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
      LEFT JOIN semantic_chunks c ON c.id=r.chunk_id
      LEFT JOIN effective_snapshot_sources e ON e.source_blob_id=c.source_blob_id
      WHERE r.model_hash=? AND r.status='ready'`;
    if (options.snapshotIds?.length) { sql += ` AND e.snapshot_id IN (${options.snapshotIds.map(() => "?").join(",")})`; params.push(...options.snapshotIds); }
    const rows = this.store.db.prepare(sql).all(...params) as Array<{ chunkId: string; modelHash: string; vecRowId: number; vectorJson: string; snapshotId?: string; filePath?: string }>;
    return rows.map((row) => ({ chunkId: row.chunkId, modelHash: row.modelHash, vecRowId: row.vecRowId, similarity: cosine(query, Float32Array.from(JSON.parse(row.vectorJson) as number[])), ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}), ...(row.filePath ? { filePath: row.filePath } : {}) })).sort((a, b) => b.similarity - a.similarity || a.chunkId.localeCompare(b.chunkId) || (a.snapshotId ?? "").localeCompare(b.snapshotId ?? "")).slice(0, Math.max(0, limit));
  }
  health(modelHash: string): { ok: boolean; reason?: string; dimensions?: number; backend: "sqlite-fallback" } {
    const row = this.store.db.prepare("SELECT dimensions FROM embedding_models WHERE model_hash=?").get(modelHash) as { dimensions: number } | undefined;
    return row ? { ok: true, dimensions: row.dimensions, backend: "sqlite-fallback" } : { ok: false, reason: "model not registered", backend: "sqlite-fallback" };
  }
  /**
   * Release/doctor gate for the optional local vector backend. The portable
   * SQLite implementation is deliberately observable as degraded; a release
   * that declares semantic retrieval required must reject it explicitly.
   */
  doctor(modelHash: string, options: { semanticRequired?: boolean } = {}): VectorDoctorResult {
    const health = this.health(modelHash);
    if (!health.ok) return { ok: false, backend: health.backend, degraded: true, modelHash, reason: health.reason };
    if (options.semanticRequired) throw new Error("SEMANTIC_EXTENSION_REQUIRED");
    return { ok: true, backend: health.backend, degraded: true, modelHash, dimensions: health.dimensions, reason: "sqlite-vec extension unavailable; using deterministic SQLite fallback" };
  }
}
