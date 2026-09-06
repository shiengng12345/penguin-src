import { createHash } from "node:crypto";
import { validateSearchRequest, validateSearchResponse, type NormalizedSearchRequest, type SearchHit, type SearchResponse, type SearchRequest } from "@penguin/knowledge-contracts";
import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import type { RevisionContext } from "./revision.js";
import { searchSource, searchSourceTerms, type ResolvedRevisionScope, type SourceSearchOccurrence } from "./source-search.js";
import { searchPath } from "./path-search.js";
import { searchRegex } from "./regex-search.js";
import { buildEvidenceEnvelope, searchLegacyRows } from "./query.js";
import { HmacSearchCursorCodec, resolveLocalCursorSecret } from "./search-cursor.js";
import { LANE_WEIGHTS, rankSearchHits, SEARCH_RANKER_VERSION } from "./search-ranking.js";
import { planSearch, SEARCH_PLANNER_VERSION } from "./search-planner.js";
import { fuseHybridHits, searchPersistedVectors } from "./hybrid-search.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { sanitizeUntrustedText } from "./content-safety.js";
import { OntologyStore } from "./ontology.js";
import { isWorkingTreeOverlaySnapshotKey, workingTreeRevisionKind } from "./working-tree-overlay.js";

export interface SearchContext {
  store: KnowledgeStore;
  scopes?: ResolvedRevisionScope[];
  cursorSecret?: string;
  now?: () => Date;
  semanticProvider?: EmbeddingProvider;
  semanticProviderFactory?: () => Promise<EmbeddingProvider | undefined>;
  signal?: AbortSignal;
}
const DEFAULT_CURSOR_SECRET = resolveLocalCursorSecret();

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
  const snapshot = store.db.prepare("SELECT repo_id AS repoId,commit_sha AS commitSha,worktree_fingerprint AS worktreeFingerprint,snapshot_key AS snapshotKey,base_snapshot_id AS baseSnapshotId,state FROM revision_snapshots WHERE id=? AND state='ready'").get(scope.snapshotId) as { repoId: string; commitSha: string | null; worktreeFingerprint: string | null; snapshotKey: string; baseSnapshotId: string | null; state: string } | undefined;
  if (!snapshot || !scope.repoId) return undefined;
  let branch = store.db.prepare("SELECT id,name FROM branches WHERE current_snapshot_id=? AND repo_id=? ORDER BY default_branch DESC LIMIT 1").get(scope.snapshotId, scope.repoId) as { id: string; name: string } | undefined;
  if (!branch && isWorkingTreeOverlaySnapshotKey(snapshot.snapshotKey)) {
    const seen = new Set<string>();
    let baseId = snapshot.baseSnapshotId;
    while (baseId && !seen.has(baseId) && !branch) {
      seen.add(baseId);
      branch = store.db.prepare("SELECT id,name FROM branches WHERE current_snapshot_id=? AND repo_id=? ORDER BY default_branch DESC LIMIT 1").get(baseId, scope.repoId) as { id: string; name: string } | undefined;
      if (branch) break;
      baseId = (store.db.prepare("SELECT base_snapshot_id AS baseSnapshotId FROM revision_snapshots WHERE id=? AND state='ready'").get(baseId) as { baseSnapshotId: string | null } | undefined)?.baseSnapshotId ?? null;
    }
  }
  // The legacy symbol index is branch-backed. A building snapshot that has not
  // yet been published to a branch must not be treated as a complete symbol
  // revision, otherwise newly inserted fixture/live-branch symbols disappear
  // from the compatibility lane while source search still has valid snapshot
  // data. Source/path lanes remain scoped by the resolved snapshot above.
  if (!branch && !isWorkingTreeOverlaySnapshotKey(snapshot.snapshotKey)) return undefined;
  return { repoId: scope.repoId, ...(branch ? { branchId: branch.id, branch: branch.name } : {}), commitSha: snapshot.commitSha ?? "", snapshotId: scope.snapshotId, ...(snapshot.worktreeFingerprint ? { worktreeFingerprint: snapshot.worktreeFingerprint } : {}), trust: isWorkingTreeOverlaySnapshotKey(snapshot.snapshotKey) ? "exact_worktree" : "exact_commit" };
}
function scopeRows(store: KnowledgeStore): ResolvedRevisionScope[] {
  return (store.db.prepare("SELECT repo_id AS repoId,id AS branchId,current_snapshot_id AS snapshotId FROM branches WHERE status='live' ORDER BY default_branch DESC,name").all() as Array<{ repoId: string; branchId: string; snapshotId: string | null }>).map((row) => ({ repoId: row.repoId, snapshotId: row.snapshotId ?? `legacy:${row.branchId}` }));
}
function hitId(scope: ResolvedRevisionScope, path: string, startByte = 0, endByte = 0, contentHash?: string): string { return `hit_${hash([scope.snapshotId, path, startByte, endByte, contentHash ?? null]).slice(0, 24)}`; }
const MAX_SEARCH_CANDIDATES = 5_000;
const MAX_TOTAL_SNIPPET_BYTES = 32_000;
const MAX_GLOBAL_SEARCH_SCOPES = 4;
const DEFAULT_GLOBAL_SEARCH_BUDGET_MS = 10_000;
const LOW_VECTOR_SIMILARITY_THRESHOLD = 0.2;

function publicSearchError(code: string, message: string, details: Record<string, unknown>): Error & { code: string; details: Record<string, unknown>; retryable: false } {
  return Object.assign(new Error(message), { code, details, retryable: false as const });
}

/** Strict validation belongs at the exported core boundary, not only in CLI
 * and MCP adapters. The shared contract validator owns the canonical grammar;
 * this small preflight supplies the stable INVALID_QUERY code and closes the
 * paths element-type gap that the current contract validator does not inspect. */
function validatePublicSearchRequest(input: unknown): NormalizedSearchRequest {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (!record || typeof record.query !== "string" || !record.query.trim()) {
    throw publicSearchError("INVALID_QUERY", "search query must be a non-empty string", { path: "request.query" });
  }
  const scope = record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
    ? record.scope as Record<string, unknown>
    : null;
  if (scope?.paths !== undefined
    && (!Array.isArray(scope.paths)
      || scope.paths.some((path) => typeof path !== "string" || !path.trim()))) {
    throw publicSearchError("INVALID_SEARCH_REQUEST", "request.scope.paths must be an array of non-empty strings", { path: "request.scope.paths" });
  }
  try {
    return validateSearchRequest(input);
  } catch (error) {
    const details = (error as { details?: Record<string, unknown> }).details;
    if (details?.path === "request.query") {
      throw publicSearchError("INVALID_QUERY", (error as Error).message, details);
    }
    throw error;
  }
}

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
type SourceHitItem = Pick<SourceSearchOccurrence, "sourceFactId" | "contentHash" | "filePath" | "startLine" | "endLine" | "startByte" | "endByte" | "snippet" | "reasonCode">;

