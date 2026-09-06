import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { chunkIdentity } from "./semantic-identity.js";
import { VectorStore } from "./vector-store.js";

export interface SemanticChunk { id: string; text: string; contentHash: string; chunkKind: "heading" | "paragraph" | "comment" | "window"; startChar: number; endChar: number; }

export const SEMANTIC_CHUNKER_VERSION = "semantic-chunker-v6-precision";

interface SemanticBlock {
  text: string;
  start: number;
  kind: "heading" | "paragraph" | "comment";
}

function semanticBlocks(text: string, targetChars: number): SemanticBlock[] {
  const blocks: SemanticBlock[] = [];
  let current: SemanticBlock | null = null;
  const flush = () => {
    if (current?.text.trim()) blocks.push(current);
    current = null;
  };
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const start = match.index ?? 0;
    if (!line.trim()) {
      // Keep small adjacent declarations together, but preserve a useful
      // retrieval boundary once a block is substantial. This avoids both
      // one-vector-per-line explosions and 1200-character windows whose intent
      // is diluted by several unrelated functions.
      if (current && current.text.length >= targetChars) flush();
      else if (current) current.text += line;
      continue;
    }
    const heading = /^#{1,6}\s/.test(line);
    const comment = !heading && /^(?:\s*(?:\/\/|\/\*|\*|#|;)|\s*(?:'''|\"\"\"))/.test(line);
    const kind: SemanticBlock["kind"] = heading ? "heading" : comment ? "comment" : "paragraph";
    if (heading) {
      flush();
      blocks.push({ text: line, start, kind });
      continue;
    }
    if (!current || current.kind !== kind) {
      flush();
      current = { text: line, start, kind };
    } else {
      current.text += line;
    }
  }
  flush();
  return blocks;
}

export function chunkSemanticText(text: string, maxChars = 1200, overlap = 180): SemanticChunk[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0 || overlap < 0 || overlap >= maxChars) throw new Error("SEMANTIC_CHUNK_OPTIONS_INVALID");
  const result: SemanticChunk[] = [];
  const blocks = semanticBlocks(text, Math.max(1, Math.floor(maxChars / 3)));
  const source = blocks.length ? blocks : text ? [{ text, start: 0, kind: "paragraph" as const }] : [];
  for (const block of source) {
    let offset = 0;
    while (offset < block.text.length) {
      const end = Math.min(block.text.length, offset + maxChars);
      const chunkText = block.text.slice(offset, end);
      const kind: SemanticChunk["chunkKind"] = block.kind === "paragraph" && chunkText.length === maxChars
        ? "window"
        : block.kind;
      const contentHash = createHash("sha256").update(chunkText).digest("hex");
      result.push({ id: `chunk_${contentHash.slice(0, 24)}`, text: chunkText, contentHash, chunkKind: kind, startChar: block.start + offset, endChar: block.start + end });
      if (end === block.text.length) break;
      offset = end - overlap;
    }
  }
  return result;
}

export interface PersistSemanticChunksInput {
  sourceBlobId?: number;
  nodeId?: string;
  repoId?: string;
  snapshotId?: string;
  canonicalFilePath?: string;
  chunkerVersion?: string;
  text: string;
  maxChars?: number;
  overlap?: number;
}

export interface SemanticSnapshotSourceInput {
  sourceBlobId: number;
  canonicalFilePath: string;
  text: string;
}

export interface SemanticSnapshotChunksResult {
  files: number;
  chunks: number;
}

