import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { KnowledgeStore } from "./store.js";
import type { RevisionContext } from "./revision.js";
import { legacyRevisionScope } from "./revision-scope.js";
import { openRevisionView } from "./revision-view.js";

// The single query implementation shared by MCP tools, the CLI, and the UI
// (§8). Results carry provenance/staleness where applicable (§3.3/§4.4).

export interface SearchResultRow {
  // null only for a "field" hit (object-literal key / interface / type-alias
  // / class field name) — these are file:line index entries, not graph
  // nodes, so there's no id get_node could ever resolve.
  nodeId: string | null;
  nodeType: string;
  title: string;
  snippet: string | null;
  identityKey: string;
  filePath: string | null;
  branch: string | null;
  rank: number | null;
  // Only populated for "field" hits — symbol/note hits carry their line via
  // the caller looking up symbol_versions/get_node instead.
  startLine?: number | null;
}

export interface RevisionQueryOptions {
  revision?: RevisionContext;
  limit?: number;
}

export interface LegacySearchFilters extends RevisionQueryOptions {
  type?: string[];
  repo?: string;
  workspace?: string;
  includeSensitive?: boolean;
}

function snapshotNodeIds(store: KnowledgeStore, revision?: RevisionContext): Set<string> | null {
  if (!revision || revision.snapshotId.startsWith("legacy:")) return null;
  return new Set(openRevisionView(store, revision).symbolVersions().map((row) => row.nodeId));
}

function snapshotEdgePairs(store: KnowledgeStore, revision: RevisionContext): Array<{ src: string; dst: string | null; edgeType: string }> {
  const view = openRevisionView(store, revision);
  const ids = new Map<string, string>();
  for (const row of view.symbolVersions()) ids.set(row.identityKey, row.nodeId);
  return view.edges({ limit: 10000 }).map((edge) => ({
    src: ids.get(edge.srcIdentityKey) ?? store.findNodeIdByIdentity(edge.srcIdentityKey) ?? edge.srcIdentityKey,
    dst: edge.dstIdentityKey ? (ids.get(edge.dstIdentityKey) ?? store.findNodeIdByIdentity(edge.dstIdentityKey) ?? edge.dstIdentityKey) : null,
    edgeType: edge.edgeType,
  }));
}

function snapshotEdgePairsForNodes(
  store: KnowledgeStore,
  revision: RevisionContext,
  nodeIds: string[],
  options: { edgeTypes?: string[]; direction?: "in" | "out" | "both"; limit?: number },
): Array<{ src: string; dst: string | null; edgeType: string }> {
  if (nodeIds.length === 0) return [];
  const edges = openRevisionView(store, revision).edges({
    nodeIds,
    edgeTypes: options.edgeTypes,
    direction: options.direction,
    limit: options.limit,
  });
  const identityKeys = [...new Set(edges.flatMap((edge) => [edge.srcIdentityKey, edge.dstIdentityKey].filter((key): key is string => Boolean(key))))];
  if (identityKeys.length === 0) return [];
  const rows = store.db.prepare(
    `SELECT id, identity_key AS identityKey FROM nodes WHERE identity_key IN (${identityKeys.map(() => "?").join(",")})`,
  ).all(...identityKeys) as Array<{ id: string; identityKey: string }>;
  const ids = new Map(rows.map((row) => [row.identityKey, row.id]));
  return edges.map((edge) => ({
    src: ids.get(edge.srcIdentityKey) ?? edge.srcIdentityKey,
    dst: edge.dstIdentityKey ? (ids.get(edge.dstIdentityKey) ?? edge.dstIdentityKey) : null,
    edgeType: edge.edgeType,
  }));
}

function revisionBranchId(options?: { revision?: RevisionContext; branchId?: string }): string | undefined {
  return options?.revision?.branchId ?? options?.branchId;
}

function nodeVisibleInRevision(store: KnowledgeStore, nodeId: string, revision?: RevisionContext): boolean {
  if (revision?.snapshotId && !revision.snapshotId.startsWith("legacy:")) return openRevisionView(store, revision).symbolVersions([nodeId]).length > 0 || ["note", "endpoint", "service"].includes(store.getNode(nodeId)?.node_type ?? "");
  if (!revision?.branchId) return true;
  const node = store.getNode(nodeId);
  if (!node || node.node_type === "note" || node.repo_id == null || node.node_type === "endpoint" || node.node_type === "service") return true;
  return Boolean(
    store.db.prepare("SELECT 1 FROM symbol_versions WHERE node_id=? AND branch_id=? AND status <> 'deleted' LIMIT 1")
      .get(nodeId, revision.branchId),
  );
}

function resolveNodeId(store: KnowledgeStore, idOrKey: string): string | null {
  const r = resolveSymbolMatches(store, idOrKey);
  return r.kind === "unique" ? r.nodeId : null;
}

// A candidate when a name resolves to more than one symbol — enough to both
// display ("which one?") and act on directly (nodeId feeds straight back into
// context/flow, no re-typing the ambiguous name).
export interface SymbolCandidate {
  nodeId: string;
  nodeType: string;
  identityKey: string;
  title: string;
  filePath: string | null;
  branch: string | null;
  startLine: number | null;
}

export type SymbolResolution =
  | { kind: "unique"; nodeId: string }
  | { kind: "ambiguous"; candidates: SymbolCandidate[] }
  | { kind: "none" };

// Cap on ambiguous candidates returned/rendered — a name shared by hundreds of
// symbols (generic getters etc.) would otherwise dump an unusable wall of text;
// zero/unique/truly-few-candidates are the cases this feature is for.
const MAX_AMBIGUOUS_CANDIDATES = 20;

type SymbolCandidateScope = { branchId?: string; revision?: RevisionContext };

function symbolCandidateOf(
  store: KnowledgeStore,
  nodeId: string,
  scope?: SymbolCandidateScope,
): SymbolCandidate {
  const n = store.getNode(nodeId)!;
  const scopedBranchId = scope?.revision?.branchId ?? scope?.branchId;
  let v: { filePath: string | null; branchId: string | null; startLine: number | null } | undefined;
  if (scope?.revision && !scope.revision.snapshotId.startsWith("legacy:")) {
    const row = openRevisionView(store, scope.revision).symbolVersions([nodeId])[0];
    if (row) {
      v = {
        filePath: row.filePath,
        branchId: scope.revision.branchId ?? null,
        startLine: row.startLine ?? null,
      };
    }
  } else if (scopedBranchId) {
    v = store.db
      .prepare(
        `SELECT file_path AS filePath, branch_id AS branchId, start_line AS startLine
         FROM symbol_versions
         WHERE node_id=? AND branch_id=? AND status='fresh'
         LIMIT 1`,
      )
      .get(nodeId, scopedBranchId) as typeof v;
  } else {
    v = store.db
      .prepare(
        `SELECT file_path AS filePath, branch_id AS branchId, start_line AS startLine
         FROM symbol_versions WHERE node_id=? ORDER BY (status='fresh') DESC LIMIT 1`,
      )
      .get(nodeId) as typeof v;
  }
  const branch = v?.branchId
    ? ((store.db.prepare("SELECT name FROM branches WHERE id=?").get(v.branchId) as { name: string } | undefined)?.name ?? v.branchId)
    : null;
  return {
    nodeId, nodeType: n.node_type, identityKey: n.identity_key, title: n.title,
    filePath: v?.filePath ?? null, branch, startLine: v?.startLine ?? null,
  };
}

// Resolve a user-typed name/id to EXACTLY one of three outcomes — ambiguity
// must never collapse into "not found" (that's what silently broke `context`/
// `flow` for any name shared by 2+ symbols, e.g. several classes each with a
// same-named method). `symbol:<node-id>` is an explicit escape hatch a
// disambiguation prompt can suggest back to the caller.
export function resolveSymbolMatches(
  store: KnowledgeStore,
  idOrKey: string,
  scope?: SymbolCandidateScope,
): SymbolResolution {
  const raw = idOrKey.startsWith("symbol:") ? idOrKey.slice("symbol:".length) : idOrKey;
  if (store.getNode(raw)) return { kind: "unique", nodeId: raw };
  const r = store.resolveIdentity(raw);
  if (r) return { kind: "unique", nodeId: r.nodeId };
  // Human-friendly repo prefix: `auth::Class.method` or
  // `auth::src/file.ts::Class.method`. Repo ids are random on a fresh DB, so
  // prompts, benchmarks and notes must not need to preserve `repo_<uuid>`.
  const repoSeparator = raw.indexOf("::");
  if (repoSeparator > 0 && !raw.startsWith("repo_") && !raw.startsWith("grpc::")) {
    const repoPrefix = raw.slice(0, repoSeparator);
    const suffix = raw.slice(repoSeparator + 2);
    const resolvedIds = new Set<string>();
    for (const repoId of store.resolveRepoIds(repoPrefix)) {
      const match = store.resolveIdentity(`${repoId}::${suffix}`);
      if (match) resolvedIds.add(match.nodeId);
    }
    if (resolvedIds.size === 1) return { kind: "unique", nodeId: [...resolvedIds][0] };
    if (resolvedIds.size > 1) {
      return {
        kind: "ambiguous",
        candidates: [...resolvedIds].slice(0, MAX_AMBIGUOUS_CANDIDATES).map((nodeId) => symbolCandidateOf(store, nodeId, scope)),
      };
    }
  }
  // friendly-name fallback: title match, or qualified-name suffix (so CLI/MCP
  // callers can pass "login" or "Svc.login", not just full identity keys).
  const rows = store.db
    .prepare(
      `SELECT id FROM nodes
       WHERE (title = ? OR identity_key LIKE ? OR identity_key LIKE ?)
         AND (
           node_type <> 'symbol'
           OR NOT EXISTS (
             SELECT 1 FROM symbol_versions sv
             WHERE sv.node_id = nodes.id
           )
           OR EXISTS (
             SELECT 1 FROM symbol_versions sv
             WHERE sv.node_id = nodes.id AND sv.status = 'fresh'
           )
         )
       LIMIT ${MAX_AMBIGUOUS_CANDIDATES + 1}`,
    )
    .all(raw, `%::${raw}`, `%.${raw}`) as { id: string }[];
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "unique", nodeId: rows[0].id };
  return { kind: "ambiguous", candidates: rows.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((row) => symbolCandidateOf(store, row.id, scope)) };
}

// Shared renderer for an ambiguous SymbolResolution — used by `context`/`node`
// CLI verbs so the message shape (candidates + concrete next commands) stays
// consistent wherever a name resolves to more than one symbol.
export function renderAmbiguousSymbols(
  target: string,
  candidates: SymbolCandidate[],
  verb: "context" | "flow" = "context",
): string {
  const lines = [`Multiple symbols found for "${target}":`, ""];
  candidates.forEach((c, i) => {
    const loc = c.filePath ? `${c.filePath}${c.startLine ? `:${c.startLine}` : ""}` : "(no file)";
    lines.push(`${i + 1}. ${c.nodeType} ${c.identityKey.includes("::") ? c.identityKey.slice(c.identityKey.indexOf("::") + 2) : c.title}`);
    lines.push(`   ${loc}${c.branch ? `  [${c.branch}]` : ""}  node:${c.nodeId}`);
  });
  lines.push("", "Next step: pick one and re-run with its node id, e.g.:");
  lines.push(`  penguin ${verb} symbol:${candidates[0].nodeId}`);
  return lines.join("\n");
}

