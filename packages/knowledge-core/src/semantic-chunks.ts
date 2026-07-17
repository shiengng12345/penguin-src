import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

export interface SemanticChunk { id: string; text: string; contentHash: string; chunkKind: "heading" | "paragraph" | "comment" | "window"; startChar: number; endChar: number; }

export function chunkSemanticText(text: string, maxChars = 1200, overlap = 180): SemanticChunk[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0 || overlap < 0 || overlap >= maxChars) throw new Error("SEMANTIC_CHUNK_OPTIONS_INVALID");
  const result: SemanticChunk[] = [];
  const blocks = [...text.matchAll(/(^#{1,6}[^\n]*\n(?:[^\n]*\n)*|[^\n]+(?:\n|$))/gm)].map((match) => ({ text: match[0], start: match.index ?? 0 }));
  const source = blocks.length ? blocks : [{ text, start: 0 }];
  for (const block of source) {
    let offset = 0;
    while (offset < block.text.length) {
      const end = Math.min(block.text.length, offset + maxChars);
      const chunkText = block.text.slice(offset, end);
      const isCommentOrDocstring = /^(?:\s*(?:\/\/|\/\*|\*|#|;)|\s*(?:'''|\"\"\"))/.test(chunkText);
      const kind: SemanticChunk["chunkKind"] = /^#{1,6}\s/.test(chunkText) ? "heading" : isCommentOrDocstring ? "comment" : chunkText.length < maxChars ? "paragraph" : "window";
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
  text: string;
  maxChars?: number;
  overlap?: number;
}

/** Persist the chunk set for one source blob/node; exact source remains separate. */
export function persistSemanticChunks(store: KnowledgeStore, input: PersistSemanticChunksInput): SemanticChunk[] {
  const chunks = chunkSemanticText(input.text, input.maxChars, input.overlap);
  const sourceBlobId = input.sourceBlobId ?? null;
  const nodeId = input.nodeId ?? null;
  const currentIds = new Set(chunks.map((chunk) => chunk.id));
  const tx = store.db.transaction(() => {
    if (sourceBlobId !== null) {
      const old = store.db.prepare("SELECT id FROM semantic_chunks WHERE source_blob_id=? AND node_id IS ?").all(sourceBlobId, nodeId) as Array<{ id: string }>;
      for (const row of old) if (!currentIds.has(row.id)) {
        store.db.prepare("DELETE FROM semantic_embedding_refs WHERE chunk_id=?").run(row.id);
        store.db.prepare("DELETE FROM semantic_chunks WHERE id=?").run(row.id);
      }
    }
    const insert = store.db.prepare(`INSERT INTO semantic_chunks(id,content_hash,source_blob_id,node_id,start_byte,end_byte,chunk_kind,text_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_blob_id=excluded.source_blob_id,node_id=excluded.node_id,start_byte=excluded.start_byte,end_byte=excluded.end_byte,chunk_kind=excluded.chunk_kind,text_hash=excluded.text_hash`);
    for (const chunk of chunks) {
      const startByte = Buffer.byteLength(input.text.slice(0, chunk.startChar), "utf8");
      const endByte = Buffer.byteLength(input.text.slice(0, chunk.endChar), "utf8");
      insert.run(chunk.id, chunk.contentHash, sourceBlobId, nodeId, startByte, endByte, chunk.chunkKind, chunk.contentHash, new Date().toISOString());
    }
  });
  tx();
  return chunks;
}
