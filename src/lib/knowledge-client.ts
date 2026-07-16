// Typed webview wrappers over the Rust knowledge bridge (src-tauri/knowledge.rs).
// Everything routes through the bundled `penguin` CLI (same query semantics as
// CLI/MCP, §8.3) except db_status which is a cheap direct read. The UI adds no
// query logic — it's a view over the shared implementation.
import { invoke } from "@tauri-apps/api/core";

export function formatKnowledgeError(error: unknown): string {
  const raw = String((error as Error).message ?? error);
  const abi = raw.match(/NODE_MODULE_VERSION\s+(\d+).*?NODE_MODULE_VERSION\s+(\d+)/s);
  if (raw.includes("better-sqlite3") && raw.includes("NODE_MODULE_VERSION")) {
    const detail = abi ? `built ABI ${abi[1]}, runtime ABI ${abi[2]}` : "Node ABI mismatch";
    return `Knowledge index dependency mismatch (${detail}). Run pnpm rebuild better-sqlite3, then reopen Penguin.`;
  }
  if (raw.startsWith("penguin CLI exit")) {
    const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? raw;
    return firstLine.length > 220 ? `${firstLine.slice(0, 217)}...` : firstLine;
  }
  return raw.length > 260 ? `${raw.slice(0, 257)}...` : raw;
}

// The CLI exits 3 with this message when knowledge.db simply doesn't exist yet
// (fresh install / index deleted on purpose). That's an onboarding state, not a
// failure — UIs must render "start indexing" guidance instead of an error card.
export function isNoDatabaseError(message: string): boolean {
  return message.includes("no knowledge database");
}

// Terminal availability of the `penguin` CLI (launcher present + on PATH).
// Backs onboarding's one-click "configure penguin command".
export interface CliSetupStatus {
  installed: boolean;
  on_path: boolean;
  rc_updated: boolean;
  bin_dir: string;
  // Login shell basename ("zsh" | "bash" | "fish" | ...); empty if unknown.
  shell: string;
  // Present when PATH couldn't be wired automatically (unrecognized shell).
  manual_hint: string | null;
}

export async function knowledgeCliStatus(): Promise<CliSetupStatus> {
  return invoke<CliSetupStatus>("knowledge_cli_status");
}

export async function knowledgeCliSetup(): Promise<CliSetupStatus> {
  return invoke<CliSetupStatus>("knowledge_cli_setup");
}

// Configure the penguin MCP server into Claude Desktop / Claude Code / Codex
// (idempotent config merges; returns a human summary).
export async function mcpInstallToLocalClients(): Promise<string> {
  return invoke<string>("mcp_install_to_local_clients");
}

// Write/refresh the global Penguin guidance block in the instruction files of
// AI clients present on this machine (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md).
// `skipped` lists clients not installed here — nothing is scaffolded for them.
export interface GuidanceSetupResult {
  written: string[];
  skipped: string[];
}

export async function knowledgeAgentGuidanceSetup(): Promise<GuidanceSetupResult> {
  return invoke<GuidanceSetupResult>("knowledge_agent_guidance_setup");
}

export interface HookSetupResult {
  supported: boolean;
  written: boolean;
  settings_path: string;
  enabled: Array<"SessionStart" | "UserPromptSubmit">;
}

export async function knowledgeAgentHookSetup(
  sessionStart: boolean,
  userPromptSubmit: boolean,
): Promise<HookSetupResult> {
  return invoke<HookSetupResult>("knowledge_agent_hook_setup", {
    sessionStart,
    userPromptSubmit,
  });
}

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
  identityKey: string;
  filePath: string | null;
  branch: string | null;
  rank: number | null;
}

