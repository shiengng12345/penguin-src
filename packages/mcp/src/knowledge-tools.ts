import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  KnowledgeStore,
  compareBranches,
  exploreGraph,
  getNodeDetail,
  indexStatus,
  compactIndexStatus,
  buildStatusPanel,
  resolveSymbolMatches,
  search,
  searchSource,
  searchPath,
  searchRegex,
  searchKnowledge,
  searchKnowledgeAsync,
  graphQuery,
  getSourceHit,
  buildDomainClaims,
  buildDomainFlow,
  WhyCardStore,
  OntologyStore,
  MemoryStore,
  exportKnowledgeArtifact,
  importKnowledgeArtifact,
  AuditStore,
  ExternalSourceStore,
  syncMarkdownDirectory,
  syncRemoteSource,
  architecture,
  buildExplorePack,
  buildContextPack,
  buildFlow,
  affectedByFiles,
  communities,
  deadCode,
  listTags,
  listIndexedFiles,
  listFileSymbols,
  graphNeighborhood,
  repoGraph,
  serviceGraph,
  serviceContext,
  servicePath,
  listCoverageDebt,
  timeline,
  endpointSamples,
  resolveEndpointId,
  SavedQueryStore,
  writeSavedQueryMarkdown,
  reflectSearchFeedback,
  packageDependencies,
  dependencyPath,
  type RevisionContext,
  type GraphMode,
  parseWorkspaceRoots,
  assertWorkspacePath,
  canonicalPathForCheck,
  resolveMutationTargetRoot,
  MutationTargetResolutionError,
  syncPostgresSchema,
  type PostgresSchemaClient,
  SCHEMA_VERSION,
  resolveQueryScope,
  ScopeResolutionError,
  resolveTarget,
  readResetManifest,
  HmacOperationCursorCodec,
  resolveLocalCursorSecret,
  type ResolvedQueryScope,
  buildOnboardingDocument,
  reconcileCorpus,
  type CorpusCanonicalProjection,
} from "@penguin/knowledge-core";
import { CAPABILITIES, capabilityHash, listMcpRegistrations, CAPABILITY_ALIASES, canonicalInputSchema, knowledgeErrorEnvelope, normalizeKnowledgeError, scopeResolutionErrorEnvelope, KnowledgeContractError, validateSemanticStatusResponse, type EndpointProvenanceKind } from "@penguin/knowledge-contracts";
import { analyzeRepository } from "./repository-analysis.js";
import { preflightSearchTerms } from "./log-investigation-preflight.js";
import { readConfig } from "./config.js";
import { INITIAL_SLS_TARGETS, mergeSlsTargets } from "./sls-target-registry.js";
import { planLogInvestigation, continueLogInvestigation } from "./log-investigation.js";
import { correlateInvestigationEvidence } from "./log-evidence-correlator.js";
import { FileInvestigationStateStore } from "./log-investigation-store.js";
import type { InvestigationRequest, InvestigationContinuation } from "./log-investigation-contract.js";
import type { KnowledgeEvidencePreflight } from "./log-evidence-correlator.js";
import { ApiDocPreviewStore, buildApiDocumentation, collectDocumentationFacts, renderApiDocumentation, validateDocumentationRequest } from "@penguin/api-doc-generator";
import * as notes from "@penguin/knowledge-indexer/notes";
import { createKnowledgeApiDocAdapter, currentApiDocRevisionIds } from "../../knowledge-cli/src/api-doc-knowledge-adapter.js";

const execFileAsync = promisify(execFile);
const OPERATION_CURSOR_CODEC = new HmacOperationCursorCodec(resolveLocalCursorSecret());

export interface KnowledgeToolOptions {
  /** Host-owned adapter; credentials are resolved outside the MCP process. */
  postgresSchemaClient?: PostgresSchemaClient;
  /** Worker-owned store; avoids reopening the DB inside an isolated query. */
  store?: KnowledgeStore;
  /** True when this long-lived MCP process is serving an older runtime. */
  restartRequired?: boolean;
  /** Test/host-owned note root; defaults to the owner-local Penguin notes directory. */
  notesDir?: string;
  /** Host-owned CLI bridge; injectable so idempotent wake behavior is testable. */
  invokeLocalCli?: (args: string[]) => Promise<Record<string, unknown>>;
}

async function invokeLocalCli(args: string[]): Promise<Record<string, unknown>> {
  const configured = process.env.PENGUIN_KNOWLEDGE_CLI;
  const candidate = configured ?? join(process.cwd(), "packages", "knowledge-cli", "dist", "bin.js");
  const commandArgs = configured ? args : [candidate, ...args];
  const command = configured ? candidate : process.execPath;
  try {
    const result = await execFileAsync(command, commandArgs, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: process.env });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as { message?: string; stdout?: string; stderr?: string; code?: string | number };
    return { ok: false, error: "LOCAL_CLI_FAILED", code: e.code ?? "unknown", message: e.message ?? String(error), stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// Penguin Knowledge MCP 6-pack handlers (§8.1). This module imports
// knowledge-core (→ native better-sqlite3), so the MCP server dynamically
// imports it ONLY on the first knowledge-tool call — never at server load —
// keeping the release-bundled server self-contained. Tool DEFINITIONS live in
// knowledge-tool-defs.ts (no core import).

// Open the shared knowledge store for one call (null if not yet initialized).
// allowSchemaMutation:false: the MCP server is a long-lived (per-call, but
// repeatedly re-opened over the process lifetime) reader -- it must never
// silently run DDL/migrations against the on-disk DB just because a tool
// call happened to be the first one after a build upgrade (Phase 1B Task 9,
// mirroring the CLI's READ_VERBS gate and the resident query-server). This
// only blocks the migration branch in openDatabase() (schema.ts): reads and
// writes against an already-current schema are unaffected, so mutating MCP
// tools keep working normally once the DB has been migrated by any other
// write path (`penguin index`, etc.).
//
// Deliberate asymmetry: MCP write tools (knowledge_index, knowledge_rebuild,
// knowledge_repository_register, ...) share this SAME gated handle, so an MCP
// client cannot self-heal a stale schema by calling knowledge_index -- unlike
// the resident query-server's `knowledge.cli` bridge, which opens write verbs
// through a separate mutation-allowed handle (runCli's own openStore()) and
// so CAN self-heal via that path. This is intentional, not an oversight: the
// SCHEMA_OUTDATED error message points the caller at the CLI (`penguin
// index`) for remediation. If MCP-side self-healing is ever wanted, give
// index/rebuild/register their own mutation-allowed store open instead of
// loosening this one.
function openKnowledgeStore(): KnowledgeStore | null {
  const dbPath = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
  const ledgerPath = process.env.PENGUIN_KNOWLEDGE_LEDGER ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl");
  if (!existsSync(dbPath)) return null;
  return KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
}

// Entry point the server dynamically imports: open store → dispatch → close.
function slsRegistry() {
  return mergeSlsTargets(INITIAL_SLS_TARGETS, readConfig().sls?.targets ?? []);
}

function investigationStateStore(): FileInvestigationStateStore {
  return new FileInvestigationStateStore(join(homedir(), ".penguin", "knowledge", "investigations"));
}

const TOOL_CAPABILITY_ALIASES: Record<string, string> = { ...CAPABILITY_ALIASES };
// Capture workspace roots once at server startup; requests cannot widen them.
const MCP_WORKSPACE_ROOTS = parseWorkspaceRoots(process.env.PENGUIN_MCP_WORKSPACE_ROOTS, process.cwd());

/** Registration may only widen into owner-configured roots. Existing exact
 * repository roots are already owner-approved state, so fresh MCP processes
 * may safely index/rebuild them even when their launch cwd is elsewhere. */
function assertOwnerMutationRoot(
  store: KnowledgeStore,
  action: "register" | "index" | "rebuild",
  requestedRoot: string,
  expectedCanonicalRoot?: string,
  requireCanonicalInput = false,
): string {
  const canonical = canonicalPathForCheck(requestedRoot);
  const registeredRoots = (store.db.prepare("SELECT root_path AS rootPath FROM repos").all() as Array<{ rootPath: string }>).map((repo) => repo.rootPath);
  if (action !== "register") {
    const registered = registeredRoots
      .some((root) => canonicalPathForCheck(root) === canonical);
    if (registered) {
      return resolveMutationTargetRoot({ action, requestedRoot, ownerApprovedRoots: registeredRoots, expectedCanonicalRoot, requireCanonicalInput }).rootPath;
    }
  }
  return resolveMutationTargetRoot({ action, requestedRoot, ownerApprovedRoots: MCP_WORKSPACE_ROOTS, expectedCanonicalRoot, requireCanonicalInput }).rootPath;
}

/** Map generated canonical tool names to the legacy handler names that already
 * implement the same core operation.  The public MCP name remains canonical;
 * this table only prevents duplicate business logic during the migration. */
const CANONICAL_HANDLER_ALIASES: Record<string, string> = {
  knowledge_capabilities: "knowledge_capabilities",
  knowledge_package_dependencies: "package_dependencies",
  knowledge_dependency_path: "dependency_path",
  knowledge_analyze_repository: "analyze_repository",
  knowledge_graph_query: "knowledge_graph_query",
  knowledge_get_hit: "knowledge_get_hit",
  knowledge_search: "knowledge_search",
  knowledge_get_node: "get_node",
  knowledge_graph_query_alias: "knowledge_graph_query",
  knowledge_explore: "knowledge_explore",
  knowledge_compare_branches: "compare_branches",
  knowledge_note_write: "write_note",
  knowledge_link_create: "suggest_links",
  knowledge_index_status: "index_status",
  knowledge_status_panel: "status_panel",
  knowledge_set_master_branch: "set_master_branch",
  knowledge_suggestion_list: "list_suggestions",
  knowledge_suggestion_accept: "accept_suggestion",
  knowledge_suggestion_reject: "reject_suggestion",
  knowledge_architecture: "get_architecture",
  knowledge_communities: "find_communities",
  knowledge_dead_code: "find_dead_code",
  knowledge_coverage: "knowledge_coverage",
  knowledge_endpoints: "knowledge_endpoints",
  knowledge_why_get: "knowledge_why_get",
  knowledge_domain_explain: "knowledge_domain_explain",
  knowledge_onboarding_generate: "knowledge_onboarding_generate",
  knowledge_ontology_list: "knowledge_ontology_list",
  knowledge_ontology_upsert: "knowledge_ontology_upsert",
  knowledge_ontology_link: "knowledge_ontology_link",
  knowledge_artifact_export: "knowledge_artifact_export",
  knowledge_artifact_import: "knowledge_artifact_import",
  knowledge_source_register: "knowledge_source_register",
  knowledge_source_list: "knowledge_source_list",
  knowledge_source_remove: "knowledge_source_remove",
  knowledge_source_sync: "knowledge_source_sync",
  knowledge_memory_remember: "knowledge_memory_remember",
  knowledge_memory_recall: "knowledge_memory_recall",
  knowledge_memory_forget: "knowledge_memory_forget",
  knowledge_memory_improve: "knowledge_memory_improve",
  knowledge_evidence_note_list: "list_evidence_notes",
  knowledge_evidence_status_set: "set_evidence_status",
  knowledge_evidence_doctor: "evidence_doctor",
  knowledge_evidence_repair: "repair_evidence",
  knowledge_api_doc_generate: "api_doc_generate",
  knowledge_api_doc_list: "api_doc_list",
  knowledge_api_doc_show: "api_doc_show",
  knowledge_api_doc_diff: "api_doc_diff",
  knowledge_evidence_investigation_plan: "plan_log_investigation",
  knowledge_evidence_investigation_capture: "capture_log_investigation",
};

function handlerName(name: string): string {
  return CANONICAL_HANDLER_ALIASES[name] ?? name;
}

function capabilityForTool(name: string): string | undefined {
  const alias = TOOL_CAPABILITY_ALIASES[name];
  if (alias) return alias;
  const canonical = CAPABILITIES.find((capability) => capability.id.replaceAll(".", "_") === name);
  if (canonical) return canonical.id;
  const candidate = name.startsWith("knowledge_") ? name.replace(/^knowledge_/, "knowledge.").replaceAll("_", ".") : undefined;
  return CAPABILITIES.find((capability) => capability.id === candidate)?.id;
}

function mutationInputDigest(input: Record<string, unknown>): string {
  const copy = { ...input };
  delete copy.confirmation_token;
  return createHash("sha256").update(JSON.stringify(copy, Object.keys(copy).sort())).digest("hex");
}

function mutationScopeHash(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ repo: input.repo ?? input.repo_id ?? null, branch: input.branch ?? null, snapshot: input.snapshot_id ?? null })).digest("hex");
}