function semanticChunkRows(input: PersistSemanticChunksInput): Array<{
  id: string;
  contentHash: string;
  sourceBlobId: number | null;
  nodeId: string | null;
  repoId: string | null;
  snapshotId: string | null;
  canonicalFilePath: string | null;
  identityHash: string | null;
  chunkerVersion: string;
  startByte: number;
  endByte: number;
  chunkKind: SemanticChunk["chunkKind"];
}> {
  const chunks = chunkSemanticText(input.text, input.maxChars, input.overlap);
  const sourceBlobId = input.sourceBlobId ?? null;
  const nodeId = input.nodeId ?? null;
  const provenanceFields = [input.repoId, input.snapshotId, input.canonicalFilePath, input.chunkerVersion];
  const hasProvenance = provenanceFields.some((value) => value !== undefined);
  if (hasProvenance && provenanceFields.some((value) => value === undefined)) throw new Error("SEMANTIC_CHUNK_PROVENANCE_REQUIRED");
  const chunkerVersion = input.chunkerVersion ?? "legacy-content-v1";
  const identities = hasProvenance
    ? chunks.map((chunk) => chunkIdentity({
        repoId: input.repoId!, snapshotId: input.snapshotId!, canonicalFilePath: input.canonicalFilePath!, nodeId: input.nodeId,
        startByte: Buffer.byteLength(input.text.slice(0, chunk.startChar), "utf8"),
        endByte: Buffer.byteLength(input.text.slice(0, chunk.endChar), "utf8"),
        contentHash: chunk.contentHash, chunkerVersion,
      }))
    : chunks.map((chunk) => ({ id: chunk.id, identityHash: null, provenance: null }));
  return chunks.map((chunk, index) => ({
    id: identities[index].id,
    contentHash: chunk.contentHash,
    sourceBlobId,
    nodeId,
    repoId: hasProvenance ? input.repoId! : null,
    snapshotId: hasProvenance ? input.snapshotId! : null,
    canonicalFilePath: hasProvenance ? input.canonicalFilePath! : null,
    identityHash: identities[index].identityHash,
    chunkerVersion,
    startByte: Buffer.byteLength(input.text.slice(0, chunk.startChar), "utf8"),
    endByte: Buffer.byteLength(input.text.slice(0, chunk.endChar), "utf8"),
    chunkKind: chunk.chunkKind,
  }));
}

/**
 * Replace the semantic chunk set for one published source snapshot. This is
 * intentionally separate from vector backfill: chunk persistence is safe and
 * deterministic even when the local model is unavailable, while embeddings
 * remain a later staging-generation operation.
 */
export function replaceSemanticSnapshotChunks(store: KnowledgeStore, input: {
  repoId: string;
  snapshotId: string;
  sources: SemanticSnapshotSourceInput[];
  chunkerVersion?: string;
  maxChars?: number;
  overlap?: number;
}): SemanticSnapshotChunksResult {
  const vectors = new VectorStore(store);
  const rows = input.sources.flatMap((source) => semanticChunkRows({
    sourceBlobId: source.sourceBlobId,
    repoId: input.repoId,
    snapshotId: input.snapshotId,
    canonicalFilePath: source.canonicalFilePath,
    chunkerVersion: input.chunkerVersion ?? SEMANTIC_CHUNKER_VERSION,
    maxChars: input.maxChars,
    overlap: input.overlap,
    text: source.text,
  }));
  const tx = store.db.transaction(() => {
    const refs = store.db.prepare(`
      SELECT r.model_hash AS modelHash,r.chunk_id AS chunkId
        FROM semantic_embedding_refs r
        JOIN semantic_chunks c ON c.id=r.chunk_id
       WHERE c.snapshot_id=?
    `).all(input.snapshotId) as Array<{ modelHash: string; chunkId: string }>;
    for (const ref of refs) vectors.delete(ref.modelHash, ref.chunkId);
    // This function replaces the complete snapshot chunk set. Delete jobs and
    // chunks with set-based statements: a v2→v3 migration can contain hundreds
    // of thousands of old rows, while only a tiny fraction has vector refs.
    store.db.prepare(`
      UPDATE embedding_generations
         SET status='failed',failure_reason='SEMANTIC_CHUNK_SET_REPLACED'
       WHERE status='staging' AND id IN (
         SELECT DISTINCT j.generation_id
           FROM embedding_jobs j JOIN semantic_chunks c ON c.id=j.chunk_id
          WHERE c.snapshot_id=?
       )
    `).run(input.snapshotId);
    store.db.prepare("DELETE FROM embedding_jobs WHERE chunk_id IN (SELECT id FROM semantic_chunks WHERE snapshot_id=?)").run(input.snapshotId);
    store.db.prepare("DELETE FROM semantic_chunks WHERE snapshot_id=?").run(input.snapshotId);
    const insert = store.db.prepare(`INSERT INTO semantic_chunks(id,content_hash,source_blob_id,node_id,repo_id,snapshot_id,canonical_file_path,identity_hash,chunker_version,start_byte,end_byte,chunk_kind,text_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_blob_id=excluded.source_blob_id,node_id=excluded.node_id,repo_id=excluded.repo_id,snapshot_id=excluded.snapshot_id,canonical_file_path=excluded.canonical_file_path,identity_hash=excluded.identity_hash,chunker_version=excluded.chunker_version,start_byte=excluded.start_byte,end_byte=excluded.end_byte,chunk_kind=excluded.chunk_kind,text_hash=excluded.text_hash`);
    for (const row of rows) {
      insert.run(row.id, row.contentHash, row.sourceBlobId, row.nodeId, row.repoId, row.snapshotId, row.canonicalFilePath, row.identityHash, row.chunkerVersion, row.startByte, row.endByte, row.chunkKind, row.contentHash, new Date().toISOString());
    }
  });
  tx();
  return { files: input.sources.length, chunks: rows.length };
}