// knowledge_search: title→FTS unified retrieval with scope filters (§8.1).
// "field" is a pseudo node-type — object-literal keys / interface / type-alias
// / class field names, backed by fts_identifiers (see store.searchIdentifiers),
// not real symbol/note nodes. It's included when the caller explicitly asks
// for it (type: ["field"]) OR automatically when a normal, type-unfiltered
// search comes back empty — a real field name deserves file:line, not a bare
// empty result (the reporting session's longest-stuck point: searching for
// object-literal keys/interface fields always returned nothing).
export function searchLegacyRows(
  store: KnowledgeStore,
  query: string,
  filters?: LegacySearchFilters,
): SearchResultRow[] {
  const requestedTypes = filters?.type;
  const wantsFields = requestedTypes?.includes("field") ?? false;
  const otherTypes = requestedTypes?.filter((t) => t !== "field");
  // type: ["field"] alone means "fields only" — skip the symbol/note query.
  const skipSymbolSearch = wantsFields && otherTypes?.length === 0;

  let hits: SearchResultRow[] = skipSymbolSearch
    ? []
    : store.searchText(query, {
        types: otherTypes?.length ? otherTypes : undefined,
        includeSensitive: filters?.includeSensitive,
      limit: filters?.limit,
    });

  if (filters?.revision?.snapshotId && !filters.revision.snapshotId.startsWith("legacy:")) {
    const revision = filters.revision;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    // Do not materialize every symbol in the snapshot for every lexical
    // query. A large snapshot's manifest is intentionally lazy, and the
    // previous unfiltered symbolVersions() call walked every indexed file
    // before applying the query terms. That made the default `auto` search
    // appear to hang on large repositories even though exact/source search
    // was responsive. Use the bounded FTS candidates first, then resolve
    // only those candidates against the revision view.
    const candidateIds = hits.map((hit) => hit.nodeId).filter((id): id is string => Boolean(id));
    const revisionView = openRevisionView(store, revision);
    const revisionHits = revisionView.symbolVersions(candidateIds).filter((row) => terms.every((term) => `${row.title} ${row.identityKey} ${row.signature ?? ""}`.toLowerCase().includes(term))).slice(0, filters.limit ?? 50).map((row) => ({ nodeId: row.nodeId, nodeType: "symbol", title: row.title, snippet: row.signature ?? null, identityKey: row.identityKey, filePath: row.filePath, branch: revision.branch ?? null, rank: 100, startLine: row.startLine ?? null }));
    if (revisionHits.length || !revision.branchId) {
      hits = revisionHits;
    } else {
      // A ready snapshot can exist before its materialized file manifest is
      // rebuilt (or after an interrupted backfill). Do not hide symbols that
      // are already present in the branch index in that transitional state.
      // The fallback is restricted to an actually empty manifest and still
      // applies the branch's fresh-version visibility filter.
      const materialized = Number((store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_files WHERE snapshot_id=?").get(revision.snapshotId) as { n: number } | undefined)?.n ?? 0);
      if (materialized === 0) {
        hits = hits.filter((hit) => !hit.nodeId || nodeVisibleInRevision(store, hit.nodeId, { ...revision, snapshotId: `legacy:${revision.branchId}` })).slice(0, filters.limit ?? 50);
      } else {
        hits = revisionHits;
      }
    }
  }

  if (filters?.revision) {
    const revision = filters.revision;
    const emptySnapshot = revision.branchId && !revision.snapshotId.startsWith("legacy:")
      && Number((store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_files WHERE snapshot_id=?").get(revision.snapshotId) as { n: number } | undefined)?.n ?? 0) === 0;
    const visibilityRevision = emptySnapshot ? { ...revision, snapshotId: `legacy:${revision.branchId}` } : revision;
    hits = hits.filter((hit) => !hit.nodeId || nodeVisibleInRevision(store, hit.nodeId, visibilityRevision));
  }

  // Endpoints/services/entities are graph nodes rather than source symbols, so
  // they have no fts_symbols row. Include them by title/identity to make real
  // routes and proto RPCs discoverable through the same search entry point.
  const structuralTypes = ["endpoint", "service", "entity", "log_site", "field"]
    .filter((nodeType) => !requestedTypes?.length || requestedTypes.includes(nodeType));
  if (!skipSymbolSearch && structuralTypes.length > 0) {
    const placeholders = structuralTypes.map(() => "?").join(",");
    const structuralQuery = `%${query}%`;
    const structuralHits = store.db
      .prepare(
        `SELECT id AS nodeId, node_type AS nodeType, title, identity_key AS identityKey,
                CASE WHEN node_type IN ('log_site', 'field') THEN json_extract(meta, '$.filePath') ELSE NULL END AS filePath,
                NULL AS branch, NULL AS rank,
                CASE WHEN node_type='log_site' THEN json_extract(meta, '$.message') ELSE NULL END AS snippet,
                CASE WHEN node_type IN ('log_site', 'field') THEN json_extract(meta, '$.startLine') ELSE NULL END AS startLine
           FROM nodes
          WHERE node_type IN (${placeholders})
            AND (title LIKE ? COLLATE NOCASE OR identity_key LIKE ? COLLATE NOCASE)
          LIMIT ?`,
      )
      .all(...structuralTypes, structuralQuery, structuralQuery, filters?.limit ?? 50) as SearchResultRow[];
    const seenNodeIds = new Set(hits.map((hit) => hit.nodeId).filter(Boolean));
    hits = hits.concat(structuralHits.filter((hit) => !seenNodeIds.has(hit.nodeId)
      && (!filters?.revision || !hit.nodeId || nodeVisibleInRevision(store, hit.nodeId, filters.revision))));
  }

  // Scope by repo, or by all repos in a workspace (§8.1 workspace filter).
  const repoScope: Set<string> | null = filters?.workspace
    ? new Set(store.workspaceRepoIds(filters.workspace))
    : filters?.repo
      ? new Set(store.resolveRepoIds(filters.repo))
      : null;
  if (repoScope) {
    hits = hits.filter((h) => {
      const n = store.getNode(h.nodeId!);
      const isDirectRepoMatch = n?.repo_id != null && repoScope.has(n.repo_id);
      if (isDirectRepoMatch) return true;
      if (!n || n.repo_id != null) return false;
      const linkedRepos = store.db
        .prepare(
          `SELECT DISTINCT linked.repo_id AS repoId
             FROM edges e
             JOIN nodes linked ON linked.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
            WHERE (e.src = ? OR e.dst = ?) AND linked.repo_id IS NOT NULL
              ${filters?.revision ? "AND (e.branch_id = ? OR e.branch_id IS NULL)" : ""}`,
        )
        .all(...(filters?.revision ? [n.id, n.id, n.id, filters.revision.branchId] : [n.id, n.id, n.id])) as Array<{ repoId: string }>;
      return linkedRepos.some((row) => repoScope.has(row.repoId));
    });
  }

  const shouldSearchFields = wantsFields || (hits.length === 0 && !requestedTypes?.length);
  if (shouldSearchFields) {
    const idHits = store.searchIdentifiers(query, { limit: filters?.limit });
    const scoped = repoScope ? idHits.filter((h) => repoScope.has(h.repoId)) : idHits;
    hits = hits.concat(
      scoped.filter((h) => !filters?.revision || Boolean(store.db.prepare(
        "SELECT 1 FROM files_index WHERE repo_id=? AND branch_id=? AND file_path=? LIMIT 1",
      ).get(h.repoId, filters.revision.branchId, h.filePath))).map((h) => ({
        nodeId: null,
        nodeType: "field",
        title: h.name,
        snippet: null,
        identityKey: `field::${h.repoId}::${h.filePath}::${h.startLine}::${h.name}`,
        filePath: h.filePath,
        branch: null,
        rank: null,
        startLine: h.startLine,
      })),
    );
  }
  return hits;
}

export interface NodeDetail {
  node: { id: string; nodeType: string; identityKey: string; title: string; repoId: string | null };
  versions: Array<{
    branchId: string; filePath: string; lang: string; kind: string; status: string;
    contentHash: string; signature: string | null; startLine: number | null; endLine: number | null;
  }>;
  aliases: Array<{ aliasKey: string; reason: string | null; validTo: string | null }>;
  body: string | null; // note body, honoring mcp_access; null for symbols/denied
  // For code symbols: the declaration's actual source, read off disk by line
  // range (the graph stores only a content hash, not the text). null if the
  // file is unreadable or the node is a note (use body instead).
  source: { code: string; lang: string; filePath: string; startLine: number } | null;
  // For typed notes (Phase 3 why-layer): kind + lifecycle from frontmatter.
  note: { type: string; status: string | null; owner: string | null } | null;
}

// get_node: node + versions (symbol) or body (note, respects mcp_access) + aliases (§8.1).
export function getNodeDetail(
  store: KnowledgeStore,
  idOrKey: string,
  options?: { revision?: RevisionContext; branchId?: string },
): NodeDetail | null {
  const nodeId = resolveNodeId(store, idOrKey);
  if (!nodeId) return null;
  const node = store.getNode(nodeId)!;
  const branchId = revisionBranchId(options);
  const versionWhere = branchId ? " AND branch_id=?" : "";
  const versions = options?.revision?.snapshotId && !options.revision.snapshotId.startsWith("legacy:")
    ? openRevisionView(store, options.revision).symbolVersions([nodeId]).map((row) => ({ branchId: options.revision?.branchId ?? options.revision?.snapshotId ?? "revision", filePath: row.filePath, lang: row.language, kind: row.kind, status: "fresh", contentHash: row.contentHash, signature: row.signature ?? null, startLine: row.startLine ?? null, endLine: row.endLine ?? null }))
    : store.db
      .prepare(
        `SELECT branch_id AS branchId, file_path AS filePath, lang, kind, status,
                content_hash AS contentHash, signature, start_line AS startLine, end_line AS endLine
         FROM symbol_versions WHERE node_id=?${versionWhere} ORDER BY branch_id`,
      )
      .all(...(branchId ? [nodeId, branchId] : [nodeId])) as NodeDetail["versions"];
  const aliases = store
    .getAliases(nodeId)
    .map((a) => ({ aliasKey: a.aliasKey, reason: a.reason, validTo: a.validTo }));

  let body: string | null = null;
  let note: NodeDetail["note"] = null;
  const noteRow = store.db
    .prepare("SELECT mcp_access, frontmatter FROM notes_index WHERE node_id=?")
    .get(nodeId) as { mcp_access: string; frontmatter: string | null } | undefined;
  if (noteRow && noteRow.mcp_access !== "denied") {
    const fts = store.db
      .prepare("SELECT body FROM fts_notes WHERE node_id=?")
      .get(nodeId) as { body: string } | undefined;
    body = fts?.body ?? null;
    try {
      const fm = noteRow.frontmatter ? (JSON.parse(noteRow.frontmatter) as Record<string, unknown>) : {};
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      note = { type: s(fm.type) ?? "note", status: s(fm.status), owner: s(fm.owner) };
    } catch {
      note = { type: "note", status: null, owner: null };
    }
  }

  // Symbol source: prefer the fresh version, read [startLine, endLine] off disk.
  let source: NodeDetail["source"] = null;
  if (!noteRow && node.repo_id) {
    const v = versions.find((x) => x.status === "fresh") ?? versions[0];
    if (v && v.startLine != null && v.endLine != null) {
      const repo = store.db
        .prepare("SELECT root_path AS rootPath FROM repos WHERE id=?")
        .get(node.repo_id) as { rootPath: string } | undefined;
      if (repo) {
        try {
          const abs = isAbsolute(v.filePath) ? v.filePath : join(repo.rootPath, v.filePath);
          const lines = readFileSync(abs, "utf8").split(/\r?\n/);
          const code = lines.slice(v.startLine - 1, v.endLine).join("\n");
          if (code.trim()) source = { code, lang: v.lang, filePath: v.filePath, startLine: v.startLine };
        } catch {
          source = null; // best-effort: file moved/unreadable → fall back to signature
        }
      }
    }
  }

  return {
    node: {
      id: node.id, nodeType: node.node_type, identityKey: node.identity_key,
      title: node.title, repoId: node.repo_id,
    },
    versions, aliases, body, source, note,
  };
}

export type GraphMode =
  | "who_calls" | "calls_of" | "impact" | "backlinks" | "path" | "timeline" | "recent_changes" | "who_injects";

export interface GraphResult {
  mode: GraphMode;
  nodes: Array<{ nodeId: string; title: string; nodeType: string }>;
  events?: Array<{ eventType: string; ts: string; origin: string; method: string; nodeId: string | null }>;
  diagnostics?: QueryDiagnostics;
  revision?: RevisionContext;
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // traversal silently answered against the repo's live branch instead (see
  // FlowResult.scopeFallback). Matters most for the legacy graph verbs
  // (callers/calls/impact/backlinks/recent) that stay unscoped by design.
  scopeFallback?: { branchId: string };
}

function nodeBrief(store: KnowledgeStore, id: string) {
  const n = store.getNode(id);
  return { nodeId: id, title: n?.title ?? id, nodeType: n?.node_type ?? "unknown" };
}

// The live branch of a node's repo — the default "which branch am I answering
// for" so multi-branch repos never silently mix branches. null for repo-less
// (global) nodes like cross-repo gRPC endpoints.
export interface BranchFreshness {
  branchId: string;
  name: string;
  status: string;
  indexedCommit: string | null;
  indexedAt: string | null;
  stale: boolean;
  reason: string;
}

export interface TrustEnvelope {
  repoId: string;
  repoName: string;
  branchId: string;
  branchName: string;
  headCommit: string | null;
  indexedCommit: string | null;
  indexedAt: string | null;
  worktreeState: "clean" | "dirty" | "unknown" | "not_applicable";
  worktreeFingerprint: string | null;
  dirtyFiles: string[];
  parserVersion: string | null;
  schemaVersion: number | null;
  stale: boolean;
  staleReason: string | null;
  coverageGaps: string[];
  snapshotId?: string | null;
  baseCommit?: string | null;
  mergeBaseCommit?: string | null;
  cacheState?: "ready" | "cold" | "legacy" | "missing";
  changedFiles?: number;
  reusePercent?: number | null;
  deploymentTargets?: string[];
}

// Read the trust facts persisted by the successful indexing transaction. All
// query surfaces call this helper so repo/branch/freshness semantics cannot
// drift between Context, Flow, CLI, MCP, and the Wiki UI.
export function trustEnvelopeForBranch(
  store: KnowledgeStore,
  branchId: string | null,
): TrustEnvelope | null {
  if (!branchId) return null;
  const row = store.db.prepare(
    `SELECT r.id AS repoId, r.name AS repoName,
            b.id AS branchId, b.name AS branchName,
            b.head_commit AS headCommit,
            b.last_indexed_commit AS indexedCommit,
            b.last_indexed_at AS indexedAt,
            b.indexed_worktree_state AS worktreeState,
            b.indexed_worktree_fingerprint AS worktreeFingerprint,
            b.indexed_dirty_files AS dirtyFiles,
            b.parser_version AS parserVersion,
            b.indexed_schema_version AS schemaVersion,
            b.stale_reason AS staleReason
       FROM branches b JOIN repos r ON r.id=b.repo_id
      WHERE b.id=?`,
  ).get(branchId) as {
    repoId: string; repoName: string; branchId: string; branchName: string;
    headCommit: string | null; indexedCommit: string | null; indexedAt: string | null;
    worktreeState: TrustEnvelope["worktreeState"]; worktreeFingerprint: string | null;
    dirtyFiles: string; parserVersion: string | null; schemaVersion: number | null;
    staleReason: string | null;
  } | undefined;
  if (!row) return null;
  let dirtyFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.dirtyFiles);
    dirtyFiles = Array.isArray(parsed) ? parsed.filter((file): file is string => typeof file === "string") : [];
  } catch {
    dirtyFiles = [];
  }
  const coverageGaps = row.worktreeState === "unknown" ? ["git_status_unavailable"] : [];
  const snapshot = store.db.prepare(
    `SELECT s.id AS snapshotId, s.base_snapshot_id AS baseSnapshotId, s.merge_base_sha AS mergeBaseCommit,
            s.state AS cacheState,
            (SELECT COUNT(*) FROM snapshot_overlays o WHERE o.snapshot_id=s.id AND o.operation IN ('add','modify')) AS changedFiles,
            (SELECT COUNT(*) FROM effective_snapshot_files e WHERE e.snapshot_id=s.id) AS totalFiles
       FROM branches b JOIN revision_snapshots s ON s.id=b.current_snapshot_id WHERE b.id=?`,
  ).get(branchId) as { snapshotId: string; baseSnapshotId: string | null; mergeBaseCommit: string | null; cacheState: "ready" | "cold"; changedFiles: number; totalFiles: number } | undefined;
  const baseCommit = snapshot?.baseSnapshotId
    ? (store.db.prepare("SELECT commit_sha AS commitSha FROM revision_snapshots WHERE id=?").get(snapshot.baseSnapshotId) as { commitSha: string | null } | undefined)?.commitSha ?? null
    : null;
  const deploymentTargets = snapshot?.snapshotId
    ? (store.db.prepare("SELECT DISTINCT target_id AS targetId FROM deployment_revisions d JOIN revision_snapshots s ON s.repo_id=d.repo_id AND s.commit_sha=d.commit_sha WHERE s.id=?").all(snapshot.snapshotId) as Array<{ targetId: string }>).map((item) => item.targetId)
    : [];
  return {
    ...row,
    dirtyFiles,
    stale: row.staleReason != null,
    ...(snapshot ? { snapshotId: snapshot.snapshotId, baseCommit, mergeBaseCommit: snapshot.mergeBaseCommit, cacheState: snapshot.cacheState, changedFiles: snapshot.changedFiles, reusePercent: snapshot.totalFiles ? Math.max(0, 100 - (snapshot.changedFiles / snapshot.totalFiles * 100)) : 100, deploymentTargets } : { cacheState: "legacy" as const }),
    coverageGaps,
  };
}

// Bulk variant for list/status surfaces. The single-branch helper remains the
// canonical path for focused queries, while Wiki/CLI status must not perform
// one stale/trust/deployment query per branch.
function trustEnvelopesForBranches(store: KnowledgeStore, branchIds: string[]): Map<string, TrustEnvelope> {
  const out = new Map<string, TrustEnvelope>();
  if (branchIds.length === 0) return out;
  const marks = branchIds.map(() => "?").join(",");
  type BranchTrustRow = {
    repoId: string; repoName: string; branchId: string; branchName: string;
    headCommit: string | null; indexedCommit: string | null; indexedAt: string | null;
    worktreeState: TrustEnvelope["worktreeState"]; worktreeFingerprint: string | null;
    dirtyFiles: string; parserVersion: string | null; schemaVersion: number | null; staleReason: string | null;
  };
  type SnapshotTrustRow = {
    branchId: string; snapshotId: string; baseSnapshotId: string | null; mergeBaseCommit: string | null;
    cacheState: "ready" | "cold"; changedFiles: number; totalFiles: number; baseCommit: string | null;
  };
  const branches = store.db.prepare(
    `SELECT r.id AS repoId, r.name AS repoName,
            b.id AS branchId, b.name AS branchName, b.head_commit AS headCommit,
            b.last_indexed_commit AS indexedCommit, b.last_indexed_at AS indexedAt,
            b.indexed_worktree_state AS worktreeState,
            b.indexed_worktree_fingerprint AS worktreeFingerprint,
            b.indexed_dirty_files AS dirtyFiles, b.parser_version AS parserVersion,
            b.indexed_schema_version AS schemaVersion, b.stale_reason AS staleReason
       FROM branches b JOIN repos r ON r.id=b.repo_id
      WHERE b.id IN (${marks})`,
  ).all(...branchIds) as BranchTrustRow[];
  const snapshots = store.db.prepare(
    `SELECT b.id AS branchId, s.id AS snapshotId, s.base_snapshot_id AS baseSnapshotId,
            s.merge_base_sha AS mergeBaseCommit, s.state AS cacheState,
            (SELECT COUNT(*) FROM snapshot_overlays o WHERE o.snapshot_id=s.id AND o.operation IN ('add','modify')) AS changedFiles,
            (SELECT COUNT(*) FROM effective_snapshot_files e WHERE e.snapshot_id=s.id) AS totalFiles,
            base.commit_sha AS baseCommit
       FROM branches b JOIN revision_snapshots s ON s.id=b.current_snapshot_id
       LEFT JOIN revision_snapshots base ON base.id=s.base_snapshot_id
      WHERE b.id IN (${marks})`,
  ).all(...branchIds) as SnapshotTrustRow[];
  const snapshotByBranch = new Map(snapshots.map((row) => [row.branchId, row]));
  const snapshotIds = snapshots.map((row) => row.snapshotId);
  const deploymentBySnapshot = new Map<string, string[]>();
  if (snapshotIds.length > 0) {
    const snapshotMarks = snapshotIds.map(() => "?").join(",");
    for (const row of store.db.prepare(
      `SELECT DISTINCT s.id AS snapshotId, d.target_id AS targetId
         FROM revision_snapshots s
         JOIN deployment_revisions d ON d.repo_id=s.repo_id AND d.commit_sha=s.commit_sha
        WHERE s.id IN (${snapshotMarks})`,
    ).all(...snapshotIds) as Array<{ snapshotId: string; targetId: string }>) {
      const list = deploymentBySnapshot.get(row.snapshotId) ?? [];
      if (!list.includes(row.targetId)) list.push(row.targetId);
      deploymentBySnapshot.set(row.snapshotId, list);
    }
  }
  for (const row of branches) {
    let dirtyFiles: string[] = [];
    try {
      const parsed = JSON.parse(row.dirtyFiles);
      dirtyFiles = Array.isArray(parsed) ? parsed.filter((file): file is string => typeof file === "string") : [];
    } catch { /* malformed legacy metadata is treated as empty */ }
    const snapshot = snapshotByBranch.get(row.branchId);
    const coverageGaps = row.worktreeState === "unknown" ? ["git_status_unavailable"] : [];
    out.set(row.branchId, {
      ...row,
      dirtyFiles,
      stale: row.staleReason != null,
      ...(snapshot ? {
        snapshotId: snapshot.snapshotId,
        baseCommit: snapshot.baseCommit,
        mergeBaseCommit: snapshot.mergeBaseCommit,
        cacheState: snapshot.cacheState,
        changedFiles: snapshot.changedFiles,
        reusePercent: snapshot.totalFiles ? Math.max(0, 100 - (snapshot.changedFiles / snapshot.totalFiles * 100)) : 100,
        deploymentTargets: deploymentBySnapshot.get(snapshot.snapshotId) ?? [],
      } : { cacheState: "legacy" as const }),
      coverageGaps,
    });
  }
  return out;
}

// "Which branch am I answering for, and is it current?" — compares the live git
// HEAD (passed by the caller, which can read .git) against what was indexed.
// Every Context Pack / answer should carry this so an AI never trusts a stale
// or wrong-branch view (§ Phase 1).
export function branchFreshness(
  store: KnowledgeStore,
  branchId: string,
  currentHeadCommit?: string | null,
): BranchFreshness | null {
  const b = store.db
    .prepare("SELECT id, name, status, last_indexed_commit AS ic, last_indexed_at AS ia FROM branches WHERE id=?")
    .get(branchId) as { id: string; name: string; status: string; ic: string | null; ia: string | null } | undefined;
  if (!b) return null;
  const short = (c: string) => c.slice(0, 8);
  let stale = false;
  let reason = "fresh";
  if (!b.ia) { stale = true; reason = "never indexed"; }
  else if (currentHeadCommit && b.ic && currentHeadCommit !== b.ic) {
    stale = true;
    reason = `branch advanced: HEAD ${short(currentHeadCommit)} ≠ indexed ${short(b.ic)} — re-index`;
  }
  return { branchId: b.id, name: b.name, status: b.status, indexedCommit: b.ic, indexedAt: b.ia, stale, reason };
}

export function liveBranchOf(store: KnowledgeStore, nodeId: string): string | null {
  const n = store.getNode(nodeId);
  if (!n?.repo_id) return null;
  const b = store.db
    .prepare("SELECT id FROM branches WHERE repo_id=? AND status='live' ORDER BY last_indexed_at DESC LIMIT 1")
    .get(n.repo_id) as { id: string } | undefined;
  return b?.id ?? null;
}

export interface QueryDiagnostics {
  resolutionStatus:
    | "resolved"
    | "no_match"
    | "ambiguous"
    | "stale_target"
    | "not_indexed"
    | "assembly_error";
  resultStatus:
    | "has_results"
    | "no_static_edge"
    | "unresolved_edges"
    | "query_error";
  target: {
    requested: string;
    resolvedNodeId: string | null;
    repo: string | null;
    branch: string | null;
  };
  freshness: {
    status: "fresh" | "dirty" | "stale" | "unknown";
    indexedCommit: string | null;
    headCommit: string | null;
    dirtyFileCount: number | null;
  } | null;
  evidence: {
    incomingByType: Record<string, number>;
    outgoingByType: Record<string, number>;
    unresolvedReferenceCount: number;
  };
  coverageGaps: string[];
}

function edgeCountsByType(
  store: KnowledgeStore,
  nodeId: string,
  direction: "incoming" | "outgoing",
): Record<string, number> {
  const column = direction === "incoming" ? "dst" : "src";
  const rows = store.db
    .prepare(
      `SELECT edge_type AS edgeType, COUNT(*) AS count
         FROM edges
        WHERE ${column}=? AND status='active' AND method IN ('EXTRACTED','ASSERTED')
        GROUP BY edge_type
        ORDER BY edge_type`,
    )
    .all(nodeId) as Array<{ edgeType: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.edgeType, row.count]));
}

