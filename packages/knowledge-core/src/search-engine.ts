import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSearchRequest, validateSearchResponse, type NormalizedSearchRequest, type SearchHit, type SearchResponse, type SearchRequest } from "@penguin/knowledge-contracts";
import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import { searchSource, type ResolvedRevisionScope } from "./source-search.js";
import { searchPath } from "./path-search.js";
import { searchRegex } from "./regex-search.js";
import { search } from "./query.js";
import { HmacSearchCursorCodec } from "./search-cursor.js";
import { LANE_WEIGHTS, rankSearchHits, semanticLaneScore } from "./search-ranking.js";
import { planSearch } from "./search-planner.js";
import { semanticSearch, type SemanticDocument } from "./semantic-search.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { sanitizeUntrustedText } from "./content-safety.js";
import { OntologyStore } from "./ontology.js";

export interface SearchContext { store: KnowledgeStore; scopes?: ResolvedRevisionScope[]; cursorSecret?: string; now?: () => Date; semanticProvider?: EmbeddingProvider; signal?: AbortSignal; }
function defaultCursorSecret(): string {
  if (process.env.PENGUIN_CURSOR_SECRET) return process.env.PENGUIN_CURSOR_SECRET;
  const root = join(homedir(), ".penguin", "knowledge");
  const path = join(root, ".cursor-secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch { /* first process creates the local secret */ }
  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: "wx" });
    const persisted = readFileSync(path, "utf8").trim();
    return persisted.length >= 32 ? persisted : generated;
  } catch {
    // Read-only environments still get a stable process-local fallback; the
    // configured env var is the supported way to share a secret there.
    return generated;
  }
}
const DEFAULT_CURSOR_SECRET = defaultCursorSecret();

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function queryHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function repoName(store: KnowledgeStore, repoId: string): string { return (store.db.prepare("SELECT name FROM repos WHERE id=?").get(repoId) as { name: string } | undefined)?.name ?? repoId; }
function scopeRows(store: KnowledgeStore): ResolvedRevisionScope[] {
  return (store.db.prepare("SELECT repo_id AS repoId,current_snapshot_id AS snapshotId FROM branches WHERE status='live' AND current_snapshot_id IS NOT NULL ORDER BY default_branch DESC,name").all() as Array<{ repoId: string; snapshotId: string }>).map((row) => row);
}
function hitId(scope: ResolvedRevisionScope, path: string, startByte = 0, endByte = 0, contentHash?: string): string { return `hit_${hash([scope.snapshotId, path, startByte, endByte, contentHash ?? null]).slice(0, 24)}`; }

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = previous[j];
      previous[j] = a[i - 1] === b[j - 1]
        ? diagonal
        : Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + 1);
      diagonal = next;
    }
  }
  return previous[b.length];
}

function spellingSuggestions(store: KnowledgeStore, query: string, limit = 5): Array<{ query: string; mode: "path" | "lexical"; reason: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length < 2) return [];
  const candidates = new Map<string, "path" | "lexical">();
  for (const row of store.db.prepare("SELECT DISTINCT file_path AS value FROM source_facts LIMIT 5000").all() as Array<{ value: string }>) candidates.set(row.value, "path");
  for (const row of store.db.prepare("SELECT DISTINCT title AS value FROM nodes WHERE node_type IN ('symbol','service','endpoint','entity') LIMIT 5000").all() as Array<{ value: string }>) candidates.set(row.value, "lexical");
  return [...candidates.entries()]
    .map(([value, mode]) => ({ value, mode, distance: editDistance(needle, value.toLowerCase()), contains: value.toLowerCase().includes(needle) }))
    .filter((row) => row.contains || row.distance <= Math.max(2, Math.floor(needle.length / 3)))
    .sort((a, b) => Number(b.contains) - Number(a.contains) || a.distance - b.distance || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map((row) => ({ query: row.value, mode: row.mode, reason: row.contains ? "wider indexed spelling candidate" : "nearby indexed spelling candidate" }));
}
function sourceHit(scope: ResolvedRevisionScope, store: KnowledgeStore, item: { sourceFactId: string; contentHash?: string; filePath: string; startLine: number; endLine: number; startByte: number; endByte: number; snippet: string }, score: number, reason: string): SearchHit {
  const repo = scope.repoId ?? (store.db.prepare("SELECT repo_id FROM source_facts WHERE id=?").get(item.sourceFactId) as { repo_id: string }).repo_id;
  const locator = { repoId: repo, repoName: repoName(store, repo), revisionId: scope.snapshotId, revisionKind: "commit" as const, filePath: item.filePath, startLine: item.startLine, endLine: item.endLine, startByte: item.startByte, endByte: item.endByte, offsetEncoding: "utf8_normalized" as const };
  const coverage = store.db.prepare("SELECT coverage_json AS coverage FROM source_facts WHERE id=?").get(item.sourceFactId) as { coverage: string | null } | undefined;
  let untrusted = false;
  try { const parsed = coverage?.coverage ? JSON.parse(coverage.coverage) as { reasonCode?: string } : {}; untrusted = parsed.reasonCode?.startsWith("external_") === true; } catch { untrusted = false; }
  const safe = sanitizeUntrustedText(item.snippet);
  return { hitId: hitId(scope, item.filePath, item.startByte, item.endByte, item.contentHash), kind: "source_occurrence", lane: "source", title: item.filePath, locator, snippet: safe.text, untrustedContent: true, score, rankReasons: [reason, ...(untrusted ? ["external content is untrusted"] : []), ...(safe.redacted ? ["secret content redacted"] : [])], evidence: [{ source: "source", locator, excerpt: safe.text, contentHash: item.contentHash, status: untrusted ? "observed" : "verified" }] };
}

