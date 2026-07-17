import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SourceStore, type KnowledgeStore } from "@penguin/knowledge-core";
import type { DiscoveredFile } from "./coverage.js";
import { decodeTextBuffer } from "./encoding.js";

export interface SourceIngestResult {
  sourceFactId: string;
  sourceBlobId: number;
  contentHash: string;
}

/** Persist one admitted file independently of parser support. */
export function ingestSourceFile(store: KnowledgeStore, repoId: string, file: DiscoveredFile): SourceIngestResult {
  const rawBytes = readFileSync(file.absolutePath);
  const contentHash = createHash("sha256").update(rawBytes).digest("hex");
  const decoded = decodeTextBuffer(rawBytes);
  const decodedContent = file.content ?? (decoded.ok ? decoded.text : rawBytes.toString("utf8"));
  const sourceStore = new SourceStore(store);
  const sourceBlobId = sourceStore.putBlob({
    contentHash,
    rawBytes,
    decodedContent,
    encoding: file.encoding ?? "utf8",
  });
  const sourceFactId = sourceStore.putSourceFact({
    repoId,
    filePath: file.relativePath,
    factFingerprint: `source-v1:${contentHash}:${file.reasonCode}`,
    contentHash,
    sourceBlobId,
    coverage: {
      status: file.coverageStatus,
      reasonCode: file.reasonCode,
      classification: file.classification,
      gitState: file.gitState,
      byteSize: file.byteSize,
      reason: file.reason,
      encoding: file.encoding ?? "utf8",
    },
  });
  return { sourceFactId, sourceBlobId, contentHash };
}
