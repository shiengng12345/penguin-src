import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { KnowledgeStore } from "./store.js";

// The single query implementation shared by MCP tools, the CLI, and the UI
// (§8). Results carry provenance/staleness where applicable (§3.3/§4.4).

export interface SearchResultRow {
  nodeId: string;
  nodeType: string;
  title: string;
  snippet: string | null;
}

function resolveNodeId(store: KnowledgeStore, idOrKey: string): string | null {
  if (store.getNode(idOrKey)) return idOrKey;
  const r = store.resolveIdentity(idOrKey);
  if (r) return r.nodeId;
  // friendly-name fallback: a unique node by title or qualified-name suffix
  // (so CLI/MCP callers can pass "login" or "Svc.login", not just full keys).
  const rows = store.db
    .prepare(
      "SELECT id FROM nodes WHERE title = ? OR identity_key LIKE ? OR identity_key LIKE ? LIMIT 2",
    )
    .all(idOrKey, `%::${idOrKey}`, `%.${idOrKey}`) as { id: string }[];
  return rows.length === 1 ? rows[0].id : null;
}

// knowledge_search: title→FTS unified retrieval with scope filters (§8.1).
export function search(
  store: KnowledgeStore,
  query: string,
  filters?: { type?: string[]; repo?: string; workspace?: string; includeSensitive?: boolean; limit?: number },
): SearchResultRow[] {
  const hits = store.searchText(query, {
    types: filters?.type,
    includeSensitive: filters?.includeSensitive,
    limit: filters?.limit,
  });
  // Scope by repo, or by all repos in a workspace (§8.1 workspace filter).
  const repoScope: Set<string> | null = filters?.workspace
    ? new Set(store.workspaceRepoIds(filters.workspace))
    : filters?.repo
      ? new Set([filters.repo])
      : null;
  if (!repoScope) return hits;
  return hits.filter((h) => {
    const n = store.getNode(h.nodeId);
    return n?.repo_id != null && repoScope.has(n.repo_id);
  });
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
export function getNodeDetail(store: KnowledgeStore, idOrKey: string): NodeDetail | null {
  const nodeId = resolveNodeId(store, idOrKey);
  if (!nodeId) return null;
  const node = store.getNode(nodeId)!;
  const versions = store.db
    .prepare(
      `SELECT branch_id AS branchId, file_path AS filePath, lang, kind, status,
              content_hash AS contentHash, signature, start_line AS startLine, end_line AS endLine
       FROM symbol_versions WHERE node_id=? ORDER BY branch_id`,
    )
    .all(nodeId) as NodeDetail["versions"];
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
  | "who_calls" | "calls_of" | "impact" | "backlinks" | "path" | "timeline" | "recent_changes";

export interface GraphResult {
  mode: GraphMode;
  nodes: Array<{ nodeId: string; title: string; nodeType: string }>;
  events?: Array<{ eventType: string; ts: string; origin: string; method: string; nodeId: string | null }>;
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

// explore_graph: one traversal entry point across modes (§8.1).
export function exploreGraph(
  store: KnowledgeStore,
  mode: GraphMode,
  nodeOrKey: string,
  options?: { depth?: number; limit?: number; to?: string; branchId?: string },
): GraphResult {
  const limit = options?.limit ?? 100;

  if (mode === "timeline" || mode === "recent_changes") {
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
    return { mode, nodes: [], events: rows };
  }

  const nodeId = resolveNodeId(store, nodeOrKey);
  if (!nodeId) return { mode, nodes: [] };

  // Trust filter (§3.3/§11): default traversal only follows confirmed edges —
  // unconfirmed AI suggestions (status='suggested') and rejected edges are out.
  const ACTIVE = "status='active'";
  // Branch-scope (correctness): when a branch is given, only follow edges on that
  // branch (plus branch-less edges like git topology / cross-repo endpoints).
  // Without it, a repo indexed on multiple branches would silently mix branches.
  const branchId = options?.branchId ?? null;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const P = (nid: string) => (branchId ? [nid, branchId, limit] : [nid, limit]);
  const Pd = (nid: string) => (branchId ? [nid, branchId] : [nid]); // no LIMIT (impact/path)
  if (mode === "who_calls") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='calls' AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { src: string }[];
    return { mode, nodes: rows.map((r) => nodeBrief(store, r.src)) };
  }
  if (mode === "calls_of") {
    const rows = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND edge_type='calls' AND dst IS NOT NULL AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { dst: string }[];
    return { mode, nodes: rows.map((r) => nodeBrief(store, r.dst)) };
  }
  if (mode === "backlinks") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { src: string }[];
    return { mode, nodes: rows.map((r) => nodeBrief(store, r.src)) };
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
    return { mode, nodes: [...seen].slice(0, limit).map((id) => nodeBrief(store, id)) };
  }
  if (mode === "path") {
    const to = options?.to ? resolveNodeId(store, options.to) : null;
    if (!to) return { mode, nodes: [] };
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
    if (!visited.has(to)) return { mode, nodes: [] };
    const chain: string[] = [];
    for (let c: string | undefined = to; c; c = prev.get(c)) chain.unshift(c);
    return { mode, nodes: chain.map((id) => nodeBrief(store, id)) };
  }
  return { mode, nodes: [] };
}

export interface BranchDiff {
  symbol: string;
  branchA: { branchId: string; contentHash: string | null; status: string | null };
  branchB: { branchId: string; contentHash: string | null; status: string | null };
  identical: boolean;
}

// compare_branches: same symbol across two branches; equal hash = no diff (§8.1).
export function compareBranches(
  store: KnowledgeStore,
  symbolIdOrKey: string,
  branchAId: string,
  branchBId: string,
): BranchDiff | null {
  const nodeId = resolveNodeId(store, symbolIdOrKey);
  if (!nodeId) return null;
  const va = store.getSymbolVersion(nodeId, branchAId);
  const vb = store.getSymbolVersion(nodeId, branchBId);
  return {
    symbol: symbolIdOrKey,
    branchA: { branchId: branchAId, contentHash: va?.content_hash ?? null, status: va?.status ?? null },
    branchB: { branchId: branchBId, contentHash: vb?.content_hash ?? null, status: vb?.status ?? null },
    identical: !!va && !!vb && va.content_hash === vb.content_hash,
  };
}

export interface IndexStatus {
  repos: Array<{
    repoId: string; name: string; rootPath: string;
    branches: Array<{ branchId: string; name: string; status: string; lastIndexedAt: string | null; staleSymbols: number }>;
  }>;
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
  branchId: string,
): IndexedFileRow[] {
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
  branchId: string,
  filePath: string,
): FileSymbolRow[] {
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
  nodes: Array<{ nodeId: string; title: string; nodeType: string }>;
  edges: Array<{ src: string; dst: string; edgeType: string }>;
}

// Local graph: a focus node + its neighbourhood within `depth` hops (both
// directions over active edges), capped at `limit` nodes. Only active edges
// (confirmed) are followed — same trust rule as exploreGraph. 22k-node graphs
// can't render whole, so callers recenter by picking a neighbour as new focus.
export function graphNeighborhood(
  store: KnowledgeStore,
  nodeOrKey: string,
  options?: { depth?: number; limit?: number; branchId?: string },
): GraphView {
  const focus = resolveNodeId(store, nodeOrKey);
  if (!focus) return { focus: null, nodes: [], edges: [] };
  const depth = options?.depth ?? 1;
  const limit = options?.limit ?? 150;
  const branchId = options?.branchId ?? null;
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
  branchId: string,
  options?: { limit?: number },
): GraphView {
  const limit = options?.limit ?? 200;
  const top = store.db
    .prepare(
      `SELECT d.id AS id FROM (
         SELECT node AS id, COUNT(*) AS cnt FROM (
           SELECT src AS node FROM edges WHERE branch_id=? AND status='active'
           UNION ALL
           SELECT dst AS node FROM edges WHERE branch_id=? AND status='active' AND dst IS NOT NULL
         ) GROUP BY node
       ) d JOIN nodes n ON n.id = d.id
       WHERE n.repo_id=? ORDER BY d.cnt DESC, d.id LIMIT ?`,
    )
    .all(branchId, branchId, repoId, limit) as { id: string }[];
  const ids = top.map((r) => r.id);
  if (ids.length === 0) return { focus: null, nodes: [], edges: [] };
  return { focus: null, ...collectGraph(store, ids, branchId) };
}

// Build {nodes, edges} for a fixed node-id set — edges only where BOTH ends are
// in the set (optionally scoped to a branch). Shared by the two graph views.
function collectGraph(
  store: KnowledgeStore,
  ids: string[],
  branchId?: string,
): { nodes: GraphView["nodes"]; edges: GraphView["edges"] } {
  const nodes = ids.map((id) => nodeBrief(store, id));
  const ph = ids.map(() => "?").join(",");
  const branchClause = branchId ? "AND branch_id=?" : "";
  const params = branchId ? [branchId, ...ids, ...ids] : [...ids, ...ids];
  const edges = store.db
    .prepare(
      `SELECT src, dst, edge_type AS edgeType FROM edges
       WHERE status='active' AND dst IS NOT NULL ${branchClause}
         AND src IN (${ph}) AND dst IN (${ph})`,
    )
    .all(...params) as GraphView["edges"];
  return { nodes, edges };
}

// index_status: repos/branches + staleness (answers list_repos/list_branches, §8.1).
export function indexStatus(store: KnowledgeStore): IndexStatus {
  const repos = store.db.prepare("SELECT id, name, root_path AS rootPath FROM repos ORDER BY name").all() as Array<{ id: string; name: string; rootPath: string }>;
  return {
    repos: repos.map((repo) => {
      const branches = store.db.prepare("SELECT id, name, status, last_indexed_at AS lastIndexedAt FROM branches WHERE repo_id=? ORDER BY name").all(repo.id) as Array<{ id: string; name: string; status: string; lastIndexedAt: string | null }>;
      return {
        repoId: repo.id, name: repo.name, rootPath: repo.rootPath,
        branches: branches.map((b) => {
          const stale = store.db.prepare("SELECT COUNT(*) AS n FROM symbol_versions WHERE branch_id=? AND status='stale'").get(b.id) as { n: number };
          return { branchId: b.id, name: b.name, status: b.status, lastIndexedAt: b.lastIndexedAt, staleSymbols: stale.n };
        }),
      };
    }),
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
  referencedBy: ContextBrief[]; // who uses this as a type (references in)
  usesTypes: ContextBrief[]; // types the focus uses (references out)
  routes: Array<{ route: string; via: "direct" | "caller" }>; // HTTP routes reaching the focus
  tests: ContextBrief[]; // test files that exercise the focus
  errors: string[]; // error types the focus throws
  envs: string[]; // env vars the focus reads
  notes: ContextBrief[]; // notes linked to the focus
  importers: ContextBrief[]; // files importing the focus's file
  signals: string[]; // risk/attention heuristics
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
  options?: { branchId?: string; limit?: number },
): ContextPack {
  const limit = options?.limit ?? 25;
  const empty: ContextPack = {
    target, focus: null, callers: [], calls: [], referencedBy: [], usesTypes: [],
    routes: [], tests: [], errors: [], envs: [], notes: [], importers: [], signals: [],
  };
  const focusId = resolveNodeId(store, target);
  if (!focusId) return empty;

  const detail = getNodeDetail(store, focusId);
  const active = "status='active'";
  // Branch-scope to the focus's live branch (or an explicit one) so a repo indexed
  // on multiple branches doesn't mix them. branch-less edges (git / global gRPC
  // endpoints) always pass so cross-repo links aren't dropped.
  const branchId = options?.branchId ?? liveBranchOf(store, focusId);
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const inEdges = (type: string) =>
    store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type=? AND ${active}${bx} LIMIT ?`)
      .all(...(branchId ? [focusId, type, branchId, limit] : [focusId, type, limit])) as { id: string }[];
  const outEdges = (type: string) =>
    store.db.prepare(`SELECT DISTINCT dst AS id FROM edges WHERE src=? AND edge_type=? AND dst IS NOT NULL AND ${active}${bx} LIMIT ?`)
      .all(...(branchId ? [focusId, type, branchId, limit] : [focusId, type, limit])) as { id: string }[];

  const callers = inEdges("calls");
  const calls = outEdges("calls");
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

  return {
    target,
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
    referencedBy: briefsFrom(store, referencedBy),
    usesTypes: briefsFrom(store, usesTypes),
    routes,
    tests: briefsFrom(store, tests),
    errors,
    envs,
    notes,
    importers,
    signals,
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
    return `# Context Pack: ${pack.target}\n\n_No matching symbol/note found._\n`;
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
}
export interface FlowResult {
  target: string;
  root: FlowStep | null;
  steps: FlowStep[];
}

const DOWNSTREAM = ["calls", "invokes", "references", "reads", "writes", "throws", "uses", "handles"];

export function buildFlow(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; depth?: number; limit?: number },
): FlowResult {
  const focus = resolveNodeId(store, target);
  if (!focus) return { target, root: null, steps: [] };
  const depthCap = options?.depth ?? 5;
  const limit = options?.limit ?? 60;
  const branchId = options?.branchId ?? liveBranchOf(store, focus);
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const ph = DOWNSTREAM.map(() => "?").join(",");

  const outEdges = (id: string) => {
    const params = branchId ? [id, ...DOWNSTREAM, branchId] : [id, ...DOWNSTREAM];
    return store.db
      .prepare(
        `SELECT DISTINCT dst AS id, edge_type AS via FROM edges
         WHERE src=? AND dst IS NOT NULL AND status='active' AND edge_type IN (${ph})${bx}
         ORDER BY edge_type`,
      )
      .all(...params) as Array<{ id: string; via: string }>;
  };

  const root: FlowStep = { depth: 0, ...nodeBriefStep(store, focus), via: "root" };
  const steps: FlowStep[] = [root];
  const seen = new Set<string>([focus]);
  // DFS so a chain reads top-to-bottom (controller → service → repo → db).
  const visit = (id: string, depth: number) => {
    if (depth >= depthCap || steps.length >= limit) return;
    for (const e of outEdges(id)) {
      if (steps.length >= limit) break;
      const brief = nodeBriefStep(store, e.id);
      steps.push({ depth: depth + 1, ...brief, via: e.via });
      if (!seen.has(e.id)) {
        seen.add(e.id);
        visit(e.id, depth + 1);
      }
    }
  };
  visit(focus, 0);
  return { target, root, steps };
}

function nodeBriefStep(store: KnowledgeStore, id: string) {
  const b = nodeBrief(store, id);
  return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType };
}

