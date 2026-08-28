import { createRequire } from "node:module";
import type { KnowledgeStore } from "./store.js";
import { trigramLaneEnabled } from "./trigram-lane.js";
import { locateSourceRange, sourceSnippet } from "./source-snippet.js";
import type { ResolvedRevisionScope, SourceSearchOccurrence } from "./source-search.js";

export interface RegexSearchOptions {
  flags?: string;
  maxScannedBytes?: number;
  deadlineMs?: number;
  allowPartial?: boolean;
}
export type RegexSearchResult =
  | { status: "ok"; hits: SourceSearchOccurrence[]; scannedBytes: number; truncated: boolean }
  | { status: "error"; code: "REGEX_UNSUPPORTED" | "SEARCH_BUDGET_EXCEEDED"; message: string; scannedBytes: number; hits?: SourceSearchOccurrence[]; truncated: boolean };

function longestLiteral(pattern: string): string {
  const pieces: string[] = []; let current = ""; let escaped = false;
  const metachar = new Set(["(", ")", "[", "]", "{", "}", "|", "+", "*", "?", "^", "$", "."]);
  for (const char of pattern) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (metachar.has(char)) { if (current) pieces.push(current); current = ""; continue; }
    current += char;
  }
  if (current) pieces.push(current);
  return pieces.sort((a, b) => b.length - a.length)[0] ?? "";
}

function rows(store: KnowledgeStore, scope: ResolvedRevisionScope, literal: string): Array<{ sourceFactId: string; blobId: number; contentHash: string; filePath: string; content: string }> {
  const params: unknown[] = [scope.snapshotId];
  let sql = `SELECT e.source_fact_id AS sourceFactId,e.source_blob_id AS blobId,b.content_hash AS contentHash,e.file_path AS filePath,b.decoded_content AS content
    FROM effective_snapshot_sources e JOIN source_blobs b ON b.id=e.source_blob_id WHERE e.snapshot_id=?`;
  const chars = [...literal];
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) grams.add(chars.slice(i, i + 3).join(""));
  // Trigram prefilter is an accelerator only — with the lane off the regex
  // engine below still scans and matches every scoped blob exactly.
  if (grams.size > 0 && trigramLaneEnabled(store)) { const list = [...grams]; sql += ` AND e.source_blob_id IN (SELECT source_blob_id FROM source_blob_trigrams WHERE trigram IN (${list.map(() => "?").join(",")}) GROUP BY source_blob_id HAVING COUNT(DISTINCT trigram)=?)`; params.push(...list, list.length); }
  if (scope.repoId) { sql += " AND EXISTS (SELECT 1 FROM source_facts sf WHERE sf.id=e.source_fact_id AND sf.repo_id=?)"; params.push(scope.repoId); }
  return store.db.prepare(sql).all(...params) as Array<{ sourceFactId: string; blobId: number; contentHash: string; filePath: string; content: string }>;
}

export function searchRegex(store: KnowledgeStore, scope: ResolvedRevisionScope, pattern: string, options: RegexSearchOptions = {}): RegexSearchResult {
  const flags = [...new Set(`${options.flags ?? "g"}u`.split(""))].join("");
  let regex: { exec(input: string): Array<string | undefined> & { index?: number }; lastIndex: number; global: boolean };
  try {
    // Lazy CJS loading keeps CLI/MCP startup independent of the WASM runtime;
    // createRequire also gives re2-wasm the real package directory it needs to
    // locate its bundled .wasm file when the MCP artifact is executed.
    const require = createRequire(import.meta.url);
    const Re2 = require("re2-wasm").RE2 as new (source: string, flags?: string) => typeof regex;
    regex = new Re2(pattern, flags);
  }
  catch (error) {
    return { status: "error", code: "REGEX_UNSUPPORTED", message: String((error as Error).message ?? error), scannedBytes: 0, truncated: false };
  }
  const maxScannedBytes = options.maxScannedBytes ?? 32 * 1024 * 1024;
  const deadline = Date.now() + (options.deadlineMs ?? 5000);
  const hits: SourceSearchOccurrence[] = [];
  let scannedBytes = 0;
  let truncated = false;
  for (const row of rows(store, scope, longestLiteral(pattern))) {
    scannedBytes += Buffer.byteLength(row.content, "utf8");
    if (scannedBytes > maxScannedBytes || Date.now() > deadline) {
      truncated = true;
      if (!options.allowPartial) return { status: "error", code: "SEARCH_BUDGET_EXCEEDED", message: "regex search budget exceeded; rerun with a narrower scope or explicit allowPartial", scannedBytes, truncated: false };
      break;
    }
    regex.lastIndex = 0;
    let match: ReturnType<typeof regex.exec>;
    while ((match = regex.exec(row.content)) !== null) {
      const start = match.index ?? 0;
      const end = start + (match[0]?.length ?? 0);
      const location = locateSourceRange(store, row.blobId, row.content, start, end);
      hits.push({ ...location, sourceFactId: row.sourceFactId, blobId: row.blobId, contentHash: row.contentHash, filePath: row.filePath, snippet: sourceSnippet(row.content, start, end), verified: true });
      if (!regex.global) break;
      if (match[0] === "") regex.lastIndex += 1;
    }
  }
  return { status: "ok", hits: hits.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startByte - b.startByte), scannedBytes, truncated };
}