export function searchKnowledge(input: SearchRequest | NormalizedSearchRequest, context: SearchContext): SearchResponse {
  const request = normalizeSearchRequest(input);
  const plan = planSearch(request);
  const availableScopes = context.scopes?.length ? context.scopes : scopeRows(context.store);
  const requestedRevisions = request.scope.revisions;
  const scopes = requestedRevisions?.length
    ? availableScopes.filter((scope) => requestedRevisions.some((revision) => {
        if (revision.snapshotId) return revision.snapshotId === scope.snapshotId;
        if (revision.repoId) return revision.repoId === scope.repoId;
        if (revision.repoName && scope.repoId) return revision.repoName.toLocaleLowerCase() === repoName(context.store, scope.repoId).toLocaleLowerCase();
        if (revision.branch && scope.repoId) return Boolean(context.store.db.prepare("SELECT 1 FROM branches WHERE repo_id=? AND name=? AND current_snapshot_id=?").get(scope.repoId, revision.branch, scope.snapshotId));
        return true;
      }))
    : availableScopes;
  const secret = context.cursorSecret ?? DEFAULT_CURSOR_SECRET;
  const codec = new HmacSearchCursorCodec(secret, () => (context.now?.() ?? new Date()).getTime());
  const normalizedHash = hash({ ...request, page: { limit: request.page.limit } });
  let after: string | undefined;
  const warnings: Array<{ code: string; message: string }> = [];
  const ontology = new OntologyStore(context.store);
  if (request.page.cursor) {
    try {
      const cursor = codec.decode(request.page.cursor);
      if (cursor.normalizedRequestHash !== normalizedHash || cursor.capabilityHash !== capabilityHash(CAPABILITIES)) throw new Error("CURSOR_STALE");
      after = cursor.lastHitId;
    } catch (error) { throw new Error(String((error as Error).message).includes("STALE") ? "CURSOR_STALE" : "CURSOR_INVALID"); }
  }
  const hits: SearchHit[] = [];
  for (const scope of scopes) {
    if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
    for (const stage of plan.stages) {
      if (stage.lane === "source") {
        if (request.mode === "regex") {
          const result = searchRegex(context.store, scope, request.query, { allowPartial: false });
          if (result.status === "error") { warnings.push({ code: result.code, message: result.message }); continue; }
          hits.push(...result.hits.map((item) => sourceHit(scope, context.store, item, LANE_WEIGHTS.source, "verified regex occurrence")));
        } else {
          const callExpressionQuery = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\([^)]*\)\s*$/u.test(request.query);
          hits.push(...searchSource(context.store, scope, { query: request.query, mode: request.mode, options: request.options }, { signal: context.signal })
            .filter((item) => !request.scope.paths?.length || request.scope.paths.some((prefix) => item.filePath === prefix || item.filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)))
            .map((item) => sourceHit(scope, context.store, item, callExpressionQuery ? 1.3 : request.mode === "exact" ? 1.1 : LANE_WEIGHTS.source, callExpressionQuery ? "verified exact call expression; call-site boost=0.3" : request.mode === "exact" ? "verified exact source occurrence; exact boost=0.1" : "verified source occurrence")));
        }
      } else if (stage.lane === "path") {
        for (const item of searchPath(context.store, scope, request.query, request.options.includeExcludedMetadata).filter((candidate) => !request.scope.paths?.length || request.scope.paths.some((prefix) => candidate.filePath === prefix || candidate.filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)))) {
          if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
          const locator = { repoId: scope.repoId ?? "", repoName: repoName(context.store, scope.repoId ?? ""), revisionId: scope.snapshotId, revisionKind: "commit" as const, filePath: item.filePath };
          const normalizedPath = request.query.replaceAll("\\", "/").replace(/^\.\//, "");
          const exactPath = item.filePath === normalizedPath;
          hits.push({ hitId: hitId(scope, item.filePath), kind: "path", lane: "path", title: item.filePath, locator, score: item.metadataOnly ? 0.7 : exactPath ? 1.2 : 1, rankReasons: [item.metadataOnly ? "excluded path metadata; secret_policy=path_only" : exactPath ? "exact full path; exact boost=0.2" : "path match", `coverage_status=${item.coverageStatus}`, `reason_code=${item.reasonCode}`], evidence: [{ source: "source", locator, status: item.metadataOnly ? "observed" : "verified" }] });
        }
      } else if (stage.lane === "symbol") {
        const expansion = request.mode === "exact" || request.mode === "phrase" || request.mode === "path" || request.mode === "regex"
          ? { terms: [], boost: 0, ambiguous: [] }
          : ontology.expansion(request.query, { ...(request.scope.workspaceId ? { workspaceId: request.scope.workspaceId } : {}), ...(scope.repoId ? { repoIds: [scope.repoId] } : {}) });
        if (expansion.ambiguous.length) warnings.push({ code: "ONTOLOGY_ALIAS_AMBIGUOUS", message: `alias has multiple ontology candidates: ${expansion.ambiguous.map((candidate) => candidate.canonicalName).join(", ")}` });
        const symbolQueries = [request.query, ...expansion.terms];
        for (const [query, expansionQuery] of symbolQueries.map((value, index) => [value, index > 0] as const)) for (const item of search(context.store, query, { repo: scope.repoId, limit: request.page.limit })) {
          if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
          const filePath = item.filePath;
          if (!filePath || (request.scope.paths?.length && !request.scope.paths.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)))) continue;
          const locatorRepoId = scope.repoId ?? (item.nodeId ? context.store.getNode(item.nodeId)?.repo_id : undefined) ?? "workspace";
          const symbolLine = item.startLine ?? (item.nodeId
            ? (context.store.db.prepare("SELECT start_line AS startLine FROM symbol_versions WHERE node_id=? AND status <> 'deleted' ORDER BY (status='fresh') DESC, start_line LIMIT 1").get(item.nodeId) as { startLine: number | null } | undefined)?.startLine ?? undefined
            : undefined);
          const locator = { repoId: locatorRepoId, repoName: repoName(context.store, locatorRepoId), revisionId: scope.snapshotId, revisionKind: "commit" as const, filePath, ...(symbolLine != null ? { startLine: symbolLine } : {}) };
          const symbolLane = item.nodeType === "note" ? "note" : "symbol";
          const exactSymbol = symbolLane === "symbol" && (item.title === request.query || item.identityKey === request.query);
          hits.push({ hitId: hitId(scope, filePath, item.startLine ?? 0), kind: item.nodeType, lane: symbolLane, title: item.title, locator, snippet: item.snippet ?? undefined, score: LANE_WEIGHTS[symbolLane] + (exactSymbol ? 0.1 : 0) + (expansionQuery ? expansion.boost : 0), rankReasons: [exactSymbol ? "exact symbol name; exact boost=0.1" : "indexed lexical symbol/name match", ...(expansionQuery ? ["ontology alias expansion; non-proof ranking boost=0.04"] : [])], evidence: [{ source: item.nodeType === "note" ? "note" : "graph", locator, excerpt: item.snippet ?? undefined, status: "verified" }] });
        }
      }
    }
  }
  const deduped = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = `${hit.locator.revisionId}:${hit.locator.filePath}:${hit.locator.startByte ?? hit.locator.startLine ?? 0}:${hit.locator.endByte ?? hit.locator.endLine ?? 0}`;
    const old = deduped.get(key);
    if (!old) deduped.set(key, hit);
    else if (hit.score >= old.score) deduped.set(key, { ...hit, evidence: [...old.evidence, ...hit.evidence], rankReasons: [...new Set([...old.rankReasons, ...hit.rankReasons])] });
    else deduped.set(key, { ...old, evidence: [...old.evidence, ...hit.evidence], rankReasons: [...new Set([...old.rankReasons, ...hit.rankReasons])] });
  }
  const feedbackScopeHash = hash(scopes);
  const feedback = context.store.db.prepare(
    "SELECT hit_id AS hitId, verdict FROM search_feedback WHERE query_hash=? AND scope_hash=? ORDER BY created_at",
  ).all(queryHash(request.query), feedbackScopeHash) as Array<{ hitId: string; verdict: "useful" | "dead_end" | "corrected" }>;
  const feedbackByHit = new Map<string, Array<"useful" | "dead_end" | "corrected">>();
  for (const item of feedback) feedbackByHit.set(item.hitId, [...(feedbackByHit.get(item.hitId) ?? []), item.verdict]);
  const adjusted = [...deduped.values()].map((hit) => {
    const verdicts = feedbackByHit.get(hit.hitId) ?? [];
    const useful = verdicts.filter((verdict) => verdict === "useful").length;
    const deadEnd = verdicts.filter((verdict) => verdict === "dead_end").length;
    if (!useful && !deadEnd) return hit;
    return { ...hit, score: hit.score + useful * 0.02 - deadEnd * 0.05, rankReasons: [...hit.rankReasons, ...(useful ? [`feedback useful x${useful}`] : []), ...(deadEnd ? [`feedback dead-end x${deadEnd}`] : [])] };
  });
  let ranked = rankSearchHits(adjusted);
  if (after) { const index = ranked.findIndex((item) => item.hitId === after); if (index >= 0) ranked = ranked.slice(index + 1); else warnings.push({ code: "CURSOR_STALE", message: "cursor hit is not present in the current result set" }); }
  const pageHits = ranked.slice(0, request.page.limit);
  const last = pageHits.at(-1);
  const nextCursor = ranked.length > pageHits.length && last ? codec.encode({ schemaVersion: "1", queryHash: hash(request.query), normalizedRequestHash: normalizedHash, scopeHash: hash(scopes), mode: request.mode, lanes: plan.stages.map((stage) => stage.lane), lastRank: last.score, lastHitId: last.hitId, capabilityHash: capabilityHash(CAPABILITIES), expiresAt: new Date((context.now?.() ?? new Date()).getTime() + 15 * 60_000).toISOString() }) : undefined;
  const coverage = scopes.reduce((sum, scope) => { const row = context.store.db.prepare("SELECT COUNT(*) AS discovered, SUM(coverage_status='admitted') AS admitted, SUM(coverage_status<>'admitted') AS excluded, SUM(coverage_status='failed') AS failed, SUM(coverage_status='stale') AS stale FROM coverage_records WHERE repo_id=?").get(scope.repoId) as { discovered: number; admitted: number; excluded: number; failed: number; stale: number }; return { discovered: sum.discovered + (row?.discovered ?? 0), admitted: sum.admitted + (row?.admitted ?? 0), excluded: sum.excluded + (row?.excluded ?? 0), failed: sum.failed + (row?.failed ?? 0), stale: sum.stale + (row?.stale ?? 0) }; }, { discovered: 0, admitted: 0, excluded: 0, failed: 0, stale: 0 });
  const sourceFacts = Number((context.store.db.prepare("SELECT COUNT(*) AS n FROM source_facts").get() as { n: number }).n ?? 0);
  if (sourceFacts === 0 && plan.stages.some((stage) => stage.lane === "source")) warnings.push({ code: "SOURCE_NOT_INCLUDED", message: "the selected artifact/index contains no source corpus; graph and metadata may still be available, but exact source search cannot prove absence" });
  if (coverage.excluded > 0 || coverage.failed > 0) warnings.push({ code: "COVERAGE_INCOMPLETE", message: "coverage includes excluded or failed files; an empty result is not proof of absence" });
  if (coverage.stale > 0) warnings.push({ code: "INDEX_STALE", message: "one or more coverage records are stale; the result total is not exact" });
  const exclusions: Array<{ filePath: string; code: string; reason: string }> = [];
  if (pageHits.length === 0) {
    warnings.push({ code: "NO_MATCH", message: "no verified match in the resolved scopes" });
    if (scopes.length && !request.options.includeExcludedMetadata) {
      const repoIds = [...new Set(scopes.map((scope) => scope.repoId).filter((repoId): repoId is string => Boolean(repoId)))];
      const excluded = repoIds.length === 0 ? [] : context.store.db.prepare(`SELECT file_path AS filePath, reason_code AS reason FROM coverage_records WHERE repo_id IN (${repoIds.map(() => "?").join(",")}) AND coverage_status <> 'admitted' AND (file_path LIKE ? OR file_path LIKE ?) ORDER BY file_path LIMIT 5`).all(...repoIds, `%${request.query}%`, `%/${request.query}%`) as Array<{ filePath: string; reason: string }>;
      for (const row of excluded) exclusions.push({ filePath: row.filePath, code: "EXCLUDED_FILES_MATCH_PATH", reason: row.reason });
      if (exclusions.length) warnings.push({ code: "EXCLUDED_FILES_MATCH_PATH", message: `query matched excluded path metadata: ${exclusions.map((row) => `${row.filePath} (${row.reason})`).join(", ")}` });
    }
  }
  const suggestions = pageHits.length === 0 ? spellingSuggestions(context.store, request.query) : [];
  if (scopes.length === 0 && request.scope.revisions?.length) warnings.push({ code: "SCOPE_EMPTY", message: "the requested repository or revision is not indexed" });
  const error = scopes.length === 0 && request.scope.revisions?.length
    ? { code: "REPOSITORY_NOT_FOUND" as const, message: "requested repository or revision was not found in the indexed knowledge store", details: { revisions: request.scope.revisions }, retryable: false }
    : undefined;
  const totalIsExact = coverage.stale === 0 && coverage.failed === 0 && coverage.excluded === 0 && request.mode === "exact" && ranked.length <= request.page.limit;
  return validateSearchResponse({ schemaVersion: "2", hits: pageHits, ...(error ? { error } : {}), diagnostics: { requestId: `search_${hash([normalizedHash, Date.now()]).slice(0, 16)}`, contractVersion: "2", capabilityHash: capabilityHash(CAPABILITIES), resolvedScopes: scopes.map((scope) => ({ repoId: scope.repoId ?? "", branch: (storeBranch(context.store, scope.snapshotId) ?? ""), snapshotId: scope.snapshotId, revisionKind: "commit" as const })), searchedLanes: plan.stages.map((stage) => stage.lane), skippedLanes: [], coverage, exclusions, warnings, suggestions, timingsMs: {}, truncated: false }, page: { limit: request.page.limit, ...(nextCursor ? { nextCursor } : {}), totalIsExact, ...(totalIsExact ? { total: ranked.length } : {}) } });
}