function sourceHits(scope: ResolvedRevisionScope, store: KnowledgeStore, items: SourceHitItem[], score: number, reason: string, branchId?: string, revisionKind: "commit" | "working_tree" = "commit"): SearchHit[] {
  if (items.length === 0) return [];
  const repo = scope.repoId ?? (store.db.prepare("SELECT repo_id FROM source_facts WHERE id=?").get(items[0].sourceFactId) as { repo_id: string }).repo_id;
  // A caller may provide an immutable snapshot without the branch metadata
  // that produced it. Resolve that snapshot back to its owning branch before
  // hydrating symbol coordinates; otherwise identical files from another
  // branch can win the containment query and produce a false nodeId.
  const effectiveBranchId = branchId ?? (
    scope.snapshotId.startsWith("legacy:")
      ? undefined
      : (store.db.prepare(
        "SELECT id FROM branches WHERE repo_id=? AND current_snapshot_id=? ORDER BY default_branch DESC, id LIMIT 1",
      ).get(repo, scope.snapshotId) as { id: string } | undefined)?.id
  );
  const resolvedRepoName = repoName(store, repo);
  type SymbolRow = { filePath: string; startLine: number; endLine: number; nodeId: string; title: string };
  const symbolsByFile = new Map<string, SymbolRow[]>();
  const paths = [...new Set(items.map((item) => item.filePath))];

  // Hydrate candidate symbols once per path batch. The old per-occurrence
  // containment query produced more than 10,000 SQLite round trips for common
  // terms in a full workspace and made MCP hit its 30-second timeout.
  for (let offset = 0; offset < paths.length; offset += 500) {
    const batch = paths.slice(offset, offset + 500);
    const params: unknown[] = [];
    let sql = `SELECT sv.file_path AS filePath, sv.start_line AS startLine,
      sv.end_line AS endLine, sv.node_id AS nodeId, n.title AS title
      FROM symbol_versions sv JOIN nodes n ON n.id=sv.node_id
      WHERE sv.status='fresh' AND sv.start_line IS NOT NULL AND sv.end_line IS NOT NULL`;
    if (effectiveBranchId) { sql += " AND sv.branch_id=?"; params.push(effectiveBranchId); }
    sql += " AND n.repo_id=?"; params.push(repo);
    sql += ` AND sv.file_path IN (${batch.map(() => "?").join(",")})
      ORDER BY sv.file_path, (sv.end_line - sv.start_line), sv.start_line DESC, sv.node_id`;
    params.push(...batch);
    for (const row of store.db.prepare(sql).all(...params) as SymbolRow[]) {
      const rows = symbolsByFile.get(row.filePath) ?? [];
      rows.push(row);
      symbolsByFile.set(row.filePath, rows);
    }
  }

  return items.map((item) => {
    const locator = { repoId: repo, repoName: resolvedRepoName, revisionId: scope.snapshotId, revisionKind, filePath: item.filePath, startLine: item.startLine, endLine: item.endLine, startByte: item.startByte, endByte: item.endByte, offsetEncoding: "utf8_normalized" as const };
    const untrusted = item.reasonCode?.startsWith("external_") === true;
    const safe = sanitizeUntrustedText(item.snippet);
    // The first containing row is the innermost symbol because the batch query
    // orders each file by span. Branch scoping prevents cross-revision node IDs.
    const symbol = symbolsByFile.get(item.filePath)?.find((candidate) => candidate.startLine <= item.startLine && candidate.endLine >= item.startLine);
    const resolvedLocator = symbol ? { ...locator, nodeId: symbol.nodeId } : locator;
    return { hitId: hitId(scope, item.filePath, item.startByte, item.endByte, item.contentHash), kind: "source_occurrence", lane: "source", title: item.filePath, locator: resolvedLocator, snippet: safe.text, untrustedContent: true, score, rankReasons: [reason, ...(untrusted ? ["external content is untrusted"] : []), ...(safe.redacted ? ["secret content redacted"] : [])], evidence: [{ source: "source", locator: resolvedLocator, excerpt: safe.text, contentHash: item.contentHash, status: untrusted ? "observed" : "verified" }],
      ...(symbol ? { nodeId: symbol.nodeId, symbol: symbol.title } : {}) };
  });
}

function pathMatches(filePath: string, prefixes: string[] | undefined): boolean {
  return !prefixes?.length || prefixes.some((prefix) => {
    const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return filePath === normalized || filePath.startsWith(`${normalized}/`);
  });
}

function effectiveSearchPaths(request: NormalizedSearchRequest, parsed: ReturnType<typeof planSearch>["parsed"]): string[] | undefined {
  const paths = [...(request.scope.paths ?? []), ...(parsed.path ? [parsed.path] : [])]
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter(Boolean);
  return paths.length ? [...new Set(paths)] : undefined;
}

function lexicalQueries(parsed: ReturnType<typeof planSearch>["parsed"]): string[] {
  if (parsed.intent === "business_intent") return parsed.terms;
  if (parsed.intent === "path_qualified" && parsed.identifier) return [parsed.identifier];
  return [parsed.identifier ?? parsed.raw];
}

function sourceTermOccurrences(
  store: KnowledgeStore,
  scope: ResolvedRevisionScope,
  request: NormalizedSearchRequest,
  queries: string[],
  paths: string[] | undefined,
  signal: AbortSignal | undefined,
): Array<{ item: SourceSearchOccurrence; coverage: number; fileCoverage: number; totalTerms: number }> {
  const uniqueQueries = [...new Set(queries)];
  const totalTerms = uniqueQueries.length;
  const searchOptions = parsedBusinessOptions(request, uniqueQueries);
  const byOccurrence = new Map<string, { item: SourceSearchOccurrence; terms: Set<string> }>();
  const termsByFile = new Map<string, Set<string>>();
  const occurrences = searchSourceTerms(
    store,
    scope,
    uniqueQueries,
    { mode: request.mode === "lexical" || request.mode === "structural" ? "substring" : request.mode, options: searchOptions },
    {
      signal,
      maxOccurrencesPerTerm: MAX_SEARCH_CANDIDATES + 1,
      // Natural-language discovery needs one representative per term/file;
      // a one-term exact/phrase/substring query is an occurrence query and
      // must retain every location for stable cursor pagination.
      ...(uniqueQueries.length > 1 ? { maxOccurrencesPerTermPerBlob: 1 } : {}),
      paths,
    },
  );
  for (const { item, term } of occurrences) {
    // One source blob may be materialized at many snapshot paths. The path
    // is part of the hit identity; omitting it collapses distinct files and
    // silently under-counts broad queries.
    const key = `${item.sourceFactId}:${item.filePath}:${item.startByte}:${item.endByte}`;
    const fileKey = `${item.sourceFactId}:${item.filePath}`;
    const normalizedTerm = term.toLocaleLowerCase();
    const fileTerms = termsByFile.get(fileKey) ?? new Set<string>();
    fileTerms.add(normalizedTerm);
    termsByFile.set(fileKey, fileTerms);
    const existing = byOccurrence.get(key);
    if (existing) existing.terms.add(normalizedTerm);
    else byOccurrence.set(key, { item, terms: new Set([normalizedTerm]) });
  }
  const rankedOccurrences = [...byOccurrence.values()].map(({ item, terms }) => {
    const localText = `${item.filePath}\n${item.snippet}`.toLocaleLowerCase();
    const localCoverage = uniqueQueries.filter((query) => localText.includes(query.toLocaleLowerCase())).length;
    return {
      item,
      // Rank the evidence window the user will actually receive. File-wide
      // coverage is useful diagnostics but must not make every occurrence in
      // a README or generated bundle look like a 5/5 natural-language match.
      coverage: Math.max(terms.size, localCoverage),
      fileCoverage: termsByFile.get(`${item.sourceFactId}:${item.filePath}`)?.size ?? terms.size,
      totalTerms,
    };
  });
  if (uniqueQueries.length <= 1) return rankedOccurrences;
  // A natural-language query is trying to discover relevant files/symbols,
  // not enumerate every occurrence of every common token. Keep the strongest
  // evidence window per materialized file so one rich README or generated
  // source cannot consume the entire first page with near-identical hits.
  const bestByFile = new Map<string, (typeof rankedOccurrences)[number]>();
  for (const candidate of rankedOccurrences) {
    const key = `${candidate.item.sourceFactId}:${candidate.item.filePath}`;
    const current = bestByFile.get(key);
    if (!current
      || candidate.coverage > current.coverage
      || (candidate.coverage === current.coverage && candidate.item.snippet.length < current.item.snippet.length)
      || (candidate.coverage === current.coverage && candidate.item.snippet.length === current.item.snippet.length && candidate.item.startByte < current.item.startByte)) {
      bestByFile.set(key, candidate);
    }
  }
  return [...bestByFile.values()];
}