function staleExactTargetExists(store: KnowledgeStore, requested: string): boolean {
  const row = store.db
    .prepare(
      `SELECT n.id
         FROM nodes n
         JOIN symbol_versions sv ON sv.node_id=n.id
        WHERE (n.id=? OR n.identity_key=? OR n.title=?)
        GROUP BY n.id
       HAVING SUM(CASE WHEN sv.status='fresh' THEN 1 ELSE 0 END)=0
        LIMIT 1`,
    )
    .get(requested, requested, requested) as { id: string } | undefined;
  return !!row;
}

function buildQueryDiagnostics(
  store: KnowledgeStore,
  requested: string,
  resolvedNodeId: string | null,
  resultCount: number,
  options?: { branchId?: string; assemblyError?: string | null },
): QueryDiagnostics {
  const repoCount = (
    store.db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number }
  ).count;
  const symbolResolution = resolvedNodeId ? null : resolveSymbolMatches(store, requested);
  const resolutionStatus: QueryDiagnostics["resolutionStatus"] = options?.assemblyError
    ? "assembly_error"
    : resolvedNodeId
      ? "resolved"
      : repoCount === 0
        ? "not_indexed"
        : symbolResolution?.kind === "ambiguous"
          ? "ambiguous"
          : staleExactTargetExists(store, requested)
            ? "stale_target"
            : "no_match";
  const branchId = resolvedNodeId
    ? options?.branchId ?? liveBranchOf(store, resolvedNodeId)
    : null;
  const trust = trustEnvelopeForBranch(store, branchId);
  const node = resolvedNodeId ? store.getNode(resolvedNodeId) : null;
  const repo = node?.repo_id
    ? (store.db.prepare("SELECT name FROM repos WHERE id=?").get(node.repo_id) as
        | { name: string }
        | undefined)
    : undefined;
  const freshness = trust
    ? {
        status: trust.stale
          ? "stale" as const
          : trust.worktreeState === "dirty"
            ? "dirty" as const
            : trust.worktreeState === "unknown"
              ? "unknown" as const
              : "fresh" as const,
        indexedCommit: trust.indexedCommit,
        headCommit: trust.headCommit,
        dirtyFileCount: trust.dirtyFiles.length,
      }
    : null;
  const coverageGaps = new Set(trust?.coverageGaps ?? []);
  coverageGaps.add("unresolved_reference_counts_not_persisted");
  return {
    resolutionStatus,
    resultStatus: resolutionStatus !== "resolved"
      ? "query_error"
      : resultCount > 0
        ? "has_results"
        : "no_static_edge",
    target: {
      requested,
      resolvedNodeId,
      repo: repo?.name ?? trust?.repoName ?? null,
      branch: trust?.branchName ?? null,
    },
    freshness,
    evidence: {
      incomingByType: resolvedNodeId
        ? edgeCountsByType(store, resolvedNodeId, "incoming")
        : {},
      outgoingByType: resolvedNodeId
        ? edgeCountsByType(store, resolvedNodeId, "outgoing")
        : {},
      unresolvedReferenceCount: 0,
    },
    coverageGaps: [...coverageGaps],
  };
}