export interface KnowledgeNodeDetail {
  node: { id: string; nodeType: string; identityKey: string; title: string; repoId: string | null };
  versions: Array<{
    branchId: string; filePath: string; lang: string; kind: string; status: string;
    contentHash: string; signature: string | null; startLine: number | null; endLine: number | null;
  }>;
  aliases: Array<{ aliasKey: string; reason: string | null; validTo: string | null }>;
  body: string | null;
  // Code symbols: the declaration's source read off disk (null for notes/unreadable).
  source: { code: string; lang: string; filePath: string; startLine: number } | null;
  // Typed notes (why-layer): kind + lifecycle from frontmatter (null for symbols).
  note: { type: string; status: string | null; owner: string | null } | null;
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
    defaultBranch: string | null;
    branches: Array<{ branchId: string; name: string; status: string; lastIndexedAt: string | null; defaultBranch: boolean; baseBranchName: string | null; staleSymbols: number; pinned: boolean; trust?: { snapshotId?: string | null; baseCommit?: string | null; headCommit?: string | null; mergeBaseCommit?: string | null; changedFiles?: number; reusePercent?: number | null; cacheState?: string; deploymentTargets?: string[] } | null }>;
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

// Hide the checked-off node types — and optionally individual nodes (service
// map: pick which repos display) — from a graph view. Pure: the raw view stays
// intact so re-checking restores. Edges touching a hidden node drop with it
// (a dangling edge would crash the force layout).
export function filterGraphView(
  view: KnowledgeGraphView,
  hiddenTypes: Set<string>,
  hiddenIds?: Set<string>,
): KnowledgeGraphView {
  if (hiddenTypes.size === 0 && !hiddenIds?.size) return view;
  const nodes = view.nodes.filter((n) => !hiddenTypes.has(n.nodeType) && !hiddenIds?.has(n.nodeId));
  const keep = new Set(nodes.map((n) => n.nodeId));
  return {
    focus: view.focus && keep.has(view.focus) ? view.focus : null,
    nodes,
    edges: view.edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
  };
}

// repos + branches for the navigation tree's top two levels.
export function knowledgeIndexStatus(): Promise<KnowledgeIndexStatus> {
  return query<KnowledgeIndexStatus>(["status"]);
}

export interface KnowledgeEvidenceNote {
  slug: string; path: string; nodeId?: string; title: string; targetId: string;
  environment: string; region: string; project: string; logstore: string;
  status: "draft" | "reviewed" | "verified" | "resolved" | "archived";
  firstSeen?: string; lastSeen?: string; observationCount: number;
  topicHash?: string; evidenceHash?: string; sensitive: boolean; mcpAccess: string; indexed: boolean;
}
export function knowledgeEvidenceList(filters?: { target?: string; status?: string; limit?: number }): Promise<KnowledgeEvidenceNote[]> {
  const args = ["evidence", "list"];
  if (filters?.target) args.push("--target", filters.target);
  if (filters?.status) args.push("--status", filters.status);
  if (filters?.limit) args.push("--limit", String(filters.limit));
  args.push("--json");
  return query<KnowledgeEvidenceNote[]>(args);
}
export function knowledgeEvidenceSetStatus(slug: string, status: KnowledgeEvidenceNote["status"]): Promise<KnowledgeEvidenceNote> {
  return query<KnowledgeEvidenceNote>(["evidence", "status", slug, status, "--json"]);
}

// Remove a repo (by name or root path) from the index — parser data only,
// rebuildable by re-indexing. Backs the Explorer/table delete buttons.
export function knowledgeRemoveRepo(nameOrPath: string): Promise<{ ok: boolean; name: string }> {
  return query<{ ok: boolean; name: string }>(["remove", nameOrPath]);
}

// Remove a single branch of a repo (refused while pinned).
export function knowledgeRemoveBranch(repo: string, branch: string): Promise<{ ok: boolean }> {
  return query<{ ok: boolean }>(["remove", repo, branch]);
}

// Toggle a branch's pin: pinned branches are exempt from auto-retention.
export function knowledgePinBranch(repo: string, branch: string): Promise<{ ok: boolean; pinned: boolean }> {
  return query<{ ok: boolean; pinned: boolean }>(["pin", repo, branch]);
}

// Select the canonical master branch without checking out Git or indexing.
export function knowledgeSetMaster(repo: string, branch: string): Promise<{ ok: boolean; branch: string; previousBranchId: string | null }> {
  return query<{ ok: boolean; branch: string; previousBranchId: string | null }>(["master", repo, branch]);
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

// —— AI Context Pack + Flow (the hero views) ——

export interface ContextBrief { nodeId: string; title: string; nodeType: string }
export interface ContextPack {
  target: string;
  focus: {
    nodeId: string; title: string; nodeType: string; kind: string | null;
    filePath: string | null; signature: string | null; source: string | null;
    branches: Array<{ branch: string; status: string }>;
  } | null;
  callers: ContextBrief[];
  calls: ContextBrief[];
  remoteCalls: ContextBrief[];
  invokedBy: ContextBrief[];
  referencedBy: ContextBrief[];
  usesTypes: ContextBrief[];
  routes: Array<{ route: string; via: "direct" | "caller" }>;
  tests: ContextBrief[];
  errors: string[];
  envs: string[];
  notes: ContextBrief[];
  importers: ContextBrief[];
  signals: string[];
}
export function knowledgeContext(target: string): Promise<ContextPack> {
  return query<ContextPack>(["context", target]);
}

export interface FlowStep { depth: number; nodeId: string; title: string; nodeType: string; via: string }
export interface FlowResult { target: string; root: FlowStep | null; steps: FlowStep[] }
export function knowledgeFlow(target: string): Promise<FlowResult> {
  return query<FlowResult>(["flow", target]);
}

// Repo/branch-scoped graph (top-degree hubs).
export function knowledgeRepoGraph(repoId: string, branchId: string): Promise<KnowledgeGraphView> {
  return query<KnowledgeGraphView>(["repograph", repoId, branchId]);
}

// System-level microservice map: services + cross-service gRPC links.
export function knowledgeServiceGraph(): Promise<KnowledgeGraphView> {
  return query<KnowledgeGraphView>(["services"]);
}

// Module/community clusters (label propagation), each with its god node first.
export interface KnowledgeCommunity {
  id: number;
  size: number;
  repos: string[];
  topMembers: Array<{ title: string; nodeType: string; degree: number }>;
}
export interface KnowledgeCommunityResult {
  communities: KnowledgeCommunity[];
  totalNodes: number;
  totalCommunities: number;
}
export function knowledgeCommunities(limit = 20): Promise<KnowledgeCommunityResult> {
  return query<KnowledgeCommunityResult>(["communities", String(limit)]);
}

// Recent commits across repos (timeline view).
export interface KnowledgeTimelineEntry {
  sha: string;
  subject: string;
  author: string | null;
  date: string | null;
  merge: boolean;
  repo: string | null;
  tags: string[];
}
export function knowledgeTimeline(limit = 50): Promise<{ entries: KnowledgeTimelineEntry[] }> {
  return query<{ entries: KnowledgeTimelineEntry[] }>(["timeline", String(limit)]);
}

// —— File-backed notes (C9): create / read / overwrite / list ——

export function knowledgeNoteNew(title: string): Promise<{ ok: boolean; slug: string; path: string; nodeId: string }> {
  return query(["note", "new", title]);
}

// Typed note (decision/incident/compliance/bug/requirement/architecture) — the
// why-layer lifecycle. `incident` uses the structured incident scaffold.
export type KnowledgeNoteType =
  | "decision" | "incident" | "compliance" | "bug" | "requirement" | "architecture";
export function knowledgeNoteNewTyped(
  title: string,
  type: KnowledgeNoteType,
): Promise<{ ok: boolean; slug: string; path: string; nodeId: string; type?: string }> {
  if (type === "incident") return query(["incident", "new", title]);
  return query(["note", "new", title, `--type=${type}`]);
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

export interface IndexProgress {
  phase: "scan" | "index" | "complete";
  done?: number;
  total?: number;
  file?: string;
  rootPath?: string;
  report?: KnowledgeIndexReport;
}

// Subscribe to live index progress (emitted by the Rust bridge while
// knowledge_reindex runs). Returns an unlisten fn. Lazy-imports the event API
// so the module's only static Tauri import stays @tauri-apps/api/core.
export async function onIndexProgress(cb: (p: IndexProgress) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<IndexProgress>("knowledge-index-progress", (e) => cb(e.payload));
}

export interface WatchStatus {
  repoId: string;
  watching: boolean;
}

// Toggle live auto-indexing for one repo: spawns/kills a `penguin watch
// <rootPath>` child process (Rust-managed WatchRegistry). Returns the
// resulting on/off state (mirrors the request on success).
export function knowledgeWatchToggle(repoId: string, rootPath: string, enable: boolean): Promise<boolean> {
  return invoke<boolean>("knowledge_watch_toggle", { repoId, rootPath, enable });
}

export function knowledgeWatchStatus(repoIds: string[]): Promise<WatchStatus[]> {
  return invoke<WatchStatus[]>("knowledge_watch_status", { repoIds });
}

// Subscribe to a watched repo's incremental re-index runs (fired once per
// debounced file-change settle, not just once like onIndexProgress).
export async function onWatchEvent(
  cb: (repoId: string, payload: unknown) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ repoId: string; payload: unknown }>("knowledge-watch-event", (e) =>
    cb(e.payload.repoId, e.payload.payload),
  );
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

// Captured runtime responses for an endpoint (Penguin's REST/gRPC channel).
export interface KnowledgeResponseSample {
  id: string;
  endpointKey: string;
  status: string | null;
  contentType: string | null;
  sample: string;
  capturedAt: string;
}
export function knowledgeEndpointSamples(endpoint: string): Promise<KnowledgeResponseSample[]> {
  return query<KnowledgeResponseSample[]>(["samples", endpoint]);
}