/** Async companion for the optional semantic lane. Deterministic search remains
 * the source of truth; semantic hits are explicitly marked as inference and
 * are only blended when the caller opts in and supplies a provider. */
export async function searchKnowledgeAsync(input: SearchRequest | NormalizedSearchRequest, context: SearchContext): Promise<SearchResponse> {
  const request = normalizeSearchRequest(input);
  const deterministic = searchKnowledge({ ...request, options: { ...request.options, semantic: "off" } }, context);
  if (request.options.semantic === "off") return deterministic;
  const scopes = context.scopes?.length ? context.scopes : scopeRows(context.store);
  const warnings = [...deterministic.diagnostics.warnings];
  if (!context.semanticProvider) {
    warnings.push({ code: "SEMANTIC_UNAVAILABLE", message: "semantic search was requested but no embedding provider is configured; deterministic lanes were returned" });
    return { ...deterministic, diagnostics: { ...deterministic.diagnostics, warnings } };
  }
  try {
    const providerHealth = await context.semanticProvider.health();
    if (!providerHealth.ok) {
      warnings.push({ code: "SEMANTIC_UNAVAILABLE", message: providerHealth.reason ?? "embedding provider is unhealthy; deterministic lanes were returned" });
      return { ...deterministic, diagnostics: { ...deterministic.diagnostics, warnings } };
    }
  } catch (error) {
    warnings.push({ code: "SEMANTIC_UNAVAILABLE", message: String((error as Error).message ?? error) });
    return { ...deterministic, diagnostics: { ...deterministic.diagnostics, warnings } };
  }
  const requestedRevisions = request.scope.revisions;
  const semanticScopes = requestedRevisions?.length
    ? scopes.filter((scope) => requestedRevisions.some((revision) => {
        if (revision.snapshotId) return revision.snapshotId === scope.snapshotId;
        if (revision.repoId) return revision.repoId === scope.repoId;
        if (revision.repoName && scope.repoId) return revision.repoName.toLocaleLowerCase() === repoName(context.store, scope.repoId).toLocaleLowerCase();
        if (revision.branch && scope.repoId) return Boolean(context.store.db.prepare("SELECT 1 FROM branches WHERE repo_id=? AND name=? AND current_snapshot_id=?").get(scope.repoId, revision.branch, scope.snapshotId));
        return true;
      }))
    : scopes;
  const documents: SemanticDocument[] = [];
  for (const scope of semanticScopes) {
    const rows = context.store.db.prepare(`SELECT f.id AS sourceFactId,e.file_path AS filePath,b.decoded_content AS content
      FROM effective_snapshot_sources e JOIN source_facts f ON f.id=e.source_fact_id
      JOIN source_blobs b ON b.id=f.source_blob_id JOIN coverage_records c ON c.repo_id=f.repo_id AND c.file_path=f.file_path
      WHERE e.snapshot_id=? AND c.coverage_status='admitted' LIMIT 1000`).all(scope.snapshotId) as Array<{ sourceFactId: string; filePath: string; content: string }>;
    for (const row of rows) {
      if (!row.content || (request.scope.paths?.length && !request.scope.paths.some((prefix) => row.filePath === prefix || row.filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)))) continue;
      const safe = sanitizeUntrustedText(row.content);
      documents.push({ id: `${scope.snapshotId}:${row.sourceFactId}`, text: safe.text.slice(0, 20000), locator: { repoId: scope.repoId ?? "", repoName: repoName(context.store, scope.repoId ?? ""), revisionId: scope.snapshotId, revisionKind: "commit" as const, filePath: row.filePath } });
    }
  }
  if (semanticScopes.length !== scopes.length) warnings.push({ code: "SEMANTIC_SCOPE_FILTERED", message: "semantic documents were restricted to the requested repository/revision scope" });
  if (!documents.length) {
    warnings.push({ code: "SEMANTIC_EMPTY_CORPUS", message: "semantic search has no source documents in the resolved scopes" });
    return { ...deterministic, diagnostics: { ...deterministic.diagnostics, warnings } };
  }
  let semanticHits;
  try { semanticHits = await semanticSearch(context.semanticProvider, request.query, documents, Math.max(50, request.page.limit)); }
  catch (error) { warnings.push({ code: "SEMANTIC_UNAVAILABLE", message: String((error as Error).message ?? error) }); return { ...deterministic, diagnostics: { ...deterministic.diagnostics, warnings } }; }
  const inferred: SearchHit[] = semanticHits.map((hit) => ({ hitId: `semantic_${hash(hit.id).slice(0, 24)}`, kind: "source_document", lane: "semantic", title: String((hit.locator as { filePath?: string }).filePath ?? hit.id), locator: hit.locator as SearchHit["locator"], score: semanticLaneScore(hit.similarity), rankReasons: [`semantic similarity ${hit.similarity.toFixed(4)}`, "semantic score normalized within semantic lane"], untrustedContent: true, evidence: [{ source: "semantic", locator: hit.locator as SearchHit["locator"], status: "inference" }] }));
  const merged = rankSearchHits([...deterministic.hits, ...inferred]).slice(0, request.page.limit);
  return { ...deterministic, hits: merged, diagnostics: { ...deterministic.diagnostics, searchedLanes: [...new Set([...deterministic.diagnostics.searchedLanes, "semantic" as const])], warnings }, page: { limit: request.page.limit, totalIsExact: false } };
}

function storeBranch(store: KnowledgeStore, snapshotId: string): string | undefined {
  return (store.db.prepare("SELECT name FROM branches WHERE current_snapshot_id=? ORDER BY default_branch DESC LIMIT 1").get(snapshotId) as { name: string } | undefined)?.name;
}