// explore_graph: one traversal entry point across modes (§8.1).
export function exploreGraph(
  store: KnowledgeStore,
  mode: GraphMode,
  nodeOrKey: string,
  options?: { depth?: number; limit?: number; to?: string; branchId?: string; revision?: RevisionContext },
): GraphResult {
  const limit = options?.limit ?? 100;

  if (mode === "timeline" || mode === "recent_changes") {
    if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
      const events = (store.db.prepare("SELECT event_type AS eventType, ts, origin, method, node_id AS nodeId FROM events WHERE repo_id IS NULL OR repo_id=? ORDER BY ts DESC LIMIT ?").all(options.revision.repoId, limit) as GraphResult["events"]);
      return { mode, nodes: [], events, revision: options.revision } as GraphResult;
    }
    const nodeId = mode === "timeline" ? resolveNodeId(store, nodeOrKey) : null;
    const rows = (
      nodeId
        ? store.db.prepare(
            "SELECT event_type AS eventType, ts, origin, method, node_id AS nodeId FROM events WHERE node_id=? ORDER BY ts DESC LIMIT ?",
          ).all(nodeId, limit)
        : store.db.prepare(
            "SELECT event_type AS eventType, ts, origin, method, node_id AS nodeId FROM events ORDER BY ts DESC LIMIT ?",
          ).all(limit)
    ) as GraphResult["events"];
    return { mode, nodes: [], events: rows, revision: options?.revision } as GraphResult;
  }

  const nodeId = resolveNodeId(store, nodeOrKey);
  if (!nodeId) {
    return {
      mode,
      nodes: [],
      diagnostics: buildQueryDiagnostics(store, nodeOrKey, null, 0, {
        branchId: options?.branchId,
      }),
    };
  }
  // Set below (after the branch-scope fallback below fires) so the closure
  // sees the up-to-date value at call time — the revision-scoped early
  // returns above call graphResult() before this fires (never a fallback,
  // since an explicit revision was supplied), the plain-SQL modes below call
  // it after (scopeFallback reflects whether liveBranchOf actually filled in).
  //
  // CAUTION — ordering-dependent: correctness relies on the revision-scoped
  // early-return block (the `if (options?.revision?.snapshotId && ...)` block
  // immediately below, covering who_calls/calls_of/backlinks/who_injects/
  // impact/path) running and returning BEFORE the branch-scope fallback
  // assignment (`scopeFallback = !explicitBranchId && branchId ? ... `)
  // further down this function. If that assignment is ever hoisted above, or
  // the revision-scoped block is reordered to run after it, an explicit
  // revision would start getting marked as a live-branch fallback (or worse,
  // a genuine fallback could go unmarked) — do not reorder without keeping
  // this invariant true, and re-run tests/knowledge-fallback-honesty.test.mjs.
  let scopeFallback: { branchId: string } | undefined;
  const graphResult = (
    nodes: GraphResult["nodes"],
    events?: GraphResult["events"],
  ): GraphResult => ({
    mode,
    nodes,
    ...(events ? { events } : {}),
    diagnostics: buildQueryDiagnostics(store, nodeOrKey, nodeId, nodes.length, {
      branchId: options?.branchId,
    }),
    revision: options?.revision,
    ...(scopeFallback ? { scopeFallback } : {}),
  });

  // Trust filter (§3.3/§11): default traversal only follows confirmed edges —
  // unconfirmed AI suggestions (status='suggested') and rejected edges are out.
  // Parser confidence is explicit: EXTRACTED/ASSERTED edges are verified for
  // deterministic impact; INFERRED edges remain candidate evidence and are
  // never silently promoted into a hard blast-radius answer.
  const ACTIVE = "status='active' AND method IN ('EXTRACTED','ASSERTED')";
  if (options?.revision?.snapshotId && !options.revision.snapshotId.startsWith("legacy:")) {
    const targetKey = store.getNode(nodeId)?.identity_key ?? nodeOrKey;
    const view = openRevisionView(store, options.revision);
    const all = view.edges({ limit: 10000 });
    const nodeFor = (key?: string) => key ? store.findNodeIdByIdentity(key) : null;
    const incoming = (key: string, type?: string) => all.filter((edge) => edge.dstIdentityKey === key && (!type || edge.edgeType === type)).map((edge) => edge.srcIdentityKey);
    const outgoing = (key: string, type?: string) => all.filter((edge) => edge.srcIdentityKey === key && (!type || edge.edgeType === type)).map((edge) => edge.dstIdentityKey).filter((key): key is string => Boolean(key));
    if (mode === "who_calls") return graphResult([...new Set(incoming(targetKey, "calls"))].map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    if (mode === "calls_of") return graphResult([...new Set(outgoing(targetKey, "calls"))].map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    if (mode === "backlinks") return graphResult([...new Set(incoming(targetKey))].map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    if (mode === "who_injects") {
      const classes = new Set<string>();
      for (const key of incoming(targetKey, "references")) if (key.endsWith(".constructor")) { const id = nodeFor(key.slice(0, -".constructor".length)); if (id) classes.add(id); }
      return graphResult([...classes].slice(0, limit).map((id) => nodeBrief(store, id)));
    }
    if (mode === "impact") {
      const seen = new Set<string>([targetKey]); let frontier = [targetKey];
      for (let depth = 0; depth < (options.depth ?? 3); depth++) { const next: string[] = []; for (const key of frontier) for (const child of incoming(key, "calls")) if (!seen.has(child)) { seen.add(child); next.push(child); } frontier = next; }
      return graphResult([...seen].filter((key) => key !== targetKey).map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    }
    if (mode === "path") {
      const toId = options.to ? resolveNodeId(store, options.to) : null;
      const toKey = toId ? store.getNode(toId)?.identity_key : null;
      if (!toKey) return graphResult([]);
      const prev = new Map<string, string>(); const queue = [targetKey]; const seen = new Set(queue);
      while (queue.length) {
        const current = queue.shift()!;
        if (current === toKey) break;
        for (const next of outgoing(current)) if (!seen.has(next)) { seen.add(next); prev.set(next, current); queue.push(next); }
      }
      if (!seen.has(toKey)) return graphResult([]);
      const chain: string[] = []; for (let key: string | undefined = toKey; key; key = prev.get(key)) chain.unshift(key);
      return graphResult(chain.map(nodeFor).filter((id): id is string => Boolean(id)).map((id) => nodeBrief(store, id)));
    }
  }
  // Branch-scope (correctness): when a branch is given, only follow edges on that
  // branch (plus branch-less edges like git topology / cross-repo endpoints).
  // Without it, a repo indexed on multiple branches would silently mix branches.
  const explicitBranchId = revisionBranchId(options);
  const branchId = explicitBranchId ?? liveBranchOf(store, nodeId);
  scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const P = (nid: string) => (branchId ? [nid, branchId, limit] : [nid, limit]);
  const Pd = (nid: string) => (branchId ? [nid, branchId] : [nid]); // no LIMIT (impact/path)
  if (mode === "who_calls") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='calls' AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { src: string }[];
    return graphResult(rows.map((r) => nodeBrief(store, r.src)));
  }
  // NestJS-style constructor-injection dependents. A constructor parameter's
  // type annotation is already extracted as a `references` edge from
  // `<Class>.constructor` (who_calls never looks at this edge type, only
  // `calls` — real gap: `who_calls SomeInjectedService` always came back
  // empty even though the dependency data already existed). Restricting to
  // src identity_keys ending ".constructor" is what excludes an unrelated
  // type reference elsewhere from being mistaken for injection, and
  // resolving to the enclosing class (not the constructor symbol itself) is
  // what makes the result read as "X depends on Y" instead of
  // "X.constructor depends on Y".
  if (mode === "who_injects") {
    const CTOR_SUFFIX = ".constructor";
    const rows = store.db
      .prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='references' AND ${ACTIVE}${bx}`)
      .all(...Pd(nodeId)) as { src: string }[];
    const classIds = new Set<string>();
    for (const r of rows) {
      const srcNode = store.getNode(r.src);
      if (!srcNode?.identity_key.endsWith(CTOR_SUFFIX)) continue;
      const classKey = srcNode.identity_key.slice(0, -CTOR_SUFFIX.length);
      const classId = store.findNodeIdByIdentity(classKey);
      if (classId) classIds.add(classId);
    }
    return graphResult([...classIds].slice(0, limit).map((id) => nodeBrief(store, id)));
  }
  if (mode === "calls_of") {
    const rows = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND edge_type='calls' AND dst IS NOT NULL AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { dst: string }[];
    return graphResult(rows.map((r) => nodeBrief(store, r.dst)));
  }
  if (mode === "backlinks") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { src: string }[];
    return graphResult(rows.map((r) => nodeBrief(store, r.src)));
  }
  if (mode === "impact") {
    // transitive who_calls up to depth
    const depth = options?.depth ?? 3;
    const seen = new Set<string>([nodeId]);
    let frontier = [nodeId];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const callers = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='calls' AND ${ACTIVE}${bx}`).all(...Pd(id)) as { src: string }[];
        for (const c of callers) if (!seen.has(c.src)) { seen.add(c.src); next.push(c.src); }
      }
      frontier = next;
    }
    seen.delete(nodeId);
    return graphResult([...seen].slice(0, limit).map((id) => nodeBrief(store, id)));
  }
  if (mode === "path") {
    const to = options?.to ? resolveNodeId(store, options.to) : null;
    if (!to) return graphResult([]);
    // BFS over active edges src→dst
    const prev = new Map<string, string>();
    const queue = [nodeId];
    const visited = new Set([nodeId]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === to) break;
      const outs = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND dst IS NOT NULL AND ${ACTIVE}${bx}`).all(...Pd(cur)) as { dst: string }[];
      for (const o of outs) if (!visited.has(o.dst)) { visited.add(o.dst); prev.set(o.dst, cur); queue.push(o.dst); }
    }
    if (!visited.has(to)) return graphResult([]);
    const chain: string[] = [];
    for (let c: string | undefined = to; c; c = prev.get(c)) chain.unshift(c);
    return graphResult(chain.map((id) => nodeBrief(store, id)));
  }
  return graphResult([]);
}

export interface BranchDiff {
  symbol: string;
  branchA: { branchId: string; contentHash: string | null; status: string | null };
  branchB: { branchId: string; contentHash: string | null; status: string | null };
  identical: boolean;
  revision?: RevisionContext;
}

// compare_branches: same symbol across two branches; equal hash = no diff (§8.1).
export function compareBranches(
  store: KnowledgeStore,
  symbolIdOrKey: string,
  branchAId: string,
  branchBId: string,
  options?: { revision?: RevisionContext },
): BranchDiff | null {
  const nodeId = resolveNodeId(store, symbolIdOrKey);
  if (!nodeId) return null;
  const va = options?.revision && !options.revision.snapshotId.startsWith("legacy:")
    ? openRevisionView(store, options.revision).symbolVersions([nodeId])[0] && { content_hash: openRevisionView(store, options.revision).symbolVersions([nodeId])[0].contentHash, status: "fresh" }
    : store.getSymbolVersion(nodeId, branchAId);
  const vb = store.getSymbolVersion(nodeId, branchBId);
  return {
    symbol: symbolIdOrKey,
    branchA: { branchId: branchAId, contentHash: va?.content_hash ?? null, status: va?.status ?? null },
    branchB: { branchId: branchBId, contentHash: vb?.content_hash ?? null, status: vb?.status ?? null },
    identical: !!va && !!vb && va.content_hash === vb.content_hash,
    revision: options?.revision,
  };
}

export interface IndexStatus {
  repos: Array<{
    repoId: string; name: string; rootPath: string;
    defaultBranch: string | null;
    branches: Array<{
      branchId: string; name: string; status: string; lastIndexedAt: string | null; defaultBranch: boolean; baseBranchName: string | null;
      staleSymbols: number; pinned: boolean; trust: TrustEnvelope | null;
    }>;
  }>;
}

export interface CompactRepoStatus {
  repo: string;
  liveBranch: string | null;
  freshness: "fresh" | "dirty" | "stale" | "unknown";
  dirtyFileCount: number | null;
  indexedCommit: string | null;
  headCommit: string | null;
  parserVersion: string | null;
  indexErrorCount: number;
}

export interface CompactIndexStatus {
  summary: {
    totalRepos: number;
    fresh: number;
    dirty: number;
    stale: number;
    unknown: number;
    errors: number;
  };
  repos: CompactRepoStatus[];
}

// The pending AI-suggestion queue (edges awaiting accept/reject, §8.2).
export function listSuggestions(store: KnowledgeStore) {
  return store.listSuggestions();
}

// Distinct tags across all nodes (tags live in node meta.tags). Powers the
// Wiki editor's `#` autocomplete and tag filtering. Uses SQLite JSON1.
export function listTags(store: KnowledgeStore): string[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT je.value AS tag
         FROM nodes, json_each(json_extract(nodes.meta, '$.tags')) je
        WHERE je.value IS NOT NULL
        ORDER BY tag`,
    )
    .all() as { tag: string }[];
  return rows.map((r) => r.tag);
}

// —— 索引浏览:repo → branch → file → symbol(Wiki 导航树,§8.1）——

export interface IndexedFileRow {
  filePath: string;
  lang: string | null;
  status: string; // indexed | skipped | deleted
  sizeBytes: number | null;
  indexedAt: string | null;
  error: string | null;
}

// The files captured for a repo/branch (the file-tree source). Ordered by path.
export function listIndexedFiles(
  store: KnowledgeStore,
  repoId: string,
  branchIdOrOptions: string | { branchId?: string; revision?: RevisionContext },
): IndexedFileRow[] {
  const branchId = typeof branchIdOrOptions === "string"
    ? branchIdOrOptions
    : revisionBranchId(branchIdOrOptions);
  if (!branchId) return [];
  if (typeof branchIdOrOptions !== "string" && branchIdOrOptions.revision && !branchIdOrOptions.revision.snapshotId.startsWith("legacy:")) {
    return openRevisionView(store, branchIdOrOptions.revision).listFiles().map((row) => ({ filePath: row.filePath, lang: row.language || null, status: "indexed", sizeBytes: null, indexedAt: null, error: null }));
  }
  return store.db
    .prepare(
      `SELECT file_path AS filePath, lang, status, size_bytes AS sizeBytes,
              indexed_at AS indexedAt, error
       FROM files_index WHERE repo_id=? AND branch_id=? ORDER BY file_path`,
    )
    .all(repoId, branchId) as IndexedFileRow[];
}

export interface FileSymbolRow {
  nodeId: string;
  title: string;
  kind: string;
  status: string; // fresh | stale
}

// The symbols defined in one file on one branch (click-a-file → its symbols).
export function listFileSymbols(
  store: KnowledgeStore,
  branchIdOrOptions: string | { branchId?: string; revision?: RevisionContext },
  filePath: string,
): FileSymbolRow[] {
  const branchId = typeof branchIdOrOptions === "string"
    ? branchIdOrOptions
    : revisionBranchId(branchIdOrOptions);
  if (!branchId) return [];
  if (typeof branchIdOrOptions !== "string" && branchIdOrOptions.revision && !branchIdOrOptions.revision.snapshotId.startsWith("legacy:")) {
    return openRevisionView(store, branchIdOrOptions.revision).symbolVersions().filter((row) => row.filePath === filePath).map((row) => ({ nodeId: row.nodeId, title: row.title, kind: row.kind, status: "fresh" }));
  }
  return store.db
    .prepare(
      `SELECT sv.node_id AS nodeId, n.title AS title, sv.kind AS kind, sv.status AS status
       FROM symbol_versions sv JOIN nodes n ON n.id = sv.node_id
       WHERE sv.branch_id=? AND sv.file_path=? ORDER BY n.title`,
    )
    .all(branchId, filePath) as FileSymbolRow[];
}

// —— 图谱视图:节点-连线(Obsidian 式,§8.1)——

export interface GraphView {
  focus: string | null; // the centered node (null for repo-scoped view)
  nodes: Array<{ nodeId: string; title: string; nodeType: string; revisionId?: string }>;
  edges: Array<{ src: string; dst: string; edgeType: string; sourceType?: string | null }>;
}

// Local graph: a focus node + its neighbourhood within `depth` hops (both
// directions over active edges), capped at `limit` nodes. Only active edges
// (confirmed) are followed — same trust rule as exploreGraph. 22k-node graphs
// can't render whole, so callers recenter by picking a neighbour as new focus.
export function graphNeighborhood(
  store: KnowledgeStore,
  nodeOrKey: string,
  options?: { depth?: number; limit?: number; branchId?: string; revision?: RevisionContext },
): GraphView {
  const focus = resolveNodeId(store, nodeOrKey);
  if (!focus) return { focus: null, nodes: [], edges: [] };
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const pairs = snapshotEdgePairs(store, options.revision);
    const ids = new Set<string>([focus]);
    const maxDepth = Math.min(3, Math.max(1, options.depth ?? 1));
    let frontier = [focus];
    for (let depth = 0; depth < maxDepth && frontier.length && ids.size < (options?.limit ?? 150); depth += 1) {
      const next: string[] = [];
      for (const pair of pairs) {
        if (!pair.dst) continue;
        if (!frontier.includes(pair.src) && !frontier.includes(pair.dst)) continue;
        const other = frontier.includes(pair.src) ? pair.dst : pair.src;
        if (!ids.has(other) && ids.size < (options?.limit ?? 150)) { ids.add(other); next.push(other); }
      }
      frontier = next;
    }
    const graph = collectGraph(store, [...ids], undefined, options?.limit ?? 150, pairs);
    return { focus, nodes: graph.nodes.map((node) => ({ ...node, revisionId: options.revision!.snapshotId })), edges: graph.edges };
  }
  const depth = Math.min(3, Math.max(1, options?.depth ?? 1));
  const limit = options?.limit ?? 150;
  const branchId = revisionBranchId(options) ?? null;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";

  const neighbours = store.db.prepare(
    `SELECT dst AS other FROM edges WHERE src=? AND dst IS NOT NULL AND status='active'${bx}
     UNION SELECT src AS other FROM edges WHERE dst=? AND status='active'${bx}`,
  );
  const nParams = (id: string) => (branchId ? [id, branchId, id, branchId] : [id, id]);
  const seen = new Set<string>([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.size >= limit) break;
      for (const row of neighbours.all(...nParams(id)) as { other: string }[]) {
        if (!seen.has(row.other) && seen.size < limit) {
          seen.add(row.other);
          next.push(row.other);
        }
      }
    }
    frontier = next;
  }
  // Every symbol now connects to its file node via a real `defines` edge (P1),
  // so a focused node always has a genuine neighbourhood — no synthetic fallback
  // needed (removing it keeps the graph free of edges that aren't real facts).
  return { focus, ...collectGraph(store, [...seen]) };
}

// Repo/branch-scoped view: the top-`limit` most-connected nodes (by active
// branch-scoped edge degree) plus the edges among them. Keeps a big repo's
// graph readable by showing its hubs rather than every leaf.
export function repoGraph(
  store: KnowledgeStore,
  repoId: string,
  branchIdOrOptions: string | { branchId?: string; revision?: RevisionContext },
  options?: { limit?: number; edgeLimit?: number },
): GraphView {
  const branchId = typeof branchIdOrOptions === "string"
    ? branchIdOrOptions
    : revisionBranchId(branchIdOrOptions);
  if (!branchId) return { focus: null, nodes: [], edges: [] };
  if (typeof branchIdOrOptions !== "string" && branchIdOrOptions.revision && !branchIdOrOptions.revision.snapshotId.startsWith("legacy:")) {
    const revision = branchIdOrOptions.revision;
    const ids = [...(snapshotNodeIds(store, revision) ?? new Set())].filter((id) => store.getNode(id)?.repo_id === repoId).slice(0, options?.limit ?? 150);
    return { focus: null, ...collectGraph(store, ids, undefined, options?.edgeLimit, snapshotEdgePairs(store, revision)) };
  }
  const limit = options?.limit ?? 150;
  const genericNames = [...GENERIC_UTILITY_HUB_NAMES];
  const genericPlaceholders = genericNames.map(() => "?").join(",");
  const top = store.db
    .prepare(
      `SELECT d.id AS id FROM (
         SELECT node AS id, COUNT(*) AS cnt FROM (
           SELECT src AS node FROM edges WHERE branch_id=? AND status='active'
           UNION ALL
           SELECT dst AS node FROM edges WHERE branch_id=? AND status='active' AND dst IS NOT NULL
         ) GROUP BY node
       ) d JOIN nodes n ON n.id = d.id
       WHERE n.repo_id=? AND LOWER(n.title) NOT IN (${genericPlaceholders})
       ORDER BY d.cnt DESC, d.id LIMIT ?`,
    )
    .all(branchId, branchId, repoId, ...genericNames, limit) as { id: string }[];
  const ids = top.map((r) => r.id);
  if (ids.length === 0) return { focus: null, nodes: [], edges: [] };
  return { focus: null, ...collectGraph(store, ids, branchId, options?.edgeLimit) };
}

// Build {nodes, edges} for a fixed node-id set — edges only where BOTH ends are
// in the set (optionally scoped to a branch). Shared by the two graph views.
// Edges are capped (dense hub nodes can otherwise yield tens of thousands of
// edges — a force/3D layout that freezes the UI) and ordered so the meaningful
// relations survive the cap: cross-service (invokes/handles) first, then calls,
// with `defines`/`imports` noise last.
function collectGraph(
  store: KnowledgeStore,
  ids: string[],
  branchId?: string,
  edgeLimit = 1000,
  providedEdges?: Array<{ src: string; dst: string | null; edgeType: string }>,
): { nodes: GraphView["nodes"]; edges: GraphView["edges"] } {
  const nodes = ids.map((id) => nodeBrief(store, id));
  const ph = ids.map(() => "?").join(",");
  const branchClause = branchId ? "AND branch_id=?" : "";
  const params = branchId ? [branchId, ...ids, ...ids, edgeLimit] : [...ids, ...ids, edgeLimit];
  const edges = providedEdges
    ? providedEdges.filter((edge) => edge.dst && ids.includes(edge.src) && ids.includes(edge.dst)).slice(0, edgeLimit).map((edge) => ({ src: edge.src, dst: edge.dst!, edgeType: edge.edgeType, sourceType: null }))
    : store.db
    .prepare(
      `SELECT src, dst, edge_type AS edgeType, source_type AS sourceType FROM edges
       WHERE status='active' AND dst IS NOT NULL ${branchClause}
         AND src IN (${ph}) AND dst IN (${ph})
       ORDER BY CASE edge_type
         WHEN 'invokes' THEN 0 WHEN 'handles' THEN 1 WHEN 'calls' THEN 2
         WHEN 'references' THEN 3 WHEN 'tests' THEN 4 WHEN 'imports' THEN 5 ELSE 6 END
       LIMIT ?`,
    )
    .all(...params) as GraphView["edges"];
  // Backfill false isolates: the priority order above decides which edge TYPES
  // survive the cap, but within the losing rank the cut is arbitrary — a node
  // can lose every one of its edges and render as if it had no relationships
  // at all (which reads as an indexing error, not a display cap). Any in-set
  // node with zero selected edges gets its top few in-set edges back; the
  // per-node bound keeps the overflow small.
  const touched = new Set<string>();
  for (const e of edges) {
    touched.add(e.src);
    if (e.dst) touched.add(e.dst);
  }
  const isolated = ids.filter((id) => !touched.has(id));
  if (isolated.length > 0) {
    const seen = new Set(edges.map((e) => `${e.src}\0${e.dst}\0${e.edgeType}`));
    const perNode = store.db.prepare(
      `SELECT src, dst, edge_type AS edgeType, source_type AS sourceType FROM edges
       WHERE status='active' AND dst IS NOT NULL ${branchClause}
         AND (src = ? OR dst = ?) AND src IN (${ph}) AND dst IN (${ph})
       ORDER BY CASE edge_type
         WHEN 'invokes' THEN 0 WHEN 'handles' THEN 1 WHEN 'calls' THEN 2
         WHEN 'references' THEN 3 WHEN 'tests' THEN 4 WHEN 'imports' THEN 5 ELSE 6 END,
         src, dst LIMIT 5`,
    );
    for (const id of isolated) {
      const extraParams = branchId ? [branchId, id, id, ...ids, ...ids] : [id, id, ...ids, ...ids];
      for (const e of perNode.all(...extraParams) as GraphView["edges"]) {
        const key = `${e.src}\0${e.dst}\0${e.edgeType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(e);
      }
    }
  }
  return { nodes, edges };
}

// index_status: repos/branches + staleness (answers list_repos/list_branches, §8.1).
export function indexStatus(store: KnowledgeStore): IndexStatus {
  const repos = store.db.prepare("SELECT id, name, root_path AS rootPath FROM repos ORDER BY name").all() as Array<{ id: string; name: string; rootPath: string }>;
  const branches = repos.length === 0 ? [] : store.db.prepare(
    `SELECT id, repo_id AS repoId, name, status, last_indexed_at AS lastIndexedAt,
            pinned, default_branch AS defaultBranch, base_branch_name AS baseBranchName
       FROM branches WHERE repo_id IN (${repos.map(() => "?").join(",")}) ORDER BY name`,
  ).all(...repos.map((repo) => repo.id)) as Array<{ id: string; repoId: string; name: string; status: string; lastIndexedAt: string | null; pinned: number; defaultBranch: number; baseBranchName: string | null }>;
  const staleCounts = new Map<string, number>();
  if (branches.length > 0) {
    for (const row of store.db.prepare(
      `SELECT branch_id AS branchId, COUNT(*) AS n FROM symbol_versions
        WHERE status='stale' AND branch_id IN (${branches.map(() => "?").join(",")}) GROUP BY branch_id`,
    ).all(...branches.map((branch) => branch.id)) as Array<{ branchId: string; n: number }>) staleCounts.set(row.branchId, row.n);
  }
  const trusts = trustEnvelopesForBranches(store, branches.map((branch) => branch.id));
  return {
    repos: repos.map((repo) => {
      const repoBranches = branches.filter((branch) => branch.repoId === repo.id);
      return {
        repoId: repo.id, name: repo.name, rootPath: repo.rootPath,
        defaultBranch: repoBranches.find((b) => b.defaultBranch === 1)?.name ?? null,
        branches: repoBranches.map((b) => {
          return {
            branchId: b.id, name: b.name, status: b.status,
            lastIndexedAt: b.lastIndexedAt, staleSymbols: staleCounts.get(b.id) ?? 0,
            pinned: !!b.pinned, defaultBranch: b.defaultBranch === 1, baseBranchName: b.baseBranchName, trust: trusts.get(b.id) ?? null,
          };
        }),
      };
    }),
  };
}

