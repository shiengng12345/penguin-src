import type { NormalizedSearchRequest, SearchLane, SearchRequest } from "@penguin/knowledge-contracts";

export const SEARCH_PLANNER_VERSION = "planner-v2";

export interface ParsedKnowledgeQuery {
  raw: string;
  identifier?: string;
  path?: string;
  terms: string[];
  intent: "exact_identifier" | "path_qualified" | "business_intent" | "free_text";
}

export interface SearchPlan {
  request: NormalizedSearchRequest;
  parsed: ParsedKnowledgeQuery;
  stages: Array<{ lane: SearchLane; required: boolean; reason: string; budgetMs: number }>;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/u;
const PATH_EXTENSION_SOURCE = "\\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|sql|proto|rs|go|py|java|kt|swift|rb|php|vue|html|css)";
const PATH_EXTENSION = new RegExp(`${PATH_EXTENSION_SOURCE}$`, "iu");

function queryTerms(value: string): string[] {
  return [...new Set(value.match(/[A-Za-z_$][\w$-]*/gu) ?? [])];
}

export function parseKnowledgeQuery(request: NormalizedSearchRequest | SearchRequest): ParsedKnowledgeQuery {
  const raw = request.query.trim();
  const mode = request.mode ?? "auto";
  // A colon/hash is a qualifier only when the left side is a repository path.
  // This avoids treating URLs, TypeScript type annotations, and ordinary
  // punctuation-heavy source queries as path-qualified requests.
  const qualified = raw.match(new RegExp(`^(.+${PATH_EXTENSION_SOURCE})(?:#|:)([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)$`, "iu"));
  if (qualified) {
    const path = qualified[1].replaceAll("\\", "/").replace(/^\.\//u, "");
    const identifier = qualified[2];
    return { raw, path, identifier, terms: queryTerms(identifier), intent: "path_qualified" };
  }
  if (IDENTIFIER.test(raw)) {
    return { raw, identifier: raw, terms: [raw], intent: "exact_identifier" };
  }
  const terms = queryTerms(raw);
  const intent = (mode === "auto" || mode === "lexical") && terms.length >= 2 ? "business_intent" : "free_text";
  return { raw, terms, intent };
}

export function planSearch(request: NormalizedSearchRequest | SearchRequest): SearchPlan {
  const normalized = request as NormalizedSearchRequest;
  const mode = normalized.mode ?? "auto";
  const parsed = parseKnowledgeQuery(normalized);
  const semantic = mode === "semantic" && (normalized.options?.semantic ?? "off") === "off"
    ? "blend"
    : normalized.options?.semantic ?? "off";
  // Explicit path mode is authoritative. Heuristics are only safe in auto:
  // exact/phrase/substring must accept punctuation such as `//`, URL paths,
  // regex-like source text and JSX without accidentally invoking path
  // normalization (which correctly rejects `..` and absolute paths).
  const pathLike = mode === "path" || parsed.intent === "path_qualified" || (mode === "auto" && (normalized.query.includes("/") || PATH_EXTENSION.test(normalized.query)));
  const stages: SearchPlan["stages"] = [];
  if (pathLike) stages.push({ lane: "path", required: false, reason: "path heuristic or explicit path mode", budgetMs: 250 });
  if (["auto", "exact", "phrase", "substring", "regex"].includes(mode) || parsed.intent === "business_intent") stages.push({ lane: "source", required: true, reason: "verified source retrieval", budgetMs: 1000 });
  if (["auto", "lexical", "structural"].includes(mode) || parsed.intent === "exact_identifier" || parsed.intent === "path_qualified") stages.push({ lane: "symbol", required: false, reason: "existing symbol/note index", budgetMs: 500 });
  if (semantic !== "off") stages.push({ lane: "semantic", required: semantic === "blend", reason: `semantic ${semantic}`, budgetMs: 1000 });
  return { request: normalized, parsed, stages };
}
