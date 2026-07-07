// Pure tool definitions + name check for the Knowledge 6-pack (§8.1).
// IMPORTANT: this file must NOT import @penguin/knowledge-core (which pulls the
// native better-sqlite3). The MCP server imports ONLY this at top level so the
// release-bundled server initializes without the knowledge deps present; the
// actual handler (knowledge-tools.ts) is dynamically imported on first call.
export const KNOWLEDGE_TOOL_DEFS = [
  {
    name: "knowledge_search",
    description:
      "Unified knowledge search: titles → full text → graph neighbors, mixing notes/symbols/entities. Sensitive pages excluded unless include_sensitive. Filters: type[], repo, limit.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        type: { type: "array", items: { type: "string" } },
        repo: { type: "string" },
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
      "Graph traversal. mode = who_calls | calls_of | impact | backlinks | path | timeline | recent_changes. options: depth, limit, to (for path).",
    inputSchema: {
      type: "object",
      required: ["mode", "node"],
      properties: {
        mode: {
          type: "string",
          enum: ["who_calls", "calls_of", "impact", "backlinks", "path", "timeline", "recent_changes"],
        },
        node: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
        to: { type: "string" },
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
    description: "Index status across repos/branches/workspaces: staleness + counts (also answers list_repos / list_branches).",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const NAMES = new Set(KNOWLEDGE_TOOL_DEFS.map((t) => t.name));
export function isKnowledgeTool(name: string): boolean {
  return NAMES.has(name);
}
