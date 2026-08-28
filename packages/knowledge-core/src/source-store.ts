import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { trigramLaneEnabled } from "./trigram-lane.js";
import { buildLineIndex } from "./line-index.js";
import { WhyCardStore } from "./why-card.js";

export interface SourceCoverageInput {
  status: string;
  reasonCode: string;
  classification: string;
  [key: string]: unknown;
}

export interface EffectiveSource {
  sourceFactId: string;
  filePath: string;
  contentHash: string | null;
  encoding: string | null;
  decodedContent: string | null;
  sourceBlobId: number | null;
}

export interface PutBlobInput {
  contentHash: string;
  rawBytes: Uint8Array;
  decodedContent: string;
  encoding: string;
}

export interface PutSourceFactInput {
  repoId: string;
  filePath: string;
  factFingerprint: string;
  contentHash?: string;
  sourceBlobId?: number;
  coverage: SourceCoverageInput;
}

function lexicalText(content: string): string {
  return content.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[\s_\-./:]+/g, " ");
}

function trigrams(content: string): string[] {
  const chars = [...content];
  if (chars.length < 3) return [];
  const result = new Set<string>();
  for (let i = 0; i <= chars.length - 3; i += 1) result.add(chars.slice(i, i + 3).join(""));
  return [...result];
}

export class SourceStore {
  constructor(private readonly store: KnowledgeStore) {}

  putBlob(input: PutBlobInput): number {
    const existing = this.store.db.prepare("SELECT id, byte_size, raw_bytes FROM source_blobs WHERE content_hash=?").get(input.contentHash) as { id: number; byte_size: number; raw_bytes: Buffer } | undefined;
    if (existing) {
      if (existing.byte_size !== input.rawBytes.byteLength || !Buffer.from(existing.raw_bytes).equals(Buffer.from(input.rawBytes))) {
        throw new Error("CONTENT_HASH_COLLISION");
      }
      return existing.id;
    }
    const lineIndex = buildLineIndex(input.rawBytes, input.decodedContent);
    const tx = this.store.db.transaction(() => {
      const inserted = this.store.db.prepare(
        "INSERT INTO source_blobs(content_hash,byte_size,encoding,raw_bytes,decoded_content,created_at) VALUES (?,?,?,?,?,?)",
      ).run(input.contentHash, input.rawBytes.byteLength, input.encoding, Buffer.from(input.rawBytes), input.decodedContent, new Date().toISOString());
      const id = Number(inserted.lastInsertRowid);
      const lineInsert = this.store.db.prepare(
        "INSERT INTO source_blob_lines(source_blob_id,line_number,start_byte,end_byte,start_char,end_char) VALUES (?,?,?,?,?,?)",
      );
      for (const line of lineIndex.lines) lineInsert.run(id, line.line, line.startByte, line.endByte, line.startChar, line.endChar);
      // Trigram lane is optional (see trigram-lane.ts): skipping the inserts
      // only slows literal search down to the bounded full scan — the
      // downstream verifier keeps results exact either way.
      if (trigramLaneEnabled(this.store)) {
        const trigramInsert = this.store.db.prepare("INSERT INTO source_blob_trigrams(source_blob_id,trigram) VALUES (?,?)");
        for (const trigram of trigrams(input.decodedContent)) trigramInsert.run(id, trigram);
      }
      this.store.db.prepare("INSERT INTO source_fts(rowid,content) VALUES (?,?)").run(id, input.decodedContent);
      this.store.db.prepare("INSERT INTO source_lexical_fts(rowid,content) VALUES (?,?)").run(id, lexicalText(input.decodedContent));
      return id;
    });
    return tx() as number;
  }

  putSourceFact(input: PutSourceFactInput): string {
    if (input.sourceBlobId !== undefined && !this.store.db.prepare("SELECT 1 FROM source_blobs WHERE id=?").get(input.sourceBlobId)) {
      throw new Error("SOURCE_BLOB_NOT_FOUND");
    }
    const id = "sourcefact_" + sha256Hex(canonicalJson([input.repoId, input.filePath, input.factFingerprint]));
    const staleWhyHashes: string[] = [];
    const tx = this.store.db.transaction(() => {
      const previous = this.store.db.prepare("SELECT content_hash AS contentHash FROM source_facts WHERE repo_id=? AND file_path=? AND content_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(input.repoId, input.filePath) as { contentHash: string } | undefined;
      if (previous?.contentHash && previous.contentHash !== input.contentHash) {
        this.store.db.prepare("UPDATE trust_evidence SET status='stale' WHERE content_hash=? AND status NOT IN ('stale','contradicted')").run(previous.contentHash);
        staleWhyHashes.push(previous.contentHash);
      }
      this.store.db.prepare(
        `INSERT INTO source_facts(id,repo_id,file_path,fact_fingerprint,content_hash,source_blob_id,coverage_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(repo_id,file_path,fact_fingerprint) DO UPDATE SET
           content_hash=excluded.content_hash, source_blob_id=excluded.source_blob_id, coverage_json=excluded.coverage_json`,
      ).run(id, input.repoId, input.filePath, input.factFingerprint, input.contentHash ?? null, input.sourceBlobId ?? null, JSON.stringify(input.coverage), new Date().toISOString());
      const row = this.store.db.prepare("SELECT source_fact_rowid FROM source_facts WHERE id=?").get(id) as { source_fact_rowid: number };
      this.store.db.prepare("DELETE FROM source_path_fts WHERE rowid=?").run(row.source_fact_rowid);
      this.store.db.prepare("INSERT INTO source_path_fts(rowid,file_path,source_fact_id) VALUES (?,?,?)").run(row.source_fact_rowid, input.filePath, id);
    });
    tx();
    for (const contentHash of staleWhyHashes) new WhyCardStore(this.store).markStaleByContentHash(contentHash);
    return id;
  }

  attachFileFact(fileFactId: string, sourceFactId: string): void {
    const tx = this.store.db.transaction(() => {
      if (!this.store.db.prepare("SELECT 1 FROM source_facts WHERE id=?").get(sourceFactId)) throw new Error("SOURCE_FACT_NOT_FOUND");
      this.store.db.prepare("INSERT OR IGNORE INTO file_fact_sources(file_fact_id,source_fact_id) VALUES (?,?)").run(fileFactId, sourceFactId);
    });
    tx();
  }

  getEffectiveSource(snapshotId: string, filePath: string): EffectiveSource | undefined {
    return this.store.db.prepare(
      `SELECT e.source_fact_id AS sourceFactId, e.file_path AS filePath,
              f.content_hash AS contentHash, b.encoding, b.decoded_content AS decodedContent,
              f.source_blob_id AS sourceBlobId
       FROM effective_snapshot_sources e
       JOIN source_facts f ON f.id=e.source_fact_id
       LEFT JOIN source_blobs b ON b.id=f.source_blob_id
       WHERE e.snapshot_id=? AND e.file_path=?`,
    ).get(snapshotId, filePath) as EffectiveSource | undefined;
  }
}
