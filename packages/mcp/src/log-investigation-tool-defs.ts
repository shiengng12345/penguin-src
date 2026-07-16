export const LOG_INVESTIGATION_TOOL_DEFS = [
  {
    name: "list_sls_targets",
    description: "List verified multi-region Aliyun SLS targets and their project/logstore identity. Read-only; PROD is listed but never queried unless selected by the investigation request.",
    inputSchema: { type: "object", properties: { include_disabled: { type: "boolean" } } },
  },
  {
    name: "plan_log_investigation",
    description: "Plan a bounded read-only SLS investigation. The host calls Aliyun SLS as a sibling MCP using pending text-to-SQL/execute calls, then submits results to capture. PROD may be selected by auto/all/exact URL. No business RPC replay.",
    inputSchema: {
      type: "object", required: ["question", "time_range", "clues"], properties: {
        question: { type: "string" }, scope: { type: "string", enum: ["auto", "all", "targets"] }, target_ids: { type: "array", items: { type: "string" } }, sls_urls: { type: "array", items: { type: "string" } },
        time_range: { type: "object", required: ["from", "to", "timezone"], properties: { from: { type: "string" }, to: { type: "string" }, timezone: { type: "string" } } }, clues: { type: "object" }, budgets: { type: "object" },
      },
    },
  },
  {
    name: "capture_log_investigation",
    description: "Continue a planned sibling-MCP SLS investigation with phase-aware results. Final capture correlates Knowledge/Wiki/SLS and writes one sensitive-allowed target-scoped Markdown evidence note per target. No RPC replay.",
    inputSchema: { type: "object", required: ["continuation", "results"], properties: { continuation: { type: "object" }, results: { type: "array" } } },
  },
  {
    name: "list_evidence_notes",
    description: "List file-backed SLS evidence notes with target, lifecycle, hashes, observation count, and index status. Read-only.",
    inputSchema: { type: "object", properties: { target_id: { type: "string" }, status: { type: "string", enum: ["draft", "reviewed", "verified", "resolved", "archived"] }, limit: { type: "integer" } } },
  },
  {
    name: "set_evidence_status",
    description: "Advance one evidence note through the safe review lifecycle. Does not rewrite verified facts.",
    inputSchema: { type: "object", required: ["slug", "status"], properties: { slug: { type: "string" }, status: { type: "string", enum: ["reviewed", "verified", "resolved", "archived"] }, from: { type: "string" } } },
  },
  {
    name: "evidence_doctor",
    description: "Report evidence Markdown/index integrity, orphan rows, malformed notes, and stale locks. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "repair_evidence",
    description: "Reindex valid evidence Markdown and remove only dead stale locks. Does not modify evidence facts.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const NAMES = new Set<string>(LOG_INVESTIGATION_TOOL_DEFS.map((tool) => tool.name));
export function isLogInvestigationTool(name: string): boolean { return NAMES.has(name); }
