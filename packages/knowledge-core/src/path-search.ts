import type { KnowledgeStore } from "./store.js";
import type { ResolvedRevisionScope } from "./source-search.js";

export interface PathSearchHit {
  filePath: string;
  lane: "path";
  coverageStatus: string;
  reasonCode: string;
  metadataOnly: boolean;
  sourceFactId?: string;
}

function normalizePath(query: string): string {
  const value = query.replaceAll("\\", "/");
  if (value === ".." || value.startsWith("../") || value.includes("/../") || value.startsWith("/")) throw new Error("PATH_OUTSIDE_WORKSPACE");
  return value.replace(/^\.\//, "");
}

export function searchPath(
  store: KnowledgeStore,
  scope: ResolvedRevisionScope,
  query: string,
  includeExcludedMetadata = false,
  options: { includeGenerated?: boolean; includeVendor?: boolean } = {},
): PathSearchHit[] {
  const normalized = normalizePath(query.trim());
  if (!normalized) return [];
  const hits: PathSearchHit[] = [];
  const sourceRows = store.db.prepare(`SELECT e.file_path AS filePath, e.source_fact_id AS sourceFactId, sf.coverage_json AS coverage
    FROM effective_snapshot_sources e JOIN source_facts sf ON sf.id=e.source_fact_id
    LEFT JOIN coverage_records c ON c.repo_id=sf.repo_id AND c.file_path=e.file_path
    WHERE e.snapshot_id=?
      AND (? OR COALESCE(c.classification, 'source') <> 'generated')
      AND (? OR COALESCE(c.classification, 'source') <> 'vendor')
      AND (e.file_path=? OR e.file_path LIKE ? OR e.file_path LIKE ? OR e.file_path LIKE ?)`)
    .all(scope.snapshotId, options.includeGenerated ? 1 : 0, options.includeVendor ? 1 : 0, normalized, `%/${normalized}`, `%${normalized}%`, `${normalized}%`) as Array<{ filePath: string; sourceFactId: string; coverage: string }>;
  for (const row of sourceRows) {
    const coverage = JSON.parse(row.coverage) as { status?: string; reasonCode?: string };
    hits.push({ filePath: row.filePath, lane: "path", coverageStatus: coverage.status ?? "admitted", reasonCode: coverage.reasonCode ?? "text_searchable", metadataOnly: false, sourceFactId: row.sourceFactId });
  }
  if (includeExcludedMetadata && scope.repoId) {
    const excluded = store.db.prepare(`SELECT file_path AS filePath, coverage_status AS coverageStatus, reason_code AS reasonCode
      FROM coverage_records WHERE repo_id=? AND coverage_status <> 'admitted'
        AND (file_path=? OR file_path LIKE ? OR file_path LIKE ? OR file_path LIKE ?)`)
      .all(scope.repoId, normalized, `%/${normalized}`, `%${normalized}%`, `${normalized}%`) as Array<{ filePath: string; coverageStatus: string; reasonCode: string }>;
    for (const row of excluded) if (!hits.some((hit) => hit.filePath === row.filePath)) hits.push({ ...row, lane: "path", metadataOnly: true });
  }
  const rank = (path: string): number => path === normalized ? 0 : path.endsWith(`/${normalized}`) ? 1 : path.includes(normalized) ? 2 : 3;
  return hits.sort((a, b) => rank(a.filePath) - rank(b.filePath) || a.filePath.localeCompare(b.filePath));
}
