import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

export interface VectorHit { chunkId: string; modelHash: string; similarity: number; vecRowId: number; generationId?: string; spaceId?: string; snapshotId?: string; filePath?: string; }
export interface VectorDoctorResult { ok: boolean; backend: "sqlite-fallback" | "sqlite-vec"; degraded: boolean; modelHash: string; dimensions?: number; reason?: string; }
export interface VectorPutItem { chunkId: string; vector: Float32Array; }

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

const require = createRequire(import.meta.url);
const extensionState = new WeakMap<object, { available: boolean; reason?: string }>();
const debugFallbackEnabled = () => process.env.PENGUIN_VECTOR_DEBUG_FALLBACK === "1";

function loadVectorExtension(store: KnowledgeStore): { available: boolean; reason?: string } {
  const cached = extensionState.get(store.db);
  if (cached) return cached;
  try {
    // Optional at runtime: the deterministic JSON fallback remains valid on
    // unsupported platforms and in the dependency-free MCP bundle.
    const extension = require("sqlite-vec") as { load: (db: { loadExtension(path: string, entrypoint?: string): void }) => void };
    extension.load(store.db);
    const result = { available: true } as { available: boolean; reason?: string };
    extensionState.set(store.db, result);
    return result;
  } catch (error) {
    const result = { available: false, reason: String((error as Error).message ?? error) };
    extensionState.set(store.db, result);
    return result;
  }
}

function vectorTable(modelHash: string): string {
  return `vec_${modelHash.slice(0, 16).toLowerCase()}`;
}

/**
 * A model can have many snapshots/generations. Keeping all of them in one
 * vec0 table makes every scoped KNN query scan historical vectors before the
 * relational generation filter can run. Partition new writes by generation;
 * the hash keeps the SQLite identifier short and independent of UUID shape.
 */
function generationVectorTable(modelHash: string, generationId: string): string {
  const generationHash = createHash("sha256").update(generationId).digest("hex").slice(0, 16);
  return `${vectorTable(modelHash)}_g${generationHash}`;
}

function tableExists(store: KnowledgeStore, tableName: string): boolean {
  return store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(tableName) != null;
}

