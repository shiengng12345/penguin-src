import type { KnowledgeStore } from "./store.js";
import { sanitizeUntrustedText } from "./content-safety.js";
import { readLineOffsets, lineAtChar, lineAtByte, lineEntry } from "./line-offsets.js";

export interface SourceLocation { startLine: number; endLine: number; startByte: number; endByte: number; }

export function locateSourceRange(store: KnowledgeStore, blobId: number, content: string, startChar: number, endChar: number): SourceLocation {
  const startByte = Buffer.byteLength(content.slice(0, startChar), "utf8");
  const endByte = Buffer.byteLength(content.slice(0, endChar), "utf8");
  const offsets = readLineOffsets(store, blobId);
  if (!offsets) return { startLine: 1, endLine: 1, startByte, endByte };
  const startLine = lineAtChar(offsets, startChar);
  const endLine = lineAtChar(offsets, Math.max(startChar, endChar - 1));
  return { startLine, endLine: Math.max(startLine, endLine), startByte, endByte };
}

export function sourceSnippet(content: string, startChar: number, endChar: number, contextLines = 2, maxBytes = 4096): string {
  const lines = content.split("\n");
  let line = 0; let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const next = offset + lines[i].length + 1;
    if (startChar < next) { line = i; break; }
    offset = next;
  }
  const selected = lines.slice(Math.max(0, line - contextLines), Math.min(lines.length, line + contextLines + 1)).join("\n");
  const bytes = Buffer.from(selected, "utf8");
  return bytes.byteLength <= maxBytes ? selected : bytes.subarray(0, maxBytes).toString("utf8");
}

export interface SourceHitRequest { snapshotId: string; filePath: string; repoId?: string; startLine?: number; startByte?: number; endLine?: number; contextLines?: number; }

export function getSourceHit(store: KnowledgeStore, request: SourceHitRequest): Record<string, unknown> | null {
  const row = store.db.prepare(`SELECT e.source_fact_id AS sourceFactId, f.repo_id AS repoId, b.id AS blobId, b.decoded_content AS content, f.coverage_json AS coverage
    FROM effective_snapshot_sources e JOIN source_facts f ON f.id=e.source_fact_id JOIN source_blobs b ON b.id=f.source_blob_id
    WHERE e.snapshot_id=? AND e.file_path=? AND (? IS NULL OR f.repo_id=?)`).get(request.snapshotId, request.filePath, request.repoId ?? null, request.repoId ?? null) as { sourceFactId: string; repoId: string; blobId: number; content: string; coverage: string | null } | undefined;
  if (!row) return null;
  const offsets = readLineOffsets(store, row.blobId);
  if (!offsets) return null;
  const start = request.startByte !== undefined
    // Same rule the row-per-line query encoded: the last line whose start is at
    // or before the offset — the line the offset falls inside.
    ? lineEntry(offsets, lineAtByte(offsets, request.startByte))
    : request.startLine !== undefined
      ? lineEntry(offsets, request.startLine)
      : lineEntry(offsets, 1);
  if (!start) return null;
  const end = request.endLine !== undefined
    ? lineEntry(offsets, request.endLine)
    : { endChar: start.endChar };
  let untrusted = false;
  try { untrusted = String(JSON.parse(row.coverage ?? "{}").reasonCode ?? "").startsWith("external_"); } catch { untrusted = false; }
  const repoName = (store.db.prepare("SELECT name FROM repos WHERE id=?").get(row.repoId) as { name: string } | undefined)?.name ?? row.repoId;
  const locator = { repoId: row.repoId, repoName, revisionId: request.snapshotId, revisionKind: "commit", filePath: request.filePath, startLine: start.line, endLine: request.endLine ?? start.line, startByte: start.startByte, offsetEncoding: "utf8_normalized" };
  const safe = sanitizeUntrustedText(sourceSnippet(row.content, start.startChar, end?.endChar ?? start.endChar, request.contextLines ?? 2));
  return { hitId: `source_${row.sourceFactId}_${start.startByte}`, kind: "source_occurrence", lane: "source", title: request.filePath, locator, snippet: safe.text, untrustedContent: true, evidence: [{ source: "source", locator, excerpt: safe.text, status: untrusted ? "observed" : "verified" }], ...(safe.redacted ? { warnings: ["secret content redacted"] } : {}) };
}