function parsedBusinessOptions(
  request: NormalizedSearchRequest,
  queries: string[],
): NormalizedSearchRequest["options"] {
  // Natural-language intent is case-insensitive; identifier/path queries keep
  // the caller's exactness settings so case-sensitive source lookups remain
  // available for code symbols and literals.
  return queries.length > 1 ? { ...request.options, caseSensitive: false } : request.options;
}

interface SemanticProgressSummary {
  expected: number;
  ready: number;
  activeGenerationIds: string[];
}

function semanticProgressForScopes(
  store: KnowledgeStore,
  scopes: ResolvedRevisionScope[],
): SemanticProgressSummary {
  const summary: SemanticProgressSummary = { expected: 0, ready: 0, activeGenerationIds: [] };
  const activeGenerationIds = new Set<string>();
  const scopeKeys = new Set(
    scopes
      .map((scope) => scope.repoId ? `repo:${scope.repoId}` : null)
      .filter((scopeKey): scopeKey is string => Boolean(scopeKey)),
  );
  const statement = store.db.prepare(`
    SELECT g.expected_chunks AS expected,
           COALESCE(SUM(j.status='ready'),0) AS ready,
           active.generation_id AS activeGenerationId
      FROM embedding_generations g
     LEFT JOIN embedding_jobs j ON j.generation_id=g.id
     LEFT JOIN semantic_active_spaces active ON active.scope_key=g.scope_key
     WHERE g.id=COALESCE(
       (SELECT generation_id FROM semantic_active_spaces WHERE scope_key=?),
       (SELECT id FROM embedding_generations WHERE scope_key=? AND status='staging' ORDER BY created_at DESC,id DESC LIMIT 1),
       (SELECT id FROM embedding_generations WHERE scope_key=? AND status='active' ORDER BY created_at DESC,id DESC LIMIT 1)
     )
     GROUP BY g.id
  `);
  for (const scopeKey of scopeKeys) {
    const row = statement.get(scopeKey, scopeKey, scopeKey) as { expected: number; ready: number; activeGenerationId: string | null } | undefined;
    if (!row) continue;
    summary.expected += Number(row.expected);
    summary.ready += Number(row.ready);
    if (row.activeGenerationId) activeGenerationIds.add(row.activeGenerationId);
  }
  summary.activeGenerationIds = [...activeGenerationIds];
  return summary;
}