/** Persist the chunk set for one source blob/node; exact source remains separate. */
export function persistSemanticChunks(store: KnowledgeStore, input: PersistSemanticChunksInput): SemanticChunk[] {
  const chunks = chunkSemanticText(input.text, input.maxChars, input.overlap);
  const sourceBlobId = input.sourceBlobId ?? null;
  const nodeId = input.nodeId ?? null;
  const provenanceFields = [input.repoId, input.snapshotId, input.canonicalFilePath, input.chunkerVersion];
  const hasProvenance = provenanceFields.some((value) => value !== undefined);
  if (hasProvenance && provenanceFields.some((value) => value === undefined)) throw new Error("SEMANTIC_CHUNK_PROVENANCE_REQUIRED");
  const chunkerVersion = input.chunkerVersion ?? "legacy-content-v1";
  const identities = hasProvenance
    ? chunks.map((chunk) => chunkIdentity({
        repoId: input.repoId!, snapshotId: input.snapshotId!, canonicalFilePath: input.canonicalFilePath!, nodeId: input.nodeId,
        startByte: Buffer.byteLength(input.text.slice(0, chunk.startChar), "utf8"),
        endByte: Buffer.byteLength(input.text.slice(0, chunk.endChar), "utf8"),
        contentHash: chunk.contentHash, chunkerVersion,
      }))
    : chunks.map((chunk) => ({ id: chunk.id, identityHash: null, provenance: null }));
  const persistedIds = new Set(identities.map((identity) => identity.id));
  const currentIds = new Set(chunks.map((chunk) => chunk.id));
  const vectors = new VectorStore(store);
  const tx = store.db.transaction(() => {
    if (sourceBlobId !== null) {
      const old = hasProvenance
        ? store.db.prepare("SELECT id FROM semantic_chunks WHERE source_blob_id=? AND node_id IS ? AND repo_id=? AND snapshot_id=? AND canonical_file_path=?").all(sourceBlobId, nodeId, input.repoId, input.snapshotId, input.canonicalFilePath)
        : store.db.prepare("SELECT id FROM semantic_chunks WHERE source_blob_id=? AND node_id IS ? AND repo_id IS NULL AND snapshot_id IS NULL").all(sourceBlobId, nodeId) as Array<{ id: string }>;
      for (const row of old as Array<{ id: string }>) if (!persistedIds.has(row.id) && !currentIds.has(row.id)) {
        const refs = store.db.prepare("SELECT model_hash AS modelHash FROM semantic_embedding_refs WHERE chunk_id=?").all(row.id) as Array<{ modelHash: string }>;
        for (const ref of refs) vectors.delete(ref.modelHash, row.id);
        store.db.prepare("DELETE FROM embedding_jobs WHERE chunk_id=?").run(row.id);
        store.db.prepare("DELETE FROM semantic_chunks WHERE id=?").run(row.id);
      }
    }
    const insert = store.db.prepare(`INSERT INTO semantic_chunks(id,content_hash,source_blob_id,node_id,repo_id,snapshot_id,canonical_file_path,identity_hash,chunker_version,start_byte,end_byte,chunk_kind,text_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_blob_id=excluded.source_blob_id,node_id=excluded.node_id,repo_id=excluded.repo_id,snapshot_id=excluded.snapshot_id,canonical_file_path=excluded.canonical_file_path,identity_hash=excluded.identity_hash,chunker_version=excluded.chunker_version,start_byte=excluded.start_byte,end_byte=excluded.end_byte,chunk_kind=excluded.chunk_kind,text_hash=excluded.text_hash`);
    chunks.forEach((chunk, index) => {
      const startByte = Buffer.byteLength(input.text.slice(0, chunk.startChar), "utf8");
      const endByte = Buffer.byteLength(input.text.slice(0, chunk.endChar), "utf8");
      const identity = identities[index];
      insert.run(identity.id, chunk.contentHash, sourceBlobId, nodeId, hasProvenance ? input.repoId : null, hasProvenance ? input.snapshotId : null, hasProvenance ? input.canonicalFilePath : null, identity.identityHash, chunkerVersion, startByte, endByte, chunk.chunkKind, chunk.contentHash, new Date().toISOString());
    });
  });
  tx();
  return chunks.map((chunk, index) => ({ ...chunk, id: identities[index].id }));
}
