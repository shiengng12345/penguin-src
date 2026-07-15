// Pure tool definitions + name check for the Knowledge 6-pack (§8.1).
// IMPORTANT: this file must NOT import @penguin/knowledge-core (which pulls the
// native better-sqlite3). The MCP server imports ONLY this at top level so the
// release-bundled server initializes without the knowledge deps present; the
// actual handler (knowledge-tools.ts) is dynamically imported on first call.
export const KNOWLEDGE_TOOL_DEFS = [
  {
    name: "knowledge_search",
    description:
      "Searches SYMBOL NAMES + SIGNATURES and note bodies — NOT call-site text, NOT object-literal/type field names, NOT string literals. " +
      "Query terms are AND-matched (any order) against each symbol's bare name (e.g. searching \"CpmsRedisService.hset\" will find nothing — " +
      "search the bare method name \"hset\" instead; qualified/class-prefixed names are not indexed as a unit). " +
      "To answer \"who calls method X\": search the bare method name here first (results include identityKey/filePath to disambiguate " +
      "same-named methods across classes), then call explore_graph mode=who_calls on the matching node's id — call-graph edges already " +
      "exist and who_calls resolves them; searching for a call-site expression like \"obj.method()\" here will not. " +
      "An empty result means \"no symbol/note name matched\", not \"this doesn't exist in the code\" — a real field name, string literal, or " +
      "local variable reference can still be present in source but absent from this index. Sensitive pages excluded unless include_sensitive. Filters: type[], repo, limit.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        type: { type: "array", items: { type: "string" } },
        repo: {
          type: "string",
          description: "Repo's display name (as shown by index_status, e.g. \"fpms\" — case-insensitive) or its internal repo id. Unknown name → zero results, not an error.",
        },
        include_sensitive: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_node",
    description:
      "Node detail by id or identity/friendly name: symbol versions (per branch) or note body (respects mcp_access) + alias history.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, identity_key: { type: "string" } },
    },
  },
  {
    name: "explore_graph",
    description:
      "Graph traversal. mode = who_calls | calls_of | impact | backlinks | path | timeline | recent_changes | who_injects. " +
      "who_calls only follows direct call expressions — a NestJS/DI service that's constructor-injected (never directly called) " +
      "will show empty there even when heavily used; use who_injects on the SERVICE CLASS node (not a specific method) to find " +
      "every class that constructor-injects it. An empty nodes array is not enough to claim there is no relation: inspect " +
      "diagnostics.resolutionStatus and diagnostics.resultStatus (especially no_static_edge). options: depth, limit, to (for path).",
    inputSchema: {
      type: "object",
      required: ["mode", "node"],
      properties: {
        mode: {
          type: "string",
          enum: ["who_calls", "calls_of", "impact", "backlinks", "path", "timeline", "recent_changes", "who_injects"],
        },
        node: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
        to: { type: "string" },
      },
    },
  },
  {
    name: "knowledge_explore",
    description:
      "Default first call for code-understanding or editing work. Returns one bounded symbol/endpoint result with source, callers/calls, " +
      "linear call path, transitive blast radius, tests, routes, edge provenance/confidence, freshness, and queryDiagnostics. " +
      "Inspect queryDiagnostics before treating an empty relation as authoritative. Uses the same core result as `penguin explore`.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string" },
        branch: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "compare_branches",
    description: "Diff one symbol across two branches; equal content hash = no difference.",
    inputSchema: {
      type: "object",
      required: ["symbol", "branch_a", "branch_b"],
      properties: { symbol: { type: "string" }, branch_a: { type: "string" }, branch_b: { type: "string" } },
    },
  },
  {
    name: "write_note",
    description:
      "Safe write entry point (Ledger-first). action = create_page | append_note | link_pages. AI writes drafts/appends only and must not touch sensitive pages.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["create_page", "append_note", "link_pages"] },
        title: { type: "string" },
        identity_key: { type: "string" },
        text: { type: "string" },
        src: { type: "string" },
        dst: { type: "string" },
        edge_type: { type: "string" },
      },
    },
  },
  {
    name: "index_status",
    description:
      "Index status across repos/branches/workspaces. Use mode=compact for one bounded freshness row per repo; " +
      "the default detailed mode keeps full branches, trust, staleness, and counts.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["detailed", "compact"],
          description: "compact returns one bounded freshness row per repo; default is detailed.",
        },
      },
    },
  },
  {
    name: "list_suggestions",
    description: "Pending AI edge suggestions awaiting accept/reject (excluded from default search until accepted).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "suggest_links",
    description: "Propose an edge for confirmation (origin=ai, method=INFERRED). Stays out of default results until accepted. Returns the suggestion event id.",
    inputSchema: {
      type: "object",
      required: ["src", "dst"],
      properties: {
        src: { type: "string" }, dst: { type: "string" },
        edge_type: { type: "string" }, confidence: { type: "number" },
      },
    },
  },
  {
    name: "accept_suggestion",
    description: "Accept a pending suggestion by its event id (edge becomes active/ASSERTED).",
    inputSchema: { type: "object", required: ["suggestion_event_id"], properties: { suggestion_event_id: { type: "string" } } },
  },
  {
    name: "reject_suggestion",
    description: "Reject a pending suggestion by its event id.",
    inputSchema: { type: "object", required: ["suggestion_event_id"], properties: { suggestion_event_id: { type: "string" } } },
  },
  {
    name: "get_architecture",
    description:
      "Repo/branch/language overview: node+edge counts, per-language symbol counts, entry points, and \"hubs\" (highest-fan-in god-nodes — " +
      "the closest thing to 'what's the architecture' or 'what's most depended-on here').",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_communities",
    description:
      "Detects clusters of densely-interconnected nodes (community detection over the call/reference graph) — answers \"what are the major " +
      "subsystems/modules\" without a manual graph crawl. Returns each community's size, member repos, and top members by connectivity.",
    inputSchema: { type: "object", properties: { limit: { type: "number" }, min_size: { type: "number" } } },
  },
  {
    name: "find_dead_code",
    description:
      "Symbols with zero incoming calls/invokes/references edges — candidate dead code. A candidate can be a false positive (dynamic dispatch, " +
      "public API, reflection) — treat as leads to verify, not a deletion list.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
] as const;

const NAMES = new Set(KNOWLEDGE_TOOL_DEFS.map((t) => t.name));
export function isKnowledgeTool(name: string): boolean {
  return NAMES.has(name);
}
