import { zipSync, strToU8 } from "fflate";
import { createHash, createCipheriv, createHmac, createPrivateKey, createPublicKey, randomBytes, scryptSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import type { KnowledgeArtifactManifest } from "./artifact-manifest.js";

function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export interface ArtifactExportOptions { buildId?: string; includeSource?: boolean; includeNotes?: boolean; includeEvidence?: boolean; includeEmbeddings?: boolean; repoIds?: string[]; snapshotIds?: string[]; signingKey?: string; signingPrivateKey?: string; encryptionKey?: string; baseDatabase?: Uint8Array; }
export interface ArtifactPreview { estimatedBytes: number; included: { source: boolean; notes: boolean; evidence: boolean; embeddings: boolean }; counts: Record<string, number>; repoIds?: string[]; snapshotIds?: string[]; requiresConfirmation: true; }
export function previewKnowledgeArtifact(store: KnowledgeStore, options: Pick<ArtifactExportOptions, "includeSource" | "includeNotes" | "includeEvidence" | "includeEmbeddings" | "repoIds" | "snapshotIds"> = {}): ArtifactPreview {
  const count = (table: string): number => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n ?? 0);
  const pageCount = Number(store.db.pragma("page_count", { simple: true }) ?? 0);
  const pageSize = Number(store.db.pragma("page_size", { simple: true }) ?? 4096);
  return { estimatedBytes: pageCount * pageSize, included: { source: options.includeSource === true, notes: options.includeNotes === true, evidence: options.includeEvidence === true, embeddings: options.includeEmbeddings === true }, counts: { sourceBlobs: options.includeSource ? count("source_blobs") : 0, notes: options.includeNotes ? count("fts_notes") : 0, evidence: options.includeEvidence ? count("trust_evidence") : 0, embeddings: options.includeEmbeddings ? count("semantic_chunks") : 0 }, ...(options.repoIds?.length ? { repoIds: options.repoIds } : {}), ...(options.snapshotIds?.length ? { snapshotIds: options.snapshotIds } : {}), requiresConfirmation: true };
}
const DELTA_CHUNK_SIZE = 64 * 1024;
function deltaFor(base: Uint8Array, current: Uint8Array, tombstoneCount: number): { delta: Uint8Array; manifest: { algorithm: "fixed-chunk-v1"; chunkSize: number; baseDatabaseBytes: number; tombstoneCount: number } } {
  const chunks: Array<{ offset: number; data: string }> = [];
  const size = Math.max(base.byteLength, current.byteLength);
  for (let offset = 0; offset < size; offset += DELTA_CHUNK_SIZE) {
    const next = current.slice(offset, Math.min(offset + DELTA_CHUNK_SIZE, current.byteLength));
    const previous = base.slice(offset, Math.min(offset + DELTA_CHUNK_SIZE, base.byteLength));
    if (!Buffer.from(next).equals(Buffer.from(previous))) chunks.push({ offset, data: Buffer.from(next).toString("base64") });
  }
  return { delta: strToU8(JSON.stringify({ algorithm: "fixed-chunk-v1", chunkSize: DELTA_CHUNK_SIZE, size: current.byteLength, chunks })), manifest: { algorithm: "fixed-chunk-v1", chunkSize: DELTA_CHUNK_SIZE, baseDatabaseBytes: base.byteLength, tombstoneCount } };
}

const TOMBSTONE_SPECS = [
  ["repo", "SELECT id FROM repos"],
  ["snapshot", "SELECT id FROM revision_snapshots"],
  ["note", "SELECT path FROM notes_index"],
  ["source_fact", "SELECT id FROM source_facts"],
  ["semantic_chunk", "SELECT id FROM semantic_chunks"],
] as const;

