import type { SearchHit } from "@penguin/knowledge-contracts";
import type { ParsedKnowledgeQuery } from "./search-planner.js";

export const SEARCH_RANKER_VERSION = "ranker-v2";
export const LANE_WEIGHTS = { source: 1, path: 1, symbol: 0.85, graph: 0.8, note: 0.7, evidence: 0.75, semantic: 0.55, vector: 0.55 } as const;

export interface RankTuple {
  exactIdentity: 0 | 1;
  exactTitle: 0 | 1;
  termCoverage: number;
  lanePriority: number;
  laneScore: number;
}

const LANE_PRIORITIES = { symbol: 3, source: 2, path: 2, graph: 1, note: 1, evidence: 1, semantic: 0, vector: 0 } as const;

function normalized(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

export function rankTupleForHit(hit: SearchHit, parsed?: ParsedKnowledgeQuery): RankTuple {
  const identifier = normalized(parsed?.identifier);
  const query = normalized(parsed?.raw);
  const title = normalized(hit.title);
  const symbol = normalized(hit.symbol);
  const exactIdentity: 0 | 1 = identifier && hit.nodeId && (title === identifier || symbol === identifier) ? 1 : 0;
  const exactTitle: 0 | 1 = query && (title === query || symbol === query || title === identifier) ? 1 : 0;
  const searchable = [hit.title, hit.symbol, hit.locator.filePath, hit.snippet].filter(Boolean).join(" ").toLocaleLowerCase();
  const terms = parsed?.terms ?? [];
  const reportedCoverage = hit.rankReasons.find((reason) => /^business intent term coverage=\d+\/\d+$/u.test(reason))?.match(/=(\d+)\/(\d+)$/u);
  const termCoverage = reportedCoverage
    ? Number(reportedCoverage[1]) / Math.max(1, Number(reportedCoverage[2]))
    : terms.length === 0
      ? 0
      : terms.filter((term) => searchable.includes(term.toLocaleLowerCase())).length / terms.length;
  return {
    exactIdentity,
    exactTitle,
    termCoverage,
    lanePriority: LANE_PRIORITIES[hit.lane] ?? 0,
    laneScore: Number.isFinite(hit.score) ? hit.score : 0,
  };
}

/** Keep cosine similarity in its own bounded lane; never add it directly to
 * lexical/BM25 scores. */
export function semanticLaneScore(similarity: number): number {
  const normalized = Math.max(0, Math.min(1, ((Number.isFinite(similarity) ? similarity : 0) + 1) / 2));
  return LANE_WEIGHTS.semantic * normalized;
}

export function rankSearchHits(hits: SearchHit[], parsed?: ParsedKnowledgeQuery): SearchHit[] {
  return hits.map((hit) => ({
    ...hit,
    score: Math.round(hit.score * 1_000_000) / 1_000_000,
    rankReasons: [...hit.rankReasons, `lane_rank=${LANE_WEIGHTS[hit.lane] ?? 0}`, ...(parsed ? (() => { const tuple = rankTupleForHit(hit, parsed); return [`rank_tuple=${tuple.exactIdentity}/${tuple.exactTitle}/${tuple.termCoverage.toFixed(4)}/${tuple.lanePriority}/${tuple.laneScore.toFixed(6)}`]; })() : [])],
  }))
    .sort((a, b) => {
      const left = rankTupleForHit(a, parsed);
      const right = rankTupleForHit(b, parsed);
      return right.exactIdentity - left.exactIdentity
        || right.exactTitle - left.exactTitle
        || right.termCoverage - left.termCoverage
        || right.lanePriority - left.lanePriority
        || right.laneScore - left.laneScore
        || a.locator.repoName.localeCompare(b.locator.repoName)
        || a.locator.revisionId.localeCompare(b.locator.revisionId)
        || a.locator.filePath.localeCompare(b.locator.filePath)
        || (a.locator.startLine ?? 0) - (b.locator.startLine ?? 0)
        || (a.locator.startByte ?? 0) - (b.locator.startByte ?? 0)
        || a.hitId.localeCompare(b.hitId);
    });
}