export function compactIndexStatus(store: KnowledgeStore): CompactIndexStatus {
  const detailed = indexStatus(store);
  const repos = detailed.repos.map((repo): CompactRepoStatus => {
    const live = repo.branches.find((branch) => branch.status === "live") ?? null;
    const trust = live?.trust ?? null;
    const errorRow = store.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM files_index
          WHERE repo_id=? AND status='error'`,
      )
      .get(repo.repoId) as { count: number };
    const freshness: CompactRepoStatus["freshness"] = trust === null
      ? "unknown"
      : trust.stale
        ? "stale"
        : trust.worktreeState === "dirty"
          ? "dirty"
          : trust.worktreeState === "unknown"
            ? "unknown"
            : "fresh";
    return {
      repo: repo.name,
      liveBranch: live?.name ?? null,
      freshness,
      dirtyFileCount: trust?.dirtyFiles.length ?? null,
      indexedCommit: trust?.indexedCommit ?? null,
      headCommit: trust?.headCommit ?? null,
      parserVersion: trust?.parserVersion ?? null,
      indexErrorCount: errorRow.count,
    };
  });
  return {
    summary: {
      totalRepos: repos.length,
      fresh: repos.filter((repo) => repo.freshness === "fresh").length,
      dirty: repos.filter((repo) => repo.freshness === "dirty").length,
      stale: repos.filter((repo) => repo.freshness === "stale").length,
      unknown: repos.filter((repo) => repo.freshness === "unknown").length,
      errors: repos.reduce((sum, repo) => sum + repo.indexErrorCount, 0),
    },
    repos,
  };
}

// —— AI Context Pack (§ vision主产品): 把富图变现成「AI 写代码前的最小必要上下文」——
// Not a graph dump: a focused, branch-aware bundle around one target — the code,
// who calls it, what it calls/uses, the routes that reach it, its tests, the
// errors/env it touches, linked notes, and risk signals. This is what an AI
// coding agent should read BEFORE editing (the differentiator over graph tools).

export interface ContextBrief {
  nodeId: string;
  title: string;
  nodeType: string;
}

export interface ContextPack {
  target: string;
  trust: TrustEnvelope | null;
  focus:
    | {
        nodeId: string;
        title: string;
        nodeType: string;
        kind: string | null;
        filePath: string | null;
        signature: string | null;
        source: string | null;
        branches: Array<{ branch: string; status: string }>;
      }
    | null;
  callers: ContextBrief[]; // who calls the focus (calls edges in)
  calls: ContextBrief[]; // what the focus calls (calls edges out)
  renderedBy: ContextBrief[]; // components that render the focus (renders edges in)
  renders: ContextBrief[]; // components the focus renders (renders edges out)
  invokedDynamicallyBy: ContextBrief[]; // callers using a callback prop
  invokesDynamic: ContextBrief[]; // callback props the focus invokes
  remoteCalls: ContextBrief[]; // gRPC services the focus invokes (invokes edges out, cross-service)
  invokedBy: ContextBrief[]; // symbols in OTHER services that invoke an endpoint this focus handles
  referencedBy: ContextBrief[]; // who uses this as a type (references in)
  usesTypes: ContextBrief[]; // types the focus uses (references out)
  routes: Array<{ route: string; via: "direct" | "caller" }>; // HTTP routes reaching the focus
  tests: ContextBrief[]; // test files that exercise the focus
  errors: string[]; // error types the focus throws
  envs: string[]; // env vars the focus reads
  notes: ContextBrief[]; // notes linked to the focus
  importers: ContextBrief[]; // files importing the focus's file
  signals: string[]; // risk/attention heuristics
  // Populated ONLY when `target` matched 2+ symbols and no single focus could
  // be chosen; null (not []) otherwise, so callers can tell "ambiguous" apart
  // from "zero matches" — both used to look identical (silent empty focus).
  ambiguous: SymbolCandidate[] | null;
  // Populated ONLY when `target` resolved to exactly one symbol but assembling
  // its context pack then threw (e.g. a corrupt/incomplete DB row) — a FOURTH
  // distinct outcome from zero/one/ambiguous: the symbol demonstrably exists,
  // so reporting this as "no context" would be misleading (looks like a typo
  // when it's actually an internal failure worth investigating/reporting).
  assemblyError: string | null;
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // query silently answered against the repo's live branch instead (see
  // FlowResult.scopeFallback).
  scopeFallback?: { branchId: string };
}

function briefsFrom(store: KnowledgeStore, rows: Array<{ id: string }>): ContextBrief[] {
  return rows.map((r) => {
    const b = nodeBrief(store, r.id);
    return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType };
  });
}

export function buildContextPack(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; revision?: RevisionContext; limit?: number },
): ContextPack {
  const limit = options?.limit ?? 25;
  const empty: ContextPack = {
    target, trust: null, focus: null, callers: [], calls: [], renderedBy: [], renders: [],
    invokedDynamicallyBy: [], invokesDynamic: [], remoteCalls: [], invokedBy: [],
    referencedBy: [], usesTypes: [],
    routes: [], tests: [], errors: [], envs: [], notes: [], importers: [], signals: [],
    ambiguous: null, assemblyError: null,
  };
  let resolution: SymbolResolution;
  try {
    resolution = resolveSymbolMatches(store, target, options);
  } catch (e) {
    return { ...empty, assemblyError: (e as Error).message };
  }
  if (resolution.kind === "none") return empty;
  if (resolution.kind === "ambiguous") return { ...empty, ambiguous: resolution.candidates };
  const focusId = resolution.nodeId;

  // The symbol DID resolve uniquely at this point — any throw from here on is
  // an internal assembly failure (corrupt/incomplete row, disk read fault,
  // etc.), NOT "not found". Surfacing it as assemblyError keeps it from being
  // silently indistinguishable from a genuine zero-match.
  try {
    return buildContextPackBody(store, target, focusId, limit, options);
  } catch (e) {
    return { ...empty, assemblyError: (e as Error).message };
  }
}

function buildContextPackBody(
  store: KnowledgeStore,
  target: string,
  focusId: string,
  limit: number,
  options: { branchId?: string; revision?: RevisionContext; limit?: number } | undefined,
): ContextPack {
  const detail = getNodeDetail(store, focusId, options);
  const active = "status='active'";
  // Branch-scope to the focus's live branch (or an explicit one) so a repo indexed
  // on multiple branches doesn't mix them. branch-less edges (git / global gRPC
  // endpoints) always pass so cross-repo links aren't dropped.
  const explicitBranchId = revisionBranchId(options);
  const branchId = explicitBranchId ?? liveBranchOf(store, focusId);
  const scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const snapshotRevision = options?.revision && !options.revision.snapshotId.startsWith("legacy:") ? options.revision : null;
  const snapshotIds = (type: string, direction: "in" | "out") => snapshotEdgePairsForNodes(
    store,
    snapshotRevision!,
    [focusId],
    { edgeTypes: [type], direction, limit },
  )
    .map((edge) => direction === "in" ? edge.src : edge.dst).filter((id): id is string => Boolean(id)).map((id) => ({ id })).slice(0, limit);
  const inEdges = (type: string) =>
    snapshotRevision ? snapshotIds(type, "in") : store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type=? AND ${active}${bx} LIMIT ?`)
      .all(...(branchId ? [focusId, type, branchId, limit] : [focusId, type, limit])) as { id: string }[];
  const outEdges = (type: string) =>
    snapshotRevision ? snapshotIds(type, "out") : store.db.prepare(`SELECT DISTINCT dst AS id FROM edges WHERE src=? AND edge_type=? AND dst IS NOT NULL AND ${active}${bx} LIMIT ?`)
      .all(...(branchId ? [focusId, type, branchId, limit] : [focusId, type, limit])) as { id: string }[];

  const callers = inEdges("calls");
  const calls = outEdges("calls");
  const renderedBy = inEdges("renders");
  const renders = outEdges("renders");
  const invokedDynamicallyBy = inEdges("invokes_dynamic");
  const invokesDynamic = outEdges("invokes_dynamic");
  // Cross-service: gRPC endpoints this focus invokes (branch-less edges pass bx).
  const remoteCalls = outEdges("invokes");
  // Cross-service reverse: symbols in OTHER services that invoke an endpoint this
  // focus handles (focus ← handles ← endpoint ← invokes ← caller). Endpoints are
  // global + edges branch-less, so no branch scoping here.
  const handledEndpoints = store.db
    .prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type='handles' AND ${active}`)
    .all(focusId) as { id: string }[];
  const invokedBy = handledEndpoints.length
    ? (store.db
        .prepare(
          `SELECT DISTINCT src AS id FROM edges
           WHERE edge_type='invokes' AND ${active} AND src != ?
           AND dst IN (${handledEndpoints.map(() => "?").join(",")}) LIMIT ?`,
        )
        .all(focusId, ...handledEndpoints.map((e) => e.id), limit) as { id: string }[])
    : [];
  const referencedBy = inEdges("references");
  const usesTypes = outEdges("references");
  const tests = inEdges("tests");
  const errors = outEdges("throws").map((r) => nodeBrief(store, r.id).title);
  const envs = outEdges("uses").map((r) => nodeBrief(store, r.id).title);

  // routes: directly handled, or handled by a caller (route → handler → focus).
  const directRoutes = inEdges("handles");
  const callerIds = callers.map((c) => c.id);
  const routeSet = new Map<string, "direct" | "caller">();
  for (const r of directRoutes) routeSet.set(nodeBrief(store, r.id).title, "direct");
  if (callerIds.length) {
    const ph = callerIds.map(() => "?").join(",");
    const viaCaller = store.db
      .prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='handles' AND ${active} AND dst IN (${ph}) LIMIT ?`)
      .all(...callerIds, limit) as { id: string }[];
    for (const r of viaCaller) {
      const t = nodeBrief(store, r.id).title;
      if (!routeSet.has(t)) routeSet.set(t, "caller");
    }
  }
  const routes = [...routeSet].map(([route, via]) => ({ route, via }));

  // notes linked to the focus (any incoming edge whose source is a note node).
  const notes = briefsFrom(
    store,
    store.db.prepare(
      `SELECT DISTINCT e.src AS id FROM edges e JOIN nodes n ON n.id=e.src
       WHERE e.dst=? AND ${active} AND n.node_type='note' LIMIT ?`,
    ).all(focusId, limit) as { id: string }[],
  );

  // importers: files importing the focus's file (focus ← defines ← file → imports).
  const fileRow = store.db
    .prepare(`SELECT src AS id FROM edges WHERE dst=? AND edge_type='defines' AND ${active} LIMIT 1`)
    .get(focusId) as { id: string } | undefined;
  const importers = fileRow
    ? briefsFrom(store, store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type='imports' AND ${active} LIMIT ?`).all(fileRow.id, limit) as { id: string }[])
    : [];

  // risk/attention signals — cheap heuristics from the graph itself.
  const signals: string[] = [];
  const stale = (detail?.versions ?? []).filter((v) => v.status !== "fresh");
  if (stale.length) signals.push(`⚠ ${stale.length} stale version(s) — re-index before trusting`);
  const fanIn = (store.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE dst=? AND edge_type='calls' AND ${active}`).get(focusId) as { n: number }).n;
  if (fanIn >= 10) signals.push(`high fan-in: ${fanIn} callers — changes ripple widely`);
  const inferred = (store.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE (src=? OR dst=?) AND method='INFERRED' AND ${active}`).get(focusId, focusId) as { n: number }).n;
  if (inferred) signals.push(`${inferred} INFERRED edge(s) — some relations are best-guess, verify`);
  if (routes.length) signals.push(`reachable from ${routes.length} HTTP route(s) — public-facing`);
  if (remoteCalls.length) signals.push(`calls ${remoteCalls.length} remote gRPC endpoint(s) — cross-service dependency`);
  if (invokedBy.length) signals.push(`invoked by ${invokedBy.length} caller(s) in other services — cross-service contract`);

  return {
    target,
    trust: trustEnvelopeForBranch(store, branchId),
    focus: detail
      ? {
          nodeId: detail.node.id,
          title: detail.node.title,
          nodeType: detail.node.nodeType,
          kind: detail.versions[0]?.kind ?? null,
          filePath: detail.versions[0]?.filePath ?? null,
          signature: (detail.versions.find((v) => v.status === "fresh") ?? detail.versions[0])?.signature ?? null,
          source: detail.source?.code ?? detail.body ?? null,
          branches: detail.versions.map((v) => ({ branch: v.branchId, status: v.status })),
        }
      : null,
    callers: briefsFrom(store, callers),
    calls: briefsFrom(store, calls),
    renderedBy: briefsFrom(store, renderedBy),
    renders: briefsFrom(store, renders),
    invokedDynamicallyBy: briefsFrom(store, invokedDynamicallyBy),
    invokesDynamic: briefsFrom(store, invokesDynamic),
    remoteCalls: briefsFrom(store, remoteCalls),
    invokedBy: briefsFrom(store, invokedBy),
    referencedBy: briefsFrom(store, referencedBy),
    usesTypes: briefsFrom(store, usesTypes),
    routes,
    tests: briefsFrom(store, tests),
    errors,
    envs,
    notes,
    importers,
    signals,
    ambiguous: null,
    assemblyError: null,
    ...(scopeFallback ? { scopeFallback } : {}),
  };
}

// Render a Context Pack as Markdown — what an AI coding agent reads before editing.
export function renderContextPackMarkdown(pack: ContextPack): string {
  const L: string[] = [];
  const list = (title: string, items: ContextBrief[]) => {
    if (!items.length) return;
    L.push(`### ${title}`);
    for (const i of items) L.push(`- \`${i.title}\`${i.nodeType !== "symbol" ? ` (${i.nodeType})` : ""}`);
    L.push("");
  };
  if (!pack.focus) {
    if (pack.ambiguous) {
      return `# Context Pack: ${pack.target}\n\n${renderAmbiguousSymbols(pack.target, pack.ambiguous)}\n`;
    }
    if (pack.assemblyError) {
      return `# Context Pack: ${pack.target}\n\n_"${pack.target}" resolved to a symbol, but building its context failed: ${pack.assemblyError}_\n`;
    }
    return `# Context Pack: ${pack.target}\n\n_No matching symbol/note found for "${pack.target}". Not indexed, or the name doesn't match any symbol/note title or qualified name._\n`;
  }
  const f = pack.focus;
  L.push(`# Context Pack: ${f.title}`);
  L.push("");
  L.push(`- **type**: ${f.kind ?? f.nodeType}`);
  if (f.filePath) L.push(`- **file**: \`${f.filePath}\``);
  if (f.branches.length) L.push(`- **branches**: ${f.branches.map((b) => `${b.branch} (${b.status})`).join(", ")}`);
  L.push("");
  if (pack.signals.length) {
    L.push(`## ⚠ Signals`);
    for (const s of pack.signals) L.push(`- ${s}`);
    L.push("");
  }
  if (f.signature) {
    L.push(`## Signature`);
    L.push("```", f.signature, "```", "");
  }
  if (f.source) {
    L.push(`## Source`);
    L.push("```", f.source, "```", "");
  }
  if (pack.routes.length) {
    L.push(`## HTTP routes reaching this`);
    for (const r of pack.routes) L.push(`- ${r.route}${r.via === "caller" ? " (via caller)" : ""}`);
    L.push("");
  }
  list("Called by", pack.callers);
  list("Calls", pack.calls);
  list("Calls remote services (gRPC)", pack.remoteCalls);
  list("Invoked by other services (gRPC)", pack.invokedBy);
  list("Used as a type by", pack.referencedBy);
  list("Uses types", pack.usesTypes);
  list("Tested by", pack.tests);
  list("Linked notes", pack.notes);
  list("Imported by (files)", pack.importers);
  if (pack.errors.length) {
    L.push(`### Throws`);
    for (const e of pack.errors) L.push(`- ${e}`);
    L.push("");
  }
  if (pack.envs.length) {
    L.push(`### Env vars used`);
    for (const e of pack.envs) L.push(`- ${e}`);
    L.push("");
  }
  return L.join("\n");
}

// —— Flow Explorer (§ vision #3): a linear execution chain, not a graph blob ——
// From an endpoint or symbol, walk DOWNSTREAM edges (handles→calls→invokes→
// reads/writes→throws/uses) branch-scoped, producing an ordered, indented flow:
//   POST /withdraw → WithdrawController.create → WithdrawService.createWithdraw
//     → WalletService.freeze → [players] (reads) → RpcException (throws)
// This is what a developer/AI actually wants to see, not a cloud of dots.

export interface FlowStep {
  depth: number;
  nodeId: string;
  title: string;
  nodeType: string;
  via: string; // edge type from its parent ("root" for the entry)
  source?: { repoId: string; filePath: string; startLine: number; endLine?: number; revisionId: string };
}
export type FlowDiagnosticReason =
  | "not_indexed" // no gRPC endpoint or symbol/note matches the target at all
  | "ambiguous" // 2+ candidates (gRPC services sharing a method, or same-named symbols)
  | "endpoint_no_handler" // target resolved to a gRPC endpoint with no `handles` edge yet
  | "no_outgoing_edges"; // target resolved uniquely but is a dead end (leaf, or callees unindexed)
export interface FlowDiagnostic {
  reason: FlowDiagnosticReason;
  message: string;
  suggestions?: string[]; // "did you mean" — e.g. `penguin flow <nodeId>` for each candidate
}
export interface FlowResult {
  target: string;
  trust: TrustEnvelope | null;
  root: FlowStep | null;
  steps: FlowStep[];
  // Aggregated across every node in `steps`, so callers do not need one
  // context query per hop to discover regression tests and operational notes.
  relatedTests: ContextBrief[];
  linkedKnowledge: ContextBrief[];
  diagnostic?: FlowDiagnostic;
  ambiguous?: SymbolCandidate[]; // populated only when diagnostic.reason === "ambiguous"
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // query silently answered against the repo's live branch instead — an AI
  // consumer should know it got an implicit "whatever's live" answer, not a
  // revision it asked for (§ Phase 1 trust plumbing).
  scopeFallback?: { branchId: string };
}

function emptyFlowEnrichment(): Pick<FlowResult, "relatedTests" | "linkedKnowledge"> {
  return { relatedTests: [], linkedKnowledge: [] };
}

