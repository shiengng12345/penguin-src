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
  filters?: { type?: string[]; repo?: string; includeSensitive?: boolean; limit?: number },
): SearchResultRow[] {
  const hits = store.searchText(query, {
    types: filters?.type,
    includeSensitive: filters?.includeSensitive,
    limit: filters?.limit,
  });
  if (!filters?.repo) return hits;
  return hits.filter((h) => {
    const n = store.getNode(h.nodeId);
    return n?.repo_id === filters.repo;
  });
}

export interface NodeDetail {
  node: { id: string; nodeType: string; identityKey: string; title: string; repoId: string | null };
  versions: Array<{ branchId: string; filePath: string; lang: string; kind: string; status: string; contentHash: string }>;
  aliases: Array<{ aliasKey: string; reason: string | null; validTo: string | null }>;
  body: string | null; // note body, honoring mcp_access; null for symbols/denied
}

// get_node: node + versions (symbol) or body (note, respects mcp_access) + aliases (§8.1).
export function getNodeDetail(store: KnowledgeStore, idOrKey: string): NodeDetail | null {
  const nodeId = resolveNodeId(store, idOrKey);
  if (!nodeId) return null;
  const node = store.getNode(nodeId)!;
  const versions = store.db
    .prepare(
      `SELECT branch_id AS branchId, file_path AS filePath, lang, kind, status, content_hash AS contentHash
       FROM symbol_versions WHERE node_id=? ORDER BY branch_id`,
    )
    .all(nodeId) as NodeDetail["versions"];
  const aliases = store
    .getAliases(nodeId)
    .map((a) => ({ aliasKey: a.aliasKey, reason: a.reason, validTo: a.validTo }));

  let body: string | null = null;
  const noteRow = store.db
    .prepare("SELECT mcp_access FROM notes_index WHERE node_id=?")
    .get(nodeId) as { mcp_access: string } | undefined;
  if (noteRow && noteRow.mcp_access !== "denied") {
    const fts = store.db
      .prepare("SELECT body FROM fts_notes WHERE node_id=?")
      .get(nodeId) as { body: string } | undefined;
    body = fts?.body ?? null;
  }

  return {
    node: {
      id: node.id, nodeType: node.node_type, identityKey: node.identity_key,
      title: node.title, repoId: node.repo_id,
    },
    versions, aliases, body,
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

// explore_graph: one traversal entry point across modes (§8.1).
export function exploreGraph(
  store: KnowledgeStore,
  mode: GraphMode,
  nodeOrKey: string,
  options?: { depth?: number; limit?: number; to?: string },
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
  if (mode === "who_calls") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='calls' AND ${ACTIVE} LIMIT ?`).all(nodeId, limit) as { src: string }[];
    return { mode, nodes: rows.map((r) => nodeBrief(store, r.src)) };
  }
  if (mode === "calls_of") {
    const rows = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND edge_type='calls' AND dst IS NOT NULL AND ${ACTIVE} LIMIT ?`).all(nodeId, limit) as { dst: string }[];
    return { mode, nodes: rows.map((r) => nodeBrief(store, r.dst)) };
  }
  if (mode === "backlinks") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND ${ACTIVE} LIMIT ?`).all(nodeId, limit) as { src: string }[];
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
        const callers = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='calls' AND ${ACTIVE}`).all(id) as { src: string }[];
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
      const outs = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND dst IS NOT NULL AND ${ACTIVE}`).all(cur) as { dst: string }[];
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
