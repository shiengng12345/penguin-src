import type { SearchHit } from "@penguin/knowledge-contracts";

export const LANE_WEIGHTS = { source: 1, path: 1, symbol: 0.85, graph: 0.8, note: 0.7, evidence: 0.75, semantic: 0.55 } as const;

/** Keep cosine similarity in its own bounded lane; never add it directly to
 * lexical/BM25 scores. */
export function semanticLaneScore(similarity: number): number {
  const normalized = Math.max(0, Math.min(1, ((Number.isFinite(similarity) ? similarity : 0) + 1) / 2));
  return LANE_WEIGHTS.semantic * normalized;
}

export function rankSearchHits(hits: SearchHit[]): SearchHit[] {
  return hits.map((hit) => ({
    ...hit,
    score: Math.round(hit.score * 1_000_000) / 1_000_000,
    rankReasons: [...hit.rankReasons, `lane_rank=${LANE_WEIGHTS[hit.lane] ?? 0}`],
  }))
    .sort((a, b) => b.score - a.score || a.locator.repoName.localeCompare(b.locator.repoName) || a.locator.revisionId.localeCompare(b.locator.revisionId) || a.locator.filePath.localeCompare(b.locator.filePath) || (a.locator.startLine ?? 0) - (b.locator.startLine ?? 0) || (a.locator.startByte ?? 0) - (b.locator.startByte ?? 0) || a.hitId.localeCompare(b.hitId));
}
