import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSearchRequest, validateSearchResponse, type NormalizedSearchRequest, type SearchHit, type SearchResponse, type SearchRequest } from "@penguin/knowledge-contracts";
import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import type { RevisionContext } from "./revision.js";
import { searchSource, type ResolvedRevisionScope } from "./source-search.js";
import { searchPath } from "./path-search.js";
import { searchRegex } from "./regex-search.js";
import { searchLegacyRows } from "./query.js";
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
function revisionContext(store: KnowledgeStore, scope: ResolvedRevisionScope): RevisionContext | undefined {
  if (scope.snapshotId.startsWith("legacy:")) {
    const branchId = scope.snapshotId.slice("legacy:".length);
    const branch = store.db.prepare("SELECT repo_id AS repoId,name FROM branches WHERE id=? AND status <> 'gone'").get(branchId) as { repoId: string; name: string } | undefined;
    if (!branch) return undefined;
    return { repoId: scope.repoId ?? branch.repoId, branchId, branch: branch.name, commitSha: "(legacy)", snapshotId: scope.snapshotId, trust: "fallback_live", degradationReason: "legacy branch index has no immutable source snapshot" };
  }
  const snapshot = store.db.prepare("SELECT repo_id AS repoId,commit_sha AS commitSha,worktree_fingerprint AS worktreeFingerprint FROM revision_snapshots WHERE id=?").get(scope.snapshotId) as { repoId: string; commitSha: string | null; worktreeFingerprint: string | null } | undefined;
  if (!snapshot || !scope.repoId) return undefined;
  const branch = store.db.prepare("SELECT id,name FROM branches WHERE current_snapshot_id=? AND repo_id=? ORDER BY default_branch DESC LIMIT 1").get(scope.snapshotId, scope.repoId) as { id: string; name: string } | undefined;
  // The legacy symbol index is branch-backed. A building snapshot that has not
  // yet been published to a branch must not be treated as a complete symbol
  // revision, otherwise newly inserted fixture/live-branch symbols disappear
  // from the compatibility lane while source search still has valid snapshot
  // data. Source/path lanes remain scoped by the resolved snapshot above.
  if (!branch) return undefined;
  return { repoId: scope.repoId, branchId: branch.id, branch: branch.name, commitSha: snapshot.commitSha ?? "", snapshotId: scope.snapshotId, ...(snapshot.worktreeFingerprint ? { worktreeFingerprint: snapshot.worktreeFingerprint } : {}), trust: snapshot.worktreeFingerprint ? "exact_worktree" : "exact_commit" };
}
function scopeRows(store: KnowledgeStore): ResolvedRevisionScope[] {
  return (store.db.prepare("SELECT repo_id AS repoId,id AS branchId,current_snapshot_id AS snapshotId FROM branches WHERE status='live' ORDER BY default_branch DESC,name").all() as Array<{ repoId: string; branchId: string; snapshotId: string | null }>).map((row) => ({ repoId: row.repoId, snapshotId: row.snapshotId ?? `legacy:${row.branchId}` }));
}
function hitId(scope: ResolvedRevisionScope, path: string, startByte = 0, endByte = 0, contentHash?: string): string { return `hit_${hash([scope.snapshotId, path, startByte, endByte, contentHash ?? null]).slice(0, 24)}`; }
const MAX_SEARCH_CANDIDATES = 5_000;
const MAX_TOTAL_SNIPPET_BYTES = 32_000;