export function searchKnowledge(input: SearchRequest | NormalizedSearchRequest, context: SearchContext): SearchResponse {
  const startedAt = performance.now();
  const request = validatePublicSearchRequest(input);
  const scopeResolutionStartedAt = performance.now();
  const phaseTimings: Record<string, number> = {};
  const elapsedMs = (phaseStartedAt: number) => Math.round((performance.now() - phaseStartedAt) * 1000) / 1000;
  const plan = planSearch(request);
  const parsedQuery = plan.parsed;
  const searchPaths = effectiveSearchPaths(request, parsedQuery);
  const searchQueries = lexicalQueries(parsedQuery);
  const semanticDeferred = plan.stages.some((stage) => stage.lane === "semantic");
  const allAvailableScopes = context.scopes?.length ? context.scopes : scopeRows(context.store);
  const workspaceId = request.scope.workspaceId;
  const workspace = workspaceId
    ? context.store.db.prepare("SELECT id,name FROM workspaces WHERE id=?").get(workspaceId) as { id: string; name: string } | undefined
    : undefined;
  const workspaceRepoIds = workspace ? new Set(context.store.workspaceRepoIds(workspace.id)) : null;
  const workspaceScopeError = workspaceId && !workspace
    ? {
        code: "WORKSPACE_NOT_FOUND" as const,
        message: `requested workspace ${workspaceId} was not found`,
        details: { workspaceId },
        retryable: false,
      }
    : workspaceRepoIds && workspaceRepoIds.size === 0
      ? {
          code: "SCOPE_EMPTY" as const,
          message: `requested workspace ${workspaceId} contains no repositories`,
          details: { workspaceId },
          retryable: false,
        }
      : undefined;
  const availableScopes = workspaceRepoIds
    ? allAvailableScopes.filter((scope) => Boolean(scope.repoId && workspaceRepoIds.has(scope.repoId)))
    : allAvailableScopes;
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
  const unresolvedRevision = requestedRevisions?.find((revision) => !availableScopes.some((scope) => matchesRevision(scope, revision)));
  const requestedRepoIds = unresolvedRevision
    ? unresolvedRevision.repoId
      ? [unresolvedRevision.repoId]
      : unresolvedRevision.repoName
        ? context.store.resolveRepoIds(unresolvedRevision.repoName)
        : []
    : [];
  const revisionScopeError = unresolvedRevision
    ? requestedRepoIds.length === 0
      ? {
          code: "REPOSITORY_NOT_FOUND",
          message: "requested repository was not found in the indexed knowledge store",
          details: { revision: unresolvedRevision },
          retryable: false,
        }
      : unresolvedRevision.branch
        ? {
            code: "BRANCH_NOT_FOUND",
            message: `requested branch ${unresolvedRevision.branch} was not found in the indexed repository`,
            details: { revision: unresolvedRevision, repoIds: requestedRepoIds },
            retryable: false,
          }
        : {
            code: "REVISION_NOT_FOUND",
            message: "requested revision was not found in the indexed knowledge store",
            details: { revision: unresolvedRevision, repoIds: requestedRepoIds },
            retryable: false,
          }
    : undefined;
  const globalScopeCapped = !workspaceId && !requestedRevisions?.length && matchingScopes.length > MAX_GLOBAL_SEARCH_SCOPES;
  const scopes = !workspaceScopeError && allRequestedScopesResolved && !revisionScopeError
    ? (globalScopeCapped ? matchingScopes.slice(0, MAX_GLOBAL_SEARCH_SCOPES) : matchingScopes)
    : [];
  const missingPath = !workspaceScopeError && !revisionScopeError && searchPaths?.find((requestedPath) => {
    const normalizedPath = requestedPath.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    const prefix = `${normalizedPath}/%`;
    return !scopes.some((scope) => {
      if (!scope.repoId) return false;
      const branchId = revisionContext(context.store, scope)?.branchId;
      const present = context.store.db.prepare(`
        SELECT 1 FROM coverage_records WHERE repo_id=? AND (file_path=? OR file_path LIKE ?)
        UNION ALL SELECT 1 FROM source_facts WHERE repo_id=? AND (file_path=? OR file_path LIKE ?)
        UNION ALL SELECT 1 FROM files_index WHERE repo_id=? ${branchId ? "AND branch_id=?" : ""} AND (file_path=? OR file_path LIKE ?)
        UNION ALL SELECT 1 FROM symbol_versions sv JOIN nodes n ON n.id=sv.node_id
          WHERE n.repo_id=? ${branchId ? "AND sv.branch_id=?" : ""} AND sv.status<>'deleted' AND (sv.file_path=? OR sv.file_path LIKE ?)
        LIMIT 1
      `).get(
        scope.repoId, normalizedPath, prefix,
        scope.repoId, normalizedPath, prefix,
        scope.repoId, ...(branchId ? [branchId] : []), normalizedPath, prefix,
        scope.repoId, ...(branchId ? [branchId] : []), normalizedPath, prefix,
      );
      return Boolean(present);
    });
  });
  const scopeError = workspaceScopeError ?? revisionScopeError ?? (missingPath
    ? {
        code: "FILE_NOT_FOUND",
        message: `requested file scope ${missingPath} was not found in the resolved revision`,
        details: { filePath: missingPath, revisions: requestedRevisions ?? [] },
        retryable: false,
      }
    : undefined);
  phaseTimings.scopeResolution = elapsedMs(scopeResolutionStartedAt);
  const secret = context.cursorSecret ?? DEFAULT_CURSOR_SECRET;
  const codec = new HmacSearchCursorCodec(secret, () => (context.now?.() ?? new Date()).getTime());
  const normalizedHash = hash({
    plannerVersion: SEARCH_PLANNER_VERSION,
    rankerVersion: SEARCH_RANKER_VERSION,
    parsedQuery,
    searchPaths,
    searchQueries,
    ...request,
    page: { limit: request.page.limit },
  });
  let after: string | undefined;
  const warnings: Array<{ code: string; message: string }> = [];
  if (globalScopeCapped) {
    warnings.push({
      code: "GLOBAL_SCOPE_CAPPED",
      message: `unscoped search is limited to ${MAX_GLOBAL_SEARCH_SCOPES} repositories; pass an explicit scope for complete coverage`,
    });
  }
  const ontology = new OntologyStore(context.store);
  if (request.page.cursor) {
    try {
      const cursor = codec.decode(request.page.cursor);
      if (cursor.normalizedRequestHash !== normalizedHash || cursor.capabilityHash !== capabilityHash(CAPABILITIES)) throw new Error("CURSOR_STALE");
      after = cursor.lastHitId;
    } catch (error) {
      const message = String((error as Error).message);
      const code = message.includes("OPERATION_MISMATCH") ? "CURSOR_OPERATION_MISMATCH" : message.includes("EXPIRED") ? "CURSOR_EXPIRED" : message.includes("STALE") ? "CURSOR_STALE" : "CURSOR_INVALID";
      throw Object.assign(new Error(code), {
        code,
        retryable: false,
        details: { remediation: "restart search pagination from the first page using the same scope, query, mode, options, and limit" },
      });
    }
  }
  const hits: SearchHit[] = [];
  const executedDeterministicLanes = new Set<string>();
  const requestedKinds = request.scope.kinds?.length ? new Set(request.scope.kinds) : null;
  const sourceLaneRequested = (!requestedKinds || requestedKinds.has("source_occurrence"))
    && plan.stages.some((stage) => stage.lane === "source");
  let globalBudgetExceeded = false;
  const globalBudgetMs = Number(process.env.PENGUIN_GLOBAL_SEARCH_BUDGET_MS ?? DEFAULT_GLOBAL_SEARCH_BUDGET_MS);
  const candidateSelectionStartedAt = performance.now();
  searchScopes: for (const scope of scopes) {
    if (!requestedRevisions?.length && performance.now() - startedAt >= globalBudgetMs) {
      globalBudgetExceeded = true;
      break searchScopes;
    }
    const scopedRevision = revisionContext(context.store, scope);
    const scopedRevisionKind = workingTreeRevisionKind(scopedRevision ?? { trust: "exact_commit" });
    if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
    for (const stage of plan.stages) {
      if (!requestedRevisions?.length && performance.now() - startedAt >= globalBudgetMs) {
        globalBudgetExceeded = true;
        break searchScopes;
      }
      if (requestedKinds) {
        if (stage.lane === "source" && !requestedKinds.has("source_occurrence")) continue;
        if (stage.lane === "path" && !requestedKinds.has("path")) continue;
        if (stage.lane === "symbol" && [...requestedKinds].every((kind) => kind === "source_occurrence" || kind === "path")) continue;
      }
      if (stage.lane !== "semantic") executedDeterministicLanes.add(stage.lane);
      if (stage.lane === "source") {
        if (request.mode === "regex") {
          const result = searchRegex(context.store, scope, request.query, { allowPartial: false });
          if (result.status === "error") { warnings.push({ code: result.code, message: result.message }); continue; }
          // Loop-push, never push(...spread): a common query can match more
          // occurrences than the engine allows spread arguments, which throws
          // "Maximum call stack size exceeded".
          for (const hit of sourceHits(scope, context.store, result.hits, LANE_WEIGHTS.source, "verified regex occurrence", scopedRevision?.branchId, scopedRevisionKind)) hits.push(hit);
        } else {
          const callExpressionQuery = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\([^)]*\)\s*$/u.test(request.query);
          const termOccurrences = sourceTermOccurrences(context.store, scope, request, searchQueries, searchPaths, context.signal);
          for (const { item, coverage, fileCoverage, totalTerms } of termOccurrences) {
            const businessIntent = parsedQuery.intent === "business_intent";
            const score = businessIntent
              ? LANE_WEIGHTS.source
                + coverage / Math.max(1, totalTerms) * 0.35
                + fileCoverage / Math.max(1, totalTerms) * 0.05
              : callExpressionQuery
                ? 1.3
                : request.mode === "exact"
                  ? 1.1
                  : LANE_WEIGHTS.source;
            const reason = businessIntent
              ? `business intent term coverage=${coverage}/${totalTerms}`
              : callExpressionQuery
                ? "verified exact call expression; call-site boost=0.3"
                : request.mode === "exact"
                  ? "verified exact source occurrence; exact boost=0.1"
                  : "verified source occurrence";
            for (const hit of sourceHits(scope, context.store, [item], score, reason, scopedRevision?.branchId, scopedRevisionKind)) {
              if (businessIntent) hit.rankReasons.push(`business intent file coverage=${fileCoverage}/${totalTerms}`);
              hits.push(hit);
            }
          }
        }
      } else if (stage.lane === "path") {
        const pathQuery = parsedQuery.path ?? request.query;
        for (const item of searchPath(context.store, scope, pathQuery, request.options.includeExcludedMetadata, request.options).filter((candidate) => pathMatches(candidate.filePath, request.scope.paths))) {
          if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
          const locator = { repoId: scope.repoId ?? "", repoName: repoName(context.store, scope.repoId ?? ""), revisionId: scope.snapshotId, revisionKind: scopedRevisionKind, filePath: item.filePath };
          const normalizedPath = pathQuery.replaceAll("\\", "/").replace(/^\.\//, "");
          const exactPath = item.filePath === normalizedPath;
          hits.push({ hitId: hitId(scope, item.filePath), kind: "path", lane: "path", title: item.filePath, locator, score: item.metadataOnly ? 0.7 : exactPath ? 1.2 : 1, rankReasons: [item.metadataOnly ? "excluded path metadata; secret_policy=path_only" : exactPath ? "exact full path; exact boost=0.2" : "path match", `coverage_status=${item.coverageStatus}`, `reason_code=${item.reasonCode}`], evidence: [{ source: "source", locator, status: item.metadataOnly ? "observed" : "verified" }] });
        }
      } else if (stage.lane === "symbol") {
        const identifierQuery = parsedQuery.intent === "exact_identifier" || parsedQuery.intent === "path_qualified";
        const expansion = parsedQuery.intent === "business_intent" || request.mode === "exact" || request.mode === "phrase" || request.mode === "path" || request.mode === "regex" || identifierQuery
          ? { terms: [], boost: 0, ambiguous: [] }
          : ontology.expansion(request.query, { ...(request.scope.workspaceId ? { workspaceId: request.scope.workspaceId } : {}), ...(scope.repoId ? { repoIds: [scope.repoId] } : {}) });
        if (expansion.ambiguous.length) warnings.push({ code: "ONTOLOGY_ALIAS_AMBIGUOUS", message: `alias has multiple ontology candidates: ${expansion.ambiguous.map((candidate) => candidate.canonicalName).join(", ")}` });
        const symbolQueries = parsedQuery.intent === "business_intent" || parsedQuery.intent === "path_qualified"
          ? searchQueries
          : [request.query, ...expansion.terms];
        const symbolMatches = new Map<string, { item: ReturnType<typeof searchLegacyRows>[number]; terms: Set<string>; expansionQuery: boolean }>();
        for (const [query, expansionQuery] of symbolQueries.map((value, index) => [value, index > 0 && parsedQuery.intent !== "business_intent" && parsedQuery.intent !== "path_qualified"] as const)) {
          for (const item of searchLegacyRows(context.store, query, {
            repo: scope.repoId,
            limit: request.page.limit,
            ...(request.scope.kinds?.length ? { type: request.scope.kinds } : {}),
            ...(scopedRevision ? { revision: scopedRevision } : {}),
          })) {
            const key = `${item.nodeId ?? item.filePath}:${item.startLine ?? 0}`;
            const existing = symbolMatches.get(key);
            if (existing) {
              existing.terms.add(query.toLocaleLowerCase());
              existing.expansionQuery = existing.expansionQuery || expansionQuery;
            } else {
              symbolMatches.set(key, { item, terms: new Set([query.toLocaleLowerCase()]), expansionQuery });
            }
          }
        }
        for (const { item, terms, expansionQuery } of symbolMatches.values()) {
          if (context.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
          const filePath = item.filePath;
          if (!filePath || !pathMatches(filePath, searchPaths)) continue;
          const locatorRepoId = scope.repoId ?? (item.nodeId ? context.store.getNode(item.nodeId)?.repo_id : undefined) ?? "workspace";
          const symbolLine = item.startLine ?? (item.nodeId
            ? (context.store.db.prepare("SELECT start_line AS startLine FROM symbol_versions WHERE node_id=? AND status <> 'deleted' ORDER BY (status='fresh') DESC, start_line LIMIT 1").get(item.nodeId) as { startLine: number | null } | undefined)?.startLine ?? undefined
            : undefined);
          const locator = { repoId: locatorRepoId, repoName: repoName(context.store, locatorRepoId), revisionId: scope.snapshotId, revisionKind: scopedRevisionKind, filePath, ...(item.nodeId ? { nodeId: item.nodeId } : {}), ...(symbolLine != null ? { startLine: symbolLine } : {}) };
          const symbolLane = item.nodeType === "note" ? "note" : item.nodeId ? "symbol" : "source";
          const exactSymbol = symbolLane === "symbol" && Boolean(parsedQuery.identifier) && (item.title.toLocaleLowerCase() === parsedQuery.identifier!.toLocaleLowerCase() || item.identityKey.toLocaleLowerCase() === parsedQuery.identifier!.toLocaleLowerCase());
          const businessIntent = parsedQuery.intent === "business_intent";
          const termCoverage = businessIntent ? terms.size : 0;
          const totalTerms = businessIntent ? searchQueries.length : 0;
          hits.push({
            hitId: hitId(scope, filePath, item.startLine ?? 0),
            kind: item.nodeId ? item.nodeType : "source_occurrence",
            lane: symbolLane,
            title: item.title,
            locator,
            ...(item.nodeId ? { nodeId: item.nodeId } : {}),
            snippet: item.snippet ?? undefined,
            score: LANE_WEIGHTS[symbolLane] + (exactSymbol ? 0.1 : 0) + (businessIntent ? termCoverage / Math.max(1, totalTerms) * 0.3 : 0) + (expansionQuery ? expansion.boost : 0),
            rankReasons: [exactSymbol ? "exact symbol name; exact boost=0.1" : businessIntent ? `business intent term coverage=${termCoverage}/${totalTerms}` : item.nodeId ? "indexed lexical symbol/name match" : "indexed source-only occurrence", ...(expansionQuery ? ["ontology alias expansion; non-proof ranking boost=0.04"] : [])],
            evidence: [{ source: item.nodeId ? (item.nodeType === "note" ? "note" : "graph") : "source", locator, excerpt: item.snippet ?? undefined, status: "verified" }],
          });
        }
      }
    }
  }
  if (globalBudgetExceeded) {
    warnings.push({
      code: "TIMEOUT_PARTIAL",
      message: `global search stopped after ${globalBudgetMs}ms; results cover only the repositories listed in searchedRepos`,
    });
  }
  const kindFiltered = request.scope.kinds?.length
    ? hits.filter((hit) => request.scope.kinds!.includes(hit.kind))
    : hits;
  const deduped = new Map<string, SearchHit>();
  for (const hit of kindFiltered) {
    // A symbol declaration and a source occurrence can legitimately share the
    // same line/range. Keep both candidates so the rank tuple can prefer the
    // exact graph identity instead of letting source-score deduplication erase
    // the only round-trippable node hit.
    const key = `${hit.locator.revisionId}:${hit.locator.filePath}:${hit.locator.startByte ?? hit.locator.startLine ?? 0}:${hit.locator.endByte ?? hit.locator.endLine ?? 0}:${hit.lane}:${hit.nodeId ?? ""}`;
    const old = deduped.get(key);
    if (!old) deduped.set(key, hit);
    else if (hit.score >= old.score) deduped.set(key, { ...hit, evidence: [...old.evidence, ...hit.evidence], rankReasons: [...new Set([...old.rankReasons, ...hit.rankReasons])] });
      else deduped.set(key, { ...old, evidence: [...old.evidence, ...hit.evidence], rankReasons: [...new Set([...old.rankReasons, ...hit.rankReasons])] });
  }
  phaseTimings.candidateSelection = elapsedMs(candidateSelectionStartedAt);
  const countStartedAt = performance.now();
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
  const budgeted = enforceResultBudgets(rankSearchHits(adjusted, parsedQuery));
  let ranked = budgeted.hits;
  const candidateCount = adjusted.length;
  phaseTimings.count = elapsedMs(countStartedAt);
  const hydrationStartedAt = performance.now();
  if (after) { const index = ranked.findIndex((item) => item.hitId === after); if (index >= 0) ranked = ranked.slice(index + 1); else warnings.push({ code: "CURSOR_STALE", message: "cursor hit is not present in the current result set" }); }
  const pageHits = ranked.slice(0, request.page.limit);
  phaseTimings.hydration = elapsedMs(hydrationStartedAt);
  const last = pageHits.at(-1);
  const nextCursor = ranked.length > pageHits.length && last ? codec.encode({ schemaVersion: "1", queryHash: hash(request.query), normalizedRequestHash: normalizedHash, scopeHash: hash(scopes), mode: request.mode, lanes: plan.stages.map((stage) => stage.lane), lastRank: last.score, lastHitId: last.hitId, capabilityHash: capabilityHash(CAPABILITIES), expiresAt: new Date((context.now?.() ?? new Date()).getTime() + 15 * 60_000).toISOString() }) : undefined;
  const responseTruncated = Boolean(nextCursor) || budgeted.truncated || globalScopeCapped || globalBudgetExceeded;
  const evidenceStartedAt = performance.now();
  const coverage = scopes.reduce((sum, scope) => { const row = context.store.db.prepare("SELECT COUNT(*) AS discovered, SUM(coverage_status='admitted') AS admitted, SUM(coverage_status<>'admitted') AS excluded, SUM(coverage_status='failed') AS failed, SUM(coverage_status='stale') AS stale FROM coverage_records WHERE repo_id=?").get(scope.repoId) as { discovered: number; admitted: number; excluded: number; failed: number; stale: number }; return { discovered: sum.discovered + (row?.discovered ?? 0), admitted: sum.admitted + (row?.admitted ?? 0), excluded: sum.excluded + (row?.excluded ?? 0), failed: sum.failed + (row?.failed ?? 0), stale: sum.stale + (row?.stale ?? 0) }; }, { discovered: 0, admitted: 0, excluded: 0, failed: 0, stale: 0 });
  const sourceFacts = Number((context.store.db.prepare("SELECT COUNT(*) AS n FROM source_facts").get() as { n: number }).n ?? 0);
  const scopedSourceFacts = scopes.length === 0
    ? sourceFacts
    : scopes.reduce((total, scope) => {
      if (scope.snapshotId.startsWith("legacy:")) {
        return total + Number((context.store.db.prepare("SELECT COUNT(*) AS n FROM source_facts WHERE repo_id=?").get(scope.repoId ?? "") as { n: number } | undefined)?.n ?? 0);
      }
      return total + Number((context.store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_sources e JOIN source_facts sf ON sf.id=e.source_fact_id WHERE e.snapshot_id=? AND (? IS NULL OR sf.repo_id=? )").get(scope.snapshotId, scope.repoId ?? null, scope.repoId ?? null) as { n: number } | undefined)?.n ?? 0);
    }, 0);
  const sourceMissing = scopedSourceFacts === 0 && sourceLaneRequested;
  if (sourceMissing) warnings.push({ code: "SOURCE_NOT_INCLUDED", message: "the selected artifact/index contains no source corpus; graph and metadata may still be available, but exact source search cannot prove absence" });
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
  if (scopeError) warnings.push({ code: scopeError.code, message: scopeError.message });
  const resolvedRevision = scopes.length === 1 ? revisionContext(context.store, scopes[0]) : undefined;
  const sharedEvidence = buildEvidenceEnvelope(context.store, {
    repoId: scopes.length === 1 ? scopes[0].repoId : undefined,
    branchId: resolvedRevision?.branchId,
    revision: resolvedRevision,
    scope: request.scope as unknown as Record<string, unknown>,
    completeness: "unknown",
    proofStatus: "unresolved",
    candidateCount,
    returnedCount: pageHits.length,
    truncated: responseTruncated,
    cursor: nextCursor ?? null,
  });
  const publicCoverage = scopes.length === 1
    ? sharedEvidence.coverage
    : {
        status: coverage.discovered === 0 ? "unknown" as const : coverage.excluded > 0 || coverage.failed > 0 || coverage.stale > 0 ? "partial" as const : "complete" as const,
        ...coverage,
        unresolvedReferences: null,
      };
  const incomplete = sourceMissing || publicCoverage.status !== "complete" || publicCoverage.unresolvedReferences === null || publicCoverage.unresolvedReferences > 0 || semanticDeferred || globalScopeCapped || globalBudgetExceeded;
  const totalIsExact = !incomplete && coverage.stale === 0 && coverage.failed === 0 && coverage.excluded === 0 && request.mode === "exact" && ranked.length <= request.page.limit;
  const queryStatus = scopeError
    ? "SCOPE_ERROR"
    : pageHits.length > 0
      ? "MATCH"
      : incomplete
        ? "NO_MATCH_INCOMPLETE"
        : "NO_MATCH_VERIFIED";
  const nextActions = scopeError?.code === "REPOSITORY_NOT_FOUND"
    ? [{ command: "index_status({\"mode\":\"detailed\"})", reason: "choose an indexed repository; repository registration is an owner-only knowledge_repository_register action" }]
    : incomplete
      ? [{ command: "knowledge_coverage({\"repo\":\"<repo>\",\"kind\":\"failed\"})", reason: "inspect coverage debt before relying on a negative result; only the owner may refresh it with knowledge_index" }]
      : [];
  const deterministicLanes = [...executedDeterministicLanes];
  const completeness = totalIsExact ? "complete" as const : incomplete ? "partial" as const : "lower_bound" as const;
  const proofStatus = pageHits.length > 0 && totalIsExact ? "proven" as const : pageHits.length > 0 ? "candidate" as const : "not_proven" as const;
  const evidence = {
    ...sharedEvidence,
    coverage: publicCoverage,
    completeness,
    proofStatus,
  };
  phaseTimings.evidence = elapsedMs(evidenceStartedAt);
  const envelope = {
    scope: {
      ...(request.scope as unknown as Record<string, unknown>),
      ...(!requestedRevisions?.length ? {
        searchedRepos: scopes.map((scope) => ({ repoId: scope.repoId, repoName: repoName(context.store, scope.repoId ?? ""), snapshotId: scope.snapshotId })),
      } : {}),
    },
    revision: resolvedRevision ?? null,
    freshness: evidence.freshness,
    coverage: publicCoverage,
    completeness,
    proofStatus,
    candidateCount,
    returnedCount: pageHits.length,
    truncated: responseTruncated,
    cursor: nextCursor ?? null,
    evidence,
  };
  const compactHits = request.options.compact
    ? pageHits.map((hit) => {
      const compactHit = { ...hit, evidence: hit.evidence.map((evidence) => {
        const compactEvidence = { ...evidence };
        delete compactEvidence.excerpt;
        return compactEvidence;
      }) };
      if (hit.kind !== "source_occurrence") delete compactHit.snippet;
      delete compactHit.highlights;
      return compactHit;
    })
    : pageHits;
  const semanticProgress = semanticProgressForScopes(context.store, scopes);
  const response = validateSearchResponse({ schemaVersion: "2", hits: compactHits, ...envelope, ...(scopeError ? { error: scopeError as SearchResponse["error"] } : {}), diagnostics: { queryStatus, requestId: `search_${hash([normalizedHash, Date.now()]).slice(0, 16)}`, contractVersion: "2", capabilityHash: capabilityHash(CAPABILITIES), requestedScope: request.scope, resolvedScope: scopes.map((scope) => ({ repoId: scope.repoId ?? "", snapshotId: scope.snapshotId })), scopeApplied: !scopeError && allRequestedScopesResolved && (!requestedRevisions?.length || scopes.length > 0), resolvedScopes: scopes.map((scope) => { const revision = revisionContext(context.store, scope); return { repoId: scope.repoId ?? "", branch: revision?.branch ?? storeBranch(context.store, scope.snapshotId) ?? "", snapshotId: scope.snapshotId, ...(revision?.commitSha ? { commitSha: revision.commitSha } : {}), revisionKind: workingTreeRevisionKind(revision ?? { trust: "exact_commit" }) }; }), searchedLanes: deterministicLanes, skippedLanes: semanticDeferred ? [{ lane: "semantic", reason: "async_semantic_lane_required" }] : [], semantic: { requested: semanticDeferred, applied: false, reason: semanticDeferred ? "async_semantic_lane_required" : "not_requested", ready: semanticProgress.ready, expected: semanticProgress.expected, activeGenerationIds: semanticProgress.activeGenerationIds, lanesUsed: deterministicLanes }, coverage: publicCoverage, exclusions, warnings, nextActions, suggestions, timingsMs: { ...phaseTimings, total: Math.round((performance.now() - startedAt) * 1000) / 1000 }, candidateCount, truncated: responseTruncated }, page: { limit: request.page.limit, ...(nextCursor ? { nextCursor } : {}), totalIsExact, ...(totalIsExact ? { total: ranked.length } : {}) } });
  const serializationStartedAt = performance.now();
  response.diagnostics.timingsMs.serialization = elapsedMs(serializationStartedAt);
  return response;
}

/** Async companion for the optional semantic lane. Deterministic search remains
 * the source of truth; semantic hits are explicitly marked as inference and
 * are only blended when the caller opts in and supplies a provider. */
export async function searchKnowledgeAsync(input: SearchRequest | NormalizedSearchRequest, context: SearchContext): Promise<SearchResponse> {
  const request = validatePublicSearchRequest(input);
  const parsedQuery = planSearch(request).parsed;
  if (request.options.semantic === "off") {
    return searchKnowledge(request, context);
  }
  // Hybrid pagination is ranked over a stable bounded candidate window. The
  // deterministic pass must not consume the hybrid cursor or page at the
  // caller's tiny limit, otherwise vector hits 4..N are structurally lost.
  const candidateWindow = Math.max(50, request.page.limit);
  const deterministic = searchKnowledge({
    ...request,
    options: { ...request.options, semantic: "off" },
    page: { limit: candidateWindow },
  }, context);
  // Scope failures are terminal. Starting a model for a missing workspace is
  // both expensive and misleading because no semantic lane can make the
  // requested scope valid.
  if (deterministic.error) return deterministic;
  const resolvedScopeKeys = new Set(deterministic.diagnostics.resolvedScope.map((scope) => `${scope.repoId}|${scope.snapshotId}`));
  const scopes = (context.scopes?.length ? context.scopes : scopeRows(context.store))
    .filter((scope) => resolvedScopeKeys.has(`${scope.repoId ?? ""}|${scope.snapshotId}`));
  const warnings = [...deterministic.diagnostics.warnings];
  const semanticProgress = semanticProgressForScopes(context.store, scopes);
  const semanticPartial = semanticProgress.expected > 0 && semanticProgress.ready < semanticProgress.expected;
  if (semanticPartial) {
    warnings.push({
      code: "SEMANTIC_PARTIAL_INDEX",
      message: `semantic vectors are available for ${semanticProgress.ready}/${semanticProgress.expected} indexed chunks; results are a lower bound while the background worker continues`,
    });
  }
  const skippedSemantic = (reason: string, message: string): SearchResponse => {
    // The candidate pass intentionally widens to at least 50 for hybrid RRF.
    // A skipped semantic lane must instead return the caller's original
    // deterministic page (including its cursor and exact requested limit).
    const fallback = searchKnowledge({
      ...request,
      options: { ...request.options, semantic: "off" },
    }, context);
    return {
    ...fallback,
    diagnostics: {
      ...fallback.diagnostics,
      searchedLanes: fallback.diagnostics.searchedLanes.filter((lane) => lane !== "semantic"),
      skippedLanes: [
        ...fallback.diagnostics.skippedLanes.filter((lane) => lane.lane !== "semantic"),
        { lane: "semantic", reason },
      ],
      warnings: [...fallback.diagnostics.warnings, { code: "SEMANTIC_LANE_UNAVAILABLE", message }],
      queryStatus: fallback.hits.length > 0 ? "MATCH" : "NO_MATCH_INCOMPLETE",
      semantic: {
        requested: true,
        applied: false,
        reason,
        ready: semanticProgress.ready,
        expected: semanticProgress.expected,
        activeGenerationIds: semanticProgress.activeGenerationIds,
        lanesUsed: fallback.diagnostics.searchedLanes.filter((lane) => lane !== "semantic" && lane !== "vector"),
      },
    },
    ...(request.mode === "semantic" ? { error: { code: "MODE_UNAVAILABLE" as const, message, details: { reason }, retryable: false } } : {}),
    };
  };
  if (semanticProgress.activeGenerationIds.length === 0) {
    return skippedSemantic("no_active_space", "semantic search has no active embedding generation for the resolved scope");
  }
  const semanticProvider = context.semanticProvider ?? await context.semanticProviderFactory?.();
  if (!semanticProvider) {
    return skippedSemantic("provider_not_configured", "semantic search was requested but no embedding provider is configured; deterministic lanes are partial results");
  }
  try {
    const providerHealth = await Promise.race([
      semanticProvider.health(),
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
  if (semanticScopes.length !== scopes.length) warnings.push({ code: "SEMANTIC_SCOPE_FILTERED", message: "semantic documents were restricted to the requested repository/revision scope" });
  let persisted;
  try {
    persisted = await searchPersistedVectors({ store: context.store, provider: semanticProvider, query: request.query, scopes: semanticScopes, pathPrefixes: request.scope.paths, limit: Math.max(50, request.page.limit), signal: context.signal });
  } catch (error) {
    return skippedSemantic("provider_error", String((error as Error).message ?? error));
  }
  if (!persisted.activeGenerations.length) return skippedSemantic("no_active_space", "semantic search has no active embedding generation for the resolved scope");
  const cursorCodec = new HmacSearchCursorCodec(context.cursorSecret ?? DEFAULT_CURSOR_SECRET, () => (context.now?.() ?? new Date()).getTime());
  const semanticRequestHash = hash({
    kind: "semantic-hybrid-page-v1",
    ...request,
    page: { limit: request.page.limit },
  });
  const semanticScopeHash = hash(request.scope);
  let afterHitId: string | undefined;
  if (request.page.cursor) {
    try {
      const decoded = cursorCodec.decode(request.page.cursor);
      if (decoded.normalizedRequestHash !== semanticRequestHash
        || decoded.scopeHash !== semanticScopeHash
        || decoded.capabilityHash !== capabilityHash(CAPABILITIES)
        || decoded.mode !== request.mode) {
        throw new Error("CURSOR_STALE");
      }
      afterHitId = decoded.lastHitId;
    } catch (error) {
      const message = String((error as Error).message);
      const code = message.includes("OPERATION_MISMATCH") ? "CURSOR_OPERATION_MISMATCH" : message.includes("EXPIRED") ? "CURSOR_EXPIRED" : message.includes("STALE") ? "CURSOR_STALE" : "CURSOR_INVALID";
      throw Object.assign(new Error(code), {
        code,
        retryable: false,
        details: { remediation: "restart semantic search pagination from the first page using the same scope, query, mode, options, and limit" },
      });
    }
  }
  const merged = fuseHybridHits(deterministic.hits, persisted.hits, { rrfK: 60, lexicalLimit: Math.max(50, request.page.limit), vectorLimit: Math.max(50, request.page.limit), exactPin: true, rankerVersion: SEARCH_RANKER_VERSION });
  let pageStart = 0;
  if (afterHitId) {
    const priorIndex = merged.findIndex((hit) => hit.hitId === afterHitId);
    if (priorIndex < 0) throw Object.assign(new Error("CURSOR_STALE"), { code: "CURSOR_STALE" });
    pageStart = priorIndex + 1;
  }
  const hits = merged.slice(pageStart, pageStart + request.page.limit);
  const returnedCount = hits.length;
  // The deterministic pass deliberately reports the semantic stage as deferred.
  // Once the async vector lane has run, every public envelope field must be
  // rebuilt from the merged result; otherwise consumers see hits alongside a
  // false NO_MATCH/returnedCount=0 result.
  const candidateCount = merged.length;
  const truncated = pageStart + returnedCount < merged.length;
  const last = hits.at(-1);
  const proofStatus = returnedCount > 0
    ? hits.some((hit) => hit.lane !== "vector" && hit.lane !== "semantic")
      ? deterministic.proofStatus ?? "candidate" as const
      : "candidate" as const
    : deterministic.proofStatus ?? "not_proven" as const;
  const searchedLanes = [...new Set([...deterministic.diagnostics.searchedLanes, "vector" as const])];
  const bestVectorSimilarity = persisted.hits.reduce((best, hit) => Math.max(best, Number.isFinite(hit.score) ? hit.score : -1), -1);
  const mergedWarnings = [
    ...warnings.filter((warning) => warning.code !== "SEMANTIC_LANE_UNAVAILABLE" && (returnedCount === 0 || warning.code !== "NO_MATCH")),
    ...(persisted.hits.length > 0 && bestVectorSimilarity < LOW_VECTOR_SIMILARITY_THRESHOLD
      ? [{
          code: "LOW_SIMILARITY",
          message: `best vector similarity ${bestVectorSimilarity.toFixed(4)} is below ${LOW_VECTOR_SIMILARITY_THRESHOLD.toFixed(2)}; treat semantic hits as weak candidate leads, not evidence`,
        }]
      : []),
  ];
  const nextCursor = truncated && last
    ? cursorCodec.encode({
        schemaVersion: "1",
        queryHash: hash(request.query),
        normalizedRequestHash: semanticRequestHash,
        scopeHash: semanticScopeHash,
        capabilityHash: capabilityHash(CAPABILITIES),
        mode: request.mode,
        lanes: searchedLanes,
        lastRank: last.score,
        lastHitId: last.hitId,
        expiresAt: new Date((context.now?.() ?? new Date()).getTime() + 15 * 60_000).toISOString(),
      })
    : undefined;
  return validateSearchResponse({
    ...deterministic,
    hits,
    proofStatus,
    candidateCount,
    returnedCount,
    truncated,
    cursor: nextCursor ?? null,
    evidence: {
      ...deterministic.evidence,
      proofStatus,
      candidateCount,
      returnedCount,
      truncated,
      cursor: nextCursor ?? null,
    },
    diagnostics: {
      ...deterministic.diagnostics,
      queryStatus: returnedCount > 0 ? "MATCH" : deterministic.diagnostics.queryStatus,
      searchedLanes,
      skippedLanes: deterministic.diagnostics.skippedLanes.filter((lane) => lane.lane !== "semantic"),
      warnings: mergedWarnings,
      suggestions: returnedCount > 0 ? [] : deterministic.diagnostics.suggestions,
      candidateCount,
      truncated,
      semantic: {
        requested: true,
        applied: true,
        reason: semanticPartial ? "partial_index" : null,
        ready: semanticProgress.ready,
        expected: semanticProgress.expected,
        activeGenerationIds: persisted.activeGenerations,
        lanesUsed: searchedLanes,
      },
    },
    page: { limit: request.page.limit, ...(nextCursor ? { nextCursor } : {}), totalIsExact: false },
  });
}

function storeBranch(store: KnowledgeStore, snapshotId: string): string | undefined {
  if (snapshotId.startsWith("legacy:")) return (store.db.prepare("SELECT name FROM branches WHERE id=?").get(snapshotId.slice("legacy:".length)) as { name: string } | undefined)?.name;
  return (store.db.prepare("SELECT name FROM branches WHERE current_snapshot_id=? ORDER BY default_branch DESC LIMIT 1").get(snapshotId) as { name: string } | undefined)?.name;
}
