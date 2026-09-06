import { HmacOperationCursorCodec, resolveLocalCursorSecret } from "./search-cursor.js";
import { buildKnowledgeListEnvelope } from "./query.js";
import type { KnowledgeStore } from "./store.js";
import { KnowledgeContractError } from "@penguin/knowledge-contracts";

export type CoverageDebtKind = "excluded" | "failed" | "stale" | "unresolved";

export interface CoverageDebtItem {
  kind: CoverageDebtKind;
  repoId: string;
  branchId?: string;
  snapshotId?: string;
  filePath: string;
  startLine?: number;
  sourceNodeId?: string;
  rawTarget?: string;
  reasonCode: string;
  reason: string;
  classification?: string;
}

export interface CoverageDebtRequest {
  repo?: string;
  repoId?: string;
  branchId?: string;
  revisionId?: string;
  path?: string;
  kind?: CoverageDebtKind;
  limit?: number;
  cursor?: string;
}

export interface CoverageDebtResult {
  items: CoverageDebtItem[];
  scope: Record<string, unknown> | null;
  revision: unknown;
  freshness: unknown;
  coverage: {
    status: "complete" | "partial" | "unknown";
    discovered: number | null;
    admitted: number | null;
    excluded: number | null;
    failed: number | null;
    stale: number | null;
    unresolvedReferences: number | null;
    reconciliation: {
      status: "reconciled" | "mismatch" | "unavailable";
      revisionId: string | null;
      itemCount: number | null;
      aggregateUnresolved: number | null;
      delta: number | null;
    };
  };
  completeness: "complete" | "lower_bound" | "partial" | "unknown";
  proofStatus: "proven" | "not_proven" | "candidate" | "unresolved";
  candidateCount: number | null;
  returnedCount: number;
  remainingCount: number | null;
  totalIsExact: boolean;
  truncated: boolean;
  nextCursor: string | null;
  gaps: string[];
  evidence: unknown;
}

const COVERAGE_CURSOR_CODEC = new HmacOperationCursorCodec(resolveLocalCursorSecret());

const KIND_ORDER: Record<CoverageDebtKind, number> = {
  excluded: 0,
  failed: 1,
  stale: 2,
  unresolved: 3,
};

function resolveRepo(store: KnowledgeStore, request: CoverageDebtRequest): string | undefined {
  const selector = request.repo ?? request.repoId;
  if (!selector) return undefined;
  const ids = store.resolveRepoIds(selector);
  if (ids.length === 0) {
    throw new KnowledgeContractError(
      "REPOSITORY_NOT_FOUND",
      `unknown repo: ${selector}; no indexed repo matches ${selector}`,
      { repo: selector, remediation: "call index_status({\"mode\":\"detailed\"}) and choose an indexed repository" },
    );
  }
  if (ids.length > 1) {
    throw new KnowledgeContractError(
      "INVALID_ARGUMENT",
      `repository selector is ambiguous: ${selector}`,
      { repo: selector, candidates: ids, remediation: "specify the repository id" },
    );
  }
  return ids[0];
}

function resolveBranch(store: KnowledgeStore, repoId: string | undefined, requested?: string): string | undefined {
  if (!repoId) return requested;
  if (requested) {
    const row = store.db.prepare(
      "SELECT id FROM branches WHERE repo_id=? AND (id=? OR name=?) AND status<>'gone'",
    ).get(repoId, requested, requested) as { id: string } | undefined;
    if (!row) {
      throw new KnowledgeContractError("INVALID_ARGUMENT", `branch ${requested} is not indexed for ${repoId}`, { repoId, branch: requested });
    }
    return row.id;
  }
  const row = store.db.prepare(
    `SELECT id FROM branches
      WHERE repo_id=? AND status='live'
      ORDER BY default_branch DESC, last_indexed_at DESC, id LIMIT 1`,
  ).get(repoId) as { id: string } | undefined;
  return row?.id;
}