function flowEnrichment(
  store: KnowledgeStore,
  stepNodeIds: string[],
  options: {
    branchId?: string;
    limit: number;
    snapshotPairs?: Array<{ src: string; dst: string | null; edgeType: string }>;
    snapshotRevision?: RevisionContext;
  },
): Pick<FlowResult, "relatedTests" | "linkedKnowledge"> {
  const nodeIds = [...new Set(stepNodeIds)];
  if (nodeIds.length === 0) return emptyFlowEnrichment();
  const nodeSet = new Set(nodeIds);

  let testIds: string[];
  if (options.snapshotRevision) {
    testIds = snapshotEdgePairsForNodes(store, options.snapshotRevision, nodeIds, {
      edgeTypes: ["tests"],
      direction: "in",
      limit: options.limit,
    })
      .filter((edge) => edge.dst != null && nodeSet.has(edge.dst))
      .map((edge) => edge.src);
  } else if (options.snapshotPairs) {
    testIds = options.snapshotPairs
      .filter((edge) => edge.edgeType === "tests" && edge.dst != null && nodeSet.has(edge.dst))
      .map((edge) => edge.src);
  } else {
    const placeholders = nodeIds.map(() => "?").join(",");
    const branchClause = options.branchId ? "AND (e.branch_id=? OR e.branch_id IS NULL)" : "";
    const params = options.branchId
      ? [...nodeIds, options.branchId, options.limit]
      : [...nodeIds, options.limit];
    testIds = (store.db.prepare(
      `SELECT DISTINCT e.src AS id
         FROM edges e JOIN nodes n ON n.id=e.src
        WHERE e.status='active' AND e.edge_type='tests'
          AND e.dst IN (${placeholders}) ${branchClause}
        ORDER BY n.title LIMIT ?`,
    ).all(...params) as Array<{ id: string }>).map((row) => row.id);
  }

  // Markdown knowledge edges are branch-independent and point from a note to
  // the code/entity they mention. Querying them separately also keeps an
  // immutable code snapshot from silently hiding still-relevant runbooks.
  const placeholders = nodeIds.map(() => "?").join(",");
  const knowledgeIds = (store.db.prepare(
    `SELECT DISTINCT e.src AS id
       FROM edges e JOIN nodes n ON n.id=e.src
      WHERE e.status='active' AND n.node_type='note'
        AND e.dst IN (${placeholders})
      ORDER BY n.title LIMIT ?`,
  ).all(...nodeIds, options.limit) as Array<{ id: string }>).map((row) => row.id);

  const uniqueBriefs = (ids: string[]) => briefsFrom(
    store,
    [...new Set(ids)].slice(0, options.limit).map((id) => ({ id })),
  );
  return { relatedTests: uniqueBriefs(testIds), linkedKnowledge: uniqueBriefs(knowledgeIds) };
}

const DOWNSTREAM = ["calls", "renders", "invokes_dynamic", "invokes", "references", "reads", "writes", "throws", "uses", "handles"];
const FLOW_INGRESS = ["handles", "calls", "renders", "invokes_dynamic", "invokes"];

type FlowTraversalEdge = { id: string; via: string };
type FlowDownstreamEdge = FlowTraversalEdge & { src: string };

function flowIngressPath(
  store: KnowledgeStore,
  focus: string,
  incomingEdges: (id: string) => FlowTraversalEdge[],
  depthCap: number,
  limit: number,
): FlowTraversalEdge[] {
  const focusOnly = [{ id: focus, via: "root" }];
  if (store.getNode(focus)?.node_type === "endpoint") return focusOnly;

  type ReverseEdge = { parent: string; child: string; via: string };
  const queue: Array<{ id: string; reverseEdges: ReverseEdge[] }> = [
    { id: focus, reverseEdges: [] },
  ];
  const seen = new Set<string>([focus]);

  while (queue.length > 0 && seen.size <= limit) {
    const current = queue.shift()!;
    if (current.reverseEdges.length >= depthCap) continue;
    const parents = incomingEdges(current.id)
      .filter((edge) => !seen.has(edge.id))
      .sort((a, b) => {
        const aKey = store.getNode(a.id)?.identity_key ?? a.id;
        const bKey = store.getNode(b.id)?.identity_key ?? b.id;
        return a.via.localeCompare(b.via) || aKey.localeCompare(bKey);
      });
    for (const parent of parents) {
      if (seen.size >= limit) break;
      seen.add(parent.id);
      const reverseEdges = [
        ...current.reverseEdges,
        { parent: parent.id, child: current.id, via: parent.via },
      ];
      if (store.getNode(parent.id)?.node_type === "endpoint") {
        return [
          { id: parent.id, via: "root" },
          ...reverseEdges.reverse().map((edge) => ({ id: edge.child, via: edge.via })),
        ];
      }
      queue.push({ id: parent.id, reverseEdges });
    }
  }
  return focusOnly;
}

function appendFlowDownstream(
  store: KnowledgeStore,
  focus: string,
  focusDepth: number,
  steps: FlowStep[],
  seen: Set<string>,
  outEdges: (ids: string[]) => FlowDownstreamEdge[],
  depthCap: number,
  limit: number,
  revisionId: string,
): void {
  // Breadth-first expansion preserves every shallow/direct relationship before
  // spending the response budget on one large descendant subtree. The old DFS
  // could exhaust a 60-step limit inside the first callee and silently omit a
  // sibling call that Context had already confirmed. `seen` is checked before
  // append so converging branches also do not duplicate steps.
  let frontier: Array<{ id: string; depth: number }> = [{ id: focus, depth: focusDepth }];
  while (frontier.length > 0 && steps.length < limit) {
    const expandable = frontier.filter((item) => item.depth < depthCap);
    if (expandable.length === 0) break;
    const grouped = new Map<string, FlowDownstreamEdge[]>();
    for (const edge of outEdges(expandable.map((item) => item.id))) {
      grouped.set(edge.src, [...(grouped.get(edge.src) ?? []), edge]);
    }

    // Round-robin within one depth: a high-fanout node cannot consume the
    // remaining response budget before its same-depth siblings contribute.
    const next: Array<{ id: string; depth: number }> = [];
    const maxEdges = Math.max(0, ...expandable.map((item) => grouped.get(item.id)?.length ?? 0));
    for (let edgeIndex = 0; edgeIndex < maxEdges && steps.length < limit; edgeIndex += 1) {
      for (const current of expandable) {
        if (steps.length >= limit) break;
        const edge = grouped.get(current.id)?.[edgeIndex];
        if (!edge || seen.has(edge.id) || !store.getNode(edge.id)) continue;
        seen.add(edge.id);
        const depth = current.depth + 1;
        steps.push({ depth, ...nodeBriefStep(store, edge.id, revisionId), via: edge.via });
        if (depth < depthCap) next.push({ id: edge.id, depth });
      }
    }
    frontier = next;
  }
}

// gRPC route-string resolution for `flow`/`context` targets. NestJS
// `@GrpcMethod('Service','Method')` handlers are indexed as a single GLOBAL
// endpoint node keyed `grpc::<service>.<method-lowercased>` (see
// grpcEndpointKey in knowledge-indexer); callers refer to that endpoint by any
// of several conventional shapes, so a route string must be normalized to
// that key before a plain node/identity lookup has a chance of finding it.
export type GrpcResolution =
  | { kind: "unique"; nodeId: string }
  | { kind: "ambiguous"; candidates: SymbolCandidate[] }
  | { kind: "not_grpc" } // doesn't look like any gRPC route shape — try plain symbol resolution
  | { kind: "not_found"; attemptedKey: string }; // looked like a route, but no such endpoint is indexed

export function resolveGrpcEndpoint(store: KnowledgeStore, input: string): GrpcResolution {
  const raw = input.trim();
  const lookup = (service: string, method: string): GrpcResolution => {
    if (!service || !method) return { kind: "not_grpc" };
    const key = `grpc::${service}.${method.toLowerCase()}`;
    const id = store.findNodeIdByIdentity(key);
    return id ? { kind: "unique", nodeId: id } : { kind: "not_found", attemptedKey: key };
  };

  // 1. literal identity key: grpc::Service.method
  if (raw.startsWith("grpc::")) {
    const id = store.findNodeIdByIdentity(raw);
    return id ? { kind: "unique", nodeId: id } : { kind: "not_found", attemptedKey: raw };
  }

  // 2. slash-form route strings: /pkg.Service/Method or /pkg/pkg.Service/Method.
  // The service segment is always the second-to-last path component (whatever
  // package-path prefix precedes it), and the service name itself is the
  // substring after the LAST '.' in that segment (proto package qualifiers
  // are dot-separated, e.g. "pkg.sub.Service").
  if (raw.includes("/")) {
    const parts = raw.split("/").filter(Boolean);
    if (parts.length < 2) return { kind: "not_grpc" };
    const method = parts[parts.length - 1];
    const serviceSeg = parts[parts.length - 2];
    const service = serviceSeg.includes(".") ? serviceSeg.slice(serviceSeg.lastIndexOf(".") + 1) : serviceSeg;
    return lookup(service, method);
  }

  // 3. dot-form: Service.Method (also matches a qualified symbol name like
  // "Ctrl.create" — if no gRPC endpoint exists for it, the caller falls
  // through to plain symbol resolution, where the exact-title fallback tier
  // still finds it).
  if (raw.includes(".")) {
    const idx = raw.lastIndexOf(".");
    return lookup(raw.slice(0, idx), raw.slice(idx + 1));
  }

  // 4. bare method name — ambiguous whenever 2+ distinct services expose a
  // method with this (lowercased) name; this is the exact shape of the
  // originally reported bug (FrontendPlayerService vs PlayerService both
  // expose getPlayerProfileByJwt).
  const services = store.findEndpointServicesByMethod(raw.toLowerCase());
  if (services.length === 0) return { kind: "not_grpc" };
  if (services.length === 1) return lookup(services[0], raw);
  const candidates = services
    .map((svc) => store.findNodeIdByIdentity(`grpc::${svc}.${raw.toLowerCase()}`))
    .filter((id): id is string => id != null)
    .map((id) => symbolCandidateOf(store, id));
  return { kind: "ambiguous", candidates };
}

export function buildFlow(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; revision?: RevisionContext; depth?: number; limit?: number },
): FlowResult {
  const grpc = resolveGrpcEndpoint(store, target);
  let focus: string | null = null;
  let attemptedKey: string | null = null;
  if (grpc.kind === "unique") {
    focus = grpc.nodeId;
  } else if (grpc.kind === "ambiguous") {
    return {
      target, trust: null, root: null, steps: [], ...emptyFlowEnrichment(), ambiguous: grpc.candidates,
      diagnostic: {
        reason: "ambiguous",
        message: `"${target}" matches ${grpc.candidates.length} gRPC endpoints across different services — specify one.`,
        suggestions: grpc.candidates.map((c) => `penguin flow symbol:${c.nodeId}`),
      },
    };
  } else {
    if (grpc.kind === "not_found") attemptedKey = grpc.attemptedKey;
    const sym = resolveSymbolMatches(store, target, options);
    if (sym.kind === "unique") {
      focus = sym.nodeId;
    } else if (sym.kind === "ambiguous") {
      return {
        target, trust: null, root: null, steps: [], ...emptyFlowEnrichment(), ambiguous: sym.candidates,
        diagnostic: {
          reason: "ambiguous",
          message: `"${target}" matches ${sym.candidates.length} symbols — specify one.`,
          suggestions: sym.candidates.map((c) => `penguin flow symbol:${c.nodeId}`),
        },
      };
    }
  }
  if (!focus) {
    return {
      target, trust: null, root: null, steps: [], ...emptyFlowEnrichment(),
      diagnostic: {
        reason: "not_indexed",
        message: attemptedKey
          ? `No symbol found for "${target}", and no gRPC endpoint "${attemptedKey}" is indexed. Check the service/method spelling, or that the provider repo has been indexed.`
          : `"${target}" is not indexed — no symbol, note, or gRPC endpoint matches this name.`,
      },
    };
  }
  const depthCap = options?.depth ?? 5;
  const limit = options?.limit ?? 60;
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const outEdges = (ids: string[]) => snapshotEdgePairsForNodes(store, options.revision!, ids, {
      edgeTypes: DOWNSTREAM,
      direction: "out",
      limit: Math.max(limit, Math.min(5_000, limit * ids.length)),
    }).filter((edge) => edge.dst).map((edge) => ({ src: edge.src, id: edge.dst!, via: edge.edgeType }));
    const inEdges = (id: string) => snapshotEdgePairsForNodes(store, options.revision!, [id], {
      edgeTypes: FLOW_INGRESS,
      direction: "in",
      limit,
    }).filter((edge) => edge.dst === id).map((edge) => ({ id: edge.src, via: edge.edgeType }));
    const flowRevisionId = options.revision.snapshotId ?? options.revision.branchId ?? "live";
    const ingress = flowIngressPath(store, focus, inEdges, depthCap, limit);
    const steps: FlowStep[] = ingress.map((edge, depth) => ({ depth, ...nodeBriefStep(store, edge.id, flowRevisionId), via: edge.via }));
    const root = steps[0];
    const seen = new Set<string>(ingress.map((edge) => edge.id));
    appendFlowDownstream(store, focus, ingress.length - 1, steps, seen, outEdges, depthCap, limit, flowRevisionId);
    const enrichment = flowEnrichment(store, steps.map((step) => step.nodeId), {
      branchId: options.revision.branchId,
      limit,
      snapshotRevision: options.revision,
    });
    return { target, trust: options.revision.branchId ? trustEnvelopeForBranch(store, options.revision.branchId) : null, root, steps, ...enrichment, ...(steps.length === 1 ? { diagnostic: { reason: "no_outgoing_edges" as const, message: `"${root.title}" is indexed but has no outgoing edges in the selected revision.` } } : {}) };
  }
  const explicitBranchId = revisionBranchId(options);
  const branchId = explicitBranchId ?? liveBranchOf(store, focus);
  const scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const ph = DOWNSTREAM.map(() => "?").join(",");

  const outEdges = (ids: string[]) => {
    const srcPlaceholders = ids.map(() => "?").join(",");
    const params = branchId ? [...ids, ...DOWNSTREAM, branchId] : [...ids, ...DOWNSTREAM];
    return store.db
      .prepare(
        `SELECT DISTINCT src, dst AS id, edge_type AS via FROM edges
         WHERE src IN (${srcPlaceholders}) AND dst IS NOT NULL AND status='active' AND edge_type IN (${ph})${bx}
         ORDER BY src, edge_type, dst`,
      )
      .all(...params) as FlowDownstreamEdge[];
  };

  const inEdges = (id: string) => {
    const ingressPlaceholders = FLOW_INGRESS.map(() => "?").join(",");
    const params = branchId ? [id, ...FLOW_INGRESS, branchId] : [id, ...FLOW_INGRESS];
    return store.db
      .prepare(
        `SELECT DISTINCT src AS id, edge_type AS via FROM edges
         WHERE dst=? AND status='active' AND edge_type IN (${ingressPlaceholders})${bx}
         ORDER BY edge_type, src`,
      )
      .all(...params) as Array<{ id: string; via: string }>;
  };

  const ingress = flowIngressPath(store, focus, inEdges, depthCap, limit);
  const steps: FlowStep[] = ingress.map((edge, depth) => ({ depth, ...nodeBriefStep(store, edge.id, branchId ?? "live"), via: edge.via }));
  const root = steps[0];
  const seen = new Set<string>(ingress.map((edge) => edge.id));
  appendFlowDownstream(store, focus, ingress.length - 1, steps, seen, outEdges, depthCap, limit, branchId ?? "live");
  const enrichment = flowEnrichment(store, steps.map((step) => step.nodeId), { branchId: branchId ?? undefined, limit });
  if (steps.length === 1) {
    const node = store.getNode(focus);
    const isEndpoint = node?.node_type === "endpoint";
    return {
      target, trust: trustEnvelopeForBranch(store, branchId), root, steps, ...enrichment,
      diagnostic: {
        reason: isEndpoint ? "endpoint_no_handler" : "no_outgoing_edges",
        message: isEndpoint
          ? `Endpoint "${root.title}" is indexed but has no \`handles\` edge to a handler yet — the provider service may not be indexed, or its @GrpcMethod handler wasn't recognized.`
          : `"${root.title}" is indexed but has no outgoing calls/references — it may be a terminal/leaf symbol, or its callees aren't indexed.`,
      },
      ...(scopeFallback ? { scopeFallback } : {}),
    };
  }
  return { target, trust: trustEnvelopeForBranch(store, branchId), root, steps, ...enrichment, ...(scopeFallback ? { scopeFallback } : {}) };
}

function nodeBriefStep(store: KnowledgeStore, id: string, revisionId = "live") {
  const b = nodeBrief(store, id);
  const source = store.db.prepare("SELECT b.repo_id AS repoId,sv.file_path AS filePath,sv.start_line AS startLine,sv.end_line AS endLine FROM symbol_versions sv JOIN branches b ON b.id=sv.branch_id WHERE sv.node_id=? AND sv.status='fresh' ORDER BY sv.start_line LIMIT 1").get(id) as { repoId: string | null; filePath: string | null; startLine: number | null; endLine: number | null } | undefined;
  return {
    nodeId: b.nodeId,
    title: b.title,
    nodeType: b.nodeType,
    ...(source?.repoId && source.filePath && source.startLine != null ? { source: { repoId: source.repoId, filePath: source.filePath, startLine: source.startLine, ...(source.endLine != null ? { endLine: source.endLine } : {}), revisionId } } : {}),
  };
}

// —— Explore v2: verbatim source packs ———————————————————————————————
// The pack carries the actual code, not just briefs/locators, so an AI
// consumer can answer AND edit from ONE call — the two-step
// "explore → Read the file anyway" loop is what pushed agents to other tools.

