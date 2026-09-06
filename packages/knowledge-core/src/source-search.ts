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
  reasonCode?: string | null;
  verified: true;
}

function trigrams(value: string): string[] {
  const chars = [...value]; const result = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) result.add(chars.slice(i, i + 3).join(""));
  return [...result];
}

function occurrencesInHaystack(haystack: string, needle: string, mode: SearchMode, wholeWord: boolean): Array<[number, number]> {
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

function occurrences(content: string, query: string, mode: SearchMode, caseSensitive: boolean, wholeWord: boolean): Array<[number, number]> {
  if (caseSensitive) return occurrencesInHaystack(content, query, mode, wholeWord);
  if (!query || (mode !== "exact" && mode !== "phrase" && mode !== "substring")) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escaped, "giu");
  const result: Array<[number, number]> = [];
  for (let match = matcher.exec(content); match; match = matcher.exec(content)) {
    const start = match.index;
    const end = start + match[0].length;
    const wordOk = !wholeWord || (!/[\p{L}\p{N}_]/u.test(content[start - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(content[end] ?? ""));
    if (wordOk) result.push([start, end]);
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return result;
}

type ScopeSourceRow = { sourceFactId: string; blobId: number; contentHash: string; filePath: string; content: string; reasonCode: string | null };

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
  options: Pick<NormalizedSearchRequest["options"], "includeGenerated" | "includeVendor" | "caseSensitive">,
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
    let sql = `SELECT e.source_fact_id AS sourceFactId, e.source_blob_id AS blobId, b.content_hash AS contentHash, e.file_path AS filePath, b.decoded_content AS content,
      json_extract(sf.coverage_json, '$.reasonCode') AS reasonCode
      FROM effective_snapshot_sources e JOIN source_blobs b ON b.id=e.source_blob_id
      JOIN source_facts sf ON sf.id=e.source_fact_id
      LEFT JOIN coverage_records c ON c.repo_id=sf.repo_id AND c.file_path=e.file_path
      WHERE e.snapshot_id=?`;
    if (scope.repoId) { sql += " AND sf.repo_id=?"; params.push(scope.repoId); }
    if (!options.includeGenerated) sql += " AND COALESCE(c.classification, 'source') <> 'generated'";
    if (!options.includeVendor) sql += " AND COALESCE(c.classification, 'source') <> 'vendor'";
    if (batch) { sql += ` AND e.source_blob_id IN (${batch.map(() => "?").join(",")})`; params.push(...batch); }
    else {
      // With the optional trigram lane disabled, let SQLite discard
      // non-matching multi-megabyte blobs before they cross into JavaScript.
      // The JS occurrence verifier below still computes exact offsets and
      // whole-word semantics; this predicate is only a lossless prefilter.
      sql += options.caseSensitive
        ? " AND instr(b.decoded_content, ?) > 0"
        : " AND instr(lower(b.decoded_content), lower(?)) > 0";
      params.push(query);
    }
    // Loop-push instead of push(...spread): a broad query can return more rows
    // than the engine allows spread arguments, which throws "Maximum call
    // stack size exceeded".
    for (const row of store.db.prepare(sql).all(...params) as ScopeSourceRow[]) rows.push(row);
  }
  return rows;
}

export interface SourceSearchLimits { signal?: AbortSignal; maxOccurrences?: number; paths?: string[]; }

export interface SourceTermSearchOccurrence {
  item: SourceSearchOccurrence;
  term: string;
}

/** Search several literal terms with one snapshot read. Natural-language
 * queries used to call searchSource once per term, which made a five-term
 * request scan every decoded source blob five times whenever the optional
 * trigram lane was disabled. This function unions indexed candidates when
 * possible and otherwise sends one lossless OR prefilter to SQLite, then
 * performs the same exact offset/whole-word verification in JavaScript. */
export function searchSourceTerms(
  store: KnowledgeStore,
  scope: ResolvedRevisionScope,
  queries: string[],
  request: Pick<NormalizedSearchRequest, "mode" | "options">,
  options: SourceSearchLimits & { maxOccurrencesPerTerm?: number; maxOccurrencesPerTermPerBlob?: number } = {},
): SourceTermSearchOccurrence[] {
  const mode = request.mode === "auto" ? "substring" : request.mode;
  if (mode !== "exact" && mode !== "phrase" && mode !== "substring") return [];
  const terms = [...new Set(queries.filter(Boolean))];
  if (terms.length === 0) return [];
  const inPaths = (filePath: string) => !options.paths?.length
    || options.paths.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix.replace(/\/$/, "")}/`));
  const maxPerTerm = options.maxOccurrencesPerTerm ?? options.maxOccurrences ?? Number.POSITIVE_INFINITY;
  const maxPerTermPerBlob = options.maxOccurrencesPerTermPerBlob ?? Number.POSITIVE_INFINITY;
  const indexedCandidates = terms.map((term) => candidateBlobIds(store, scope, term));
  const canUseIndexedUnion = indexedCandidates.every((candidate) => candidate !== null);
  const candidateUnion = canUseIndexedUnion
    ? new Set(indexedCandidates.flatMap((candidate) => [...candidate!]))
    : null;
  if (candidateUnion?.size === 0) return [];
  const counts = new Map(terms.map((term) => [term, 0]));
  const hits: SourceTermSearchOccurrence[] = [];
  const emitBlobRows = (blobRows: ScopeSourceRow[]) => {
    if (blobRows.length === 0) return;
    if (options.signal?.aborted) throw new Error("SEARCH_CANCELLED");
    const row = blobRows[0];
    const emitOccurrence = (term: string, start: number, end: number) => {
      if ((counts.get(term) ?? 0) >= maxPerTerm) return;
      const location = locateSourceRange(store, row.blobId, row.content, start, end);
      for (const mapped of blobRows) {
        if ((counts.get(term) ?? 0) >= maxPerTerm) break;
        hits.push({
          term,
          item: {
            ...location,
            sourceFactId: mapped.sourceFactId,
            blobId: mapped.blobId,
            contentHash: mapped.contentHash,
            filePath: mapped.filePath,
            snippet: sourceSnippet(row.content, start, end),
            reasonCode: mapped.reasonCode,
            verified: true,
          },
        });
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    };
    if (maxPerTermPerBlob === 1) {
      // Natural-intent ranking keeps one representative occurrence per term
      // and file. Scan all terms with one native RegExp pass instead of five
      // full passes over legacy multi-megabyte controller/language files.
      const foldedTerms = new Map(terms.map((term) => [request.options.caseSensitive ? term : term.toLocaleLowerCase(), term]));
      const alternatives = [...terms]
        .sort((a, b) => b.length - a.length)
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const matcher = new RegExp(alternatives.join("|"), request.options.caseSensitive ? "gu" : "giu");
      const seen = new Set<string>();
      for (let match = matcher.exec(row.content); match; match = matcher.exec(row.content)) {
        const key = request.options.caseSensitive ? match[0] : match[0].toLocaleLowerCase();
        const term = foldedTerms.get(key);
        if (!term || seen.has(term) || (counts.get(term) ?? 0) >= maxPerTerm) continue;
        const start = match.index;
        const end = start + match[0].length;
        const wordOk = !request.options.wholeWord
          || (!/[\p{L}\p{N}_]/u.test(row.content[start - 1] ?? "") && !/[\p{L}\p{N}_]/u.test(row.content[end] ?? ""));
        if (!wordOk) continue;
        emitOccurrence(term, start, end);
        seen.add(term);
        if (seen.size === terms.length) break;
      }
      // Alternation consumes overlapping matches. Only terms contained in a
      // different term need a focused fallback to preserve exact semantics.
      for (const term of terms) {
        if (seen.has(term) || !terms.some((other) => other !== term && other.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) continue;
        const first = occurrences(row.content, term, mode, request.options.caseSensitive, request.options.wholeWord)[0];
        if (first) emitOccurrence(term, first[0], first[1]);
      }
      return;
    }
    for (const term of terms) {
      if ((counts.get(term) ?? 0) >= maxPerTerm) continue;
      let emittedForTerm = 0;
      for (const [start, end] of occurrences(row.content, term, mode, request.options.caseSensitive, request.options.wholeWord)) {
        if (emittedForTerm >= maxPerTermPerBlob) break;
        emitOccurrence(term, start, end);
        emittedForTerm += 1;
      }
    }
  };
  const sourceRowsQuery = (batch?: number[]) => {
    const params: unknown[] = [scope.snapshotId];
    let sql = `SELECT e.source_fact_id AS sourceFactId, e.source_blob_id AS blobId, b.content_hash AS contentHash, e.file_path AS filePath, b.decoded_content AS content,
      json_extract(sf.coverage_json, '$.reasonCode') AS reasonCode
      FROM effective_snapshot_sources e JOIN source_blobs b ON b.id=e.source_blob_id
      JOIN source_facts sf ON sf.id=e.source_fact_id
      LEFT JOIN coverage_records c ON c.repo_id=sf.repo_id AND c.file_path=e.file_path
      WHERE e.snapshot_id=?`;
    if (scope.repoId) { sql += " AND sf.repo_id=?"; params.push(scope.repoId); }
    if (!request.options.includeGenerated) sql += " AND COALESCE(c.classification, 'source') <> 'generated'";
    if (!request.options.includeVendor) sql += " AND COALESCE(c.classification, 'source') <> 'vendor'";
    if (batch) {
      sql += ` AND e.source_blob_id IN (${batch.map(() => "?").join(",")})`;
      params.push(...batch);
    }
    return { sql, params };
  };

  if (candidateUnion === null) {
    const query = sourceRowsQuery();
    const predicates: string[] = [];
    for (const term of terms) {
      if (request.options.caseSensitive) {
        predicates.push("instr(b.decoded_content, ?) > 0");
        query.params.push(term);
      } else if (/^[\x00-\x7F]*$/u.test(term)) {
        // SQLite LIKE performs allocation-free ASCII case folding. It is a
        // lossless prefilter for code-search terms and avoids materializing a
        // new lower-cased copy of every multi-megabyte legacy source blob.
        predicates.push("b.decoded_content LIKE ? ESCAPE '\\' COLLATE NOCASE");
        query.params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
      } else {
        // Keep the previous Unicode-safe prefilter for the uncommon non-ASCII
        // query; the JS verifier below remains authoritative for offsets.
        predicates.push("instr(lower(b.decoded_content), lower(?)) > 0");
        query.params.push(term);
      }
    }
    query.sql += ` AND (${predicates.join(" OR ")})`;
    query.sql += " ORDER BY e.source_blob_id, e.source_fact_id";
    let currentBlobId: number | null = null;
    let currentRows: ScopeSourceRow[] = [];
    for (const row of store.db.prepare(query.sql).iterate(...query.params) as Iterable<ScopeSourceRow>) {
      if (options.signal?.aborted) throw new Error("SEARCH_CANCELLED");
      if (currentBlobId !== null && row.blobId !== currentBlobId) {
        emitBlobRows(currentRows);
        currentRows = [];
      }
      currentBlobId = row.blobId;
      if (inPaths(row.filePath)) currentRows.push(row);
    }
    emitBlobRows(currentRows);
    return hits.sort((a, b) => a.item.filePath.localeCompare(b.item.filePath)
      || a.item.startByte - b.item.startByte
      || a.term.localeCompare(b.term)
      || a.item.sourceFactId.localeCompare(b.item.sourceFactId));
  }
  const candidateBatches = candidateUnion
    ? [...candidateUnion].reduce<number[][]>((batches, blobId, index) => {
      const batch = batches[Math.floor(index / 900)] ?? [];
      batch.push(blobId);
      batches[Math.floor(index / 900)] = batch;
      return batches;
    }, [])
    : [undefined];
  const rows: ScopeSourceRow[] = [];
  for (const batch of candidateBatches) {
    if (options.signal?.aborted) throw new Error("SEARCH_CANCELLED");
    const query = sourceRowsQuery(batch);
    for (const row of store.db.prepare(query.sql).all(...query.params) as ScopeSourceRow[]) {
      if (inPaths(row.filePath)) rows.push(row);
    }
  }

  const byBlob = new Map<number, ScopeSourceRow[]>();
  for (const row of rows) byBlob.set(row.blobId, [...(byBlob.get(row.blobId) ?? []), row]);
  for (const blobRows of byBlob.values()) emitBlobRows(blobRows);
  return hits.sort((a, b) => a.item.filePath.localeCompare(b.item.filePath)
    || a.item.startByte - b.item.startByte
    || a.term.localeCompare(b.term)
    || a.item.sourceFactId.localeCompare(b.item.sourceFactId));
}

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
        hits.push({ ...location, sourceFactId: mapped.sourceFactId, blobId: mapped.blobId, contentHash: mapped.contentHash, filePath: mapped.filePath, snippet: sourceSnippet(row.content, start, end), reasonCode: mapped.reasonCode, verified: true });
      }
    }
  }
  return hits.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startByte - b.startByte || a.sourceFactId.localeCompare(b.sourceFactId));
}
