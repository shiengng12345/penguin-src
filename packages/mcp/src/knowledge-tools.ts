import { existsSync } from "node:fs";
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
  architecture,
  buildExplorePack,
  communities,
  deadCode,
  packageDependencies,
  dependencyPath,
  resolveRevisionContext,
  type RevisionContext,
  type GraphMode,
} from "@penguin/knowledge-core";
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

export async function runKnowledgeTool(name: string, a: Record<string, unknown>): Promise<unknown> {
  const store = openKnowledgeStore();
  try {
    if (name === "api_doc_generate") {
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
    if (name === "list_sls_targets") return slsRegistry().filter((target) => a.include_disabled === true || target.enabled);
    if (name === "plan_log_investigation") {
      const request = { ...a, timeRange: a.time_range, targetIds: a.target_ids, slsUrls: a.sls_urls } as unknown as InvestigationRequest;
      return await planLogInvestigation(request, { registry: slsRegistry(), stateStore: investigationStateStore(), knowledgePreflight: knowledgePreflight(store), now: () => new Date(), delay: async (ms, signal) => { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }); } });
    }
    if (name === "capture_log_investigation") {
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
    if (["list_evidence_notes", "set_evidence_status", "evidence_doctor", "repair_evidence"].includes(name)) {
      if (!store) return { error: "knowledge not initialized — run `penguin init` or capture evidence first" };
      const notesPackage = ["@penguin/knowledge-indexer", "notes"].join("/");
      const notes = await import(notesPackage);
      if (name === "list_evidence_notes") return notes.listEvidenceNotes({ store, notesDir: evidenceNotesDir(), targetId: a.target_id as string | undefined, status: a.status as never, limit: Number(a.limit ?? 100) });
      if (name === "set_evidence_status") return notes.setEvidenceStatus({ store, notesDir: evidenceNotesDir(), slug: String(a.slug ?? ""), to: String(a.status ?? "") as never, from: a.from as never });
      if (name === "evidence_doctor") return notes.evidenceDoctor({ store, notesDir: evidenceNotesDir() });
      return notes.repairEvidence({ store, notesDir: evidenceNotesDir() });
    }
    return handleKnowledgeTool(name, a, store);
  } finally {
    store?.close();
  }
}

function isSensitive(store: KnowledgeStore, nodeId: string): boolean {
  const row = store.db
    .prepare("SELECT sensitive, mcp_access FROM notes_index WHERE node_id=?")
    .get(nodeId) as { sensitive: number; mcp_access: string } | undefined;
  return !!row && (row.sensitive === 1 || row.mcp_access === "denied");
}

function resolveMcpRevision(
  store: KnowledgeStore,
  args: Record<string, unknown>,
  inferredRepoId?: string | null,
): { context?: RevisionContext; error?: Record<string, unknown> } {
  const selectorPresent = ["repo", "branch", "commit_sha", "snapshot_id"].some((key) => args[key] != null);
  if (!selectorPresent) return {};
  const repoSelector = typeof args.repo === "string" ? args.repo : inferredRepoId;
  if (!repoSelector) return { error: { error: "revision_repo_required", reason: "repo is required when selecting a branch, commit, or snapshot" } };
  const repoIds = store.resolveRepoIds(String(repoSelector));
  if (repoIds.length === 0) return { error: { error: "revision_repo_not_found", repo: repoSelector } };
  if (repoIds.length > 1) return { error: { error: "revision_repo_ambiguous", repo: repoSelector, candidates: repoIds } };
  const result = resolveRevisionContext(store, {
    repoId: repoIds[0],
    branch: args.branch as string | undefined,
    commitSha: args.commit_sha as string | undefined,
    snapshotId: args.snapshot_id as string | undefined,
  });
  if (result.status === "resolved") return { context: result.context };
  return {
    error: {
      error: result.status === "ambiguous" ? "revision_ambiguous" : "revision_not_found",
      reason: result.reason,
      candidates: result.candidates.map(({ repoId, branch, commitSha, snapshotId, trust }) => ({ repoId, branch, commitSha, snapshotId, trust })),
    },
  };
}

function nodeRepoId(store: KnowledgeStore, target: string): string | null {
  const resolution = resolveSymbolMatches(store, target);
  return resolution.kind === "unique" ? store.getNode(resolution.nodeId)?.repo_id ?? null : null;
}

// Dispatch a knowledge tool call. `store` may be null when the knowledge DB
// hasn't been created yet (no `penguin init`) — read tools then return a hint
// instead of crashing (§9).
export function handleKnowledgeTool(
  name: string,
  a: Record<string, unknown>,
  store: KnowledgeStore | null,
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
  if (!store) {
    return { error: "knowledge not initialized — run `penguin init` or open Penguin app" };
  }
  switch (name) {
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
        const revision = resolveMcpRevision(store, a);
        if (revision.error) return revision.error;
      return {
        results: search(store, String(a.query ?? ""), {
          type: a.type as string[] | undefined,
          repo: a.repo as string | undefined,
          includeSensitive: a.include_sensitive !== false,
          limit: a.limit as number | undefined,
          revision: revision.context,
        }),
        ...(revision.context ? { revision: revision.context } : {}),
      };
      }
    case "get_node": {
      const key = (a.id ?? a.identity_key) as string | undefined;
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, key ?? ""));
      if (revision.error) return revision.error;
      const detail = getNodeDetail(store, key ?? "", revision.context ? { revision: revision.context } : undefined);
      return detail ? { ...detail, ...(revision.context ? { revision: revision.context } : {}) } : { error: "node not found" };
    }
    case "explore_graph": {
      const node = String(a.node ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, node));
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
      return { ...result, ...(revision.context ? { revision: revision.context } : {}) };
    }
    case "compare_branches": {
      const symbol = String(a.symbol ?? "");
      const revision = resolveMcpRevision(store, a, nodeRepoId(store, symbol));
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
    case "list_sls_targets":
      return slsRegistry().filter((target) => a.include_disabled === true || target.enabled);
    default:
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