function createVectorTable(store: KnowledgeStore, tableName: string, dimensions: number): void {
  store.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(embedding float[${dimensions}])`);
}

function tableForGeneration(store: KnowledgeStore, modelHash: string, generationId: string): string {
  const partition = generationVectorTable(modelHash, generationId);
  return tableExists(store, partition) ? partition : vectorTable(modelHash);
}

function tableForRef(
  store: KnowledgeStore,
  modelHash: string,
  generationId: string | null | undefined,
  persistedTable: string | null | undefined,
): string {
  if (persistedTable && /^vec_[a-f0-9]+(?:_g[a-f0-9]+)?$/u.test(persistedTable)) return persistedTable;
  // A null table name is a legacy row. Use a generation partition only when
  // that partition actually exists; otherwise the vector still lives in the
  // pre-partition global table.
  return generationId ? tableForGeneration(store, modelHash, generationId) : vectorTable(modelHash);
}

/** Local vector persistence with an explicit SQLite fallback. */
export class VectorStore {
  constructor(private readonly store: KnowledgeStore) {}
  ensureModel(provider: EmbeddingProvider): void {
    if (!provider.modelHash || !/^[a-f0-9]{8,128}$/i.test(provider.modelHash)) throw new Error("SEMANTIC_MODEL_HASH_INVALID");
    if (!Number.isInteger(provider.dimensions) || provider.dimensions <= 0) throw new Error("SEMANTIC_DIMENSIONS_INVALID");
    const tableName = vectorTable(provider.modelHash);
    this.store.db.prepare("INSERT INTO embedding_models(model_hash,provider_id,model_id,dimensions,vec_table_name,installed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(model_hash) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,dimensions=excluded.dimensions,vec_table_name=excluded.vec_table_name")
      .run(provider.modelHash, provider.id, provider.modelId, provider.dimensions, tableName, new Date().toISOString());
    if (loadVectorExtension(this.store).available) {
      createVectorTable(this.store, tableName, provider.dimensions);
    }
  }
  /**
   * Persist one embedding batch in one transaction with prepared statements
   * reused across the batch. The old one-vector path opened a transaction and
   * resolved the model/backend for every vector, which made SQLite write
   * overhead visible once inference was accelerated.
   */
  putBatch(modelHash: string, items: VectorPutItem[], options: { generationId?: string; spaceId?: string } = {}): number[] {
    if (!items.length) return [];
    const model = this.store.db.prepare("SELECT dimensions FROM embedding_models WHERE model_hash=?").get(modelHash) as { dimensions: number } | undefined;
    if (!model) throw new Error("SEMANTIC_MODEL_NOT_REGISTERED");
    if (items.some(({ vector }) => model.dimensions !== vector.length)) throw new Error("SEMANTIC_DIMENSIONS_MISMATCH");
    if ((options.generationId && !options.spaceId) || (!options.generationId && options.spaceId)) throw new Error("SEMANTIC_GENERATION_IDENTITY_REQUIRED");
    if (options.generationId) {
      const generation = this.store.db.prepare("SELECT space_id AS spaceId,status FROM embedding_generations WHERE id=?").get(options.generationId) as { spaceId: string; status: string } | undefined;
      if (!generation || !["staging", "active"].includes(generation.status)) throw new Error("SEMANTIC_GENERATION_NOT_WRITABLE");
      if (generation.spaceId !== options.spaceId) throw new Error("SEMANTIC_SPACE_MISMATCH");
    }
    const backend = loadVectorExtension(this.store);
    if (!backend.available && !debugFallbackEnabled()) throw new Error("SQLITE_VEC_MISSING");
    const partitioned = backend.available && Boolean(options.generationId);
    const tableName = options.generationId ? generationVectorTable(modelHash, options.generationId) : vectorTable(modelHash);
    if (backend.available && options.generationId) createVectorTable(this.store, tableName, model.dimensions);
    const createdAt = new Date().toISOString();
    const tx = this.store.db.transaction(() => {
      const findOld = this.store.db.prepare(`
        SELECT r.vec_rowid AS vecRowId,r.generation_id AS generationId,v.vector_table_name AS vectorTableName
          FROM semantic_embedding_refs r
          LEFT JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
         WHERE r.model_hash=? AND r.chunk_id=?
      `);
      const deleteJson = this.store.db.prepare("DELETE FROM semantic_vector_values WHERE vec_rowid=?");
      const insertVector = backend.available ? this.store.db.prepare(`INSERT INTO ${tableName}(embedding) VALUES (?)`) : null;
      const deleteVectors = new Map<string, ReturnType<typeof this.store.db.prepare>>();
      const deleteVector = (rowId: number, generationId: string | null | undefined, persistedTable: string | null | undefined) => {
        if (!backend.available) return;
        const oldTable = tableForRef(this.store, modelHash, generationId, persistedTable);
        if (!tableExists(this.store, oldTable)) return;
        let statement = deleteVectors.get(oldTable);
        if (!statement) {
          statement = this.store.db.prepare(`DELETE FROM ${oldTable} WHERE rowid=?`);
          deleteVectors.set(oldTable, statement);
        }
        statement.run(rowId);
      };
      const insertFallback = this.store.db.prepare("INSERT INTO semantic_vector_values(model_hash,dimensions,vector_json,vector_table_name,created_at) VALUES (?,?,?,?,?)");
      const reservePartitionId = partitioned
        ? this.store.db.prepare("INSERT INTO semantic_vector_values(model_hash,dimensions,vector_json,vector_table_name,created_at) VALUES (?,?,?,?,?)")
        : null;
      const insertJson = backend.available && !partitioned
        ? this.store.db.prepare("INSERT INTO semantic_vector_values(vec_rowid,model_hash,dimensions,vector_json,vector_table_name,created_at) VALUES (?,?,?,?,?,?)")
        : null;
      const insertPartitionVector = partitioned ? this.store.db.prepare(`INSERT INTO ${tableName}(rowid,embedding) VALUES (?,?)`) : null;
      const updatePartitionJson = partitioned ? this.store.db.prepare("UPDATE semantic_vector_values SET vector_json=? WHERE vec_rowid=?") : null;
      const upsertRef = this.store.db.prepare(`
        INSERT INTO semantic_embedding_refs(model_hash,chunk_id,vec_rowid,status,error,embedded_at,generation_id,space_id)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(model_hash,chunk_id) DO UPDATE SET
          vec_rowid=excluded.vec_rowid,status=excluded.status,error=NULL,embedded_at=excluded.embedded_at,
          generation_id=COALESCE(excluded.generation_id,semantic_embedding_refs.generation_id),
          space_id=COALESCE(excluded.space_id,semantic_embedding_refs.space_id)
      `);
      return items.map(({ chunkId, vector }) => {
        const old = findOld.get(modelHash, chunkId) as { vecRowId: number; generationId: string | null; vectorTableName: string | null } | undefined;
        if (old) {
          deleteJson.run(old.vecRowId);
          deleteVector(old.vecRowId, old.generationId, old.vectorTableName);
        }
        const vectorJson = JSON.stringify([...vector]);
        let vecRowId: number;
        if (!backend.available) {
          vecRowId = Number(insertFallback.run(modelHash, vector.length, vectorJson, vectorTable(modelHash), createdAt).lastInsertRowid);
        } else if (partitioned) {
          vecRowId = Number(reservePartitionId!.run(modelHash, vector.length, "[]", tableName, createdAt).lastInsertRowid);
          // sqlite-vec accepts explicit rowids only as SQLite INTEGER values;
          // better-sqlite3 binds a JavaScript number as REAL for this virtual
          // table, so pass BigInt even though the public ref API stays numeric.
          insertPartitionVector!.run(BigInt(vecRowId), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
          updatePartitionJson!.run(vectorJson, vecRowId);
        } else {
          vecRowId = Number(insertVector!.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)).lastInsertRowid);
          insertJson!.run(vecRowId, modelHash, vector.length, vectorJson, tableName, createdAt);
        }
        upsertRef.run(modelHash, chunkId, vecRowId, "ready", null, createdAt, options.generationId ?? null, options.spaceId ?? null);
        return vecRowId;
      });
    });
    return tx() as number[];
  }
  put(modelHash: string, chunkId: string, vector: Float32Array, options: { generationId?: string; spaceId?: string } = {}): number {
    const [vecRowId] = this.putBatch(modelHash, [{ chunkId, vector }], options);
    return vecRowId;
  }
  /** Copy a verified vector into a new generation without re-embedding text. */
  copy(modelHash: string, sourceChunkId: string, targetChunkId: string, options: { generationId: string; spaceId: string }): number {
    const row = this.store.db.prepare(`
      SELECT v.vector_json AS vectorJson
        FROM semantic_embedding_refs r JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
       WHERE r.model_hash=? AND r.chunk_id=? AND r.status='ready'
    `).get(modelHash, sourceChunkId) as { vectorJson: string } | undefined;
    if (!row) throw new Error("SEMANTIC_SOURCE_VECTOR_NOT_FOUND");
    let values: number[];
    try { values = JSON.parse(row.vectorJson) as number[]; } catch { throw new Error("SEMANTIC_SOURCE_VECTOR_INVALID"); }
    if (!Array.isArray(values) || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("SEMANTIC_SOURCE_VECTOR_INVALID");
    return this.put(modelHash, targetChunkId, Float32Array.from(values), options);
  }
  delete(modelHash: string, chunkId: string): boolean {
    const tx = this.store.db.transaction(() => {
      const ref = this.store.db.prepare(`
        SELECT r.vec_rowid AS vecRowId,r.generation_id AS generationId,v.vector_table_name AS vectorTableName
          FROM semantic_embedding_refs r
          LEFT JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
         WHERE r.model_hash=? AND r.chunk_id=?
      `).get(modelHash, chunkId) as { vecRowId: number; generationId: string | null; vectorTableName: string | null } | undefined;
      if (!ref) return false;
      const backend = loadVectorExtension(this.store);
      this.store.db.prepare("DELETE FROM semantic_vector_values WHERE vec_rowid=?").run(ref.vecRowId);
      const tableName = tableForRef(this.store, modelHash, ref.generationId, ref.vectorTableName);
      if (backend.available && tableExists(this.store, tableName)) this.store.db.prepare(`DELETE FROM ${tableName} WHERE rowid=?`).run(ref.vecRowId);
      this.store.db.prepare("DELETE FROM semantic_embedding_refs WHERE model_hash=? AND chunk_id=?").run(modelHash, chunkId);
      return true;
    });
    return tx() as boolean;
  }
  garbageCollect(modelHash?: string): { refs: number; vectors: number } {
    const tx = this.store.db.transaction(() => {
      const refRows = this.store.db.prepare(`
        SELECT r.model_hash AS modelHash,r.chunk_id AS chunkId
          FROM semantic_embedding_refs r
          LEFT JOIN embedding_jobs j ON j.generation_id=r.generation_id AND j.chunk_id=r.chunk_id
         WHERE j.id IS NULL OR j.status='deleting'${modelHash ? " AND r.model_hash=?" : ""}
      `).all(...(modelHash ? [modelHash] : [])) as Array<{ modelHash: string; chunkId: string }>;
      for (const ref of refRows) this.delete(ref.modelHash, ref.chunkId);
      const orphanRows = this.store.db.prepare(`
        SELECT v.vec_rowid AS vecRowId,v.model_hash AS modelHash,v.vector_table_name AS vectorTableName
          FROM semantic_vector_values v
          LEFT JOIN semantic_embedding_refs r ON r.vec_rowid=v.vec_rowid
         WHERE r.model_hash IS NULL${modelHash ? " AND v.model_hash=?" : ""}
      `).all(...(modelHash ? [modelHash] : [])) as Array<{ vecRowId: number; modelHash: string; vectorTableName: string | null }>;
      const backend = loadVectorExtension(this.store);
      for (const row of orphanRows) {
        const tableName = tableForRef(this.store, row.modelHash, undefined, row.vectorTableName);
        if (backend.available && tableExists(this.store, tableName)) this.store.db.prepare(`DELETE FROM ${tableName} WHERE rowid=?`).run(row.vecRowId);
        this.store.db.prepare("DELETE FROM semantic_vector_values WHERE vec_rowid=?").run(row.vecRowId);
      }
      return { refs: refRows.length, vectors: orphanRows.length };
    });
    return tx() as { refs: number; vectors: number };
  }
  search(modelHash: string, query: Float32Array, limit = 50, options: { snapshotIds?: string[]; generationId?: string; activeScopeKey?: string } = {}): VectorHit[] {
    const backend = loadVectorExtension(this.store);
    if (!backend.available && !debugFallbackEnabled()) throw new Error("SQLITE_VEC_MISSING");
    const model = this.store.db.prepare("SELECT dimensions FROM embedding_models WHERE model_hash=?").get(modelHash) as { dimensions: number } | undefined;
    const generationId = options.generationId ?? (options.activeScopeKey
      ? (this.store.db.prepare("SELECT generation_id AS generationId FROM semantic_active_spaces WHERE scope_key=?").get(options.activeScopeKey) as { generationId: string } | undefined)?.generationId
      : undefined);
    // A scoped production query has no result until an entire generation is
    // atomically activated. This is the read-side half of the staging gate;
    // legacy unscoped callers remain available for compatibility tests only.
    if (options.activeScopeKey && !generationId) return [];
    if (backend.available && model) {
      const tableName = generationId ? tableForGeneration(this.store, modelHash, generationId) : vectorTable(modelHash);
      const partitioned = Boolean(generationId && tableName !== vectorTable(modelHash));
      // Force vec0 to finish its bounded top-K scan before joining relational
      // metadata. Without MATERIALIZED SQLite may choose semantic refs as the
      // outer loop and execute the virtual-table KNN scan once per ref (45k
      // times on FPMS-NT), turning a ~60ms lookup into a hard timeout.
      const params: unknown[] = [
        Buffer.from(query.buffer, query.byteOffset, query.byteLength),
        Math.max(0, limit),
        modelHash,
        ...(generationId ? [generationId] : []),
      ];
      let sql = `WITH nearest AS MATERIALIZED (
          SELECT rowid,distance FROM ${tableName}
           WHERE embedding MATCH ? AND k = ?
        )
        SELECT r.chunk_id AS chunkId,r.model_hash AS modelHash,r.vec_rowid AS vecRowId,r.generation_id AS generationId,r.space_id AS spaceId,nearest.distance AS distance,COALESCE(e.snapshot_id,c.snapshot_id) AS snapshotId,COALESCE(e.file_path,c.canonical_file_path) AS filePath
        FROM nearest JOIN semantic_embedding_refs r ON r.model_hash=? AND r.vec_rowid=nearest.rowid${partitioned ? " AND r.generation_id=?" : ""}
        LEFT JOIN semantic_chunks c ON c.id=r.chunk_id
        LEFT JOIN effective_snapshot_sources e ON e.source_blob_id=c.source_blob_id
        WHERE r.status='ready'${generationId && !partitioned ? " AND r.generation_id=?" : ""}`;
      if (options.snapshotIds?.length) { sql += ` AND COALESCE(e.snapshot_id,c.snapshot_id) IN (${options.snapshotIds.map(() => "?").join(",")})`; params.push(...options.snapshotIds); }
      sql += " ORDER BY nearest.distance ASC,r.chunk_id ASC";
      const rows = this.store.db.prepare(sql).all(...params) as Array<{ chunkId: string; modelHash: string; vecRowId: number; generationId?: string; spaceId?: string; distance: number; snapshotId?: string; filePath?: string }>;
      return rows.map((row) => ({ chunkId: row.chunkId, modelHash: row.modelHash, vecRowId: row.vecRowId, similarity: 1 - row.distance, ...(row.generationId ? { generationId: row.generationId } : {}), ...(row.spaceId ? { spaceId: row.spaceId } : {}), ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}), ...(row.filePath ? { filePath: row.filePath } : {}) }));
    }
    const params: unknown[] = [modelHash];
    let sql = `SELECT r.chunk_id AS chunkId,r.model_hash AS modelHash,r.vec_rowid AS vecRowId,r.generation_id AS generationId,r.space_id AS spaceId,v.vector_json AS vectorJson,COALESCE(e.snapshot_id,c.snapshot_id) AS snapshotId,COALESCE(e.file_path,c.canonical_file_path) AS filePath
      FROM semantic_embedding_refs r JOIN semantic_vector_values v ON v.vec_rowid=r.vec_rowid
      LEFT JOIN semantic_chunks c ON c.id=r.chunk_id
      LEFT JOIN effective_snapshot_sources e ON e.source_blob_id=c.source_blob_id
      WHERE r.model_hash=? AND r.status='ready'${generationId ? " AND r.generation_id=?" : ""}`;
    if (generationId) params.push(generationId);
    if (options.snapshotIds?.length) { sql += ` AND COALESCE(e.snapshot_id,c.snapshot_id) IN (${options.snapshotIds.map(() => "?").join(",")})`; params.push(...options.snapshotIds); }
    const rows = this.store.db.prepare(sql).all(...params) as Array<{ chunkId: string; modelHash: string; vecRowId: number; generationId?: string; spaceId?: string; vectorJson: string; snapshotId?: string; filePath?: string }>;
    return rows.map((row) => ({ chunkId: row.chunkId, modelHash: row.modelHash, vecRowId: row.vecRowId, similarity: cosine(query, Float32Array.from(JSON.parse(row.vectorJson) as number[])), ...(row.generationId ? { generationId: row.generationId } : {}), ...(row.spaceId ? { spaceId: row.spaceId } : {}), ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}), ...(row.filePath ? { filePath: row.filePath } : {}) })).sort((a, b) => b.similarity - a.similarity || a.chunkId.localeCompare(b.chunkId) || (a.snapshotId ?? "").localeCompare(b.snapshotId ?? "")).slice(0, Math.max(0, limit));
  }
  health(modelHash: string): { ok: boolean; reason?: string; dimensions?: number; backend: "sqlite-fallback" | "sqlite-vec" } {
    const row = this.store.db.prepare("SELECT dimensions FROM embedding_models WHERE model_hash=?").get(modelHash) as { dimensions: number } | undefined;
    const backend = loadVectorExtension(this.store).available ? "sqlite-vec" : "sqlite-fallback";
    return row ? { ok: backend === "sqlite-vec" || debugFallbackEnabled(), dimensions: row.dimensions, backend, ...(backend === "sqlite-fallback" ? { reason: "SQLITE_VEC_MISSING" } : {}) } : { ok: false, reason: "model not registered", backend };
  }
  /**
   * Release/doctor gate for the optional local vector backend. The portable
   * SQLite implementation is deliberately observable as degraded; a release
   * that declares semantic retrieval required must reject it explicitly.
   */
  doctor(modelHash: string, options: { semanticRequired?: boolean; sampleQuery?: Float32Array } = {}): VectorDoctorResult {
    const health = this.health(modelHash);
    if (!health.ok) return { ok: false, backend: health.backend, degraded: true, modelHash, reason: health.reason };
    if (health.backend !== "sqlite-vec" && !debugFallbackEnabled()) return { ok: false, backend: health.backend, degraded: true, modelHash, dimensions: health.dimensions, reason: "SQLITE_VEC_MISSING" };
    if (options.semanticRequired && health.backend !== "sqlite-vec") throw new Error("SEMANTIC_EXTENSION_REQUIRED");
    if (health.backend === "sqlite-vec") {
      const tableName = vectorTable(modelHash);
      try {
        this.store.db.prepare(`SELECT rowid FROM ${tableName} WHERE embedding MATCH ? AND k = ?`).all(
          Buffer.from((options.sampleQuery ?? new Float32Array(health.dimensions!)).buffer), 1,
        );
      } catch (error) {
        return { ok: false, backend: health.backend, degraded: true, modelHash, dimensions: health.dimensions, reason: `sqlite-vec sample query failed: ${String((error as Error).message ?? error)}` };
      }
    }
    return { ok: true, backend: health.backend, degraded: health.backend !== "sqlite-vec", modelHash, dimensions: health.dimensions, ...(health.backend === "sqlite-vec" ? {} : { reason: "sqlite-vec extension unavailable; using deterministic SQLite fallback" }) };
  }
}
