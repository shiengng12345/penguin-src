import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeStore,
  compareBranches,
  exploreGraph,
  getNodeDetail,
  indexStatus,
  compactIndexStatus,
  resolveSymbolMatches,
  search,
  searchSource,
  searchPath,
  searchRegex,
  searchKnowledge,
  graphQuery,
  getSourceHit,
  buildOnboarding,
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
  syncPostgresSchema,
  type PostgresSchemaClient,
  SCHEMA_VERSION,
  resolveQueryScope,
  ScopeResolutionError,
  type ResolvedQueryScope,
} from "@penguin/knowledge-core";
import { CAPABILITIES, capabilityHash, listMcpRegistrations, CAPABILITY_ALIASES } from "@penguin/knowledge-contracts";
import { analyzeRepository } from "./repository-analysis.js";
import { readConfig } from "./config.js";
import { INITIAL_SLS_TARGETS, mergeSlsTargets } from "./sls-target-registry.js";
import { planLogInvestigation, continueLogInvestigation } from "./log-investigation.js";
import { correlateInvestigationEvidence } from "./log-evidence-correlator.js";
import { FileInvestigationStateStore } from "./log-investigation-store.js";
import type { InvestigationRequest, InvestigationContinuation } from "./log-investigation-contract.js";
import type { KnowledgeEvidencePreflight } from "./log-evidence-correlator.js";
import { ApiDocPreviewStore, buildApiDocumentation, collectDocumentationFacts, renderApiDocumentation, validateDocumentationRequest } from "@penguin/api-doc-generator";
import { createKnowledgeApiDocAdapter } from "../../knowledge-cli/src/api-doc-knowledge-adapter.js";

const execFileAsync = promisify(execFile);