function pathPrefix(path?: string): string | undefined {
  if (!path) return undefined;
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function parseLastKey(value: string | undefined): [number, string, number, string] | null {
  if (!value) return null;
  const [rank, filePath, line, id] = value.split("\u0000");
  const parsedRank = Number(rank);
  const parsedLine = Number(line);
  if (!Number.isInteger(parsedRank) || !filePath || !Number.isInteger(parsedLine) || !id) return null;
  return [parsedRank, filePath, parsedLine, id];
}

function sourceQueries(repoId: string | undefined, branchId: string | undefined, revisionId: string | undefined, kinds: CoverageDebtKind[]): { sql: string; params: unknown[] }[] {
  const repoFilter = repoId ? "repo_id=?" : "1=1";
  const repoParam = repoId ? [repoId] : [];
  const sources: { sql: string; params: unknown[] }[] = [];
  const addCoverage = (kind: CoverageDebtKind, rank: number): void => {
    if (!kinds.includes(kind)) return;
    sources.push({
      sql: `SELECT '${kind}' AS kind, ${rank} AS sortRank, repo_id AS repoId,
                    ? AS branchId, NULL AS snapshotId, file_path AS filePath,
                    NULL AS startLine, NULL AS sourceNodeId, NULL AS rawTarget,
                    reason_code AS reasonCode, reason, classification,
                    ('coverage:' || repo_id || ':' || file_path) AS id
               FROM coverage_records
              WHERE ${repoFilter} AND coverage_status='${kind}'`,
      params: [branchId ?? null, ...repoParam],
    });
  };
  addCoverage("excluded", KIND_ORDER.excluded);
  addCoverage("failed", KIND_ORDER.failed);
  addCoverage("stale", KIND_ORDER.stale);
  if (kinds.includes("unresolved")) {
    sources.push({
      sql: `SELECT 'unresolved' AS kind, ${KIND_ORDER.unresolved} AS sortRank,
                    repo_id AS repoId, branch_id AS branchId,
                    revision_id AS snapshotId, file_path AS filePath,
                    start_line AS startLine, source_node_id AS sourceNodeId,
                    raw_target AS rawTarget, reason_code AS reasonCode,
                    reason, classification, id
               FROM unresolved_reference_items
              WHERE ${repoFilter}${branchId ? " AND branch_id=?" : ""}${revisionId ? " AND revision_id=?" : ""}`,
      params: [...repoParam, ...(branchId ? [branchId] : []), ...(revisionId ? [revisionId] : [])],
    });
  }
  return sources;
}

function coverageReconciliation(
  store: KnowledgeStore,
  repoId: string | undefined,
  branchId: string | undefined,
  requestedRevisionId: string | undefined,
): CoverageDebtResult["coverage"]["reconciliation"] {
  if (!repoId || !branchId) {
    return { status: "unavailable", revisionId: null, itemCount: null, aggregateUnresolved: null, delta: null };
  }
  const revision = requestedRevisionId
    ?? (store.db.prepare(`
      SELECT revision_id AS revisionId
        FROM unresolved_reference_items
       WHERE repo_id=? AND branch_id=?
       GROUP BY revision_id
       ORDER BY MAX(created_at) DESC, revision_id DESC
       LIMIT 1
    `).get(repoId, branchId) as { revisionId: string } | undefined)?.revisionId
    ?? (store.db.prepare(`
      SELECT revision_id AS revisionId
        FROM unresolved_reference_coverage
       WHERE repo_id=? AND branch_id=?
       GROUP BY revision_id
       ORDER BY MAX(updated_at) DESC, revision_id DESC
       LIMIT 1
    `).get(repoId, branchId) as { revisionId: string } | undefined)?.revisionId;
  if (!revision) {
    return { status: "unavailable", revisionId: null, itemCount: null, aggregateUnresolved: null, delta: null };
  }
  const legacyAggregateRow = store.db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(total-resolved),0) AS aggregateUnresolved
      FROM unresolved_reference_coverage
     WHERE repo_id=? AND branch_id=? AND revision_id=?
  `).get(repoId, branchId, revision) as { rows: number; aggregateUnresolved: number };
  const currentLayer = store.db.prepare(
    "SELECT total-resolved AS aggregateUnresolved FROM coverage_layers WHERE repo_id=? AND branch_id=? AND layer='references'",
  ).get(repoId, branchId) as { aggregateUnresolved: number } | undefined;
  if (legacyAggregateRow.rows === 0 && !currentLayer) {
    return { status: "unavailable", revisionId: revision, itemCount: null, aggregateUnresolved: null, delta: null };
  }
  const itemRow = store.db.prepare(`
    SELECT COUNT(*) AS itemCount
      FROM unresolved_reference_items
     WHERE repo_id=? AND branch_id=? AND revision_id=?
  `).get(repoId, branchId, revision) as { itemCount: number };
  const itemCount = Number(itemRow.itemCount);
  const aggregateUnresolved = Math.max(0, Number(
    itemCount > 0 && legacyAggregateRow.rows > 0
      ? legacyAggregateRow.aggregateUnresolved
      : currentLayer?.aggregateUnresolved ?? legacyAggregateRow.aggregateUnresolved,
  ) || 0);
  if (itemCount === 0 && aggregateUnresolved > 0) {
    return { status: "unavailable", revisionId: revision, itemCount, aggregateUnresolved, delta: null };
  }
  const delta = itemCount - aggregateUnresolved;
  return {
    status: delta === 0 ? "reconciled" : "mismatch",
    revisionId: revision,
    itemCount,
    aggregateUnresolved,
    delta,
  };
}

function coverageTotals(store: KnowledgeStore, repoId: string | undefined, branchId: string | undefined, revisionId?: string): CoverageDebtResult["coverage"] {
  const row = (repoId
    ? store.db.prepare(`SELECT COUNT(*) AS discovered,
          COALESCE(SUM(coverage_status='admitted'),0) AS admitted,
          COALESCE(SUM(coverage_status='excluded'),0) AS excluded,
          COALESCE(SUM(coverage_status='failed'),0) AS failed,
          COALESCE(SUM(coverage_status='stale'),0) AS stale
        FROM coverage_records WHERE repo_id=?`).get(repoId)
    : store.db.prepare(`SELECT COUNT(*) AS discovered,
          COALESCE(SUM(coverage_status='admitted'),0) AS admitted,
          COALESCE(SUM(coverage_status='excluded'),0) AS excluded,
          COALESCE(SUM(coverage_status='failed'),0) AS failed,
          COALESCE(SUM(coverage_status='stale'),0) AS stale
        FROM coverage_records`).get()) as { discovered: number; admitted: number; excluded: number; failed: number; stale: number };
  const unresolvedWhere: string[] = [];
  const unresolvedParams: string[] = [];
  if (repoId !== undefined) { unresolvedWhere.push("repo_id=?"); unresolvedParams.push(repoId); }
  if (branchId !== undefined) { unresolvedWhere.push("branch_id=?"); unresolvedParams.push(branchId); }
  if (revisionId !== undefined) { unresolvedWhere.push("revision_id=?"); unresolvedParams.push(revisionId); }
  const unresolvedRow = store.db.prepare(
    `SELECT COUNT(*) AS count FROM unresolved_reference_items${unresolvedWhere.length ? ` WHERE ${unresolvedWhere.join(" AND ")}` : ""}`,
  ).get(...unresolvedParams) as { count: number };
  let unresolved: number | null = unresolvedRow.count > 0 ? unresolvedRow.count : null;
  if (unresolved === null && repoId && branchId) {
    try {
      const layer = store.db.prepare(
        "SELECT total - resolved AS n FROM coverage_layers WHERE repo_id=? AND branch_id=? AND layer='references'",
      ).get(repoId, branchId) as { n: number } | undefined;
      if (layer) unresolved = Math.max(0, Number(layer.n) || 0);
    } catch {
      unresolved = null;
    }
  }
  const hasRows = row.discovered > 0 || unresolved !== null;
  const reconciliation = coverageReconciliation(store, repoId, branchId, revisionId);
  return {
    status: !hasRows ? "unknown" : (row.excluded + row.failed + row.stale > 0 || unresolved === null || unresolved > 0 ? "partial" : "complete"),
    discovered: hasRows ? row.discovered : null,
    admitted: hasRows ? row.admitted : null,
    excluded: hasRows ? row.excluded : null,
    failed: hasRows ? row.failed : null,
    stale: hasRows ? row.stale : null,
    unresolvedReferences: unresolved,
    reconciliation,
  };
}

export function listCoverageDebt(store: KnowledgeStore, request: CoverageDebtRequest = {}): CoverageDebtResult {
  const repoId = resolveRepo(store, request);
  const branchId = resolveBranch(store, repoId, request.branchId);
  const revisionId = request.revisionId;
  const kind = request.kind;
  if (kind && !Object.hasOwn(KIND_ORDER, kind)) {
    throw new KnowledgeContractError("INVALID_ARGUMENT", `unsupported coverage debt kind: ${kind}`, { kind, allowed: Object.keys(KIND_ORDER) });
  }
  const kinds = kind ? [kind] : (Object.keys(KIND_ORDER) as CoverageDebtKind[]);
  const requestedLimit = Number(request.limit ?? 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
    throw new KnowledgeContractError("INVALID_ARGUMENT", "coverage limit must be an integer from 1 to 500", { limit: request.limit });
  }
  const limit = requestedLimit;
  const prefix = pathPrefix(request.path);
  const scopeKey = `${repoId ?? "*"}|${branchId ?? "*"}|${revisionId ?? "*"}|${kind ?? "all"}|${prefix ?? ""}`;
  let last: [number, string, number, string] | null = null;
  if (request.cursor) {
    const decoded = COVERAGE_CURSOR_CODEC.decode(request.cursor, { operation: "coverage", scope: scopeKey, revision: revisionId ?? branchId ?? null, limit });
    last = parseLastKey(decoded.lastKey);
    if (!last) throw new Error("CURSOR_INVALID");
  }
  const sources = sourceQueries(repoId, branchId, revisionId, kinds);
  const cte = `WITH debt AS (${sources.map((source) => source.sql).join(" UNION ALL ")})`;
  const filters: string[] = [];
  const params: unknown[] = sources.flatMap((source) => source.params);
  if (prefix) { filters.push("filePath LIKE ? ESCAPE '\\'"); params.push(`${escapeLikePrefix(prefix)}%`); }
  if (last) {
    filters.push(`(sortRank > ? OR (sortRank=? AND (filePath > ? OR
      (filePath=? AND (COALESCE(startLine,-1) > ? OR
       (COALESCE(startLine,-1)=? AND id>?))))))`);
    params.push(last[0], last[0], last[1], last[1], last[2], last[2], last[3]);
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const countRow = store.db.prepare(`${cte} SELECT COUNT(*) AS count FROM debt${prefix ? " WHERE filePath LIKE ? ESCAPE '\\'" : ""}`)
    .get(...sources.flatMap((source) => source.params), ...(prefix ? [`${escapeLikePrefix(prefix)}%`] : [])) as { count: number };
  const rows = store.db.prepare(`${cte} SELECT kind,repoId,branchId,snapshotId,filePath,startLine,sourceNodeId,rawTarget,reasonCode,reason,classification,id
    FROM debt${where} ORDER BY sortRank,filePath,COALESCE(startLine,-1),id LIMIT ?`)
    .all(...params, limit + 1) as Array<Record<string, unknown>>;
  const remainingRow = last
    ? store.db.prepare(`${cte} SELECT COUNT(*) AS count FROM debt${where}`).get(...params) as { count: number }
    : countRow;
  const page = rows.slice(0, limit).map((row): CoverageDebtItem => ({
    kind: row.kind as CoverageDebtKind,
    repoId: String(row.repoId),
    ...(row.branchId ? { branchId: String(row.branchId) } : {}),
    ...(row.snapshotId ? { snapshotId: String(row.snapshotId) } : {}),
    filePath: String(row.filePath),
    ...(row.startLine == null ? {} : { startLine: Number(row.startLine) }),
    ...(row.sourceNodeId ? { sourceNodeId: String(row.sourceNodeId) } : {}),
    ...(row.rawTarget ? { rawTarget: String(row.rawTarget) } : {}),
    reasonCode: String(row.reasonCode),
    reason: String(row.reason),
    ...(row.classification ? { classification: String(row.classification) } : {}),
  }));
  const truncated = rows.length > page.length;
  const lastPage = page.at(-1);
  const lastId = rows[page.length - 1]?.id as string | undefined;
  const nextCursor = truncated && lastPage && lastId
    ? COVERAGE_CURSOR_CODEC.encode({
        schemaVersion: "1", contractVersion: "2", operation: "coverage", scope: scopeKey,
        orderingKey: "kind,filePath,startLine,id",
        lastKey: `${KIND_ORDER[lastPage.kind]}\u0000${lastPage.filePath}\u0000${lastPage.startLine ?? -1}\u0000${lastId}`,
        revision: revisionId ?? branchId ?? null, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), limit,
      })
    : null;
  const totals = coverageTotals(store, repoId, branchId, revisionId);
  const hasKnownCoverage = totals.status !== "unknown";
  const candidateCount = hasKnownCoverage ? countRow.count : null;
  const coverageGaps = [
    ...(totals.status === "unknown" ? ["coverage_records_empty", "unresolved_reference_coverage_unavailable"] : []),
    ...(countRow.count > 0 ? ["coverage_debt_requires_remediation"] : []),
    ...(totals.reconciliation.status === "mismatch" ? ["coverage_reconciliation_mismatch"] : []),
    ...(totals.reconciliation.status === "unavailable" && totals.status !== "unknown" ? ["unresolved_reference_coverage_unavailable"] : []),
  ];
  const envelope = buildKnowledgeListEnvelope(store, page, {
    repoId,
    branchId,
    scope: { repoId: repoId ?? null, branchId: branchId ?? null, path: prefix ?? null, kind: kind ?? null },
    candidateCount,
    remainingCount: candidateCount == null ? null : Math.max(0, remainingRow.count - page.length),
    totalIsExact: candidateCount != null,
    truncated,
    nextCursor,
    completeness: "lower_bound",
    proofStatus: page.length ? "candidate" : "not_proven",
    gaps: coverageGaps,
  });
  return {
    ...envelope,
    coverage: totals,
    evidence: { ...envelope.evidence, coverage: totals },
  } as CoverageDebtResult;
}
