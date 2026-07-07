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