export interface SourceBlock {
  nodeId: string;
  title: string;
  role: "focus" | "implementation" | "callee" | "caller";
  filePath: string;
  startLine: number;
  endLine: number;
  lang: string | null;
  /** Verbatim file content for [startLine, endLine] — re-read from DISK at
   * query time, byte-for-byte what an editor would see (never a stale index
   * copy). Safe to base edits on when `truncated` is false. */
  code: string;
  /** True when the block was cut to fit the pack's line budget. */
  truncated: boolean;
}

// Read a symbol's current source off disk via its freshest version row.
// Best-effort: moved/unreadable files or notes return null (callers fall back
// to briefs) — same degradation contract as getNodeDetail's source field.
function readSourceBlock(
  store: KnowledgeStore,
  nodeId: string,
  maxLines: number,
): Omit<SourceBlock, "role"> | null {
  const node = store.db
    .prepare("SELECT id, title, repo_id AS repoId FROM nodes WHERE id=?")
    .get(nodeId) as { id: string; title: string; repoId: string | null } | undefined;
  if (!node?.repoId) return null;
  const version = store.db
    .prepare(
      `SELECT file_path AS filePath, start_line AS startLine, end_line AS endLine, lang
         FROM symbol_versions WHERE node_id=?
        ORDER BY (status='fresh') DESC LIMIT 1`,
    )
    .get(nodeId) as
    | { filePath: string; startLine: number | null; endLine: number | null; lang: string | null }
    | undefined;
  if (!version?.filePath || version.startLine == null || version.endLine == null) return null;
  const repo = store.db
    .prepare("SELECT root_path AS rootPath FROM repos WHERE id=?")
    .get(node.repoId) as { rootPath: string } | undefined;
  if (!repo) return null;
  try {
    const abs = isAbsolute(version.filePath)
      ? version.filePath
      : join(repo.rootPath, version.filePath);
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    const fullEnd = Math.min(version.endLine, lines.length);
    const truncated = fullEnd - version.startLine + 1 > maxLines;
    const endLine = truncated ? version.startLine + maxLines - 1 : fullEnd;
    const code = lines.slice(version.startLine - 1, endLine).join("\n");
    if (!code.trim()) return null;
    return {
      nodeId: node.id,
      title: node.title,
      filePath: version.filePath,
      startLine: version.startLine,
      endLine,
      lang: version.lang,
      code,
      truncated,
    };
  } catch {
    return null;
  }
}

export interface ExplorePack {
  target: string;
  focus: ContextPack["focus"];
  implementation: ContextPack["focus"];
  trust: TrustEnvelope | null;
  freshness: {
    stale: boolean;
    reason: string | null;
    indexedAt: string | null;
    coverageGaps: string[];
  };
  callers: ContextBrief[];
  calls: ContextBrief[];
  renderedBy: ContextBrief[];
  renders: ContextBrief[];
  invokedDynamicallyBy: ContextBrief[];
  invokesDynamic: ContextBrief[];
  callPath: FlowStep[];
  blastRadius: ContextBrief[];
  tests: ContextBrief[];
  routes: ContextPack["routes"];
  provenance: Array<{
    edgeType: string;
    origin: string;
    method: string;
    confidence: number;
    count: number;
  }>;
  confidence: {
    level: "high" | "mixed" | "low";
    minimum: number;
    inferredEdges: number;
    totalEdges: number;
  };
  diagnostics: string[];
  /** Verbatim disk source for the focus/implementation and the nearest
   * callers/callees, within a line budget. Never silently capped — anything
   * dropped for budget is named in `sourcesOmitted`. */
  sources: SourceBlock[];
  sourcesOmitted: string[];
  // Structured counterpart to the "ambiguous target: N matches" diagnostics
  // string — callers need the actual candidates (nodeId/filePath/branch) to
  // disambiguate and retry directly, not just a count to guess against.
  ambiguousCandidates?: SymbolCandidate[];
  queryDiagnostics: QueryDiagnostics;
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // underlying context/flow queries silently answered against the repo's live
  // branch instead (see FlowResult.scopeFallback). Sourced from whichever of
  // context/flow actually hit the fallback (buildQueryDiagnostics deliberately
  // does NOT carry its own copy of this — see its call site for why).
  scopeFallback?: { branchId: string };
}

// One editing-oriented result shared by CLI and MCP. It composes the existing
// deterministic context, flow, and impact queries and adds edge trust metadata.
export function buildExplorePack(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; revision?: RevisionContext; depth?: number; limit?: number },
): ExplorePack {
  let context = buildContextPack(store, target, options);
  let flow = buildFlow(store, target, options);
  let searchFallback: string | null = null;
  let searchCandidates: SymbolCandidate[] | null = null;
  // Fuzzy resolution: an exact miss (no focus, no flow root, not ambiguous)
  // falls back to full-text search. A SINGLE hit resolves automatically; more
  // than one becomes ambiguousCandidates — never a guess (index answers are
  // judged 对/错, and a wrong auto-pick is 错).
  if (!context.focus && !flow.root && !context.ambiguous) {
    const hits = store
      .searchText(target, { limit: 5 })
      .filter((hit) => hit.nodeType === "symbol" || hit.nodeType === "endpoint");
    if (hits.length === 1) {
      context = buildContextPack(store, hits[0].nodeId, options);
      flow = buildFlow(store, hits[0].nodeId, options);
      searchFallback = `resolved "${target}" via search fallback → ${hits[0].title}`;
    } else if (hits.length > 1) {
      searchCandidates = hits.map((hit) => ({
        nodeId: hit.nodeId,
        nodeType: hit.nodeType,
        identityKey: hit.identityKey,
        title: hit.title,
        filePath: hit.filePath ?? null,
        branch: hit.branch ?? null,
        startLine: null,
      }));
    }
  }
  const focusId = context.focus?.nodeId ?? flow.root?.nodeId ?? null;
  const handler = context.focus?.nodeType === "endpoint"
    ? flow.steps.find((step) => step.via === "handles" && step.nodeType === "symbol")
    : undefined;
  const implementationContext = handler ? buildContextPack(store, handler.nodeId, options) : null;
  const effectiveContext = implementationContext ?? context;
  const trust = context.trust ?? implementationContext?.trust ?? flow.trust;
  // Whichever underlying query actually hit the live-branch fallback (context
  // wins over flow since effectiveContext is what the rest of the pack is
  // built from) — see ExplorePack.scopeFallback.
  const scopeFallback = effectiveContext.scopeFallback ?? flow.scopeFallback;
  const blastRadius = focusId
    ? exploreGraph(store, "impact", focusId, { depth: options?.depth, limit: options?.limit, revision: options?.revision, branchId: options?.branchId }).nodes
    : [];
  const rows = focusId
    ? store.db.prepare(
        `SELECT edge_type AS edgeType, origin, method,
                COALESCE(confidence, CASE WHEN method='INFERRED' THEN 0.5 ELSE 1.0 END) AS confidence,
                COUNT(*) AS count
           FROM edges
          WHERE (src=? OR dst=?) AND status='active'
            ${revisionBranchId(options) ? "AND (branch_id=? OR branch_id IS NULL)" : ""}
          GROUP BY edge_type, origin, method, confidence
          ORDER BY edge_type, method`,
      ).all(...(revisionBranchId(options) ? [focusId, focusId, revisionBranchId(options)] : [focusId, focusId])) as Array<{
        edgeType: string; origin: string; method: string; confidence: number; count: number;
      }>
    : [];
  const totalEdges = rows.reduce((sum, row) => sum + row.count, 0);
  const inferredEdges = rows
    .filter((row) => row.method === "INFERRED")
    .reduce((sum, row) => sum + row.count, 0);
  const minimum = rows.length > 0 ? Math.min(...rows.map((row) => row.confidence)) : 0;
  const level = inferredEdges === 0 ? "high" : minimum >= 0.5 ? "mixed" : "low";
  const diagnostics = [
    ...context.signals,
    ...(implementationContext?.signals ?? []),
    ...(context.ambiguous ? [`ambiguous target: ${context.ambiguous.length} matches`] : []),
    ...(searchCandidates ? [`ambiguous target: ${searchCandidates.length} search matches`] : []),
    ...(searchFallback ? [searchFallback] : []),
    ...(context.assemblyError ? [`context assembly failed: ${context.assemblyError}`] : []),
    ...(flow.diagnostic ? [flow.diagnostic.message] : []),
  ];

  // —— verbatim sources, within an explicit budget ——————————————————————
  // focus/implementation first (the thing being asked about), then nearest
  // callees and callers. Budget keeps one pack safely inside a tool-result;
  // every drop is NAMED in sourcesOmitted — silent truncation reads as
  // "covered everything" when it didn't.
  const SOURCE_BUDGET_LINES = 800;
  const FOCUS_MAX_LINES = 400;
  const NEIGHBOR_MAX_LINES = 120;
  const NEIGHBOR_COUNT = 3;
  const sources: SourceBlock[] = [];
  const sourcesOmitted: string[] = [];
  const seenSourceIds = new Set<string>();
  let budgetLeft = SOURCE_BUDGET_LINES;
  const pushSource = (
    nodeId: string | null | undefined,
    role: SourceBlock["role"],
    title: string,
    maxLines: number,
  ): void => {
    if (!nodeId || seenSourceIds.has(nodeId)) return;
    if (budgetLeft <= 0) {
      sourcesOmitted.push(`${role} ${title} (line budget exhausted)`);
      return;
    }
    const block = readSourceBlock(store, nodeId, Math.min(maxLines, budgetLeft));
    if (!block) return; // note/moved-file/no-range — briefs still cover it
    seenSourceIds.add(nodeId);
    const lineCount = block.endLine - block.startLine + 1;
    budgetLeft -= lineCount;
    sources.push({ ...block, role });
  };
  pushSource(context.focus?.nodeId, "focus", context.focus?.title ?? target, FOCUS_MAX_LINES);
  if (implementationContext?.focus && implementationContext.focus.nodeId !== context.focus?.nodeId) {
    pushSource(implementationContext.focus.nodeId, "implementation", implementationContext.focus.title, FOCUS_MAX_LINES);
  }
  for (const callee of effectiveContext.calls.slice(0, NEIGHBOR_COUNT)) {
    pushSource(callee.nodeId, "callee", callee.title, NEIGHBOR_MAX_LINES);
  }
  for (const caller of effectiveContext.callers.slice(0, NEIGHBOR_COUNT)) {
    pushSource(caller.nodeId, "caller", caller.title, NEIGHBOR_MAX_LINES);
  }
  for (const extra of effectiveContext.calls.slice(NEIGHBOR_COUNT)) {
    sourcesOmitted.push(`callee ${extra.title} (beyond top ${NEIGHBOR_COUNT})`);
  }
  for (const extra of effectiveContext.callers.slice(NEIGHBOR_COUNT)) {
    sourcesOmitted.push(`caller ${extra.title} (beyond top ${NEIGHBOR_COUNT})`);
  }
  const routes = context.focus?.nodeType === "endpoint"
    ? [{ route: context.focus.title, via: "direct" as const }, ...effectiveContext.routes]
    : context.routes;
  const uniqueRoutes = routes.filter((route, index) =>
    routes.findIndex((candidate) => candidate.route === route.route && candidate.via === route.via) === index);
  const resultCount =
    effectiveContext.callers.length
    + effectiveContext.calls.length
    + flow.steps.filter((step) => step.depth > 0).length
    + blastRadius.length
    + effectiveContext.tests.length
    + uniqueRoutes.length;
  return {
    target,
    focus: context.focus,
    implementation: effectiveContext.focus,
    trust,
    freshness: {
      stale: trust?.stale ?? true,
      reason: trust?.staleReason ?? (trust ? null : "trust_unavailable"),
      indexedAt: trust?.indexedAt ?? null,
      coverageGaps: trust?.coverageGaps ?? ["trust_unavailable"],
    },
    callers: effectiveContext.callers,
    calls: effectiveContext.calls,
    renderedBy: effectiveContext.renderedBy,
    renders: effectiveContext.renders,
    invokedDynamicallyBy: effectiveContext.invokedDynamicallyBy,
    invokesDynamic: effectiveContext.invokesDynamic,
    callPath: flow.steps,
    blastRadius,
    tests: effectiveContext.tests,
    routes: uniqueRoutes,
    provenance: rows,
    confidence: { level, minimum, inferredEdges, totalEdges },
    diagnostics: [...new Set(diagnostics)],
    sources,
    sourcesOmitted,
    ...(context.ambiguous ? { ambiguousCandidates: context.ambiguous } : {}),
    ...(!context.ambiguous && searchCandidates ? { ambiguousCandidates: searchCandidates } : {}),
    ...(scopeFallback ? { scopeFallback } : {}),
    queryDiagnostics: buildQueryDiagnostics(
      store,
      target,
      focusId,
      resultCount,
      {
        branchId: trust?.branchId ?? options?.branchId,
        assemblyError: context.assemblyError,
      },
    ),
  };
}

export function renderFlowMarkdown(flow: FlowResult): string {
  if (!flow.root) {
    const L = [`# Flow: ${flow.target}`, ""];
    if (flow.ambiguous) L.push(renderAmbiguousSymbols(flow.target, flow.ambiguous, "flow"));
    else L.push(flow.diagnostic?.message ?? "_No matching entry point/symbol._");
    return L.join("\n") + "\n";
  }
  const L: string[] = [`# Flow: ${flow.root.title}`, ""];
  for (const s of flow.steps) {
    const indent = "  ".repeat(s.depth);
    const arrow = s.via === "root" ? "" : `${s.via} → `;
    const tag = s.nodeType !== "symbol" ? ` _(${s.nodeType})_` : "";
    L.push(`${indent}${s.depth === 0 ? "" : "↳ "}${arrow}\`${s.title}\`${tag}`);
  }
  if (flow.relatedTests.length > 0) {
    L.push("", "## Related tests", "", ...flow.relatedTests.map((item) => `- \`${item.title}\``));
  }
  if (flow.linkedKnowledge.length > 0) {
    L.push("", "## Linked knowledge", "", ...flow.linkedKnowledge.map((item) => `- ${item.title}`));
  }
  if (flow.diagnostic) L.push("", `⚠ ${flow.diagnostic.message}`);
  return L.join("\n");
}