export function renderFlowMarkdown(flow: FlowResult): string {
  if (!flow.root) return `# Flow: ${flow.target}\n\n_No matching entry point/symbol._\n`;
  const L: string[] = [`# Flow: ${flow.root.title}`, ""];
  for (const s of flow.steps) {
    const indent = "  ".repeat(s.depth);
    const arrow = s.via === "root" ? "" : `${s.via} → `;
    const tag = s.nodeType !== "symbol" ? ` _(${s.nodeType})_` : "";
    L.push(`${indent}${s.depth === 0 ? "" : "↳ "}${arrow}\`${s.title}\`${tag}`);
  }
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
  options?: { depth?: number; limit?: number },
): AffectedResult {
  const depth = options?.depth ?? 3;
  const limit = options?.limit ?? 200;
  if (files.length === 0) return { files, changed: [], impacted: [], tests: [], routes: [] };
  const ph = files.map(() => "?").join(",");
  const changedIds = (store.db
    .prepare(`SELECT DISTINCT node_id AS id FROM symbol_versions WHERE file_path IN (${ph})`)
    .all(...files) as { id: string }[]).map((r) => r.id);

  // transitive who_calls from the changed set = blast radius.
  const seen = new Set(changedIds);
  let frontier = [...changedIds];
  for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.size >= limit) break;
      // both "calls" and "references" mean "depends on this" — a DTO/type change
      // ripples through its type-users just as a fn change ripples through callers.
      const callers = store.db.prepare("SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type IN ('calls','references') AND status='active'").all(id) as { src: string }[];
      for (const c of callers) if (!seen.has(c.src)) { seen.add(c.src); next.push(c.src); }
    }
    frontier = next;
  }
  const impactedIds = [...seen].filter((id) => !changedIds.includes(id));

  const allIds = [...seen];
  const p2 = allIds.map(() => "?").join(",");
  const tests = allIds.length
    ? (store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='tests' AND status='active' AND dst IN (${p2}) LIMIT ?`).all(...allIds, limit) as { id: string }[])
    : [];
  const routes = allIds.length
    ? (store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='handles' AND status='active' AND dst IN (${p2}) LIMIT ?`).all(...allIds, limit) as { id: string }[])
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
   .filter((h) => h.nodeType === "symbol").slice(0, 12);
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
}