export function createMutationConfirmationToken(capabilityId: string, input: Record<string, unknown>, options: { secret?: string; expiresAt?: number } = {}): string {
  const secret = options.secret ?? process.env.PENGUIN_MCP_CONFIRMATION_SECRET;
  if (!secret) throw new Error("MUTATION_CONFIRMATION_SECRET_REQUIRED");
  const payload = { capabilityId, scopeHash: mutationScopeHash(input), inputDigest: mutationInputDigest(input), expiresAt: options.expiresAt ?? Date.now() + 5 * 60_000 };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function mutationGuard(name: string, input: Record<string, unknown>): { capabilityId: string } | { error: string; capabilityId: string } | null {
  const capabilityId = capabilityForTool(name);
  const capability = CAPABILITIES.find((item) => item.id === capabilityId);
  if (!capability?.mutating) return null;
  if (process.env.PENGUIN_MCP_MUTATIONS !== "enabled") return { error: "MUTATION_DISABLED", capabilityId };
  const secret = process.env.PENGUIN_MCP_CONFIRMATION_SECRET;
  const token = typeof input.confirmation_token === "string" ? input.confirmation_token : "";
  if (!secret || !token) return { error: "CONFIRMATION_TOKEN_REQUIRED", capabilityId };
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return { error: "CONFIRMATION_TOKEN_INVALID", capabilityId };
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  let validSignature = false;
  try { validSignature = timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { validSignature = false; }
  if (!validSignature) return { error: "CONFIRMATION_TOKEN_INVALID", capabilityId };
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { capabilityId?: string; scopeHash?: string; inputDigest?: string; expiresAt?: number };
    if (payload.capabilityId !== capabilityId || payload.scopeHash !== mutationScopeHash(input) || payload.inputDigest !== mutationInputDigest(input) || !Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) return { error: "CONFIRMATION_TOKEN_INVALID", capabilityId };
  } catch { return { error: "CONFIRMATION_TOKEN_INVALID", capabilityId }; }
  return { capabilityId };
}


const evidenceNotesDir = () => join(homedir(), ".penguin", "knowledge", "notes");

function knowledgePreflight(store: KnowledgeStore | null): KnowledgeEvidencePreflight | undefined {
  if (!store) return undefined;
  return {
    async collect({ request, targets }) {
      const terms = preflightSearchTerms(request);
      const facts: Array<{ factId: string; source: "knowledge" | "wiki"; statement: string; targetIds: string[]; evidenceIds: string[] }> = [];
      const evidence: Array<{ evidenceId: string; source: "knowledge" | "wiki"; locator: string }> = [];
      const seen = new Set<string>();
      for (const term of terms) {
        const hits = search(store, term, { includeSensitive: true, limit: 8 });
        for (const hit of hits) {
          const key = `${hit.nodeId ?? hit.identityKey}:${term}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const evidenceId = `knowledge_${Buffer.from(key).toString("base64url").slice(0, 48)}`;
          const source = hit.nodeType === "note" ? "wiki" : "knowledge";
          const targetIds = targets.filter((target) => `${target.targetId} ${target.environment} ${target.project} ${target.logstore}`.toLowerCase().includes(term.toLowerCase())).map((target) => target.targetId);
          facts.push({ factId: `fact_${evidenceId}`, source, statement: `Knowledge match for “${term}”: ${hit.title}${hit.filePath ? ` (${hit.filePath})` : ""}.`, targetIds, evidenceIds: [evidenceId] });
          evidence.push({ evidenceId, source, locator: hit.nodeId ?? hit.identityKey });
        }
      }
      const gaps = facts.length === 0
        ? [{ gapId: "gap_knowledge_no_match", code: "knowledge_no_match", message: "No matching Knowledge/Wiki facts were found during preflight; this is not proof that the code or incident does not exist.", targetIds: targets.map((target) => target.targetId), evidenceIds: [] }]
        : [];
      return { collectedAt: new Date().toISOString(), facts, gaps, targetHints: [], evidence };
    },
  };
}


/** Tools whose advertised inputSchema is known to list EVERY argument their
 * handler reads. Only these reject unknown arguments.
 *
 * Not every tool qualifies: knowledge_search, for instance, deliberately accepts
 * flat MCP aliases (include_sensitive and friends) that its canonical capability
 * schema does not list, so enforcing there would reject working callers rather
 * than catch mistakes. Adding a tool here means having checked its handler reads
 * nothing outside its schema — the schema becomes a promise, not a hint. */
// Declared here rather than read from KNOWLEDGE_TOOL_DEFS: that module is kept
// out of this one's import graph on purpose (it must not pull in core). A parity
// test asserts these lists match the advertised schemas, so drift fails loudly
// instead of quietly rejecting a real argument.
export const STRICT_TOOL_ARGUMENTS: Record<string, string[]> = {
  get_architecture: ["repo", "branch", "commit_sha", "snapshot_id", "allow_fallback"],
  find_dead_code: ["limit", "cursor", "repo", "path", "branch", "compact"],
  knowledge_dead_code: ["limit", "cursor", "repo", "path", "branch", "compact"],
  knowledge_note_list: ["repo", "branch", "commit_sha", "snapshot_id", "allow_fallback", "limit", "cursor"],
};

/** Reject arguments a tool does not accept, instead of ignoring them.
 *
 * The schemas already said `additionalProperties: false`, but nothing enforced
 * it: an agent passing `repo` to a tool with no repo filter got a whole-graph
 * answer that looked scoped. A silently dropped filter is worse than an error,
 * because the caller believes the scope it asked for. */
export function unsupportedArguments(
  toolName: string,
  input: Record<string, unknown>,
): { error: { code: string; message: string; retryable: boolean; unsupported: string[]; accepted: string[] } } | null {
  const accepted = STRICT_TOOL_ARGUMENTS[toolName];
  if (!accepted) return null;
  const unsupported = Object.keys(input).filter((key) => !accepted.includes(key));
  if (unsupported.length === 0) return null;
  return {
    error: {
      ...knowledgeErrorEnvelope(
        "UNSUPPORTED_FILTER",
        `${toolName} does not accept ${unsupported.map((key) => `\`${key}\``).join(", ")}`
        + ` — it would have been ignored, and the answer would have looked scoped when it was not.`
        + ` Accepted: ${accepted.join(", ")}.`,
        { unsupported, accepted, remediation: `remove unsupported arguments: ${unsupported.join(", ")}` },
      ),
      unsupported,
      accepted,
    },
  };
}

/** 什么时候用：MCP tool result 离开 handler 前使用，确保字符串错误也满足统一 error envelope。 */
function normalizeMcpToolResult(result: unknown): unknown {
  const isRecord = result !== null && typeof result === "object" && !Array.isArray(result);
  if (!isRecord || !("error" in result)) return result;

  const record = result as Record<string, unknown>;
  const rawError = record.error;
  const rawMessage = typeof record.message === "string" && record.message ? record.message : undefined;
  if (typeof rawError === "string") {
    const codeMatch = /^([A-Z][A-Z0-9_]*)(?::|$)/u.exec(rawError);
    const code = codeMatch?.[1] ?? "INTERNAL";
    const message = rawMessage ?? rawError;
    return { ...record, error: knowledgeErrorEnvelope(code, message) };
  }

  return { ...record, error: normalizeKnowledgeError(rawError) };
}

function withReadCapabilityTiming(name: string, result: unknown, startedAt: number): unknown {
  const capabilityId = capabilityForTool(name);
  const capability = CAPABILITIES.find((candidate) => candidate.id === capabilityId);
  if (!capability || capability.mutating || result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const prior = record.timingsMs && typeof record.timingsMs === "object" && !Array.isArray(record.timingsMs)
    ? record.timingsMs as Record<string, unknown>
    : {};
  return {
    ...record,
    timingsMs: {
      ...prior,
      total: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    },
  };
}

/** Reconcile through the canonical CLI process so MCP, CLI, and Tauri share
 * the same independent oracle and persisted-count implementation. */
async function runMcpCorpusReconciliation(
  store: KnowledgeStore,
  rawRequest: unknown,
  invoke: (args: string[]) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const request = inputRecord(rawRequest);
  const requestedRoot = String(request.root_path ?? request.path ?? "").trim();
  let corpusRoot: string | null = null;
  if (requestedRoot) {
    try {
      corpusRoot = assertWorkspacePath(requestedRoot, MCP_WORKSPACE_ROOTS, "MCP reconciliation root");
    } catch (error) {
      return { error: knowledgeErrorEnvelope(
        "ROOT_PATH_OUT_OF_SCOPE",
        String((error as Error).message ?? error),
        { rootPath: requestedRoot },
        false,
        "choose a corpus root inside the configured MCP workspace roots",
      ) };
    }
  }
  const roots = corpusRoot
    ? [corpusRoot]
    : (store.db.prepare("SELECT root_path AS rootPath FROM repos ORDER BY root_path").all() as Array<{ rootPath: string }>)
      .map((row) => canonicalPathForCheck(row.rootPath));
  if (roots.length === 0) {
    return {
      mode: "reconciliation",
      rootPath: corpusRoot,
      strict: request.strict === true,
      checkedAt: new Date().toISOString(),
      ok: false,
      repositories: [],
      remediation: "register and index at least one repository, then retry reconciliation",
    };
  }
  const reports: Array<Record<string, unknown>> = [];
  for (const root of [...new Set(roots)]) {
    const result = await invoke(["corpus", "reconcile", root, "--json"]);
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    let payload: unknown = null;
    try { payload = stdout ? JSON.parse(stdout) : null; } catch { /* handled below */ }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const candidate = payload as Record<string, unknown>;
      if (Array.isArray(candidate.repositories)) reports.push(...candidate.repositories as Array<Record<string, unknown>>);
      else reports.push(candidate);
      continue;
    }
    reports.push({
      rootPath: root,
      status: "incomplete",
      gaps: ["canonical_cli:unavailable"],
      error: typeof result.message === "string" ? result.message : "canonical reconciliation CLI returned no JSON report",
    });
  }
  const failed = reports.filter((report) => report.status !== "passed");
  const ok = failed.length === 0 && reports.length > 0;
  return {
    mode: "reconciliation",
    rootPath: corpusRoot,
    strict: request.strict === true,
    checkedAt: new Date().toISOString(),
    ok,
    repositories: reports,
    transport: { name: "mcp", implementation: "canonical-cli-reconcile", sourceTruth: "independent-checkout-oracle" },
    remediation: ok
      ? null
      : "run penguin corpus reconcile --root <path> --json and inspect each repository's sourceOracle, gaps, and revision scope",
  };
}

/** 什么时候用：MCP server 调用 knowledge tool 时使用，统一返回结果和未捕获异常。 */
export async function runKnowledgeTool(name: string, a: Record<string, unknown>, options: KnowledgeToolOptions = {}): Promise<unknown> {
  const startedAt = performance.now();
  try {
    const result = await runKnowledgeToolUnsafe(name, a, options);
    return withReadCapabilityTiming(name, normalizeMcpToolResult(result), startedAt);
  } catch (error) {
    return withReadCapabilityTiming(name, { error: normalizeKnowledgeError(error) }, startedAt);
  }
}

/** 什么时候用：执行既有 knowledge tool 路由时使用，保留成功路径和资源清理逻辑。 */
async function runKnowledgeToolUnsafe(name: string, a: Record<string, unknown>, options: KnowledgeToolOptions = {}): Promise<unknown> {
  const mutation = mutationGuard(name, a);
  if (mutation && "error" in mutation) return mutation;
  let store: KnowledgeStore | null;
  try {
    store = options.store ?? openKnowledgeStore();
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "SCHEMA_OUTDATED") {
      return { error: { code: "SCHEMA_OUTDATED", message: error.message, retryable: false } };
    }
    throw error;
  }
  try {
    const routedName = handlerName(name);
    let workingTreeStatus: Record<string, unknown> | undefined;
    if (store && routedName === "knowledge_search" && typeof a.query === "string" && a.query.trim()) {
      const prepared = await prepareMcpWorkingTreeSearch(a, store);
      if (prepared && "error" in prepared) return { error: prepared.error };
      if (prepared) {
        a = prepared.input;
        workingTreeStatus = prepared.status;
      }
    }
    if (["knowledge_api_doc_bind", "knowledge_api_doc_unbind", "knowledge_api_doc_draft", "knowledge_api_doc_sync", "knowledge_api_doc_repair"].includes(routedName)) {
      const sub = routedName.replace("knowledge_api_doc_", "");
      const positional = typeof a.document_key === "string" ? [a.document_key] : typeof a.preview_id === "string" ? [a.preview_id] : [];
      const flags = Object.entries(a).flatMap(([key, value]) => key === "confirmation_token" || key === "document_key" || key === "preview_id" ? [] : [`--${key.replaceAll("_", "-")}`, String(value)]);
      return invokeLocalCli(["api-doc", sub, ...positional, ...flags]);
    }
    if (routedName === "knowledge_agent_hook_invoke") {
      const event = String(a.event ?? "session-start");
      return invokeLocalCli(["hook", event]);
    }
    if (routedName === "knowledge_cli_install") return invokeLocalCli(["install"]);
    if (routedName === "knowledge_watch") {
      const rootPath = String(a.root_path ?? a.path ?? "").trim();
      if (!rootPath) return { error: "ROOT_PATH_REQUIRED" };
      try { assertWorkspacePath(rootPath, MCP_WORKSPACE_ROOTS, "MCP watch root"); }
      catch (error) { return { error: (error as Error).message }; }
      return invokeLocalCli(["watch", rootPath]);
    }
    if (routedName === "knowledge_capabilities") {
      const requestedContract = typeof a.contract_version === "string" ? a.contract_version : undefined;
      if (requestedContract && requestedContract.split(".")[0] !== "2") {
        return { error: knowledgeErrorEnvelope(
          "CAPABILITY_MISMATCH",
          `unsupported knowledge contract major ${requestedContract}; upgrade Penguin or request contract 2`,
          { requestedContract, remediation: "upgrade Penguin or request contract 2" },
        ) };
      }
      const registrations = listMcpRegistrations();
      if (a.compact === true) {
        return {
          schemaVersion: String(SCHEMA_VERSION),
          contractVersion: "2",
          buildId: process.env.PENGUIN_BUILD_ID ?? "local",
          capabilityHash: capabilityHash(CAPABILITIES),
          modelHash: process.env.PENGUIN_MODEL_HASH ?? "unknown",
          compact: true,
          capabilityCount: CAPABILITIES.length,
          schemaReferences: {
            input: "{capabilityId}.input.v2",
            output: "{capabilityId}.output.v2",
          },
          registrations: registrations.map(({ capabilityId, status }) => ({ capabilityId, status })),
        };
      }
      return {
        schemaVersion: String(SCHEMA_VERSION),
        contractVersion: "2",
        buildId: process.env.PENGUIN_BUILD_ID ?? "local",
        capabilityHash: capabilityHash(CAPABILITIES),
        modelHash: process.env.PENGUIN_MODEL_HASH ?? "unknown",
        capabilities: CAPABILITIES,
        registrations,
      };
    }
    if (routedName === "knowledge_doctor" && a.reconcile != null) {
      if (!store) return { error: "knowledge not initialized — open Penguin; the owner may register a repository with knowledge_repository_register" };
      return runMcpCorpusReconciliation(store, a.reconcile, options.invokeLocalCli ?? invokeLocalCli);
    }
    if (routedName === "api_doc_generate") {
      if (!store) return { error: "knowledge not initialized — open Penguin; the owner may register a repository with knowledge_repository_register" };
      const validation = validateDocumentationRequest(a.request);
      if (!validation.ok) return { status: "invalid_request", errors: validation.errors };
      const collected = await collectDocumentationFacts(validation.request!, createKnowledgeApiDocAdapter(store));
      if (collected.status !== "collected") return collected;
      const generated = await buildApiDocumentation({ bundle: collected.bundle });
      if (generated.status !== "generated") return generated;
      const rendered = renderApiDocumentation(generated.ir);
      const root = process.env.PENGUIN_API_DOC_PREVIEWS ?? join(homedir(), ".penguin", "knowledge", "api-docs", "previews");
      const saved = new ApiDocPreviewStore(root).save({ ir: generated.ir, rendered, mode: validation.request!.mode === "sync" ? "preview" : validation.request!.mode });
      return { ...saved, preview: { documentKey: generated.ir.documentKey, coverage: generated.ir.coverage, gaps: generated.ir.gaps.length } };
    }
    if (routedName === "list_sls_targets") return slsRegistry().filter((target) => a.include_disabled === true || target.enabled);
    if (routedName === "plan_log_investigation") {
      const request = { ...a, timeRange: a.time_range, targetIds: a.target_ids, slsUrls: a.sls_urls } as unknown as InvestigationRequest;
      return await planLogInvestigation(request, { registry: slsRegistry(), stateStore: investigationStateStore(), knowledgePreflight: knowledgePreflight(store), now: () => new Date(), delay: async (ms, signal) => { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }); } });
    }
    if (routedName === "capture_log_investigation") {
      if (!store) return { error: "knowledge not initialized — open Penguin before capturing evidence" };
      const result = await continueLogInvestigation(a.continuation as InvestigationContinuation, (a.results ?? []) as never[], { registry: slsRegistry(), stateStore: investigationStateStore(), now: () => new Date(), delay: async () => {} });
      if (result.status === "awaiting_sls_execution") return result;
      const packet = await correlateInvestigationEvidence(result, result.knowledgeSeed ?? { collectedAt: new Date().toISOString(), facts: [], gaps: [], targetHints: [], evidence: [] });
      const captures = packet.targetPackets.map((targetPacket) => notes.upsertEvidenceNote({ store: store!, notesDir: join(homedir(), ".penguin", "knowledge", "notes"), packet: targetPacket as never }));
      const failedCapture = captures.some((capture: { searchable: boolean; status: string }) => capture.status === "failed" || !capture.searchable);
      if (!failedCapture) investigationStateStore().remove(result.sessionId);
      return { ...result, captures, packet: { investigationId: packet.investigationId, targetIds: packet.targetPackets.map((item) => item.target.targetId) } };
    }
    if (["list_evidence_notes", "set_evidence_status", "evidence_doctor", "repair_evidence"].includes(routedName)) {
      if (!store) return { error: "knowledge not initialized — open Penguin or capture evidence after owner setup" };
      if (routedName === "list_evidence_notes") {
        const rows = notes.publicEvidenceSummaries(notes.listEvidenceNotes({ store, notesDir: evidenceNotesDir(), targetId: a.target_id as string | undefined, status: a.status as never, limit: Number(a.limit ?? 100) }));
        return affectedByFiles.listEnvelope(store, rows, { candidateCount: null, totalIsExact: false, gaps: rows.flatMap((row: { provenanceGaps: string[] }) => row.provenanceGaps) });
      }
      if (routedName === "set_evidence_status") return notes.setEvidenceStatus({ store, notesDir: evidenceNotesDir(), slug: String(a.slug ?? ""), to: String(a.status ?? "") as never, from: a.from as never });
      if (routedName === "evidence_doctor") return notes.evidenceDoctor({ store, notesDir: evidenceNotesDir() });
      return notes.repairEvidence({ store, notesDir: evidenceNotesDir() });
    }
    if (["knowledge_note_create", "knowledge_note_append", "knowledge_note_list", "knowledge_note_reindex", "knowledge_incident_create", "knowledge_evidence_target_list", "knowledge_evidence_note_get", "knowledge_evidence_validate"].includes(routedName)) {
      const notesDir = evidenceNotesDir();
      if (routedName === "knowledge_note_create") return notes.createNote({ store, notesDir, title: String(a.title ?? ""), body: String(a.body ?? a.text ?? ""), frontmatter: { type: String(a.type ?? "note") } });
      if (routedName === "knowledge_incident_create") return notes.createIncident({ store, notesDir, title: String(a.title ?? ""), fields: (a.fields ?? {}) as never });
      if (routedName === "knowledge_note_append") return notes.appendNote({ store, notesDir, slug: String(a.slug ?? a.id ?? ""), text: String(a.text ?? a.body ?? "") });
      if (routedName === "knowledge_note_list") {
        const input = normalizeMcpPageInput(a, routedName);
        if (input.error) return { error: input.error };
        const unsupported = unsupportedArguments(routedName, input);
        if (unsupported) return unsupported;
        const revision = resolveMcpRevision(store, input);
        if (revision.error) return { error: revision.error };
        const repoId = revision.context?.repoId;
        const limit = Math.min(500, Math.max(1, Number(input.limit ?? 100)));
        const cursorScope = `${repoId ?? "*"}|${revision.context?.branchId ?? "*"}`;
        const cursorRevision = revision.context?.snapshotId ?? null;
        let afterPath: string | undefined;
        if (typeof input.cursor === "string") {
          try {
            const decoded = OPERATION_CURSOR_CODEC.decode(input.cursor, { operation: "notelist", scope: cursorScope, revision: cursorRevision });
            afterPath = decoded.lastKey;
          } catch (error) {
            const code = String((error as Error).message ?? error);
            return { error: knowledgeErrorEnvelope(
              code === "CURSOR_OPERATION_MISMATCH" || code === "CURSOR_SCOPE_MISMATCH" || code === "CURSOR_STALE" || code === "CURSOR_EXPIRED" || code === "CURSOR_REQUEST_MISMATCH" ? code : "CURSOR_INVALID",
              "invalid or mismatched note-list cursor",
              { remediation: "restart note pagination from the first page using the same repo and branch scope" },
            ) };
          }
        }
        const scopedRows = notes.listPublicNotes({ store, notesDir: options.notesDir ?? notesDir })
          .filter((row: { scope: { repoId: string | null } }) => !repoId || row.scope.repoId === repoId)
          .sort((left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path));
        const remainingRows = afterPath ? scopedRows.filter((row: { path: string }) => row.path > afterPath!) : scopedRows;
        const rows = remainingRows.slice(0, limit);
        const truncated = remainingRows.length > rows.length;
        const nextCursor = truncated && rows.length
          ? OPERATION_CURSOR_CODEC.encode({ schemaVersion: "1", contractVersion: "2", operation: "notelist", scope: cursorScope, orderingKey: "path", lastKey: rows.at(-1)!.path, revision: cursorRevision, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
          : null;
        return {
          ...affectedByFiles.listEnvelope(store, rows, {
            repoId,
            branchId: revision.context?.branchId,
            revision: revision.context,
            scope: repoId ? { repo: revision.scope?.locator.repoName ?? String(input.repo), branch: revision.context?.branch ?? null } : { repo: null, branch: null },
            candidateCount: scopedRows.length,
            remainingCount: remainingRows.length - rows.length,
            totalIsExact: true,
            truncated,
            nextCursor,
            completeness: truncated ? "partial" : "complete",
            gaps: rows.flatMap((row: { provenanceGaps: string[] }) => row.provenanceGaps),
          }),
          ...scopeEnvelopeFields(revision.scope),
        };
      }
      if (routedName === "knowledge_note_reindex") {
        const report = notes.reindexNotesDir({ store, notesDir });
        const dangling = notes.listDanglingNoteLinks(store, Number(a.limit ?? 100));
        return { ...report, danglingLinks: dangling };
      }
      if (routedName === "knowledge_evidence_target_list") {
        const rows = notes.publicEvidenceSummaries(notes.listEvidenceNotes({ store, notesDir, limit: Number(a.limit ?? 100) }));
        const items = [...new Map(rows.map((row: { targetId: string; environment: string; region: string; project: string; logstore: string; source: unknown; timestamp: string | null; sensitivity: string; permission: unknown; provenanceGaps: string[] }) => [row.targetId, { targetId: row.targetId, environment: row.environment, region: row.region, project: row.project, logstore: row.logstore, source: row.source, timestamp: row.timestamp, scope: { targetId: row.targetId || null, environment: row.environment || null }, revision: null, sensitivity: row.sensitivity, permission: row.permission, provenanceGaps: row.provenanceGaps }])).values()];
        return affectedByFiles.listEnvelope(store, items, { candidateCount: null, totalIsExact: false, gaps: items.flatMap((item: { provenanceGaps: string[] }) => item.provenanceGaps) });
      }
      if (routedName === "knowledge_evidence_note_get") {
        const slug = String(a.slug ?? a.id ?? "");
        const summaries = notes.listEvidenceNotes({ store, notesDir, limit: 100 }).filter((row: { slug: string }) => row.slug === slug);
        return summaries.length === 0 ? { error: "EVIDENCE_NOTE_NOT_FOUND", slug } : { ...summaries[0], markdown: notes.readNote(notesDir, slug) };
      }
      return { ...notes.evidenceDoctor({ store, notesDir }), status: "validated" };
    }
    if (["knowledge_repository_register", "knowledge_index", "knowledge_rebuild", "knowledge_repository_remove"].includes(routedName)) {
      if (routedName !== "knowledge_repository_remove" && a.confirmed !== true) {
        return { error: knowledgeErrorEnvelope(
          "CONFIRMATION_REQUIRED",
          `${routedName} changes the owner-local index and requires confirmed=true`,
          { capability: routedName, remediation: "retry the same MCP operation with confirmed=true after owner approval" },
        ) };
      }
      const indexer = await import("@penguin/knowledge-indexer");
      if (routedName === "knowledge_repository_remove") {
        const repoId = store.resolveRepoIds(String(a.repo ?? a.repo_id ?? ""))[0];
        if (!repoId) return { error: "REPOSITORY_NOT_FOUND" };
        store.removeRepo(repoId);
        return { ok: true, repoId };
      }
      const rootPath = String(a.root_path ?? a.path ?? "").trim();
      if (!rootPath) return { error: "ROOT_PATH_REQUIRED" };
      const mutationAction = routedName === "knowledge_repository_register"
        ? "register"
        : routedName === "knowledge_rebuild" ? "rebuild" : "index";
      const validatedRoot = assertOwnerMutationRoot(store, mutationAction, rootPath);
      const confirmedRoot = assertOwnerMutationRoot(store, mutationAction, rootPath, validatedRoot, true);
      const report = await indexer.indexRepo({
        store,
        rootPath: confirmedRoot,
        mode: routedName === "knowledge_rebuild" ? "rebuild" : "incremental",
      });
      const worker = await invokeLocalCli(["semantic", "wake", "--json"]);
      return { ...report, semanticWorker: worker };
    }
    if (routedName === "knowledge_snapshot_materialize") {
      const repoSelector = String(a.repo ?? a.repo_id ?? "");
      const repoId = store.resolveRepoIds(repoSelector)[0];
      if (!repoId) return { error: "REPOSITORY_NOT_FOUND" };
      const repo = store.db.prepare("SELECT root_path AS rootPath FROM repos WHERE id=?").get(repoId) as { rootPath: string } | undefined;
      if (!repo) return { error: "REPOSITORY_NOT_FOUND" };
      const branch = typeof a.branch === "string" ? a.branch : undefined;
      const commitSha = typeof a.commit_sha === "string" ? a.commit_sha : undefined;
      if (!!branch === !!commitSha) return { error: "EXACTLY_ONE_REVISION_REQUIRED" };
      const indexer = await import("@penguin/knowledge-indexer");
      return indexer.indexRevision({ store, rootPath: repo.rootPath, repoId, revision: branch ? { branch } : { commitSha: commitSha! }, parserVersion: indexer.KNOWLEDGE_PARSER_VERSION, resolverVersion: indexer.KNOWLEDGE_RESOLVER_VERSION, coordinator: new indexer.RevisionIndexCoordinator() });
    }
    const nestedSearchOptions = inputRecord(a.options);
    if (store && routedName === "knowledge_search" && (
      a.semantic === "fallback"
      || a.semantic === "blend"
      || nestedSearchOptions.semantic === "fallback"
      || nestedSearchOptions.semantic === "blend"
    )) {
      return attachMcpWorkingTreeStatus(await runSemanticSearchAdapter(a, store), workingTreeStatus);
    }
    return attachMcpWorkingTreeStatus(handleKnowledgeTool(routedName, a, store, options), workingTreeStatus);
  } finally {
    if (store) {
      try {
        new AuditStore(store).append({ capabilityId: name, actorId: "mcp", scopeHash: createHash("sha256").update(JSON.stringify({ repo: a.repo ?? null, branch: a.branch ?? null, snapshot_id: a.snapshot_id ?? null })).digest("hex"), input: a, resultCode: "completed_or_returned" });
      } catch { /* audit must not turn a read result into a transport failure */ }
    }
    if (!options.store) store?.close();
  }
}

async function runSemanticSearchAdapter(input: Record<string, unknown>, store: KnowledgeStore): Promise<unknown> {
  const normalized = normalizeMcpSearchInput(input);
  const scope = inputRecord(normalized.scope);
  const repoSelector = typeof normalized.repo === "string" ? normalized.repo : undefined;
  const resolvedRepoIds = repoSelector ? store.resolveRepoIds(repoSelector) : [];
  if (repoSelector && resolvedRepoIds.length === 0) return { error: knowledgeErrorEnvelope("REPOSITORY_NOT_FOUND", `no indexed repo matches ${repoSelector}`, { repo: repoSelector }) };
  if (resolvedRepoIds.length > 1) return { error: knowledgeErrorEnvelope("AMBIGUOUS_REPOSITORY", `repository selector matches multiple indexed repositories: ${repoSelector}`, { repo: repoSelector, candidates: repositoryCandidates(store, resolvedRepoIds) }, false, "retry with one repository id or canonical root from details.candidates") };
  const repoId = resolvedRepoIds[0];
  const revisions = Array.isArray(scope.revisions)
    ? scope.revisions
    : typeof normalized.snapshot_id === "string"
      ? [{ ...(repoId ? { repoId } : {}), snapshotId: normalized.snapshot_id }]
      : repoId ? [{ repoId }] : undefined;
  return searchKnowledgeAsync({
    query: String(normalized.query ?? ""),
    mode: (normalized.mode as "auto" | "exact" | "phrase" | "substring" | "path" | "regex" | "lexical" | "structural" | undefined) ?? "auto",
    scope: { ...(revisions ? { revisions } : {}), ...(Array.isArray(scope.paths) ? { paths: scope.paths.map(String) } : {}) },
    options: {
      semantic: normalized.semantic === "fallback" || normalized.semantic === "blend" ? normalized.semantic : "blend",
      caseSensitive: normalized.case_sensitive !== false,
      wholeWord: normalized.whole_word === true,
      includeGenerated: normalized.include_generated === true,
      includeVendor: normalized.include_vendor === true,
      includeExcludedMetadata: normalized.include_excluded_metadata === true,
      compact: normalized.compact !== false,
      explain: normalized.explain === true,
    },
    page: { limit: Number.isInteger(normalized.limit) ? normalized.limit as number : 20, ...(typeof normalized.cursor === "string" ? { cursor: normalized.cursor } : {}) },
  }, { store });
}

function repositoryCandidates(store: KnowledgeStore, repoIds: string[]): Array<{ repoId: string; name: string; rootPath: string }> {
  const get = store.db.prepare("SELECT id AS repoId,name,root_path AS rootPath FROM repos WHERE id=?");
  return repoIds
    .map((repoId) => get.get(repoId) as { repoId: string; name: string; rootPath: string } | undefined)
    .filter((candidate): candidate is { repoId: string; name: string; rootPath: string } => candidate != null);
}

function isSensitive(store: KnowledgeStore, nodeId: string): boolean {
  const row = store.db
    .prepare("SELECT sensitive, mcp_access FROM notes_index WHERE node_id=?")
    .get(nodeId) as { sensitive: number; mcp_access: string } | undefined;
  return !!row && (row.sensitive === 1 || row.mcp_access === "denied");
}

// Converts a ScopeResolutionError into the MCP tool-error shape used
// elsewhere in this module. BRANCH_NOT_INDEXED is the deliberate blocker
// (§Task 6 CLI parity): the message keeps the `penguin index` hint from
// query-scope.ts and additionally points the caller at `allow_fallback`,
// since MCP clients read structured errors and retry rather than reading a
// CLI --flag hint.
function scopeResolutionErrorPayload(error: ScopeResolutionError): Record<string, unknown> {
  return scopeResolutionErrorEnvelope(error);
}

// The shared scope chokepoint (§Phase 1a trust plumbing, Task 8). Delegates
// to resolveQueryScope instead of duplicating repo/branch/commit resolution.
// MCP has no meaningful cwd, so repo inference is explicit-arg → inferred
// symbol repo only; git introspection then happens at that repo's
// registered root_path inside resolveQueryScope itself. When no repoId can
// be determined at all, ScopeResolutionError("REPO_REQUIRED") is swallowed
// back into `{}` (unscoped) — the same pragmatic fallback every knowledge
// tool used before this change whenever no repo/branch/commit/snapshot was
// given. Every other ScopeResolutionError (notably BRANCH_NOT_INDEXED, the
// deliberate blocker when the repo IS known) is converted to a tool error.
function resolveMcpRevision(
  store: KnowledgeStore,
  args: Record<string, unknown>,
  inferredRepoId?: string | null,
): { context?: RevisionContext; scope?: ResolvedQueryScope; error?: Record<string, unknown> } {
  const repoSelector = typeof args.repo === "string" ? args.repo : inferredRepoId ?? undefined;
  let repoId: string | undefined;
  if (repoSelector) {
    const repoIds = store.resolveRepoIds(String(repoSelector));
    if (repoIds.length === 0) return { error: knowledgeErrorEnvelope("SCOPE_NOT_FOUND", `repository not found: ${repoSelector}`, { repo: repoSelector, remediation: "specify a registered repository" }) };
    if (repoIds.length > 1) return { error: knowledgeErrorEnvelope("AMBIGUOUS_REPOSITORY", `repository is ambiguous: ${repoSelector}`, { repo: repoSelector, candidates: repositoryCandidates(store, repoIds) }, false, "retry with one repository id or canonical root from details.candidates") };
    repoId = repoIds[0];
  }
  try {
    const scope = resolveQueryScope(store, {
      ...(repoId ? { repoId } : {}),
      branch: typeof args.branch === "string" ? args.branch : undefined,
      commitSha: typeof args.commit_sha === "string" ? args.commit_sha : undefined,
      snapshotId: typeof args.snapshot_id === "string" ? args.snapshot_id : undefined,
      allowFallback: args.allow_fallback === true,
    });
    return { context: scope.revision, scope };
  } catch (error) {
    if (error instanceof ScopeResolutionError) {
      if (error.code === "REPO_REQUIRED") return {};
      return { error: scopeResolutionErrorPayload(error) };
    }
    throw error;
  }
}

// Attaches the scope envelope (locator/alignment/warnings) to a scoped
// tool's result object, matching the CLI's `emit()` envelope (Task 6).
function scopeEnvelopeFields(scope?: ResolvedQueryScope): Record<string, unknown> {
  return scope ? { locator: scope.locator, alignment: scope.alignment, warnings: scope.warnings } : {};
}

function canonicalCorpusForScope(
  store: KnowledgeStore,
  repoId?: string | null,
  branchId?: string | null,
  snapshotId?: string | null,
): CorpusCanonicalProjection | null {
  if (!repoId || !branchId) return null;
  return reconcileCorpus({
    store,
    scope: { repoId, branchId, snapshotId },
  }).canonical;
}

function nodeRepoId(store: KnowledgeStore, target: string): string | null {
  try { return resolveTarget(store, target).repoId; }
  catch { return null; }
}

function targetResolutionError(error: unknown, target?: string): Record<string, unknown> {
  const normalized = normalizeKnowledgeError(error, "INVALID_TARGET");
  const endpointLike = typeof target === "string" && /^(?:grpc|http|https|ws|event|endpoint)(?::\/\/|::|:)/iu.test(target);
  const code = normalized.code === "TARGET_NOT_FOUND"
    ? endpointLike ? "ENDPOINT_NOT_FOUND" : "NODE_NOT_FOUND"
    : normalized.code;
  return { error: knowledgeErrorEnvelope(
    code,
    normalized.message,
    normalized.details,
    normalized.retryable,
    endpointLike
      ? "call knowledge_endpoints with the same repository/revision scope and use a freshly returned endpoint nodeId"
      : normalized.remediation ?? "call knowledge_search with the same repository/revision scope and use a freshly returned stable nodeId",
  ) };
}

// get_node / explore_graph / compare_branches are pre-canonical low-level
// tools: unlike the nine named scoped tools (knowledge_context/flow/
// affected/path/locate/explore/callers/callees/impact), their input schemas
// don't carry allow_fallback (explore_graph's is even additionalProperties:
// false) and their results don't carry locator/alignment/warnings. Routing
// their symbol-inferred repoId through resolveQueryScope unconditionally
// would make them newly hard-fail with BRANCH_NOT_INDEXED on calls that
// previously always answered, with no schema-documented escape hatch. Full
// scope unification for these three is deferred until their schemas/results
// are upgraded (tracked in the plan ledger); until then, only resolve via
// the inferred repo when the caller supplied an explicit selector
// (repo/branch/commit_sha/snapshot_id) — preserving the pre-Task-8
// selector-gated behavior for the no-selector case.
function hasExplicitScopeSelector(args: Record<string, unknown>): boolean {
  return ["repo", "branch", "commit_sha", "snapshot_id"].some((key) => args[key] != null);
}

function legacyGatedRepoId(store: KnowledgeStore, args: Record<string, unknown>, target: string): string | null {
  return hasExplicitScopeSelector(args) ? nodeRepoId(store, target) : null;
}

function inputRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function withHonestByteStats(
  normalPayload: Record<string, unknown>,
  presentedPayload: Record<string, unknown>,
  compact: boolean,
): Record<string, unknown> {
  const normal = {
    ...normalPayload,
    compact: false,
    stats: { rawBytesEstimate: 0, sentBytesEstimate: 0, compactRatio: 1 },
  };
  for (let pass = 0; pass < 10; pass += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(normal), "utf8");
    if (normal.stats.rawBytesEstimate === bytes && normal.stats.sentBytesEstimate === bytes) break;
    normal.stats.rawBytesEstimate = bytes;
    normal.stats.sentBytesEstimate = bytes;
  }
  if (!compact) return normal;
  const response = {
    ...presentedPayload,
    compact: true,
    stats: { rawBytesEstimate: normal.stats.sentBytesEstimate, sentBytesEstimate: 0, compactRatio: 1 },
  };
  for (let pass = 0; pass < 10; pass += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
    const ratio = normal.stats.sentBytesEstimate === 0
      ? 1
      : Math.round((bytes / normal.stats.sentBytesEstimate) * 1_000) / 1_000;
    if (response.stats.sentBytesEstimate === bytes && response.stats.compactRatio === ratio) break;
    response.stats.sentBytesEstimate = bytes;
    response.stats.compactRatio = ratio;
  }
  return response;
}

/**
 * Canonical knowledge.search exposes nested `scope`, `options`, and `page`
 * objects, while the original MCP handler accepted their fields at the top
 * level. Normalize both shapes at this adapter boundary so canonical clients
 * cannot silently lose revision isolation or pagination.
 */
function normalizeMcpSearchInput(input: Record<string, unknown>): Record<string, unknown> {
  const scope = inputRecord(input.scope);
  const options = inputRecord(input.options);
  const page = inputRecord(input.page);
  const firstRevision = Array.isArray(scope.revisions)
    ? inputRecord(scope.revisions[0])
    : {};
  const nestedRepo = scope.repo ?? scope.repoId ?? firstRevision.repoId ?? firstRevision.repoName;
  const nestedSnapshot = scope.snapshot_id ?? scope.snapshotId ?? firstRevision.snapshotId;
  const nestedBranch = scope.branch ?? firstRevision.branch;
  const nestedCommit = scope.commit_sha ?? scope.commitSha ?? firstRevision.commitSha;
  return {
    ...input,
    ...(input.repo === undefined && typeof nestedRepo === "string" ? { repo: nestedRepo } : {}),
    ...(input.snapshot_id === undefined && typeof nestedSnapshot === "string" ? { snapshot_id: nestedSnapshot } : {}),
    ...(input.branch === undefined && typeof nestedBranch === "string" ? { branch: nestedBranch } : {}),
    ...(input.commit_sha === undefined && typeof nestedCommit === "string" ? { commit_sha: nestedCommit } : {}),
    ...(input.limit === undefined && Number.isInteger(page.limit) ? { limit: page.limit } : {}),
    ...(input.cursor === undefined && typeof page.cursor === "string" ? { cursor: page.cursor } : {}),
    ...(input.case_sensitive === undefined && typeof options.caseSensitive === "boolean" ? { case_sensitive: options.caseSensitive } : {}),
    ...(input.whole_word === undefined && typeof options.wholeWord === "boolean" ? { whole_word: options.wholeWord } : {}),
    ...(input.include_generated === undefined && typeof options.includeGenerated === "boolean" ? { include_generated: options.includeGenerated } : {}),
    ...(input.include_vendor === undefined && typeof options.includeVendor === "boolean" ? { include_vendor: options.includeVendor } : {}),
    ...(input.include_excluded_metadata === undefined && typeof options.includeExcludedMetadata === "boolean" ? { include_excluded_metadata: options.includeExcludedMetadata } : {}),
    ...(input.semantic === undefined && typeof options.semantic === "string" ? { semantic: options.semantic } : {}),
    ...(input.compact === undefined && typeof options.compact === "boolean" ? { compact: options.compact } : {}),
    ...(input.explain === undefined && typeof options.explain === "boolean" ? { explain: options.explain } : {}),
  };
}

interface PreparedMcpWorkingTreeSearch {
  input: Record<string, unknown>;
  status: Record<string, unknown>;
}

/**
 * MCP has no meaningful process cwd, so a working-tree request must identify
 * one registered repository and then build the overlay from that repository's
 * real checkout. The resulting request is rewritten to an immutable snapshot
 * id before it reaches the synchronous search handler; every MCP search lane
 * therefore reads the same overlay and never silently falls back to HEAD.
 */
async function prepareMcpWorkingTreeSearch(
  input: Record<string, unknown>,
  store: KnowledgeStore,
): Promise<PreparedMcpWorkingTreeSearch | { error: Record<string, unknown> } | null> {
  const normalized = normalizeMcpSearchInput(input);
  const scope = inputRecord(normalized.scope);
  const revisions = Array.isArray(scope.revisions) ? scope.revisions.map(inputRecord) : [];
  const workingRevisions = revisions.filter((revision) => revision.workingTree === true);
  const topLevelRequested = normalized.workingTree === true || normalized.working_tree === true;
  if (workingRevisions.length === 0 && !topLevelRequested) return null;
  if (workingRevisions.length > 1 || (workingRevisions.length > 0 && (topLevelRequested || revisions.length !== 1))) {
    return {
      error: knowledgeErrorEnvelope(
        "INVALID_ARGUMENT",
        "working-tree search accepts exactly one workingTree revision and no other revision selector",
        { remediation: "use scope.revisions: [{repoId, workingTree: true}]" },
      ),
    };
  }

  const selector = workingRevisions[0] ?? {};
  const repoSelector = typeof selector.repoId === "string"
    ? selector.repoId
    : typeof selector.repoName === "string"
      ? selector.repoName
      : typeof normalized.repo === "string"
        ? normalized.repo
        : undefined;
  let repoIds = repoSelector ? store.resolveRepoIds(repoSelector) : [];
  if (!repoSelector) {
    // A unique exact symbol is safe as an inference; a free-text query that
    // matches multiple repositories must ask the agent to choose explicitly.
    try {
      const match = resolveSymbolMatches(store, String(normalized.query ?? ""));
      if (match.kind === "unique") {
        const repoId = store.getNode(match.nodeId)?.repo_id;
        if (repoId) repoIds = [repoId];
      }
    } catch { /* the handler will return its normal query error */ }
  }
  if (repoIds.length === 0) {
    return {
      error: knowledgeErrorEnvelope(
        "REPOSITORY_REQUIRED",
        "working-tree search requires an indexed repository selector",
        { remediation: "pass scope.revisions: [{repoId, workingTree: true}] or repo", query: normalized.query ?? null },
      ),
    };
  }
  if (repoIds.length > 1) {
    return {
      error: knowledgeErrorEnvelope(
        "AMBIGUOUS_REPOSITORY",
        `repository selector matches multiple indexed repositories: ${repoSelector}`,
        { repo: repoSelector, candidates: repositoryCandidates(store, repoIds) },
        false,
        "retry with one repository id or canonical root from details.candidates",
      ),
    };
  }
  const repoId = repoIds[0];
  const repo = store.db.prepare("SELECT root_path AS rootPath FROM repos WHERE id=?").get(repoId) as { rootPath: string } | undefined;
  if (!repo) {
    return { error: knowledgeErrorEnvelope("REPOSITORY_NOT_FOUND", `indexed repository not found: ${repoId}`, { repo: repoId }) };
  }

  try {
    const indexer = await import("@penguin/knowledge-indexer");
    const overlay = await indexer.prepareWorkingTreeOverlay({
      store,
      rootPath: repo.rootPath,
      repoId,
      parserVersion: indexer.KNOWLEDGE_PARSER_VERSION,
      resolverVersion: indexer.KNOWLEDGE_RESOLVER_VERSION,
    });
    const rewritten: Record<string, unknown> = {
      ...normalized,
      repo: repoId,
      snapshot_id: overlay.context.snapshotId,
      scope: { ...scope, revisions: [{ repoId, snapshotId: overlay.context.snapshotId }] },
    };
    delete rewritten.workingTree;
    delete rewritten.working_tree;
    return { input: rewritten, status: overlay.status as unknown as Record<string, unknown> };
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "WORKING_TREE_OVERLAY_FAILED";
    const retryable = code === "WORKING_TREE_OVERLAY_BUSY";
    const remediation = code === "WORKING_TREE_BASE_BEHIND"
      ? "run penguin index for the committed HEAD, then retry working-tree search"
      : code === "BRANCH_NOT_INDEXED" || code === "WORKING_TREE_BASE_NOT_READY"
        ? "run penguin index for this repository, then retry working-tree search"
        : "retry the working-tree search after the active overlay job finishes";
    return {
      error: knowledgeErrorEnvelope(code, String((error as Error).message ?? error), { repo: repoId, remediation }, retryable, remediation),
    };
  }
}

function attachMcpWorkingTreeStatus(result: unknown, status: Record<string, unknown> | undefined): unknown {
  if (!status || !result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), workingTree: status };
}

/**
 * Canonical paged capabilities put pagination under `page`, while the
 * legacy MCP adapters read `limit` and `cursor` at the top level. Normalize
 * both forms before dispatch so a valid canonical request cannot silently
 * fall back to the default first page.
 */
function normalizeMcpPageInput(input: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const page = inputRecord(input.page);
  const hasTopLimit = Object.prototype.hasOwnProperty.call(input, "limit");
  const hasNestedLimit = Object.prototype.hasOwnProperty.call(page, "limit");
  const nestedLimit = page.limit;
  const nestedCursor = typeof page.cursor === "string" ? page.cursor : undefined;
  const topLimit = input.limit;
  const topCursor = input.cursor;
  const validLimit = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 500;
  if ((hasTopLimit && !validLimit(topLimit)) || (hasNestedLimit && !validLimit(nestedLimit))) {
    const message = toolName === "knowledge_endpoints"
      ? "endpoint page limit must be an integer between 1 and 500"
      : "page limit must be an integer between 1 and 500";
    return { ...input, error: knowledgeErrorEnvelope("INVALID_ARGUMENT", message, { remediation: "provide an integer page limit between 1 and 500" }) };
  }
  if (hasTopLimit && hasNestedLimit && topLimit !== nestedLimit) {
    return { ...input, error: knowledgeErrorEnvelope("INVALID_ARGUMENT", "top-level limit conflicts with page.limit", { remediation: "provide pagination in page or top-level fields, not both" }) };
  }
  if (topCursor !== undefined && nestedCursor !== undefined && topCursor !== nestedCursor) {
    return { ...input, error: knowledgeErrorEnvelope("INVALID_ARGUMENT", "top-level cursor conflicts with page.cursor", { remediation: "provide pagination in page or top-level fields, not both" }) };
  }
  const normalized = { ...input };
  delete normalized.page;
  return {
    ...normalized,
    ...(!hasTopLimit && hasNestedLimit ? { limit: nestedLimit } : {}),
    ...(topCursor === undefined && nestedCursor !== undefined ? { cursor: nestedCursor } : {}),
  };
}

// Dispatch a knowledge tool call. `store` may be null when the knowledge DB
// hasn't been created yet (no `penguin init`) — read tools then return a hint
// instead of crashing (§9).
/** 什么时候用：需要直接调用同步 MCP handler 测试或路由时使用，返回统一错误 envelope。 */
export function handleKnowledgeTool(
  name: string,
  a: Record<string, unknown>,
  store: KnowledgeStore | null,
  options: KnowledgeToolOptions = {},
): unknown {
  try {
    return normalizeMcpToolResult(handleKnowledgeToolUnsafe(name, a, store, options));
  } catch (error) {
    return { error: normalizeKnowledgeError(error) };
  }
}

/** 什么时候用：执行同步 MCP tool 分支时使用，保留原有业务结果供外层归一化。 */
function handleKnowledgeToolUnsafe(
  name: string,
  a: Record<string, unknown>,
  store: KnowledgeStore | null,
  options: KnowledgeToolOptions = {},
): unknown {
  name = handlerName(name);
  if (name === "knowledge_endpoints" || name === "knowledge_file_symbols" || name === "find_dead_code" || name === "knowledge_dead_code" || name === "knowledge_note_list") {
    a = normalizeMcpPageInput(a, name);
    if (a.error) return { error: a.error };
  }
  // Before anything else: an argument the capability does not accept would
  // otherwise be dropped, and the caller would trust a scope it never got.
  const unsupported = unsupportedArguments(name, a);
  if (unsupported) return unsupported;
  if (name === "api_doc_list" || name === "api_doc_show" || name === "api_doc_diff") {
    const root = process.env.PENGUIN_API_DOC_PREVIEWS ?? join(homedir(), ".penguin", "knowledge", "api-docs", "previews");
    const previews = new ApiDocPreviewStore(root);
    try {
      if (name === "api_doc_list") return previews.listEnvelope({ documentKey: a.document_key as string | undefined, query: a.query as string | undefined, currentRevisionIds: store ? currentApiDocRevisionIds(store) : undefined });
      if (name === "api_doc_show") {
        const preview = previews.load(String(a.preview_id ?? ""), { currentRevisionIds: store ? currentApiDocRevisionIds(store) : undefined });
        const format = a.format ?? "json";
        const staleMessage = preview.manifest.evidenceState === "stale"
          ? `API_DOC_PREVIEW_STALE | preview_revision_stale | preview revisions: ${preview.manifest.revisionIds.join(", ") || "unknown"} | current revisions: ${preview.manifest.currentRevisionIds?.join(", ") || "unknown"}`
          : null;
        return format === "markdown"
          ? { format, content: staleMessage ? `> [!WARNING]\n> ${staleMessage}\n\n${preview.rendered.markdown}` : preview.rendered.markdown, manifest: preview.manifest }
          : format === "xml"
            ? { format, content: staleMessage ? `<p><strong>${staleMessage}</strong></p>\n${preview.rendered.larkXml}` : preview.rendered.larkXml, manifest: preview.manifest }
            : preview;
      }
      return previews.diff(String(a.left_preview_id ?? ""), String(a.right_preview_id ?? ""));
    } catch (error) { return { error: "api_doc_preview_error", message: String((error as Error).message ?? error) }; }
  }
  if (name === "knowledge_capabilities") {
    const requestedContract = typeof a.contract_version === "string" ? a.contract_version : undefined;
    if (requestedContract && requestedContract.split(".")[0] !== "2") {
      return { error: knowledgeErrorEnvelope(
        "CAPABILITY_MISMATCH",
        `unsupported knowledge contract major ${requestedContract}; upgrade Penguin or request contract 2`,
        { requestedContract, remediation: "upgrade Penguin or request contract 2" },
      ) };
    }
    const registrations = listMcpRegistrations();
    if (a.compact === true) {
      return {
        schemaVersion: String(SCHEMA_VERSION),
        contractVersion: "2",
        buildId: process.env.PENGUIN_BUILD_ID ?? "local",
        capabilityHash: capabilityHash(CAPABILITIES),
        modelHash: process.env.PENGUIN_MODEL_HASH ?? "unknown",
        compact: true,
        capabilityCount: CAPABILITIES.length,
        schemaReferences: {
          input: "{capabilityId}.input.v2",
          output: "{capabilityId}.output.v2",
        },
        registrations: registrations.map(({ capabilityId, status }) => ({ capabilityId, status })),
      };
    }
    return { schemaVersion: String(SCHEMA_VERSION), contractVersion: "2", buildId: process.env.PENGUIN_BUILD_ID ?? "local", capabilityHash: capabilityHash(CAPABILITIES), modelHash: process.env.PENGUIN_MODEL_HASH ?? "unknown", capabilities: CAPABILITIES, registrations };
  }
  if (!store) {
    return { error: "knowledge not initialized — open Penguin; the owner may register a repository with knowledge_repository_register" };
  }
  switch (name) {
    case "knowledge_endpoints": {
      const repoSelector = typeof a.repo === "string" ? a.repo : undefined;
      let repoId = repoSelector ? store.resolveRepoIds(repoSelector)[0] : undefined;
      if (repoSelector && !repoId) return { error: knowledgeErrorEnvelope("REPOSITORY_NOT_FOUND", `no indexed repo matches ${repoSelector}`, { repo: repoSelector, remediation: "call index_status({\"mode\":\"detailed\"}) and choose an indexed repository" }) };
      const hasExplicitRevisionSelector = typeof a.branch === "string"
        || typeof a.commit_sha === "string"
        || typeof a.snapshot_id === "string";
      const resolved: ReturnType<typeof resolveMcpRevision> = hasExplicitRevisionSelector
        ? resolveMcpRevision(store, a, repoId)
        : {};
      if (resolved.error) return { error: resolved.error };
      repoId = resolved.context?.repoId ?? repoId;
      const requestedProtocol = typeof a.protocol === "string" ? a.protocol : undefined;
      const protocol = requestedProtocol === "rest" ? "http" : requestedProtocol;
      const service = typeof a.service === "string" ? a.service : undefined;
      const method = typeof a.method === "string" ? a.method : undefined;
      const path = typeof a.path === "string" ? a.path : undefined;
      const handledOnly = a.handled_only === true;
      const provenanceKind = typeof a.provenance_kind === "string"
        ? a.provenance_kind as EndpointProvenanceKind
        : undefined;
      const limit = a.limit === undefined ? 100 : a.limit;
      const cursor = typeof a.cursor === "string" ? a.cursor : undefined;
      let endpointPage;
      try {
        endpointPage = affectedByFiles.endpointInventoryPage(store, {
          repoId,
          protocol,
          service,
          method,
          path,
          handledOnly,
          provenanceKind,
          ...(resolved.context ? { scope: {
            repoId: resolved.context.repoId,
            branchId: resolved.context.branchId ?? null,
            revisionId: resolved.context.snapshotId,
            revision: resolved.context,
          } } : {}),
          limit: limit as number,
          cursor,
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === "INVALID_ARGUMENT") {
          throw new KnowledgeContractError(
            "INVALID_ARGUMENT",
            String((error as Error).message),
            { limit },
            false,
          );
        }
        const errorMsg = String((error as Error).message ?? error);
        const code = errorMsg === "CURSOR_OPERATION_MISMATCH" || errorMsg === "CURSOR_SCOPE_MISMATCH" || errorMsg === "CURSOR_STALE" || errorMsg === "CURSOR_EXPIRED" || errorMsg === "CURSOR_REQUEST_MISMATCH"
          ? errorMsg
          : "CURSOR_INVALID";
        return { error: knowledgeErrorEnvelope(
          code,
          errorMsg.includes("malformed") ? errorMsg : "invalid or mismatched endpoint cursor",
          { cursor },
          false,
          "restart endpoint pagination with the same repository, revision, protocol, and limit",
        ) };
      }
      const endpointScope = endpointPage.scope;
      const canonicalReconciliation = canonicalCorpusForScope(
        store,
        repoId,
        endpointScope.branchId,
        endpointScope.revision?.snapshotId ?? null,
      );
      const coverageTotals = repoId
        ? store.db.prepare("SELECT COUNT(*) AS discovered,SUM(coverage_status='excluded') AS excluded,SUM(coverage_status='failed') AS failed FROM coverage_records WHERE repo_id=?").get(repoId) as { discovered: number; excluded: number | null; failed: number | null }
        : null;
      const endpointCoverageComplete = Boolean(repoId && Number(coverageTotals?.discovered ?? 0) > 0 && Number(coverageTotals?.excluded ?? 0) === 0 && Number(coverageTotals?.failed ?? 0) === 0);
      const rawEndpointItems = endpointPage.items.map((row) => ({
        ...row,
        missingHandlerReason: row.handlers.length ? null : endpointCoverageComplete
          ? "no_active_handles_edge"
          : "handler_not_proven_absent: endpoint coverage or generated wiring may be incomplete",
      }));
      const endpointItems = rawEndpointItems.map((row) => {
        const firstHopsDuplicateHandlers = row.firstHopRelations.length === row.handlers.length
          && row.firstHopRelations.every((relation, index) => relation === row.handlers[index]);
        if (!firstHopsDuplicateHandlers) return row;
        const { firstHopRelations: _duplicate, ...withoutDuplicateAlias } = row;
        return withoutDuplicateAlias;
      });
      const envelopeOptions = {
        repoId,
        branchId: endpointScope.branchId ?? undefined,
        revision: endpointScope.revision ?? undefined,
        scope: { ...endpointScope },
        candidateCount: endpointPage.candidateCount,
        remainingCount: endpointPage.remainingCount,
        totalIsExact: endpointPage.totalIsExact,
        truncated: endpointPage.truncated,
        nextCursor: endpointPage.nextCursor,
        completeness: endpointCoverageComplete ? "lower_bound" : "partial",
        proofStatus: endpointItems.length ? "candidate" : "not_proven",
        gaps: endpointCoverageComplete ? [] : ["endpoint_coverage_incomplete"],
      } as const;
      const rawResponse = affectedByFiles.listEnvelope(store, rawEndpointItems, envelopeOptions);
      const response = affectedByFiles.listEnvelope(store, endpointItems, envelopeOptions);
      Object.assign(rawResponse, { publication: endpointPage.publication, reconciliation: canonicalReconciliation, ...scopeEnvelopeFields(resolved.scope) });
      Object.assign(response, { publication: endpointPage.publication, reconciliation: canonicalReconciliation, ...scopeEnvelopeFields(resolved.scope) });
      if (a.compact !== true) return withHonestByteStats(rawResponse, rawResponse, false);

      const { evidence: _evidenceMirror, ...compactResponse } = response;
      return withHonestByteStats(rawResponse, compactResponse, true);
    }
    case "knowledge_coverage": {
      const result = listCoverageDebt(store, {
        ...(typeof a.repo === "string" ? { repo: a.repo } : {}),
        ...(typeof a.branch === "string" ? { branchId: a.branch } : {}),
        ...(typeof a.snapshot_id === "string" ? { revisionId: a.snapshot_id } : {}),
        ...(typeof a.path === "string" ? { path: a.path } : {}),
        ...(typeof a.kind === "string" ? { kind: a.kind as "excluded" | "failed" | "stale" | "unresolved" } : {}),
        ...(Number.isInteger(a.limit) ? { limit: a.limit as number } : {}),
        ...(typeof a.cursor === "string" ? { cursor: a.cursor } : {}),
      });
      const coverageScope = result.scope as { repoId?: unknown; branchId?: unknown; revisionId?: unknown } | null;
      return {
        ...result,
        reconciliation: canonicalCorpusForScope(
          store,
          typeof coverageScope?.repoId === "string" ? coverageScope.repoId : null,
          typeof coverageScope?.branchId === "string" ? coverageScope.branchId : null,
          typeof coverageScope?.revisionId === "string" ? coverageScope.revisionId : null,
        ),
      };
    }
    case "knowledge_why_get":
      return new WhyCardStore(store).get(String(a.id ?? a.card_id ?? "")) ?? { error: "WHY_NOT_FOUND" };
    case "knowledge_domain_explain":
      return { target: String(a.target ?? ""), claims: buildDomainClaims(store, { ...(typeof a.repo === "string" ? { repoId: store.resolveRepoIds(a.repo)[0] } : {}), ...(typeof a.persona === "string" ? { persona: a.persona as "frontend" | "backend" | "qa" | "sre" | "pm/security" } : {}) }), flow: buildDomainFlow(store, { ...(typeof a.repo === "string" ? { repoId: store.resolveRepoIds(a.repo)[0] } : {}), ...(typeof a.target === "string" && a.target ? { target: a.target } : {}) }), gaps: ["domain claims are candidates and require human review"] };
    case "knowledge_onboarding_generate":
      return buildOnboardingDocument(store, typeof a.repo === "string" ? store.resolveRepoIds(a.repo)[0] : undefined);
    case "knowledge_ontology_list":
      return new OntologyStore(store).list();
    case "knowledge_ontology_upsert": {
      const result = new OntologyStore(store).upsert({ id: String(a.id ?? ""), canonicalName: String(a.canonical_name ?? a.canonicalName ?? ""), aliases: Array.isArray(a.aliases) ? a.aliases.map(String) : [], scope: (a.scope ?? {}) as { workspaceId?: string; repoIds?: string[] }, type: String(a.type ?? "entity") as "actor" | "capability" | "entity" | "state" | "event" | "system", definition: String(a.definition ?? ""), evidence: Array.isArray(a.evidence) ? a.evidence : [], status: String(a.status ?? "draft") as "draft" | "reviewed" | "verified" | "stale" });
      if (result.status === "ambiguous") return { ok: false, code: "ONTOLOGY_ALIAS_AMBIGUOUS", candidates: result.candidates };
      return { ok: true, id: String(a.id ?? ""), resolution: result };
    }
    case "knowledge_ontology_link":
      new OntologyStore(store).link(String(a.from_id ?? ""), String(a.to_id ?? ""), String(a.relation ?? "related_to"), Array.isArray(a.evidence) ? a.evidence : []);
      return { ok: true };
    case "knowledge_artifact_export": {
      const baseDatabase = typeof a.base_database_base64 === "string" ? Buffer.from(a.base_database_base64, "base64") : undefined;
      const artifact = exportKnowledgeArtifact(store, { includeSource: a.include_source === true, includeNotes: a.include_notes === true, includeEvidence: a.include_evidence === true, ...(baseDatabase ? { baseDatabase } : {}) });
      return { manifest: artifact.manifest, artifactBase64: Buffer.from(artifact.bytes).toString("base64") };
    }
    case "knowledge_artifact_import": {
      const raw = typeof a.artifact_base64 === "string" ? Buffer.from(a.artifact_base64, "base64") : null;
      if (!raw) return { error: "ARTIFACT_INPUT_REQUIRED" };
      const baseDatabase = typeof a.base_database_base64 === "string" ? Buffer.from(a.base_database_base64, "base64") : undefined;
      const imported = importKnowledgeArtifact(raw, baseDatabase ? { expectedCapabilityHash: typeof a.capability_hash === "string" ? a.capability_hash : undefined, baseDatabase } : (typeof a.capability_hash === "string" ? a.capability_hash : undefined));
      return { ok: true, imported: false, manifest: imported.manifest, databaseBytes: imported.database.byteLength, note: "validated; explicit database restore is required" };
    }
    case "knowledge_api_doc_export": {
      const root = process.env.PENGUIN_API_DOC_PREVIEWS ?? join(homedir(), ".penguin", "knowledge", "api-docs", "previews");
      try {
        const preview = new ApiDocPreviewStore(root).load(String(a.preview_id ?? a.id ?? ""), { currentRevisionIds: currentApiDocRevisionIds(store) });
        const format = String(a.format ?? "markdown");
        return { format, content: format === "xml" ? preview.rendered.larkXml : format === "json" ? preview.ir : preview.rendered.markdown, manifest: preview.manifest };
      } catch (error) { return { error: "API_DOC_PREVIEW_NOT_FOUND", message: String((error as Error).message ?? error) }; }
    }
    case "knowledge_source_register":
      return new ExternalSourceStore(store).register({ type: String(a.type ?? "url") as import("@penguin/knowledge-core").ExternalKnowledgeSourceType, location: String(a.location ?? ""), config: (a.config ?? {}) as Record<string, unknown>, allowHosts: Array.isArray(a.allow_hosts) ? a.allow_hosts.map(String) : [] });
    case "knowledge_source_list":
      return new ExternalSourceStore(store).list();
    case "knowledge_source_remove":
      if (a.confirmed !== true) return { error: "CONFIRMATION_REQUIRED", id: String(a.id ?? "") };
      new ExternalSourceStore(store).remove(String(a.id ?? "")); return { ok: true, id: String(a.id ?? "") };
    case "knowledge_source_sync": {
      const sources = new ExternalSourceStore(store);
      const source = sources.list().find((candidate) => candidate.id === String(a.id ?? ""));
      if (!source) return { error: "EXTERNAL_SOURCE_NOT_FOUND" };
      if (source.type === "url" || source.type === "openapi") {
        return syncRemoteSource(store, source.id).catch((error) => ({ error: String((error as Error).message ?? error) }));
      }
      if (source.type === "postgres_schema") {
        return syncPostgresSchema(store, source.id, options.postgresSchemaClient).catch((error) => ({ error: String((error as Error).message ?? error), sourceType: source.type, credentialEntryId: source.config.credentialEntryId ?? null }));
      }
      if (source.type !== "markdown_directory") return { error: "EXTERNAL_SYNC_REQUIRES_EXPLICIT_EXECUTION", sourceType: source.type, note: "network fetching is never implicit; provide a bounded sync job" };
      try { return syncMarkdownDirectory(store, source.id); }
      catch (error) { return { error: String((error as Error).message ?? error) }; }
    }
    case "knowledge_memory_remember":
      if (!a.repo_id && !a.workspace_id && a.global !== true) return { error: "MEMORY_SCOPE_REQUIRED", note: "provide repo_id, workspace_id, or global=true" };
      return new MemoryStore(store).remember({
        class: String(a.class ?? "project") as import("@penguin/knowledge-core").MemoryClass,
        scope: { ...(a.repo_id ? { repoId: String(a.repo_id) } : {}), ...(a.workspace_id ? { workspaceId: String(a.workspace_id) } : {}) },
        subject: String(a.subject ?? ""), body: String(a.body ?? ""), source: Array.isArray(a.source) ? a.source : [{ type: "mcp" }], confidence: Number(a.confidence ?? 1), retention: String(a.retention ?? "normal") as "ephemeral" | "normal" | "indefinite",
      });
    case "knowledge_memory_recall":
      return new MemoryStore(store).recall({ ...(a.repo_id ? { repoId: String(a.repo_id) } : {}), ...(a.workspace_id ? { workspaceId: String(a.workspace_id) } : {}) });
    case "knowledge_memory_forget":
      if (a.confirmed !== true) return { error: "CONFIRMATION_REQUIRED", id: String(a.id ?? "") };
      new MemoryStore(store).forget(String(a.id ?? ""));
      return { ok: true, id: String(a.id ?? "") };
    case "knowledge_memory_improve":
      return reflectSearchFeedback(store);
    case "package_dependencies":
      return packageDependencies(store, {
        subject: String(a.subject ?? ""),
        direction: (a.direction as "dependencies" | "dependents" | "both") ?? "dependencies",
        transitive: a.transitive !== false,
        maxDepth: Number.isFinite(a.max_depth as number) ? a.max_depth as number : 5,
        limit: Number.isFinite(a.limit as number) ? a.limit as number : 100,
      });
    case "dependency_path":
      return dependencyPath(store, {
        from: String(a.from ?? ""),
        to: String(a.to ?? ""),
        maxDepth: Number.isFinite(a.max_depth as number) ? a.max_depth as number : 8,
      });
    case "analyze_repository":
      return analyzeRepository(store, {
        query: String(a.query ?? ""),
        repo: a.repo as string | undefined,
        focus: a.focus as "auto" | "dependency" | "logging" | "calls" | "architecture" | undefined,
        limit: Number.isFinite(a.limit as number) ? a.limit as number : 50,
      });
    case "knowledge_search":
      if (a.query === undefined || a.query === null) {
        throw new KnowledgeContractError(
          "MISSING_REQUIRED_ARGUMENT",
          "knowledge_search requires a query argument",
          { argument: "query", remediation: "provide a query string" },
          false,
        );
      }
      if (!String(a.query).trim()) {
        throw new KnowledgeContractError(
          "INVALID_QUERY",
          "knowledge_search requires a non-empty query",
          { query: a.query, remediation: "provide a non-empty query string" },
          false,
        );
      }
      {
        a = normalizeMcpSearchInput(a);
        const canonicalScope = inputRecord(a.scope);
        const canonicalRevisionInputs = Array.isArray(canonicalScope.revisions)
          ? canonicalScope.revisions.map(inputRecord)
          : [];
        const canonicalRevisionContexts: RevisionContext[] = [];
        if (canonicalRevisionInputs.length > 0) {
          for (const selector of canonicalRevisionInputs) {
            if (selector.workingTree === true) {
              return { error: { code: "WORKING_TREE_SCOPE_UNSUPPORTED", message: "MCP search requires an indexed snapshot, branch, or commit" } };
            }
            const repoSelector = typeof selector.repoId === "string"
              ? selector.repoId
              : typeof selector.repoName === "string"
                ? selector.repoName
                : undefined;
            const canonicalRepoIds = repoSelector ? store.resolveRepoIds(repoSelector) : [];
            if (repoSelector && canonicalRepoIds.length === 0) {
              return { error: knowledgeErrorEnvelope(
                "REPOSITORY_NOT_FOUND",
                `no indexed repo matches ${repoSelector}`,
                { selector, remediation: "call index_status({\"mode\":\"detailed\"}) and choose an indexed repository" },
              ) };
            }
            if (canonicalRepoIds.length > 1) {
              return { error: knowledgeErrorEnvelope(
                "AMBIGUOUS_REPOSITORY",
                `repository selector matches multiple indexed repositories: ${repoSelector}`,
                { selector, candidates: repositoryCandidates(store, canonicalRepoIds) },
                false,
                "retry with one repository id or canonical root from details.candidates",
              ) };
            }
            const resolved = resolveMcpRevision(store, {
              ...(canonicalRepoIds[0] ? { repo: canonicalRepoIds[0] } : {}),
              ...(typeof selector.branch === "string" ? { branch: selector.branch } : {}),
              ...(typeof selector.commitSha === "string" ? { commit_sha: selector.commitSha } : {}),
              ...(typeof selector.snapshotId === "string" ? { snapshot_id: selector.snapshotId } : {}),
            });
            if (resolved.error) {
              const error = selector.branch
                ? knowledgeErrorEnvelope("BRANCH_NOT_FOUND", `branch ${selector.branch} was not found in the indexed repository`, { selector, remediation: "call index_status and retry with an indexed branch" })
                : normalizeKnowledgeError(resolved.error);
              return { error };
            }
            if (!resolved.context) {
              return { error: { code: "REVISION_SCOPE_REQUIRED", message: "each canonical revision must resolve to an indexed repository snapshot" } };
            }
            canonicalRevisionContexts.push(resolved.context);
          }
        }
        const requestedRepo = typeof a.repo === "string" ? a.repo : undefined;
        const resolvedRepoIds = requestedRepo ? store.resolveRepoIds(requestedRepo) : [];
        if (requestedRepo && resolvedRepoIds.length === 0) return { error: knowledgeErrorEnvelope("REPOSITORY_NOT_FOUND", `no indexed repo matches ${requestedRepo}`, { repo: requestedRepo, remediation: "call index_status({\"mode\":\"detailed\"}) and choose an indexed repository" }) };
        if (requestedRepo && resolvedRepoIds.length > 1) return { error: knowledgeErrorEnvelope("AMBIGUOUS_REPOSITORY", `repository selector matches multiple indexed repositories: ${requestedRepo}`, { repo: requestedRepo, candidates: repositoryCandidates(store, resolvedRepoIds) }, false, "retry with one repository id or canonical root from details.candidates") };
        const resolvedRepoId = resolvedRepoIds[0];
        if (resolvedRepoId && typeof a.branch === "string" && !store.getBranch(resolvedRepoId, a.branch)) {
          return { error: knowledgeErrorEnvelope("BRANCH_NOT_FOUND", `branch ${a.branch} was not found in the indexed repository`, { repo: requestedRepo ?? resolvedRepoId, branch: a.branch }) };
        }
      const resolvedRepoName = resolvedRepoId
          ? (store.db.prepare("SELECT name FROM repos WHERE id=?").get(resolvedRepoId) as { name: string } | undefined)?.name
          : undefined;
      const revision = canonicalRevisionContexts.length > 0
        ? { context: canonicalRevisionContexts[0] }
        : resolveMcpRevision(store, resolvedRepoId ? { ...a, repo: resolvedRepoId } : a);
      if (revision.error) return { error: revision.error };
      const queryText = String(a.query ?? "");
      const camelCaseIdentifier = /^[A-Za-z_$][\w$]*$/u.test(queryText) && /[a-z][A-Z]/u.test(queryText);
      const defaultIdentifier = camelCaseIdentifier && a.mode === undefined;
      const useV2 = a.mode !== undefined || a.contract_version === "2" || a.cursor !== undefined || camelCaseIdentifier || canonicalRevisionContexts.length > 0;
      const sourceSnapshotId = revision.context && !revision.context.snapshotId.startsWith("legacy:")
          ? revision.context.snapshotId
          : (revision.context?.branchId
          ? (store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(revision.context.branchId) as { current_snapshot_id: string | null } | undefined)?.current_snapshot_id ?? null
          : resolvedRepoId
            ? (store.db.prepare("SELECT current_snapshot_id FROM branches WHERE repo_id=? AND status='live' AND current_snapshot_id IS NOT NULL ORDER BY default_branch DESC, name LIMIT 1").get(resolvedRepoId) as { current_snapshot_id: string | null } | undefined)?.current_snapshot_id ?? null
            : null);
      const repoId = revision.context?.repoId ?? resolvedRepoId;
      const mode = String(a.mode ?? "auto") as "exact" | "phrase" | "substring" | "auto" | "path" | "regex" | "lexical" | "structural";
      const revisionScopes = canonicalRevisionContexts.length > 0
        ? canonicalRevisionContexts.map((context) => ({ repoId: context.repoId, snapshotId: context.snapshotId }))
        : revision.context
          ? [{ repoId: revision.context.repoId, snapshotId: revision.context.snapshotId }]
          : sourceSnapshotId
            ? [{ ...(repoId ? { repoId } : {}), snapshotId: sourceSnapshotId }]
            : [];
      const canonical = searchKnowledge({
          query: queryText,
          mode: defaultIdentifier ? "exact" : mode,
          scope: {
            ...(revisionScopes.length > 0 ? { revisions: revisionScopes } : {}),
            ...(canonicalScope.paths !== undefined ? { paths: canonicalScope.paths as string[] } : {}),
            ...(Array.isArray(canonicalScope.languages) ? { languages: canonicalScope.languages.map(String) } : {}),
            ...(Array.isArray(canonicalScope.kinds) ? { kinds: canonicalScope.kinds.map(String) } : {}),
          },
          options: {
            caseSensitive: defaultIdentifier ? false : a.case_sensitive !== false,
            wholeWord: a.whole_word === true,
            includeGenerated: a.include_generated === true,
            includeVendor: a.include_vendor === true,
            includeExcludedMetadata: a.include_excluded_metadata === true,
            semantic: a.semantic === "fallback" || a.semantic === "blend" ? a.semantic : "off",
            compact: a.compact !== false,
            explain: a.explain === true,
          },
          page: {
            limit: a.limit === undefined ? 20 : a.limit as number,
            ...(a.cursor !== undefined ? { cursor: a.cursor as string } : {}),
          },
        }, {
          store,
          scopes: revisionScopes.length > 0
            ? revisionScopes.map((scope) => ({ snapshotId: scope.snapshotId, repoId: scope.repoId }))
            : undefined,
        });
      if (useV2) return canonical;
      // Preserve the legacy response shape, but do not pay the global graph
      // search cost for requests that can be answered by the source lane.
      // The old eager call made a plain camelCase lookup fan out through every
      // repository before the legacy response was assembled.
      const graphResults = search(store, queryText, {
        type: a.type as string[] | undefined,
        repo: resolvedRepoName ?? requestedRepo,
        includeSensitive: a.include_sensitive !== false,
        limit: a.limit as number | undefined,
        revision: revision.context,
      });
      const regexResult = sourceSnapshotId && mode === "regex" ? searchRegex(store, { snapshotId: sourceSnapshotId, repoId }, String(a.query ?? ""), { flags: String(a.regex_flags ?? "g"), maxScannedBytes: Number.isFinite(a.max_scanned_bytes as number) ? a.max_scanned_bytes as number : undefined, allowPartial: a.allow_partial === true }) : null;
      if (regexResult?.status === "error") return regexResult;
      const sourceResults = sourceSnapshotId && mode !== "path" && mode !== "regex" ? searchSource(store, { snapshotId: sourceSnapshotId, repoId }, { query: String(a.query ?? ""), mode, options: { caseSensitive: a.case_sensitive !== false, wholeWord: a.whole_word === true, includeGenerated: true, includeVendor: true, includeExcludedMetadata: a.include_excluded_metadata === true, semantic: "off", compact: false, explain: false } }).map((hit) => ({ ...hit, lane: "source" })) : [];
      const pathResults = sourceSnapshotId && mode === "path" ? searchPath(store, { snapshotId: sourceSnapshotId, repoId }, String(a.query ?? ""), a.include_excluded_metadata === true) : [];
      const rawResults = mode === "regex"
        ? (regexResult?.status === "ok" ? regexResult.hits.map((hit) => ({ ...hit, lane: "source" })) : [])
        : mode === "path"
          ? pathResults
          : mode === "exact" || mode === "phrase" || mode === "substring"
            ? sourceResults
            : [...sourceResults, ...graphResults];
      const results = rawResults.map((result) => {
        if (!("nodeType" in result) || result.nodeId) return result;
        return { ...result, nodeType: "source_occurrence", kind: "source_occurrence", lane: "source" };
      });
      return { ...canonical, results };
      }
    case "knowledge_graph_query":
      try { return graphQuery(store, (a.request ?? a) as import("@penguin/knowledge-core").GraphQueryRequest); }
      catch (error) { return { error: String((error as Error).message ?? error) }; }
    case "knowledge_get_hit": {
      const snapshotId = String(a.snapshot_id ?? a.revision_id ?? "");
      const filePath = String(a.file_path ?? "");
      if (!snapshotId || !filePath) return { error: "HIT_LOCATOR_REQUIRED" };
      const originalRevision = typeof a.original_revision_id === "string" ? a.original_revision_id : typeof a.originalRevisionId === "string" ? a.originalRevisionId : undefined;
      if (originalRevision && originalRevision !== snapshotId) return { error: "HIT_REVISION_MISMATCH", snapshotId, originalRevision };
      const repoId = typeof a.repo_id === "string" ? a.repo_id : typeof a.repo === "string" ? store.resolveRepoIds(a.repo)[0] : undefined;
      const snapshotRepo = store.db.prepare("SELECT repo_id AS repoId FROM revision_snapshots WHERE id=?").get(snapshotId) as { repoId: string } | undefined;
      if (!snapshotRepo) return { error: "REVISION_NOT_FOUND", snapshotId };
      const callerWorkspace = typeof a.caller_workspace_id === "string" ? a.caller_workspace_id : typeof a.workspace_id === "string" ? a.workspace_id : undefined;
      if (callerWorkspace && !store.workspaceRepoIds(callerWorkspace).includes(snapshotRepo.repoId)) return { error: "HIT_WORKSPACE_MISMATCH", workspaceId: callerWorkspace, repoId: snapshotRepo.repoId };
      if (repoId && repoId !== snapshotRepo.repoId) return { error: "HIT_REPOSITORY_MISMATCH", snapshotId, repoId, actualRepoId: snapshotRepo.repoId };
      const hit = getSourceHit(store, { snapshotId, filePath, ...(repoId ? { repoId } : {}), ...(Number.isInteger(a.start_line) ? { startLine: a.start_line as number } : {}), ...(Number.isInteger(a.end_line) ? { endLine: a.end_line as number } : {}), ...(Number.isInteger(a.start_byte) ? { startByte: a.start_byte as number } : {}), ...(Number.isInteger(a.context_lines) ? { contextLines: a.context_lines as number } : {}) });
      return hit ?? { error: "HIT_NOT_FOUND", snapshotId, filePath };
    }
    case "get_node": {
      const key = (a.id ?? a.identity_key) as string | undefined;
      if (!key) {
        return { error: knowledgeErrorEnvelope(
          "MISSING_REQUIRED_ARGUMENT",
          "get_node requires either `id` or `identity_key`; the `node` alias is not accepted",
          { requiredAnyOf: ["id", "identity_key"], receivedKeys: Object.keys(a).sort() },
        ) };
      }
      const revision = resolveMcpRevision(store, a, legacyGatedRepoId(store, a, key));
      if (revision.error) return { error: revision.error };
      // get_node used to trust the node id after resolving the revision. That
      // allowed a foreign node to be returned with an unrelated revision
      // envelope (for example, a ccmsrust node plus a Proposal snapshot).
      // Resolve through the same target ownership gate as context/flow before
      // reading any detail, so cross-repository and revision-mismatched
      // handoffs become typed errors rather than plausible empty versions.
      let resolvedTarget;
      try {
        resolvedTarget = resolveTarget(store, key, {
          repoId: revision.context?.repoId,
          revision: revision.context,
        });
      } catch (error) {
        return targetResolutionError(error, key);
      }
      const detail = getNodeDetail(store, `node:${resolvedTarget.nodeId}`, revision.context ? { revision: revision.context } : undefined);
      return detail
        ? { ...detail, target: resolvedTarget, ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) }
        : { error: knowledgeErrorEnvelope(
            "NODE_NOT_FOUND",
            "node was not found",
            { id: key },
            false,
            "call knowledge_search with the same repository/revision scope and use a freshly returned stable nodeId",
          ) };
    }
    case "explore_graph": {
      const node = String(a.node ?? "");
      // Selector-gated (see legacyGatedRepoId) — full unification deferred.
      const revision = resolveMcpRevision(store, a, legacyGatedRepoId(store, a, node));
      if (revision.error) return { error: revision.error };
      if (node.startsWith("service:")) {
        if (a.mode === "path" && typeof a.to === "string" && a.to.startsWith("service:")) {
          return { ...servicePath(store, node, a.to, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
        }
        return { ...serviceContext(store, node, { revision: revision.context }).graph, ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
      }
      const result = exploreGraph(store, a.mode as GraphMode, node, {
        depth: a.depth as number | undefined,
        limit: a.limit as number | undefined,
        to: a.to as string | undefined,
        revision: revision.context,
      });
      return { ...result, ...(revision.context ? { revision: revision.context } : {}) };
    }
    case "knowledge_explore": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return { error: revision.error };
      const result = buildExplorePack(store, target, {
        revision: revision.context,
        depth: a.depth as number | undefined,
        limit: a.limit as number | undefined,
        // Let the caller decide what it pays for: relations only when it is
        // mapping the graph, a raised ceiling when it is reading a long body.
        includeSources: a.include_sources as boolean | undefined,
        maxSourceLines: a.max_source_lines as number | undefined,
      });
      return { ...result, ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "compare_branches": {
      const symbol = String(a.symbol ?? "");
      // Selector-gated (see legacyGatedRepoId) — full unification deferred.
      const revision = resolveMcpRevision(store, a, legacyGatedRepoId(store, a, symbol));
      if (revision.error) return { error: revision.error };
      return (
        compareBranches(store, symbol, String(a.branch_a ?? ""), String(a.branch_b ?? ""), { revision: revision.context }) ??
        { error: "symbol not found on one or both branches" }
      );
    }
    case "index_status": {
      if (!String(a.reset_manifest_path ?? "").trim()) {
        return a.mode === "compact" ? compactIndexStatus(store) : indexStatus(store);
      }
      const manifestPath = resolve(String(a.reset_manifest_path));
      const databasePath = resolve(store.db.name);
      if (dirname(manifestPath) !== dirname(databasePath)) {
        return {
          error: knowledgeErrorEnvelope("RESET_MANIFEST_OUTSIDE_DATABASE_DIRECTORY", "reset manifest must be beside the active knowledge database", {
            manifestPath,
            databaseDirectory: dirname(databasePath),
            remediation: "ask the owner for the manifest emitted by `penguin corpus reset plan` for this active database",
          }),
        };
      }
      try {
        const manifest = readResetManifest(manifestPath);
        if (resolve(manifest.plan.databasePath) !== databasePath) {
          return {
            error: knowledgeErrorEnvelope("RESET_DATABASE_PATH_MISMATCH", "reset manifest belongs to a different knowledge database", {
              manifestDatabasePath: manifest.plan.databasePath,
              activeDatabasePath: databasePath,
            }),
          };
        }
        return {
          ...manifest,
          plan: { ...manifest.plan, confirmationToken: manifest.tokenConsumed ? "consumed" : "redacted" },
          ownerCommands: {
            status: `penguin corpus reset status --manifest ${manifestPath} --json`,
            execute: "owner-only: use the exact token printed by `penguin corpus reset plan`",
            recover: `penguin corpus reset recover --manifest ${manifestPath} --confirm=${manifest.plan.operationId}:recover --json`,
            rollback: `penguin corpus reset rollback --manifest ${manifestPath} --out <fresh-db-path> --confirm=${manifest.plan.operationId}:rollback --json`,
          },
          mutationAvailableThroughMcp: false,
        };
      } catch (error) {
        return {
          error: knowledgeErrorEnvelope("RESET_STATUS_FAILED", String((error as Error)?.message ?? error), {
            manifestPath,
            remediation: "verify the immutable manifest path with the owner CLI; MCP cannot create or execute a reset",
          }),
        };
      }
    }
    case "status_panel":
      return buildStatusPanel(store);
    case "set_master_branch": {
      const repoSelector = String(a.repo ?? "").trim();
      const branchName = String(a.branch ?? "");
      if (!repoSelector || !branchName) return { error: "set_master_branch requires repo and branch" };
      const repoIds = store.resolveRepoIds(repoSelector);
      if (repoIds.length === 0) return { error: "repo not found", repo: repoSelector };
      if (repoIds.length > 1) return { error: "repo is ambiguous", repo: repoSelector, candidates: repoIds };
      const branch = store.getBranch(repoIds[0], branchName);
      if (!branch) return { error: "branch not found", repo: repoSelector, branch: branchName };
      try {
        return { ok: true, ...store.setDefaultBranch(repoIds[0], branch.id) };
      } catch (error) {
        return { error: String((error as Error).message ?? error), repo: repoSelector, branch: branchName };
      }
    }
    case "list_suggestions":
      return { suggestions: store.listSuggestions() };
    case "suggest_links": {
      const ev = store.suggestEdge({
        src: String(a.src ?? ""),
        dst: a.dst == null ? null : String(a.dst),
        edgeType: String(a.edge_type ?? "wikilink"),
        confidence: a.confidence as number | undefined,
        actorId: "mcp",
      });
      return { ok: true, suggestionEventId: ev.id };
    }
    case "accept_suggestion":
      store.acceptSuggestion(String(a.suggestion_event_id ?? ""), "mcp");
      return { ok: true };
    case "reject_suggestion":
      store.rejectSuggestion(String(a.suggestion_event_id ?? ""), "mcp");
      return { ok: true };
    case "write_note":
      return writeNote(store, a);
    case "get_architecture": {
      const revision = resolveMcpRevision(store, a);
      if (revision.error) return { error: revision.error };
      return {
        ...architecture(store, { repoId: revision.context?.repoId }),
        reconciliation: canonicalCorpusForScope(store, revision.context?.repoId, revision.context?.branchId, revision.context?.snapshotId),
        ...(revision.context ? { revision: revision.context } : {}),
        ...scopeEnvelopeFields(revision.scope),
      };
    }
    case "find_communities":
      return communities(store, { limit: a.limit as number | undefined, minSize: a.min_size as number | undefined });
    case "find_dead_code": {
      // repo/path were previously accepted-and-ignored; they now scope the query.
      const branchName = a.branch != null ? String(a.branch) : undefined;
      const repoRow = a.repo != null
        ? store.db
            .prepare("SELECT id,name FROM repos WHERE id=? OR name=? LIMIT 1")
            .get(String(a.repo), String(a.repo)) as { id: string; name: string } | undefined
        : undefined;
      let branchId: string | undefined;
      if (branchName && repoRow) {
        branchId = store.getBranch(repoRow.id, branchName)?.id;
        if (repoRow && !branchId) {
          return { error: { code: "SCOPE_NOT_INDEXED", message: `branch "${branchName}" is not indexed for repo "${String(a.repo)}"`, retryable: false } };
        }
      } else if (repoRow) {
        branchId = (store.db
          .prepare("SELECT id FROM branches WHERE repo_id=? AND status='live' ORDER BY last_indexed_at DESC LIMIT 1")
          .get(repoRow.id) as { id: string } | undefined)?.id;
      }
      const branchRevision = branchId
        ? store.db
            .prepare("SELECT repo_id AS repoId,current_snapshot_id AS snapshotId FROM branches WHERE id=?")
            .get(branchId) as { repoId: string; snapshotId: string | null } | undefined
        : undefined;
      const cursorRevision = branchRevision
        ? `repo:${branchRevision.repoId}|snapshot:${branchRevision.snapshotId ?? `legacy:${branchId}`}`
        : null;
      const cursorScope = `${String(a.repo ?? "*")}|${String(a.path ?? "*")}|${String(a.branch ?? "*")}`;
      let after: { filePath: string; startLine: number; nodeId: string } | undefined;
      if (typeof a.cursor === "string") {
        try {
          const decoded = OPERATION_CURSOR_CODEC.decode(a.cursor, { operation: "deadcode", scope: cursorScope, revision: cursorRevision });
          const [filePath, startLine, nodeId] = decoded.lastKey.split("\u0000");
          if (!filePath || !Number.isFinite(Number(startLine)) || !nodeId) throw new Error("CURSOR_INVALID");
          after = { filePath, startLine: Number(startLine), nodeId };
        } catch (error) {
          const code = String((error as Error).message ?? error);
          return { error: knowledgeErrorEnvelope(
            code === "CURSOR_OPERATION_MISMATCH" || code === "CURSOR_SCOPE_MISMATCH" || code === "CURSOR_STALE" || code === "CURSOR_EXPIRED" || code === "CURSOR_REQUEST_MISMATCH" ? code : "CURSOR_INVALID",
            "invalid or mismatched dead-code cursor",
            { remediation: "restart dead-code pagination from the first page using the same repo, path, and branch scope" },
          ) };
        }
      }
      const result = deadCode(store, {
        limit: a.limit as number | undefined,
        repo: a.repo != null ? String(a.repo) : undefined,
        path: a.path != null ? String(a.path) : undefined,
        branchId,
        after,
      });
      const nextCursor = result.truncated && result.candidates.length
        ? OPERATION_CURSOR_CODEC.encode({
            schemaVersion: "1",
            contractVersion: "2",
            operation: "deadcode",
            scope: cursorScope,
            orderingKey: "filePath,startLine,nodeId",
            lastKey: `${result.candidates.at(-1)!.filePath ?? ""}\u0000${result.candidates.at(-1)!.startLine ?? -1}\u0000${result.candidates.at(-1)!.nodeId}`,
            revision: cursorRevision,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          })
        : null;
      const repoId = repoRow?.id;
      const envelope = affectedByFiles.listEnvelope(store, result.candidates, {
        repoId,
        branchId: result.scope.branch ?? undefined,
        scope: result.scope,
        candidateCount: result.candidateCount,
        remainingCount: result.remainingCount,
        totalIsExact: result.totalIsExact,
        truncated: result.truncated,
        nextCursor,
        completeness: result.truncated ? "partial" : "lower_bound",
        proofStatus: result.candidates.length ? "candidate" : "not_proven",
        gaps: ["dynamic_dispatch_and_di_not_proven"],
      });
      const { candidates: _duplicateCandidates, ...resultWithoutCandidates } = result;
      const normalPayload = { ...resultWithoutCandidates, ...envelope };
      if (a.compact !== true) return withHonestByteStats(normalPayload, normalPayload, false);
      const { evidence: _rootEvidenceMirror, ...compactPayload } = normalPayload;
      return withHonestByteStats(normalPayload, compactPayload, true);
    }
    case "knowledge_callers":
    case "knowledge_callees":
    case "knowledge_impact": {
      const mode = name === "knowledge_callers" ? "who_calls" : name === "knowledge_callees" ? "calls_of" : "impact";
      const target = String(a.target ?? a.node ?? a.symbol ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return { error: revision.error };
      let resolvedTarget;
      try { resolvedTarget = resolveTarget(store, target, { repoId: revision.context?.repoId, revision: revision.context }); }
      catch (error) { return targetResolutionError(error, target); }
      return { ...exploreGraph(store, mode, `node:${resolvedTarget.nodeId}`, { depth: a.depth as number | undefined, limit: a.limit as number | undefined, revision: revision.context }), target: resolvedTarget, ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_locate": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return { error: revision.error };
      return { ...buildExplorePack(store, target, { revision: revision.context, depth: a.depth as number | undefined, limit: a.limit as number | undefined }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_context": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return { error: revision.error };
      if (target.startsWith("service:")) {
        return { ...serviceContext(store, target, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
      }
      let resolvedTarget;
      try { resolvedTarget = resolveTarget(store, target, { repoId: revision.context?.repoId, revision: revision.context }); }
      catch (error) { return targetResolutionError(error, target); }
      const limit = Math.min(500, Math.max(1, Number.isInteger(a.limit) ? Number(a.limit) : 25));
      const cursorScope = `${resolvedTarget.nodeId}|${revision.context?.repoId ?? "*"}|${revision.context?.branchId ?? "*"}`;
      const cursorRevision = revision.context?.snapshotId ?? null;
      let offset = 0;
      if (typeof a.cursor === "string") {
        try {
          const decoded = OPERATION_CURSOR_CODEC.decode(a.cursor, { operation: "context", scope: cursorScope, revision: cursorRevision, limit });
          offset = Number(decoded.lastKey);
          if (!Number.isInteger(offset) || offset < 0) throw new Error("CURSOR_INVALID");
        } catch (error) {
          const code = String((error as Error).message ?? error);
          return { error: knowledgeErrorEnvelope(
            ["CURSOR_OPERATION_MISMATCH", "CURSOR_SCOPE_MISMATCH", "CURSOR_STALE", "CURSOR_EXPIRED", "CURSOR_REQUEST_MISMATCH"].includes(code) ? code : "CURSOR_INVALID",
            "invalid or mismatched context cursor",
            undefined,
            false,
            "restart context pagination from the first page using the same target, repo, revision, and limit",
          ) };
        }
      }
      const pack = buildContextPack(store, `node:${resolvedTarget.nodeId}`, { revision: revision.context, limit, offset });
      const nextCursor = pack.truncated.length > 0
        ? OPERATION_CURSOR_CODEC.encode({
            schemaVersion: "1", contractVersion: "2", operation: "context",
            scope: cursorScope, orderingKey: "relation-offset", lastKey: String(offset + limit),
            revision: cursorRevision, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), limit,
          })
        : null;
      return {
        ...pack,
        cursor: nextCursor,
        evidence: pack.evidence ? { ...pack.evidence, cursor: nextCursor } : pack.evidence,
        target: resolvedTarget,
        ...(revision.context ? { revision: revision.context } : {}),
        ...scopeEnvelopeFields(revision.scope),
      };
    }
    case "knowledge_flow": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return { error: revision.error };
      const limit = Math.max(1, Math.min(100, Number.isInteger(a.limit) ? Number(a.limit) : 20));
      if (target.startsWith("service:")) {
        return { ...serviceContext(store, target, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
      }
      let resolvedTarget;
      try { resolvedTarget = resolveTarget(store, target, { repoId: revision.context?.repoId, revision: revision.context }); }
      catch (error) { return targetResolutionError(error, target); }
      const scopedTarget = {
        ...resolvedTarget,
        repoId: resolvedTarget.repoId ?? revision.context?.repoId ?? null,
      };
      const cursorScope = `${resolvedTarget.nodeId}|${revision.context?.repoId ?? "*"}|${revision.context?.branchId ?? "*"}`;
      const cursorRevision = revision.context?.snapshotId ?? null;
      let offset = 0;
      if (typeof a.cursor === "string") {
        try {
          const decoded = OPERATION_CURSOR_CODEC.decode(a.cursor, { operation: "flow", scope: cursorScope, revision: cursorRevision, limit });
          offset = Number(decoded.lastKey);
          if (!Number.isInteger(offset) || offset < 0) throw new Error("CURSOR_INVALID");
        } catch (error) {
          const code = String((error as Error).message ?? error);
          return { error: knowledgeErrorEnvelope(
            ["CURSOR_OPERATION_MISMATCH", "CURSOR_SCOPE_MISMATCH", "CURSOR_STALE", "CURSOR_EXPIRED", "CURSOR_REQUEST_MISMATCH"].includes(code) ? code : "CURSOR_INVALID",
            "invalid or mismatched flow cursor",
            undefined,
            false,
            "restart flow pagination from the first page using the same target, repo, revision, and limit",
          ) };
        }
      }
      const flow = buildFlow(store, `node:${resolvedTarget.nodeId}`, { revision: revision.context, limit, offset });
      const nextCursor = flow.truncated
        ? OPERATION_CURSOR_CODEC.encode({
            schemaVersion: "1", contractVersion: "2", operation: "flow",
            scope: cursorScope, orderingKey: "flow-offset", lastKey: String(offset + flow.steps.length),
            revision: cursorRevision, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), limit,
          })
        : null;
      const normalPayload = {
        ...flow,
        cursor: nextCursor,
        evidence: flow.evidence ? { ...flow.evidence, cursor: nextCursor } : flow.evidence,
        target: scopedTarget,
        ...(revision.context ? { revision: revision.context } : {}),
        ...scopeEnvelopeFields(revision.scope),
      };
      if (a.compact !== true) return withHonestByteStats(normalPayload, normalPayload, false);
      const {
        executionSteps: _executionMirror,
        referenceSteps: _referenceMirror,
        evidence: _evidenceMirror,
        ...compactPayload
      } = normalPayload;
      return withHonestByteStats(normalPayload, compactPayload, true);
    }
    case "knowledge_affected": {
      let initialRequest;
      try {
        initialRequest = affectedByFiles.normalize(store, a);
      } catch (error) {
        if (error instanceof affectedByFiles.RequestError) return { error: knowledgeErrorEnvelope(error.code, error.message, error.details) };
        throw error;
      }
      const revision = resolveMcpRevision(store, a, initialRequest.kind === "node" ? nodeRepoId(store, initialRequest.values[0]) : null);
      if (revision.error) return { error: revision.error };
      let request;
      try {
        request = affectedByFiles.normalize(store, {
          ...a,
          repoId: revision.context?.repoId,
          revision: revision.context,
        });
      } catch (error) {
        if (error instanceof affectedByFiles.RequestError) return { error: knowledgeErrorEnvelope(error.code, error.message, error.details) };
        throw error;
      }
      let dispatched;
      try {
        dispatched = affectedByFiles.dispatch(store, request);
      } catch (error) {
        return targetResolutionError(error);
      }
      if ("error" in dispatched) return { error: dispatched.error };
      return { ...dispatched.result, ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_path": {
      const from = String(a.from ?? a.source ?? "");
      const to = String(a.to ?? a.target ?? "");
      const serviceRoute = from.startsWith("service:") && to.startsWith("service:");
      const revision = resolveMcpRevision(store, a, serviceRoute ? null : nodeRepoId(store, from));
      if (revision.error) return { error: revision.error };
      if (from.startsWith("service:") && to.startsWith("service:")) {
        return { ...servicePath(store, from, to, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
      }
      return { ...exploreGraph(store, "path", from, { to, depth: a.depth as number | undefined, limit: a.limit as number | undefined, revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_service_graph": {
      const repoSelector = typeof a.repo === "string" ? a.repo : undefined;
      const revision = resolveMcpRevision(store, a);
      if (revision.error) return { error: revision.error };
      return serviceGraph(store, {
        ...(repoSelector ? { repo: repoSelector } : {}),
        ...(revision.context ? { revision: revision.context } : {}),
        includeDirectNeighbours: a.include_direct_neighbours !== false,
      });
    }
    case "knowledge_local_graph":
      return graphNeighborhood(store, String(a.node ?? a.target ?? ""), { depth: Number(a.depth ?? 1) });
    case "knowledge_repository_graph": {
      const repoSelector = String(a.repo ?? "");
      const repoId = store.resolveRepoIds(repoSelector)[0];
      if (!repoId) return { error: knowledgeErrorEnvelope(
        "REPOSITORY_NOT_FOUND",
        "repository was not found",
        { repo: repoSelector || null },
        false,
        "call status_panel and choose an indexed repository name or id",
      ) };
      if (typeof a.branch === "string" && !store.getBranch(repoId, a.branch)) {
        return { error: knowledgeErrorEnvelope(
          "BRANCH_NOT_FOUND",
          "the requested indexed branch was not found",
          { repo: repoSelector, branch: a.branch },
          false,
          "call status_panel and choose a branch advertised for this repository",
        ) };
      }
      const revision = resolveMcpRevision(store, a, repoId);
      if (revision.error) return { error: revision.error };
      const repo = store.db.prepare("SELECT id,name,root_path AS rootPath FROM repos WHERE id=?").get(repoId) as { id: string; name: string; rootPath: string };
      const limit = Math.max(1, Math.min(150, Number.isInteger(a.limit) ? Number(a.limit) : 50));
      const edgeLimit = Math.max(1, Math.min(1_000, Number.isInteger(a.edge_limit) ? Number(a.edge_limit) : 200));
      const graph = repoGraph(store, repoId, { branchId: revision.context?.branchId, revision: revision.context }, { limit, edgeLimit });
      const truncated = graph.nodes.length >= limit || graph.edges.length >= edgeLimit;
      return {
        ...graph,
        repo,
        ...(revision.context ? { revision: revision.context } : {}),
        ...scopeEnvelopeFields(revision.scope),
        candidateCount: graph.nodes.length,
        returnedCount: graph.nodes.length,
        totalIsExact: !truncated,
        truncated,
        limits: { nodes: limit, edges: edgeLimit },
      };
    }
    case "knowledge_timeline":
      return timeline(store, { limit: Number(a.limit ?? 50), repoId: typeof a.repo === "string" ? store.resolveRepoIds(a.repo)[0] : undefined });
    case "knowledge_recent":
      return exploreGraph(store, "recent_changes", String(a.node ?? a.target ?? ""), { limit: Number(a.limit ?? 50) });
    case "knowledge_files": {
      const revision = resolveMcpRevision(store, a);
      if (revision.error) return { error: revision.error };
      const repoId = revision.context?.repoId ?? store.resolveRepoIds(String(a.repo ?? ""))[0];
      const branchId = revision.context?.branchId;
      if (!repoId) return { error: knowledgeErrorEnvelope("REPOSITORY_NOT_FOUND", "repository was not found", { repo: a.repo ?? null }) };
      if (!branchId) return { error: knowledgeErrorEnvelope("BRANCH_NOT_FOUND", "an indexed branch was not found", { repoId }) };
      const allFiles = listIndexedFiles(store, repoId, { branchId, revision: revision.context });
      const limit = Math.max(1, Math.min(Number(a.limit ?? 100), 500));
      const cursorScope = `${repoId}|${branchId}`;
      const cursorRevision = revision.context?.snapshotId ?? branchId;
      let remaining = allFiles;
      if (typeof a.cursor === "string") {
        try {
          const decoded = OPERATION_CURSOR_CODEC.decode(a.cursor, { operation: "files", scope: cursorScope, revision: cursorRevision });
          remaining = allFiles.filter((item) => item.filePath > decoded.lastKey);
        } catch (error) {
          const code = String((error as Error).message ?? error);
          return { error: knowledgeErrorEnvelope(
            code === "CURSOR_OPERATION_MISMATCH" || code === "CURSOR_SCOPE_MISMATCH" || code === "CURSOR_STALE" || code === "CURSOR_EXPIRED" ? code : "CURSOR_INVALID",
            "invalid or mismatched files cursor",
            { remediation: "restart file pagination from the first page using the same repository and revision scope" },
          ) };
        }
      }
      const page = remaining.slice(0, limit);
      const nextCursor = remaining.length > page.length && page.length > 0
        ? OPERATION_CURSOR_CODEC.encode({ schemaVersion: "1", contractVersion: "2", operation: "files", scope: cursorScope, orderingKey: "filePath", lastKey: page.at(-1)!.filePath, revision: cursorRevision, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
        : null;
      const modernSnapshot = Boolean(revision.context && !revision.context.snapshotId.startsWith("legacy:"));
      const sourceOnlyFiles = modernSnapshot ? allFiles.filter((item) => item.status === "source_only").length : 0;
      const graphOnlyFiles = modernSnapshot ? allFiles.filter((item) => item.status === "graph_only").length : 0;
      const sourceAndGraphFiles = modernSnapshot ? allFiles.length - sourceOnlyFiles - graphOnlyFiles : 0;
      return {
        ...affectedByFiles.listEnvelope(store, page, {
          repoId,
          branchId,
          revision: revision.context,
          scope: { repoId, branchId },
          candidateCount: allFiles.length,
          remainingCount: Math.max(0, remaining.length - page.length),
          totalIsExact: true,
          truncated: Boolean(nextCursor),
          nextCursor,
          completeness: nextCursor ? "partial" : "complete",
        }),
        ...(modernSnapshot ? {
          reconciliation: {
            admittedSourceFiles: sourceAndGraphFiles + sourceOnlyFiles,
            graphParsedFiles: sourceAndGraphFiles + graphOnlyFiles,
            sourceAndGraphFiles,
            sourceOnlyFiles,
            graphOnlyFiles,
            candidateFiles: allFiles.length,
            equations: [
              "admittedSourceFiles = sourceAndGraphFiles + sourceOnlyFiles",
              "graphParsedFiles = sourceAndGraphFiles + graphOnlyFiles",
              "candidateFiles = admittedSourceFiles + graphOnlyFiles",
            ],
            reconciles: allFiles.length === sourceAndGraphFiles + sourceOnlyFiles + graphOnlyFiles,
          },
        } : {}),
        ...scopeEnvelopeFields(revision.scope),
      };
    }
    case "knowledge_file_symbols": {
      // Previously this passed a bare branch_id straight through, so a caller
      // who supplied {repo, path} — the natural shape, and the one a sibling
      // tool like knowledge_files takes — got an empty branch string and an
      // empty array back. Silence for a file that HAS symbols is the worst
      // possible answer: it reads as "nothing defined here".
      const filePath = String(a.file_path ?? a.path ?? "");
      if (!filePath) return { error: "file_path (or path) is required" };
      const explicitBranch = a.branch_id == null ? "" : String(a.branch_id);
      const repoSelector = String(a.repo ?? "");
      if (!explicitBranch && !repoSelector) {
        return { error: "repo (or branch_id) is required to scope the file — a bare path is ambiguous across repos" };
      }
      const explicitBranchRow = explicitBranch ? store.db.prepare("SELECT repo_id AS repoId FROM branches WHERE id=? AND status<>'gone'").get(explicitBranch) as { repoId: string } | undefined : undefined;
      const repoId = explicitBranchRow?.repoId ?? store.resolveRepoIds(repoSelector)[0];
      if (!repoId) return { error: `repo not found: ${repoSelector}` };
      // getBranch needs an exact name, so an unspecified branch has to fall
      // back to the repo's live one — otherwise the natural {repo, path} call
      // fails with "branch not found" for a repo that is indexed just fine.
      const branchId = explicitBranch || (a.branch != null
        ? store.getBranch(repoId, String(a.branch))?.id
        : (store.db.prepare(
            "SELECT id FROM branches WHERE repo_id=? AND status='live' ORDER BY last_indexed_at DESC LIMIT 1",
          ).get(repoId) as { id: string } | undefined)?.id);
      if (!branchId) {
        return {
          error: a.branch != null
            ? `branch not found: ${String(a.branch)}`
            : `no live branch indexed for ${repoSelector}; call index_status to choose an indexed branch or ask the owner to call knowledge_index`,
        };
      }
      const fileExists = store.db.prepare(`
        SELECT 1 FROM files_index WHERE repo_id=? AND branch_id=? AND file_path=?
        UNION ALL SELECT 1 FROM symbol_versions WHERE branch_id=? AND file_path=? AND status<>'deleted'
        UNION ALL SELECT 1 FROM coverage_records WHERE repo_id=? AND file_path=?
        LIMIT 1
      `).get(repoId, branchId, filePath, branchId, filePath, repoId, filePath);
      if (!fileExists) {
        return { error: knowledgeErrorEnvelope(
          "FILE_NOT_FOUND",
          `file ${filePath} was not found in the selected indexed branch`,
          { filePath, branchId, repoId },
        ) };
      }
      const allSymbols = listFileSymbols(store, branchId, filePath);
      const limit = Math.max(1, Math.min(Number(a.limit ?? 100), 500));
      const scopeKey = `${branchId}|${filePath}`;
      let symbolRows = allSymbols;
      if (typeof a.cursor === "string") {
        try {
          const decoded = OPERATION_CURSOR_CODEC.decode(a.cursor, { operation: "filesymbols", scope: scopeKey, revision: branchId });
          const [lineValue, nodeId] = decoded.lastKey.split("\u0000");
          const line = Number(lineValue);
          if (!Number.isFinite(line) || !nodeId) throw new Error("CURSOR_INVALID");
          symbolRows = allSymbols.filter((item) => (item.startLine ?? -1) > line || ((item.startLine ?? -1) === line && item.nodeId > nodeId));
        } catch (error) {
          const code = String((error as Error).message ?? error);
          return { error: { code: code === "CURSOR_OPERATION_MISMATCH" || code === "CURSOR_SCOPE_MISMATCH" || code === "CURSOR_STALE" || code === "CURSOR_EXPIRED" ? code : "CURSOR_INVALID", message: "invalid or mismatched filesymbols cursor", retryable: false } };
        }
      }
      const page = symbolRows.slice(0, limit);
      const nextCursor = symbolRows.length > page.length && page.length > 0
        ? OPERATION_CURSOR_CODEC.encode({ schemaVersion: "1", contractVersion: "2", operation: "filesymbols", scope: scopeKey, orderingKey: "startLine,nodeId", lastKey: `${page.at(-1)!.startLine ?? -1}\u0000${page.at(-1)!.nodeId}`, revision: branchId, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
        : null;
      return affectedByFiles.listEnvelope(store, page, {
        repoId,
        branchId,
        scope: { repoId, branchId, filePath },
        candidateCount: allSymbols.length,
        remainingCount: Math.max(0, symbolRows.length - page.length),
        totalIsExact: true,
        truncated: Boolean(nextCursor),
        nextCursor,
        completeness: "lower_bound",
        proofStatus: page.length ? "candidate" : "not_proven",
      });
    }
    case "knowledge_tag_list": {
      const tags = listTags(store);
      const items = tags.map((tag) => ({ tag, source: { kind: "note_index" }, timestamp: null, scope: null, revision: null, sensitivity: "unknown", permission: { mcpAccess: "unknown" }, provenanceGaps: ["source_timestamp_unavailable", "permission_state_unavailable"] }));
      return { ...affectedByFiles.listEnvelope(store, items, { gaps: ["tag_item_provenance_incomplete"] }), tags };
    }
    case "knowledge_response_sample_list":
      return endpointSamples(store, String(a.endpoint ?? a.target ?? ""));
    case "knowledge_response_sample_capture": {
      const endpoint = String(a.endpoint ?? a.endpoint_key ?? "");
      const endpointId = resolveEndpointId(store, endpoint);
      const event = store.recordKnowledge({ type: "response_sample_captured", origin: "mcp", method: "ASSERTED", actor: { type: "mcp", id: "mcp" }, target: { node_id: endpointId }, payload: { endpoint_id: endpointId, endpoint_key: endpoint, status: a.status ?? null, content_type: a.content_type ?? null, sample: String(a.sample ?? a.body ?? "") } });
      return { ok: true, eventId: event.id, endpointId };
    }
    case "knowledge_snapshot_list": {
      const snapshots = store.listSnapshots();
      const items = snapshots.map((snapshot) => ({ ...snapshot, source: { kind: "ledger_snapshot", id: snapshot.id }, timestamp: snapshot.ts ?? null, scope: null, revision: null, sensitivity: "unknown", permission: { read: "local" }, provenanceGaps: ["repository_scope_unavailable"] }));
      return affectedByFiles.listEnvelope(store, items, { gaps: ["snapshot_repository_scope_unavailable"] });
    }
    case "knowledge_branch_pin": {
      const repoId = store.resolveRepoIds(String(a.repo ?? ""))[0];
      const branch = repoId ? store.getBranch(repoId, String(a.branch ?? "")) : undefined;
      if (!branch) return { error: "BRANCH_NOT_FOUND" };
      return { ok: true, repoId, branchId: branch.id, pinned: store.toggleBranchPinned(branch.id) };
    }
    case "knowledge_doctor": {
      if (a.mutation_preflight != null) {
        const preflight = inputRecord(a.mutation_preflight);
        const action = String(preflight.action ?? "").trim();
        const toolByAction: Record<string, string> = {
          register: "knowledge_repository_register",
          index: "knowledge_index",
          rebuild: "knowledge_rebuild",
        };
        const tool = toolByAction[action];
        if (!tool) {
          return { error: knowledgeErrorEnvelope(
            "MUTATION_PREFLIGHT_INVALID",
            "mutation_preflight.action must be register, index, or rebuild",
            { action: action || null },
            false,
            "choose exactly one supported action: register, index, or rebuild",
          ) };
        }
        const requestedRoot = String(preflight.root_path ?? preflight.path ?? "").trim();
        if (!requestedRoot) {
          return { error: knowledgeErrorEnvelope(
            "ROOT_PATH_REQUIRED",
            "mutation_preflight requires root_path or path",
            { action },
            false,
            "provide an absolute repository root inside the configured workspace roots",
          ) };
        }
        if (!isAbsolute(requestedRoot)) {
          return { error: knowledgeErrorEnvelope(
            "MUTATION_PREFLIGHT_INVALID",
            "mutation_preflight root_path must be an absolute existing repository path",
            { action, rootPath: requestedRoot },
            false,
            "provide an absolute existing repository path inside the configured workspace roots",
          ) };
        }
        let rootPath: string;
        try {
          rootPath = assertOwnerMutationRoot(store, action as "register" | "index" | "rebuild", requestedRoot);
        } catch (error) {
          const code = error instanceof MutationTargetResolutionError
            ? error.code
            : "MUTATION_PREFLIGHT_INVALID";
          const remediation = code === "ROOT_PATH_OUT_OF_SCOPE"
            ? "choose a repository inside the configured workspace roots or update the owner-controlled MCP workspace configuration"
            : "provide an absolute existing repository path inside the configured workspace roots";
          return { error: knowledgeErrorEnvelope(
            code,
            String((error as Error).message ?? error),
            { action, rootPath: requestedRoot },
            false,
            remediation,
          ) };
        }
        if (!existsSync(rootPath)) {
          return { error: knowledgeErrorEnvelope(
            "MUTATION_PREFLIGHT_INVALID",
            "mutation_preflight root_path must identify an existing repository path",
            { action, rootPath },
            false,
            "provide an absolute existing repository path inside the configured workspace roots",
          ) };
        }
        return {
          status: "valid",
          readOnly: true,
          mutationPerformed: false,
          capability: action === "register" ? "knowledge.repository.register" : `knowledge.${action}`,
          action,
          rootPath,
          confirmationRequired: true,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
          nextAction: {
            tool,
            arguments: { root_path: rootPath, confirmed: true },
            ownerApprovalRequired: true,
          },
        };
      }
      const consistency = store.consistencyCheck();
      const registeredRepositories = store.db.prepare("SELECT id,name,root_path AS rootPath FROM repos ORDER BY name COLLATE NOCASE,id").all();
      const pageCount = Number((store.db.prepare("PRAGMA page_count").get() as { page_count?: number }).page_count ?? 0);
      const pageSize = Number((store.db.prepare("PRAGMA page_size").get() as { page_size?: number }).page_size ?? 0);
      const database = { pageCount, pageSize, bytesEstimate: pageCount * pageSize };
      if (a.deep !== true) {
        return {
          ...consistency,
          mode: "bounded",
          database,
          configuredWorkspaceRoots: [...MCP_WORKSPACE_ROOTS],
          registeredRepositories,
          integrity: {
            status: "not_run",
            deepRequired: true,
            reason: "DEEP_CHECK_REQUIRED",
            remediation: "call knowledge_doctor with deep=true only when a full SQLite scan is required",
          },
          foreignKeys: {
            status: "not_run",
            deepRequired: true,
            violations: null,
          },
        };
      }
      const integrityRow = store.db.prepare("PRAGMA integrity_check(1)").get() as Record<string, unknown> | undefined;
      const integrityValue = String(Object.values(integrityRow ?? {})[0] ?? "unknown");
      const foreignKeyViolations = store.db.prepare("PRAGMA foreign_key_check").all();
      return {
        ...consistency,
        mode: "deep",
        database,
        configuredWorkspaceRoots: [...MCP_WORKSPACE_ROOTS],
        registeredRepositories,
        integrity: { status: integrityValue === "ok" ? "ok" : "failed", result: integrityValue },
        foreignKeys: { status: foreignKeyViolations.length === 0 ? "ok" : "failed", violations: foreignKeyViolations },
      };
    }
    case "knowledge_explain": {
      const target = String(a.target ?? a.symbol ?? "");
      const repoSelector = typeof a.repo === "string" ? a.repo : undefined;
      const repoIds = repoSelector ? store.resolveRepoIds(repoSelector) : [];
      if (repoSelector && repoIds.length === 0) {
        return {
          error: knowledgeErrorEnvelope(
            "REPOSITORY_NOT_FOUND",
            `no indexed repo matches ${repoSelector}`,
            { repo: repoSelector, remediation: "call index_status({\"mode\":\"detailed\"}) and choose an indexed repository" },
          ),
        };
      }
      if (repoIds.length > 1) {
        return {
          error: knowledgeErrorEnvelope(
            "AMBIGUOUS_REPOSITORY",
            `repository selector matches multiple indexed repositories: ${repoSelector}`,
            { repo: repoSelector, candidates: repositoryCandidates(store, repoIds) },
            false,
            "retry with one repository id or canonical root from details.candidates",
          ),
        };
      }
      const pack = buildContextPack(store, target, repoIds[0] ? { repoId: repoIds[0] } : {});
      return { target, summary: pack.focus ? `${pack.focus.nodeType}: ${pack.focus.title}` : "target not found", context: pack, confidence: pack.focus ? "verified" : "unknown" };
    }
    case "knowledge_link_list": {
      const limit = Math.min(Number(a.limit ?? 100), 500);
      const rows = store.db.prepare("SELECT id, src, dst, edge_type AS edgeType, status, provenance FROM edges WHERE status='active' ORDER BY id LIMIT ?").all(limit) as Array<{ id: string; src: string; dst: string; edgeType: string; status: string; provenance: string | null }>;
      const items = rows.map((row) => ({ ...row, source: { kind: "graph_edge", provenance: row.provenance ? (() => { try { return JSON.parse(row.provenance); } catch { return row.provenance; } })() : null }, timestamp: null, scope: null, revision: null, sensitivity: "unknown", permission: { read: "local" }, provenanceGaps: ["source_timestamp_unavailable", ...(row.provenance ? [] : ["edge_provenance_unavailable"])] }));
      return affectedByFiles.listEnvelope(store, items, { candidateCount: rows.length < limit ? rows.length : null, totalIsExact: rows.length < limit, gaps: items.flatMap((item) => item.provenanceGaps) });
    }
    case "knowledge_link_delete": {
      const id = String(a.edge_id ?? a.id ?? "");
      if (!id) return { error: "EDGE_ID_REQUIRED" };
      const event = store.recordKnowledge({ type: "manual_edge_deleted", origin: "mcp", method: "ASSERTED", actor: { type: "mcp", id: "mcp" }, target: { node_id: id }, payload: { edge_id: id } });
      return { ok: true, eventId: event.id, edgeId: id };
    }
    case "knowledge_saved_query_list":
      return new SavedQueryStore(store).list(typeof a.query === "string" ? a.query : undefined);
    case "knowledge_saved_query_run": {
      const saved = new SavedQueryStore(store).get(String(a.name ?? a.id ?? ""));
      if (!saved) return { error: "SAVED_QUERY_NOT_FOUND" };
      const request = saved.request && typeof saved.request === "object" && !Array.isArray(saved.request)
        ? saved.request as Record<string, unknown>
        : {};
      const savedPage = request.page && typeof request.page === "object" && !Array.isArray(request.page)
        ? request.page as Record<string, unknown>
        : {};
      return searchKnowledge({
        ...request,
        page: {
          ...savedPage,
          ...(a.limit == null ? {} : { limit: Number(a.limit) }),
          ...(a.cursor == null ? {} : { cursor: String(a.cursor) }),
        },
      } as never, { store });
    }
    case "knowledge_saved_query_write":
      const saved = new SavedQueryStore(store).write({ name: String(a.name ?? ""), request: (a.request ?? {}) as Record<string, unknown>, scope: (a.scope ?? {}) as Record<string, unknown> });
      const markdownPath = writeSavedQueryMarkdown(evidenceNotesDir(), saved);
      return { ...saved, markdownPath };
    case "knowledge_note_backlinks": {
      const target = String(a.node ?? a.target ?? a.id ?? "");
      return exploreGraph(store, "backlinks", target, { limit: Number(a.limit ?? 100) });
    }
    case "list_sls_targets":
      return slsRegistry().filter((target) => a.include_disabled === true || target.enabled);
    default:
      if (CAPABILITIES.some((capability) => capability.id.replaceAll(".", "_") === name)) {
        const error = new Error(`capability not implemented: ${name}`) as Error & { code?: string };
        error.code = "CAPABILITY_NOT_IMPLEMENTED";
        throw error;
      }
      throw new Error(`not a knowledge tool: ${name}`);
  }
}

function writeNote(store: KnowledgeStore, a: Record<string, unknown>): unknown {
  const action = String(a.action ?? "");
  if (action === "link_pages") {
    const src = String(a.src ?? "");
    const dst = a.dst == null ? null : String(a.dst);
    if (!src) return { error: "link_pages requires src" };
    if (isSensitive(store, src) || (dst && isSensitive(store, dst))) {
      return { error: "refused: cannot link sensitive pages (AI write policy)" };
    }
    const ev = store.recordKnowledge({
      type: "manual_edge_created",
      origin: "ai",
      method: "ASSERTED",
      actor: { type: "ai", id: "mcp" },
      target: { node_id: src },
      payload: { src, dst, edge_type: String(a.edge_type ?? "wikilink") },
    });
    return { ok: true, eventId: ev.id };
  }
  if (action === "create_page" || action === "append_note") {
    // Ledger-first record of the write intent; the .md file + FTS sync is the
    // app/wiki-path layer's job (Plan 5). AI creates drafts only.
    const ev = store.recordKnowledge({
      type: action === "create_page" ? "node_created" : "note_linked",
      origin: "ai",
      method: "ASSERTED",
      actor: { type: "ai", id: "mcp" },
      payload: {
        title: a.title ?? null,
        identity_key: a.identity_key ?? null,
        text: a.text ?? null,
        draft: true,
      },
    });
    return { ok: true, eventId: ev.id, note: "recorded to ledger; wiki file sync is app-side" };
  }
  return { error: `unknown write_note action: ${action}` };
}