// —— affected: git-diff blast radius (§ codebase-memory-mcp parity) ——
// Given changed files, return the symbols they define, the transitive callers
// (blast radius), the tests that cover any of them, and the routes that reach
// them — so a PR review / AI edit knows "what could this break".
export interface AffectedResult {
  files: string[];
  changed: ContextBrief[];
  impacted: ContextBrief[];
  tests: ContextBrief[];
  routes: string[];
}
export function affectedByFiles(
  store: KnowledgeStore,
  files: string[],
  options?: { depth?: number; limit?: number; revision?: RevisionContext; branchId?: string },
): AffectedResult {
  const depth = options?.depth ?? 3;
  const limit = options?.limit ?? 200;
  if (files.length === 0) return { files, changed: [], impacted: [], tests: [], routes: [] };
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const view = openRevisionView(store, options.revision);
    const changedIds = view.symbolVersions().filter((row) => files.includes(row.filePath)).map((row) => row.nodeId);
    const pairs = snapshotEdgePairs(store, options.revision);
    const seen = new Set(changedIds); let frontier = [...changedIds];
    for (let d = 0; d < (options.depth ?? 3) && frontier.length && seen.size < (options.limit ?? 200); d++) {
      const next: string[] = [];
      for (const id of frontier) for (const edge of pairs) if (edge.dst === id && ["calls", "references"].includes(edge.edgeType) && !seen.has(edge.src)) { seen.add(edge.src); next.push(edge.src); }
      frontier = next;
    }
    const brief = (ids: string[]) => ids.map((id) => { const b = nodeBrief(store, id); return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType }; });
    return { files, changed: brief(changedIds), impacted: brief([...seen].filter((id) => !changedIds.includes(id))), tests: [], routes: [] };
  }
  const ph = files.map(() => "?").join(",");
  const branchId = revisionBranchId(options);
  const changedIds = (store.db
    .prepare(`SELECT DISTINCT node_id AS id FROM symbol_versions WHERE file_path IN (${ph})${branchId ? " AND branch_id=?" : ""}`)
    .all(...(branchId ? [...files, branchId] : files)) as { id: string }[]).map((r) => r.id);

  // transitive who_calls from the changed set = blast radius.
  const seen = new Set(changedIds);
  let frontier = [...changedIds];
  for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.size >= limit) break;
      // both "calls" and "references" mean "depends on this" — a DTO/type change
      // ripples through its type-users just as a fn change ripples through callers.
      const callers = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type IN ('calls','references') AND status='active'${branchId ? " AND (branch_id=? OR branch_id IS NULL)" : ""}`).all(...(branchId ? [id, branchId] : [id])) as { src: string }[];
      for (const c of callers) if (!seen.has(c.src)) { seen.add(c.src); next.push(c.src); }
    }
    frontier = next;
  }
  const impactedIds = [...seen].filter((id) => !changedIds.includes(id));

  const allIds = [...seen];
  const p2 = allIds.map(() => "?").join(",");
  const tests = allIds.length
    ? (store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='tests' AND status='active' AND dst IN (${p2})${branchId ? " AND (branch_id=? OR branch_id IS NULL)" : ""} LIMIT ?`).all(...(branchId ? [...allIds, branchId, limit] : [...allIds, limit])) as { id: string }[])
    : [];
  const routes = allIds.length
    ? (store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='handles' AND status='active' AND dst IN (${p2})${branchId ? " AND (branch_id=? OR branch_id IS NULL)" : ""} LIMIT ?`).all(...(branchId ? [...allIds, branchId, limit] : [...allIds, limit])) as { id: string }[])
    : [];

  const brief = (ids: string[]): ContextBrief[] => ids.map((id) => { const b = nodeBrief(store, id); return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType }; });
  return {
    files,
    changed: brief(changedIds),
    impacted: brief(impactedIds),
    tests: brief(tests.map((t) => t.id)),
    routes: routes.map((r) => nodeBrief(store, r.id).title),
  };
}

// —— architecture: one-call project overview (AI onboarding, § parity) ——
export interface ArchitectureOverview {
  repos: Array<{ name: string; branches: number }>;
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  languages: Array<{ lang: string; symbols: number }>;
  hubs: Array<{ title: string; nodeType: string; degree: number }>;
  entryPoints: string[];
}
const GENERIC_UTILITY_HUB_NAMES = new Set([
  "get", "set", "find", "findone", "map", "filter", "reduce", "resolve",
  "log", "error", "warn", "info", "debug", "trace", "handle", "call",
  "apply", "create", "update", "delete", "read", "write", "parse", "format",
  "t", "$translate", "translate", "logerror", "emitter", "size", "populate",
]);

export function architecture(store: KnowledgeStore): ArchitectureOverview {
  const rows = <T,>(sql: string, ...p: unknown[]) => store.db.prepare(sql).all(...p) as T[];
  const repos = rows<{ name: string; n: number }>(
    "SELECT r.name AS name, (SELECT COUNT(*) FROM branches b WHERE b.repo_id=r.id) AS n FROM repos r ORDER BY r.name",
  ).map((r) => ({ name: r.name, branches: r.n }));
  const countMap = (sql: string) => Object.fromEntries(rows<{ k: string; n: number }>(sql).map((r) => [r.k, r.n]));
  const nodeCounts = countMap("SELECT node_type AS k, COUNT(*) AS n FROM nodes GROUP BY node_type ORDER BY n DESC");
  const edgeCounts = countMap("SELECT edge_type AS k, COUNT(*) AS n FROM edges WHERE status='active' GROUP BY edge_type ORDER BY n DESC");
  const languages = rows<{ lang: string; symbols: number }>(
    "SELECT lang, COUNT(*) AS symbols FROM symbol_versions WHERE status='fresh' GROUP BY lang ORDER BY symbols DESC LIMIT 12",
  );
  const hubs = rows<{ id: string; degree: number }>(
    `SELECT node AS id, COUNT(*) AS degree FROM (
        SELECT src AS node FROM edges WHERE status='active' AND edge_type IN ('calls','references')
        UNION ALL SELECT dst AS node FROM edges WHERE status='active' AND edge_type IN ('calls','references') AND dst IS NOT NULL
     ) GROUP BY node ORDER BY degree DESC LIMIT 40`,
  ).map((h) => { const b = nodeBrief(store, h.id); return { title: b.title, nodeType: b.nodeType, degree: h.degree }; })
   .filter((h) => h.nodeType === "symbol" && !GENERIC_UTILITY_HUB_NAMES.has(h.title.toLowerCase())).slice(0, 12);
  const entryPoints = rows<{ title: string }>("SELECT title FROM nodes WHERE node_type='endpoint' ORDER BY title LIMIT 30").map((r) => r.title);
  return { repos, nodeCounts, edgeCounts, languages, hubs, entryPoints };
}

export interface Community {
  id: number;
  size: number;
  repos: string[]; // repo names the community spans, most-represented first
  topMembers: Array<{ title: string; nodeType: string; degree: number }>; // god node first
}
export interface CommunityResult {
  communities: Community[];
  totalNodes: number;
  totalCommunities: number;
  suppressedHubs: Array<{ nodeId: string; title: string; degree: number; reason: "generic_utility_name" }>;
}

// Module/community detection over the active structural graph via label
// propagation (§P3): each node adopts the majority label among its neighbours,
// iterated to convergence. Deterministic (smallest-label tie-break) so repeated
// runs agree. Returns the largest communities, each with its highest-degree
// "god node" first and the repos it spans.
export function communities(store: KnowledgeStore, opts: { limit?: number; minSize?: number } = {}): CommunityResult {
  const limit = opts.limit ?? 20;
  const minSize = opts.minSize ?? 3;
  const rawEdges = store.db
    .prepare(
      "SELECT src, dst FROM edges WHERE status='active' AND dst IS NOT NULL AND edge_type IN ('calls','references','imports','defines')",
    )
    .all() as { src: string; dst: string }[];
  const rawDegree = new Map<string, number>();
  for (const edge of rawEdges) {
    rawDegree.set(edge.src, (rawDegree.get(edge.src) ?? 0) + 1);
    rawDegree.set(edge.dst, (rawDegree.get(edge.dst) ?? 0) + 1);
  }
  const nodeRows = store.db
    .prepare("SELECT id, title, repo_id AS repoId FROM nodes")
    .all() as Array<{ id: string; title: string; repoId: string | null }>;
  const suppressedIds = new Set(
    nodeRows
      .filter((node) => GENERIC_UTILITY_HUB_NAMES.has(node.title.toLowerCase()))
      .map((node) => node.id),
  );
  const suppressedHubs = nodeRows
    .filter((node) => suppressedIds.has(node.id) && (rawDegree.get(node.id) ?? 0) >= Math.max(minSize, 3))
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      degree: rawDegree.get(node.id) ?? 0,
      reason: "generic_utility_name" as const,
    }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 50);
  const edges = rawEdges.filter((edge) => !suppressedIds.has(edge.src) && !suppressedIds.has(edge.dst));

  const adj = new Map<string, string[]>();
  const degree = new Map<string, number>();
  const link = (a: string, b: string) => {
    let n = adj.get(a);
    if (!n) adj.set(a, (n = []));
    n.push(b);
    degree.set(a, (degree.get(a) ?? 0) + 1);
  };
  for (const e of edges) {
    link(e.src, e.dst);
    link(e.dst, e.src);
  }
  const nodes = [...adj.keys()];

  const label = new Map<string, string>();
  for (const n of nodes) label.set(n, n);
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map<string, number>();
      for (const m of adj.get(n)!) {
        const l = label.get(m)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(n)!;
      let bestC = -1;
      for (const [l, c] of counts) {
        if (c > bestC || (c === bestC && l < best)) {
          best = l;
          bestC = c;
        }
      }
      if (best !== label.get(n)) {
        label.set(n, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const l = label.get(n)!;
    let g = groups.get(l);
    if (!g) groups.set(l, (g = []));
    g.push(n);
  }

  // node → repo name (one pass, avoids a huge IN clause per community).
  const repoName = new Map<string, string>(
    (store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
  );
  const nodeRepo = new Map<string, string | null>(nodeRows.map((row) => [row.id, row.repoId]));

  const chosen = [...groups.values()].filter((g) => g.length >= minSize).sort((a, b) => b.length - a.length).slice(0, limit);
  const communitiesOut: Community[] = chosen.map((members, i) => {
    const topMembers = members
      .map((id) => ({ id, deg: degree.get(id) ?? 0 }))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 6)
      .map((x) => {
        const b = nodeBrief(store, x.id);
        return { title: b.title, nodeType: b.nodeType, degree: x.deg };
      });
    const repoCount = new Map<string, number>();
    for (const id of members) {
      const rid = nodeRepo.get(id);
      const name = rid ? repoName.get(rid) : undefined;
      if (name) repoCount.set(name, (repoCount.get(name) ?? 0) + 1);
    }
    const repos = [...repoCount.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return { id: i + 1, size: members.length, repos, topMembers };
  });

  return { communities: communitiesOut, totalNodes: nodes.length, totalCommunities: groups.size, suppressedHubs };
}

export interface TimelineEntry {
  sha: string;
  subject: string;
  author: string | null;
  date: string | null; // ISO
  merge: boolean;
  repo: string | null;
  tags: string[];
}
export interface TimelineResult {
  entries: TimelineEntry[];
  revision?: RevisionContext;
}

// Recent history across the graph (§P3 timeline): commit nodes ordered by their
// authored date, newest first, with author/merge flag/repo and any tags that
// point at them. Optional repo filter.
export function timeline(store: KnowledgeStore, opts: { limit?: number; repoId?: string; revision?: RevisionContext } = {}): TimelineResult {
  const limit = opts.limit ?? 50;
  const rows = store.db
    .prepare(
      `SELECT n.id AS id, n.title AS subject, n.repo_id AS repoId,
              json_extract(n.meta,'$.author') AS author,
              json_extract(n.meta,'$.date')   AS date,
              json_extract(n.meta,'$.merge')  AS merge
         FROM nodes n
        WHERE n.node_type='commit' ${opts.repoId ? "AND n.repo_id = @repoId" : ""}
        ORDER BY date DESC NULLS LAST
        LIMIT @limit`,
    )
    .all({ limit, repoId: opts.repoId }) as Array<{
    id: string; subject: string; repoId: string | null;
    author: string | null; date: string | null; merge: number | null;
  }>;

  const repoName = new Map<string, string>(
    (store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
  );
  const tagRows = store.db
    .prepare(
      "SELECT e.dst AS commitId, t.title AS tag FROM edges e JOIN nodes t ON t.id=e.src WHERE e.edge_type='tagged' AND e.status='active'",
    )
    .all() as { commitId: string; tag: string }[];
  const tagsByCommit = new Map<string, string[]>();
  for (const t of tagRows) {
    const arr = tagsByCommit.get(t.commitId) ?? [];
    arr.push(t.tag);
    tagsByCommit.set(t.commitId, arr);
  }

  return {
    entries: rows.map((r) => ({
      sha: r.subject.length > 12 && /^[0-9a-f]{7,}$/i.test(r.subject) ? r.subject.slice(0, 10) : r.id.slice(0, 10),
      subject: r.subject,
      author: r.author,
      date: r.date,
      merge: r.merge === 1,
      repo: r.repoId ? repoName.get(r.repoId) ?? null : null,
      tags: tagsByCommit.get(r.id) ?? [],
    })),
    revision: opts.revision,
  };
}

export interface ResponseSample {
  id: string;
  endpointKey: string;
  status: string | null;
  contentType: string | null;
  sample: string;
  capturedAt: string;
}

// Resolve an endpoint node id from an id or its title (e.g. "gRPC Svc.method",
// "GET /users"). Returns the raw string if no node matches (samples may be
// keyed by a global gRPC id).
export function resolveEndpointId(store: KnowledgeStore, endpoint: string): string {
  const row = store.db
    .prepare("SELECT id FROM nodes WHERE node_type='endpoint' AND (id=? OR title=?) LIMIT 1")
    .get(endpoint, endpoint) as { id: string } | undefined;
  return row?.id ?? endpoint;
}

// Captured runtime responses for an endpoint, newest first (§P2 runtime channel).
export function endpointSamples(store: KnowledgeStore, endpoint: string): ResponseSample[] {
  const endpointId = resolveEndpointId(store, endpoint);
  const rows = store.db
    .prepare(
      "SELECT id, endpoint_key AS endpointKey, status, content_type AS contentType, sample, captured_at AS capturedAt FROM response_samples WHERE endpoint_id=? ORDER BY captured_at DESC",
    )
    .all(endpointId) as ResponseSample[];
  return rows;
}

// —— dead code: symbols nothing references (best-effort; DI/reflection/entry
// points inflate false positives → callers must treat as candidates) ——
export interface DeadCodeResult { candidates: ContextBrief[]; note: string }
export function deadCode(store: KnowledgeStore, options?: { limit?: number }): DeadCodeResult {
  const limit = options?.limit ?? 100;
  const rows = store.db.prepare(
    `SELECT n.id AS id FROM nodes n
      WHERE n.node_type='symbol'
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst=n.id AND e.status='active'
                          AND e.edge_type IN ('calls','references','handles','tests'))
      LIMIT ?`,
  ).all(limit) as { id: string }[];
  return {
    candidates: rows.map((r) => { const b = nodeBrief(store, r.id); return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType }; }),
    note: "no inbound calls/references/handles/tests — verify: DI, reflection, framework magic, dynamic import, and public entry points are false positives.",
  };
}

// —— serviceGraph: the system-level microservice map ("main graph") ——
// Nodes = repos (services). Edges = consumer→provider (a real cross-service call
// via a shared global endpoint, where BOTH ends are indexed). Endpoints that are
// invoked but whose provider/handler isn't indexed (no source) are NOT shown —
// they were dangling noise. This answers "how do the services relate" without a
// symbol focus.
export function serviceGraph(store: KnowledgeStore, options?: { revision?: RevisionContext; branchId?: string }): GraphView {
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const repos = store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[];
    const repoName = new Map(repos.map((r) => [r.id, r.name]));
    const pairs = snapshotEdgePairs(store, options.revision);
    const providers = new Map<string, Set<string>>();
    for (const edge of pairs.filter((e) => e.edgeType === "handles" && e.dst)) { const repo = store.getNode(edge.dst!)?.repo_id; if (repo) (providers.get(edge.src) ?? providers.set(edge.src, new Set()).get(edge.src)!).add(repo); }
    const nodes = new Map<string, GraphView["nodes"][number]>(); const edges = new Map<string, GraphView["edges"][number]>();
    const use = (id: string) => { if (!nodes.has(id)) nodes.set(id, { nodeId: id, title: repoName.get(id) ?? id, nodeType: "service" }); };
    for (const edge of pairs.filter((e) => e.edgeType === "invokes" && e.dst)) { const consumer = store.getNode(edge.src)?.repo_id; if (!consumer) continue; for (const provider of providers.get(edge.dst!) ?? []) if (provider !== consumer) { use(consumer); use(provider); edges.set(`${consumer}|${provider}`, { src: consumer, dst: provider, edgeType: "invokes" }); } }
    for (const repo of repos) use(repo.id);
    return { focus: null, nodes: [...nodes.values()], edges: [...edges.values()] };
  }
  const repos = store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[];
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const providers = store.db.prepare(
    "SELECT e.src AS endpoint, n.repo_id AS repo FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.edge_type='handles' AND e.status='active' AND n.repo_id IS NOT NULL",
  ).all() as { endpoint: string; repo: string }[];
  const consumers = store.db.prepare(
    "SELECT e.dst AS endpoint, n.repo_id AS repo FROM edges e JOIN nodes n ON n.id=e.src WHERE e.edge_type='invokes' AND e.status='active' AND n.repo_id IS NOT NULL",
  ).all() as { endpoint: string; repo: string }[];

  const provBy = new Map<string, Set<string>>();
  for (const p of providers) { (provBy.get(p.endpoint) ?? provBy.set(p.endpoint, new Set()).get(p.endpoint)!).add(p.repo); }

  const nodes = new Map<string, GraphView["nodes"][number]>();
  const useRepo = (id: string) => { if (!nodes.has(id)) nodes.set(id, { nodeId: id, title: repoName.get(id) ?? id, nodeType: "service" }); };
  const edgeSet = new Map<string, GraphView["edges"][number]>();
  const addEdge = (src: string, dst: string, t: string) => { const k = `${src}|${dst}|${t}`; if (!edgeSet.has(k)) edgeSet.set(k, { src, dst, edgeType: t }); };

  for (const c of consumers) {
    useRepo(c.repo);
    const provs = provBy.get(c.endpoint);
    if (provs && provs.size) {
      for (const p of provs) if (p !== c.repo) { useRepo(p); addEdge(c.repo, p, "invokes"); }
    }
    // else: the endpoint has no indexed handler (no source) → skip it. We don't
    // surface "invoked but unimplemented-in-index" endpoints as standalone nodes;
    // they were graph noise (dangling red nodes with nothing behind them).
  }
  // always include every repo as a node (even isolated ones)
  for (const r of repos) useRepo(r.id);

  // ── Package dependency edges: npm-package → npm-package (depends_on) ──
  // Resolves each @snsoft/* dependency to a provider repo, creating cross-repo
  // links for the service graph (e.g. auth depends_on @snsoft/player-grpc →
  // link auth repo → flyover repo).
  const pkgDeps = store.db.prepare(
    `SELECT sn.repo_id AS consumerRepo, dn.repo_id AS providerRepo
     FROM edges e
     JOIN nodes sn ON sn.id = e.src
     JOIN nodes dn ON dn.id = e.dst
     WHERE e.edge_type='depends_on' AND e.status='active'
       AND sn.repo_id IS NOT NULL AND dn.repo_id IS NOT NULL`,
  ).all() as { consumerRepo: string; providerRepo: string }[];
  for (const d of pkgDeps) {
    if (d.consumerRepo !== d.providerRepo) {
      useRepo(d.consumerRepo);
      useRepo(d.providerRepo);
      addEdge(d.consumerRepo, d.providerRepo, "depends_on");
    }
  }

  return { focus: null, nodes: [...nodes.values()], edges: [...edgeSet.values()] };
}
