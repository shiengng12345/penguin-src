import type { NormalizedSearchRequest, SearchLane, SearchRequest } from "@penguin/knowledge-contracts";

export interface SearchPlan { request: NormalizedSearchRequest; stages: Array<{ lane: SearchLane; required: boolean; reason: string; budgetMs: number }>; }

export function planSearch(request: NormalizedSearchRequest | SearchRequest): SearchPlan {
  const normalized = request as NormalizedSearchRequest;
  const mode = normalized.mode;
  const semantic = normalized.options?.semantic ?? "off";
  // Explicit path mode is authoritative. Heuristics are only safe in auto:
  // exact/phrase/substring must accept punctuation such as `//`, URL paths,
  // regex-like source text and JSX without accidentally invoking path
  // normalization (which correctly rejects `..` and absolute paths).
  const pathLike = mode === "path" || (mode === "auto" && (normalized.query.includes("/") || /\.(ts|tsx|js|json|md|yaml|yml|sql|proto|rs|go|py)$/i.test(normalized.query)));
  const stages: SearchPlan["stages"] = [];
  if (pathLike) stages.push({ lane: "path", required: false, reason: "path heuristic or explicit path mode", budgetMs: 250 });
  if (["auto", "exact", "phrase", "substring", "regex"].includes(mode)) stages.push({ lane: "source", required: true, reason: "verified source retrieval", budgetMs: 1000 });
  if (["auto", "lexical", "structural"].includes(mode)) stages.push({ lane: "symbol", required: false, reason: "existing symbol/note index", budgetMs: 500 });
  if (semantic !== "off") stages.push({ lane: "semantic", required: semantic === "blend", reason: `semantic ${semantic}`, budgetMs: 1000 });
  return { request: normalized, stages };
}
