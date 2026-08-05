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

// Phase 1B Task 9: the resident query-server and the MCP server both now
// refuse to migrate a stale on-disk schema (allowSchemaMutation:false) --
// merely launching the app/MCP must never silently run DDL against the DB.
// A call made while the DB is behind rejects with a `SCHEMA_OUTDATED: ...`
// string: for the query-server this crosses the Tauri bridge as the
// resident-worker handshake error (src-tauri/src/knowledge.rs's
// validate_runtime_hello), for the MCP server it's the standard
// `{ error: { code: "SCHEMA_OUTDATED", ... } }` tool result. Either shape
// puts the literal code in the error text this checks against, so a Wiki
// view can render "run `penguin index`" guidance instead of a generic
// failure banner.
export function isSchemaOutdatedError(error: unknown): boolean {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  return typeof raw === "string" && raw.includes("SCHEMA_OUTDATED");
}

// Phase 1B Task 8: the query-server `knowledge.cli` compat bridge no longer
// force-injects --allow-fallback, so a scoped verb (context/flow/...) run
// against a checked-out branch that isn't indexed now reaches the UI as a
// real error instead of a silent fallback answer. The bridge encodes it as
// `{ code: "BRANCH_NOT_INDEXED" | "SCOPE_NOT_FOUND", message, candidates }`
// JSON — this IS the string that crosses the Tauri IPC boundary (see
// packages/knowledge-cli/src/query-server.ts's knowledge.cli bridge: the
// Rust reader thread only ever forwards the response frame's error.message
// text, so `code`/`candidates` are duplicated inside that string on purpose).
// `query()` below parses it into this typed error so a Wiki view can render
// an actionable blocker instead of a generic error banner.
export type ScopeBlockedErrorCode = "BRANCH_NOT_INDEXED" | "SCOPE_NOT_FOUND";

export class ScopeBlockedError extends Error {
  readonly code: ScopeBlockedErrorCode;
  readonly candidates: Array<{ branchName: string; commitSha: string }>;
  constructor(code: ScopeBlockedErrorCode, message: string, candidates: Array<{ branchName: string; commitSha: string }> = []) {
    super(message);
    this.name = "ScopeBlockedError";
    this.code = code;
    this.candidates = candidates;
  }
}

