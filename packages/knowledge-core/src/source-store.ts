import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { trigramLaneEnabled } from "./trigram-lane.js";
import { packLineIndex } from "./line-offsets.js";
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

function trigrams(content: string): string[] {
  const chars = [...content];
  if (chars.length < 3) return [];
  const result = new Set<string>();
  for (let i = 0; i <= chars.length - 3; i += 1) result.add(chars.slice(i, i + 3).join(""));
  return [...result];
}

/** True when re-encoding the decoded text reproduces the original bytes exactly,
 * which makes storing those bytes redundant. Verified per blob rather than
 * assumed from the encoding name: a file labelled utf8 that does not round-trip
 * keeps its bytes. */
function isLosslessUtf8(encoding: string, rawBytes: Uint8Array, decoded: string): boolean {
  if (encoding !== "utf8") return false;
  return Buffer.from(decoded, "utf8").equals(Buffer.from(rawBytes));
}

/** The blob's original bytes, re-derived when they were not stored. */
export function storedBytes(row: { encoding: string; raw_bytes: Buffer | null; decodedContent: string }): Buffer {
  return row.raw_bytes ? Buffer.from(row.raw_bytes) : Buffer.from(row.decodedContent, "utf8");
}

export class SourceStore {
  constructor(private readonly store: KnowledgeStore) {}

  putBlob(input: PutBlobInput): number {
    const existing = this.store.db.prepare(
      "SELECT id, byte_size, encoding, raw_bytes, decoded_content AS decodedContent FROM source_blobs WHERE content_hash=?",
    ).get(input.contentHash) as
      | { id: number; byte_size: number; encoding: string; raw_bytes: Buffer | null; decodedContent: string }
      | undefined;
    if (existing) {
      if (existing.byte_size !== input.rawBytes.byteLength
          || !storedBytes(existing).equals(Buffer.from(input.rawBytes))) {
        throw new Error("CONTENT_HASH_COLLISION");
      }
      return existing.id;
    }
    const lineIndex = buildLineIndex(input.rawBytes, input.decodedContent);
    const tx = this.store.db.transaction(() => {
      const inserted = this.store.db.prepare(
        "INSERT INTO source_blobs(content_hash,byte_size,encoding,raw_bytes,decoded_content,created_at) VALUES (?,?,?,?,?,?)",
      ).run(
        input.contentHash, input.rawBytes.byteLength, input.encoding,
        // UTF-8 raw bytes ARE the encoding of decoded_content — storing both put
        // every source file in the database twice, 3.49 GB of it in this repo's
        // own index. Only a lossy decode needs the original preserved.
        isLosslessUtf8(input.encoding, input.rawBytes, input.decodedContent) ? null : Buffer.from(input.rawBytes),
        input.decodedContent, new Date().toISOString(),
      );
      const id = Number(inserted.lastInsertRowid);
      const packed = packLineIndex(lineIndex);
      this.store.db.prepare(
        "INSERT INTO source_blob_line_offsets(source_blob_id,line_count,total_chars,total_bytes,start_chars,start_bytes) VALUES (?,?,?,?,?,?)",
      ).run(id, packed.lineCount, packed.totalChars, packed.totalBytes, packed.startChars, packed.startBytes);
      // Trigram lane is optional (see trigram-lane.ts): skipping the inserts
      // only slows literal search down to the bounded full scan — the
      // downstream verifier keeps results exact either way.
      if (trigramLaneEnabled(this.store)) {
        const trigramInsert = this.store.db.prepare("INSERT INTO source_blob_trigrams(source_blob_id,trigram) VALUES (?,?)");
        for (const trigram of trigrams(input.decodedContent)) trigramInsert.run(id, trigram);
      }
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