function addArtifactTombstones(currentDb: KnowledgeStore["db"], baseBytes: Uint8Array, DatabaseConstructor: new (path: string) => KnowledgeStore["db"], rootDir: string, baseHash: string): number {
  const basePath = join(rootDir, "base.sqlite");
  writeFileSync(basePath, Buffer.from(baseBytes), { flag: "wx", mode: 0o600 });
  const baseDb = new DatabaseConstructor(basePath);
  const pending: Array<[string, string]> = [];
  try {
    for (const [entityType, sql] of TOMBSTONE_SPECS) {
      let before: Array<{ key: string }>;
      let after: Array<{ key: string }>;
      try { before = (baseDb.prepare(sql.replace(/SELECT (id|path)/, "SELECT $1 AS key")).all() as Array<{ key: string }>); } catch { before = []; }
      try { after = (currentDb.prepare(sql.replace(/SELECT (id|path)/, "SELECT $1 AS key")).all() as Array<{ key: string }>); } catch { after = []; }
      const present = new Set(after.map((row) => String(row.key)));
      for (const row of before) if (!present.has(String(row.key))) pending.push([entityType, String(row.key)]);
    }
  } finally { baseDb.close(); }
  if (pending.length === 0) return 0;
  currentDb.exec("CREATE TABLE IF NOT EXISTS artifact_tombstones (entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, base_artifact_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity_type, entity_key))");
  const insert = currentDb.prepare("INSERT OR IGNORE INTO artifact_tombstones(entity_type,entity_key,base_artifact_hash,created_at) VALUES (?,?,?,?)");
  for (const [entityType, entityKey] of pending) insert.run(entityType, entityKey, baseHash, new Date().toISOString());
  return pending.length;
}
export function exportKnowledgeArtifact(store: KnowledgeStore, options: ArtifactExportOptions = {}): { bytes: Uint8Array; manifest: KnowledgeArtifactManifest } {
  // Serialize through SQLite's backup/serialize path only after checkpointing;
  // never copy the live WAL file. The in-memory clone also lets the content
  // policy be enforced before bytes enter the portable artifact.
  store.db.pragma("wal_checkpoint(PASSIVE)");
  const integrity = store.db.pragma("integrity_check", { simple: true }) as string;
  if (integrity !== "ok") throw new Error(`ARTIFACT_SOURCE_INTEGRITY_FAILED:${integrity}`);
  const orphanChecks = [
    ["source_facts", "SELECT COUNT(*) AS n FROM source_facts sf LEFT JOIN source_blobs b ON b.id=sf.source_blob_id WHERE sf.source_blob_id IS NOT NULL AND b.id IS NULL"],
    ["effective_snapshot_sources", "SELECT COUNT(*) AS n FROM effective_snapshot_sources e LEFT JOIN source_facts sf ON sf.id=e.source_fact_id WHERE sf.id IS NULL"],
    ["file_fact_sources", "SELECT COUNT(*) AS n FROM file_fact_sources f LEFT JOIN file_facts ff ON ff.id=f.file_fact_id LEFT JOIN source_facts sf ON sf.id=f.source_fact_id WHERE ff.id IS NULL OR sf.id IS NULL"],
  ] as const;
  for (const [name, sql] of orphanChecks) {
    const count = Number((store.db.prepare(sql).get() as { n: number }).n ?? 0);
    if (count > 0) throw new Error(`ARTIFACT_ORPHAN:${name}:${count}`);
  }
  const cloneDir = mkdtempSync(join(tmpdir(), "penguin-artifact-clone-"));
  const clonePath = join(cloneDir, "knowledge.sqlite");
  writeFileSync(clonePath, Buffer.from(store.db.serialize()));
  // Reuse the already-loaded better-sqlite3 constructor from the live store;
  // keeping this package free of a second static native import is important
  // for the MCP bundle's lazy knowledge loading.
  const DatabaseConstructor = store.db.constructor as unknown as new (path: string) => typeof store.db;
  const artifactDb = new DatabaseConstructor(clonePath);
  let tombstoneCount = 0;
  try {
    artifactDb.pragma("foreign_keys = OFF");
    // A portable artifact must not leak the exporting machine's filesystem
    // layout or checkout paths. Repo identity remains in the manifest; local
    // paths are intentionally blanked in the cloned database.
    artifactDb.prepare("UPDATE repos SET root_path='artifact://repo/' || id").run();
    artifactDb.prepare("UPDATE branches SET checkout_path=NULL").run();
    if (options.repoIds?.length) {
      const placeholders = options.repoIds.map(() => "?").join(",");
      const tables = artifactDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const columns = artifactDb.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>;
        if (columns.some((column) => column.name === "repo_id")) artifactDb.prepare(`DELETE FROM ${JSON.stringify(name)} WHERE repo_id IS NOT NULL AND repo_id NOT IN (${placeholders})`).run(...options.repoIds);
      }
      artifactDb.prepare(`DELETE FROM repos WHERE id NOT IN (${placeholders})`).run(...options.repoIds);
    }
    if (options.snapshotIds?.length) {
      const placeholders = options.snapshotIds.map(() => "?").join(",");
      const tables = artifactDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const columns = artifactDb.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>;
        if (columns.some((column) => column.name === "snapshot_id")) artifactDb.prepare(`DELETE FROM ${JSON.stringify(name)} WHERE snapshot_id IS NOT NULL AND snapshot_id NOT IN (${placeholders})`).run(...options.snapshotIds);
      }
      artifactDb.prepare(`DELETE FROM revision_snapshots WHERE id NOT IN (${placeholders})`).run(...options.snapshotIds);
      artifactDb.prepare(`UPDATE branches SET current_snapshot_id=NULL WHERE current_snapshot_id IS NOT NULL AND current_snapshot_id NOT IN (${placeholders})`).run(...options.snapshotIds);
    }
    if (options.includeSource !== true) {
      for (const table of ["source_fts", "source_lexical_fts", "source_path_fts", "source_blob_trigrams", "source_blob_lines", "source_snapshot_overlays", "effective_snapshot_sources", "file_fact_sources", "markdown_sections", "source_facts", "source_blobs", "source_backfill_checkpoints"]) artifactDb.prepare(`DELETE FROM ${table}`).run();
    }
    if (options.includeNotes !== true) {
      for (const table of ["fts_notes", "note_links", "note_properties", "notes_index"]) artifactDb.prepare(`DELETE FROM ${table}`).run();
    }
    if (options.includeEvidence !== true) {
      for (const table of ["finding_evidence", "validated_findings", "trust_evidence"]) artifactDb.prepare(`DELETE FROM ${table}`).run();
    }
    if (options.includeEmbeddings !== true) {
      for (const table of ["semantic_embedding_refs", "semantic_vector_values", "embedding_models", "semantic_chunks"]) artifactDb.prepare(`DELETE FROM ${table}`).run();
    }
    if (options.baseDatabase) tombstoneCount = addArtifactTombstones(artifactDb, options.baseDatabase, DatabaseConstructor, cloneDir, sha(options.baseDatabase));
  } finally {
    artifactDb.close();
  }
  const db = new Uint8Array(readFileSync(clonePath));
  rmSync(cloneDir, { recursive: true, force: true });
  const selectedRepoIds = options.repoIds?.length ? new Set(options.repoIds) : undefined;
  const selectedSnapshotIds = options.snapshotIds?.length ? new Set(options.snapshotIds) : undefined;
  const repos = (store.db.prepare("SELECT id,name FROM repos ORDER BY id").all() as Array<{id:string;name:string}>)
    .filter((repo) => !selectedRepoIds || selectedRepoIds.has(repo.id))
    .map((repo) => ({ repoId: repo.id, name: repo.name, revisions: (store.db.prepare("SELECT id,commit_sha FROM revision_snapshots WHERE repo_id=? ORDER BY id").all(repo.id) as Array<{id:string;commit_sha:string|null}>)
      .filter((row) => !selectedSnapshotIds || selectedSnapshotIds.has(row.id))
      .map((row) => ({ snapshotId: row.id, ...(row.commit_sha ? { commitSha: row.commit_sha } : {}) })) }));
  const manifest: KnowledgeArtifactManifest = { formatVersion: 1, createdAt: new Date().toISOString(), buildId: options.buildId ?? "local", capabilityHash: capabilityHash(CAPABILITIES), contractVersion: "2", schemaVersion: Number((store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {value:string}).value), repositories: repos, contentPolicy: { includesSource: options.includeSource === true, includesNotes: options.includeNotes === true, includesEvidence: options.includeEvidence === true, includesEmbeddings: options.includeEmbeddings === true, secretPolicyHash: "default" } };
  if (options.baseDatabase) { manifest.baseArtifactHash = sha(options.baseDatabase); }
  const computedDelta = options.baseDatabase ? deltaFor(options.baseDatabase, db, tombstoneCount) : undefined;
  if (computedDelta) manifest.delta = computedDelta.manifest;
  if (options.encryptionKey) manifest.encryption = { algorithm: "aes-256-gcm", envelope: "PKA2" };
  if (options.signingPrivateKey) {
    const privateKey = createPrivateKey(options.signingPrivateKey);
    const unsigned = JSON.stringify(manifest);
    const payload = Buffer.from(`${unsigned}\n${sha(db)}`, "utf8");
    const publicKey = privateKey.asymmetricKeyType === "ed25519" ? createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64") : undefined;
    manifest.signature = { algorithm: "ed25519", value: sign(null, payload, privateKey).toString("base64"), ...(publicKey ? { publicKey } : {}) };
  } else if (options.signingKey) manifest.signature = { algorithm: "hmac-sha256", value: createHmac("sha256", options.signingKey).update(JSON.stringify(manifest)).update(sha(db)).digest("hex") };
  const entries: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)) };
  if (computedDelta) entries["database/knowledge.sqlite.delta.json"] = computedDelta.delta;
  else entries["database/knowledge.sqlite"] = db;
  const checksums = Object.entries(entries).map(([path, bytes]) => `${sha(bytes)}  ${path}`).join("\n") + "\n";
  entries["checksums.sha256"] = strToU8(checksums);
  const zipped = zipSync(entries, { level: 6 });
  if (!options.encryptionKey) return { bytes: zipped, manifest };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(options.encryptionKey, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(zipped)), cipher.final()]);
  // PKA2 adds a random salt to the outer header; PKA1 remains importable for
  // artifacts produced before the scrypt migration.
  return { bytes: new Uint8Array(Buffer.concat([Buffer.from("PKA2"), salt, iv, cipher.getAuthTag(), ciphertext])), manifest };
}