function parseScopeBlockedError(error: unknown): ScopeBlockedError | null {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const { code, message, candidates } = parsed as { code?: unknown; message?: unknown; candidates?: unknown };
  if (code !== "BRANCH_NOT_INDEXED" && code !== "SCOPE_NOT_FOUND") return null;
  if (typeof message !== "string") return null;
  return new ScopeBlockedError(code, message, Array.isArray(candidates) ? (candidates as Array<{ branchName: string; commitSha: string }>) : []);
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

// Trust envelope carried by every CLI-bridge JSON response since Phase 1A
// (context packs, flow, graph, explore) — which repo/branch/commit actually
// produced the answer, whether it lines up with the caller's intended scope,
// and any structured warnings explaining a fallback. Not every verb emits
// every field (legacy verbs may only send `scopeFallback`), so all optional;
// UIs must render nothing when `locator` itself is absent.
export interface KnowledgeLocator {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchId?: string;
  branchName?: string;
  commitSha?: string;
  snapshotId: string;
  worktreeState: "clean" | "dirty" | "snapshot" | "unknown";
  indexedAt?: string;
}

export type ScopeAlignment = "aligned" | "revision_behind" | "fallback" | "explicit";

export interface StructuredWarning {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ScopeEnvelopeFields {
  locator?: KnowledgeLocator;
  alignment?: ScopeAlignment;
  warnings?: StructuredWarning[];
  // Legacy verbs that don't emit the full envelope may still report a bare
  // branch fallback.
  scopeFallback?: { branchId: string };
}

export interface KnowledgeGraphResult extends ScopeEnvelopeFields {
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

export interface KnowledgeRequestOptions { signal?: AbortSignal }

function abortable<T>(request: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { onAbort?.(); reject(new DOMException("The operation was aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    request.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

async function query<T>(args: string[], signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const requestId = globalThis.crypto?.randomUUID?.() ?? `knowledge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let raw: string;
  try {
    raw = await abortable(invoke<string>("knowledge_query", { args: [...args, `--request-id=${requestId}`] }), signal, () => { void invoke("knowledge_query_cancel", { requestId }).catch(() => undefined); });
  } catch (error) {
    const scopeBlocked = parseScopeBlockedError(error);
    // A scope blocker (BRANCH_NOT_INDEXED/SCOPE_NOT_FOUND) means the checked-out
    // branch/scope just changed under the caller — the cached status panel
    // (repo/branch alignment) is now stale too, so drop it here rather than
    // waiting out its TTL, letting the footer refresh promptly alongside the
    // blocker instead of showing a "still aligned" footer next to it.
    if (scopeBlocked) statusPanelCache = null;
    throw scopeBlocked ?? error;
  }
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  return JSON.parse(raw) as T;
}

async function canonicalQuery<T>(capabilityId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const requestId = globalThis.crypto?.randomUUID?.() ?? `knowledge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const raw = await abortable(invoke<string>("knowledge_query_canonical", { capabilityId, input, requestId }), signal, () => { void invoke("knowledge_query_cancel", { requestId }).catch(() => undefined); });
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  return JSON.parse(raw) as T;
}

export function knowledgeDbStatus(options: KnowledgeRequestOptions = {}): Promise<KnowledgeDbStatus> {
  return abortable(invoke<KnowledgeDbStatus>("knowledge_db_status"), options.signal);
}

// Mirrors @penguin/knowledge-contracts's SearchLocator (the wire shape the CLI
// bridge actually emits) — repoId/nodeId used to be missing here even though
// the backend always sends them, silently discarding a search hit's exact
// repo+revision the moment it crossed into the Wiki (Phase 1B Task 7).
export interface SearchHitLocator {
  repoId: string;
  repoName: string;
  revisionId: string;
  revisionKind: "commit" | "working_tree";
  branch?: string;
  commitSha?: string;
  worktreeFingerprint?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  startByte?: number;
  endByte?: number;
  offsetEncoding?: "utf8_normalized";
  nodeId?: string;
}

export interface KnowledgeSearchV2Response {
  schemaVersion: "2";
  hits: Array<{ hitId: string; kind: string; lane: string; title: string; locator: SearchHitLocator; snippet?: string; score: number; rankReasons: string[]; evidence: Array<{ status: string }> }>;
  diagnostics: { searchedLanes: string[]; resolvedScopes: Array<{ repoId: string; snapshotId: string; branch: string }>; coverage: { discovered: number; admitted: number; excluded: number; failed: number; stale: number }; warnings: Array<{ code: string; message: string }>; exclusions: Array<{ filePath: string; code: string; reason: string }> };
  page: { limit: number; nextCursor?: string; totalIsExact: boolean };
}

export function knowledgeSearchV2(queryText: string, mode: string = "auto", options: { cursor?: string; limit?: number; repo?: string; branch?: string; snapshot?: string; path?: string; language?: string; kind?: string; includeGenerated?: boolean; includeVendor?: boolean; signal?: AbortSignal } = {}): Promise<KnowledgeSearchV2Response> {
  const revision = options.repo || options.branch || options.snapshot ? [{ ...(options.repo ? { repoName: options.repo } : {}), ...(options.branch ? { branch: options.branch } : {}), ...(options.snapshot ? { snapshotId: options.snapshot } : {}) }] : undefined;
  return canonicalQuery<KnowledgeSearchV2Response>("knowledge.search", {
    query: queryText,
    mode,
    ...(revision ? { scope: { revisions: revision, ...(options.path ? { paths: [options.path] } : {}), ...(options.language ? { languages: [options.language] } : {}), ...(options.kind ? { kinds: [options.kind] } : {}) } } : options.path || options.language || options.kind ? { scope: { ...(options.path ? { paths: [options.path] } : {}), ...(options.language ? { languages: [options.language] } : {}), ...(options.kind ? { kinds: [options.kind] } : {}) } } : {}),
    options: { compact: true, ...(options.includeGenerated ? { includeGenerated: true } : {}), ...(options.includeVendor ? { includeVendor: true } : {}) },
    page: { limit: options.limit ?? 50, ...(options.cursor ? { cursor: options.cursor } : {}) },
  }, options.signal);
}

export interface KnowledgeHitDetail { hitId: string; kind: string; lane: string; title: string; locator: KnowledgeSearchV2Response["hits"][number]["locator"]; snippet?: string; evidence: Array<{ source: string; status: string; locator: KnowledgeSearchV2Response["hits"][number]["locator"] }> }
export function knowledgeGetHit(locator: KnowledgeSearchV2Response["hits"][number]["locator"], options: KnowledgeRequestOptions = {}, contextLines = 5): Promise<KnowledgeHitDetail> {
  return canonicalQuery<KnowledgeHitDetail>("knowledge.get_hit", { filePath: locator.filePath, snapshotId: locator.revisionId, contextLines: Math.max(0, Math.min(100, contextLines)), ...(locator.startLine ? { startLine: locator.startLine } : {}), ...(locator.startByte !== undefined ? { startByte: locator.startByte } : {}) }, options.signal);
}

// Repo trust snapshot for the Wiki footer (§ knowledge.status_panel): which
// branch git has checked out, whether the index is caught up, and how much of
// the repo the index actually covers. Mirrors packages/knowledge-core/src/status-panel.ts EXACTLY.
export interface RepoStatusPanel {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchName: string | null;
  revisionAlignment: "aligned" | "behind" | "branch_not_indexed" | "git_unavailable";
  indexedBranch: string | null;
  lastIndexedAt: string | null;
  staleReason: string | null;
  coverage: { admitted: number; excluded: number; failed: number } | null;
}

export interface StatusPanel {
  db: { connected: true; schemaVersion: number };
  repos: RepoStatusPanel[];
}

// Short TTL: the footer polls this repeatedly, so a longer cache (matching
// knowledgeServiceGraph/knowledgeEvidenceList's CACHE_TTL_MS) would make the
// footer look frozen across a poll interval.
const STATUS_PANEL_CACHE_TTL_MS = 5_000;
let statusPanelCache: { expiresAt: number; promise: Promise<StatusPanel> } | null = null;

export function knowledgeStatusPanel(options: KnowledgeRequestOptions = {}): Promise<StatusPanel> {
  const now = Date.now();
  if (statusPanelCache && statusPanelCache.expiresAt > now) return statusPanelCache.promise;
  const promise = canonicalQuery<StatusPanel>("knowledge.status_panel", {}, options.signal).catch((error) => {
    statusPanelCache = null;
    throw error;
  });
  statusPanelCache = { expiresAt: now + STATUS_PANEL_CACHE_TTL_MS, promise };
  return promise;
}

export function knowledgeNode(idOrName: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeNodeDetail> {
  return query<KnowledgeNodeDetail>(["node", idOrName], options.signal);
}

export type KnowledgeGraphVerb = "callers" | "calls" | "backlinks" | "impact" | "recent";

export function knowledgeExplore(verb: KnowledgeGraphVerb, node: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeGraphResult> {
  return query<KnowledgeGraphResult>([verb, node], options.signal);
}

export async function knowledgeReindex(path?: string): Promise<KnowledgeIndexReport> {
  const raw = await invoke<string>("knowledge_reindex", { path: path ?? null });
  serviceGraphCache = null;
  evidenceCache.clear();
  statusPanelCache = null;
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

export interface KnowledgeGraphView extends ScopeEnvelopeFields {
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
export function knowledgeIndexStatus(options: KnowledgeRequestOptions = {}): Promise<KnowledgeIndexStatus> {
  return query<KnowledgeIndexStatus>(["status"], options.signal);
}

export interface KnowledgeEvidenceNote {
  slug: string; path: string; nodeId?: string; title: string; targetId: string;
  environment: string; region: string; project: string; logstore: string;
  status: "draft" | "reviewed" | "verified" | "resolved" | "archived";
  firstSeen?: string; lastSeen?: string; observationCount: number;
  topicHash?: string; evidenceHash?: string; sensitive: boolean; mcpAccess: string; indexed: boolean;
}
const CACHE_TTL_MS = 15_000;
let serviceGraphCache: { expiresAt: number; promise: Promise<KnowledgeGraphView> } | null = null;
const evidenceCache = new Map<string, { expiresAt: number; promise: Promise<KnowledgeEvidenceNote[]> }>();

export function knowledgeEvidenceList(filters?: { target?: string; status?: string; limit?: number; signal?: AbortSignal }): Promise<KnowledgeEvidenceNote[]> {
  const args = ["evidence", "list"];
  if (filters?.target) args.push("--target", filters.target);
  if (filters?.status) args.push("--status", filters.status);
  if (filters?.limit) args.push("--limit", String(filters.limit));
  args.push("--json");
  const key = args.join("\u0000");
  const now = Date.now();
  const cached = evidenceCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = query<KnowledgeEvidenceNote[]>(args, filters?.signal).catch((error) => {
    evidenceCache.delete(key);
    throw error;
  });
  evidenceCache.set(key, { expiresAt: now + CACHE_TTL_MS, promise });
  return promise;
}
export function knowledgeEvidenceSetStatus(slug: string, status: KnowledgeEvidenceNote["status"], options: KnowledgeRequestOptions = {}): Promise<KnowledgeEvidenceNote> {
  return query<KnowledgeEvidenceNote>(["evidence", "status", slug, status, "--json"], options.signal);
}

export interface KnowledgeSavedQuery {
  id: string; name: string; request: Record<string, unknown>; scope: Record<string, unknown>;
  contractVersion: string; createdAt: string; updatedAt: string;
}
export function knowledgeSavedQueryList(queryText?: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeSavedQuery[]> {
  return query<KnowledgeSavedQuery[]>(["saved-query", "list", ...(queryText ? ["--query", queryText] : []), "--json"], options.signal);
}
export function knowledgeSavedQueryWrite(name: string, request: Record<string, unknown>, options: KnowledgeRequestOptions = {}): Promise<KnowledgeSavedQuery> {
  return query<KnowledgeSavedQuery>(["saved-query", "write", name, JSON.stringify(request), "--json"], options.signal);
}
export function knowledgeSavedQueryRun(name: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeSearchV2Response> {
  return query<KnowledgeSearchV2Response>(["saved-query", "run", name, "--json"], options.signal);
}
export function knowledgeWhyGet(cardId: string, options: KnowledgeRequestOptions = {}): Promise<Record<string, unknown>> {
  return query<Record<string, unknown>>(["why", cardId, "--json"], options.signal);
}

// Remove a repo (by name or root path) from the index — parser data only,
// rebuildable by re-indexing. Backs the Explorer/table delete buttons.
export function knowledgeRemoveRepo(nameOrPath: string, options: KnowledgeRequestOptions = {}): Promise<{ ok: boolean; name: string }> {
  return query<{ ok: boolean; name: string }>(["remove", nameOrPath], options.signal);
}

// Remove a single branch of a repo (refused while pinned).
export function knowledgeRemoveBranch(repo: string, branch: string, options: KnowledgeRequestOptions = {}): Promise<{ ok: boolean }> {
  return query<{ ok: boolean }>(["remove", repo, branch], options.signal);
}

// Toggle a branch's pin: pinned branches are exempt from auto-retention.
export function knowledgePinBranch(repo: string, branch: string, options: KnowledgeRequestOptions = {}): Promise<{ ok: boolean; pinned: boolean }> {
  return query<{ ok: boolean; pinned: boolean }>(["pin", repo, branch], options.signal);
}

// Select the canonical master branch without checking out Git or indexing.
export function knowledgeSetMaster(repo: string, branch: string, options: KnowledgeRequestOptions = {}): Promise<{ ok: boolean; branch: string; previousBranchId: string | null }> {
  return query<{ ok: boolean; branch: string; previousBranchId: string | null }>(["master", repo, branch], options.signal);
}

// The files captured for a repo/branch (tree leaf level, lazy-loaded).
export function knowledgeFiles(repoId: string, branchId: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeFileRow[]> {
  return query<KnowledgeFileRow[]>(["files", repoId, branchId], options.signal);
}

// The symbols defined in one file (click-a-file → its symbols).
export function knowledgeFileSymbols(branchId: string, filePath: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeFileSymbol[]> {
  return query<KnowledgeFileSymbol[]>(["filesymbols", branchId, filePath], options.signal);
}

// Local graph: a focus node + its neighbourhood (recenter by picking a node).
export function knowledgeGraph(node: string, depth = 1, options: KnowledgeRequestOptions = {}): Promise<KnowledgeGraphView> {
  return query<KnowledgeGraphView>(["graph", node, String(depth)], options.signal);
}

// —— AI Context Pack + Flow (the hero views) ——

export interface ContextBrief { nodeId: string; title: string; nodeType: string }
export interface ContextPack extends ScopeEnvelopeFields {
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
// snapshotId/repoId let a caller pin a Context pack to an exact revision —
// notably a Wiki search hit's locator (hit.locator.revisionId is the hit's
// snapshotId; hit.locator.repoId is its repo) — instead of re-resolving
// `target` by name, which can silently land on a different branch (Phase 1B
// Task 7). Maps to the CLI's existing --snapshot/--repo scope selectors
// (Phase 1A resolveCliRevision).
export function knowledgeContext(
  target: string,
  // allowFallback: the caller (a ScopeBlockerPanel's "Answer from <branch>
  // instead" retry) is opting into the CLI's own --allow-fallback flag for
  // THIS ONE request, per Phase 1B Task 8 — the bridge no longer injects it
  // automatically, so a plain retry of the same request would just hit the
  // same BRANCH_NOT_INDEXED/SCOPE_NOT_FOUND error again.
  options: KnowledgeRequestOptions & { snapshotId?: string; repoId?: string; allowFallback?: boolean } = {},
): Promise<ContextPack> {
  const args = ["context", target];
  if (options.snapshotId) args.push("--snapshot", options.snapshotId);
  if (options.repoId) args.push("--repo", options.repoId);
  if (options.allowFallback) args.push("--allow-fallback");
  return query<ContextPack>(args, options.signal);
}

export interface FlowStep { depth: number; nodeId: string; title: string; nodeType: string; via: string }
export interface FlowResult extends ScopeEnvelopeFields { target: string; root: FlowStep | null; steps: FlowStep[] }

// Repo/branch-scoped graph (top-degree hubs).
export function knowledgeRepoGraph(repoId: string, branchId: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeGraphView> {
  return query<KnowledgeGraphView>(["repograph", repoId, branchId], options.signal);
}

// System-level microservice map: services + cross-service gRPC links.
export function knowledgeServiceGraph(options: KnowledgeRequestOptions = {}): Promise<KnowledgeGraphView> {
  const now = Date.now();
  if (serviceGraphCache && serviceGraphCache.expiresAt > now) return serviceGraphCache.promise;
  const promise = query<KnowledgeGraphView>(["services"], options.signal).catch((error) => {
    serviceGraphCache = null;
    throw error;
  });
  serviceGraphCache = { expiresAt: now + CACHE_TTL_MS, promise };
  return promise;
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
export function knowledgeCommunities(limit = 20, options: KnowledgeRequestOptions = {}): Promise<KnowledgeCommunityResult> {
  return query<KnowledgeCommunityResult>(["communities", String(limit)], options.signal);
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
export function knowledgeTimeline(limit = 50, options: KnowledgeRequestOptions = {}): Promise<{ entries: KnowledgeTimelineEntry[] }> {
  return query<{ entries: KnowledgeTimelineEntry[] }>(["timeline", String(limit)], options.signal);
}

// —— File-backed notes (C9): create / read / overwrite / list ——

export function knowledgeNoteNew(title: string, options: KnowledgeRequestOptions = {}): Promise<{ ok: boolean; slug: string; path: string; nodeId: string }> {
  return query(["note", "new", title], options.signal);
}

// Typed note (decision/incident/compliance/bug/requirement/architecture) — the
// why-layer lifecycle. `incident` uses the structured incident scaffold.
export type KnowledgeNoteType =
  | "decision" | "incident" | "compliance" | "bug" | "requirement" | "architecture";
export function knowledgeNoteNewTyped(
  title: string,
  type: KnowledgeNoteType,
  options: KnowledgeRequestOptions = {},
): Promise<{ ok: boolean; slug: string; path: string; nodeId: string; type?: string }> {
  if (type === "incident") return query(["incident", "new", title], options.signal);
  return query(["note", "new", title, `--type=${type}`], options.signal);
}

export function knowledgeNoteWrite(slug: string, body: string, options: KnowledgeRequestOptions = {}): Promise<{ ok: boolean; path: string; nodeId: string }> {
  return query(["note", "write", slug, body], options.signal);
}

export function knowledgeNoteRead(slug: string, options: KnowledgeRequestOptions = {}): Promise<{ slug: string; source: string }> {
  return query(["note", "read", slug], options.signal);
}

export function knowledgeNoteList(options: KnowledgeRequestOptions = {}): Promise<string[]> {
  return query(["note", "list"], options.signal);
}

// Distinct tags across notes — powers the editor's `#` autocomplete.
export function knowledgeTags(options: KnowledgeRequestOptions = {}): Promise<string[]> {
  return query<string[]>(["tags"], options.signal);
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
export function knowledgeEndpointSamples(endpoint: string, options: KnowledgeRequestOptions = {}): Promise<KnowledgeResponseSample[]> {
  return query<KnowledgeResponseSample[]>(["samples", endpoint], options.signal);
}