export interface KnowledgeToolOptions {
  /** Host-owned adapter; credentials are resolved outside the MCP process. */
  postgresSchemaClient?: PostgresSchemaClient;
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
function openKnowledgeStore(): KnowledgeStore | null {
  const dbPath = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
  const ledgerPath = process.env.PENGUIN_KNOWLEDGE_LEDGER ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl");
  if (!existsSync(dbPath)) return null;
  return KnowledgeStore.open({ dbPath, ledgerPath });
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
  knowledge_set_master_branch: "set_master_branch",
  knowledge_suggestion_list: "list_suggestions",
  knowledge_suggestion_accept: "accept_suggestion",
  knowledge_suggestion_reject: "reject_suggestion",
  knowledge_architecture: "get_architecture",
  knowledge_communities: "find_communities",
  knowledge_dead_code: "find_dead_code",
  knowledge_coverage: "knowledge_coverage",
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
      const rawTerms = [
        ...request.clues.traceIds ?? [], ...request.clues.requestIds ?? [],
        ...request.clues.playerIds ?? [], ...request.clues.proposalIds ?? [],
        ...request.clues.routes ?? [], ...request.clues.methods ?? [],
        ...request.clues.keywords ?? [],
        ...request.question.split(/[^A-Za-z0-9_.:/-]+/).filter((term) => term.length >= 3),
      ];
      const terms = [...new Set(rawTerms.map((term) => term.trim()).filter(Boolean))].slice(0, 24);
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

export async function runKnowledgeTool(name: string, a: Record<string, unknown>, options: KnowledgeToolOptions = {}): Promise<unknown> {
  const mutation = mutationGuard(name, a);
  if (mutation && "error" in mutation) return mutation;
  const store = openKnowledgeStore();
  try {
    const routedName = handlerName(name);
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
        return { error: { code: "CAPABILITY_MISMATCH", message: `unsupported knowledge contract major ${requestedContract}; upgrade Penguin or request contract 2`, retryable: false } };
      }
      return {
        schemaVersion: "13",
        contractVersion: "2",
        buildId: process.env.PENGUIN_BUILD_ID ?? "local",
        capabilityHash: capabilityHash(CAPABILITIES),
        capabilities: CAPABILITIES,
        registrations: listMcpRegistrations(),
      };
    }
    if (routedName === "api_doc_generate") {
      if (!store) return { error: "knowledge not initialized — run `penguin init` first" };
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
      if (!store) return { error: "knowledge not initialized — run `penguin init` before capturing evidence" };
      const result = await continueLogInvestigation(a.continuation as InvestigationContinuation, (a.results ?? []) as never[], { registry: slsRegistry(), stateStore: investigationStateStore(), now: () => new Date(), delay: async () => {} });
      if (result.status === "awaiting_sls_execution") return result;
      const packet = await correlateInvestigationEvidence(result, result.knowledgeSeed ?? { collectedAt: new Date().toISOString(), facts: [], gaps: [], targetHints: [], evidence: [] });
      const notesPackage = ["@penguin/knowledge-indexer", "notes"].join("/");
      const notes = await import(notesPackage);
      const captures = packet.targetPackets.map((targetPacket) => notes.upsertEvidenceNote({ store: store!, notesDir: join(homedir(), ".penguin", "knowledge", "notes"), packet: targetPacket as never }));
      const failedCapture = captures.some((capture: { searchable: boolean; status: string }) => capture.status === "failed" || !capture.searchable);
      if (!failedCapture) investigationStateStore().remove(result.sessionId);
      return { ...result, captures, packet: { investigationId: packet.investigationId, targetIds: packet.targetPackets.map((item) => item.target.targetId) } };
    }
    if (["list_evidence_notes", "set_evidence_status", "evidence_doctor", "repair_evidence"].includes(routedName)) {
      if (!store) return { error: "knowledge not initialized — run `penguin init` or capture evidence first" };
      const notesPackage = ["@penguin/knowledge-indexer", "notes"].join("/");
      const notes = await import(notesPackage);
      if (routedName === "list_evidence_notes") return notes.listEvidenceNotes({ store, notesDir: evidenceNotesDir(), targetId: a.target_id as string | undefined, status: a.status as never, limit: Number(a.limit ?? 100) });
      if (routedName === "set_evidence_status") return notes.setEvidenceStatus({ store, notesDir: evidenceNotesDir(), slug: String(a.slug ?? ""), to: String(a.status ?? "") as never, from: a.from as never });
      if (routedName === "evidence_doctor") return notes.evidenceDoctor({ store, notesDir: evidenceNotesDir() });
      return notes.repairEvidence({ store, notesDir: evidenceNotesDir() });
    }
    if (["knowledge_note_create", "knowledge_note_append", "knowledge_note_list", "knowledge_note_reindex", "knowledge_incident_create", "knowledge_evidence_target_list", "knowledge_evidence_note_get", "knowledge_evidence_validate"].includes(routedName)) {
      const notesPackage = ["@penguin/knowledge-indexer", "notes"].join("/");
      const notes = await import(notesPackage);
      const notesDir = evidenceNotesDir();
      if (routedName === "knowledge_note_create") return notes.createNote({ store, notesDir, title: String(a.title ?? ""), body: String(a.body ?? a.text ?? ""), frontmatter: { type: String(a.type ?? "note") } });
      if (routedName === "knowledge_incident_create") return notes.createIncident({ store, notesDir, title: String(a.title ?? ""), fields: (a.fields ?? {}) as never });
      if (routedName === "knowledge_note_append") return notes.appendNote({ store, notesDir, slug: String(a.slug ?? a.id ?? ""), text: String(a.text ?? a.body ?? "") });
      if (routedName === "knowledge_note_list") return notes.listNotes(notesDir);
      if (routedName === "knowledge_note_reindex") {
        const report = notes.reindexNotesDir({ store, notesDir });
        const dangling = notes.listDanglingNoteLinks(store, Number(a.limit ?? 100));
        return { ...report, danglingLinks: dangling };
      }
      if (routedName === "knowledge_evidence_target_list") {
        const rows = notes.listEvidenceNotes({ store, notesDir, limit: Number(a.limit ?? 100) });
        return [...new Map(rows.map((row: { targetId: string; environment: string; region: string; project: string; logstore: string }) => [row.targetId, { targetId: row.targetId, environment: row.environment, region: row.region, project: row.project, logstore: row.logstore }])).values()];
      }
      if (routedName === "knowledge_evidence_note_get") {
        const slug = String(a.slug ?? a.id ?? "");
        const summaries = notes.listEvidenceNotes({ store, notesDir, limit: 100 }).filter((row: { slug: string }) => row.slug === slug);
        return summaries.length === 0 ? { error: "EVIDENCE_NOTE_NOT_FOUND", slug } : { ...summaries[0], markdown: notes.readNote(notesDir, slug) };
      }
      return { ...notes.evidenceDoctor({ store, notesDir }), status: "validated" };
    }
    if (["knowledge_repository_register", "knowledge_index", "knowledge_rebuild", "knowledge_repository_remove"].includes(routedName)) {
      const indexer = await import("@penguin/knowledge-indexer");
      if (routedName === "knowledge_repository_remove") {
        const repoId = store.resolveRepoIds(String(a.repo ?? a.repo_id ?? ""))[0];
        if (!repoId) return { error: "REPOSITORY_NOT_FOUND" };
        store.removeRepo(repoId);
        return { ok: true, repoId };
      }
      const rootPath = String(a.root_path ?? a.path ?? "").trim();
      if (!rootPath) return { error: "ROOT_PATH_REQUIRED" };
      try { assertWorkspacePath(rootPath, MCP_WORKSPACE_ROOTS, "MCP index root"); }
      catch (error) { return { error: (error as Error).message }; }
      return indexer.indexRepo({ store, rootPath, mode: routedName === "knowledge_rebuild" ? "rebuild" : "incremental" });
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
      return indexer.indexRevision({ store, rootPath: repo.rootPath, repoId, revision: branch ? { branch } : { commitSha: commitSha! }, parserVersion: "tree-sitter-wasm-v5-single-pass-log-sites", resolverVersion: "resolver-v1", coordinator: new indexer.RevisionIndexCoordinator() });
    }
    return handleKnowledgeTool(routedName, a, store, options);
  } finally {
    if (store) {
      try {
        new AuditStore(store).append({ capabilityId: name, actorId: "mcp", scopeHash: createHash("sha256").update(JSON.stringify({ repo: a.repo ?? null, branch: a.branch ?? null, snapshot_id: a.snapshot_id ?? null })).digest("hex"), input: a, resultCode: "completed_or_returned" });
      } catch { /* audit must not turn a read result into a transport failure */ }
    }
    store?.close();
  }
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
  const message = error.code === "BRANCH_NOT_INDEXED"
    ? `${error.message} Pass allow_fallback: true to answer from another indexed branch instead.`
    : error.message;
  return { error: { code: error.code, message, candidates: error.candidates } };
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
    if (repoIds.length === 0) return { error: { error: "revision_repo_not_found", repo: repoSelector } };
    if (repoIds.length > 1) return { error: { error: "revision_repo_ambiguous", repo: repoSelector, candidates: repoIds } };
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

function nodeRepoId(store: KnowledgeStore, target: string): string | null {
  const resolution = resolveSymbolMatches(store, target);
  return resolution.kind === "unique" ? store.getNode(resolution.nodeId)?.repo_id ?? null : null;
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

// Dispatch a knowledge tool call. `store` may be null when the knowledge DB
// hasn't been created yet (no `penguin init`) — read tools then return a hint
// instead of crashing (§9).
export function handleKnowledgeTool(
  name: string,
  a: Record<string, unknown>,
  store: KnowledgeStore | null,
  options: KnowledgeToolOptions = {},
): unknown {
  if (name === "api_doc_list" || name === "api_doc_show" || name === "api_doc_diff") {
    const root = process.env.PENGUIN_API_DOC_PREVIEWS ?? join(homedir(), ".penguin", "knowledge", "api-docs", "previews");
    const previews = new ApiDocPreviewStore(root);
    try {
      if (name === "api_doc_list") return previews.list({ documentKey: a.document_key as string | undefined, query: a.query as string | undefined });
      if (name === "api_doc_show") {
        const preview = previews.load(String(a.preview_id ?? ""));
        const format = a.format ?? "json";
        return format === "markdown" ? { format, content: preview.rendered.markdown, manifest: preview.manifest } : format === "xml" ? { format, content: preview.rendered.larkXml, manifest: preview.manifest } : preview;
      }
      return previews.diff(String(a.left_preview_id ?? ""), String(a.right_preview_id ?? ""));
    } catch (error) { return { error: "api_doc_preview_error", message: String((error as Error).message ?? error) }; }
  }
  if (name === "knowledge_capabilities") {
    const requestedContract = typeof a.contract_version === "string" ? a.contract_version : undefined;
    if (requestedContract && requestedContract.split(".")[0] !== "2") {
      return { error: { code: "CAPABILITY_MISMATCH", message: `unsupported knowledge contract major ${requestedContract}; upgrade Penguin or request contract 2`, retryable: false } };
    }
    return { schemaVersion: String(SCHEMA_VERSION), contractVersion: "2", buildId: process.env.PENGUIN_BUILD_ID ?? "local", capabilityHash: capabilityHash(CAPABILITIES), capabilities: CAPABILITIES, registrations: listMcpRegistrations() };
  }
  if (!store) {
    return { error: "knowledge not initialized — run `penguin init` or open Penguin app" };
  }
  switch (name) {
    case "knowledge_coverage": {
      const repoId = typeof a.repo === "string" ? store.resolveRepoIds(a.repo)[0] : undefined;
      const row = (repoId ? store.db.prepare("SELECT COUNT(*) AS discovered,SUM(coverage_status='admitted') AS admitted,SUM(coverage_status<>'admitted') AS excluded,SUM(coverage_status='failed') AS failed FROM coverage_records WHERE repo_id=?").get(repoId) : store.db.prepare("SELECT COUNT(*) AS discovered,SUM(coverage_status='admitted') AS admitted,SUM(coverage_status<>'admitted') AS excluded,SUM(coverage_status='failed') AS failed FROM coverage_records").get()) as { discovered:number; admitted:number; excluded:number; failed:number };
      return { discovered: row.discovered ?? 0, admitted: row.admitted ?? 0, excluded: row.excluded ?? 0, failed: row.failed ?? 0, stale: 0 };
    }
    case "knowledge_why_get":
      return new WhyCardStore(store).get(String(a.id ?? a.card_id ?? "")) ?? { error: "WHY_NOT_FOUND" };
    case "knowledge_domain_explain":
      return { target: String(a.target ?? ""), claims: buildDomainClaims(store, { ...(typeof a.repo === "string" ? { repoId: store.resolveRepoIds(a.repo)[0] } : {}), ...(typeof a.persona === "string" ? { persona: a.persona as "frontend" | "backend" | "qa" | "sre" | "pm/security" } : {}) }), flow: buildDomainFlow(store, { ...(typeof a.repo === "string" ? { repoId: store.resolveRepoIds(a.repo)[0] } : {}), ...(typeof a.target === "string" && a.target ? { target: a.target } : {}) }), gaps: ["domain claims are candidates and require human review"] };
    case "knowledge_onboarding_generate":
      return { markdown: buildOnboarding(store, typeof a.repo === "string" ? store.resolveRepoIds(a.repo)[0] : undefined) };
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
        const preview = new ApiDocPreviewStore(root).load(String(a.preview_id ?? a.id ?? ""));
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
      if (!String(a.query ?? "").trim()) {
        return { error: "knowledge_search requires a non-empty query" };
      }
      {
        const requestedRepo = typeof a.repo === "string" ? a.repo : undefined;
        const resolvedRepoIds = requestedRepo ? store.resolveRepoIds(requestedRepo) : [];
        if (requestedRepo && resolvedRepoIds.length === 0) return { error: "REPOSITORY_NOT_FOUND", repo: requestedRepo };
        if (requestedRepo && resolvedRepoIds.length > 1) return { error: "REPOSITORY_AMBIGUOUS", repo: requestedRepo, candidates: resolvedRepoIds };
        const resolvedRepoId = resolvedRepoIds[0];
      const resolvedRepoName = resolvedRepoId
          ? (store.db.prepare("SELECT name FROM repos WHERE id=?").get(resolvedRepoId) as { name: string } | undefined)?.name
          : undefined;
      const revision = resolveMcpRevision(store, resolvedRepoId ? { ...a, repo: resolvedRepoId } : a);
      if (revision.error) return revision.error;
      const queryText = String(a.query ?? "");
      const camelCaseIdentifier = /^[A-Za-z_$][\w$]*$/u.test(queryText) && /[a-z][A-Z]/u.test(queryText);
      const defaultIdentifier = camelCaseIdentifier && a.mode === undefined;
      const useV2 = a.mode !== undefined || a.contract_version === "2" || camelCaseIdentifier;
      const sourceSnapshotId = revision.context && !revision.context.snapshotId.startsWith("legacy:")
          ? revision.context.snapshotId
          : (revision.context?.branchId
          ? (store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(revision.context.branchId) as { current_snapshot_id: string | null } | undefined)?.current_snapshot_id ?? null
          : resolvedRepoId
            ? (store.db.prepare("SELECT current_snapshot_id FROM branches WHERE repo_id=? AND status='live' AND current_snapshot_id IS NOT NULL ORDER BY default_branch DESC, name LIMIT 1").get(resolvedRepoId) as { current_snapshot_id: string | null } | undefined)?.current_snapshot_id ?? null
            : null);
      const repoId = revision.context?.repoId ?? resolvedRepoId;
      const mode = ["exact", "phrase", "substring", "auto", "path", "regex"].includes(String(a.mode ?? "auto")) ? String(a.mode ?? "auto") as "exact" | "phrase" | "substring" | "auto" | "path" | "regex" : "auto";
      if (useV2) {
        const v2 = searchKnowledge({ query: queryText, mode: defaultIdentifier ? "exact" : mode, scope: sourceSnapshotId ? { revisions: [{ ...(repoId ? { repoId } : {}), snapshotId: sourceSnapshotId }] } : undefined, options: { caseSensitive: defaultIdentifier ? false : a.case_sensitive !== false, wholeWord: a.whole_word === true, includeExcludedMetadata: a.include_excluded_metadata === true, compact: a.compact !== false, explain: a.explain === true }, page: { limit: Number.isInteger(a.limit as number) ? a.limit as number : 20, ...(typeof a.cursor === "string" ? { cursor: a.cursor } : {}) } }, { store, scopes: sourceSnapshotId ? [{ snapshotId: sourceSnapshotId, repoId }] : undefined });
        return v2;
      }
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
      return {
        results: mode === "regex" ? (regexResult?.status === "ok" ? regexResult.hits.map((hit) => ({ ...hit, lane: "source" })) : []) : mode === "path" ? pathResults : mode === "exact" || mode === "phrase" || mode === "substring" ? sourceResults : [...sourceResults, ...graphResults],
        ...(revision.context ? { revision: revision.context } : {}),
      };
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
      // Selector-gated (see legacyGatedRepoId) — full unification deferred.
      const revision = resolveMcpRevision(store, a, legacyGatedRepoId(store, a, key ?? ""));
      if (revision.error) return revision.error;
      const detail = getNodeDetail(store, key ?? "", revision.context ? { revision: revision.context } : undefined);
      return detail ? { ...detail, ...(revision.context ? { revision: revision.context } : {}) } : { error: "node not found" };
    }
    case "explore_graph": {
      const node = String(a.node ?? "");
      // Selector-gated (see legacyGatedRepoId) — full unification deferred.
      const revision = resolveMcpRevision(store, a, legacyGatedRepoId(store, a, node));
      if (revision.error) return revision.error;
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
      if (revision.error) return revision.error;
      const result = buildExplorePack(store, target, {
        revision: revision.context,
        depth: a.depth as number | undefined,
        limit: a.limit as number | undefined,
      });
      return { ...result, ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "compare_branches": {
      const symbol = String(a.symbol ?? "");
      // Selector-gated (see legacyGatedRepoId) — full unification deferred.
      const revision = resolveMcpRevision(store, a, legacyGatedRepoId(store, a, symbol));
      if (revision.error) return revision.error;
      return (
        compareBranches(store, symbol, String(a.branch_a ?? ""), String(a.branch_b ?? ""), { revision: revision.context }) ??
        { error: "symbol not found on one or both branches" }
      );
    }
    case "index_status":
      return a.mode === "compact" ? compactIndexStatus(store) : indexStatus(store);
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
    case "get_architecture":
      return architecture(store);
    case "find_communities":
      return communities(store, { limit: a.limit as number | undefined, minSize: a.min_size as number | undefined });
    case "find_dead_code":
      return deadCode(store, { limit: a.limit as number | undefined });
    case "knowledge_callers":
    case "knowledge_callees":
    case "knowledge_impact": {
      const mode = name === "knowledge_callers" ? "who_calls" : name === "knowledge_callees" ? "calls_of" : "impact";
      const target = String(a.target ?? a.node ?? a.symbol ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return revision.error;
      return { ...exploreGraph(store, mode, target, { depth: a.depth as number | undefined, limit: a.limit as number | undefined, revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_locate": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return revision.error;
      return { ...buildExplorePack(store, target, { revision: revision.context, depth: a.depth as number | undefined, limit: a.limit as number | undefined }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_context": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return revision.error;
      return { ...buildContextPack(store, target, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_flow": {
      const target = String(a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, target));
      if (revision.error) return revision.error;
      return { ...buildFlow(store, target, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_affected": {
      const paths = Array.isArray(a.files) ? a.files.map(String) : [String(a.file ?? a.path ?? "")].filter(Boolean);
      const revision = resolveMcpRevision(store, a);
      if (revision.error) return revision.error;
      return { ...affectedByFiles(store, paths, { revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_path": {
      const from = String(a.from ?? a.source ?? "");
      const to = String(a.to ?? a.target ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, from));
      if (revision.error) return revision.error;
      return { ...exploreGraph(store, "path", from, { to, depth: a.depth as number | undefined, limit: a.limit as number | undefined, revision: revision.context }), ...(revision.context ? { revision: revision.context } : {}), ...scopeEnvelopeFields(revision.scope) };
    }
    case "knowledge_service_graph":
      return serviceGraph(store);
    case "knowledge_local_graph":
      return graphNeighborhood(store, String(a.node ?? a.target ?? ""), { depth: Number(a.depth ?? 1) });
    case "knowledge_repository_graph": {
      const repoSelector = String(a.repo ?? "");
      const repoId = store.resolveRepoIds(repoSelector)[0];
      if (!repoId) return { error: "repo not found", repo: repoSelector };
      const branch = store.getBranch(repoId, a.branch == null ? undefined : String(a.branch));
      if (!branch) return { error: "branch not found", repo: repoSelector, branch: a.branch };
      return repoGraph(store, repoId, branch.id);
    }
    case "knowledge_timeline":
      return timeline(store, { limit: Number(a.limit ?? 50), repoId: typeof a.repo === "string" ? store.resolveRepoIds(a.repo)[0] : undefined });
    case "knowledge_recent":
      return exploreGraph(store, "recent_changes", String(a.node ?? a.target ?? ""), { limit: Number(a.limit ?? 50) });
    case "knowledge_files": {
      const repoId = store.resolveRepoIds(String(a.repo ?? ""))[0];
      if (!repoId) return { error: "repo not found" };
      const branch = store.getBranch(repoId, a.branch == null ? undefined : String(a.branch));
      if (!branch) return { error: "branch not found" };
      return listIndexedFiles(store, repoId, branch.id);
    }
    case "knowledge_file_symbols":
      return listFileSymbols(store, String(a.branch_id ?? a.branch ?? ""), String(a.file_path ?? a.path ?? ""));
    case "knowledge_tag_list":
      return listTags(store);
    case "knowledge_response_sample_list":
      return endpointSamples(store, String(a.endpoint ?? a.target ?? ""));
    case "knowledge_response_sample_capture": {
      const endpoint = String(a.endpoint ?? a.endpoint_key ?? "");
      const endpointId = resolveEndpointId(store, endpoint);
      const event = store.recordKnowledge({ type: "response_sample_captured", origin: "mcp", method: "ASSERTED", actor: { type: "mcp", id: "mcp" }, target: { node_id: endpointId }, payload: { endpoint_id: endpointId, endpoint_key: endpoint, status: a.status ?? null, content_type: a.content_type ?? null, sample: String(a.sample ?? a.body ?? "") } });
      return { ok: true, eventId: event.id, endpointId };
    }
    case "knowledge_snapshot_list":
      return store.listSnapshots();
    case "knowledge_branch_pin": {
      const repoId = store.resolveRepoIds(String(a.repo ?? ""))[0];
      const branch = repoId ? store.getBranch(repoId, String(a.branch ?? "")) : undefined;
      if (!branch) return { error: "BRANCH_NOT_FOUND" };
      return { ok: true, repoId, branchId: branch.id, pinned: store.toggleBranchPinned(branch.id) };
    }
    case "knowledge_doctor": {
      const consistency = store.consistencyCheck();
      return { ...consistency, integrity: store.db.prepare("PRAGMA integrity_check").get(), foreignKeys: store.db.prepare("PRAGMA foreign_key_check").all() };
    }
    case "knowledge_explain": {
      const target = String(a.target ?? a.symbol ?? "");
      const pack = buildContextPack(store, target, {});
      return { target, summary: pack.focus ? `${pack.focus.nodeType}: ${pack.focus.title}` : "target not found", context: pack, confidence: pack.focus ? "verified" : "unknown" };
    }
    case "knowledge_link_list":
      return store.db.prepare("SELECT id, src, dst, edge_type AS edgeType, status, provenance FROM edges WHERE status='active' ORDER BY id LIMIT ?").all(Math.min(Number(a.limit ?? 100), 500));
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
      return searchKnowledge(saved.request as never, { store });
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
