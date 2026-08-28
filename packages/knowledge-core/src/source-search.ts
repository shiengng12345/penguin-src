import type { NormalizedSearchRequest, SearchMode } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import { trigramLaneEnabled } from "./trigram-lane.js";
import { locateSourceRange, sourceSnippet, type SourceLocation } from "./source-snippet.js";

export interface ResolvedRevisionScope { snapshotId: string; repoId?: string; }
export interface SourceSearchOccurrence extends SourceLocation {
  sourceFactId: string;
  blobId: number;
  contentHash: string;
  filePath: string;
  snippet: string;
  verified: true;
}

function trigrams(value: string): string[] {
  const chars = [...value]; const result = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) result.add(chars.slice(i, i + 3).join(""));
  return [...result];
}

function occurrences(content: string, query: string, mode: SearchMode, caseSensitive: boolean, wholeWord: boolean): Array<[number, number]> {
  const haystack = caseSensitive ? content : content.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const result: Array<[number, number]> = [];
  if (!needle) return result;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    const wordOk = !wholeWord || (!/[\p{L}\p{N}_]/u.test(haystack[at - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(haystack[end] ?? ""));
    if (wordOk && (mode === "exact" || mode === "phrase" || mode === "substring")) result.push([at, end]);
    from = Math.max(at + 1, end);
  }
  return result;
}

type ScopeSourceRow = { sourceFactId: string; blobId: number; contentHash: string; filePath: string; content: string };

function candidateBlobIds(store: KnowledgeStore, scope: ResolvedRevisionScope, query: string): Set<number> | null {
  // Lane off → null → the same bounded full scan used for un-prefilterable
  // queries below; the final verifier keeps results exact, just slower.
  if (!trigramLaneEnabled(store)) return null;
  const grams = trigrams(query);
  // An unbounded placeholder list is both slower and easier to abuse than a
  // bounded full scan. The final verifier still guarantees correctness.
  if (grams.length === 0 || grams.length > 256) return null;
  const params: unknown[] = [scope.snapshotId];
  let sql = `SELECT DISTINCT e.source_blob_id AS blobId
    FROM effective_snapshot_sources e
    JOIN source_blob_trigrams t ON t.source_blob_id=e.source_blob_id
    WHERE e.snapshot_id=?`;
  if (scope.repoId) {
    sql += " AND EXISTS (SELECT 1 FROM source_facts sf WHERE sf.id=e.source_fact_id AND sf.repo_id=?)";
    params.push(scope.repoId);
  }
  sql += ` AND t.trigram IN (${grams.map(() => "?").join(",")}) GROUP BY e.source_blob_id HAVING COUNT(DISTINCT t.trigram)=?`;
  params.push(...grams, grams.length);
  return new Set((store.db.prepare(sql).all(...params) as Array<{ blobId: number }>).map((row) => row.blobId));
}

function rowsForScope(
  store: KnowledgeStore,
  scope: ResolvedRevisionScope,
  query: string,
  options: Pick<NormalizedSearchRequest["options"], "includeGenerated" | "includeVendor">,
): ScopeSourceRow[] {
  const candidates = candidateBlobIds(store, scope, query);
  // A trigram miss is a definitive miss for exact/phrase/substring source
  // search. Do not materialize the entire snapshot just to filter it out in
  // JavaScript; this was the main cross-repository timeout multiplier.
  if (candidates?.size === 0) return [];

  const candidateBatches = candidates
    ? [...candidates].reduce<number[][]>((batches, blobId, index) => {
      const batch = batches[Math.floor(index / 900)] ?? [];
      batch.push(blobId);
      batches[Math.floor(index / 900)] = batch;
      return batches;
    }, [])
    : [undefined];
  const rows: ScopeSourceRow[] = [];
  for (const batch of candidateBatches) {
    const params: unknown[] = [scope.snapshotId];
    let sql = `SELECT e.source_fact_id AS sourceFactId, e.source_blob_id AS blobId, b.content_hash AS contentHash, e.file_path AS filePath, b.decoded_content AS content
      FROM effective_snapshot_sources e JOIN source_blobs b ON b.id=e.source_blob_id
      JOIN source_facts sf ON sf.id=e.source_fact_id
      LEFT JOIN coverage_records c ON c.repo_id=sf.repo_id AND c.file_path=e.file_path
      WHERE e.snapshot_id=?`;
    if (scope.repoId) { sql += " AND sf.repo_id=?"; params.push(scope.repoId); }
    if (!options.includeGenerated) sql += " AND COALESCE(c.classification, 'source') <> 'generated'";
    if (!options.includeVendor) sql += " AND COALESCE(c.classification, 'source') <> 'vendor'";
    if (batch) { sql += ` AND e.source_blob_id IN (${batch.map(() => "?").join(",")})`; params.push(...batch); }
    // Loop-push instead of push(...spread): a broad query can return more rows
    // than the engine allows spread arguments, which throws "Maximum call
    // stack size exceeded".
    for (const row of store.db.prepare(sql).all(...params) as ScopeSourceRow[]) rows.push(row);
  }
  return rows;
}

export interface SourceSearchLimits { signal?: AbortSignal; maxOccurrences?: number; paths?: string[]; }

export function searchSource(store: KnowledgeStore, scope: ResolvedRevisionScope, request: Pick<NormalizedSearchRequest, "query" | "mode" | "options">, options: SourceSearchLimits = {}): SourceSearchOccurrence[] {
  const mode = request.mode === "auto" ? "substring" : request.mode;
  if (mode !== "exact" && mode !== "phrase" && mode !== "substring") return [];
  const maxOccurrences = options.maxOccurrences ?? Number.POSITIVE_INFINITY;
  const inPaths = (filePath: string) => !options.paths?.length || options.paths.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix.replace(/\/$/, "")}/`));
  const hits: SourceSearchOccurrence[] = [];
  const byBlob = new Map<number, ScopeSourceRow[]>();
  for (const row of rowsForScope(store, scope, request.query, request.options)) {
    if (!inPaths(row.filePath)) continue;
    byBlob.set(row.blobId, [...(byBlob.get(row.blobId) ?? []), row]);
  }
  scan: for (const rows of byBlob.values()) {
    if (options.signal?.aborted) throw new Error("SEARCH_CANCELLED");
    const row = rows[0];
    const matches = occurrences(row.content, request.query, mode, request.options.caseSensitive, request.options.wholeWord);
    for (const [start, end] of matches) {
      if (hits.length >= maxOccurrences) break scan;
      const location = locateSourceRange(store, row.blobId, row.content, start, end);
      for (const mapped of rows) {
        if (hits.length >= maxOccurrences) break scan;
        hits.push({ ...location, sourceFactId: mapped.sourceFactId, blobId: mapped.blobId, contentHash: mapped.contentHash, filePath: mapped.filePath, snippet: sourceSnippet(row.content, start, end), verified: true });
      }
    }
  }
  return hits.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startByte - b.startByte || a.sourceFactId.localeCompare(b.sourceFactId));
}
