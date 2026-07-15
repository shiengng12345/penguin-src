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
  type GraphMode,
} from "@penguin/knowledge-core";

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
export function runKnowledgeTool(name: string, a: Record<string, unknown>): unknown {
  const store = openKnowledgeStore();
  try {
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

// Dispatch a knowledge tool call. `store` may be null when the knowledge DB
// hasn't been created yet (no `penguin init`) — read tools then return a hint
// instead of crashing (§9).
export function handleKnowledgeTool(
  name: string,
  a: Record<string, unknown>,
  store: KnowledgeStore | null,
): unknown {
  if (!store) {
    return { error: "knowledge not initialized — run `penguin init` or open Penguin app" };
  }
  switch (name) {
    case "knowledge_search":
      return {
        results: search(store, String(a.query ?? ""), {
          type: a.type as string[] | undefined,
          repo: a.repo as string | undefined,
          includeSensitive: !!a.include_sensitive,
          limit: a.limit as number | undefined,
        }),
      };
    case "get_node": {
      const key = (a.id ?? a.identity_key) as string | undefined;
      return getNodeDetail(store, key ?? "") ?? { error: "node not found" };
    }
    case "explore_graph":
      return exploreGraph(store, a.mode as GraphMode, String(a.node ?? ""), {
        depth: a.depth as number | undefined,
        limit: a.limit as number | undefined,
        to: a.to as string | undefined,
      });
    case "knowledge_explore": {
      const target = String(a.target ?? "");
      const requestedBranch = a.branch as string | undefined;
      let branchId: string | undefined;
      if (requestedBranch) {
        const exact = store.db.prepare("SELECT id FROM branches WHERE id=?").get(requestedBranch) as { id: string } | undefined;
        branchId = exact?.id;
        if (!branchId) {
          const resolution = resolveSymbolMatches(store, target);
          const repoId = resolution.kind === "unique" ? store.getNode(resolution.nodeId)?.repo_id : null;
          const named = repoId
            ? store.db.prepare("SELECT id FROM branches WHERE repo_id=? AND name=? LIMIT 1").get(repoId, requestedBranch) as { id: string } | undefined
            : undefined;
          branchId = named?.id;
        }
        if (!branchId) return { error: `branch "${requestedBranch}" was not found for "${target}"` };
      }
      return buildExplorePack(store, target, {
        branchId,
        depth: a.depth as number | undefined,
        limit: a.limit as number | undefined,
      });
    }
    case "compare_branches":
      return (
        compareBranches(store, String(a.symbol ?? ""), String(a.branch_a ?? ""), String(a.branch_b ?? "")) ??
        { error: "symbol not found on one or both branches" }
      );
    case "index_status":
      return a.mode === "compact" ? compactIndexStatus(store) : indexStatus(store);
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