// Module/community detection over the active structural graph via label
// propagation (§P3): each node adopts the majority label among its neighbours,
// iterated to convergence. Deterministic (smallest-label tie-break) so repeated
// runs agree. Returns the largest communities, each with its highest-degree
// "god node" first and the repos it spans.
export function communities(store: KnowledgeStore, opts: { limit?: number; minSize?: number } = {}): CommunityResult {
  const limit = opts.limit ?? 20;
  const minSize = opts.minSize ?? 3;
  const edges = store.db
    .prepare(
      "SELECT src, dst FROM edges WHERE status='active' AND dst IS NOT NULL AND edge_type IN ('calls','references','imports','defines')",
    )
    .all() as { src: string; dst: string }[];

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
  const nodeRepo = new Map<string, string | null>(
    (store.db.prepare("SELECT id, repo_id FROM nodes").all() as { id: string; repo_id: string | null }[]).map((r) => [
      r.id,
      r.repo_id,
    ]),
  );

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

  return { communities: communitiesOut, totalNodes: nodes.length, totalCommunities: groups.size };
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
}

// Recent history across the graph (§P3 timeline): commit nodes ordered by their
// authored date, newest first, with author/merge flag/repo and any tags that
// point at them. Optional repo filter.
export function timeline(store: KnowledgeStore, opts: { limit?: number; repoId?: string } = {}): TimelineResult {
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
// Nodes = repos (services) + external gRPC endpoints they consume but whose
// provider isn't indexed. Edges = consumer→provider (a real cross-service call,
// via a shared global endpoint) or consumer→external-endpoint. This answers
// "how do the services relate" without needing a symbol focus.
export function serviceGraph(store: KnowledgeStore): GraphView {
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
    } else {
      // provider not indexed → show the external endpoint node
      const b = nodeBrief(store, c.endpoint);
      if (!nodes.has(c.endpoint)) nodes.set(c.endpoint, { nodeId: c.endpoint, title: b.title, nodeType: "endpoint" });
      addEdge(c.repo, c.endpoint, "invokes");
    }
  }
  // always include every repo as a node (even isolated ones)
  for (const r of repos) useRepo(r.id);
  return { focus: null, nodes: [...nodes.values()], edges: [...edgeSet.values()] };
}
