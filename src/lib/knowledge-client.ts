// Typed webview wrappers over the Rust knowledge bridge (src-tauri/knowledge.rs).
// Everything routes through the bundled `penguin` CLI (same query semantics as
// CLI/MCP, §8.3) except db_status which is a cheap direct read. The UI adds no
// query logic — it's a view over the shared implementation.
import { invoke } from "@tauri-apps/api/core";

export interface KnowledgeDbStatus {
  db_path: string;
  exists: boolean;
  repos: number;
  symbols: number;
  notes: number;
}

export interface KnowledgeSearchHit {
  nodeId: string;
  nodeType: string;
  title: string;
  snippet: string | null;
}

export interface KnowledgeNodeDetail {
  node: { id: string; nodeType: string; identityKey: string; title: string; repoId: string | null };
  versions: Array<{ branchId: string; filePath: string; lang: string; kind: string; status: string; contentHash: string }>;
  aliases: Array<{ aliasKey: string; reason: string | null; validTo: string | null }>;
  body: string | null;
}

export interface KnowledgeGraphResult {
  mode: string;
  nodes: Array<{ nodeId: string; title: string; nodeType: string }>;
  events?: Array<{ eventType: string; ts: string; origin: string; method: string; nodeId: string | null }>;
}

export interface KnowledgeIndexReport {
  repoId: string;
  branchName: string;
  parsed: number;
  skipped: number;
  deleted: number;
  renamed: number;
  errors: number;
}

async function query<T>(args: string[]): Promise<T> {
  const raw = await invoke<string>("knowledge_query", { args });
  return JSON.parse(raw) as T;
}

export function knowledgeDbStatus(): Promise<KnowledgeDbStatus> {
  return invoke<KnowledgeDbStatus>("knowledge_db_status");
}

export function knowledgeSearch(q: string): Promise<KnowledgeSearchHit[]> {
  return query<KnowledgeSearchHit[]>(["search", q]);
}

export function knowledgeNode(idOrName: string): Promise<KnowledgeNodeDetail> {
  return query<KnowledgeNodeDetail>(["node", idOrName]);
}

export type KnowledgeGraphVerb = "callers" | "calls" | "backlinks" | "impact" | "recent";

export function knowledgeExplore(verb: KnowledgeGraphVerb, node: string): Promise<KnowledgeGraphResult> {
  return query<KnowledgeGraphResult>([verb, node]);
}

export async function knowledgeReindex(path?: string): Promise<KnowledgeIndexReport> {
  const raw = await invoke<string>("knowledge_reindex", { path: path ?? null });
  return JSON.parse(raw) as KnowledgeIndexReport;
}

// —— Index browse (repo → branch → file → symbol) + graph view (Plan 8 ②) ——

export interface KnowledgeIndexStatus {
  repos: Array<{
    repoId: string;
    name: string;
    rootPath: string;
    branches: Array<{ branchId: string; name: string; status: string; lastIndexedAt: string | null; staleSymbols: number }>;
  }>;
}

export interface KnowledgeFileRow {
  filePath: string;
  lang: string | null;
  status: string; // indexed | skipped | deleted | error
  sizeBytes: number | null;
  indexedAt: string | null;
  error: string | null;
}

export interface KnowledgeFileSymbol {
  nodeId: string;
  title: string;
  kind: string;
  status: string; // fresh | stale
}

export interface KnowledgeGraphView {
  focus: string | null;
  nodes: Array<{ nodeId: string; title: string; nodeType: string }>;
  edges: Array<{ src: string; dst: string; edgeType: string }>;
}

// repos + branches for the navigation tree's top two levels.
export function knowledgeIndexStatus(): Promise<KnowledgeIndexStatus> {
  return query<KnowledgeIndexStatus>(["status"]);
}

// The files captured for a repo/branch (tree leaf level, lazy-loaded).
export function knowledgeFiles(repoId: string, branchId: string): Promise<KnowledgeFileRow[]> {
  return query<KnowledgeFileRow[]>(["files", repoId, branchId]);
}

// The symbols defined in one file (click-a-file → its symbols).
export function knowledgeFileSymbols(branchId: string, filePath: string): Promise<KnowledgeFileSymbol[]> {
  return query<KnowledgeFileSymbol[]>(["filesymbols", branchId, filePath]);
}

// Local graph: a focus node + its neighbourhood (recenter by picking a node).
export function knowledgeGraph(node: string, depth = 1): Promise<KnowledgeGraphView> {
  return query<KnowledgeGraphView>(["graph", node, String(depth)]);
}

// Repo/branch-scoped graph (top-degree hubs).
export function knowledgeRepoGraph(repoId: string, branchId: string): Promise<KnowledgeGraphView> {
  return query<KnowledgeGraphView>(["repograph", repoId, branchId]);
}

// —— File-backed notes (C9): create / read / overwrite / list ——

export function knowledgeNoteNew(title: string): Promise<{ ok: boolean; slug: string; path: string; nodeId: string }> {
  return query(["note", "new", title]);
}

export function knowledgeNoteWrite(slug: string, body: string): Promise<{ ok: boolean; path: string; nodeId: string }> {
  return query(["note", "write", slug, body]);
}

export function knowledgeNoteRead(slug: string): Promise<{ slug: string; source: string }> {
  return query(["note", "read", slug]);
}

export function knowledgeNoteList(): Promise<string[]> {
  return query(["note", "list"]);
}

// Distinct tags across notes — powers the editor's `#` autocomplete.
export function knowledgeTags(): Promise<string[]> {
  return query<string[]>(["tags"]);
}

// Parse the search box's `type:`/`repo:`/`tag:`/`entity:` filter syntax out of
// the free text (§7). Returns the residual query + parsed filters.
export function parseSearchFilters(input: string): {
  query: string;
  filters: { type?: string; repo?: string; tag?: string; entity?: string };
} {
  const filters: { type?: string; repo?: string; tag?: string; entity?: string } = {};
  const residual: string[] = [];
  for (const tok of input.split(/\s+/)) {
    const m = tok.match(/^(type|repo|tag|entity):(.+)$/);
    if (m) filters[m[1] as keyof typeof filters] = m[2];
    else if (tok) residual.push(tok);
  }
  return { query: residual.join(" "), filters };
}