function enforceResultBudgets(hits: SearchHit[]): { hits: SearchHit[]; truncated: boolean } {
  let remainingSnippetBytes = MAX_TOTAL_SNIPPET_BYTES;
  let truncated = hits.length > MAX_SEARCH_CANDIDATES;
  const bounded = hits.slice(0, MAX_SEARCH_CANDIDATES).map((hit) => {
    if (!hit.snippet) return hit;
    const bytes = Buffer.from(hit.snippet, "utf8");
    if (bytes.byteLength <= remainingSnippetBytes) {
      remainingSnippetBytes -= bytes.byteLength;
      return hit;
    }
    truncated = true;
    if (remainingSnippetBytes <= 0) return { ...hit, snippet: undefined };
    const snippet = bytes.subarray(0, remainingSnippetBytes).toString("utf8");
    remainingSnippetBytes = 0;
    return { ...hit, snippet };
  });
  return { hits: bounded, truncated };
}

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
  const startedAt = performance.now();
  const request = normalizeSearchRequest(input);
  const plan = planSearch(request);
  const semanticDeferred = plan.stages.some((stage) => stage.lane === "semantic");
  const availableScopes = context.scopes?.length ? context.scopes : scopeRows(context.store);
  const requestedRevisions = request.scope.revisions;
  const matchesRevision = (scope: ResolvedRevisionScope, revision: NonNullable<typeof requestedRevisions>[number]): boolean => {
    if (revision.snapshotId && revision.snapshotId !== scope.snapshotId) return false;
    if (revision.repoId && revision.repoId !== scope.repoId) return false;
    if (revision.repoName && scope.repoId && revision.repoName.toLocaleLowerCase() !== repoName(context.store, scope.repoId).toLocaleLowerCase()) return false;
    if (revision.branch && scope.repoId && !context.store.db.prepare("SELECT 1 FROM branches WHERE repo_id=? AND name=? AND (current_snapshot_id=? OR (? LIKE 'legacy:%' AND id=?))").get(scope.repoId, revision.branch, scope.snapshotId, scope.snapshotId, scope.snapshotId.replace(/^legacy:/, ""))) return false;
    return true;
  };
  const matchingScopes = requestedRevisions?.length
    ? availableScopes.filter((scope) => requestedRevisions.some((revision) => matchesRevision(scope, revision)))
    : availableScopes;
  const allRequestedScopesResolved = !requestedRevisions?.length
    || requestedRevisions.every((revision) => availableScopes.some((scope) => matchesRevision(scope, revision)));
  const scopes = allRequestedScopesResolved ? matchingScopes : [];
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
          // Loop-push, never push(...spread): a common query can match more
          // occurrences than the engine allows spread arguments, which throws
          // "Maximum call stack size exceeded".
          for (const item of result.hits) hits.push(sourceHit(scope, context.store, item, LANE_WEIGHTS.source, "verified regex occurrence"));
        } else {
          const callExpressionQuery = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\([^)]*\)\s*$/u.test(request.query);
          // Path scoping and the occurrence cap both live inside searchSource:
          // filtering there keeps the cap from being consumed by out-of-scope
          // occurrences, and everything past MAX_SEARCH_CANDIDATES would be
          // discarded by enforceResultBudgets anyway (the +1 preserves the
          // truncation signal).
          const occurrences = searchSource(context.store, scope, { query: request.query, mode: request.mode, options: request.options }, { signal: context.signal, maxOccurrences: MAX_SEARCH_CANDIDATES + 1, paths: request.scope.paths });
          for (const item of occurrences) hits.push(sourceHit(scope, context.store, item, callExpressionQuery ? 1.3 : request.mode === "exact" ? 1.1 : LANE_WEIGHTS.source, callExpressionQuery ? "verified exact call expression; call-site boost=0.3" : request.mode === "exact" ? "verified exact source occurrence; exact boost=0.1" : "verified source occurrence"));
        }
      } else if (stage.lane === "path") {
        for (const item of searchPath(context.store, scope, request.query, request.options.includeExcludedMetadata, request.options).filter((candidate) => !request.scope.paths?.length || request.scope.paths.some((prefix) => candidate.filePath === prefix || candidate.filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)))) {
          if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
          const locator = { repoId: scope.repoId ?? "", repoName: repoName(context.store, scope.repoId ?? ""), revisionId: scope.snapshotId, revisionKind: "commit" as const, filePath: item.filePath };
          const normalizedPath = request.query.replaceAll("\\", "/").replace(/^\.\//, "");
          const exactPath = item.filePath === normalizedPath;
          hits.push({ hitId: hitId(scope, item.filePath), kind: "path", lane: "path", title: item.filePath, locator, score: item.metadataOnly ? 0.7 : exactPath ? 1.2 : 1, rankReasons: [item.metadataOnly ? "excluded path metadata; secret_policy=path_only" : exactPath ? "exact full path; exact boost=0.2" : "path match", `coverage_status=${item.coverageStatus}`, `reason_code=${item.reasonCode}`], evidence: [{ source: "source", locator, status: item.metadataOnly ? "observed" : "verified" }] });
        }
      } else if (stage.lane === "symbol") {
        const identifierQuery = /^[A-Za-z_$][\w$]*$/u.test(request.query);
        const expansion = request.mode === "exact" || request.mode === "phrase" || request.mode === "path" || request.mode === "regex" || identifierQuery
          ? { terms: [], boost: 0, ambiguous: [] }
          : ontology.expansion(request.query, { ...(request.scope.workspaceId ? { workspaceId: request.scope.workspaceId } : {}), ...(scope.repoId ? { repoIds: [scope.repoId] } : {}) });
        if (expansion.ambiguous.length) warnings.push({ code: "ONTOLOGY_ALIAS_AMBIGUOUS", message: `alias has multiple ontology candidates: ${expansion.ambiguous.map((candidate) => candidate.canonicalName).join(", ")}` });
        const symbolQueries = [request.query, ...expansion.terms];
        for (const [query, expansionQuery] of symbolQueries.map((value, index) => [value, index > 0] as const)) for (const item of searchLegacyRows(context.store, query, { repo: scope.repoId, limit: request.page.limit, ...(revisionContext(context.store, scope) ? { revision: revisionContext(context.store, scope) } : {}) })) {
          if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
          const filePath = item.filePath;
          if (!filePath || (request.scope.paths?.length && !request.scope.paths.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)))) continue;
          const locatorRepoId = scope.repoId ?? (item.nodeId ? context.store.getNode(item.nodeId)?.repo_id : undefined) ?? "workspace";
          const symbolLine = item.startLine ?? (item.nodeId
            ? (context.store.db.prepare("SELECT start_line AS startLine FROM symbol_versions WHERE node_id=? AND status <> 'deleted' ORDER BY (status='fresh') DESC, start_line LIMIT 1").get(item.nodeId) as { startLine: number | null } | undefined)?.startLine ?? undefined
            : undefined);
          const locator = { repoId: locatorRepoId, repoName: repoName(context.store, locatorRepoId), revisionId: scope.snapshotId, revisionKind: "commit" as const, filePath, ...(item.nodeId ? { nodeId: item.nodeId } : {}), ...(symbolLine != null ? { startLine: symbolLine } : {}) };
          const symbolLane = item.nodeType === "note" ? "note" : "symbol";
          const exactSymbol = symbolLane === "symbol" && (item.title === request.query || item.identityKey === request.query);
          hits.push({ hitId: hitId(scope, filePath, item.startLine ?? 0), kind: item.nodeType, lane: symbolLane, title: item.title, locator, snippet: item.snippet ?? undefined, score: LANE_WEIGHTS[symbolLane] + (exactSymbol ? 0.1 : 0) + (expansionQuery ? expansion.boost : 0), rankReasons: [exactSymbol ? "exact symbol name; exact boost=0.1" : "indexed lexical symbol/name match", ...(expansionQuery ? ["ontology alias expansion; non-proof ranking boost=0.04"] : [])], evidence: [{ source: item.nodeType === "note" ? "note" : "graph", locator, excerpt: item.snippet ?? undefined, status: "verified" }] });
        }
      }
    }
  }
  const kindFiltered = request.scope.kinds?.length
    ? hits.filter((hit) => request.scope.kinds!.includes(hit.kind))
    : hits;
  const deduped = new Map<string, SearchHit>();
  for (const hit of kindFiltered) {
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
  const budgeted = enforceResultBudgets(rankSearchHits(adjusted));
  let ranked = budgeted.hits;
  const candidateCount = adjusted.length;
  if (after) { const index = ranked.findIndex((item) => item.hitId === after); if (index >= 0) ranked = ranked.slice(index + 1); else warnings.push({ code: "CURSOR_STALE", message: "cursor hit is not present in the current result set" }); }
  const pageHits = ranked.slice(0, request.page.limit);
  const last = pageHits.at(-1);
  const nextCursor = ranked.length > pageHits.length && last ? codec.encode({ schemaVersion: "1", queryHash: hash(request.query), normalizedRequestHash: normalizedHash, scopeHash: hash(scopes), mode: request.mode, lanes: plan.stages.map((stage) => stage.lane), lastRank: last.score, lastHitId: last.hitId, capabilityHash: capabilityHash(CAPABILITIES), expiresAt: new Date((context.now?.() ?? new Date()).getTime() + 15 * 60_000).toISOString() }) : undefined;
  const coverage = scopes.reduce((sum, scope) => { const row = context.store.db.prepare("SELECT COUNT(*) AS discovered, SUM(coverage_status='admitted') AS admitted, SUM(coverage_status<>'admitted') AS excluded, SUM(coverage_status='failed') AS failed, SUM(coverage_status='stale') AS stale FROM coverage_records WHERE repo_id=?").get(scope.repoId) as { discovered: number; admitted: number; excluded: number; failed: number; stale: number }; return { discovered: sum.discovered + (row?.discovered ?? 0), admitted: sum.admitted + (row?.admitted ?? 0), excluded: sum.excluded + (row?.excluded ?? 0), failed: sum.failed + (row?.failed ?? 0), stale: sum.stale + (row?.stale ?? 0) }; }, { discovered: 0, admitted: 0, excluded: 0, failed: 0, stale: 0 });
  const sourceFacts = Number((context.store.db.prepare("SELECT COUNT(*) AS n FROM source_facts").get() as { n: number }).n ?? 0);
  if (sourceFacts === 0 && plan.stages.some((stage) => stage.lane === "source")) warnings.push({ code: "SOURCE_NOT_INCLUDED", message: "the selected artifact/index contains no source corpus; graph and metadata may still be available, but exact source search cannot prove absence" });
  if (coverage.excluded > 0 || coverage.failed > 0) warnings.push({ code: "COVERAGE_INCOMPLETE", message: "coverage includes excluded or failed files; an empty result is not proof of absence" });
  if (coverage.stale > 0) warnings.push({ code: "INDEX_STALE", message: "one or more coverage records are stale; the result total is not exact" });
  if (semanticDeferred) warnings.push({ code: "SEMANTIC_LANE_UNAVAILABLE", message: "semantic search requires the async provider runtime; deterministic lanes are partial results" });
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
  const incomplete = coverage.failed > 0 || coverage.excluded > 0 || coverage.stale > 0 || semanticDeferred;
  const queryStatus = error
    ? "SCOPE_ERROR"
    : pageHits.length > 0
      ? "MATCH"
      : incomplete
        ? "NO_MATCH_INCOMPLETE"
        : "NO_MATCH_VERIFIED";
  const nextActions = error?.code === "REPOSITORY_NOT_FOUND"
    ? [{ command: "penguin init <repo-path>", reason: "register the requested repository before searching" }]
    : incomplete
      ? [{ command: "penguin index <repo-path>", reason: "refresh stale or failed coverage before relying on a negative result" }]
      : [];
  const deterministicLanes = plan.stages.map((stage) => stage.lane).filter((lane) => lane !== "semantic");
  return validateSearchResponse({ schemaVersion: "2", hits: pageHits, ...(error ? { error } : {}), diagnostics: { queryStatus, requestId: `search_${hash([normalizedHash, Date.now()]).slice(0, 16)}`, contractVersion: "2", capabilityHash: capabilityHash(CAPABILITIES), requestedScope: request.scope, resolvedScope: scopes.map((scope) => ({ repoId: scope.repoId ?? "", snapshotId: scope.snapshotId })), scopeApplied: allRequestedScopesResolved && (!requestedRevisions?.length || scopes.length > 0), resolvedScopes: scopes.map((scope) => ({ repoId: scope.repoId ?? "", branch: (storeBranch(context.store, scope.snapshotId) ?? ""), snapshotId: scope.snapshotId, revisionKind: "commit" as const })), searchedLanes: deterministicLanes, skippedLanes: semanticDeferred ? [{ lane: "semantic", reason: "async_semantic_lane_required" }] : [], coverage, exclusions, warnings, nextActions, suggestions, timingsMs: { total: Math.round((performance.now() - startedAt) * 1000) / 1000 }, candidateCount, truncated: budgeted.truncated }, page: { limit: request.page.limit, ...(nextCursor ? { nextCursor } : {}), totalIsExact, ...(totalIsExact ? { total: ranked.length } : {}) } });
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
  const skippedSemantic = (reason: string, message: string): SearchResponse => ({
    ...deterministic,
    diagnostics: {
      ...deterministic.diagnostics,
      searchedLanes: deterministic.diagnostics.searchedLanes.filter((lane) => lane !== "semantic"),
      skippedLanes: [
        ...deterministic.diagnostics.skippedLanes.filter((lane) => lane.lane !== "semantic"),
        { lane: "semantic", reason },
      ],
      warnings: [...warnings, { code: "SEMANTIC_LANE_UNAVAILABLE", message }],
      queryStatus: deterministic.hits.length > 0 ? "MATCH" : "NO_MATCH_INCOMPLETE",
    },
  });
  if (!context.semanticProvider) {
    return skippedSemantic("provider_not_configured", "semantic search was requested but no embedding provider is configured; deterministic lanes are partial results");
  }
  try {
    const providerHealth = await Promise.race([
      context.semanticProvider.health(),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("SEMANTIC_LANE_TIMEOUT"), { code: "SEMANTIC_LANE_TIMEOUT" })), 1_000)),
    ]);
    if (!providerHealth.ok) {
      return skippedSemantic("provider_unhealthy", providerHealth.reason ?? "embedding provider is unhealthy; deterministic lanes are partial results");
    }
  } catch (error) {
    return skippedSemantic((error as { code?: string }).code === "SEMANTIC_LANE_TIMEOUT" ? "timeout" : "provider_error", String((error as Error).message ?? error));
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
    return skippedSemantic("empty_corpus", "semantic search has no source documents in the resolved scopes");
  }
  let semanticHits;
  try { semanticHits = await semanticSearch(context.semanticProvider, request.query, documents, Math.max(50, request.page.limit)); }
  catch (error) { return skippedSemantic("provider_error", String((error as Error).message ?? error)); }
  const inferred: SearchHit[] = semanticHits.map((hit) => ({ hitId: `semantic_${hash(hit.id).slice(0, 24)}`, kind: "source_document", lane: "semantic", title: String((hit.locator as { filePath?: string }).filePath ?? hit.id), locator: hit.locator as SearchHit["locator"], score: semanticLaneScore(hit.similarity), rankReasons: [`semantic similarity ${hit.similarity.toFixed(4)}`, "semantic score normalized within semantic lane"], untrustedContent: true, evidence: [{ source: "semantic", locator: hit.locator as SearchHit["locator"], status: "inference" }] }));
  const merged = rankSearchHits([...deterministic.hits, ...inferred]).slice(0, request.page.limit);
  return { ...deterministic, hits: merged, diagnostics: { ...deterministic.diagnostics, searchedLanes: [...new Set([...deterministic.diagnostics.searchedLanes, "semantic" as const])], warnings }, page: { limit: request.page.limit, totalIsExact: false } };
}

function storeBranch(store: KnowledgeStore, snapshotId: string): string | undefined {
  if (snapshotId.startsWith("legacy:")) return (store.db.prepare("SELECT name FROM branches WHERE id=?").get(snapshotId.slice("legacy:".length)) as { name: string } | undefined)?.name;
  return (store.db.prepare("SELECT name FROM branches WHERE current_snapshot_id=? ORDER BY default_branch DESC LIMIT 1").get(snapshotId) as { name: string } | undefined)?.name;
}
