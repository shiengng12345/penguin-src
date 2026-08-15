import type { SearchResponse } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search-engine.js";
import { searchLegacyRows, type LegacySearchFilters, type SearchResultRow } from "./query.js";

export type LegacySearchResponse = SearchResultRow[] & {
  /** Canonical v2 response retained during the compatibility window. */
  v2: SearchResponse;
  schemaVersion: "2";
  deprecation: { replacement: "knowledge.search"; removalVersion: string };
};

function requestFromLegacy(query: string, filters?: LegacySearchFilters): Record<string, unknown> {
  const revision = filters?.revision;
  const revisions = revision
    ? [{ ...(revision.repoId ? { repoId: revision.repoId } : {}), ...(revision.snapshotId ? { snapshotId: revision.snapshotId } : {}), ...(revision.branch ? { branch: revision.branch } : {}) }]
    : filters?.repo ? [{ repoName: filters.repo }] : undefined;
  return {
    query,
    mode: "auto",
    ...(revisions?.length ? { scope: { revisions } } : {}),
    ...(filters?.type?.length ? { scope: { ...(revisions?.length ? { revisions } : {}), kinds: filters.type } } : {}),
    options: { compact: false, includeExcludedMetadata: filters?.includeSensitive === true },
    page: { limit: filters?.limit ?? 50 },
  };
}

function nodeForHit(store: KnowledgeStore, hit: SearchResponse["hits"][number]): { nodeId: string | null; identityKey: string } {
  const explicit = hit.locator.nodeId ? store.getNode(hit.locator.nodeId) : undefined;
  if (explicit) return { nodeId: explicit.id, identityKey: explicit.identity_key };
  if (hit.locator.startLine != null) {
    const row = store.db.prepare(`SELECT n.id AS nodeId,n.identity_key AS identityKey FROM symbol_versions sv JOIN nodes n ON n.id=sv.node_id WHERE sv.file_path=? AND sv.start_line=? AND n.title=? ORDER BY (sv.status='fresh') DESC LIMIT 1`).get(hit.locator.filePath, hit.locator.startLine, hit.title) as { nodeId: string; identityKey: string } | undefined;
    if (row) return row;
  }
  return { nodeId: null, identityKey: `source::${hit.locator.repoId}::${hit.locator.filePath}::${hit.locator.startLine ?? 0}::${hit.title}` };
}

/**
 * Deprecated array-shaped compatibility facade. New callers use
 * `searchKnowledge`; old callers still receive the old rows, while the exact
 * v2 response is attached as a non-enumerable property for gradual migration.
 */
export function legacySearch(store: KnowledgeStore, query: string, filters?: LegacySearchFilters): LegacySearchResponse {
  const hasLiveSnapshot = Boolean(store.db.prepare("SELECT 1 FROM branches WHERE status='live' AND current_snapshot_id IS NOT NULL LIMIT 1").get());
  // A display-name repo filter is still representable by the old in-memory
  // rows when a fixture/database has no published snapshot yet. A true
  // revision request must use the canonical v2 path so scope diagnostics are
  // preserved.
  const requestedRevision = Boolean(filters?.revision);
  const v2 = hasLiveSnapshot || requestedRevision
    ? searchKnowledge(requestFromLegacy(query, filters) as never, { store })
    : null;
  // The legacy fields remain sourced from the proven row implementation during
  // the window. This preserves old ordering/field-node semantics exactly while
  // the attached `v2` response lets callers migrate and compare results.
  const rows = searchLegacyRows(store, query, filters);
  const result = rows as LegacySearchResponse;
  Object.defineProperties(result, {
    v2: { value: v2 ?? { schemaVersion: "2", hits: [], diagnostics: { requestId: "legacy-fallback", contractVersion: "2", capabilityHash: "", requestedScope: {}, resolvedScope: [], scopeApplied: false, resolvedScopes: [], searchedLanes: [], skippedLanes: [], coverage: { discovered: 0, admitted: 0, excluded: 0, failed: 0, stale: 0 }, exclusions: [], warnings: [{ code: "LEGACY_FALLBACK", message: "No live revision snapshot was available; legacy rows were preserved." }], suggestions: [], timingsMs: {}, candidateCount: 0, truncated: false }, page: { limit: filters?.limit ?? 50, totalIsExact: true, total: rows.length } }, enumerable: false },
    schemaVersion: { value: "2", enumerable: false },
    deprecation: { value: { replacement: "knowledge.search", removalVersion: "3.0.0" }, enumerable: false },
  });
  return result;
}
