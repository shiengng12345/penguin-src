import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { KnowledgeStore } from "./store.js";
import { resolveRevisionContext, type RevisionContext } from "./revision.js";
import { legacyRevisionScope } from "./revision-scope.js";
import { openRevisionView, type RevisionEdgeRow, type RevisionSymbolRow } from "./revision-view.js";
import { assertTargetInScope, resolveTarget } from "./target-resolution.js";
import { HmacOperationCursorCodec, resolveLocalCursorSecret } from "./search-cursor.js";
import {
  KnowledgeContractError,
  classifyEndpointProvenanceKind,
  compareEndpointOccurrences,
  type EndpointOccurrence,
  type EndpointProvenanceKind,
  type EndpointPublicationReceipt,
} from "@penguin/knowledge-contracts";
import {
  graphEdgeEvidence,
  isExecutionEdge,
  isReferenceEdge,
  unresolvedGraphEdgeEvidence,
} from "./graph-evidence.js";
import type { GraphEdgeEvidenceEnvelope } from "@penguin/knowledge-contracts";
import { SCHEMA_VERSION } from "./schema.js";
import { readGitStateDefault, type GitState } from "./query-scope.js";
import { assertRuntimeIndexCompatible, runtimeIndexCompatibility, type RuntimeIndexCompatibility } from "./runtime-compatibility.js";

export type EvidenceCompleteness = "complete" | "lower_bound" | "partial" | "unknown";
export type EvidenceProofStatus = "proven" | "not_proven" | "candidate" | "unresolved";

const FRAMEWORK_EDGE_TYPES = ["injects", "provides", "implements", "dispatches_to"] as const;
const IMPACT_EDGE_TYPES = ["calls", ...FRAMEWORK_EDGE_TYPES] as const;
const DEPENDENCY_EDGE_TYPES = ["calls", "references", ...FRAMEWORK_EDGE_TYPES] as const;

export interface EvidenceEnvelope {
  scope: Record<string, unknown> | null;
  revision: RevisionContext | null;
  freshness: {
    status: "fresh" | "dirty" | "stale" | "unknown";
    indexedCommit: string | null;
    headCommit: string | null;
    dirtyFileCount: number | null;
  };
  coverage: {
    status: "complete" | "partial" | "unknown";
    discovered: number | null;
    admitted: number | null;
    excluded: number | null;
    failed: number | null;
    stale: number | null;
    unresolvedReferences: number | null;
  };
  completeness: EvidenceCompleteness;
  proofStatus: EvidenceProofStatus;
  candidateCount: number | null;
  returnedCount: number;
  truncated: boolean;
  cursor: string | null;
  gaps: string[];
}

export interface UnresolvedReferenceCoverageRow {
  repoId: string;
  branchId: string;
  filePath: string;
  revisionId: string;
  resolved: number;
  total: number;
  unresolved: number;
  updatedAt: string;
}

/** Read the revision-scoped reference-resolution ledger without requiring a
 * caller to know the SQLite table layout. Old databases return an empty list
 * until their additive schema is opened once. */
export function readUnresolvedReferenceCoverage(
  store: KnowledgeStore,
  filters: { repoId?: string; branchId?: string; filePath?: string; revisionId?: string } = {},
): UnresolvedReferenceCoverageRow[] {
  try {
    const where: string[] = [];
    const params: string[] = [];
    for (const [column, value] of [
      ["repo_id", filters.repoId],
      ["branch_id", filters.branchId],
      ["file_path", filters.filePath],
      ["revision_id", filters.revisionId],
    ] as const) {
      if (value !== undefined) { where.push(`${column}=?`); params.push(value); }
    }
    const rows = store.db.prepare(`
      SELECT repo_id AS repoId, branch_id AS branchId, file_path AS filePath,
             revision_id AS revisionId, resolved, total, total-resolved AS unresolved,
             updated_at AS updatedAt
        FROM unresolved_reference_coverage
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY repo_id, branch_id, file_path, revision_id
    `).all(...params) as UnresolvedReferenceCoverageRow[];
    return rows;
  } catch {
    return [];
  }
}

function coverageForEvidence(store: KnowledgeStore, repoId?: string, branchId?: string, revisionId?: string): EvidenceEnvelope["coverage"] {
  const row = (repoId
    ? store.db.prepare("SELECT COUNT(*) AS discovered, COALESCE(SUM(coverage_status='admitted'),0) AS admitted, COALESCE(SUM(coverage_status<>'admitted'),0) AS excluded, COALESCE(SUM(coverage_status='failed'),0) AS failed, COALESCE(SUM(coverage_status='stale'),0) AS stale FROM coverage_records WHERE repo_id=?").get(repoId)
    : store.db.prepare("SELECT COUNT(*) AS discovered, COALESCE(SUM(coverage_status='admitted'),0) AS admitted, COALESCE(SUM(coverage_status<>'admitted'),0) AS excluded, COALESCE(SUM(coverage_status='failed'),0) AS failed, COALESCE(SUM(coverage_status='stale'),0) AS stale FROM coverage_records").get()) as { discovered: number; admitted: number; excluded: number; failed: number; stale: number };
  const unresolvedRows = readUnresolvedReferenceCoverage(store, { repoId, branchId, revisionId });
  let unresolved: number | null = null;
  const hasCoverageRows = Number(row?.discovered ?? 0) > 0;
  try {
    const unresolvedWhere: string[] = [];
    const unresolvedParams: string[] = [];
    if (repoId !== undefined) { unresolvedWhere.push("repo_id=?"); unresolvedParams.push(repoId); }
    if (branchId !== undefined) { unresolvedWhere.push("branch_id=?"); unresolvedParams.push(branchId); }
    if (revisionId !== undefined) { unresolvedWhere.push("revision_id=?"); unresolvedParams.push(revisionId); }
    const concrete = store.db.prepare(
      `SELECT COUNT(*) AS count FROM unresolved_reference_items${unresolvedWhere.length ? ` WHERE ${unresolvedWhere.join(" AND ")}` : ""}`,
    ).get(...unresolvedParams) as { count: number };
    // The concrete work queue is deduplicated and therefore authoritative.
    // Keep unknown coverage as null, but do not let aggregate extraction-lane
    // duplicates inflate a known repository's public evidence count.
    // A zero-sized concrete queue only proves "zero unresolved" when the
    // revision also has an explicit reference-coverage record. Source-file
    // coverage alone cannot turn an unknown reference pass into a verified
    // negative result.
    if (concrete.count > 0) {
      unresolved = Number(concrete.count);
    } else if (repoId && branchId) {
      const layer = store.db.prepare(
        "SELECT total - resolved AS n FROM coverage_layers WHERE repo_id=? AND branch_id=? AND layer='references'",
      ).get(repoId, branchId) as { n: number } | undefined;
      if (layer) unresolved = Math.max(0, Number(layer.n) || 0);
      else if (unresolvedRows.length > 0) {
        // Compatibility for indexes written before the current coverage layer.
        unresolved = unresolvedRows.reduce((sum, item) => sum + Math.max(0, Number(item.unresolved) || 0), 0);
      }
    } else if (unresolvedRows.length > 0) {
      unresolved = unresolvedRows.reduce((sum, item) => sum + Math.max(0, Number(item.unresolved) || 0), 0);
    }
  } catch {
    unresolved = null;
  }
  if (unresolved === null) {
    if (unresolvedRows.length > 0) {
      unresolved = unresolvedRows.reduce((sum, item) => sum + Math.max(0, Number(item.unresolved) || 0), 0);
    } else if (repoId && branchId) {
      try {
        const layer = store.db.prepare(
          "SELECT total - resolved AS n FROM coverage_layers WHERE repo_id=? AND branch_id=? AND layer='references'",
        ).get(repoId, branchId) as { n: number } | undefined;
        if (layer) unresolved = Math.max(0, Number(layer.n) || 0);
      } catch {
        unresolved = null;
      }
    }
  }
  const coverage = {
    discovered: hasCoverageRows ? Number(row.discovered) : null,
    admitted: hasCoverageRows ? Number(row.admitted) : null,
    excluded: hasCoverageRows ? Number(row.excluded) : null,
    failed: hasCoverageRows ? Number(row.failed) : null,
    stale: hasCoverageRows ? Number(row.stale) : null,
    unresolvedReferences: unresolved,
  };
  const hasGap = !hasCoverageRows
    || (coverage.excluded ?? 0) > 0
    || (coverage.failed ?? 0) > 0
    || (coverage.stale ?? 0) > 0
    || coverage.unresolvedReferences === null
    || coverage.unresolvedReferences > 0;
  return {
    status: !hasCoverageRows ? "unknown" : hasGap ? "partial" : "complete",
    ...coverage,
  };
}

export function buildEvidenceEnvelope(
  store: KnowledgeStore,
  options: {
    repoId?: string;
    branchId?: string;
    revision?: RevisionContext;
    scope?: Record<string, unknown> | null;
    completeness: EvidenceCompleteness;
    proofStatus: EvidenceProofStatus;
    candidateCount: number | null;
    returnedCount: number;
    truncated?: boolean;
    cursor?: string | null;
    coverageGaps?: string[];
  },
): EvidenceEnvelope {
  const branchId = options.branchId ?? options.revision?.branchId;
  const trust = branchId ? trustEnvelopeForBranch(store, branchId) : null;
  const coverage = coverageForEvidence(store, options.repoId ?? options.revision?.repoId, branchId, options.revision?.snapshotId);
  return {
    scope: options.scope ?? (options.repoId || branchId ? { ...(options.repoId ? { repoId: options.repoId } : {}), ...(branchId ? { branchId } : {}) } : null),
    revision: options.revision ?? null,
    freshness: trust ? {
      status: trust.stale || trust.alignment === "head_advanced"
        ? "stale"
        : trust.alignment === "dirty"
          ? "dirty"
          : trust.alignment === "aligned"
            ? "fresh"
            : "unknown",
      indexedCommit: trust.indexedCommit,
      headCommit: trust.headCommit,
      dirtyFileCount: trust.dirtyFiles.length,
    } : { status: "unknown", indexedCommit: null, headCommit: null, dirtyFileCount: null },
    coverage,
    completeness: options.completeness,
    proofStatus: options.proofStatus,
    candidateCount: options.candidateCount == null ? null : Math.max(0, options.candidateCount),
    returnedCount: Math.max(0, options.returnedCount),
    truncated: options.truncated === true,
    cursor: options.cursor ?? null,
    gaps: [...new Set([
      ...(coverage.status === "unknown" ? ["coverage_records_empty"] : []),
      ...(coverage.unresolvedReferences === null ? ["unresolved_reference_coverage_unavailable"] : []),
      ...(trust ? [] : ["revision_provenance_unavailable"]),
      ...(options.coverageGaps ?? []),
    ])],
  };
}

export interface KnowledgeListEnvelopeOptions {
  repoId?: string;
  branchId?: string;
  revision?: RevisionContext;
  scope?: Record<string, unknown> | null;
  candidateCount?: number | null;
  remainingCount?: number | null;
  totalIsExact?: boolean;
  truncated?: boolean;
  nextCursor?: string | null;
  completeness?: EvidenceCompleteness;
  proofStatus?: EvidenceProofStatus;
  gaps?: string[];
}

function listRevision(store: KnowledgeStore, repoId?: string, branchId?: string): RevisionContext | undefined {
  if (!repoId) return undefined;
  const branch = (branchId
    ? store.db.prepare("SELECT id,name FROM branches WHERE id=? AND repo_id=? AND status<>'gone'").get(branchId, repoId)
    : store.db.prepare("SELECT id,name FROM branches WHERE repo_id=? AND status='live' ORDER BY last_indexed_at DESC,id LIMIT 1").get(repoId)) as { id: string; name: string } | undefined;
  if (!branch) return undefined;
  const resolved = resolveRevisionContext(store, { repoId, branch: branch.name });
  return resolved.status === "resolved" ? resolved.context : undefined;
}

/** Build one additive, backwards-compatible list contract for CLI and MCP. */
export function buildKnowledgeListEnvelope<T>(
  store: KnowledgeStore,
  items: T[],
  options: KnowledgeListEnvelopeOptions = {},
): {
  items: T[];
  scope: Record<string, unknown> | null;
  revision: RevisionContext | null;
  freshness: EvidenceEnvelope["freshness"];
  coverage: EvidenceEnvelope["coverage"];
  completeness: EvidenceCompleteness;
  proofStatus: EvidenceProofStatus;
  candidateCount: number | null;
  returnedCount: number;
  remainingCount: number | null;
  totalIsExact: boolean;
  truncated: boolean;
  nextCursor: string | null;
  gaps: string[];
  evidence: EvidenceEnvelope;
} {
  const revision = options.revision ?? listRevision(store, options.repoId, options.branchId);
  const candidateCount = options.candidateCount === undefined ? items.length : options.candidateCount;
  const totalIsExact = options.totalIsExact ?? candidateCount !== null;
  const completeness = options.completeness
    ?? (items.length > 0 ? "lower_bound" : totalIsExact ? "partial" : "unknown");
  const proofStatus = options.proofStatus ?? (items.length > 0 ? "candidate" : "not_proven");
  const evidence = buildEvidenceEnvelope(store, {
    repoId: options.repoId,
    branchId: options.branchId,
    revision,
    scope: options.scope,
    completeness,
    proofStatus,
    candidateCount,
    returnedCount: items.length,
    truncated: options.truncated,
    cursor: options.nextCursor,
    coverageGaps: options.gaps,
  });
  return {
    items,
    scope: evidence.scope,
    revision: evidence.revision,
    freshness: evidence.freshness,
    coverage: evidence.coverage,
    completeness,
    proofStatus,
    candidateCount,
    returnedCount: items.length,
    remainingCount: options.remainingCount ?? (candidateCount == null ? null : Math.max(0, candidateCount - items.length)),
    totalIsExact,
    truncated: options.truncated === true,
    nextCursor: options.nextCursor ?? null,
    gaps: evidence.gaps,
    evidence,
  };
}

export function withEvidenceEnvelope<T extends Record<string, unknown>>(
  store: KnowledgeStore,
  result: T,
  options: Parameters<typeof buildEvidenceEnvelope>[1],
): T & { evidence: EvidenceEnvelope } {
  return { ...result, evidence: buildEvidenceEnvelope(store, options) };
}

/** Expose the common evidence contract at the response root as well as under
 * `evidence`. The root fields keep older CLI/MCP consumers interoperable while
 * the nested object remains the canonical grouped envelope. */
function publicEvidenceFields(
  store: KnowledgeStore,
  result: object,
  options: Parameters<typeof buildEvidenceEnvelope>[1],
): Record<string, unknown> {
  const evidence = buildEvidenceEnvelope(store, options);
  const existing = result as Record<string, unknown>;
  return {
    ...result,
    evidence,
    scope: evidence.scope,
    revision: evidence.revision,
    freshness: evidence.freshness,
    coverage: evidence.coverage,
    // Context/Explore already expose a richer `{status,note}` completeness
    // object. Keep that public contract and place the normalized scalar in the
    // nested evidence envelope; list/search surfaces without a richer field
    // receive the scalar at the root.
    completeness: existing.completeness ?? evidence.completeness,
    proofStatus: evidence.proofStatus,
    candidateCount: evidence.candidateCount,
    returnedCount: evidence.returnedCount,
    truncated: existing.truncated ?? evidence.truncated,
    cursor: evidence.cursor,
  };
}

// The single query implementation shared by MCP tools, the CLI, and the UI
// (§8). Results carry provenance/staleness where applicable (§3.3/§4.4).

export interface SearchResultRow {
  // null only for a "field" hit (object-literal key / interface / type-alias
  // / class field name) — these are file:line index entries, not graph
  // nodes, so there's no id get_node could ever resolve.
  nodeId: string | null;
  nodeType: string;
  title: string;
  snippet: string | null;
  identityKey: string;
  filePath: string | null;
  branch: string | null;
  rank: number | null;
  // Only populated for "field" hits — symbol/note hits carry their line via
  // the caller looking up symbol_versions/get_node instead.
  startLine?: number | null;
}

export interface RevisionQueryOptions {
  revision?: RevisionContext;
  limit?: number;
}

export interface LegacySearchFilters extends RevisionQueryOptions {
  type?: string[];
  repo?: string;
  workspace?: string;
  includeSensitive?: boolean;
}

function snapshotNodeIds(store: KnowledgeStore, revision?: RevisionContext): Set<string> | null {
  if (!revision || revision.snapshotId.startsWith("legacy:")) return null;
  return new Set(openRevisionView(store, revision).symbolVersions().map((row) => row.nodeId));
}

interface SnapshotEdgePair {
  src: string;
  dst: string | null;
  edgeType: string;
  method: string | null;
  confidence: number | null;
  provenance: Record<string, unknown> | null;
  scope: "revision" | "global" | "legacy_global" | null;
}

function resolveIdentityNodeIds(store: KnowledgeStore, identityKeys: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const unique = [...new Set(identityKeys.filter(Boolean))];
  // Stay well below SQLite's variable ceiling and perform a bounded number of
  // bulk lookups. The previous per-edge findNodeIdByIdentity loop turned a
  // 10k-edge service graph into tens of thousands of synchronous queries.
  for (let offset = 0; offset < unique.length; offset += 2_000) {
    const chunk = unique.slice(offset, offset + 2_000);
    const rows = store.db.prepare(
      `SELECT id,identity_key AS identityKey FROM nodes WHERE identity_key IN (${chunk.map(() => "?").join(",")})`,
    ).all(...chunk) as Array<{ id: string; identityKey: string }>;
    for (const row of rows) ids.set(row.identityKey, row.id);
  }
  return ids;
}

function snapshotEdgePairs(
  store: KnowledgeStore,
  revision: RevisionContext,
  options: { edgeTypes?: string[]; limit?: number } = {},
): SnapshotEdgePair[] {
  const view = openRevisionView(store, revision);
  const edges = view.edges({ edgeTypes: options.edgeTypes, limit: options.limit ?? 10_000 });
  const ids = resolveIdentityNodeIds(store, edges.flatMap((edge) => [edge.srcIdentityKey, edge.dstIdentityKey ?? ""]));
  return edges.map((edge) => ({
    src: ids.get(edge.srcIdentityKey) ?? store.findNodeIdByIdentity(edge.srcIdentityKey) ?? edge.srcIdentityKey,
    dst: edge.dstIdentityKey ? (ids.get(edge.dstIdentityKey) ?? store.findNodeIdByIdentity(edge.dstIdentityKey) ?? edge.dstIdentityKey) : null,
    edgeType: edge.edgeType,
    method: edge.method ?? null,
    confidence: Number.isFinite(edge.confidence) ? edge.confidence : null,
    provenance: edge.provenance ?? null,
    scope: edge.scope ?? null,
  }));
}

function snapshotEdgePairsForNodes(
  store: KnowledgeStore,
  revision: RevisionContext,
  nodeIds: string[],
  options: { edgeTypes?: string[]; direction?: "in" | "out" | "both"; limit?: number },
): SnapshotEdgePair[] {
  if (nodeIds.length === 0) return [];
  const edges = openRevisionView(store, revision).edges({
    nodeIds,
    edgeTypes: options.edgeTypes,
    direction: options.direction,
    limit: options.limit,
    includeGlobal: false,
  });
  const identityKeys = [...new Set(edges.flatMap((edge) => [edge.srcIdentityKey, edge.dstIdentityKey].filter((key): key is string => Boolean(key))))];
  if (identityKeys.length === 0) return [];
  const ids = resolveIdentityNodeIds(store, identityKeys);
  return edges.map((edge) => ({
    src: ids.get(edge.srcIdentityKey) ?? edge.srcIdentityKey,
    dst: edge.dstIdentityKey ? (ids.get(edge.dstIdentityKey) ?? edge.dstIdentityKey) : null,
    edgeType: edge.edgeType,
    method: edge.method ?? null,
    confidence: Number.isFinite(edge.confidence) ? edge.confidence : null,
    provenance: edge.provenance ?? null,
    scope: edge.scope ?? null,
  }));
}

function revisionBranchId(options?: { revision?: RevisionContext; branchId?: string }): string | undefined {
  return options?.revision?.branchId ?? options?.branchId;
}

function isCurrentRevisionSnapshot(store: KnowledgeStore, revision: RevisionContext, filePaths?: string[]): boolean {
  if (!revision.branchId || revision.snapshotId.startsWith("legacy:")) return false;
  const branch = store.db.prepare(
    "SELECT current_snapshot_id AS snapshotId FROM branches WHERE id=? AND repo_id=?",
  ).get(revision.branchId, revision.repoId) as { snapshotId: string | null } | undefined;
  if (branch?.snapshotId !== revision.snapshotId) return false;
  if (!filePaths?.length) return true;
  return Boolean(store.db.prepare(
    `SELECT 1 FROM symbol_versions
      WHERE branch_id=? AND status='fresh' AND file_path IN (${filePaths.map(() => "?").join(",")}) LIMIT 1`,
  ).get(revision.branchId, ...filePaths));
}

function nodeVisibleInRevision(store: KnowledgeStore, nodeId: string, revision?: RevisionContext): boolean {
  if (revision?.snapshotId && !revision.snapshotId.startsWith("legacy:")) return openRevisionView(store, revision).symbolVersions([nodeId]).length > 0 || ["note", "endpoint", "service"].includes(store.getNode(nodeId)?.node_type ?? "");
  if (!revision?.branchId) return true;
  const node = store.getNode(nodeId);
  if (!node || node.node_type === "note" || node.repo_id == null || node.node_type === "endpoint" || node.node_type === "service") return true;
  return Boolean(
    store.db.prepare("SELECT 1 FROM symbol_versions WHERE node_id=? AND branch_id=? AND status <> 'deleted' LIMIT 1")
      .get(nodeId, revision.branchId),
  );
}

function resolveNodeId(store: KnowledgeStore, idOrKey: string, repoId?: string): string | null {
  const r = resolveSymbolMatches(store, idOrKey, repoId ? { repoId } : undefined);
  return r.kind === "unique" ? r.nodeId : null;
}

// A candidate when a name resolves to more than one symbol — enough to both
// display ("which one?") and act on directly (nodeId feeds straight back into
// context/flow, no re-typing the ambiguous name).
export interface SymbolCandidate {
  nodeId: string;
  nodeType: string;
  identityKey: string;
  title: string;
  filePath: string | null;
  branch: string | null;
  startLine: number | null;
}

export type SymbolResolution =
  | { kind: "unique"; nodeId: string }
  | { kind: "ambiguous"; candidates: SymbolCandidate[] }
  | { kind: "none" };

// Cap on ambiguous candidates returned/rendered — a name shared by hundreds of
// symbols (generic getters etc.) would otherwise dump an unusable wall of text;
// zero/unique/truly-few-candidates are the cases this feature is for.
const MAX_AMBIGUOUS_CANDIDATES = 20;

type SymbolCandidateScope = {
  branchId?: string;
  revision?: RevisionContext;
  /** Constrains WHICH symbol a bare name resolves to. Without it `--repo` only
   * decorated the answer's scope envelope while resolution still searched every
   * indexed repo: asking for one repo's `CMSGenBaseResponse` returned a ten-way
   * ambiguity across ten repos, and a name unique in the target repo could
   * silently resolve to a same-named symbol in another one. */
  repoId?: string;
};

function symbolCandidateOf(
  store: KnowledgeStore,
  nodeId: string,
  scope?: SymbolCandidateScope,
): SymbolCandidate {
  const n = store.getNode(nodeId)!;
  const scopedBranchId = scope?.revision?.branchId ?? scope?.branchId;
  let v: { filePath: string | null; branchId: string | null; startLine: number | null } | undefined;
  if (scope?.revision && !scope.revision.snapshotId.startsWith("legacy:")) {
    const row = openRevisionView(store, scope.revision).symbolVersions([nodeId])[0];
    if (row) {
      v = {
        filePath: row.filePath,
        branchId: scope.revision.branchId ?? null,
        startLine: row.startLine ?? null,
      };
    }
  } else if (scopedBranchId) {
    v = store.db
      .prepare(
        `SELECT file_path AS filePath, branch_id AS branchId, start_line AS startLine
         FROM symbol_versions
         WHERE node_id=? AND branch_id=? AND status='fresh'
         LIMIT 1`,
      )
      .get(nodeId, scopedBranchId) as typeof v;
  } else {
    v = store.db
      .prepare(
        `SELECT file_path AS filePath, branch_id AS branchId, start_line AS startLine
         FROM symbol_versions WHERE node_id=? ORDER BY (status='fresh') DESC LIMIT 1`,
      )
      .get(nodeId) as typeof v;
  }
  const branch = v?.branchId
    ? ((store.db.prepare("SELECT name FROM branches WHERE id=?").get(v.branchId) as { name: string } | undefined)?.name ?? v.branchId)
    : null;
  return {
    nodeId, nodeType: n.node_type, identityKey: n.identity_key, title: n.title,
    filePath: v?.filePath ?? null, branch, startLine: v?.startLine ?? null,
  };
}

// Resolve a user-typed name/id to EXACTLY one of three outcomes — ambiguity
// must never collapse into "not found" (that's what silently broke `context`/
// `flow` for any name shared by 2+ symbols, e.g. several classes each with a
// same-named method). `symbol:<node-id>` is an explicit escape hatch a
// disambiguation prompt can suggest back to the caller.
export function resolveSymbolMatches(
  store: KnowledgeStore,
  idOrKey: string,
  scope?: SymbolCandidateScope,
): SymbolResolution {
  // Public continuation identifiers are emitted as `node:<id>` (symbols may
  // also be suggested as `symbol:<id>`). Normalize both forms here so every
  // graph/context command shares the same round-trip contract.
  const raw = normalizeNodeSelector(idOrKey);
  // Honour an explicit repo on every path, not just the name fallback: a direct
  // identity hit in a DIFFERENT repo is exactly the silent wrong-answer case —
  // `explore accumulatePlayerDeposit --repo FPMS-NT` came back with another
  // repo's symbol, empty callers and callees, and nothing but the trust block
  // to say so.
  const inScope = (nodeId: string): boolean =>
    !scope?.repoId || store.getNode(nodeId)?.repo_id === scope.repoId
      || ["endpoint", "service"].includes(store.getNode(nodeId)?.node_type ?? "");
  const direct = store.getNode(raw);
  if (direct) {
    if (inScope(raw)) return { kind: "unique", nodeId: raw };
    return { kind: "none" };
  }
  const r = store.resolveIdentity(raw);
  if (r && inScope(r.nodeId)) return { kind: "unique", nodeId: r.nodeId };
  // A path-qualified target is the safest form for common method names.  The
  // path is repo-relative and the symbol is resolved only among versions in
  // that file, so a same-named symbol in another app/repository cannot win by
  // accident.  Keep the syntax deliberately small: `path#symbol` and
  // `repo:path#symbol` (the latter is handled by the repo-prefix branch below).
  const hash = raw.lastIndexOf("#");
  if (hash > 0 && hash < raw.length - 1) {
    let filePath = raw.slice(0, hash).replaceAll("\\", "/").replace(/^\.\//, "");
    let pathRepoId = scope?.repoId;
    const colon = filePath.indexOf(":");
    if (colon > 0) {
      const repoIds = store.resolveRepoIds(filePath.slice(0, colon));
      if (repoIds.length === 1) {
        pathRepoId = pathRepoId && pathRepoId !== repoIds[0] ? "__path_repo_mismatch__" : repoIds[0];
        filePath = filePath.slice(colon + 1);
      }
    }
    const symbolName = raw.slice(hash + 1);
    const pathRows = store.db.prepare(
      `SELECT DISTINCT sv.node_id AS id
         FROM symbol_versions sv
         JOIN nodes n ON n.id = sv.node_id
        WHERE sv.file_path=? AND sv.status='fresh'
          AND (n.title=? OR n.identity_key LIKE ? OR n.identity_key LIKE ?)
          ${pathRepoId ? "AND n.repo_id=?" : ""}
        ORDER BY sv.start_line`,
    ).all(...(pathRepoId
      ? [filePath, symbolName, `%::${symbolName}`, `%.${symbolName}`, pathRepoId]
      : [filePath, symbolName, `%::${symbolName}`, `%.${symbolName}`])) as { id: string }[];
    const uniqueIds = [...new Set(pathRows.map((row) => row.id))];
    if (uniqueIds.length === 1) return { kind: "unique", nodeId: uniqueIds[0] };
    if (uniqueIds.length > 1) {
      const candidates = uniqueIds.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((nodeId) => symbolCandidateOf(store, nodeId, scope));
      return { kind: "ambiguous", candidates };
    }
    return { kind: "none" };
  }
  // Human-friendly repo prefix: `auth::Class.method` or
  // `auth::src/file.ts::Class.method`. Repo ids are random on a fresh DB, so
  // prompts, benchmarks and notes must not need to preserve `repo_<uuid>`.
  const repoSeparator = raw.indexOf("::");
  if (repoSeparator > 0 && !raw.startsWith("repo_") && !raw.startsWith("grpc::")) {
    const repoPrefix = raw.slice(0, repoSeparator);
    const suffix = raw.slice(repoSeparator + 2);
    const resolvedIds = new Set<string>();
    for (const repoId of store.resolveRepoIds(repoPrefix)) {
      const match = store.resolveIdentity(`${repoId}::${suffix}`);
      if (match) resolvedIds.add(match.nodeId);
    }
    if (resolvedIds.size === 1) return { kind: "unique", nodeId: [...resolvedIds][0] };
    if (resolvedIds.size > 1) {
      return {
        kind: "ambiguous",
        candidates: [...resolvedIds].slice(0, MAX_AMBIGUOUS_CANDIDATES).map((nodeId) => symbolCandidateOf(store, nodeId, scope)),
      };
    }
  }
  // friendly-name fallback: title match, or qualified-name suffix (so CLI/MCP
  // callers can pass "login" or "Svc.login", not just full identity keys).
  // A caller-supplied repo narrows the search rather than annotating its result.
  const repoClause = scope?.repoId ? "AND repo_id = ?" : "";
  const rows = store.db
    .prepare(
      `SELECT id FROM nodes
       WHERE (title = ? OR identity_key LIKE ? OR identity_key LIKE ?)
         ${repoClause}
         AND (
           node_type <> 'symbol'
           OR NOT EXISTS (
             SELECT 1 FROM symbol_versions sv
             WHERE sv.node_id = nodes.id
           )
           OR EXISTS (
             SELECT 1 FROM symbol_versions sv
             WHERE sv.node_id = nodes.id AND sv.status = 'fresh'
           )
         )
       LIMIT ${MAX_AMBIGUOUS_CANDIDATES + 1}`,
    )
    .all(...(scope?.repoId ? [raw, `%::${raw}`, `%.${raw}`, scope.repoId] : [raw, `%::${raw}`, `%.${raw}`])) as { id: string }[];
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "unique", nodeId: rows[0].id };
  const candidates = rows.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((row) => symbolCandidateOf(store, row.id, scope));
  // A name is only genuinely ambiguous between symbols that actually EXIST
  // somewhere. The title query above deliberately admits nodes with no
  // symbol_versions row — placeholders created from an unresolved reference
  // — and those were dragging real, locatable symbols into "ambiguous, pick
  // one" answers that no caller could act on ("buildStatusPanel" resolved to
  // its real definition plus one empty shell). When exactly one candidate
  // has a location, that is the answer.
  const located = candidates.filter((candidate) => candidate.filePath);
  if (located.length === 1) return { kind: "unique", nodeId: located[0].nodeId };
  return { kind: "ambiguous", candidates };
}

/** Public graph selectors use node:<id>; keep the legacy symbol alias readable. */
export function normalizeNodeSelector(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("node:")
    ? trimmed.slice("node:".length)
    : trimmed.startsWith("symbol:")
      ? trimmed.slice("symbol:".length)
      : trimmed;
}

// Shared renderer for an ambiguous SymbolResolution — used by `context`/`node`
// CLI verbs so the message shape (candidates + concrete next commands) stays
// consistent wherever a name resolves to more than one symbol.
export function renderAmbiguousSymbols(
  target: string,
  candidates: SymbolCandidate[],
  verb: "context" | "flow" = "context",
): string {
  const lines = [`Multiple symbols found for "${target}":`, ""];
  candidates.forEach((c, i) => {
    const loc = c.filePath ? `${c.filePath}${c.startLine ? `:${c.startLine}` : ""}` : "(no file)";
    lines.push(`${i + 1}. ${c.nodeType} ${c.identityKey.includes("::") ? c.identityKey.slice(c.identityKey.indexOf("::") + 2) : c.title}`);
    lines.push(`   ${loc}${c.branch ? `  [${c.branch}]` : ""}  node:${c.nodeId}`);
  });
  lines.push("", "Next step: pick one and re-run with its node id, e.g.:");
  lines.push(`  penguin ${verb} symbol:${candidates[0].nodeId}`);
  return lines.join("\n");
}

// knowledge_search: title→FTS unified retrieval with scope filters (§8.1).
// "field" is a pseudo node-type — object-literal keys / interface / type-alias
// / class field names, backed by fts_identifiers (see store.searchIdentifiers),
// not real symbol/note nodes. It's included when the caller explicitly asks
// for it (type: ["field"]) OR automatically when a normal, type-unfiltered
// search comes back empty — a real field name deserves file:line, not a bare
// empty result (the reporting session's longest-stuck point: searching for
// object-literal keys/interface fields always returned nothing).
export function searchLegacyRows(
  store: KnowledgeStore,
  query: string,
  filters?: LegacySearchFilters,
): SearchResultRow[] {
  const requestedTypes = filters?.type;
  const wantsFields = requestedTypes?.includes("field") ?? false;
  const otherTypes = requestedTypes?.filter((t) => t !== "field");
  // type: ["field"] alone means "fields only" — skip the symbol/note query.
  const skipSymbolSearch = wantsFields && otherTypes?.length === 0;
  const repoScope: Set<string> | null = filters?.workspace
    ? new Set(store.workspaceRepoIds(filters.workspace))
    : filters?.repo
      ? new Set(store.resolveRepoIds(filters.repo))
      : null;

  let hits: SearchResultRow[] = skipSymbolSearch
    ? []
    : store.searchText(query, {
        types: otherTypes?.length ? otherTypes : undefined,
        includeSensitive: filters?.includeSensitive,
        limit: filters?.limit,
        repoIds: repoScope ? [...repoScope] : undefined,
      });

  if (filters?.revision?.snapshotId && !filters.revision.snapshotId.startsWith("legacy:")) {
    const revision = filters.revision;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    // Do not materialize every symbol in the snapshot for every lexical
    // query. A large snapshot's manifest is intentionally lazy, and the
    // previous unfiltered symbolVersions() call walked every indexed file
    // before applying the query terms. That made the default `auto` search
    // appear to hang on large repositories even though exact/source search
    // was responsive. Use the bounded FTS candidates first, then resolve
    // only those candidates against the revision view.
    const candidateIds = hits.map((hit) => hit.nodeId).filter((id): id is string => Boolean(id));
    const revisionView = openRevisionView(store, revision);
    const revisionHits = revisionView.symbolVersions(candidateIds).filter((row) => terms.every((term) => `${row.title} ${row.identityKey} ${row.signature ?? ""}`.toLowerCase().includes(term))).slice(0, filters.limit ?? 50).map((row) => ({ nodeId: row.nodeId, nodeType: "symbol", title: row.title, snippet: row.signature ?? null, identityKey: row.identityKey, filePath: row.filePath, branch: revision.branch ?? null, rank: 100, startLine: row.startLine ?? null }));
    if (revisionHits.length || !revision.branchId) {
      hits = revisionHits;
    } else {
      // A ready snapshot can exist before its materialized file manifest is
      // rebuilt (or after an interrupted backfill). Do not hide symbols that
      // are already present in the branch index in that transitional state.
      // The fallback is restricted to an actually empty manifest and still
      // applies the branch's fresh-version visibility filter.
      const materialized = Number((store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_files WHERE snapshot_id=?").get(revision.snapshotId) as { n: number } | undefined)?.n ?? 0);
      if (materialized === 0) {
        hits = hits.filter((hit) => !hit.nodeId || nodeVisibleInRevision(store, hit.nodeId, { ...revision, snapshotId: `legacy:${revision.branchId}` })).slice(0, filters.limit ?? 50);
      } else {
        hits = revisionHits;
      }
    }
  }

  // Immutable snapshot candidates were already intersected with the COW
  // revision view above. Re-checking each candidate here reopened that view,
  // rebuilt the full manifest, and issued one symbol query per hit. On the
  // 20-repository corpus that duplicate visibility pass cost ~14 seconds.
  // Legacy branch searches have no snapshot intersection and still need this
  // compatibility visibility filter.
  if (filters?.revision?.snapshotId.startsWith("legacy:")) {
    const revision = filters.revision;
    hits = hits.filter((hit) => !hit.nodeId || nodeVisibleInRevision(store, hit.nodeId, revision));
  }

  // Endpoints/services/entities are graph nodes rather than source symbols, so
  // they have no fts_symbols row. Include them by title/identity to make real
  // routes and proto RPCs discoverable through the same search entry point.
  const structuralTypes = ["endpoint", "service", "entity", "log_site", "field"]
    .filter((nodeType) => !requestedTypes?.length || requestedTypes.includes(nodeType));
  if (!skipSymbolSearch && structuralTypes.length > 0) {
    const placeholders = structuralTypes.map(() => "?").join(",");
    const structuralQuery = `%${query}%`;
    const structuralHits = store.db
      .prepare(
        `SELECT id AS nodeId, node_type AS nodeType, title, identity_key AS identityKey,
                CASE WHEN node_type IN ('log_site', 'field') THEN json_extract(meta, '$.filePath') ELSE NULL END AS filePath,
                NULL AS branch, NULL AS rank,
                CASE WHEN node_type='log_site' THEN json_extract(meta, '$.message') ELSE NULL END AS snippet,
                CASE WHEN node_type IN ('log_site', 'field') THEN json_extract(meta, '$.startLine') ELSE NULL END AS startLine
           FROM nodes
          WHERE node_type IN (${placeholders})
            AND (title LIKE ? COLLATE NOCASE OR identity_key LIKE ? COLLATE NOCASE)
          LIMIT ?`,
      )
      .all(...structuralTypes, structuralQuery, structuralQuery, filters?.limit ?? 50) as SearchResultRow[];
    const seenNodeIds = new Set(hits.map((hit) => hit.nodeId).filter(Boolean));
    hits = hits.concat(structuralHits.filter((hit) => !seenNodeIds.has(hit.nodeId)
      && (!filters?.revision || !hit.nodeId || nodeVisibleInRevision(store, hit.nodeId, filters.revision))));
  }

  // Scope by repo, or by all repos in a workspace (§8.1 workspace filter).
  if (repoScope) {
    hits = hits.filter((h) => {
      const n = store.getNode(h.nodeId!);
      const isDirectRepoMatch = n?.repo_id != null && repoScope.has(n.repo_id);
      if (isDirectRepoMatch) return true;
      if (!n || n.repo_id != null) return false;
      const linkedRepos = store.db
        .prepare(
          `SELECT DISTINCT linked.repo_id AS repoId
             FROM edges e
             JOIN nodes linked ON linked.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
            WHERE (e.src = ? OR e.dst = ?) AND linked.repo_id IS NOT NULL
              ${filters?.revision ? "AND (e.branch_id = ? OR e.branch_id IS NULL)" : ""}`,
        )
        .all(...(filters?.revision ? [n.id, n.id, n.id, filters.revision.branchId] : [n.id, n.id, n.id])) as Array<{ repoId: string }>;
      return linkedRepos.some((row) => repoScope.has(row.repoId));
    });
  }

  const shouldSearchFields = wantsFields || (hits.length === 0 && !requestedTypes?.length);
  if (shouldSearchFields) {
    const idHits = store.searchIdentifiers(query, { limit: filters?.limit });
    const scoped = repoScope ? idHits.filter((h) => repoScope.has(h.repoId)) : idHits;
    hits = hits.concat(
      scoped.filter((h) => !filters?.revision || Boolean(store.db.prepare(
        "SELECT 1 FROM files_index WHERE repo_id=? AND branch_id=? AND file_path=? LIMIT 1",
      ).get(h.repoId, filters.revision.branchId, h.filePath))).map((h) => ({
        nodeId: null,
        nodeType: "field",
        title: h.name,
        snippet: null,
        identityKey: `field::${h.repoId}::${h.filePath}::${h.startLine}::${h.name}`,
        filePath: h.filePath,
        branch: null,
        rank: null,
        startLine: h.startLine,
      })),
    );
  }
  return hits;
}

export interface NodeDetail {
  node: { id: string; nodeType: string; identityKey: string; title: string; repoId: string | null };
  versions: Array<{
    branchId: string; filePath: string; lang: string; kind: string; status: string;
    contentHash: string; signature: string | null; startLine: number | null; endLine: number | null;
  }>;
  aliases: Array<{ aliasKey: string; reason: string | null; validTo: string | null }>;
  body: string | null; // note body, honoring mcp_access; null for symbols/denied
  // For code symbols: the declaration's actual source, read off disk by line
  // range (the graph stores only a content hash, not the text). null if the
  // file is unreadable or the node is a note (use body instead).
  source: { code: string; lang: string; filePath: string; startLine: number } | null;
  // For typed notes (Phase 3 why-layer): kind + lifecycle from frontmatter.
  note: { type: string; status: string | null; owner: string | null } | null;
}

// get_node: node + versions (symbol) or body (note, respects mcp_access) + aliases (§8.1).
export function getNodeDetail(
  store: KnowledgeStore,
  idOrKey: string,
  options?: { revision?: RevisionContext; branchId?: string },
): NodeDetail | null {
  const nodeId = resolveNodeId(store, idOrKey);
  if (!nodeId) return null;
  const node = store.getNode(nodeId)!;
  const branchId = revisionBranchId(options);
  const versionWhere = branchId ? " AND branch_id=?" : "";
  const versions = options?.revision?.snapshotId && !options.revision.snapshotId.startsWith("legacy:")
    ? openRevisionView(store, options.revision).symbolVersions([nodeId]).map((row) => ({ branchId: options.revision?.branchId ?? options.revision?.snapshotId ?? "revision", filePath: row.filePath, lang: row.language, kind: row.kind, status: "fresh", contentHash: row.contentHash, signature: row.signature ?? null, startLine: row.startLine ?? null, endLine: row.endLine ?? null }))
    : store.db
      .prepare(
        `SELECT branch_id AS branchId, file_path AS filePath, lang, kind, status,
                content_hash AS contentHash, signature, start_line AS startLine, end_line AS endLine
         FROM symbol_versions WHERE node_id=?${versionWhere} ORDER BY branch_id`,
      )
      .all(...(branchId ? [nodeId, branchId] : [nodeId])) as NodeDetail["versions"];
  const aliases = store
    .getAliases(nodeId)
    .map((a) => ({ aliasKey: a.aliasKey, reason: a.reason, validTo: a.validTo }));

  let body: string | null = null;
  let note: NodeDetail["note"] = null;
  const noteRow = store.db
    .prepare("SELECT mcp_access, frontmatter FROM notes_index WHERE node_id=?")
    .get(nodeId) as { mcp_access: string; frontmatter: string | null } | undefined;
  if (noteRow && noteRow.mcp_access !== "denied") {
    const fts = store.db
      .prepare("SELECT body FROM fts_notes WHERE node_id=?")
      .get(nodeId) as { body: string } | undefined;
    body = fts?.body ?? null;
    try {
      const fm = noteRow.frontmatter ? (JSON.parse(noteRow.frontmatter) as Record<string, unknown>) : {};
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      note = { type: s(fm.type) ?? "note", status: s(fm.status), owner: s(fm.owner) };
    } catch {
      note = { type: "note", status: null, owner: null };
    }
  }

  // Symbol source: prefer the fresh version, read [startLine, endLine] off disk.
  let source: NodeDetail["source"] = null;
  if (!noteRow && node.repo_id) {
    const v = versions.find((x) => x.status === "fresh") ?? versions[0];
    if (v && v.startLine != null && v.endLine != null) {
      const repo = store.db
        .prepare("SELECT root_path AS rootPath FROM repos WHERE id=?")
        .get(node.repo_id) as { rootPath: string } | undefined;
      if (repo) {
        try {
          const abs = isAbsolute(v.filePath) ? v.filePath : join(repo.rootPath, v.filePath);
          const lines = readFileSync(abs, "utf8").split(/\r?\n/);
          const code = lines.slice(v.startLine - 1, v.endLine).join("\n");
          if (code.trim()) source = { code, lang: v.lang, filePath: v.filePath, startLine: v.startLine };
        } catch {
          source = null; // best-effort: file moved/unreadable → fall back to signature
        }
      }
    }
  }

  return {
    node: {
      id: node.id, nodeType: node.node_type, identityKey: node.identity_key,
      title: node.title, repoId: node.repo_id,
    },
    versions, aliases, body, source, note,
  };
}

export type GraphMode =
  | "who_calls" | "calls_of" | "impact" | "backlinks" | "path" | "timeline" | "recent_changes" | "who_injects";

export interface GraphResult {
  mode: GraphMode;
  nodes: Array<{ nodeId: string; title: string; nodeType: string }>;
  /** Set when the result hit the limit and more exist. Absent means the list is
   * everything. Without it, `callers` on a 450-caller symbol returned exactly
   * 100 rows that looked like the whole answer. */
  truncated?: { limit: number; hint: string };
  /** The returned relationship count is exact only when traversal did not hit
   * its safety limit. A capped list must never be read as a complete impact
   * or caller answer. */
  candidateCount?: number;
  totalIsExact?: boolean;
  completeness?: "complete" | "lower_bound" | "partial" | "unknown";
  coverageGaps?: string[];
  events?: Array<{ eventType: string; ts: string; origin: string; method: string; nodeId: string | null }>;
  diagnostics?: QueryDiagnostics;
  revision?: RevisionContext;
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // traversal silently answered against the repo's live branch instead (see
  // FlowResult.scopeFallback). Matters most for the legacy graph verbs
  // (callers/calls/impact/backlinks/recent) that stay unscoped by design.
  scopeFallback?: { branchId: string };
  evidence?: EvidenceEnvelope;
}

export interface SourceReference {
  repoId: string;
  branchId: string | null;
  revisionId: string | null;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

type TargetScopeOptions = { repoId?: string; revision?: RevisionContext; branchId?: string };

function sourceBranchForRepo(
  store: KnowledgeStore,
  repoId: string,
  preferredBranchId?: string,
): Pick<SourceReference, "repoId" | "branchId" | "revisionId"> {
  const branch = store.db.prepare(
    `SELECT id AS branchId,
            COALESCE(current_snapshot_id, last_indexed_commit, head_commit) AS revisionId
       FROM branches
      WHERE repo_id=? AND status <> 'gone'
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, default_branch DESC, last_indexed_at DESC, id
      LIMIT 1`,
  ).get(repoId, preferredBranchId ?? "") as { branchId: string; revisionId: string | null } | undefined;
  return { repoId, branchId: branch?.branchId ?? null, revisionId: branch?.revisionId ?? null };
}

/**
 * Source provenance always follows the node's own repository/branch. The
 * requested revision is preferred only when it belongs to that source repo;
 * a foreign flow step must never inherit the caller's revision identifier.
 */
export function sourceContextForNode(
  store: KnowledgeStore,
  id: string,
  scope?: TargetScopeOptions,
): SourceReference | null {
  const node = store.getNode(id);
  if (!node) return null;
  const requestedRepoId = scope?.repoId ?? scope?.revision?.repoId;
  const preferredBranchId = requestedRepoId === node.repo_id
    ? scope?.revision?.branchId ?? scope?.branchId
    : undefined;
  if (node.repo_id) {
    const version = store.db.prepare(
      `SELECT b.repo_id AS repoId, b.id AS branchId,
              COALESCE(b.current_snapshot_id, b.last_indexed_commit, b.head_commit) AS revisionId,
              sv.file_path AS filePath, sv.start_line AS startLine, sv.end_line AS endLine
         FROM symbol_versions sv JOIN branches b ON b.id=sv.branch_id
        WHERE sv.node_id=? AND sv.status='fresh' AND b.status <> 'gone'
        ORDER BY CASE WHEN b.id=? THEN 0 ELSE 1 END, b.default_branch DESC, b.last_indexed_at DESC, sv.start_line, sv.id
        LIMIT 1`,
    ).get(id, preferredBranchId ?? "") as {
      repoId: string; branchId: string; revisionId: string | null;
      filePath: string | null; startLine: number | null; endLine: number | null;
    } | undefined;
    if (version) {
      return {
        repoId: version.repoId,
        branchId: version.branchId,
        revisionId: requestedRepoId === version.repoId
          && scope?.revision?.branchId === version.branchId
          && !scope.revision.snapshotId.startsWith("legacy:")
          ? scope.revision.snapshotId
          : version.revisionId,
        ...(version.filePath ? { filePath: version.filePath } : {}),
        ...(version.startLine != null ? { startLine: version.startLine } : {}),
        ...(version.endLine != null ? { endLine: version.endLine } : {}),
      };
    }
    return sourceBranchForRepo(store, node.repo_id, preferredBranchId);
  }
  if (node.node_type !== "endpoint") return null;
  const memberships = store.listEndpointMemberships(id);
  const membership = memberships.find((item) => item.repoId === requestedRepoId) ?? memberships[0];
  if (!membership) return null;
  const locatorScope = membership.repoId === requestedRepoId
    ? { repoId: membership.repoId, revision: scope?.revision, branchId: scope?.branchId }
    : { repoId: membership.repoId };
  const locator = membership.locatorNodeId
    ? sourceContextForNode(store, membership.locatorNodeId, locatorScope)
    : null;
  if (locator) return { ...locator, ...(membership.filePath ? { filePath: membership.filePath } : {}) };
  return {
    ...sourceBranchForRepo(
      store,
      membership.repoId,
      membership.repoId === requestedRepoId ? scope?.revision?.branchId ?? scope?.branchId : undefined,
    ),
    ...(membership.filePath ? { filePath: membership.filePath } : {}),
  };
}

function assertResolvedNodeInScope(
  store: KnowledgeStore,
  nodeId: string,
  scope?: TargetScopeOptions,
): void {
  const node = store.getNode(nodeId);
  if (!node) return;
  assertTargetInScope(store, {
    nodeId,
    nodeType: node.node_type as "symbol" | "endpoint" | "service" | "file" | "note",
    repoId: node.repo_id ?? null,
  }, {
    repoId: scope?.repoId,
    revision: scope?.revision,
  });
}

function nodeBrief(store: KnowledgeStore, id: string, scope?: TargetScopeOptions): ContextBrief {
  const n = store.getNode(id);
  // Coordinates travel WITH the relation. A callers list of bare names forces a
  // second lookup per entry just to open the file, and an agent that skips
  // those lookups ends up guessing where the code is.
  const at = store.db
    .prepare(
      `SELECT file_path AS filePath, start_line AS startLine, end_line AS endLine
         FROM symbol_versions WHERE node_id=? AND status='fresh'
        ORDER BY start_line LIMIT 1`,
    )
    .get(id) as { filePath: string | null; startLine: number | null; endLine: number | null } | undefined;
  const source = sourceContextForNode(store, id, scope);
  return {
    nodeId: id,
    title: n?.title ?? id,
    nodeType: n?.node_type ?? "unknown",
    ...(source?.filePath ?? at?.filePath ? { filePath: source?.filePath ?? at?.filePath! } : {}),
    ...(source?.startLine ?? at?.startLine != null ? { startLine: source?.startLine ?? at?.startLine! } : {}),
    ...(source?.endLine ?? at?.endLine != null ? { endLine: source?.endLine ?? at?.endLine! } : {}),
    ...(source ? { source } : {}),
  };
}

// The live branch of a node's repo — the default "which branch am I answering
// for" so multi-branch repos never silently mix branches. null for repo-less
// (global) nodes like cross-repo gRPC endpoints.
export interface BranchFreshness {
  branchId: string;
  name: string;
  status: string;
  indexedCommit: string | null;
  indexedAt: string | null;
  stale: boolean;
  reason: string;
}

export interface TrustEnvelope {
  repoId: string;
  repoName: string;
  branchId: string;
  branchName: string;
  headCommit: string | null;
  indexedCommit: string | null;
  indexedAt: string | null;
  worktreeState: "clean" | "dirty" | "unknown" | "not_applicable";
  worktreeFingerprint: string | null;
  dirtyFiles: string[];
  parserVersion: string | null;
  /** Current storage/API schema understood by the answering runtime. */
  schemaVersion: number;
  /** Parser-derived format recorded when this branch was indexed. */
  indexedSchemaVersion: number | null;
  indexCompatibility: RuntimeIndexCompatibility;
  stale: boolean;
  staleReason: string | null;
  alignment: "aligned" | "head_advanced" | "dirty" | "unknown";
  checkedAt: string;
  revisionGeneration: number;
  coverageGaps: string[];
  snapshotId?: string | null;
  baseCommit?: string | null;
  mergeBaseCommit?: string | null;
  cacheState?: "ready" | "cold" | "legacy" | "missing";
  changedFiles?: number;
  reusePercent?: number | null;
  deploymentTargets?: string[];
}

function durableRevisionGeneration(store: KnowledgeStore): number {
  const row = store.db.prepare("SELECT value FROM meta WHERE key='revision_generation'").get() as { value: string } | undefined;
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function liveRevisionTruth(input: {
  branchName: string;
  storedHead: string | null;
  indexedCommit: string | null;
  storedWorktreeState: TrustEnvelope["worktreeState"];
  gitState: GitState | null;
}): {
  headCommit: string | null;
  worktreeState: TrustEnvelope["worktreeState"];
  alignment: TrustEnvelope["alignment"];
} {
  const observesCheckout = input.gitState?.branch === input.branchName;
  const headCommit = observesCheckout ? input.gitState?.headSha ?? null : input.storedHead;
  const worktreeState = observesCheckout
    ? input.gitState?.dirty ? "dirty" : "clean"
    : input.storedWorktreeState;
  const alignment: TrustEnvelope["alignment"] = !observesCheckout || headCommit == null || input.indexedCommit == null
    ? "unknown"
    : input.gitState?.dirty
      ? "dirty"
      : headCommit === input.indexedCommit
        ? "aligned"
        : "head_advanced";
  return { headCommit, worktreeState, alignment };
}

// Read the trust facts persisted by the successful indexing transaction. All
// query surfaces call this helper so repo/branch/freshness semantics cannot
// drift between Context, Flow, CLI, MCP, and the Wiki UI.
export function trustEnvelopeForBranch(
  store: KnowledgeStore,
  branchId: string | null,
): TrustEnvelope | null {
  if (!branchId) return null;
  const row = store.db.prepare(
    `SELECT r.id AS repoId, r.name AS repoName, r.root_path AS rootPath,
            b.id AS branchId, b.name AS branchName,
            b.head_commit AS headCommit,
            b.last_indexed_commit AS indexedCommit,
            b.last_indexed_at AS indexedAt,
            b.indexed_worktree_state AS worktreeState,
            b.indexed_worktree_fingerprint AS worktreeFingerprint,
            b.indexed_dirty_files AS dirtyFiles,
            b.parser_version AS parserVersion,
            b.indexed_schema_version AS indexedSchemaVersion,
            b.stale_reason AS staleReason
       FROM branches b JOIN repos r ON r.id=b.repo_id
      WHERE b.id=?`,
  ).get(branchId) as {
    repoId: string; repoName: string; rootPath: string; branchId: string; branchName: string;
    headCommit: string | null; indexedCommit: string | null; indexedAt: string | null;
    worktreeState: TrustEnvelope["worktreeState"]; worktreeFingerprint: string | null;
    dirtyFiles: string; parserVersion: string | null; indexedSchemaVersion: number | null;
    staleReason: string | null;
  } | undefined;
  if (!row) return null;
  // Trust is a persisted index observation. Keep this stable across Context,
  // Flow, status and MCP calls instead of manufacturing a different timestamp
  // for every read of the same indexed branch.
  const checkedAt = row.indexedAt ?? "unknown";
  const live = liveRevisionTruth({
    branchName: row.branchName,
    storedHead: row.headCommit,
    indexedCommit: row.indexedCommit,
    storedWorktreeState: row.worktreeState,
    gitState: readGitStateDefault(row.rootPath),
  });
  let dirtyFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.dirtyFiles);
    dirtyFiles = Array.isArray(parsed) ? parsed.filter((file): file is string => typeof file === "string") : [];
  } catch {
    dirtyFiles = [];
  }
  const coverageGaps = row.worktreeState === "unknown" ? ["git_status_unavailable"] : [];
  const indexCompatibility = runtimeIndexCompatibility(store, branchId);
  if (indexCompatibility.state === "schema_outdated") coverageGaps.push("schema_outdated");
  const snapshot = store.db.prepare(
    `SELECT s.id AS snapshotId, s.base_snapshot_id AS baseSnapshotId, s.merge_base_sha AS mergeBaseCommit,
            s.state AS cacheState,
            (SELECT COUNT(*) FROM snapshot_overlays o WHERE o.snapshot_id=s.id AND o.operation IN ('add','modify')) AS changedFiles,
            (SELECT COUNT(*) FROM effective_snapshot_files e WHERE e.snapshot_id=s.id) AS totalFiles
       FROM branches b JOIN revision_snapshots s ON s.id=b.current_snapshot_id WHERE b.id=?`,
  ).get(branchId) as { snapshotId: string; baseSnapshotId: string | null; mergeBaseCommit: string | null; cacheState: "ready" | "cold"; changedFiles: number; totalFiles: number } | undefined;
  const baseCommit = snapshot?.baseSnapshotId
    ? (store.db.prepare("SELECT commit_sha AS commitSha FROM revision_snapshots WHERE id=?").get(snapshot.baseSnapshotId) as { commitSha: string | null } | undefined)?.commitSha ?? null
    : null;
  const deploymentTargets = snapshot?.snapshotId
    ? (store.db.prepare("SELECT DISTINCT target_id AS targetId FROM deployment_revisions d JOIN revision_snapshots s ON s.repo_id=d.repo_id AND s.commit_sha=d.commit_sha WHERE s.id=?").all(snapshot.snapshotId) as Array<{ targetId: string }>).map((item) => item.targetId)
    : [];
  return {
    ...row,
    headCommit: live.headCommit,
    worktreeState: live.worktreeState,
    schemaVersion: SCHEMA_VERSION,
    indexCompatibility,
    dirtyFiles,
    stale: row.staleReason != null || live.alignment === "head_advanced" || indexCompatibility.state === "schema_outdated",
    staleReason: indexCompatibility.state === "schema_outdated" ? "schema_outdated" : row.staleReason,
    alignment: live.alignment,
    checkedAt,
    revisionGeneration: durableRevisionGeneration(store),
    ...(snapshot ? { snapshotId: snapshot.snapshotId, baseCommit, mergeBaseCommit: snapshot.mergeBaseCommit, cacheState: snapshot.cacheState, changedFiles: snapshot.changedFiles, reusePercent: snapshot.totalFiles ? Math.max(0, 100 - (snapshot.changedFiles / snapshot.totalFiles * 100)) : 100, deploymentTargets } : { cacheState: "legacy" as const }),
    coverageGaps,
  };
}

// Bulk variant for list/status surfaces. The single-branch helper remains the
// canonical path for focused queries, while Wiki/CLI status must not perform
// one stale/trust/deployment query per branch.
function trustEnvelopesForBranches(store: KnowledgeStore, branchIds: string[]): Map<string, TrustEnvelope> {
  const out = new Map<string, TrustEnvelope>();
  if (branchIds.length === 0) return out;
  const marks = branchIds.map(() => "?").join(",");
  type BranchTrustRow = {
    repoId: string; repoName: string; rootPath: string; branchId: string; branchName: string;
    headCommit: string | null; indexedCommit: string | null; indexedAt: string | null;
    worktreeState: TrustEnvelope["worktreeState"]; worktreeFingerprint: string | null;
    dirtyFiles: string; parserVersion: string | null; indexedSchemaVersion: number | null; staleReason: string | null;
  };
  type SnapshotTrustRow = {
    branchId: string; snapshotId: string; baseSnapshotId: string | null; mergeBaseCommit: string | null;
    cacheState: "ready" | "cold"; changedFiles: number; totalFiles: number; baseCommit: string | null;
  };
  const branches = store.db.prepare(
    `SELECT r.id AS repoId, r.name AS repoName, r.root_path AS rootPath,
            b.id AS branchId, b.name AS branchName, b.head_commit AS headCommit,
            b.last_indexed_commit AS indexedCommit, b.last_indexed_at AS indexedAt,
            b.indexed_worktree_state AS worktreeState,
            b.indexed_worktree_fingerprint AS worktreeFingerprint,
            b.indexed_dirty_files AS dirtyFiles, b.parser_version AS parserVersion,
            b.indexed_schema_version AS indexedSchemaVersion, b.stale_reason AS staleReason
       FROM branches b JOIN repos r ON r.id=b.repo_id
      WHERE b.id IN (${marks})`,
  ).all(...branchIds) as BranchTrustRow[];
  const snapshots = store.db.prepare(
    `SELECT b.id AS branchId, s.id AS snapshotId, s.base_snapshot_id AS baseSnapshotId,
            s.merge_base_sha AS mergeBaseCommit, s.state AS cacheState,
            (SELECT COUNT(*) FROM snapshot_overlays o WHERE o.snapshot_id=s.id AND o.operation IN ('add','modify')) AS changedFiles,
            (SELECT COUNT(*) FROM effective_snapshot_files e WHERE e.snapshot_id=s.id) AS totalFiles,
            base.commit_sha AS baseCommit
       FROM branches b JOIN revision_snapshots s ON s.id=b.current_snapshot_id
       LEFT JOIN revision_snapshots base ON base.id=s.base_snapshot_id
      WHERE b.id IN (${marks})`,
  ).all(...branchIds) as SnapshotTrustRow[];
  const snapshotByBranch = new Map(snapshots.map((row) => [row.branchId, row]));
  const gitByRoot = new Map<string, GitState | null>();
  const revisionGeneration = durableRevisionGeneration(store);
  const snapshotIds = snapshots.map((row) => row.snapshotId);
  const deploymentBySnapshot = new Map<string, string[]>();
  if (snapshotIds.length > 0) {
    const snapshotMarks = snapshotIds.map(() => "?").join(",");
    for (const row of store.db.prepare(
      `SELECT DISTINCT s.id AS snapshotId, d.target_id AS targetId
         FROM revision_snapshots s
         JOIN deployment_revisions d ON d.repo_id=s.repo_id AND d.commit_sha=s.commit_sha
        WHERE s.id IN (${snapshotMarks})`,
    ).all(...snapshotIds) as Array<{ snapshotId: string; targetId: string }>) {
      const list = deploymentBySnapshot.get(row.snapshotId) ?? [];
      if (!list.includes(row.targetId)) list.push(row.targetId);
      deploymentBySnapshot.set(row.snapshotId, list);
    }
  }
  for (const row of branches) {
    let dirtyFiles: string[] = [];
    try {
      const parsed = JSON.parse(row.dirtyFiles);
      dirtyFiles = Array.isArray(parsed) ? parsed.filter((file): file is string => typeof file === "string") : [];
    } catch { /* malformed legacy metadata is treated as empty */ }
    const snapshot = snapshotByBranch.get(row.branchId);
    if (!gitByRoot.has(row.rootPath)) gitByRoot.set(row.rootPath, readGitStateDefault(row.rootPath));
    const live = liveRevisionTruth({
      branchName: row.branchName,
      storedHead: row.headCommit,
      indexedCommit: row.indexedCommit,
      storedWorktreeState: row.worktreeState,
      gitState: gitByRoot.get(row.rootPath) ?? null,
    });
    const coverageGaps = live.worktreeState === "unknown" ? ["git_status_unavailable"] : [];
    const indexCompatibility = runtimeIndexCompatibility(store, row.branchId);
    if (indexCompatibility.state === "schema_outdated") coverageGaps.push("schema_outdated");
    out.set(row.branchId, {
      ...row,
      headCommit: live.headCommit,
      worktreeState: live.worktreeState,
      schemaVersion: SCHEMA_VERSION,
      indexCompatibility,
      dirtyFiles,
      stale: row.staleReason != null || live.alignment === "head_advanced" || indexCompatibility.state === "schema_outdated",
      staleReason: indexCompatibility.state === "schema_outdated" ? "schema_outdated" : row.staleReason,
      alignment: live.alignment,
      // Match trustEnvelopeForBranch: the timestamp belongs to the persisted
      // index observation, not to this particular read request.
      checkedAt: row.indexedAt ?? "unknown",
      revisionGeneration,
      ...(snapshot ? {
        snapshotId: snapshot.snapshotId,
        baseCommit: snapshot.baseCommit,
        mergeBaseCommit: snapshot.mergeBaseCommit,
        cacheState: snapshot.cacheState,
        changedFiles: snapshot.changedFiles,
        reusePercent: snapshot.totalFiles ? Math.max(0, 100 - (snapshot.changedFiles / snapshot.totalFiles * 100)) : 100,
        deploymentTargets: deploymentBySnapshot.get(snapshot.snapshotId) ?? [],
      } : { cacheState: "legacy" as const }),
      coverageGaps,
    });
  }
  return out;
}

// "Which branch am I answering for, and is it current?" — compares the live git
// HEAD (passed by the caller, which can read .git) against what was indexed.
// Every Context Pack / answer should carry this so an AI never trusts a stale
// or wrong-branch view (§ Phase 1).
export function branchFreshness(
  store: KnowledgeStore,
  branchId: string,
  currentHeadCommit?: string | null,
): BranchFreshness | null {
  const b = store.db
    .prepare("SELECT id, name, status, last_indexed_commit AS ic, last_indexed_at AS ia FROM branches WHERE id=?")
    .get(branchId) as { id: string; name: string; status: string; ic: string | null; ia: string | null } | undefined;
  if (!b) return null;
  const short = (c: string) => c.slice(0, 8);
  let stale = false;
  let reason = "fresh";
  if (!b.ia) { stale = true; reason = "never indexed"; }
  else if (currentHeadCommit && b.ic && currentHeadCommit !== b.ic) {
    stale = true;
    reason = `branch advanced: HEAD ${short(currentHeadCommit)} ≠ indexed ${short(b.ic)} — re-index`;
  }
  return { branchId: b.id, name: b.name, status: b.status, indexedCommit: b.ic, indexedAt: b.ia, stale, reason };
}

export function liveBranchOf(store: KnowledgeStore, nodeId: string): string | null {
  const n = store.getNode(nodeId);
  if (!n?.repo_id) return null;
  const b = store.db
    .prepare("SELECT id FROM branches WHERE repo_id=? AND status='live' ORDER BY last_indexed_at DESC LIMIT 1")
    .get(n.repo_id) as { id: string } | undefined;
  return b?.id ?? null;
}

export interface QueryDiagnostics {
  resolutionStatus:
    | "resolved"
    | "no_match"
    | "ambiguous"
    | "stale_target"
    | "not_indexed"
    | "assembly_error";
  resultStatus:
    | "has_results"
    | "no_static_edge"
    | "unresolved_edges"
    | "query_error";
  target: {
    requested: string;
    resolvedNodeId: string | null;
    repo: string | null;
    branch: string | null;
  };
  freshness: {
    status: "fresh" | "dirty" | "stale" | "unknown";
    indexedCommit: string | null;
    headCommit: string | null;
    dirtyFileCount: number | null;
  } | null;
  evidence: {
    incomingByType: Record<string, number>;
    outgoingByType: Record<string, number>;
    unresolvedReferenceCount: number | null;
  };
  candidateCount: number;
  totalIsExact: boolean;
  completeness: "complete" | "lower_bound" | "partial" | "unknown";
  coverageGaps: string[];
}

function edgeCountsByType(
  store: KnowledgeStore,
  nodeId: string,
  direction: "incoming" | "outgoing",
): Record<string, number> {
  const column = direction === "incoming" ? "dst" : "src";
  const rows = store.db
    .prepare(
      `SELECT edge_type AS edgeType, COUNT(*) AS count
         FROM edges
        WHERE ${column}=? AND status='active' AND method IN ('EXTRACTED','ASSERTED')
        GROUP BY edge_type
        ORDER BY edge_type`,
    )
    .all(nodeId) as Array<{ edgeType: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.edgeType, row.count]));
}

function staleExactTargetExists(store: KnowledgeStore, requested: string): boolean {
  const row = store.db
    .prepare(
      `SELECT n.id
         FROM nodes n
         JOIN symbol_versions sv ON sv.node_id=n.id
        WHERE (n.id=? OR n.identity_key=? OR n.title=?)
        GROUP BY n.id
       HAVING SUM(CASE WHEN sv.status='fresh' THEN 1 ELSE 0 END)=0
        LIMIT 1`,
    )
    .get(requested, requested, requested) as { id: string } | undefined;
  return !!row;
}

function buildQueryDiagnostics(
  store: KnowledgeStore,
  requested: string,
  resolvedNodeId: string | null,
  resultCount: number,
  options?: {
    branchId?: string;
    assemblyError?: string | null;
    limit?: number;
    completeness?: QueryDiagnostics["completeness"];
    coverageGaps?: string[];
  },
): QueryDiagnostics {
  const repoCount = (
    store.db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number }
  ).count;
  const symbolResolution = resolvedNodeId ? null : resolveSymbolMatches(store, requested);
  const resolutionStatus: QueryDiagnostics["resolutionStatus"] = options?.assemblyError
    ? "assembly_error"
    : resolvedNodeId
      ? "resolved"
      : repoCount === 0
        ? "not_indexed"
        : symbolResolution?.kind === "ambiguous"
          ? "ambiguous"
          : staleExactTargetExists(store, requested)
            ? "stale_target"
            : "no_match";
  const branchId = resolvedNodeId
    ? options?.branchId ?? liveBranchOf(store, resolvedNodeId)
    : null;
  const trust = trustEnvelopeForBranch(store, branchId);
  const node = resolvedNodeId ? store.getNode(resolvedNodeId) : null;
  const repo = node?.repo_id
    ? (store.db.prepare("SELECT name FROM repos WHERE id=?").get(node.repo_id) as
        | { name: string }
        | undefined)
    : undefined;
  const freshness = trust
    ? {
        status: trust.stale
          ? "stale" as const
          : trust.worktreeState === "dirty"
            ? "dirty" as const
            : trust.worktreeState === "unknown"
              ? "unknown" as const
              : "fresh" as const,
        indexedCommit: trust.indexedCommit,
        headCommit: trust.headCommit,
        dirtyFileCount: trust.dirtyFiles.length,
      }
    : null;
  const coverageGaps = new Set(trust?.coverageGaps ?? []);
  const unresolvedReferenceCount = resolvedNodeId && branchId
    ? coverageForEvidence(store, node?.repo_id ?? undefined, branchId).unresolvedReferences
    : null;
  if (!resolvedNodeId || !branchId) coverageGaps.add("unresolved_reference_scope_unavailable");
  else if (unresolvedReferenceCount === null) coverageGaps.add("unresolved_reference_coverage_unavailable");
  else if (unresolvedReferenceCount > 0) coverageGaps.add("unresolved_references_present");
  for (const gap of options?.coverageGaps ?? []) coverageGaps.add(gap);
  const totalIsExact = options?.limit === undefined ? false : resultCount < options.limit;
  return {
    resolutionStatus,
    resultStatus: resolutionStatus !== "resolved"
      ? "query_error"
      : resultCount > 0
        ? "has_results"
        : "no_static_edge",
    target: {
      requested,
      resolvedNodeId,
      repo: repo?.name ?? trust?.repoName ?? null,
      branch: trust?.branchName ?? null,
    },
    freshness,
    evidence: {
      incomingByType: resolvedNodeId
        ? edgeCountsByType(store, resolvedNodeId, "incoming")
        : {},
      outgoingByType: resolvedNodeId
        ? edgeCountsByType(store, resolvedNodeId, "outgoing")
        : {},
      unresolvedReferenceCount,
    },
    candidateCount: resultCount,
    totalIsExact,
    completeness: options?.completeness
      ?? (resolutionStatus !== "resolved" ? "unknown" : totalIsExact ? "complete" : "partial"),
    coverageGaps: [...coverageGaps],
  };
}

// explore_graph: one traversal entry point across modes (§8.1).
export function exploreGraph(
  store: KnowledgeStore,
  mode: GraphMode,
  nodeOrKey: string,
  options?: {
    depth?: number;
    limit?: number;
    to?: string;
    branchId?: string;
    repoId?: string;
    revision?: RevisionContext;
    /** Internal callers can defer the expensive public evidence assembly. */
    includeDiagnostics?: boolean;
    includeEvidence?: boolean;
  },
): GraphResult {
  const limit = options?.limit ?? 100;

  if (mode === "timeline" || mode === "recent_changes") {
    if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
      const events = (store.db.prepare("SELECT event_type AS eventType, ts, origin, method, node_id AS nodeId FROM events WHERE repo_id IS NULL OR repo_id=? ORDER BY ts DESC LIMIT ?").all(options.revision.repoId, limit) as GraphResult["events"]);
      return { mode, nodes: [], events, revision: options.revision } as GraphResult;
    }
    const nodeId = mode === "timeline" ? resolveNodeId(store, nodeOrKey, options?.repoId) : null;
    const rows = (
      nodeId
        ? store.db.prepare(
            "SELECT event_type AS eventType, ts, origin, method, node_id AS nodeId FROM events WHERE node_id=? ORDER BY ts DESC LIMIT ?",
          ).all(nodeId, limit)
        : store.db.prepare(
            "SELECT event_type AS eventType, ts, origin, method, node_id AS nodeId FROM events ORDER BY ts DESC LIMIT ?",
          ).all(limit)
    ) as GraphResult["events"];
    return { mode, nodes: [], events: rows, revision: options?.revision } as GraphResult;
  }

  const pathScope = {
    repoId: options?.repoId ?? options?.revision?.repoId,
    branchId: options?.branchId,
    revision: options?.revision,
  };
  const pathTargets = mode === "path"
    ? {
        from: resolveTarget(store, nodeOrKey, pathScope),
        to: options?.to ? resolveTarget(store, options.to, pathScope) : null,
      }
    : null;
  if (pathTargets) {
    // Resolve and assert both endpoints before either revision-view or graph
    // traversal. This makes an out-of-scope destination a canonical error.
    assertTargetInScope(store, pathTargets.from, pathScope);
    if (pathTargets.to) assertTargetInScope(store, pathTargets.to, pathScope);
  }
  const scopedNodeId = pathTargets?.from.nodeId ?? resolveNodeId(store, nodeOrKey, options?.repoId);
  const nodeId = scopedNodeId ?? (options?.repoId ? resolveNodeId(store, nodeOrKey) : null);
  if (!nodeId) {
    return {
      mode,
      nodes: [],
      diagnostics: buildQueryDiagnostics(store, nodeOrKey, null, 0, {
        branchId: options?.branchId,
      }),
    };
  }
  assertResolvedNodeInScope(store, nodeId, options);
  // Set below (after the branch-scope fallback below fires) so the closure
  // sees the up-to-date value at call time — the revision-scoped early
  // returns above call graphResult() before this fires (never a fallback,
  // since an explicit revision was supplied), the plain-SQL modes below call
  // it after (scopeFallback reflects whether liveBranchOf actually filled in).
  //
  // CAUTION — ordering-dependent: correctness relies on the revision-scoped
  // early-return block (the `if (options?.revision?.snapshotId && ...)` block
  // immediately below, covering who_calls/calls_of/backlinks/who_injects/
  // impact/path) running and returning BEFORE the branch-scope fallback
  // assignment (`scopeFallback = !explicitBranchId && branchId ? ... `)
  // further down this function. If that assignment is ever hoisted above, or
  // the revision-scoped block is reordered to run after it, an explicit
  // revision would start getting marked as a live-branch fallback (or worse,
  // a genuine fallback could go unmarked) — do not reorder without keeping
  // this invariant true, and re-run tests/knowledge-fallback-honesty.test.mjs.
  let scopeFallback: { branchId: string } | undefined;
  const graphResult = (
    nodes: GraphResult["nodes"],
    events?: GraphResult["events"],
  ): GraphResult => {
    const result = {
      mode,
      nodes,
      ...(events ? { events } : {}),
    // A result exactly at the limit is indistinguishable from a complete one
    // unless it says so. Every caller of this shape was reading a capped list
    // as the full answer.
    ...(nodes.length >= limit
      ? { truncated: { limit, hint: `showing ${limit} of possibly more — pass --limit to raise the cap` } }
      : {}),
    candidateCount: nodes.length,
    totalIsExact: nodes.length < limit,
    completeness: nodes.length >= limit ? "partial" : "lower_bound",
    coverageGaps: nodes.length >= limit ? ["result_limit_reached"] : ["unresolved_reference_counts_not_persisted"],
    ...(options?.includeDiagnostics === false ? {} : {
      diagnostics: buildQueryDiagnostics(store, nodeOrKey, nodeId, nodes.length, {
        branchId: options?.branchId,
        limit,
        completeness: nodes.length >= limit ? "partial" : "lower_bound",
        coverageGaps: nodes.length >= limit ? ["result_limit_reached"] : [],
      }),
    }),
    revision: options?.revision,
      ...(scopeFallback ? { scopeFallback } : {}),
    } as GraphResult;
    if (options?.includeEvidence !== false) {
      result.evidence = buildEvidenceEnvelope(store, {
        repoId: options?.repoId ?? (nodeId ? store.getNode(nodeId)?.repo_id ?? undefined : undefined),
        branchId: options?.branchId,
        revision: options?.revision,
        completeness: nodes.length >= limit ? "partial" : nodes.length > 0 ? "lower_bound" : nodeId ? "partial" : "unknown",
        // A non-empty traversal is only candidate/lower-bound evidence. It is
        // not a proof of relation completeness, especially when the traversal
        // is capped or parser coverage is incomplete.
        proofStatus: "not_proven",
        candidateCount: nodes.length,
        returnedCount: nodes.length,
        truncated: nodes.length >= limit,
        cursor: null,
      });
    }
    return result;
  };

  // Trust filter (§3.3/§11): default traversal only follows confirmed edges —
  // unconfirmed AI suggestions (status='suggested') and rejected edges are out.
  // Parser confidence is explicit: EXTRACTED/ASSERTED edges are verified for
  // deterministic impact; INFERRED edges remain candidate evidence and are
  // never silently promoted into a hard blast-radius answer.
  // Framework methods are source-grounded parser output, but they are not
  // direct call expressions. They participate in impact/caller traversal with
  // their original method preserved in evidence responses.
  const ACTIVE = "status='active' AND method IN ('EXTRACTED','ASSERTED','DI_MODULE_PROVIDER','INTERFACE_IMPLEMENTATION','RUNTIME_OBSERVED')";
  if (options?.revision?.snapshotId && !options.revision.snapshotId.startsWith("legacy:")) {
    const targetKey = store.getNode(nodeId)?.identity_key ?? nodeOrKey;
    const view = openRevisionView(store, options.revision);
    // A revision can contain millions of immutable edges. Reading the first
    // 10,000 rows and filtering them in memory made a node-targeted affected
    // query scan the whole snapshot (and, depending on SQLite's sort plan,
    // take tens of seconds). Keep the same revision/global visibility rules,
    // but push the node frontier into RevisionView so its identity-first
    // indexes can answer only the requested relationships.
    const readEdges = (nodeKeys: string[], direction: "in" | "out" | "both", edgeTypes?: string[]) =>
      view.edges({
        nodeIds: nodeKeys,
        direction,
        ...(edgeTypes ? { edgeTypes } : {}),
        limit: Math.max(10_000, limit * 10),
      });
    const nodeFor = (key?: string) => key ? store.findNodeIdByIdentity(key) : null;
    const incoming = (key: string, type?: string) => readEdges([key], "in", type ? [type] : undefined)
      .filter((edge) => edge.dstIdentityKey === key)
      .map((edge) => edge.srcIdentityKey);
    const outgoing = (key: string, type?: string) => readEdges([key], "out", type ? [type] : undefined)
      .filter((edge) => edge.srcIdentityKey === key)
      .map((edge) => edge.dstIdentityKey)
      .filter((key): key is string => Boolean(key));
    if (mode === "who_calls") return graphResult([...new Set(IMPACT_EDGE_TYPES.flatMap((type) => incoming(targetKey, type)))].map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    if (mode === "calls_of") return graphResult([...new Set(IMPACT_EDGE_TYPES.flatMap((type) => outgoing(targetKey, type)))].map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    if (mode === "backlinks") return graphResult([...new Set(incoming(targetKey))].map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    if (mode === "who_injects") {
      const classes = new Set<string>();
      for (const key of incoming(targetKey, "references")) if (key.endsWith(".constructor")) { const id = nodeFor(key.slice(0, -".constructor".length)); if (id) classes.add(id); }
      for (const key of incoming(targetKey, "injects")) { const id = nodeFor(key); if (id) classes.add(id); }
      return graphResult([...classes].slice(0, limit).map((id) => nodeBrief(store, id)));
    }
    if (mode === "impact") {
      const seen = new Set<string>([targetKey]); let frontier = [targetKey];
      for (let depth = 0; depth < (options.depth ?? 3); depth++) {
        const next: string[] = [];
        const frontierSet = new Set(frontier);
        const edges = readEdges(frontier, "in", [...IMPACT_EDGE_TYPES]);
        for (const edge of edges) {
          if (!edge.dstIdentityKey || !frontierSet.has(edge.dstIdentityKey)) continue;
          const child = edge.srcIdentityKey;
          if (seen.has(child)) continue;
          seen.add(child);
          next.push(child);
          if (seen.size >= limit) break;
        }
        frontier = next;
        if (seen.size >= limit) break;
      }
      return graphResult([...seen].filter((key) => key !== targetKey).map(nodeFor).filter((id): id is string => Boolean(id)).slice(0, limit).map((id) => nodeBrief(store, id)));
    }
    if (mode === "path") {
      const toId = pathTargets?.to?.nodeId ?? null;
      const toKey = toId ? store.getNode(toId)?.identity_key : null;
      if (!toKey) return graphResult([]);
      const prev = new Map<string, string>(); const queue = [targetKey]; const seen = new Set(queue);
      while (queue.length) {
        const current = queue.shift()!;
        if (current === toKey) break;
        for (const next of outgoing(current)) if (!seen.has(next)) { seen.add(next); prev.set(next, current); queue.push(next); }
      }
      if (!seen.has(toKey)) return graphResult([]);
      const chain: string[] = []; for (let key: string | undefined = toKey; key; key = prev.get(key)) chain.unshift(key);
      return graphResult(chain.map(nodeFor).filter((id): id is string => Boolean(id)).map((id) => nodeBrief(store, id)));
    }
  }
  // Branch-scope (correctness): when a branch is given, only follow edges on that
  // branch (plus branch-less edges like git topology / cross-repo endpoints).
  // Without it, a repo indexed on multiple branches would silently mix branches.
  const explicitBranchId = revisionBranchId(options);
  const branchId = explicitBranchId ?? liveBranchOf(store, nodeId);
  scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const P = (nid: string) => (branchId ? [nid, branchId, limit] : [nid, limit]);
  const Pd = (nid: string) => (branchId ? [nid, branchId] : [nid]); // no LIMIT (impact/path)
  if (mode === "who_calls") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type IN (${IMPACT_EDGE_TYPES.map(() => "?").join(",")}) AND ${ACTIVE}${bx} LIMIT ?`).all(nodeId, ...IMPACT_EDGE_TYPES, ...(branchId ? [branchId, limit] : [limit])) as { src: string }[];
    return graphResult(rows.map((r) => nodeBrief(store, r.src)));
  }
  // NestJS-style constructor-injection dependents. A constructor parameter's
  // type annotation is already extracted as a `references` edge from
  // `<Class>.constructor` (who_calls never looks at this edge type, only
  // `calls` — real gap: `who_calls SomeInjectedService` always came back
  // empty even though the dependency data already existed). Restricting to
  // src identity_keys ending ".constructor" is what excludes an unrelated
  // type reference elsewhere from being mistaken for injection, and
  // resolving to the enclosing class (not the constructor symbol itself) is
  // what makes the result read as "X depends on Y" instead of
  // "X.constructor depends on Y".
  if (mode === "who_injects") {
    const CTOR_SUFFIX = ".constructor";
    const rows = store.db
      .prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='references' AND ${ACTIVE}${bx}`)
      .all(...Pd(nodeId)) as { src: string }[];
    const classIds = new Set<string>();
    for (const r of rows) {
      const srcNode = store.getNode(r.src);
      if (!srcNode?.identity_key.endsWith(CTOR_SUFFIX)) continue;
      const classKey = srcNode.identity_key.slice(0, -CTOR_SUFFIX.length);
      const classId = store.findNodeIdByIdentity(classKey);
      if (classId) classIds.add(classId);
    }
    const direct = store.db
      .prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type='injects' AND ${ACTIVE}${bx}`)
      .all(...Pd(nodeId)) as { src: string }[];
    for (const row of direct) classIds.add(row.src);
    return graphResult([...classIds].slice(0, limit).map((id) => nodeBrief(store, id)));
  }
  if (mode === "calls_of") {
    const rows = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND edge_type IN (${IMPACT_EDGE_TYPES.map(() => "?").join(",")}) AND dst IS NOT NULL AND ${ACTIVE}${bx} LIMIT ?`).all(nodeId, ...IMPACT_EDGE_TYPES, ...(branchId ? [branchId, limit] : [limit])) as { dst: string }[];
    return graphResult(rows.map((r) => nodeBrief(store, r.dst)));
  }
  if (mode === "backlinks") {
    const rows = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND ${ACTIVE}${bx} LIMIT ?`).all(...P(nodeId)) as { src: string }[];
    return graphResult(rows.map((r) => nodeBrief(store, r.src)));
  }
  if (mode === "impact") {
    // transitive who_calls up to depth
    const depth = options?.depth ?? 3;
    const seen = new Set<string>([nodeId]);
    let frontier = [nodeId];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const callers = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type IN (${IMPACT_EDGE_TYPES.map(() => "?").join(",")}) AND ${ACTIVE}${bx}`).all(id, ...IMPACT_EDGE_TYPES, ...(branchId ? [branchId] : [])) as { src: string }[];
        for (const c of callers) if (!seen.has(c.src)) { seen.add(c.src); next.push(c.src); }
      }
      frontier = next;
    }
    seen.delete(nodeId);
    return graphResult([...seen].slice(0, limit).map((id) => nodeBrief(store, id)));
  }
  if (mode === "path") {
    const to = pathTargets?.to?.nodeId ?? null;
    if (!to) return graphResult([]);
    // BFS over active edges src→dst
    const prev = new Map<string, string>();
    const queue = [nodeId];
    const visited = new Set([nodeId]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === to) break;
      const outs = store.db.prepare(`SELECT DISTINCT dst FROM edges WHERE src=? AND dst IS NOT NULL AND ${ACTIVE}${bx}`).all(...Pd(cur)) as { dst: string }[];
      for (const o of outs) if (!visited.has(o.dst)) { visited.add(o.dst); prev.set(o.dst, cur); queue.push(o.dst); }
    }
    if (!visited.has(to)) return graphResult([]);
    const chain: string[] = [];
    for (let c: string | undefined = to; c; c = prev.get(c)) chain.unshift(c);
    return graphResult(chain.map((id) => nodeBrief(store, id)));
  }
  return graphResult([]);
}

export interface BranchDiff {
  symbol: string;
  branchA: { branchId: string; contentHash: string | null; status: string | null };
  branchB: { branchId: string; contentHash: string | null; status: string | null };
  identical: boolean;
  revision?: RevisionContext;
}

// compare_branches: same symbol across two branches; equal hash = no diff (§8.1).
export function compareBranches(
  store: KnowledgeStore,
  symbolIdOrKey: string,
  branchAId: string,
  branchBId: string,
  options?: { revision?: RevisionContext },
): BranchDiff | null {
  const nodeId = resolveNodeId(store, symbolIdOrKey);
  if (!nodeId) return null;
  const va = options?.revision && !options.revision.snapshotId.startsWith("legacy:")
    ? openRevisionView(store, options.revision).symbolVersions([nodeId])[0] && { content_hash: openRevisionView(store, options.revision).symbolVersions([nodeId])[0].contentHash, status: "fresh" }
    : store.getSymbolVersion(nodeId, branchAId);
  const vb = store.getSymbolVersion(nodeId, branchBId);
  return {
    symbol: symbolIdOrKey,
    branchA: { branchId: branchAId, contentHash: va?.content_hash ?? null, status: va?.status ?? null },
    branchB: { branchId: branchBId, contentHash: vb?.content_hash ?? null, status: vb?.status ?? null },
    identical: !!va && !!vb && va.content_hash === vb.content_hash,
    revision: options?.revision,
  };
}

export interface IndexStatus {
  repos: Array<{
    repoId: string; name: string; rootPath: string;
    defaultBranch: string | null;
    branches: Array<{
      branchId: string; name: string; status: string; lastIndexedAt: string | null; defaultBranch: boolean; baseBranchName: string | null;
      staleSymbols: number; pinned: boolean; trust: TrustEnvelope | null;
    }>;
  }>;
}

export interface CompactRepoStatus {
  repo: string;
  liveBranch: string | null;
  freshness: "fresh" | "dirty" | "stale" | "unknown";
  dirtyFileCount: number | null;
  indexedCommit: string | null;
  headCommit: string | null;
  parserVersion: string | null;
  indexErrorCount: number;
}

export interface CompactIndexStatus {
  summary: {
    totalRepos: number;
    fresh: number;
    dirty: number;
    stale: number;
    unknown: number;
    errors: number;
  };
  repos: CompactRepoStatus[];
}

// The pending AI-suggestion queue (edges awaiting accept/reject, §8.2).
export function listSuggestions(store: KnowledgeStore) {
  return store.listSuggestions();
}

// Distinct tags across all nodes (tags live in node meta.tags). Powers the
// Wiki editor's `#` autocomplete and tag filtering. Uses SQLite JSON1.
export function listTags(store: KnowledgeStore): string[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT je.value AS tag
         FROM nodes, json_each(json_extract(nodes.meta, '$.tags')) je
        WHERE je.value IS NOT NULL
        ORDER BY tag`,
    )
    .all() as { tag: string }[];
  return rows.map((r) => r.tag);
}

// —— 索引浏览:repo → branch → file → symbol(Wiki 导航树,§8.1）——

export interface IndexedFileRow {
  filePath: string;
  lang: string | null;
  status: string; // indexed | skipped | deleted
  sizeBytes: number | null;
  indexedAt: string | null;
  error: string | null;
}

// The files captured for a repo/branch (the file-tree source). Ordered by path.
export function listIndexedFiles(
  store: KnowledgeStore,
  repoId: string,
  branchIdOrOptions: string | { branchId?: string; revision?: RevisionContext },
): IndexedFileRow[] {
  const branchId = typeof branchIdOrOptions === "string"
    ? branchIdOrOptions
    : revisionBranchId(branchIdOrOptions);
  if (!branchId) return [];
  if (typeof branchIdOrOptions !== "string" && branchIdOrOptions.revision && !branchIdOrOptions.revision.snapshotId.startsWith("legacy:")) {
    const snapshotId = branchIdOrOptions.revision.snapshotId;
    const graphFiles = openRevisionView(store, branchIdOrOptions.revision).listFiles();
    const graphByPath = new Map(graphFiles.map((row) => [row.filePath, row]));
    const admittedSourcePaths = new Set((store.db.prepare(`
      SELECT e.file_path AS filePath
        FROM effective_snapshot_sources e
        JOIN source_facts sf ON sf.id=e.source_fact_id
       WHERE e.snapshot_id=?
         AND json_extract(sf.coverage_json, '$.status')='admitted'
       ORDER BY e.file_path
    `).all(snapshotId) as Array<{ filePath: string }>).map((row) => row.filePath));
    const paths = [...new Set([...admittedSourcePaths, ...graphByPath.keys()])].sort((a, b) => a.localeCompare(b));
    return paths.map((filePath) => {
      const graph = graphByPath.get(filePath);
      const admitted = admittedSourcePaths.has(filePath);
      return {
        filePath,
        lang: graph?.language || null,
        status: graph && admitted ? "indexed" : graph ? "graph_only" : "source_only",
        sizeBytes: null,
        indexedAt: null,
        error: null,
      };
    });
  }
  return store.db
    .prepare(
      `SELECT file_path AS filePath, lang, status, size_bytes AS sizeBytes,
              indexed_at AS indexedAt, error
       FROM files_index WHERE repo_id=? AND branch_id=? ORDER BY file_path`,
    )
    .all(repoId, branchId) as IndexedFileRow[];
}

export interface FileSymbolRow {
  nodeId: string;
  title: string;
  kind: string;
  // Without coordinates a caller has to re-query every symbol just to find
  // out where it is — one agent spent 13 extra calls (and pulled in 860-line
  // method bodies) recovering line numbers that were one join away.
  startLine: number | null;
  endLine: number | null;
  status: string; // fresh | stale
}

// The symbols defined in one file on one branch (click-a-file → its symbols).
export function listFileSymbols(
  store: KnowledgeStore,
  branchIdOrOptions: string | { branchId?: string; revision?: RevisionContext },
  filePath: string,
): FileSymbolRow[] {
  const branchId = typeof branchIdOrOptions === "string"
    ? branchIdOrOptions
    : revisionBranchId(branchIdOrOptions);
  if (!branchId) return [];
  if (typeof branchIdOrOptions !== "string" && branchIdOrOptions.revision && !branchIdOrOptions.revision.snapshotId.startsWith("legacy:")) {
    return openRevisionView(store, branchIdOrOptions.revision).symbolVersions().filter((row) => row.filePath === filePath).map((row) => ({ nodeId: row.nodeId, title: row.title, kind: row.kind, startLine: row.startLine ?? null, endLine: row.endLine ?? null, status: "fresh" }));
  }
  return store.db
    .prepare(
      `SELECT sv.node_id AS nodeId, n.title AS title, sv.kind AS kind,
              sv.start_line AS startLine, sv.end_line AS endLine, sv.status AS status
       FROM symbol_versions sv JOIN nodes n ON n.id = sv.node_id
       WHERE sv.branch_id=? AND sv.file_path=? ORDER BY sv.start_line, n.title`,
    )
    .all(branchId, filePath) as FileSymbolRow[];
}

// —— 图谱视图:节点-连线(Obsidian 式,§8.1)——

export interface GraphView {
  focus: string | null; // the centered node (null for repo-scoped view)
  nodes: Array<{
    nodeId: string; title: string; nodeType: string; revisionId?: string;
    /** Ranked degree over calls/references/invokes/handles — the number the
     * repo view sorts on. Present on repoGraph results; absent elsewhere. */
    degree?: number;
  }>;
  edges: Array<{
    src: string;
    dst: string;
    edgeType: string;
    sourceType?: string | null;
    revisionId?: string | null;
    graphEvidence?: GraphEdgeEvidenceEnvelope;
  }>;
  revision?: RevisionContext | null;
  scope?: { repoId: string | null; branchId: string | null; revisionId: string | null };
  evidence?: EvidenceEnvelope;
}

// Local graph: a focus node + its neighbourhood within `depth` hops (both
// directions over active edges), capped at `limit` nodes. Only active edges
// (confirmed) are followed — same trust rule as exploreGraph. 22k-node graphs
// can't render whole, so callers recenter by picking a neighbour as new focus.
export function graphNeighborhood(
  store: KnowledgeStore,
  nodeOrKey: string,
  options?: { depth?: number; limit?: number; branchId?: string; revision?: RevisionContext },
): GraphView {
  const focus = resolveNodeId(store, nodeOrKey);
  if (!focus) return { focus: null, nodes: [], edges: [] };
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const pairs = snapshotEdgePairs(store, options.revision);
    const ids = new Set<string>([focus]);
    const maxDepth = Math.min(3, Math.max(1, options.depth ?? 1));
    let frontier = [focus];
    for (let depth = 0; depth < maxDepth && frontier.length && ids.size < (options?.limit ?? 150); depth += 1) {
      const next: string[] = [];
      for (const pair of pairs) {
        if (!pair.dst) continue;
        if (!frontier.includes(pair.src) && !frontier.includes(pair.dst)) continue;
        const other = frontier.includes(pair.src) ? pair.dst : pair.src;
        if (!ids.has(other) && ids.size < (options?.limit ?? 150)) { ids.add(other); next.push(other); }
      }
      frontier = next;
    }
    const graph = collectGraph(store, [...ids], undefined, options?.limit ?? 150, pairs);
    return { focus, nodes: graph.nodes.map((node) => ({ ...node, revisionId: options.revision!.snapshotId })), edges: graph.edges };
  }
  const depth = Math.min(3, Math.max(1, options?.depth ?? 1));
  const limit = options?.limit ?? 150;
  const branchId = revisionBranchId(options) ?? null;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";

  const neighbours = store.db.prepare(
    `SELECT dst AS other FROM edges WHERE src=? AND dst IS NOT NULL AND status='active'${bx}
     UNION SELECT src AS other FROM edges WHERE dst=? AND status='active'${bx}`,
  );
  const nParams = (id: string) => (branchId ? [id, branchId, id, branchId] : [id, id]);
  const seen = new Set<string>([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.size >= limit) break;
      for (const row of neighbours.all(...nParams(id)) as { other: string }[]) {
        if (!seen.has(row.other) && seen.size < limit) {
          seen.add(row.other);
          next.push(row.other);
        }
      }
    }
    frontier = next;
  }
  // Every symbol now connects to its file node via a real `defines` edge (P1),
  // so a focused node always has a genuine neighbourhood — no synthetic fallback
  // needed (removing it keeps the graph free of edges that aren't real facts).
  return { focus, ...collectGraph(store, [...seen]) };
}

// Repo/branch-scoped view: the top-`limit` most-connected nodes (by active
// branch-scoped edge degree) plus the edges among them. Keeps a big repo's
// graph readable by showing its hubs rather than every leaf.
export function repoGraph(
  store: KnowledgeStore,
  repoId: string,
  branchIdOrOptions: string | { branchId?: string; revision?: RevisionContext },
  options?: { limit?: number; edgeLimit?: number },
): GraphView {
  const branchId = typeof branchIdOrOptions === "string"
    ? branchIdOrOptions
    : revisionBranchId(branchIdOrOptions);
  if (!branchId) return { focus: null, nodes: [], edges: [] };
  if (typeof branchIdOrOptions !== "string" && branchIdOrOptions.revision && !branchIdOrOptions.revision.snapshotId.startsWith("legacy:")) {
    const revision = branchIdOrOptions.revision;
    const ids = [...(snapshotNodeIds(store, revision) ?? new Set())].filter((id) => store.getNode(id)?.repo_id === repoId).slice(0, options?.limit ?? 150);
    return { focus: null, ...collectGraph(store, ids, undefined, options?.edgeLimit, snapshotEdgePairs(store, revision)) };
  }
  const limit = options?.limit ?? 150;
  const genericNames = [...GENERIC_UTILITY_HUB_NAMES];
  const genericPlaceholders = genericNames.map(() => "?").join(",");
  // Rank on edges that say something about architecture. Counting every edge
  // type made `imports` and `defines` dominate, so the "top hubs" of a NestJS
  // monorepo came back as .spec.ts files — a test that imports thirty modules
  // outranked the service everything actually calls.
  const top = store.db
    .prepare(
      `SELECT d.id AS id, d.arch AS degree FROM (
         SELECT node AS id,
                SUM(CASE WHEN kind IN ('calls','references','invokes','handles') THEN 1 ELSE 0 END) AS arch,
                COUNT(*) AS total
           FROM (
             SELECT src AS node, edge_type AS kind FROM edges
              WHERE branch_id=? AND status='active'
             UNION ALL
             SELECT dst AS node, edge_type AS kind FROM edges
              WHERE branch_id=? AND status='active' AND dst IS NOT NULL
           ) GROUP BY node
       ) d JOIN nodes n ON n.id = d.id
       WHERE n.repo_id=? AND LOWER(n.title) NOT IN (${genericPlaceholders})
       -- Rank on the edges that say something about architecture, but do not
       -- DROP a node for having none: a file whose only relation is an import
       -- still belongs in the view, just not at the top. Ranking on every edge
       -- type put .spec.ts files above the services everything calls; ranking
       -- only on architectural edges removed them from the graph altogether.
       ORDER BY d.arch DESC, d.total DESC, d.id LIMIT ?`,
    )
    .all(branchId, branchId, repoId, ...genericNames, limit) as { id: string; degree: number }[];
  const ids = top.map((r) => r.id);
  if (ids.length === 0) return { focus: null, nodes: [], edges: [] };
  const graph = collectGraph(store, ids, branchId, options?.edgeLimit);
  // Carry the number the ranking is based on. It was advertised in the result
  // shape and always null, so a caller could neither see why a node ranked
  // where it did nor re-sort on it.
  const degreeOf = new Map(top.map((row) => [row.id, row.degree]));
  return {
    focus: null,
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, degree: degreeOf.get(node.nodeId) ?? 0 })),
  };
}

// Build {nodes, edges} for a fixed node-id set — edges only where BOTH ends are
// in the set (optionally scoped to a branch). Shared by the two graph views.
// Edges are capped (dense hub nodes can otherwise yield tens of thousands of
// edges — a force/3D layout that freezes the UI) and ordered so the meaningful
// relations survive the cap: cross-service (invokes/handles) first, then calls,
// with `defines`/`imports` noise last.
function collectGraph(
  store: KnowledgeStore,
  ids: string[],
  branchId?: string,
  edgeLimit = 1000,
  providedEdges?: Array<{
    src: string;
    dst: string | null;
    edgeType: string;
    origin?: string | null;
    method?: string | null;
    confidence?: number | null;
    provenance?: unknown;
    evidenceId?: string | null;
    scope?: string | null;
    branchId?: string | null;
  }>,
): { nodes: GraphView["nodes"]; edges: GraphView["edges"] } {
  const nodes = ids.map((id) => nodeBrief(store, id));
  const ph = ids.map(() => "?").join(",");
  const branchClause = branchId ? "AND branch_id=?" : "";
  const params = branchId ? [branchId, ...ids, ...ids, edgeLimit] : [...ids, ...ids, edgeLimit];
  type StoredGraphEdge = {
    src: string;
    dst: string;
    edgeType: string;
    sourceType?: string | null;
    origin?: string | null;
    method?: string | null;
    confidence?: number | null;
    provenance?: unknown;
    evidenceId?: string | null;
    branchId?: string | null;
  };
  const materializeEdge = (edge: StoredGraphEdge): GraphView["edges"][number] => ({
    src: edge.src,
    dst: edge.dst,
    edgeType: edge.edgeType,
    sourceType: edge.sourceType ?? null,
    graphEvidence: graphEdgeEvidence({
      edgeType: edge.edgeType,
      origin: edge.origin,
      method: edge.method,
      confidence: edge.confidence,
      provenance: edge.provenance,
      evidenceId: edge.evidenceId,
      branchId: edge.branchId,
      scope: edge.branchId ? "revision" : undefined,
    }),
  });
  const edges: GraphView["edges"] = providedEdges
    ? providedEdges.filter((edge) => edge.dst && ids.includes(edge.src) && ids.includes(edge.dst)).slice(0, edgeLimit).map((edge) => materializeEdge({
      ...edge,
      dst: edge.dst!,
      sourceType: null,
    }))
    : (store.db
    .prepare(
      `SELECT src, dst, edge_type AS edgeType, source_type AS sourceType,
              origin, method, confidence, provenance, evidence_id AS evidenceId,
              branch_id AS branchId
         FROM edges
       WHERE status='active' AND dst IS NOT NULL ${branchClause}
         AND src IN (${ph}) AND dst IN (${ph})
       ORDER BY CASE edge_type
         WHEN 'invokes' THEN 0 WHEN 'handles' THEN 1 WHEN 'calls' THEN 2
         WHEN 'references' THEN 3 WHEN 'tests' THEN 4 WHEN 'imports' THEN 5 ELSE 6 END
       LIMIT ?`,
    )
    .all(...params) as StoredGraphEdge[]).map(materializeEdge);
  // Backfill false isolates: the priority order above decides which edge TYPES
  // survive the cap, but within the losing rank the cut is arbitrary — a node
  // can lose every one of its edges and render as if it had no relationships
  // at all (which reads as an indexing error, not a display cap). Any in-set
  // node with zero selected edges gets its top few in-set edges back; the
  // per-node bound keeps the overflow small.
  const touched = new Set<string>();
  for (const e of edges) {
    touched.add(e.src);
    if (e.dst) touched.add(e.dst);
  }
  const isolated = ids.filter((id) => !touched.has(id));
  if (isolated.length > 0) {
    const seen = new Set(edges.map((e) => `${e.src}\0${e.dst}\0${e.edgeType}`));
    const perNode = store.db.prepare(
      `SELECT src, dst, edge_type AS edgeType, source_type AS sourceType,
              origin, method, confidence, provenance, evidence_id AS evidenceId,
              branch_id AS branchId
         FROM edges
       WHERE status='active' AND dst IS NOT NULL ${branchClause}
         AND (src = ? OR dst = ?) AND src IN (${ph}) AND dst IN (${ph})
       ORDER BY CASE edge_type
         WHEN 'invokes' THEN 0 WHEN 'handles' THEN 1 WHEN 'calls' THEN 2
         WHEN 'references' THEN 3 WHEN 'tests' THEN 4 WHEN 'imports' THEN 5 ELSE 6 END,
         src, dst LIMIT 5`,
    );
    for (const id of isolated) {
      const extraParams = branchId ? [branchId, id, id, ...ids, ...ids] : [id, id, ...ids, ...ids];
      for (const e of perNode.all(...extraParams) as StoredGraphEdge[]) {
        const key = `${e.src}\0${e.dst}\0${e.edgeType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(materializeEdge(e));
      }
    }
  }
  return { nodes, edges };
}

// index_status: repos/branches + staleness (answers list_repos/list_branches, §8.1).
export function indexStatus(store: KnowledgeStore): IndexStatus {
  const repos = store.db.prepare("SELECT id, name, root_path AS rootPath FROM repos ORDER BY name").all() as Array<{ id: string; name: string; rootPath: string }>;
  const branches = repos.length === 0 ? [] : store.db.prepare(
    `SELECT id, repo_id AS repoId, name, status, last_indexed_at AS lastIndexedAt,
            pinned, default_branch AS defaultBranch, base_branch_name AS baseBranchName
       FROM branches WHERE repo_id IN (${repos.map(() => "?").join(",")}) ORDER BY name`,
  ).all(...repos.map((repo) => repo.id)) as Array<{ id: string; repoId: string; name: string; status: string; lastIndexedAt: string | null; pinned: number; defaultBranch: number; baseBranchName: string | null }>;
  const staleCounts = new Map<string, number>();
  if (branches.length > 0) {
    for (const row of store.db.prepare(
      `SELECT branch_id AS branchId, COUNT(*) AS n FROM symbol_versions
        WHERE status='stale' AND branch_id IN (${branches.map(() => "?").join(",")}) GROUP BY branch_id`,
    ).all(...branches.map((branch) => branch.id)) as Array<{ branchId: string; n: number }>) staleCounts.set(row.branchId, row.n);
  }
  const trusts = trustEnvelopesForBranches(store, branches.map((branch) => branch.id));
  return {
    repos: repos.map((repo) => {
      const repoBranches = branches.filter((branch) => branch.repoId === repo.id);
      return {
        repoId: repo.id, name: repo.name, rootPath: repo.rootPath,
        defaultBranch: repoBranches.find((b) => b.defaultBranch === 1)?.name ?? null,
        branches: repoBranches.map((b) => {
          return {
            branchId: b.id, name: b.name, status: b.status,
            lastIndexedAt: b.lastIndexedAt, staleSymbols: staleCounts.get(b.id) ?? 0,
            pinned: !!b.pinned, defaultBranch: b.defaultBranch === 1, baseBranchName: b.baseBranchName, trust: trusts.get(b.id) ?? null,
          };
        }),
      };
    }),
  };
}

export function compactIndexStatus(store: KnowledgeStore): CompactIndexStatus {
  const detailed = indexStatus(store);
  const repos = detailed.repos.map((repo): CompactRepoStatus => {
    const live = repo.branches.find((branch) => branch.status === "live") ?? null;
    const trust = live?.trust ?? null;
    const errorRow = store.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM files_index
          WHERE repo_id=? AND status='error'`,
      )
      .get(repo.repoId) as { count: number };
    const freshness: CompactRepoStatus["freshness"] = trust === null
      ? "unknown"
      : trust.stale || trust.alignment === "head_advanced"
        ? "stale"
        : trust.alignment === "dirty"
          ? "dirty"
          : trust.alignment === "aligned"
            ? "fresh"
            : "unknown";
    return {
      repo: repo.name,
      liveBranch: live?.name ?? null,
      freshness,
      dirtyFileCount: trust?.dirtyFiles.length ?? null,
      indexedCommit: trust?.indexedCommit ?? null,
      headCommit: trust?.headCommit ?? null,
      parserVersion: trust?.parserVersion ?? null,
      indexErrorCount: errorRow.count,
    };
  });
  return {
    summary: {
      totalRepos: repos.length,
      fresh: repos.filter((repo) => repo.freshness === "fresh").length,
      dirty: repos.filter((repo) => repo.freshness === "dirty").length,
      stale: repos.filter((repo) => repo.freshness === "stale").length,
      unknown: repos.filter((repo) => repo.freshness === "unknown").length,
      errors: repos.reduce((sum, repo) => sum + repo.indexErrorCount, 0),
    },
    repos,
  };
}

// —— AI Context Pack (§ vision主产品): 把富图变现成「AI 写代码前的最小必要上下文」——
// Not a graph dump: a focused, branch-aware bundle around one target — the code,
// who calls it, what it calls/uses, the routes that reach it, its tests, the
// errors/env it touches, linked notes, and risk signals. This is what an AI
// coding agent should read BEFORE editing (the differentiator over graph tools).

export interface ContextBrief {
  nodeId: string;
  title: string;
  nodeType: string;
  /** Relation-family occurrence identity, stable across context pages. */
  relationType?: string;
  /** Distinguishes the same node when it appears through different relations. */
  relationItemId?: string;
  /** Repo-relative path of the symbol's fresh definition, when it has one. */
  filePath?: string;
  startLine?: number;
  endLine?: number;
  /** Source ownership is emitted with relation items for cross-repo safety. */
  source?: SourceReference;
  /** True when this relation crosses from the focused source repository. */
  boundary?: boolean;
  /** Evidence carried by the edge that exposed this relation. */
  evidenceState?: EvidenceProofStatus;
}

export interface ExternalCallGroup {
  specifier: string;
  callees: Array<{ callee: string; receiver: string | null; line: number }>;
}

export interface ContextPack {
  target: string;
  trust: TrustEnvelope | null;
  focus:
    | {
        nodeId: string;
        title: string;
        nodeType: string;
        kind: string | null;
        filePath: string | null;
        signature: string | null;
        source: string | null;
        branches: Array<{ branch: string; status: string }>;
      }
    | null;
  callers: ContextBrief[]; // who calls the focus (calls edges in)
  calls: ContextBrief[]; // what the focus calls (calls edges out)
  renderedBy: ContextBrief[]; // components that render the focus (renders edges in)
  renders: ContextBrief[]; // components the focus renders (renders edges out)
  invokedDynamicallyBy: ContextBrief[]; // callers using a callback prop
  invokesDynamic: ContextBrief[]; // callback props the focus invokes
  remoteCalls: ContextBrief[]; // gRPC services the focus invokes (invokes edges out, cross-service)
  invokedBy: ContextBrief[]; // symbols in OTHER services that invoke an endpoint this focus handles
  referencedBy: ContextBrief[]; // who uses this as a type (references in)
  usesTypes: ContextBrief[]; // types the focus uses (references out)
  routes: Array<{ route: string; via: "direct" | "caller" }>; // HTTP routes reaching the focus
  tests: ContextBrief[]; // test files that exercise the focus
  errors: string[]; // error types the focus throws
  envs: string[]; // env vars the focus reads
  notes: ContextBrief[]; // notes linked to the focus
  importers: ContextBrief[]; // files importing the focus's file
  /** Direct endpoint edges, normalized by the same reader used by flow/inventory. */
  firstHopRelations: EndpointRelation[];
  /** Compatibility grouping for endpoint provider implementations. */
  handles: EndpointRelation[];
  signals: string[]; // risk/attention heuristics
  // Calls that provably leave the repo, so no in-repo edge can exist. Recorded
  // rather than dropped: a caller once got a tidy 10-item callee list for a
  // method whose two most important calls went to an external SDK, at "high"
  // confidence with no gap reported. Grouped by specifier so a component
  // calling 30 library hooks does not produce 30 entries.
  externalCalls: ExternalCallGroup[];
  // "Are the lists above complete?" — a different question from confidence,
  // which says how much to trust the edges that ARE here. Both are needed:
  // high confidence in an incomplete list is exactly what misled that caller.
  completeness: {
    /** Never "complete". The calls list is a LOWER BOUND: the resolver models
     * direct calls, and does not model constructor invocation, interface
     * dispatch, static-method calls or calls inside callback bodies — so a
     * short list can mean "few calls" or "few calls we can see", and nothing
     * here can tell them apart. "unknown" means there is no answer at all
     * (nothing resolved), which previously reported "complete" alongside
     * confidence "high" for a symbol that is not in the index. */
    status: "lower_bound" | "partial" | "unknown";
    externalCallCount: number;
    /** Plain-language statement of what the list does and does not cover. */
    note: string;
  };
  // Relations whose real size exceeded `limit`, named by their field above
  // (e.g. ["calls","callers"]). A list at exactly `limit` is otherwise
  // indistinguishable from a complete one, so a consumer cannot tell whether
  // to re-query with a higher limit — the same reason `sourcesOmitted` names
  // dropped source blocks instead of returning a short array silently.
  truncated: string[];
  // Populated ONLY when `target` matched 2+ symbols and no single focus could
  // be chosen; null (not []) otherwise, so callers can tell "ambiguous" apart
  // from "zero matches" — both used to look identical (silent empty focus).
  ambiguous: SymbolCandidate[] | null;
  // Populated ONLY when `target` resolved to exactly one symbol but assembling
  // its context pack then threw (e.g. a corrupt/incomplete DB row) — a FOURTH
  // distinct outcome from zero/one/ambiguous: the symbol demonstrably exists,
  // so reporting this as "no context" would be misleading (looks like a typo
  // when it's actually an internal failure worth investigating/reporting).
  assemblyError: string | null;
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // query silently answered against the repo's live branch instead (see
  // FlowResult.scopeFallback).
  scopeFallback?: { branchId: string };
  evidence?: EvidenceEnvelope;
  scope?: Record<string, unknown> | null;
  revision?: RevisionContext | null;
  freshness?: EvidenceEnvelope["freshness"];
  coverage?: EvidenceEnvelope["coverage"];
  proofStatus?: EvidenceProofStatus;
  candidateCount?: number;
  totalIsExact?: boolean;
  returnedCount?: number;
  cursor?: string | null;
}

function contextPayloadCount(result: ContextPack): number {
  // `handles` is a compatibility subset of firstHopRelations and is omitted
  // here to avoid double-counting the same endpoint edge.
  const relationLists: Array<readonly unknown[]> = [
    result.callers, result.calls, result.renderedBy, result.renders,
    result.invokedDynamicallyBy, result.invokesDynamic, result.remoteCalls,
    result.invokedBy, result.referencedBy, result.usesTypes, result.routes,
    result.tests, result.errors, result.envs, result.notes, result.importers,
    result.firstHopRelations, result.externalCalls,
  ];
  return relationLists.reduce((total, items) => total + items.length, 0);
}

const CONTEXT_PAGE_RELATIONS = [
  "callers", "calls", "renderedBy", "renders", "invokedDynamicallyBy",
  "invokesDynamic", "remoteCalls", "invokedBy", "referencedBy", "usesTypes",
  "routes", "tests", "errors", "envs", "notes", "importers",
  "firstHopRelations", "externalCalls",
] as const satisfies readonly (keyof ContextPack)[];

/** Apply one global window across every context relation family. A cursor is
 * an offset in this fixed family order; it must never mean "offset N inside
 * every family", which repeats small families forever and can return
 * relationCount * limit items from a page that advertised only limit. */
function paginateContextPackRelations(result: ContextPack, offset: number, limit: number): ContextPack {
  const entries = CONTEXT_PAGE_RELATIONS.flatMap((relation) =>
    (result[relation] as readonly unknown[]).map((item) => ({ relation, item })),
  );
  const selected = entries.slice(offset, offset + limit);
  const paged = {
    ...result,
    callers: [], calls: [], renderedBy: [], renders: [], invokedDynamicallyBy: [],
    invokesDynamic: [], remoteCalls: [], invokedBy: [], referencedBy: [], usesTypes: [],
    routes: [], tests: [], errors: [], envs: [], notes: [], importers: [],
    firstHopRelations: [], handles: [], externalCalls: [],
  } as ContextPack;
  for (const { relation, item } of selected) {
    const identified = item && typeof item === "object" && "nodeId" in item
      ? {
          ...item,
          relationType: relation,
          relationItemId: [
            relation,
            "edgeType" in item ? String(item.edgeType ?? "") : "",
            String(item.nodeId),
            "filePath" in item ? String(item.filePath ?? "") : "",
            "startLine" in item ? String(item.startLine ?? "") : "",
            "endLine" in item ? String(item.endLine ?? "") : "",
          ].join("|"),
        }
      : item;
    (paged[relation] as unknown[]).push(identified);
  }
  paged.handles = paged.firstHopRelations.filter((relation) => relation.edgeType === "handles");
  const moreEntries = entries.slice(offset + limit);
  const moreRelations = new Set<string>([
    ...result.truncated,
    ...moreEntries.map(({ relation }) => relation),
  ]);
  paged.truncated = [...moreRelations].sort();
  paged.returnedCount = selected.length;
  paged.totalIsExact = result.truncated.length === 0;
  paged.candidateCount = paged.totalIsExact
    ? entries.length
    : Math.max(entries.length, offset + selected.length + (paged.truncated.length > 0 ? 1 : 0));
  return paged;
}

function briefsFrom(
  store: KnowledgeStore,
  rows: Array<{ id: string }>,
  scope?: TargetScopeOptions,
  parentSource?: SourceReference | null,
): ContextBrief[] {
  // Pass the brief through whole — dropping to the three name fields here is
  // what made every relation list coordinate-free.
  return rows.map((r) => {
    const brief = nodeBrief(store, r.id, scope);
    return parentSource?.repoId && brief.source?.repoId && parentSource.repoId !== brief.source.repoId
      ? { ...brief, boundary: true }
      : brief;
  });
}

export interface EndpointInventoryItem {
  nodeId: string;
  title: string;
  identityKey: string;
  protocol: string | null;
  source: SourceReference | null;
  handlers: ContextBrief[];
  firstHopRelations: EndpointRelation[];
  handlerStatus: "handled" | "proto_only" | "incomplete";
  memberships: Array<{ repoId: string; role: "provider" | "consumer" | "declaration"; filePath: string; locatorNodeId: string | null }>;
  occurrences: EndpointOccurrence[];
}

export interface EndpointRelation extends ContextBrief {
  edgeType: string;
  evidenceState: EvidenceProofStatus;
  edgeEvidence: {
    origin: string | null;
    method: string | null;
    confidence: number | null;
    provenance: Record<string, unknown> | null;
    scope: "revision" | "global" | "legacy_global" | null;
  };
  graphEvidence?: GraphEdgeEvidenceEnvelope;
}

export interface EndpointInventoryScope {
  repoId: string | null;
  branchId: string | null;
  revisionId: string | null;
  revision: RevisionContext | null;
}

export interface EndpointInventoryPage {
  items: EndpointInventoryItem[];
  scope: EndpointInventoryScope;
  candidateCount: number;
  remainingCount: number;
  totalIsExact: true;
  truncated: boolean;
  nextCursor: string | null;
  publication: EndpointPublicationReceipt;
}

export interface EndpointRelationView {
  endpoint: {
    nodeId: string;
    title: string;
    identityKey: string;
    protocol: string | null;
    source: SourceReference | null;
  };
  memberships: Array<{ repoId: string; role: "provider" | "consumer" | "declaration"; filePath: string; locatorNodeId: string | null }>;
  handlers: EndpointRelation[];
  handlerStatus: "handled" | "proto_only" | "incomplete";
  relations: EndpointRelation[];
}

const ENDPOINT_FIRST_HOP_EDGE_TYPES = ["calls", "renders", "invokes_dynamic", "invokes", "references", "reads", "writes", "throws", "uses", "handles"];
const ENDPOINT_INVENTORY_ORDERING = "identityKey,nodeId";
const ENDPOINT_INVENTORY_CURSOR_CODEC = new HmacOperationCursorCodec(resolveLocalCursorSecret());

interface EndpointRawRelation {
  nodeId: string;
  edgeType: string;
  origin: string | null;
  method: string | null;
  confidence: number | null;
  provenance: string | Record<string, unknown> | null;
  scope: "revision" | "global" | "legacy_global" | null;
}

/** One branch/revision decision shared by endpoint provenance, inventory and cursors. */
export function resolveEndpointInventoryScope(
  store: KnowledgeStore,
  options: TargetScopeOptions = {},
): EndpointInventoryScope {
  const repoId = options.repoId ?? options.revision?.repoId ?? null;
  if (!repoId) return { repoId: null, branchId: null, revisionId: null, revision: null };
  if (options.revision) {
    return {
      repoId,
      branchId: options.revision.branchId ?? options.branchId ?? null,
      revisionId: options.revision.snapshotId.startsWith("legacy:") ? options.revision.commitSha : options.revision.snapshotId,
      revision: options.revision,
    };
  }
  const row = store.db.prepare(
    `SELECT id AS branchId, name, head_commit AS headCommit,
            last_indexed_commit AS lastIndexedCommit,
            current_snapshot_id AS currentSnapshotId, status
       FROM branches
      WHERE repo_id=? AND status <> 'gone'
        ${options.branchId ? "AND id=?" : ""}
      ORDER BY CASE WHEN status='live' THEN 0 ELSE 1 END,
               default_branch DESC, last_indexed_at DESC, id
      LIMIT 1`,
  ).get(...(options.branchId ? [repoId, options.branchId] : [repoId])) as {
    branchId: string; name: string; headCommit: string | null; lastIndexedCommit: string | null;
    currentSnapshotId: string | null; status: string;
  } | undefined;
  if (!row) return { repoId, branchId: null, revisionId: null, revision: null };
  const resolution = resolveRevisionContext(store, {
    repoId,
    ...(row.currentSnapshotId ? { snapshotId: row.currentSnapshotId } : { branch: row.branchId }),
  });
  const revision = resolution.status === "resolved"
    ? resolution.context
    : {
        repoId,
        branch: row.name,
        branchId: row.branchId,
        commitSha: row.lastIndexedCommit ?? row.headCommit ?? "(worktree)",
        snapshotId: `legacy:${row.branchId}`,
        trust: row.status === "live" ? "fallback_live" as const : "trust_unavailable" as const,
      };
  return {
    repoId,
    branchId: row.branchId,
    revisionId: revision.snapshotId.startsWith("legacy:") ? revision.commitSha : revision.snapshotId,
    revision,
  };
}

function endpointRelationEvidenceState(edge: {
  edgeType?: string | null;
  method: string | null;
  origin: string | null;
  provenance: Record<string, unknown> | null;
}): EvidenceProofStatus {
  const evidence = graphEdgeEvidence(edge);
  return evidence.evidenceState === "proven"
    ? "proven"
    : evidence.evidenceState === "candidate" || evidence.evidenceState === "inferred"
      ? "candidate"
      : "not_proven";
}

/**
 * Canonical endpoint first-hop view. Context, flow and inventory deliberately
 * consume this one reader so branch filtering, provenance and edge evidence
 * cannot drift between public surfaces.
 */
function readEndpointRelationsWithRaw(
  store: KnowledgeStore,
  endpointId: string,
  options: TargetScopeOptions = {},
  prefetchedRawRelations?: EndpointRawRelation[],
): EndpointRelationView | null {
  const endpoint = store.getNode(endpointId);
  if (!endpoint || endpoint.node_type !== "endpoint") return null;
  const allMemberships = store.listEndpointMemberships(endpointId);
  // An omitted repository means a genuinely global inventory read. Picking a
  // membership here would silently discard the same endpoint's other owners.
  const selectedRepoId = options.repoId ?? options.revision?.repoId ?? undefined;
  const selectedScope = resolveEndpointInventoryScope(store, { ...options, repoId: selectedRepoId });
  const memberships = selectedScope.repoId
    ? allMemberships.filter((membership) => membership.repoId === selectedScope.repoId)
    : allMemberships;
  const effectiveScope: TargetScopeOptions = {
    ...(selectedScope.repoId ? { repoId: selectedScope.repoId } : {}),
    ...(selectedScope.branchId ? { branchId: selectedScope.branchId } : {}),
    ...(selectedScope.revision ? { revision: selectedScope.revision } : {}),
  };
  // A global endpoint shared by multiple repositories has no single truthful
  // root provenance. Relations below still resolve against their own nodes.
  const source = selectedScope.repoId || endpoint.repo_id
    ? sourceContextForNode(store, endpointId, effectiveScope)
    : null;
  const membershipRepoIds = new Set(memberships.map((membership) => membership.repoId));
  const branchId = selectedScope.branchId ?? source?.branchId ?? undefined;
  const snapshotRevision = selectedScope.revision && !selectedScope.revision.snapshotId.startsWith("legacy:")
    ? selectedScope.revision
    : null;
  const rawRelations = prefetchedRawRelations ?? (snapshotRevision
    ? snapshotEdgePairsForNodes(store, snapshotRevision, [endpointId], {
        edgeTypes: ENDPOINT_FIRST_HOP_EDGE_TYPES,
        direction: "out",
        limit: 10_000,
      }).filter((edge) => edge.src === endpointId && edge.dst).map((edge) => ({
        nodeId: edge.dst!, edgeType: edge.edgeType, origin: null, method: edge.method,
        confidence: edge.confidence, provenance: edge.provenance, scope: edge.scope,
      }))
    : store.db.prepare(
        `SELECT DISTINCT dst AS nodeId, edge_type AS edgeType, origin, method, confidence, provenance,
                CASE WHEN branch_id IS NULL THEN 'legacy_global' ELSE 'revision' END AS scope
           FROM edges
          WHERE src=? AND dst IS NOT NULL AND status='active'
            AND edge_type IN (${ENDPOINT_FIRST_HOP_EDGE_TYPES.map(() => "?").join(",")})
            ${branchId ? "AND (branch_id=? OR branch_id IS NULL)" : ""}
          ORDER BY edge_type, dst`,
      ).all(...(branchId
        ? [endpointId, ...ENDPOINT_FIRST_HOP_EDGE_TYPES, branchId]
        : [endpointId, ...ENDPOINT_FIRST_HOP_EDGE_TYPES])) as Array<{
          nodeId: string; edgeType: string; origin: string | null; method: string | null; confidence: number | null;
          provenance: string | Record<string, unknown> | null; scope: "revision" | "legacy_global" | null;
        }>);
  const unscopedRelations = rawRelations.flatMap((edge): EndpointRelation[] => {
    if (!store.getNode(edge.nodeId)) return [];
    const brief = nodeBrief(store, edge.nodeId, effectiveScope);
    const boundary = brief.source?.repoId && (source?.repoId
      ? source.repoId !== brief.source.repoId
      : membershipRepoIds.size > 0 && !membershipRepoIds.has(brief.source.repoId));
    let provenance: Record<string, unknown> | null = null;
    if (typeof edge.provenance === "string") {
      try { provenance = JSON.parse(edge.provenance) as Record<string, unknown>; } catch { provenance = null; }
    } else provenance = edge.provenance;
    const graphEvidence = graphEdgeEvidence({ edgeType: edge.edgeType, method: edge.method, origin: edge.origin, confidence: edge.confidence, provenance, scope: edge.scope });
    const evidenceState = endpointRelationEvidenceState({ edgeType: edge.edgeType, method: edge.method, origin: edge.origin, provenance });
    return [{
      ...brief,
      edgeType: edge.edgeType,
      evidenceState,
      edgeEvidence: { origin: edge.origin, method: edge.method, confidence: edge.confidence, provenance, scope: edge.scope },
      graphEvidence,
      ...(boundary ? { boundary: true } : {}),
    }];
  });
  const providerLocators = new Set(
    memberships.filter((membership) => membership.role === "provider" && membership.locatorNodeId)
      .map((membership) => membership.locatorNodeId!),
  );
  const relations = unscopedRelations.filter((relation) => {
    if (relation.edgeType !== "handles" || !selectedScope.repoId) return true;
    if (snapshotRevision) return relation.source?.repoId === selectedScope.repoId;
    if (providerLocators.has(relation.nodeId)) return relation.source?.repoId === selectedScope.repoId;
    return endpoint.repo_id === selectedScope.repoId && relation.source?.repoId === selectedScope.repoId;
  });
  const handlers = relations.filter((relation) => relation.edgeType === "handles");
  let protocol: string | null = null;
  try { protocol = (JSON.parse(endpoint.meta || "{}") as { protocol?: string }).protocol ?? null; } catch { protocol = null; }
  return {
    endpoint: { nodeId: endpoint.id, title: endpoint.title, identityKey: endpoint.identity_key, protocol, source },
    memberships,
    handlers,
    handlerStatus: store.endpointHandlerStatus(endpointId, selectedScope.repoId ?? undefined),
    relations,
  };
}

export function readEndpointRelations(
  store: KnowledgeStore,
  endpointId: string,
  options: TargetScopeOptions = {},
): EndpointRelationView | null {
  return readEndpointRelationsWithRaw(store, endpointId, options);
}

/** Revision fingerprint used by endpoint cursors. */
export function endpointInventoryRevision(store: KnowledgeStore, repoId?: string, _protocol?: string): string | null {
  return store.db.transaction(() => {
    const scope = resolveEndpointInventoryScope(store, { repoId });
    if (scope.branchId) return `${scope.branchId}@${scope.revisionId ?? "unknown"}`;
    return scope.repoId ? null : globalEndpointInventoryRevision(store);
  })();
}

interface EndpointInventoryRow {
  nodeId: string;
  title: string;
  identityKey: string;
  protocol: string | null;
  occurrences?: EndpointOccurrence[];
}

class EndpointInventoryPageError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT", message: string) {
    super(message);
    this.name = "EndpointInventoryPageError";
  }
}

function endpointInventoryFilter(repoId: string | undefined, options: EndpointInventoryPageOptions): { where: string[]; params: string[] } {
  const params: string[] = [];
  const where = ["n.node_type='endpoint'"];
  if (repoId) {
    // Repo-owned legacy endpoints have explicit ownership on the node itself.
    // Global endpoints never inherit scope from NULL: they require a persisted
    // endpoint_memberships row for the requested repository.
    where.push("(n.repo_id=? OR EXISTS (SELECT 1 FROM endpoint_memberships em WHERE em.endpoint_id=n.id AND em.repo_id=?))");
    params.push(repoId, repoId);
  } else {
    where.push("(n.repo_id IS NOT NULL OR EXISTS (SELECT 1 FROM endpoint_memberships any_em WHERE any_em.endpoint_id=n.id))");
  }
  if (options.protocol) {
    where.push("json_extract(n.meta, '$.protocol')=?");
    params.push(options.protocol);
  }
  if (options.service) {
    where.push("(LOWER(n.identity_key) LIKE LOWER(?) OR LOWER(n.identity_key) LIKE LOWER(?))");
    params.push(`grpc::${options.service}.%`, `grpc::%.${options.service}.%`);
  }
  if (options.method) {
    where.push("LOWER(n.identity_key) LIKE LOWER(?)");
    params.push(`%.${options.method}`);
  }
  if (options.path) {
    const path = options.path.replace(/^\.\//u, "").replace(/\/$/u, "");
    where.push("EXISTS (SELECT 1 FROM endpoint_memberships path_em WHERE path_em.endpoint_id=n.id AND (path_em.file_path=? OR path_em.file_path LIKE ?))");
    params.push(path, `${path}/%`);
  }
  const requestedKind = options.handledOnly === true ? "handler" : options.provenanceKind;
  if (requestedKind) {
    const normalizedPath = "REPLACE(LOWER(kind_em.file_path), CHAR(92), '/')";
    const isTestPath = `(${normalizedPath} GLOB 'test/*' OR ${normalizedPath} GLOB 'tests/*' OR ${normalizedPath} GLOB '*/test/*' OR ${normalizedPath} GLOB '*/tests/*' OR ${normalizedPath} GLOB '__tests__/*' OR ${normalizedPath} GLOB '*/__tests__/*' OR ${normalizedPath} GLOB 'fixture/*' OR ${normalizedPath} GLOB 'fixtures/*' OR ${normalizedPath} GLOB '*/fixture/*' OR ${normalizedPath} GLOB '*/fixtures/*' OR ${normalizedPath} GLOB 'mock/*' OR ${normalizedPath} GLOB 'mocks/*' OR ${normalizedPath} GLOB '*/mock/*' OR ${normalizedPath} GLOB '*/mocks/*' OR ${normalizedPath} GLOB '*.spec.*' OR ${normalizedPath} GLOB '*.test.*')`;
    const role = requestedKind === "handler"
      ? "provider"
      : requestedKind === "definition"
        ? "declaration"
        : requestedKind === "client"
          ? "consumer"
          : null;
    const kindPredicate = requestedKind === "test"
      ? isTestPath
      : `kind_em.role=? AND NOT ${isTestPath}`;
    where.push(`EXISTS (
      SELECT 1 FROM endpoint_memberships kind_em
       WHERE kind_em.endpoint_id=n.id
         ${repoId ? "AND kind_em.repo_id=?" : ""}
         AND ${kindPredicate}
    )`);
    if (repoId) params.push(repoId);
    if (role) params.push(role);
  }
  return { where, params };
}

function globalEndpointInventoryRevision(store: KnowledgeStore): string {
  const row = store.db.prepare(
    "SELECT value FROM meta WHERE key=?",
  ).get("endpoint_inventory_generation") as { value: string } | undefined;
  if (!row) {
    throw Object.assign(
      new Error("knowledge database schema is missing endpoint inventory generation metadata; the owner must call knowledge_index to upgrade"),
      { code: "SCHEMA_OUTDATED" },
    );
  }
  return `global-endpoints:${row.value}`;
}

function hydrateEndpointInventoryRows(
  store: KnowledgeStore,
  rows: EndpointInventoryRow[],
  scope: EndpointInventoryScope,
): EndpointInventoryItem[] {
  // A scoped page has one branch/revision, so read all first-hop edges once.
  // The previous per-endpoint reader re-expanded the same snapshot resolution
  // set for every row (500 rows x thousands of refs on a real repository).
  // Keep the unscoped path conservative because repo-owned endpoints can each
  // select a different source branch there.
  const rawRelationsByEndpoint = scope.branchId
    ? endpointRawRelationsForPage(store, rows.map((row) => row.nodeId), scope)
    : null;
  const result = rows.map((row) => {
    const view = readEndpointRelationsWithRaw(store, row.nodeId, {
      ...(scope.repoId ? { repoId: scope.repoId } : {}),
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      ...(scope.revision ? { revision: scope.revision } : {}),
    }, rawRelationsByEndpoint?.get(row.nodeId))!;
    const occurrences = row.occurrences ?? endpointMembershipOccurrences(store, row.nodeId, scope);
    const hasHandler = occurrences.some((occurrence) => occurrence.provenanceKind === "handler");
    const hasDefinition = occurrences.some((occurrence) => occurrence.provenanceKind === "definition");
    return {
      ...row,
      source: view.endpoint.source,
      handlers: view.handlers,
      firstHopRelations: view.relations,
      handlerStatus: hasHandler ? "handled" as const : hasDefinition ? "proto_only" as const : "incomplete" as const,
      memberships: view.memberships,
      occurrences,
    };
  });
  return result;
}

function endpointMembershipOccurrences(
  store: KnowledgeStore,
  endpointId: string,
  scope: EndpointInventoryScope,
): EndpointOccurrence[] {
  const memberships = store.listEndpointMemberships(endpointId, scope.repoId ?? undefined);
  const commit = scope.revision?.commitSha ?? scope.revisionId ?? "unknown";
  const snapshot = scope.revision?.snapshotId ?? scope.revisionId ?? "unknown";
  const occurrences = memberships.map((membership): EndpointOccurrence => {
    const edgeType = membership.role === "provider"
      ? "handles" as const
      : membership.role === "declaration"
        ? "declares" as const
        : "invokes" as const;
    const source = membership.locatorNodeId
      ? sourceContextForNode(store, membership.locatorNodeId, {
          ...(scope.repoId ? { repoId: scope.repoId } : {}),
          ...(scope.branchId ? { branchId: scope.branchId } : {}),
          ...(scope.revision ? { revision: scope.revision } : {}),
        })
      : null;
    return {
      provenanceKind: classifyEndpointProvenanceKind({ edgeType, filePath: membership.filePath }),
      repoId: membership.repoId,
      commit,
      snapshot,
      file: membership.filePath,
      line: source?.startLine ?? 0,
      ...(source?.endLine != null ? { endLine: source.endLine } : {}),
      ...(membership.locatorNodeId ? { locatorNodeId: membership.locatorNodeId } : {}),
    };
  });
  return dedupeEndpointOccurrences(occurrences);
}

function dedupeEndpointOccurrences(occurrences: EndpointOccurrence[]): EndpointOccurrence[] {
  const unique = new Map<string, EndpointOccurrence>();
  for (const occurrence of occurrences) {
    const key = [
      occurrence.provenanceKind,
      occurrence.repoId,
      occurrence.commit,
      occurrence.snapshot,
      occurrence.file,
      occurrence.line,
      occurrence.locatorNodeId ?? "",
    ].join("\u0000");
    unique.set(key, occurrence);
  }
  return [...unique.values()].sort(compareEndpointOccurrences);
}

function endpointRawRelationsForPage(
  store: KnowledgeStore,
  endpointIds: string[],
  scope: EndpointInventoryScope,
): Map<string, EndpointRawRelation[]> {
  const grouped = new Map<string, EndpointRawRelation[]>();
  for (const endpointId of endpointIds) grouped.set(endpointId, []);
  if (endpointIds.length === 0 || !scope.branchId) return grouped;

  const snapshotRevision = scope.revision && !scope.revision.snapshotId.startsWith("legacy:")
    ? scope.revision
    : null;
  const rows: Array<EndpointRawRelation & { endpointId: string }> = snapshotRevision
    ? snapshotEdgePairsForNodes(store, snapshotRevision, endpointIds, {
        edgeTypes: ENDPOINT_FIRST_HOP_EDGE_TYPES,
        direction: "out",
        // Preserve the old per-endpoint 10k ceiling while avoiding N identical
        // snapshot-resolution scans. Real endpoint first hops are far smaller.
        limit: Math.max(10_000, endpointIds.length * 10_000),
      }).filter((edge) => edge.dst).map((edge) => ({
        endpointId: edge.src,
        nodeId: edge.dst!,
        edgeType: edge.edgeType,
        origin: null,
        method: edge.method,
        confidence: edge.confidence,
        provenance: edge.provenance,
        scope: edge.scope,
      }))
    : store.db.prepare(
        `SELECT src AS endpointId, dst AS nodeId, edge_type AS edgeType,
                origin, method, confidence, provenance,
                CASE WHEN branch_id IS NULL THEN 'legacy_global' ELSE 'revision' END AS scope
           FROM edges
          WHERE src IN (${endpointIds.map(() => "?").join(",")})
            AND dst IS NOT NULL AND status='active'
            AND edge_type IN (${ENDPOINT_FIRST_HOP_EDGE_TYPES.map(() => "?").join(",")})
            AND (branch_id=? OR branch_id IS NULL)
          ORDER BY src, edge_type, dst`,
    ).all(...endpointIds, ...ENDPOINT_FIRST_HOP_EDGE_TYPES, scope.branchId) as Array<EndpointRawRelation & { endpointId: string }>;

  for (const row of rows) grouped.get(row.endpointId)?.push({
    nodeId: row.nodeId,
    edgeType: row.edgeType,
    origin: row.origin,
    method: row.method,
    confidence: row.confidence,
    provenance: row.provenance,
    scope: row.scope,
  });
  return grouped;
}

export interface EndpointInventoryPageOptions {
  repoId?: string;
  protocol?: string;
  service?: string;
  method?: string;
  path?: string;
  handledOnly?: boolean;
  provenanceKind?: EndpointProvenanceKind;
  scope?: EndpointInventoryScope;
  limit?: number;
  cursor?: string;
}

const ENDPOINT_PUBLICATION_EDGE_TYPES = ["handles", "declares", "invokes"];

function endpointIdentityParts(identityKey: string): { service: string; method: string } | null {
  if (!identityKey.startsWith("grpc::")) return null;
  const body = identityKey.slice("grpc::".length);
  const split = body.lastIndexOf(".");
  if (split < 1) return null;
  const servicePath = body.slice(0, split);
  return { service: servicePath.slice(servicePath.lastIndexOf(".") + 1), method: body.slice(split + 1) };
}

function endpointFilterKey(options: EndpointInventoryPageOptions): string {
  return JSON.stringify({
    protocol: options.protocol ?? null,
    service: options.service?.toLowerCase() ?? null,
    method: options.method?.toLowerCase() ?? null,
    path: options.path?.replace(/^\.\//u, "").replace(/\/$/u, "") ?? null,
    handledOnly: options.handledOnly === true,
    provenanceKind: options.provenanceKind ?? null,
  });
}

function matchesEndpointFilter(input: {
  identityKey: string;
  protocol: string | null;
  occurrences: EndpointOccurrence[];
}, options: EndpointInventoryPageOptions): boolean {
  if (options.protocol && input.protocol !== options.protocol) return false;
  const parts = endpointIdentityParts(input.identityKey);
  if (options.service && parts?.service.toLowerCase() !== options.service.toLowerCase()) return false;
  if (options.method && parts?.method.toLowerCase() !== options.method.toLowerCase()) return false;
  const requestedPath = options.path?.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (requestedPath && !input.occurrences.some((occurrence) => occurrence.file === requestedPath || occurrence.file.startsWith(`${requestedPath}/`))) return false;
  const requestedKind = options.handledOnly === true ? "handler" : options.provenanceKind;
  if (requestedKind && !input.occurrences.some((occurrence) => occurrence.provenanceKind === requestedKind)) return false;
  return true;
}

function endpointOccurrenceForRevisionEdge(
  store: KnowledgeStore,
  scope: EndpointInventoryScope,
  edge: RevisionEdgeRow,
  locatorSources: ReadonlyMap<string, RevisionSymbolRow>,
): EndpointOccurrence | null {
  if (!scope.repoId || !scope.revision) return null;
  const filePath = typeof edge.provenance.filePath === "string" ? edge.provenance.filePath : null;
  if (!filePath) return null;
  const locatorIdentityKey = edge.edgeType === "invokes" ? edge.srcIdentityKey : edge.dstIdentityKey;
  const locatorNodeId = locatorIdentityKey ? store.findNodeIdByIdentity(locatorIdentityKey) : null;
  const locatorSource = locatorIdentityKey ? locatorSources.get(locatorIdentityKey) : undefined;
  const startLine = typeof edge.provenance.startLine === "number"
    ? edge.provenance.startLine
    : locatorSource?.startLine ?? 0;
  const endLine = typeof edge.provenance.endLine === "number"
    ? edge.provenance.endLine
    : locatorSource?.endLine;
  return {
    provenanceKind: classifyEndpointProvenanceKind({
      edgeType: edge.edgeType as "handles" | "declares" | "invokes",
      filePath,
    }),
    repoId: scope.repoId,
    commit: scope.revision.commitSha,
    snapshot: scope.revision.snapshotId,
    file: filePath,
    line: startLine,
    ...(endLine != null ? { endLine } : {}),
    ...(locatorNodeId ? { locatorNodeId } : {}),
  };
}

interface RevisionEndpointPageRows {
  rows: EndpointInventoryRow[];
  candidateCount: number;
  eligibleCount: number;
  hasNext: boolean;
}

const REVISION_ENDPOINT_CTE = `
  WITH RECURSIVE snapshot_chain(snapshot_id,depth) AS (
    SELECT ?,0
    UNION ALL
    SELECT rs.base_snapshot_id,snapshot_chain.depth+1
      FROM snapshot_chain
      JOIN revision_snapshots rs ON rs.id=snapshot_chain.snapshot_id
     WHERE rs.base_snapshot_id IS NOT NULL
  ),
  effective_resolution_refs AS (
    SELECT sr.resolution_set_id
      FROM snapshot_chain chain
      JOIN snapshot_resolution_refs sr ON sr.snapshot_id=chain.snapshot_id
     WHERE NOT EXISTS (
       SELECT 1
         FROM snapshot_chain newer
         JOIN snapshot_overlays overlay ON overlay.snapshot_id=newer.snapshot_id
        WHERE newer.depth < chain.depth AND overlay.file_path=sr.file_path
     )
  ),
  endpoint_publication AS (
    SELECT edge.src_identity_key AS endpoint_identity,
           edge.dst_identity_key AS locator_identity,
           edge.edge_type AS edge_type,
           edge.method AS method,
           edge.confidence AS confidence,
           edge.provenance AS provenance,
           json_extract(edge.provenance, '$.filePath') AS file_path
      FROM effective_resolution_refs refs
      JOIN resolved_edges edge INDEXED BY idx_resolved_edges_set_type_src
        ON edge.resolution_set_id=refs.resolution_set_id
       AND edge.edge_type IN ('handles','declares')
    UNION ALL
    SELECT edge.dst_identity_key AS endpoint_identity,
           edge.src_identity_key AS locator_identity,
           edge.edge_type AS edge_type,
           edge.method AS method,
           edge.confidence AS confidence,
           edge.provenance AS provenance,
           json_extract(edge.provenance, '$.filePath') AS file_path
      FROM effective_resolution_refs refs
      JOIN resolved_edges edge INDEXED BY idx_resolved_edges_set_type_dst
        ON edge.resolution_set_id=refs.resolution_set_id
       AND edge.edge_type='invokes'
  )`;

export function materializeRevisionEndpointOccurrences(
  store: KnowledgeStore,
  input: { snapshotId: string; repoId: string; commitSha: string },
): { occurrenceCount: number } {
  return store.db.transaction(() => {
    store.db.prepare("DELETE FROM revision_endpoint_occurrences WHERE snapshot_id=?").run(input.snapshotId);
    store.db.prepare("DELETE FROM revision_endpoint_publications WHERE snapshot_id=?").run(input.snapshotId);
    store.db.prepare(
      `${REVISION_ENDPOINT_CTE}
       INSERT OR IGNORE INTO revision_endpoint_occurrences(
         snapshot_id,endpoint_node_id,endpoint_identity_key,protocol,
         locator_node_id,locator_identity_key,edge_type,provenance_kind,
         file_path,start_line,end_line,method,confidence,provenance
       )
       SELECT ?,endpoint.id,endpoint.identity_key,json_extract(endpoint.meta, '$.protocol'),
              locator.id,COALESCE(publication.locator_identity,''),publication.edge_type,
              CASE
                WHEN LOWER(COALESCE(publication.file_path,'')) LIKE '%/__tests__/%'
                  OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/test/%'
                  OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/tests/%'
                  OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/fixture/%'
                  OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/fixtures/%'
                  OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/mock/%'
                  OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/mocks/%'
                  OR LOWER(COALESCE(publication.file_path,'')) GLOB '*.spec.*'
                  OR LOWER(COALESCE(publication.file_path,'')) GLOB '*.test.*' THEN 'test'
                WHEN publication.edge_type='handles' THEN 'handler'
                WHEN publication.edge_type='declares' THEN 'definition'
                ELSE 'client'
              END,
              publication.file_path,
              COALESCE(json_extract(publication.provenance, '$.startLine'),0),
              json_extract(publication.provenance, '$.endLine'),
              publication.method,publication.confidence,publication.provenance
         FROM endpoint_publication publication
         JOIN nodes endpoint ON endpoint.identity_key=publication.endpoint_identity AND endpoint.node_type='endpoint'
         LEFT JOIN nodes locator ON locator.identity_key=publication.locator_identity
        WHERE publication.file_path IS NOT NULL`,
    ).run(input.snapshotId, input.snapshotId);
    const occurrenceCount = Number((store.db.prepare(
      "SELECT COUNT(*) AS n FROM revision_endpoint_occurrences WHERE snapshot_id=?",
    ).get(input.snapshotId) as { n: number }).n);
    store.db.prepare(
      `INSERT INTO revision_endpoint_publications(snapshot_id,repo_id,commit_sha,occurrence_count,materialized_at)
       VALUES (?,?,?,?,?)`,
    ).run(input.snapshotId, input.repoId, input.commitSha, occurrenceCount, new Date().toISOString());
    return { occurrenceCount };
  })();
}

function projectedRevisionEndpointPageRows(
  store: KnowledgeStore,
  scope: EndpointInventoryScope,
  options: EndpointInventoryPageOptions,
  after: { identityKey: string; nodeId: string } | null,
  limit: number,
): RevisionEndpointPageRows | null {
  const snapshotId = scope.revision?.snapshotId;
  if (!snapshotId || snapshotId.startsWith("legacy:")) return null;
  const publication = store.db.prepare(
    "SELECT 1 FROM revision_endpoint_publications WHERE snapshot_id=?",
  ).get(snapshotId);
  if (!publication) return null;
  const where = ["occurrence.snapshot_id=?"];
  const params: string[] = [snapshotId];
  if (options.protocol) { where.push("occurrence.protocol=?"); params.push(options.protocol); }
  if (options.service) {
    where.push("(LOWER(occurrence.endpoint_identity_key) LIKE LOWER(?) OR LOWER(occurrence.endpoint_identity_key) LIKE LOWER(?))");
    params.push(`grpc::${options.service}.%`, `grpc::%.${options.service}.%`);
  }
  if (options.method) { where.push("LOWER(occurrence.endpoint_identity_key) LIKE LOWER(?)"); params.push(`%.${options.method}`); }
  const requestedPath = options.path?.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (requestedPath) { where.push("(occurrence.file_path=? OR occurrence.file_path LIKE ?)"); params.push(requestedPath, `${requestedPath}/%`); }
  const requestedKind = options.handledOnly === true ? "handler" : options.provenanceKind;
  if (requestedKind) { where.push("occurrence.provenance_kind=?"); params.push(requestedKind); }
  const grouped = `SELECT occurrence.endpoint_node_id AS nodeId,occurrence.endpoint_identity_key AS identityKey
                     FROM revision_endpoint_occurrences occurrence
                    WHERE ${where.join(" AND ")}
                    GROUP BY occurrence.endpoint_node_id,occurrence.endpoint_identity_key`;
  const countRow = (after
    ? store.db.prepare(
        `SELECT COUNT(*) AS candidateCount,
                COALESCE(SUM(CASE WHEN identityKey>? OR (identityKey=? AND nodeId>?) THEN 1 ELSE 0 END),0) AS eligibleCount
           FROM (${grouped})`,
      ).get(after.identityKey, after.identityKey, after.nodeId, ...params)
    : store.db.prepare(
        `SELECT COUNT(*) AS candidateCount,COUNT(*) AS eligibleCount FROM (${grouped})`,
      ).get(...params)) as { candidateCount: number; eligibleCount: number };
  const candidateCount = Number(countRow.candidateCount ?? 0);
  const pageWhere = [...where];
  const pageParams = [...params];
  if (after) {
    pageWhere.push("(occurrence.endpoint_identity_key>? OR (occurrence.endpoint_identity_key=? AND occurrence.endpoint_node_id>?))");
    pageParams.push(after.identityKey, after.identityKey, after.nodeId);
  }
  const candidates = store.db.prepare(
    `SELECT occurrence.endpoint_node_id AS nodeId,n.title,
            occurrence.endpoint_identity_key AS identityKey,occurrence.protocol
       FROM revision_endpoint_occurrences occurrence
       JOIN nodes n ON n.id=occurrence.endpoint_node_id
      WHERE ${pageWhere.join(" AND ")}
      GROUP BY occurrence.endpoint_node_id,n.title,occurrence.endpoint_identity_key,occurrence.protocol
      ORDER BY occurrence.endpoint_identity_key,occurrence.endpoint_node_id
      LIMIT ?`,
  ).all(...pageParams, limit + 1) as EndpointInventoryRow[];
  const pageCandidates = candidates.slice(0, limit);
  const ids = pageCandidates.map((candidate) => candidate.nodeId);
  const occurrences = ids.length === 0 ? [] : store.db.prepare(
    `SELECT endpoint_node_id AS endpointNodeId,provenance_kind AS provenanceKind,
            locator_node_id AS locatorNodeId,file_path AS file,start_line AS line,end_line AS endLine
       FROM revision_endpoint_occurrences
      WHERE snapshot_id=? AND endpoint_node_id IN (${ids.map(() => "?").join(",")})
      ORDER BY endpoint_identity_key,provenance_kind,file_path,start_line,locator_identity_key`,
  ).all(snapshotId, ...ids) as Array<{
    endpointNodeId: string; provenanceKind: EndpointProvenanceKind; locatorNodeId: string | null;
    file: string; line: number; endLine: number | null;
  }>;
  const byEndpoint = new Map<string, EndpointOccurrence[]>();
  for (const occurrence of occurrences) {
    const values = byEndpoint.get(occurrence.endpointNodeId) ?? [];
    values.push({
      provenanceKind: occurrence.provenanceKind,
      repoId: scope.repoId!,
      commit: scope.revision!.commitSha,
      snapshot: snapshotId,
      file: occurrence.file,
      line: occurrence.line,
      ...(occurrence.endLine == null ? {} : { endLine: occurrence.endLine }),
      ...(occurrence.locatorNodeId ? { locatorNodeId: occurrence.locatorNodeId } : {}),
    });
    byEndpoint.set(occurrence.endpointNodeId, values);
  }
  return {
    rows: pageCandidates.map((candidate) => ({ ...candidate, occurrences: dedupeEndpointOccurrences(byEndpoint.get(candidate.nodeId) ?? []) })),
    candidateCount,
    eligibleCount: Number(countRow.eligibleCount ?? 0),
    hasNext: candidates.length > pageCandidates.length,
  };
}

function revisionEndpointPageRows(
  store: KnowledgeStore,
  scope: EndpointInventoryScope,
  options: EndpointInventoryPageOptions,
  after: { identityKey: string; nodeId: string } | null,
  limit: number,
): RevisionEndpointPageRows | null {
  if (!scope.revision || scope.revision.snapshotId.startsWith("legacy:")) return null;
  const projected = projectedRevisionEndpointPageRows(store, scope, options, after, limit);
  if (projected) return projected;
  const occurrenceWhere = ["n.node_type='endpoint'"];
  const occurrenceParams: string[] = [];
  if (options.protocol) {
    occurrenceWhere.push("json_extract(n.meta, '$.protocol')=?");
    occurrenceParams.push(options.protocol);
  }
  if (options.service) {
    occurrenceWhere.push("(LOWER(n.identity_key) LIKE LOWER(?) OR LOWER(n.identity_key) LIKE LOWER(?))");
    occurrenceParams.push(`grpc::${options.service}.%`, `grpc::%.${options.service}.%`);
  }
  if (options.method) {
    occurrenceWhere.push("LOWER(n.identity_key) LIKE LOWER(?)");
    occurrenceParams.push(`%.${options.method}`);
  }
  const requestedPath = options.path?.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (requestedPath) {
    occurrenceWhere.push("(publication.file_path=? OR publication.file_path LIKE ?)");
    occurrenceParams.push(requestedPath, `${requestedPath}/%`);
  }
  const requestedKind = options.handledOnly === true ? "handler" : options.provenanceKind;
  const testPath = `(LOWER(COALESCE(publication.file_path,'')) LIKE '%/__tests__/%'
    OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/test/%'
    OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/tests/%'
    OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/fixture/%'
    OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/fixtures/%'
    OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/mock/%'
    OR LOWER(COALESCE(publication.file_path,'')) LIKE '%/mocks/%'
    OR LOWER(COALESCE(publication.file_path,'')) GLOB '*.spec.*'
    OR LOWER(COALESCE(publication.file_path,'')) GLOB '*.test.*')`;
  if (requestedKind === "test") occurrenceWhere.push(testPath);
  else if (requestedKind === "handler") occurrenceWhere.push(`publication.edge_type='handles' AND NOT ${testPath}`);
  else if (requestedKind === "definition") occurrenceWhere.push(`publication.edge_type='declares' AND NOT ${testPath}`);
  else if (requestedKind === "client") occurrenceWhere.push(`publication.edge_type='invokes' AND NOT ${testPath}`);

  const baseFrom = `FROM endpoint_publication publication JOIN nodes n ON n.identity_key=publication.endpoint_identity WHERE ${occurrenceWhere.join(" AND ")}`;
  const count = store.db.prepare(
    `${REVISION_ENDPOINT_CTE} SELECT COUNT(*) AS candidateCount FROM (SELECT n.id ${baseFrom} GROUP BY n.id,n.identity_key)`,
  ).get(scope.revision.snapshotId, ...occurrenceParams) as { candidateCount: number };
  const pageWhere = [...occurrenceWhere];
  const pageParams = [...occurrenceParams];
  if (after) {
    pageWhere.push("(n.identity_key>? OR (n.identity_key=? AND n.id>?))");
    pageParams.push(after.identityKey, after.identityKey, after.nodeId);
  }
  const candidates = store.db.prepare(
    `${REVISION_ENDPOINT_CTE}
     SELECT n.id AS nodeId,n.title,n.identity_key AS identityKey,
            json_extract(n.meta, '$.protocol') AS protocol
       FROM endpoint_publication publication
       JOIN nodes n ON n.identity_key=publication.endpoint_identity
      WHERE ${pageWhere.join(" AND ")}
      GROUP BY n.id,n.title,n.identity_key,n.meta
      ORDER BY n.identity_key,n.id
      LIMIT ?`,
  ).all(scope.revision.snapshotId, ...pageParams, limit + 1) as EndpointInventoryRow[];
  const pageCandidates = candidates.slice(0, limit);
  if (pageCandidates.length === 0) {
    return { rows: [], candidateCount: Number(count.candidateCount), eligibleCount: 0, hasNext: false };
  }
  const identities = pageCandidates.map((candidate) => candidate.identityKey);
  const edges = store.db.prepare(
    `${REVISION_ENDPOINT_CTE}
     SELECT publication.*
       FROM endpoint_publication publication
      WHERE publication.endpoint_identity IN (${identities.map(() => "?").join(",")})
      ORDER BY publication.endpoint_identity,publication.edge_type,publication.locator_identity`,
  ).all(scope.revision.snapshotId, ...identities) as Array<{
    endpoint_identity: string;
    locator_identity: string | null;
    edge_type: string;
    method: string;
    confidence: number;
    provenance: string;
    file_path: string | null;
  }>;
  const revisionView = openRevisionView(store, scope.revision);
  const locatorIdentityKeys = [...new Set(edges.flatMap((edge) => edge.locator_identity ? [edge.locator_identity] : []))];
  const locatorSources = new Map(
    revisionView.symbolVersions(locatorIdentityKeys).map((source) => [source.identityKey, source]),
  );
  const evidence = new Map<string, EndpointOccurrence[]>();
  for (const edge of edges) {
    const nodeId = store.findNodeIdByIdentity(edge.endpoint_identity);
    if (!nodeId) continue;
    const provenance = JSON.parse(edge.provenance || "{}") as Record<string, unknown>;
    const revisionEdge: RevisionEdgeRow = {
      id: "",
      srcIdentityKey: edge.edge_type === "invokes" ? edge.locator_identity ?? "" : edge.endpoint_identity,
      ...(edge.edge_type === "invokes"
        ? { dstIdentityKey: edge.endpoint_identity }
        : edge.locator_identity ? { dstIdentityKey: edge.locator_identity } : {}),
      edgeType: edge.edge_type,
      method: edge.method,
      confidence: edge.confidence,
      provenance,
      scope: "revision",
    };
    const occurrence = endpointOccurrenceForRevisionEdge(store, scope, revisionEdge, locatorSources);
    if (!occurrence) continue;
    const current = evidence.get(nodeId) ?? [];
    current.push(occurrence);
    evidence.set(nodeId, current);
  }
  const rows = pageCandidates.map((candidate) => ({
    ...candidate,
    occurrences: dedupeEndpointOccurrences(evidence.get(candidate.nodeId) ?? []),
  }));
  const candidateCount = Number(count.candidateCount ?? 0);
  return {
    rows,
    candidateCount,
    eligibleCount: Math.max(0, candidateCount - (after ? 1 : 0)),
    hasNext: candidates.length > pageCandidates.length,
  };
}

function endpointPublicationExclusions(
  store: KnowledgeStore,
  scope: EndpointInventoryScope,
  options: EndpointInventoryPageOptions,
): EndpointPublicationReceipt["excluded"] {
  if (!scope.repoId || !scope.revisionId) return [];
  const rows = store.db.prepare(
    `SELECT file_path AS filePath,start_line AS startLine,raw_target AS discoveryKey,
            reason_code AS reasonCode,reason
       FROM unresolved_reference_items
      WHERE repo_id=? AND revision_id=?
        AND reason_code IN ('ambiguous-grpc-handler','ambiguous-grpc-endpoint','ambiguous-grpc-declaration')
      ORDER BY file_path,start_line,id`,
  ).all(scope.repoId, scope.revisionId) as Array<{
    filePath: string; startLine: number; discoveryKey: string; reasonCode: string; reason: string;
  }>;
  return rows.flatMap((row) => {
    let candidateEndpointIds: string[] = [];
    try {
      const parsed = JSON.parse(row.reason) as { candidateEndpointIds?: unknown };
      if (Array.isArray(parsed.candidateEndpointIds)) candidateEndpointIds = parsed.candidateEndpointIds
        .filter((value): value is string => typeof value === "string")
        .sort();
    } catch { candidateEndpointIds = []; }
    const protocol: string | null = row.discoveryKey.startsWith("grpc::") ? "grpc" : null;
    const edgeType = row.reasonCode === "ambiguous-grpc-handler"
      ? "handles" as const
      : row.reasonCode === "ambiguous-grpc-declaration"
        ? "declares" as const
        : "invokes" as const;
    const provenanceKind = classifyEndpointProvenanceKind({ edgeType, filePath: row.filePath });
    const occurrence: EndpointOccurrence = {
      provenanceKind,
      repoId: scope.repoId!,
      commit: scope.revision?.commitSha ?? scope.revisionId!,
      snapshot: scope.revision?.snapshotId ?? scope.revisionId!,
      file: row.filePath,
      line: row.startLine,
    };
    if (!matchesEndpointFilter({
      identityKey: row.discoveryKey,
      protocol,
      occurrences: [occurrence],
    }, options)) return [];
    return [{
      discoveryKey: row.discoveryKey,
      reasonCode: row.reasonCode,
      candidateEndpointIds,
      provenance: { provenanceKind, filePath: row.filePath, ...(row.startLine > 0 ? { startLine: row.startLine } : {}) },
    }];
  });
}

function readEndpointInventoryPage(
  store: KnowledgeStore,
  options: EndpointInventoryPageOptions,
  limit: number,
): EndpointInventoryPage {
  if (options.handledOnly === true && options.provenanceKind && options.provenanceKind !== "handler") {
    throw new EndpointInventoryPageError(
      "INVALID_ARGUMENT",
      "handledOnly is exactly provenanceKind=handler and cannot be combined with another provenanceKind",
    );
  }
  const scope = options.scope ?? resolveEndpointInventoryScope(store, { repoId: options.repoId });
  // A branch may point at a database revision created by an older runtime even
  // when the database-wide schema has already migrated. Refuse before the
  // legacy endpoint-publication fallback scans the full resolved-edge graph;
  // every transport can then return the same typed remediation quickly.
  if (scope.branchId) assertRuntimeIndexCompatible(store, scope.branchId);
  const repoId = scope.repoId ?? options.repoId;
  const scopeKey = `${scope.repoId ?? "*"}|${scope.branchId ?? "*"}|${endpointFilterKey(options)}|${ENDPOINT_INVENTORY_ORDERING}`;
  const revision = scope.revisionId ?? (scope.repoId ? null : globalEndpointInventoryRevision(store));
  let after: { identityKey: string; nodeId: string } | null = null;
  if (options.cursor) {
    try {
      const decoded = ENDPOINT_INVENTORY_CURSOR_CODEC.decode(options.cursor, { operation: "endpoints", scope: scopeKey, revision, limit });
      const [identityKey, nodeId] = decoded.lastKey.split("\u0000");
      if (!identityKey || !nodeId) {
        throw new KnowledgeContractError("CURSOR_INVALID", "malformed cursor: invalid lastKey format", { cursor: options.cursor }, false);
      }
      after = { identityKey, nodeId };
    } catch (error) {
      if (error instanceof KnowledgeContractError) throw error;
      const code = String((error as Error).message ?? error);
      if (code === "CURSOR_REQUEST_MISMATCH") {
        throw new KnowledgeContractError("CURSOR_REQUEST_MISMATCH", "cursor was created with a different limit", { cursor: options.cursor, requestedLimit: limit }, false);
      }
      if (code === "CURSOR_OPERATION_MISMATCH" || code === "CURSOR_SCOPE_MISMATCH" || code === "CURSOR_STALE" || code === "CURSOR_EXPIRED") throw error;
      throw new KnowledgeContractError("CURSOR_INVALID", "malformed cursor", { cursor: options.cursor }, false);
    }
  }

  const revisionPage = revisionEndpointPageRows(store, scope, options, after, limit);
  if (revisionPage) {
    const pageRows = revisionPage.rows;
    const hasNext = revisionPage.hasNext;
    const items = hydrateEndpointInventoryRows(store, pageRows, scope);
    const nextCursor = hasNext && pageRows.length > 0
      ? ENDPOINT_INVENTORY_CURSOR_CODEC.encode({
          schemaVersion: "1", contractVersion: "2", operation: "endpoints", scope: scopeKey,
          orderingKey: ENDPOINT_INVENTORY_ORDERING,
          lastKey: `${pageRows.at(-1)!.identityKey}\u0000${pageRows.at(-1)!.nodeId}`,
          revision, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), limit,
        })
      : null;
    const excluded = endpointPublicationExclusions(store, scope, options);
    return {
      items,
      scope,
      candidateCount: revisionPage.candidateCount,
      remainingCount: Math.max(0, revisionPage.eligibleCount - items.length),
      totalIsExact: true,
      truncated: hasNext,
      nextCursor,
      publication: {
        discovered: revisionPage.candidateCount + excluded.length,
        persisted: revisionPage.candidateCount,
        queryable: revisionPage.candidateCount,
        excluded,
        totalIsExact: true,
      },
    };
  }

  const filter = endpointInventoryFilter(repoId, options);
  const countRow = (after
    ? store.db.prepare(
        `SELECT COUNT(*) AS candidateCount,
                COALESCE(SUM(CASE WHEN n.identity_key>? OR (n.identity_key=? AND n.id>?) THEN 1 ELSE 0 END),0) AS eligibleCount
           FROM nodes n
          WHERE ${filter.where.join(" AND ")}`,
      ).get(after.identityKey, after.identityKey, after.nodeId, ...filter.params)
    : store.db.prepare(
        `SELECT COUNT(*) AS candidateCount, COUNT(*) AS eligibleCount
           FROM nodes n
          WHERE ${filter.where.join(" AND ")}`,
      ).get(...filter.params)) as { candidateCount: number; eligibleCount: number };

  const pageWhere = [...filter.where];
  const pageParams: Array<string | number> = [...filter.params];
  if (after) {
    pageWhere.push("(n.identity_key>? OR (n.identity_key=? AND n.id>?))");
    pageParams.push(after.identityKey, after.identityKey, after.nodeId);
  }
  pageParams.push(limit + 1);
  const rows = store.db.prepare(
    `SELECT n.id AS nodeId, n.title, n.identity_key AS identityKey,
            json_extract(n.meta, '$.protocol') AS protocol
       FROM nodes n
      WHERE ${pageWhere.join(" AND ")}
      ORDER BY n.identity_key, n.id
      LIMIT ?`,
  ).all(...pageParams) as EndpointInventoryRow[];
  const pageRows = rows.slice(0, limit);
  const hasNext = rows.length > pageRows.length;
  const items = hydrateEndpointInventoryRows(store, pageRows, scope);
  const nextCursor = hasNext && pageRows.length > 0
    ? ENDPOINT_INVENTORY_CURSOR_CODEC.encode({
        schemaVersion: "1",
        contractVersion: "2",
        operation: "endpoints",
        scope: scopeKey,
        orderingKey: ENDPOINT_INVENTORY_ORDERING,
        lastKey: `${pageRows.at(-1)!.identityKey}\u0000${pageRows.at(-1)!.nodeId}`,
        revision,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        limit,
      })
    : null;
  const candidateCount = Number(countRow.candidateCount ?? 0);
  const eligibleCount = Number(countRow.eligibleCount ?? 0);
  return {
    items,
    scope,
    candidateCount,
    remainingCount: Math.max(0, eligibleCount - items.length),
    totalIsExact: true,
    truncated: hasNext,
    nextCursor,
    publication: {
      discovered: candidateCount,
      persisted: candidateCount,
      queryable: candidateCount,
      excluded: [],
      totalIsExact: true,
    },
  };
}

/**
 * Canonical ownership-only endpoint page. One SQLite read transaction covers
 * scope, counting, keyset selection, hydration and cursor construction.
 */
export function listEndpointInventoryPage(
  store: KnowledgeStore,
  options: EndpointInventoryPageOptions = {},
): EndpointInventoryPage {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new EndpointInventoryPageError("INVALID_ARGUMENT", "endpoint page limit must be an integer between 1 and 500");
  }
  if (options.provenanceKind && !(["definition", "client", "handler", "test"] as string[]).includes(options.provenanceKind)) {
    throw new EndpointInventoryPageError("INVALID_ARGUMENT", `unsupported endpoint provenanceKind: ${options.provenanceKind}`);
  }
  return store.db.transaction(() => readEndpointInventoryPage(store, options, limit))();
}

/** Compatibility full-list helper retained for existing core consumers. */
export function listEndpointInventory(
  store: KnowledgeStore,
  options: EndpointInventoryPageOptions = {},
): EndpointInventoryItem[] {
  const scope = options.scope ?? resolveEndpointInventoryScope(store, { repoId: options.repoId });
  const items: EndpointInventoryItem[] = [];
  let cursor: string | undefined;
  do {
    const page = listEndpointInventoryPage(store, { ...options, scope, limit: 500, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export interface PackSourceOptions {
  /** false returns relations only, with each drop named in sourcesOmitted. */
  includeSources?: boolean;
  /** Total line ceiling for the pack's source blocks (default 800). */
  maxSourceLines?: number;
}

export function buildContextPack(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; repoId?: string; revision?: RevisionContext; limit?: number; offset?: number } & PackSourceOptions,
): ContextPack {
  const limit = options?.limit ?? 25;
  const offset = Math.max(0, options?.offset ?? 0);
  const attach = (result: ContextPack): ContextPack => {
    const payloadCount = contextPayloadCount(result);
    return publicEvidenceFields(store, result, {
    repoId: options?.repoId,
    branchId: options?.branchId,
    revision: options?.revision,
    completeness: result.completeness.status,
    // Relations are lower-bound evidence even when callers/callees exist.
    // Presence must not be presented as proof while the pack is partial.
    proofStatus: "not_proven",
    candidateCount: result.candidateCount ?? payloadCount,
    returnedCount: result.returnedCount ?? payloadCount,
    truncated: result.truncated.length > 0,
    cursor: null,
    }) as unknown as ContextPack;
  };
  const empty: ContextPack = {
    target, trust: null, focus: null, callers: [], calls: [], renderedBy: [], renders: [],
    invokedDynamicallyBy: [], invokesDynamic: [], remoteCalls: [], invokedBy: [],
    referencedBy: [], usesTypes: [],
    routes: [], tests: [], errors: [], envs: [], notes: [], importers: [], signals: [],
    firstHopRelations: [], handles: [],
    externalCalls: [], completeness: { status: "unknown", externalCallCount: 0, note: "Nothing resolved for this target, so there is no calls list to describe." },
    truncated: [],
    ambiguous: null, assemblyError: null,
  };
  let resolution: SymbolResolution;
  try {
    resolution = resolveSymbolMatches(store, target, options);
  } catch (e) {
    return attach({ ...empty, assemblyError: (e as Error).message });
  }
  if (resolution.kind === "none") return attach(empty);
  if (resolution.kind === "ambiguous") return attach({ ...empty, ambiguous: resolution.candidates });
  const focusId = resolution.nodeId;
  assertResolvedNodeInScope(store, focusId, options);

  // The symbol DID resolve uniquely at this point — any throw from here on is
  // an internal assembly failure (corrupt/incomplete row, disk read fault,
  // etc.), NOT "not found". Surfacing it as assemblyError keeps it from being
  // silently indistinguishable from a genuine zero-match.
  try {
    return attach(buildContextPackBody(store, target, focusId, limit, offset, options));
  } catch (e) {
    return attach({ ...empty, assemblyError: (e as Error).message });
  }
}

function buildContextPackBody(
  store: KnowledgeStore,
  target: string,
  focusId: string,
  limit: number,
  offset: number,
  options: { branchId?: string; revision?: RevisionContext; limit?: number; offset?: number } | undefined,
): ContextPack {
  const detail = getNodeDetail(store, focusId, options);
  const active = "status='active'";
  // Branch-scope to the focus's live branch (or an explicit one) so a repo indexed
  // on multiple branches doesn't mix them. branch-less edges (git / global gRPC
  // endpoints) always pass so cross-repo links aren't dropped.
  const explicitBranchId = revisionBranchId(options);
  const branchId = explicitBranchId ?? liveBranchOf(store, focusId);
  const scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const snapshotRevision = options?.revision && !options.revision.snapshotId.startsWith("legacy:") ? options.revision : null;
  // Relation lists cut at `limit` used to be indistinguishable from complete
  // ones: a caller could not tell 25-of-25 from 25-of-500, so an agent reading
  // `calls` would reason as if it had seen everything. Every relation now
  // fetches limit+1 rows and names itself in `truncated` when the extra row
  // exists — the same contract `sourcesOmitted` already gives source blocks.
  // External-call facts for this focus symbol, grouped by the package they
  // came from. Falls back to an empty list on an index written before the
  // table existed, so an old DB degrades quietly instead of throwing.
  const externalCallRows = (() => {
    try {
      return store.db.prepare(
        `SELECT callee, receiver, specifier, line FROM external_calls
          WHERE src_node_id=? ORDER BY line`,
      ).all(focusId) as Array<{ callee: string; receiver: string | null; specifier: string; line: number }>;
    } catch {
      return [];
    }
  })();
  const externalCallCount = externalCallRows.length;
  const externalCallGroups: ExternalCallGroup[] = [...externalCallRows
    .reduce((groups, row) => {
      const entry = groups.get(row.specifier) ?? [];
      entry.push({ callee: row.callee, receiver: row.receiver, line: row.line });
      groups.set(row.specifier, entry);
      return groups;
    }, new Map<string, ExternalCallGroup["callees"]>())]
    .map(([specifier, callees]) => ({ specifier, callees }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier));

  const truncatedRelations = new Set<string>();
  // Read a stable small relation window up front. Without this floor, page 1
  // saw only `limit + 1` candidates while page 2 expanded every relation to
  // `offset + limit + 1`, making the advertised total drift across cursors.
  const relationScanLimit = Math.min(100_000, Math.max(100, offset + limit + 1));
  const capped = (relation: string, rows: { id: string }[]) => {
    if (rows.length > relationScanLimit) truncatedRelations.add(relation);
    return rows.slice(0, relationScanLimit);
  };
  const snapshotRelationNames = [
    "callers", "calls", "renderedBy", "renders", "invokedDynamicallyBy", "invokesDynamic",
    "remoteCalls", "referencedBy", "usesTypes", "tests", "errors", "envs", "routes",
  ];
  const snapshotRelationScanLimit = 10_001;
  // A revision Context Pack used to run the same snapshot-wide resolved-edge
  // query once per relation type. On a multi-thousand-file snapshot that made
  // one context lookup perform fourteen equivalent scans and occasionally
  // cross the CLI's 10s hard timeout. Read all direct relation types once,
  // then preserve each relation's independent limit+1 truncation in memory.
  const snapshotRelationPairs = snapshotRevision
    ? snapshotEdgePairsForNodes(store, snapshotRevision, [focusId], {
        edgeTypes: ["calls", "renders", "invokes_dynamic", "invokes", "references", "tests", "throws", "uses", "handles"],
        direction: "both",
        limit: snapshotRelationScanLimit,
      })
    : [];
  if (snapshotRelationPairs.length >= snapshotRelationScanLimit) {
    for (const relation of snapshotRelationNames) truncatedRelations.add(relation);
  }
  const snapshotIds = (type: string, direction: "in" | "out") => snapshotRelationPairs
    .filter((edge) => edge.edgeType === type && (direction === "in" ? edge.dst === focusId : edge.src === focusId))
    .map((edge) => direction === "in" ? edge.src : edge.dst)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, relationScanLimit + 1);
  const inEdges = (relation: string, type: string) => capped(
    relation,
    snapshotRevision ? snapshotIds(type, "in") : store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type=? AND ${active}${bx} ORDER BY src LIMIT ? OFFSET ?`)
      .all(...(branchId ? [focusId, type, branchId, relationScanLimit + 1, 0] : [focusId, type, relationScanLimit + 1, 0])) as { id: string }[],
  );
  const outEdges = (relation: string, type: string) => capped(
    relation,
    snapshotRevision ? snapshotIds(type, "out") : store.db.prepare(`SELECT DISTINCT dst AS id FROM edges WHERE src=? AND edge_type=? AND dst IS NOT NULL AND ${active}${bx} ORDER BY dst LIMIT ? OFFSET ?`)
      .all(...(branchId ? [focusId, type, branchId, relationScanLimit + 1, 0] : [focusId, type, relationScanLimit + 1, 0])) as { id: string }[],
  );

  const callers = inEdges("callers", "calls");
  const calls = outEdges("calls", "calls");
  const renderedBy = inEdges("renderedBy", "renders");
  const renders = outEdges("renders", "renders");
  const invokedDynamicallyBy = inEdges("invokedDynamicallyBy", "invokes_dynamic");
  const invokesDynamic = outEdges("invokesDynamic", "invokes_dynamic");
  // Cross-service: gRPC endpoints this focus invokes (branch-less edges pass bx).
  const remoteCalls = outEdges("remoteCalls", "invokes");
  // Cross-service reverse: symbols in OTHER services that invoke an endpoint this
  // focus handles (focus ← handles ← endpoint ← invokes ← caller). Endpoints are
  // global + edges branch-less, so no branch scoping here.
  const handledEndpoints = store.db
    .prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type='handles' AND ${active}`)
    .all(focusId) as { id: string }[];
  const invokedBy = handledEndpoints.length
    ? capped("invokedBy", store.db
        .prepare(
          `SELECT DISTINCT src AS id FROM edges
           WHERE edge_type='invokes' AND ${active} AND src != ?
           AND dst IN (${handledEndpoints.map(() => "?").join(",")}) LIMIT ?`,
        )
        .all(focusId, ...handledEndpoints.map((e) => e.id), relationScanLimit + 1) as { id: string }[])
    : [];
  const referencedBy = inEdges("referencedBy", "references");
  const usesTypes = outEdges("usesTypes", "references");
  const focusFilePath = detail?.versions.find((version) => version.status === "fresh")?.filePath
    ?? detail?.versions[0]?.filePath
    ?? null;
  const fileSymbolIds = focusFilePath
    ? (store.db.prepare(
        `SELECT DISTINCT node_id AS id FROM symbol_versions
          WHERE file_path=? AND status='fresh'${branchId ? " AND branch_id=?" : ""}
          ORDER BY node_id`,
      ).all(...(branchId ? [focusFilePath, branchId] : [focusFilePath])) as Array<{ id: string }>).map((row) => row.id)
    : [];
  const tests = fileSymbolIds.length > 0
    ? capped("tests", snapshotRevision
        ? snapshotEdgePairsForNodes(store, snapshotRevision, fileSymbolIds, {
            edgeTypes: ["tests"], direction: "in", limit: relationScanLimit + 1,
          })
          .map((edge) => ({ id: edge.src }))
          .filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index)
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, relationScanLimit + 1)
        : store.db.prepare(
            `SELECT DISTINCT src AS id FROM edges
              WHERE dst IN (${fileSymbolIds.map(() => "?").join(",")})
                AND edge_type='tests' AND ${active}${bx}
              ORDER BY src LIMIT ? OFFSET ?`,
          ).all(...fileSymbolIds, ...(branchId ? [branchId] : []), relationScanLimit + 1, 0) as Array<{ id: string }>)
    : inEdges("tests", "tests");
  const errors = outEdges("errors", "throws").map((r) => nodeBrief(store, r.id).title);
  const envs = outEdges("envs", "uses").map((r) => nodeBrief(store, r.id).title);

  // routes: directly handled, or handled by a caller (route → handler → focus).
  const directRoutes = inEdges("routes", "handles");
  const callerIds = callers.map((c) => c.id);
  const routeSet = new Map<string, "direct" | "caller">();
  for (const r of directRoutes) routeSet.set(nodeBrief(store, r.id).title, "direct");
  if (callerIds.length) {
    const ph = callerIds.map(() => "?").join(",");
    const viaCaller = store.db
      .prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='handles' AND ${active} AND dst IN (${ph}) LIMIT ?`)
      .all(...callerIds, relationScanLimit) as { id: string }[];
    for (const r of viaCaller) {
      const t = nodeBrief(store, r.id).title;
      if (!routeSet.has(t)) routeSet.set(t, "caller");
    }
  }
  const routes = [...routeSet].map(([route, via]) => ({ route, via }));

  // notes linked to the focus (any incoming edge whose source is a note node).
  const notes = store.db.prepare(
      `SELECT DISTINCT e.src AS id FROM edges e JOIN nodes n ON n.id=e.src
       WHERE e.dst=? AND ${active} AND n.node_type='note' ORDER BY e.src LIMIT ?`,
    ).all(focusId, relationScanLimit) as { id: string }[];

  // importers: files importing the focus's file (focus ← defines ← file → imports).
  const fileRow = store.db
    .prepare(`SELECT src AS id FROM edges WHERE dst=? AND edge_type='defines' AND ${active} LIMIT 1`)
    .get(focusId) as { id: string } | undefined;
  const importers = fileRow
    ? store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE dst=? AND edge_type='imports' AND ${active} ORDER BY src LIMIT ?`).all(fileRow.id, relationScanLimit) as { id: string }[]
    : [];
  const focusSource = sourceContextForNode(store, focusId, options);
  const relationBriefs = (rows: Array<{ id: string }>) => briefsFrom(store, rows, options, focusSource);
  const endpointRelations = detail?.node.nodeType === "endpoint"
    ? readEndpointRelations(store, focusId, options)?.relations ?? []
    : [];

  // risk/attention signals — cheap heuristics from the graph itself.
  const signals: string[] = [];
  const stale = (detail?.versions ?? []).filter((v) => v.status !== "fresh");
  if (stale.length) signals.push(`⚠ ${stale.length} stale version(s) — re-index before trusting`);
  const fanIn = (store.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE dst=? AND edge_type='calls' AND ${active}`).get(focusId) as { n: number }).n;
  if (fanIn >= 10) signals.push(`high fan-in: ${fanIn} callers — changes ripple widely`);
  const inferred = (store.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE (src=? OR dst=?) AND method='INFERRED' AND ${active}`).get(focusId, focusId) as { n: number }).n;
  if (inferred) signals.push(`${inferred} INFERRED edge(s) — some relations are best-guess, verify`);
  if (routes.length) signals.push(`reachable from ${routes.length} HTTP route(s) — public-facing`);
  if (remoteCalls.length) signals.push(`calls ${remoteCalls.length} remote gRPC endpoint(s) — cross-service dependency`);
  if (invokedBy.length) signals.push(`invoked by ${invokedBy.length} caller(s) in other services — cross-service contract`);

  return paginateContextPackRelations({
    target,
    trust: trustEnvelopeForBranch(store, branchId),
    focus: detail
      ? {
          nodeId: detail.node.id,
          title: detail.node.title,
          nodeType: detail.node.nodeType,
          kind: detail.versions[0]?.kind ?? null,
          filePath: detail.versions[0]?.filePath ?? null,
          signature: (detail.versions.find((v) => v.status === "fresh") ?? detail.versions[0])?.signature ?? null,
          source: detail.source?.code ?? detail.body ?? null,
          branches: detail.versions.map((v) => ({ branch: v.branchId, status: v.status })),
        }
      : null,
    callers: relationBriefs(callers),
    calls: relationBriefs(calls),
    renderedBy: relationBriefs(renderedBy),
    renders: relationBriefs(renders),
    invokedDynamicallyBy: relationBriefs(invokedDynamicallyBy),
    invokesDynamic: relationBriefs(invokesDynamic),
    remoteCalls: relationBriefs(remoteCalls),
    invokedBy: relationBriefs(invokedBy),
    referencedBy: relationBriefs(referencedBy),
    usesTypes: relationBriefs(usesTypes),
    routes,
    tests: relationBriefs(tests),
    errors,
    envs,
    notes: relationBriefs(notes),
    importers: relationBriefs(importers),
    firstHopRelations: endpointRelations,
    handles: endpointRelations.filter((relation) => relation.edgeType === "handles"),
    signals,
    externalCalls: externalCallGroups,
    completeness: {
      // "complete" was never true and was actively harmful: a symbol that is
      // not indexed at all came back as complete with confidence high, and a
      // function whose five calls the resolver does not model came back the
      // same way. An agent reading that concludes "this calls nothing".
      status: externalCallCount > 0 ? "partial" : "lower_bound",
      externalCallCount,
      note: externalCallCount > 0
        ? `${externalCallCount} call(s) go to external packages and have no in-repo target — see externalCalls. Beyond those, the calls list is a lower bound: constructor calls, interface dispatch, static-method calls and calls inside callback bodies are not modelled.`
        : "The calls list is a lower bound: constructor calls, interface dispatch, static-method calls and calls inside callback bodies are not modelled, so a short list may mean few calls or few visible calls.",
    },
    truncated: [...truncatedRelations].sort(),
    ambiguous: null,
    assemblyError: null,
    ...(scopeFallback ? { scopeFallback } : {}),
  }, offset, limit);
}

// Render a Context Pack as Markdown — what an AI coding agent reads before editing.
export function renderContextPackMarkdown(pack: ContextPack): string {
  const L: string[] = [];
  const list = (title: string, items: ContextBrief[]) => {
    if (!items.length) return;
    L.push(`### ${title}`);
    for (const i of items) L.push(`- \`${i.title}\`${i.nodeType !== "symbol" ? ` (${i.nodeType})` : ""}`);
    L.push("");
  };
  if (!pack.focus) {
    if (pack.ambiguous) {
      return `# Context Pack: ${pack.target}\n\n${renderAmbiguousSymbols(pack.target, pack.ambiguous)}\n`;
    }
    if (pack.assemblyError) {
      return `# Context Pack: ${pack.target}\n\n_"${pack.target}" resolved to a symbol, but building its context failed: ${pack.assemblyError}_\n`;
    }
    return `# Context Pack: ${pack.target}\n\n_No matching symbol/note found for "${pack.target}". Not indexed, or the name doesn't match any symbol/note title or qualified name._\n`;
  }
  const f = pack.focus;
  L.push(`# Context Pack: ${f.title}`);
  L.push("");
  L.push(`- **type**: ${f.kind ?? f.nodeType}`);
  if (f.filePath) L.push(`- **file**: \`${f.filePath}\``);
  if (f.branches.length) L.push(`- **branches**: ${f.branches.map((b) => `${b.branch} (${b.status})`).join(", ")}`);
  L.push("");
  if (pack.signals.length) {
    L.push(`## ⚠ Signals`);
    for (const s of pack.signals) L.push(`- ${s}`);
    L.push("");
  }
  if (f.signature) {
    L.push(`## Signature`);
    L.push("```", f.signature, "```", "");
  }
  if (f.source) {
    L.push(`## Source`);
    L.push("```", f.source, "```", "");
  }
  if (pack.routes.length) {
    L.push(`## HTTP routes reaching this`);
    for (const r of pack.routes) L.push(`- ${r.route}${r.via === "caller" ? " (via caller)" : ""}`);
    L.push("");
  }
  list("Called by", pack.callers);
  list("Calls", pack.calls);
  // Right after "Calls", because that is the list these facts qualify — a
  // reader who has just counted 10 callees needs to learn here, not in a
  // footer, that two more went into an SDK.
  if (pack.externalCalls.length) {
    L.push(`## Calls into external packages (not resolvable to repo symbols)`);
    for (const g of pack.externalCalls) {
      const callees = g.callees
        .map((c) => `\`${c.receiver ? `${c.receiver}.` : ""}${c.callee}\` (line ${c.line})`)
        .join(", ");
      L.push(`- **${g.specifier}**: ${callees}`);
    }
    L.push("");
    L.push(`_The "Calls" list above is incomplete: ${pack.completeness.externalCallCount} call(s) leave this repo._`);
    L.push("");
  }
  list("Calls remote services (gRPC)", pack.remoteCalls);
  list("Invoked by other services (gRPC)", pack.invokedBy);
  list("Used as a type by", pack.referencedBy);
  list("Uses types", pack.usesTypes);
  list("Tested by", pack.tests);
  list("Linked notes", pack.notes);
  list("Imported by (files)", pack.importers);
  if (pack.errors.length) {
    L.push(`### Throws`);
    for (const e of pack.errors) L.push(`- ${e}`);
    L.push("");
  }
  if (pack.envs.length) {
    L.push(`### Env vars used`);
    for (const e of pack.envs) L.push(`- ${e}`);
    L.push("");
  }
  if (pack.truncated.length) {
    L.push(`### ⚠ Lists cut off by the result limit`);
    L.push(`Raise \`limit\` to see the rest of: ${pack.truncated.join(", ")}.`);
    L.push("");
  }
  return L.join("\n");
}

// —— Flow Explorer (§ vision #3): a linear execution chain, not a graph blob ——
// From an endpoint or symbol, walk DOWNSTREAM edges (handles→calls→invokes→
// reads/writes→throws/uses) branch-scoped, producing an ordered, indented flow:
//   POST /withdraw → WithdrawController.create → WithdrawService.createWithdraw
//     → WalletService.freeze → [players] (reads) → RpcException (throws)
// This is what a developer/AI actually wants to see, not a cloud of dots.

export interface FlowStep {
  depth: number;
  nodeId: string;
  title: string;
  nodeType: string;
  via: string; // edge type from its parent ("root" for the entry)
  /** The node this step actually hangs off. Absent on the root.
   *
   * Without it a renderer can only indent by depth, which hangs every depth-N+1
   * step off whichever depth-N line was printed last — and that printed a
   * TypeScript interface as the caller of thirteen functions. The traversal knew
   * the parent all along and dropped it. */
  parentNodeId?: string;
  source?: SourceReference;
  /** This edge crosses repository ownership; both step sources remain intact. */
  boundary?: boolean;
  evidenceState?: EvidenceProofStatus;
  edgeEvidence?: EndpointRelation["edgeEvidence"];
  /** Canonical evidence for the edge that produced this hop. */
  graphEvidence?: GraphEdgeEvidenceEnvelope;
}
export type FlowDiagnosticReason =
  | "not_indexed" // no gRPC endpoint or symbol/note matches the target at all
  | "ambiguous" // 2+ candidates (gRPC services sharing a method, or same-named symbols)
  | "endpoint_no_handler" // target resolved to a gRPC endpoint with no `handles` edge yet
  | "no_outgoing_edges"; // target resolved uniquely but is a dead end (leaf, or callees unindexed)
export interface FlowDiagnostic {
  reason: FlowDiagnosticReason;
  message: string;
  suggestions?: string[]; // "did you mean" — e.g. `penguin flow <nodeId>` for each candidate
}
export interface FlowResult {
  target: string;
  trust: TrustEnvelope | null;
  root: FlowStep | null;
  steps: FlowStep[];
  // Aggregated across every node in `steps`, so callers do not need one
  // context query per hop to discover regression tests and operational notes.
  relatedTests: ContextBrief[];
  linkedKnowledge: ContextBrief[];
  /** Execution-only projection; root is retained as the flow entry. */
  executionSteps?: FlowStep[];
  /** Type/reference projection kept separate from executable traversal hops. */
  referenceSteps?: FlowStep[];
  diagnostic?: FlowDiagnostic;
  ambiguous?: SymbolCandidate[]; // populated only when diagnostic.reason === "ambiguous"
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // query silently answered against the repo's live branch instead — an AI
  // consumer should know it got an implicit "whatever's live" answer, not a
  // revision it asked for (§ Phase 1 trust plumbing).
  scopeFallback?: { branchId: string };
  evidence?: EvidenceEnvelope;
  scope?: Record<string, unknown> | null;
  revision?: RevisionContext | null;
  freshness?: EvidenceEnvelope["freshness"];
  coverage?: EvidenceEnvelope["coverage"];
  completeness?: EvidenceCompleteness;
  proofStatus?: EvidenceProofStatus;
  candidateCount?: number;
  returnedCount?: number;
  totalIsExact?: boolean;
  truncated?: boolean;
  cursor?: string | null;
}

function emptyFlowEnrichment(): Pick<FlowResult, "relatedTests" | "linkedKnowledge"> {
  return { relatedTests: [], linkedKnowledge: [] };
}

function flowEnrichment(
  store: KnowledgeStore,
  stepNodeIds: string[],
  options: {
    branchId?: string;
    limit: number;
    snapshotPairs?: Array<{ src: string; dst: string | null; edgeType: string }>;
    snapshotRevision?: RevisionContext;
  },
): Pick<FlowResult, "relatedTests" | "linkedKnowledge"> {
  const nodeIds = [...new Set(stepNodeIds)];
  if (nodeIds.length === 0) return emptyFlowEnrichment();
  const nodeSet = new Set(nodeIds);

  let testIds: string[];
  if (options.snapshotRevision) {
    testIds = snapshotEdgePairsForNodes(store, options.snapshotRevision, nodeIds, {
      edgeTypes: ["tests"],
      direction: "in",
      limit: options.limit,
    })
      .filter((edge) => edge.dst != null && nodeSet.has(edge.dst))
      .map((edge) => edge.src);
  } else if (options.snapshotPairs) {
    testIds = options.snapshotPairs
      .filter((edge) => edge.edgeType === "tests" && edge.dst != null && nodeSet.has(edge.dst))
      .map((edge) => edge.src);
  } else {
    const placeholders = nodeIds.map(() => "?").join(",");
    const branchClause = options.branchId ? "AND (e.branch_id=? OR e.branch_id IS NULL)" : "";
    const params = options.branchId
      ? [...nodeIds, options.branchId, options.limit]
      : [...nodeIds, options.limit];
    testIds = (store.db.prepare(
      `SELECT DISTINCT e.src AS id
         FROM edges e JOIN nodes n ON n.id=e.src
        WHERE e.status='active' AND e.edge_type='tests'
          AND e.dst IN (${placeholders}) ${branchClause}
        ORDER BY n.title LIMIT ?`,
    ).all(...params) as Array<{ id: string }>).map((row) => row.id);
  }

  // Markdown knowledge edges are branch-independent and point from a note to
  // the code/entity they mention. Querying them separately also keeps an
  // immutable code snapshot from silently hiding still-relevant runbooks.
  const placeholders = nodeIds.map(() => "?").join(",");
  const knowledgeIds = (store.db.prepare(
    `SELECT DISTINCT e.src AS id
       FROM edges e JOIN nodes n ON n.id=e.src
      WHERE e.status='active' AND n.node_type='note'
        AND e.dst IN (${placeholders})
      ORDER BY n.title LIMIT ?`,
  ).all(...nodeIds, options.limit) as Array<{ id: string }>).map((row) => row.id);

  const uniqueBriefs = (ids: string[]) => briefsFrom(
    store,
    [...new Set(ids)].slice(0, options.limit).map((id) => ({ id })),
  );
  return { relatedTests: uniqueBriefs(testIds), linkedKnowledge: uniqueBriefs(knowledgeIds) };
}

const DOWNSTREAM = ["calls", "renders", "invokes_dynamic", "invokes", "references", "reads", "writes", "throws", "uses", "handles", ...FRAMEWORK_EDGE_TYPES];
const FLOW_INGRESS = ["handles", "calls", "renders", "invokes_dynamic", "invokes", ...FRAMEWORK_EDGE_TYPES];

type FlowTraversalEdge = { id: string; via: string; graphEvidence?: GraphEdgeEvidenceEnvelope };
type FlowDownstreamEdge = FlowTraversalEdge & { src: string };

function flowIngressPath(
  store: KnowledgeStore,
  focus: string,
  incomingEdges: (id: string) => FlowTraversalEdge[],
  depthCap: number,
  limit: number,
): FlowTraversalEdge[] {
  const focusOnly = [{ id: focus, via: "root" }];
  if (store.getNode(focus)?.node_type === "endpoint") return focusOnly;

  type ReverseEdge = { parent: string; child: string; via: string; graphEvidence?: GraphEdgeEvidenceEnvelope };
  const queue: Array<{ id: string; reverseEdges: ReverseEdge[] }> = [
    { id: focus, reverseEdges: [] },
  ];
  const seen = new Set<string>([focus]);

  while (queue.length > 0 && seen.size <= limit) {
    const current = queue.shift()!;
    if (current.reverseEdges.length >= depthCap) continue;
    const parents = incomingEdges(current.id)
      .filter((edge) => !seen.has(edge.id))
      .sort((a, b) => {
        const aKey = store.getNode(a.id)?.identity_key ?? a.id;
        const bKey = store.getNode(b.id)?.identity_key ?? b.id;
        return a.via.localeCompare(b.via) || aKey.localeCompare(bKey);
      });
    for (const parent of parents) {
      if (seen.size >= limit) break;
      seen.add(parent.id);
      const reverseEdges = [
        ...current.reverseEdges,
        { parent: parent.id, child: current.id, via: parent.via, graphEvidence: parent.graphEvidence },
      ];
      if (store.getNode(parent.id)?.node_type === "endpoint") {
        return [
          { id: parent.id, via: "root" },
          ...reverseEdges.reverse().map((edge) => ({ id: edge.child, via: edge.via, graphEvidence: edge.graphEvidence })),
        ];
      }
      queue.push({ id: parent.id, reverseEdges });
    }
  }
  return focusOnly;
}

function appendFlowDownstream(
  store: KnowledgeStore,
  focus: string,
  focusDepth: number,
  steps: FlowStep[],
  seen: Set<string>,
  outEdges: (ids: string[]) => FlowDownstreamEdge[],
  depthCap: number,
  limit: number,
  scope?: TargetScopeOptions,
  initialFrontier?: Array<{ id: string; depth: number }>,
): void {
  // Breadth-first expansion preserves every shallow/direct relationship before
  // spending the response budget on one large descendant subtree. The old DFS
  // could exhaust a 60-step limit inside the first callee and silently omit a
  // sibling call that Context had already confirmed. `seen` is checked before
  // append so converging branches also do not duplicate steps.
  let frontier: Array<{ id: string; depth: number }> = initialFrontier ?? [{ id: focus, depth: focusDepth }];
  while (frontier.length > 0 && steps.length < limit) {
    const expandable = frontier.filter((item) => item.depth < depthCap);
    if (expandable.length === 0) break;
    const grouped = new Map<string, FlowDownstreamEdge[]>();
    for (const edge of outEdges(expandable.map((item) => item.id))) {
      grouped.set(edge.src, [...(grouped.get(edge.src) ?? []), edge]);
    }

    // Round-robin within one depth: a high-fanout node cannot consume the
    // remaining response budget before its same-depth siblings contribute.
    const next: Array<{ id: string; depth: number }> = [];
    const maxEdges = Math.max(0, ...expandable.map((item) => grouped.get(item.id)?.length ?? 0));
    for (let edgeIndex = 0; edgeIndex < maxEdges && steps.length < limit; edgeIndex += 1) {
      for (const current of expandable) {
        if (steps.length >= limit) break;
        const edge = grouped.get(current.id)?.[edgeIndex];
        if (!edge || seen.has(edge.id) || !store.getNode(edge.id)) continue;
        seen.add(edge.id);
        const depth = current.depth + 1;
        steps.push({ depth, parentNodeId: current.id, ...nodeBriefStep(store, edge.id, scope), via: edge.via, graphEvidence: edge.graphEvidence });
        if (depth < depthCap) next.push({ id: edge.id, depth });
      }
    }
    frontier = next;
  }
}

// gRPC route-string resolution for `flow`/`context` targets. NestJS
// `@GrpcMethod('Service','Method')` handlers are indexed as a single GLOBAL
// endpoint node keyed `grpc::<service>.<method-lowercased>` (see
// grpcEndpointKey in knowledge-indexer); callers refer to that endpoint by any
// of several conventional shapes, so a route string must be normalized to
// that key before a plain node/identity lookup has a chance of finding it.
export type GrpcResolution =
  | { kind: "unique"; nodeId: string }
  | { kind: "ambiguous"; candidates: SymbolCandidate[] }
  | { kind: "not_grpc" } // doesn't look like any gRPC route shape — try plain symbol resolution
  | { kind: "not_found"; attemptedKey: string }; // looked like a route, but no such endpoint is indexed

export function resolveGrpcEndpoint(store: KnowledgeStore, input: string): GrpcResolution {
  // `endpoints` renders the human-facing title as `gRPC Service.Method`,
  // while the resolver historically accepted only `Service.Method` or the
  // canonical `grpc::Service.method` identity. Accept the rendered title so
  // endpoint inventory can feed directly into flow without a normalization
  // detour.
  const rawInput = input.trim();
  const selector = normalizeNodeSelector(rawInput);
  if (selector !== rawInput) {
    const node = store.getNode(selector);
    return node?.node_type === "endpoint"
      ? { kind: "unique", nodeId: selector }
      : { kind: "not_grpc" };
  }
  const raw = rawInput.replace(/^gRPC\s+/i, "");
  const lookup = (service: string, method: string): GrpcResolution => {
    if (!service || !method) return { kind: "not_grpc" };
    const key = `grpc::${service}.${method.toLowerCase()}`;
    const exact = store.findNodeIdByIdentity(key);
    if (exact) return { kind: "unique", nodeId: exact };
    // Older indexes and generated-proto metadata occasionally preserve the
    // method's original casing or a package-qualified service. Endpoint
    // identity is case-insensitive at the route boundary; do the final match
    // against endpoint rows instead of turning a valid route into a silent
    // flow/context miss.
    const rows = store.db.prepare(
      `SELECT id, identity_key AS identityKey, title
         FROM nodes
        WHERE node_type='endpoint'
          AND (LOWER(identity_key)=LOWER(?) OR LOWER(title)=LOWER(?)
               OR LOWER(identity_key) LIKE LOWER(?))
        ORDER BY id`,
    ).all(key, `${service}.${method}`, `%${method.toLowerCase()}`) as Array<{ id: string; identityKey: string; title: string }>;
    const matches = rows.filter((row) => {
      const identity = row.identityKey.startsWith("grpc::") ? row.identityKey.slice("grpc::".length) : row.identityKey;
      const split = identity.lastIndexOf(".");
      if (split < 1) return false;
      const indexedService = identity.slice(0, split);
      const indexedMethod = identity.slice(split + 1);
      return indexedMethod.toLowerCase() === method.toLowerCase()
        && (indexedService.toLowerCase() === service.toLowerCase()
          || indexedService.toLowerCase().endsWith(`.${service.toLowerCase()}`));
    });
    if (matches.length === 1) return { kind: "unique", nodeId: matches[0].id };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((row) => symbolCandidateOf(store, row.id)) };
    return { kind: "not_found", attemptedKey: key };
  };

  // 1. literal identity key: grpc::Service.method
  if (raw.startsWith("grpc::")) {
    const body = raw.slice("grpc::".length);
    const split = body.lastIndexOf(".");
    if (split > 0) return lookup(body.slice(0, split), body.slice(split + 1));
    const id = store.findNodeIdByIdentity(raw);
    return id ? { kind: "unique", nodeId: id } : { kind: "not_found", attemptedKey: raw };
  }

  // 2. slash-form route strings: /pkg.Service/Method or /pkg/pkg.Service/Method.
  // The service segment is always the second-to-last path component (whatever
  // package-path prefix precedes it), and the service name itself is the
  // substring after the LAST '.' in that segment (proto package qualifiers
  // are dot-separated, e.g. "pkg.sub.Service").
  if (raw.includes("/")) {
    const parts = raw.split("/").filter(Boolean);
    if (parts.length < 2) return { kind: "not_grpc" };
    const method = parts[parts.length - 1];
    const serviceSeg = parts[parts.length - 2];
    const service = serviceSeg.includes(".") ? serviceSeg.slice(serviceSeg.lastIndexOf(".") + 1) : serviceSeg;
    return lookup(service, method);
  }

  // 3. dot-form: Service.Method (also matches a qualified symbol name like
  // "Ctrl.create" — if no gRPC endpoint exists for it, the caller falls
  // through to plain symbol resolution, where the exact-title fallback tier
  // still finds it).
  if (raw.includes(".")) {
    const idx = raw.lastIndexOf(".");
    return lookup(raw.slice(0, idx), raw.slice(idx + 1));
  }

  // 4. bare method name — ambiguous whenever 2+ distinct services expose a
  // method with this (lowercased) name; this is the exact shape of the
  // originally reported bug (FrontendPlayerService vs PlayerService both
  // expose getPlayerProfileByJwt).
  const services = store.findEndpointServicesByMethod(raw.toLowerCase());
  if (services.length === 0) return { kind: "not_grpc" };
  if (services.length === 1) return lookup(services[0], raw);
  const candidates = services
    .map((svc) => store.findNodeIdByIdentity(`grpc::${svc}.${raw.toLowerCase()}`))
    .filter((id): id is string => id != null)
    .map((id) => symbolCandidateOf(store, id));
  return { kind: "ambiguous", candidates };
}

function endpointFlowSeed(
  store: KnowledgeStore,
  focus: string,
  options: TargetScopeOptions | undefined,
  limit: number,
): { steps: FlowStep[]; seen: Set<string>; frontier: Array<{ id: string; depth: number }> } | null {
  const view = readEndpointRelations(store, focus, options);
  if (!view) return null;
  const root: FlowStep = { depth: 0, ...nodeBriefStep(store, focus, options), via: "root" };
  const direct = view.relations.slice(0, Math.max(0, limit - 1));
  const steps: FlowStep[] = [root, ...direct.map((relation): FlowStep => ({
    depth: 1,
    parentNodeId: focus,
    nodeId: relation.nodeId,
    title: relation.title,
    nodeType: relation.nodeType,
    via: relation.edgeType,
    ...(relation.source ? { source: relation.source } : {}),
    ...(relation.boundary ? { boundary: true } : {}),
    evidenceState: relation.evidenceState,
    edgeEvidence: relation.edgeEvidence,
    graphEvidence: relation.graphEvidence,
  }))];
  return {
    steps,
    seen: new Set(steps.map((step) => step.nodeId)),
    frontier: direct.map((relation) => ({ id: relation.nodeId, depth: 1 })),
  };
}

export function buildFlow(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; repoId?: string; revision?: RevisionContext; depth?: number; limit?: number; offset?: number },
): FlowResult {
  // The public knowledge.flow contract defaults to 20 hops on every surface.
  // Keep that default here so callers that omit an explicit limit (notably the
  // CLI) cannot silently return a different graph than MCP/query-server.
  const requestedLimit = Math.max(1, Math.min(100, options?.limit ?? 20));
  const pageOffset = Math.max(0, Math.trunc(options?.offset ?? 0));
  // Discover one row beyond the requested page so `truncated` means that a
  // continuation can actually return another identity. The public page limit
  // remains unchanged; this is only the bounded traversal budget.
  const discoveryLimit = Math.min(10_000, pageOffset + requestedLimit + 1);
  const attach = (result: FlowResult): FlowResult => {
    const candidateSteps = result.steps;
    const boundedSteps = candidateSteps.slice(pageOffset, pageOffset + requestedLimit);
    const truncated = candidateSteps.length > pageOffset + boundedSteps.length;
    const steps = boundedSteps.map((step, index) => index === 0
      ? (pageOffset === 0 ? step : { ...step, graphEvidence: step.graphEvidence ?? unresolvedGraphEdgeEvidence("flow_edge_record_missing") })
      : { ...step, graphEvidence: step.graphEvidence ?? unresolvedGraphEdgeEvidence("flow_edge_record_missing") });
    return publicEvidenceFields(store, {
      ...result,
      root: result.root,
      steps,
      executionSteps: steps.filter((step) => step.via === "root" || isExecutionEdge(step.via)),
      referenceSteps: steps.filter((step) => isReferenceEdge(step.via)),
      totalIsExact: !truncated,
    }, {
      repoId: options?.repoId,
      branchId: options?.branchId,
      revision: options?.revision,
      completeness: result.root ? "partial" : "unknown",
      // Flow is assembled from statically resolved steps and is never a proof
      // that all runtime paths were discovered.
      proofStatus: "not_proven",
      candidateCount: candidateSteps.length,
      returnedCount: steps.length,
      truncated,
      cursor: null,
    }) as unknown as FlowResult;
  };
  const grpc = resolveGrpcEndpoint(store, target);
  let focus: string | null = null;
  let attemptedKey: string | null = null;
  if (grpc.kind === "unique") {
    focus = grpc.nodeId;
  } else if (grpc.kind === "ambiguous") {
    return attach({
      target, trust: null, root: null, steps: [], ...emptyFlowEnrichment(), ambiguous: grpc.candidates,
      diagnostic: {
        reason: "ambiguous",
        message: `"${target}" matches ${grpc.candidates.length} gRPC endpoints across different services — specify one.`,
        suggestions: grpc.candidates.map((c) => `penguin flow symbol:${c.nodeId}`),
      },
    });
  } else {
    if (grpc.kind === "not_found") attemptedKey = grpc.attemptedKey;
    const scoped = resolveSymbolMatches(store, target, options);
    const sym = scoped.kind === "none" && options?.repoId
      ? resolveSymbolMatches(store, target)
      : scoped;
    if (sym.kind === "unique") {
      focus = sym.nodeId;
    } else if (sym.kind === "ambiguous") {
      return attach({
        target, trust: null, root: null, steps: [], ...emptyFlowEnrichment(), ambiguous: sym.candidates,
        diagnostic: {
          reason: "ambiguous",
          message: `"${target}" matches ${sym.candidates.length} symbols — specify one.`,
          suggestions: sym.candidates.map((c) => `penguin flow symbol:${c.nodeId}`),
        },
      });
    }
  }
  if (!focus) {
    return attach({
      target, trust: null, root: null, steps: [], ...emptyFlowEnrichment(),
      diagnostic: {
        reason: "not_indexed",
        message: attemptedKey
          ? `No symbol found for "${target}", and no gRPC endpoint "${attemptedKey}" is indexed. Check the service/method spelling, or that the provider repo has been indexed.`
          : `"${target}" is not indexed — no symbol, note, or gRPC endpoint matches this name.`,
      },
    });
  }
  assertResolvedNodeInScope(store, focus, options);
  const depthCap = options?.depth ?? 5;
  const limit = discoveryLimit;
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const outEdges = (ids: string[]) => snapshotEdgePairsForNodes(store, options.revision!, ids, {
      edgeTypes: DOWNSTREAM,
      direction: "out",
      limit: Math.max(limit, Math.min(5_000, limit * ids.length)),
    }).filter((edge) => edge.dst).map((edge) => ({
      src: edge.src,
      id: edge.dst!,
      via: edge.edgeType,
      graphEvidence: graphEdgeEvidence({
        edgeType: edge.edgeType,
        method: edge.method,
        confidence: edge.confidence,
        provenance: edge.provenance,
        scope: edge.scope,
      }),
    }));
    const inEdges = (id: string) => snapshotEdgePairsForNodes(store, options.revision!, [id], {
      edgeTypes: FLOW_INGRESS,
      direction: "in",
      limit,
    }).filter((edge) => edge.dst === id).map((edge) => ({
      id: edge.src,
      via: edge.edgeType,
      graphEvidence: graphEdgeEvidence({
        edgeType: edge.edgeType,
        method: edge.method,
        confidence: edge.confidence,
        provenance: edge.provenance,
        scope: edge.scope,
      }),
    }));
    const endpointSeed = endpointFlowSeed(store, focus, options, limit);
    const ingress = endpointSeed ? [] : flowIngressPath(store, focus, inEdges, depthCap, limit);
    const steps: FlowStep[] = endpointSeed?.steps ?? ingress.map((edge, depth) => ({ depth, ...nodeBriefStep(store, edge.id, options), via: edge.via, ...(edge.graphEvidence ? { graphEvidence: edge.graphEvidence } : {}) }));
    const seen = endpointSeed?.seen ?? new Set<string>(ingress.map((edge) => edge.id));
    appendFlowDownstream(store, focus, endpointSeed ? 0 : ingress.length - 1, steps, seen, outEdges, depthCap, limit, options, endpointSeed?.frontier);
    const boundedSteps = markFlowBoundaries(steps);
    const root = boundedSteps[0];
    const enrichment = flowEnrichment(store, boundedSteps.map((step) => step.nodeId), {
      branchId: options.revision.branchId,
      limit,
      snapshotRevision: options.revision,
    });
    return attach({ target, trust: options.revision.branchId ? trustEnvelopeForBranch(store, options.revision.branchId) : null, root, steps: boundedSteps, ...enrichment, ...(boundedSteps.length === 1 ? { diagnostic: { reason: "no_outgoing_edges" as const, message: `"${root.title}" is indexed but has no outgoing edges in the selected revision.` } } : {}) });
  }
  const explicitBranchId = revisionBranchId(options);
  const branchId = explicitBranchId ?? liveBranchOf(store, focus);
  const scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
  const bx = branchId ? " AND (branch_id = ? OR branch_id IS NULL)" : "";
  const ph = DOWNSTREAM.map(() => "?").join(",");

  const outEdges = (ids: string[]) => {
    const srcPlaceholders = ids.map(() => "?").join(",");
    const params = branchId ? [...ids, ...DOWNSTREAM, branchId] : [...ids, ...DOWNSTREAM];
    const rows = store.db
      .prepare(
         `SELECT DISTINCT src, dst AS id, edge_type AS via,
                 origin, method, confidence, provenance, evidence_id AS evidenceId,
                 branch_id AS branchId
            FROM edges
         WHERE src IN (${srcPlaceholders}) AND dst IS NOT NULL AND status='active' AND edge_type IN (${ph})${bx}
         ORDER BY src, edge_type, dst`,
      )
      .all(...params) as Array<FlowDownstreamEdge & { origin?: string | null; method?: string | null; confidence?: number | null; provenance?: string | Record<string, unknown> | null; evidenceId?: string | null; branchId?: string | null }>;
    return rows.map((edge) => ({
        ...edge,
        graphEvidence: graphEdgeEvidence({ edgeType: edge.via, origin: edge.origin, method: edge.method, confidence: edge.confidence, provenance: edge.provenance, evidenceId: edge.evidenceId, branchId: edge.branchId, scope: branchId ? "revision" : undefined }),
      })) as FlowDownstreamEdge[];
  };

  const inEdges = (id: string) => {
    const ingressPlaceholders = FLOW_INGRESS.map(() => "?").join(",");
    const params = branchId ? [id, ...FLOW_INGRESS, branchId] : [id, ...FLOW_INGRESS];
    const rows = store.db
      .prepare(
        `SELECT DISTINCT src AS id, edge_type AS via,
                 origin, method, confidence, provenance, evidence_id AS evidenceId,
                 branch_id AS branchId
            FROM edges
         WHERE dst=? AND status='active' AND edge_type IN (${ingressPlaceholders})${bx}
         ORDER BY edge_type, src`,
      )
      .all(...params) as Array<{ id: string; via: string; origin?: string | null; method?: string | null; confidence?: number | null; provenance?: string | Record<string, unknown> | null; evidenceId?: string | null; branchId?: string | null }>;
    return rows.map((edge) => ({
        ...edge,
        graphEvidence: graphEdgeEvidence({ edgeType: edge.via, origin: edge.origin, method: edge.method, confidence: edge.confidence, provenance: edge.provenance, evidenceId: edge.evidenceId, branchId: edge.branchId, scope: branchId ? "revision" : undefined }),
      }));
  };

  const endpointSeed = endpointFlowSeed(store, focus, options, limit);
  const ingress = endpointSeed ? [] : flowIngressPath(store, focus, inEdges, depthCap, limit);
  const steps: FlowStep[] = endpointSeed?.steps ?? ingress.map((edge, depth) => ({ depth, ...nodeBriefStep(store, edge.id, options), via: edge.via, ...(edge.graphEvidence ? { graphEvidence: edge.graphEvidence } : {}) }));
  const seen = endpointSeed?.seen ?? new Set<string>(ingress.map((edge) => edge.id));
  appendFlowDownstream(store, focus, endpointSeed ? 0 : ingress.length - 1, steps, seen, outEdges, depthCap, limit, options, endpointSeed?.frontier);
  const boundedSteps = markFlowBoundaries(steps);
  const root = boundedSteps[0];
  const enrichment = flowEnrichment(store, boundedSteps.map((step) => step.nodeId), { branchId: branchId ?? undefined, limit });
  if (boundedSteps.length === 1) {
    const node = store.getNode(focus);
    const isEndpoint = node?.node_type === "endpoint";
    // A FILE node with defines/imports is not a leaf, and saying so sent one
    // agent through five other tools before it gave up on listing that file's
    // symbols. Count what the node actually has and point at the tool that
    // enumerates it.
    const isFile = node?.node_type === "file";
    const fileEdges = isFile
      ? store.db.prepare(
          `SELECT edge_type AS type, COUNT(*) AS n FROM edges
            WHERE src=? AND status='active' AND edge_type IN ('defines','imports') GROUP BY edge_type`,
        ).all(focus) as Array<{ type: string; n: number }>
      : [];
    const defines = fileEdges.find((row) => row.type === "defines")?.n ?? 0;
    const imports = fileEdges.find((row) => row.type === "imports")?.n ?? 0;
    return attach({
      target, trust: trustEnvelopeForBranch(store, branchId), root, steps: boundedSteps, ...enrichment,
      diagnostic: {
        reason: isEndpoint ? "endpoint_no_handler" : "no_outgoing_edges",
        message: isEndpoint
          ? `Endpoint "${root.title}" is indexed but has no \`handles\` edge to a handler yet — the provider service may not be indexed, or its @GrpcMethod handler wasn't recognized.`
          : isFile && (defines > 0 || imports > 0)
            ? `"${root.title}" is a FILE node with ${defines} defined symbol(s) and ${imports} import(s), but files carry no outgoing calls/references of their own — call knowledge_file_symbols(repo, path) to enumerate what it defines.`
            : `"${root.title}" is indexed but has no outgoing calls/references — it may be a terminal/leaf symbol, or its callees aren't indexed.`,
      },
      ...(scopeFallback ? { scopeFallback } : {}),
    });
  }
  return attach({ target, trust: trustEnvelopeForBranch(store, branchId), root, steps: boundedSteps, ...enrichment, ...(scopeFallback ? { scopeFallback } : {}) });
}

function markFlowBoundaries(steps: FlowStep[]): FlowStep[] {
  const byId = new Map(steps.map((step) => [step.nodeId, step]));
  return steps.map((step) => {
    const parent = step.parentNodeId ? byId.get(step.parentNodeId) : undefined;
    return parent?.source?.repoId && step.source?.repoId && parent.source.repoId !== step.source.repoId
      ? { ...step, boundary: true }
      : step;
  });
}

function nodeBriefStep(store: KnowledgeStore, id: string, scope?: TargetScopeOptions): ContextBrief {
  return nodeBrief(store, id, scope);
}

// —— Explore v2: verbatim source packs ———————————————————————————————
// The pack carries the actual code, not just briefs/locators, so an AI
// consumer can answer AND edit from ONE call — the two-step
// "explore → Read the file anyway" loop is what pushed agents to other tools.

export interface SourceBlock {
  nodeId: string;
  title: string;
  role: "focus" | "implementation" | "callee" | "caller";
  filePath: string;
  startLine: number;
  endLine: number;
  lang: string | null;
  /** Verbatim file content for [startLine, endLine] — re-read from DISK at
   * query time, byte-for-byte what an editor would see (never a stale index
   * copy). Safe to base edits on when `truncated` is false. */
  code: string;
  /** True when the block was cut to fit the pack's line budget. */
  truncated: boolean;
}

// Read a symbol's current source off disk via its freshest version row.
// Best-effort: moved/unreadable files or notes return null (callers fall back
// to briefs) — same degradation contract as getNodeDetail's source field.
function readSourceBlock(
  store: KnowledgeStore,
  nodeId: string,
  maxLines: number,
): Omit<SourceBlock, "role"> | null {
  const node = store.db
    .prepare("SELECT id, title, repo_id AS repoId FROM nodes WHERE id=?")
    .get(nodeId) as { id: string; title: string; repoId: string | null } | undefined;
  if (!node?.repoId) return null;
  const version = store.db
    .prepare(
      `SELECT file_path AS filePath, start_line AS startLine, end_line AS endLine, lang
         FROM symbol_versions WHERE node_id=?
        ORDER BY (status='fresh') DESC LIMIT 1`,
    )
    .get(nodeId) as
    | { filePath: string; startLine: number | null; endLine: number | null; lang: string | null }
    | undefined;
  if (!version?.filePath || version.startLine == null || version.endLine == null) return null;
  const repo = store.db
    .prepare("SELECT root_path AS rootPath FROM repos WHERE id=?")
    .get(node.repoId) as { rootPath: string } | undefined;
  if (!repo) return null;
  try {
    const abs = isAbsolute(version.filePath)
      ? version.filePath
      : join(repo.rootPath, version.filePath);
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    const fullEnd = Math.min(version.endLine, lines.length);
    const truncated = fullEnd - version.startLine + 1 > maxLines;
    const endLine = truncated ? version.startLine + maxLines - 1 : fullEnd;
    const code = lines.slice(version.startLine - 1, endLine).join("\n");
    if (!code.trim()) return null;
    return {
      nodeId: node.id,
      title: node.title,
      filePath: version.filePath,
      startLine: version.startLine,
      endLine,
      lang: version.lang,
      code,
      truncated,
    };
  } catch {
    return null;
  }
}

export interface ExplorePack {
  target: string;
  focus: ContextPack["focus"];
  implementation: ContextPack["focus"];
  trust: TrustEnvelope | null;
  freshness: {
    stale: boolean;
    reason: string | null;
    indexedAt: string | null;
    coverageGaps: string[];
  };
  callers: ContextBrief[];
  calls: ContextBrief[];
  renderedBy: ContextBrief[];
  renders: ContextBrief[];
  invokedDynamicallyBy: ContextBrief[];
  invokesDynamic: ContextBrief[];
  callPath: FlowStep[];
  blastRadius: ContextBrief[];
  tests: ContextBrief[];
  routes: ContextPack["routes"];
  provenance: Array<{
    edgeType: string;
    origin: string;
    method: string;
    confidence: number;
    count: number;
  }>;
  confidence: {
    level: "high" | "mixed" | "low";
    minimum: number;
    inferredEdges: number;
    totalEdges: number;
  };
  diagnostics: string[];
  /** Verbatim disk source for the focus/implementation and the nearest
   * callers/callees, within a line budget. Never silently capped — anything
   * dropped for budget is named in `sourcesOmitted`. */
  sources: SourceBlock[];
  sourcesOmitted: string[];
  /** Relations whose real size exceeded the limit, named by field. */
  truncated: string[];
  /** Calls that leave the repo, grouped by package — the calls list's gaps. */
  externalCalls: ExternalCallGroup[];
  completeness: {
    /** Never "complete". The calls list is a LOWER BOUND: the resolver models
     * direct calls, and does not model constructor invocation, interface
     * dispatch, static-method calls or calls inside callback bodies — so a
     * short list can mean "few calls" or "few calls we can see", and nothing
     * here can tell them apart. "unknown" means there is no answer at all
     * (nothing resolved), which previously reported "complete" alongside
     * confidence "high" for a symbol that is not in the index. */
    status: "lower_bound" | "partial" | "unknown";
    externalCallCount: number;
    /** Plain-language statement of what the list does and does not cover. */
    note: string;
  };
  // Structured counterpart to the "ambiguous target: N matches" diagnostics
  // string — callers need the actual candidates (nodeId/filePath/branch) to
  // disambiguate and retry directly, not just a count to guess against.
  ambiguousCandidates?: SymbolCandidate[];
  queryDiagnostics: QueryDiagnostics;
  // Set ONLY when no revision/branchId was supplied by the caller and the
  // underlying context/flow queries silently answered against the repo's live
  // branch instead (see FlowResult.scopeFallback). Sourced from whichever of
  // context/flow actually hit the fallback (buildQueryDiagnostics deliberately
  // does NOT carry its own copy of this — see its call site for why).
  scopeFallback?: { branchId: string };
}

// One editing-oriented result shared by CLI and MCP. It composes the existing
// deterministic context, flow, and impact queries and adds edge trust metadata.
export function buildExplorePack(
  store: KnowledgeStore,
  target: string,
  options?: { branchId?: string; repoId?: string; revision?: RevisionContext; depth?: number; limit?: number } & PackSourceOptions,
): ExplorePack {
  // A revision is already repository-scoped. Carry that ownership into every
  // resolver below; otherwise an explicitly selected snapshot can still
  // produce ambiguity candidates from every repository in the database.
  const queryOptions = options?.repoId || !options?.revision?.repoId
    ? options
    : { ...options, repoId: options.revision.repoId };
  let context = buildContextPack(store, target, queryOptions);
  let flow = buildFlow(store, target, queryOptions);
  let searchFallback: string | null = null;
  let searchCandidates: SymbolCandidate[] | null = null;
  // Fuzzy resolution: an exact miss (no focus, no flow root, not ambiguous)
  // falls back to full-text search. A SINGLE hit resolves automatically; more
  // than one becomes ambiguousCandidates — never a guess (index answers are
  // judged 对/错, and a wrong auto-pick is 错).
  if (!context.focus && !flow.root && !context.ambiguous) {
    const hits = store
      .searchText(target, { limit: 5 })
      .filter((hit) => hit.nodeType === "symbol" || hit.nodeType === "endpoint");
    if (hits.length === 1) {
      context = buildContextPack(store, hits[0].nodeId, queryOptions);
      flow = buildFlow(store, hits[0].nodeId, queryOptions);
      searchFallback = `resolved "${target}" via search fallback → ${hits[0].title}`;
    } else if (hits.length > 1) {
      searchCandidates = hits.map((hit) => ({
        nodeId: hit.nodeId,
        nodeType: hit.nodeType,
        identityKey: hit.identityKey,
        title: hit.title,
        filePath: hit.filePath ?? null,
        branch: hit.branch ?? null,
        startLine: null,
      }));
    }
  }
  const focusId = context.focus?.nodeId ?? flow.root?.nodeId ?? null;
  const handler = context.focus?.nodeType === "endpoint"
    ? flow.steps.find((step) => step.via === "handles" && step.nodeType === "symbol")
    : undefined;
  // The handler was discovered through a valid cross-service edge from the
  // already-scoped focus. It is evidence, not a second user-selected target,
  // so read it from its own source scope instead of rejecting it as foreign.
  const implementationContext = handler
    ? buildContextPack(store, handler.nodeId, { ...queryOptions, repoId: undefined, revision: undefined, branchId: undefined })
    : null;
  const effectiveContext = implementationContext ?? context;
  const trust = context.trust ?? implementationContext?.trust ?? flow.trust;
  // Whichever underlying query actually hit the live-branch fallback (context
  // wins over flow since effectiveContext is what the rest of the pack is
  // built from) — see ExplorePack.scopeFallback.
  const scopeFallback = effectiveContext.scopeFallback ?? flow.scopeFallback;
  const blastRadius = focusId
    ? exploreGraph(store, "impact", focusId, { depth: queryOptions?.depth, limit: queryOptions?.limit, revision: queryOptions?.revision, branchId: queryOptions?.branchId, repoId: queryOptions?.repoId }).nodes
    : [];
  const rows = focusId
    ? store.db.prepare(
        `SELECT edge_type AS edgeType, origin, method,
                COALESCE(confidence, CASE WHEN method='INFERRED' THEN 0.5 ELSE 1.0 END) AS confidence,
                COUNT(*) AS count
           FROM edges
          WHERE (src=? OR dst=?) AND status='active'
            ${revisionBranchId(options) ? "AND (branch_id=? OR branch_id IS NULL)" : ""}
          GROUP BY edge_type, origin, method, confidence
          ORDER BY edge_type, method`,
      ).all(...(revisionBranchId(queryOptions) ? [focusId, focusId, revisionBranchId(queryOptions)] : [focusId, focusId])) as Array<{
        edgeType: string; origin: string; method: string; confidence: number; count: number;
      }>
    : [];
  const persistedTotalEdges = rows.reduce((sum, row) => sum + row.count, 0);
  const persistedInferredEdges = rows
    .filter((row) => row.method === "INFERRED")
    .reduce((sum, row) => sum + row.count, 0);
  const flowEdges = flow.steps.filter((step) => step.depth > 0);
  const inferredFlowEdges = flowEdges.filter((step) => step.graphEvidence?.evidenceState === "inferred").length;
  const totalEdges = Math.max(persistedTotalEdges, flowEdges.length);
  const inferredEdges = Math.max(persistedInferredEdges, inferredFlowEdges);
  const confidenceValues = [
    ...rows.map((row) => row.confidence),
    ...flowEdges.flatMap((step) => typeof step.graphEvidence?.confidence === "number" ? [step.graphEvidence.confidence] : []),
  ];
  const minimum = confidenceValues.length > 0 ? Math.min(...confidenceValues) : 0;
  // Unresolvable external calls cap the level below "high". Strictly speaking
  // confidence measures the edges that ARE here (precision) and completeness
  // is a separate axis, which `completeness` now reports — but a caller who
  // sees "high" stops reading, and that is exactly how a 10-item callee list
  // missing its two most important calls got believed. The cap is the signal
  // that actually gets seen; `completeness` carries the precise story.
  const externalCallCount = effectiveContext.completeness?.externalCallCount ?? 0;
  // No focus means no answer, and an answer that does not exist cannot be
  // high-confidence. `explore <name-that-is-not-indexed>` reported level "high"
  // beside an empty pack.
  const resolved = effectiveContext.focus != null;
  const level = !resolved
    ? "low"
    : externalCallCount > 0
      ? (inferredEdges === 0 ? "mixed" : "low")
      : inferredEdges === 0 ? "high" : minimum >= 0.5 ? "mixed" : "low";
  const diagnostics = [
    ...context.signals,
    ...(externalCallCount > 0
      ? [`${externalCallCount} call(s) go to external packages and cannot be resolved to repo symbols — see externalCalls; the calls list is incomplete`]
      : []),
    ...(implementationContext?.signals ?? []),
    ...(context.ambiguous ? [`ambiguous target: ${context.ambiguous.length} matches`] : []),
    ...(searchCandidates ? [`ambiguous target: ${searchCandidates.length} search matches`] : []),
    ...(searchFallback ? [searchFallback] : []),
    ...(context.assemblyError ? [`context assembly failed: ${context.assemblyError}`] : []),
    ...(flow.diagnostic ? [flow.diagnostic.message] : []),
  ];

  // —— verbatim sources, within an explicit budget ——————————————————————
  // focus/implementation first (the thing being asked about), then nearest
  // callees and callers. Budget keeps one pack safely inside a tool-result;
  // every drop is NAMED in sourcesOmitted — silent truncation reads as
  // "covered everything" when it didn't.
  // The budget is a default, not a law: a caller that only wants the relation
  // graph should not pay 800 lines of code for it, and one auditing a large
  // function needs to raise the ceiling rather than get a silently clipped body.
  // Both were previously fixed constants with no way to say either.
  const includeSources = options?.includeSources !== false;
  const SOURCE_BUDGET_LINES = includeSources ? Math.max(0, options?.maxSourceLines ?? 800) : 0;
  const FOCUS_MAX_LINES = Math.min(400, SOURCE_BUDGET_LINES);
  const NEIGHBOR_MAX_LINES = Math.min(120, SOURCE_BUDGET_LINES);
  const NEIGHBOR_COUNT = 3;
  const sources: SourceBlock[] = [];
  const sourcesOmitted: string[] = [];
  const seenSourceIds = new Set<string>();
  let budgetLeft = SOURCE_BUDGET_LINES;
  const pushSource = (
    nodeId: string | null | undefined,
    role: SourceBlock["role"],
    title: string,
    maxLines: number,
  ): void => {
    if (!nodeId || seenSourceIds.has(nodeId)) return;
    if (!includeSources) {
      sourcesOmitted.push(`${role} ${title} (source omitted: includeSources=false)`);
      return;
    }
    if (budgetLeft <= 0) {
      sourcesOmitted.push(`${role} ${title} (line budget exhausted at ${SOURCE_BUDGET_LINES} lines — raise maxSourceLines)`);
      return;
    }
    const block = readSourceBlock(store, nodeId, Math.min(maxLines, budgetLeft));
    if (!block) return; // note/moved-file/no-range — briefs still cover it
    seenSourceIds.add(nodeId);
    const lineCount = block.endLine - block.startLine + 1;
    budgetLeft -= lineCount;
    sources.push({ ...block, role });
  };
  pushSource(context.focus?.nodeId, "focus", context.focus?.title ?? target, FOCUS_MAX_LINES);
  if (implementationContext?.focus && implementationContext.focus.nodeId !== context.focus?.nodeId) {
    pushSource(implementationContext.focus.nodeId, "implementation", implementationContext.focus.title, FOCUS_MAX_LINES);
  }
  for (const callee of effectiveContext.calls.slice(0, NEIGHBOR_COUNT)) {
    pushSource(callee.nodeId, "callee", callee.title, NEIGHBOR_MAX_LINES);
  }
  for (const caller of effectiveContext.callers.slice(0, NEIGHBOR_COUNT)) {
    pushSource(caller.nodeId, "caller", caller.title, NEIGHBOR_MAX_LINES);
  }
  for (const extra of effectiveContext.calls.slice(NEIGHBOR_COUNT)) {
    sourcesOmitted.push(`callee ${extra.title} (beyond top ${NEIGHBOR_COUNT})`);
  }
  for (const extra of effectiveContext.callers.slice(NEIGHBOR_COUNT)) {
    sourcesOmitted.push(`caller ${extra.title} (beyond top ${NEIGHBOR_COUNT})`);
  }
  const routes = context.focus?.nodeType === "endpoint"
    ? [{ route: context.focus.title, via: "direct" as const }, ...effectiveContext.routes]
    : context.routes;
  const uniqueRoutes = routes.filter((route, index) =>
    routes.findIndex((candidate) => candidate.route === route.route && candidate.via === route.via) === index);
  const resultCount =
    effectiveContext.callers.length
    + effectiveContext.calls.length
    + flow.steps.filter((step) => step.depth > 0).length
    + blastRadius.length
    + effectiveContext.tests.length
    + uniqueRoutes.length;
  return {
    target,
    focus: context.focus,
    implementation: effectiveContext.focus,
    trust,
    freshness: {
      stale: trust?.stale ?? true,
      reason: trust?.staleReason ?? (trust ? null : "trust_unavailable"),
      indexedAt: trust?.indexedAt ?? null,
      coverageGaps: trust?.coverageGaps ?? ["trust_unavailable"],
    },
    callers: effectiveContext.callers,
    calls: effectiveContext.calls,
    renderedBy: effectiveContext.renderedBy,
    renders: effectiveContext.renders,
    invokedDynamicallyBy: effectiveContext.invokedDynamicallyBy,
    invokesDynamic: effectiveContext.invokesDynamic,
    callPath: flow.steps,
    blastRadius,
    tests: effectiveContext.tests,
    routes: uniqueRoutes,
    provenance: rows,
    confidence: { level, minimum, inferredEdges, totalEdges },
    diagnostics: [...new Set(diagnostics)],
    sources,
    sourcesOmitted,
    // Relations cut at the limit, named. Explore is what agents call, so the
    // honesty contract has to survive the hop from ContextPack to here.
    truncated: effectiveContext.truncated ?? [],
    externalCalls: effectiveContext.externalCalls ?? [],
    completeness: effectiveContext.completeness ?? { status: "unknown", externalCallCount: 0, note: "Nothing resolved for this target, so there is no calls list to describe." },
    ...(context.ambiguous ? { ambiguousCandidates: context.ambiguous } : {}),
    ...(!context.ambiguous && searchCandidates ? { ambiguousCandidates: searchCandidates } : {}),
    ...(scopeFallback ? { scopeFallback } : {}),
    queryDiagnostics: buildQueryDiagnostics(
      store,
      target,
      focusId,
      resultCount,
      {
        branchId: trust?.branchId ?? options?.branchId,
        assemblyError: context.assemblyError,
      },
    ),
  };
}

export function renderFlowMarkdown(flow: FlowResult): string {
  if (!flow.root) {
    const L = [`# Flow: ${flow.target}`, ""];
    if (flow.ambiguous) L.push(renderAmbiguousSymbols(flow.target, flow.ambiguous, "flow"));
    else L.push(flow.diagnostic?.message ?? "_No matching entry point/symbol._");
    return L.join("\n") + "\n";
  }
  const L: string[] = [`# Flow: ${flow.root.title}`, ""];
  // Walk the real parent links. Printing in traversal order and indenting by
  // depth put each step under whichever line of the previous depth happened to
  // be printed last, which showed an interface as the caller of thirteen
  // functions — a statement that is false, not merely incomplete.
  const childrenOf = new Map<string, FlowStep[]>();
  const roots: FlowStep[] = [];
  for (const step of flow.steps) {
    if (!step.parentNodeId) { roots.push(step); continue; }
    const bucket = childrenOf.get(step.parentNodeId);
    if (bucket) bucket.push(step);
    else childrenOf.set(step.parentNodeId, [step]);
  }
  const line = (step: FlowStep, indentDepth: number) => {
    const indent = "  ".repeat(indentDepth);
    const arrow = step.via === "root" ? "" : `${step.via} → `;
    const tag = step.nodeType !== "symbol" ? ` _(${step.nodeType})_` : "";
    L.push(`${indent}${indentDepth === 0 ? "" : "↳ "}${arrow}\`${step.title}\`${tag}`);
  };
  const walk = (step: FlowStep, indentDepth: number, visited: Set<string>) => {
    line(step, indentDepth);
    if (visited.has(step.nodeId)) return; // a cycle prints once, not forever
    visited.add(step.nodeId);
    for (const child of childrenOf.get(step.nodeId) ?? []) walk(child, indentDepth + 1, visited);
  };
  const seenInRender = new Set<string>();
  for (const root of roots) walk(root, 0, seenInRender);
  // A step whose parent never made it into `steps` still belongs in the output;
  // dropping it silently would trade a wrong tree for a short one.
  const rendered = new Set<string>();
  const collect = (step: FlowStep) => { rendered.add(step.nodeId); (childrenOf.get(step.nodeId) ?? []).forEach(collect); };
  roots.forEach(collect);
  for (const step of flow.steps) {
    if (!rendered.has(step.nodeId)) line(step, step.depth);
  }
  if (flow.relatedTests.length > 0) {
    L.push("", "## Related tests", "", ...flow.relatedTests.map((item) => `- \`${item.title}\``));
  }
  if (flow.linkedKnowledge.length > 0) {
    L.push("", "## Linked knowledge", "", ...flow.linkedKnowledge.map((item) => `- ${item.title}`));
  }
  if (flow.diagnostic) L.push("", `⚠ ${flow.diagnostic.message}`);
  return L.join("\n");
}

// —— affected: git-diff blast radius (§ codebase-memory-mcp parity) ——
// Given changed files, return the symbols they define, the transitive callers
// (blast radius), the tests that cover any of them, and the routes that reach
// them — so a PR review / AI edit knows "what could this break".
export interface AffectedResult {
  files: string[];
  changed: ContextBrief[];
  impacted: ContextBrief[];
  /** Direct outgoing dependencies of the changed symbols. */
  dependencies: ContextBrief[];
  tests: ContextBrief[];
  routes: string[];
  /** Commands are suggestions only; they are never proof that a test ran. */
  suggestedVerification: string[];
  target?: { requested: string; nodeId: string; nodeType: string };
  candidateCount?: number;
  totalIsExact?: boolean;
  completeness?: "complete" | "lower_bound" | "partial" | "unknown";
  coverageGaps?: string[];
  evidence?: EvidenceEnvelope;
  scope?: Record<string, unknown> | null;
  revision?: RevisionContext | null;
  freshness?: EvidenceEnvelope["freshness"];
  coverage?: EvidenceEnvelope["coverage"];
  proofStatus?: EvidenceProofStatus;
  returnedCount?: number;
  cursor?: string | null;
  /** Graph facts explaining the returned impact hops. */
  impactEdges?: AffectedEdgeEvidence[];
}

export interface AffectedEdgeEvidence {
  src: string;
  dst: string;
  edgeType: string;
  evidenceState: "proven" | "candidate";
  origin: string | null;
  method: string | null;
  confidence: number | null;
  provenance: Record<string, unknown> | null;
  scope: "revision" | "global" | "unknown";
  graphEvidence: GraphEdgeEvidenceEnvelope;
}

function suggestedVerification(files: string[]): string[] {
  const normalized = files.map((file) => file.toLowerCase());
  const suggestions: string[] = [];
  if (normalized.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(file))) {
    suggestions.push("pnpm test", "pnpm typecheck");
  }
  if (normalized.some((file) => /\.rs$/u.test(file))) {
    suggestions.push("cargo test", "cargo check");
  }
  if (normalized.some((file) => /\.(py|go|java|kt|kts)$/u.test(file))) {
    suggestions.push("Run the repository-configured test command", "Run the repository-configured build or type-check command");
  }
  return suggestions.length > 0
    ? [...new Set(suggestions)]
    : ["Run the repository-configured test command", "Run the repository-configured build or type-check command"];
}

function affectedDependencies(
  store: KnowledgeStore,
  ids: string[],
  options?: { branchId?: string; revision?: RevisionContext },
): ContextBrief[] {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const branchId = revisionBranchId(options);
  let dependencyIds: string[] = [];
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    dependencyIds = snapshotEdgePairsForNodes(store, options.revision, uniqueIds, {
      edgeTypes: [...DEPENDENCY_EDGE_TYPES],
      direction: "out",
      limit: 10_000,
    }).map((edge) => edge.dst).filter((id): id is string => Boolean(id));
  } else {
    const sourcePlaceholders = uniqueIds.map(() => "?").join(",");
    const rows = store.db.prepare(
      `SELECT DISTINCT dst AS id FROM edges
        WHERE src IN (${sourcePlaceholders}) AND dst IS NOT NULL
          AND edge_type IN (${DEPENDENCY_EDGE_TYPES.map(() => "?").join(",")})
          AND status='active'
          ${branchId ? "AND (branch_id=? OR branch_id IS NULL)" : ""}
        ORDER BY dst LIMIT 10000`,
    ).all(...uniqueIds, ...DEPENDENCY_EDGE_TYPES, ...(branchId ? [branchId] : [])) as Array<{ id: string }>;
    dependencyIds = rows.map((row) => row.id);
  }
  return [...new Set(dependencyIds)].map((id) => {
    const brief = nodeBrief(store, id);
    return { nodeId: brief.nodeId, title: brief.title, nodeType: brief.nodeType };
  });
}

function parseEdgeProvenance(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
  }
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function affectedImpactEdges(
  store: KnowledgeStore,
  ids: string[],
  options?: { branchId?: string; revision?: RevisionContext },
): AffectedEdgeEvidence[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const branchId = revisionBranchId(options);
  const rows = store.db.prepare(
    `SELECT src, dst, edge_type AS edgeType, origin, method, confidence, provenance,
            evidence_id AS evidenceId,
            CASE WHEN branch_id IS NULL THEN 'global' ELSE 'revision' END AS scope
       FROM edges
      WHERE dst IN (${placeholders}) AND src IN (${placeholders})
        AND status='active' AND edge_type IN (${IMPACT_EDGE_TYPES.map(() => "?").join(",")})
        ${branchId ? "AND (branch_id=? OR branch_id IS NULL)" : ""}
      ORDER BY edge_type, src, dst, id`,
  ).all(
    ...ids,
    ...ids,
    ...IMPACT_EDGE_TYPES,
    ...(branchId ? [branchId] : []),
  ) as Array<{ src: string; dst: string; edgeType: string; origin: string | null; method: string | null; confidence: number | null; provenance: unknown; evidenceId: string | null; scope: "revision" | "global" | "unknown" }>;
  return rows.map((row) => {
    const graphEvidence = graphEdgeEvidence({
      edgeType: row.edgeType,
      origin: row.origin,
      method: row.method,
      confidence: row.confidence,
      provenance: row.provenance,
      evidenceId: row.evidenceId,
      scope: row.scope,
    });
    return {
      ...row,
      // Preserve the old two-state affected contract while exposing the
      // richer evidence envelope beside it.
      evidenceState: graphEvidence.evidenceState === "proven" && row.edgeType === "calls" ? "proven" as const : "candidate" as const,
      provenance: parseEdgeProvenance(row.provenance),
      graphEvidence,
    };
  });
}

export type AffectedRequest = {
  kind: "file" | "node";
  values: string[];
  repoId?: string;
  revision?: RevisionContext;
};

export type AffectedInput = {
  files?: unknown;
  file?: unknown;
  path?: unknown;
  target?: unknown;
  node?: unknown;
  symbol?: unknown;
  positional?: unknown;
  repoId?: string;
  revision?: RevisionContext;
};

export class AffectedRequestError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: "INVALID_ARGUMENT",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AffectedRequestError";
  }
}

function affectedStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRepoRelativeFileLike(value: string): boolean {
  if (/^(?:node|symbol):/u.test(value) || value.startsWith("/")) return false;
  return value.includes("/") || /\.[^/]+$/u.test(value);
}

function isIndexedAffectedFile(
  store: KnowledgeStore,
  filePath: string,
  options: Pick<AffectedRequest, "repoId" | "revision">,
): boolean {
  const branchId = options.revision?.branchId;
  const repoId = options.repoId ?? options.revision?.repoId;
  const fileCheckpoint = store.db.prepare(
    `SELECT 1
       FROM files_index
      WHERE file_path=?
        ${repoId ? "AND repo_id=?" : ""}
        ${branchId ? "AND branch_id=?" : ""}
      LIMIT 1`,
  ).get(...[filePath, ...(repoId ? [repoId] : []), ...(branchId ? [branchId] : [])]);
  if (fileCheckpoint) return true;
  return Boolean(store.db.prepare(
    `SELECT 1
       FROM symbol_versions sv
       JOIN branches b ON b.id=sv.branch_id
      WHERE sv.file_path=? AND sv.status='fresh'
        ${repoId ? "AND b.repo_id=?" : ""}
        ${branchId ? "AND sv.branch_id=?" : ""}
      LIMIT 1`,
  ).get(...[filePath, ...(repoId ? [repoId] : []), ...(branchId ? [branchId] : [])]));
}

/**
 * Classifies the public affected inputs once for every adapter. File fields
 * are explicit; a bare repo-relative file path wins over fuzzy node lookup.
 */
export function normalizeAffectedRequest(store: KnowledgeStore, input: AffectedInput): AffectedRequest {
  const fileValues = [
    ...affectedStrings(input.files),
    ...affectedStrings(input.file),
    ...affectedStrings(input.path),
  ];
  const nodeValues = [
    ...affectedStrings(input.target),
    ...affectedStrings(input.node),
    ...affectedStrings(input.symbol),
  ];
  const positionalValues = affectedStrings(input.positional);
  const scope = { repoId: input.repoId, revision: input.revision };

  if (fileValues.length > 0 && nodeValues.length > 0) {
    throw new AffectedRequestError("INVALID_ARGUMENT", "affected accepts file inputs or a node target, not both", {
      fileValues,
      nodeValues,
      remediation: "provide file/files/path or target/node/symbol, but not both",
    });
  }
  if (nodeValues.length > 1 && new Set(nodeValues).size > 1) {
    throw new AffectedRequestError("INVALID_ARGUMENT", "affected accepts exactly one node target", {
      nodeValues,
      remediation: "provide one of target, node, or symbol",
    });
  }
  if (fileValues.length > 0) return { kind: "file", values: fileValues, ...scope };
  if (nodeValues.length > 0) return { kind: "node", values: [nodeValues[0]], ...scope };
  if (positionalValues.length !== 1) return { kind: "file", values: positionalValues, ...scope };

  const value = positionalValues[0];
  if (isIndexedAffectedFile(store, value, scope) || isRepoRelativeFileLike(value)) {
    return { kind: "file", values: [value], ...scope };
  }
  return { kind: "node", values: [value], ...scope };
}

export type AffectedDispatchResult =
  | { request: AffectedRequest; result: AffectedResult }
  | { request: AffectedRequest; error: { code: "TARGET_NOT_RESOLVED"; message: string; retryable: false } };

/** Executes the normalized affected request shared by CLI and MCP. */
export function dispatchAffectedRequest(
  store: KnowledgeStore,
  request: AffectedRequest,
): AffectedDispatchResult {
  if (request.kind === "file") {
    return {
      request,
      result: affectedByFiles(store, request.values, { revision: request.revision }),
    };
  }
  const result = affectedByNode(store, request.values[0], {
    revision: request.revision,
    repoId: request.repoId ?? request.revision?.repoId,
  });
  return result
    ? { request, result }
    : {
      request,
      error: {
        code: "TARGET_NOT_RESOLVED",
        message: `affected target could not be resolved: ${request.values[0]}`,
        retryable: false,
      },
    };
}

/**
 * Node-targeted blast radius. `affected <file>...` and `affected node:<id>`
 * are deliberately separate contracts: a node target must never be treated
 * as a literal filename and reported as a successful empty result.
 */
export function affectedByNode(
  store: KnowledgeStore,
  requested: string,
  options?: { depth?: number; limit?: number; revision?: RevisionContext; repoId?: string },
): AffectedResult | null {
  const scoped = resolveSymbolMatches(store, requested, options?.repoId ? { repoId: options.repoId } : undefined);
  const resolution = scoped.kind === "none" && options?.repoId
    ? resolveSymbolMatches(store, requested)
    : scoped;
  if (resolution.kind !== "unique") return null;
  const target = store.getNode(resolution.nodeId);
  if (!target) return null;
  assertResolvedNodeInScope(store, resolution.nodeId, options);
  const location = store.db.prepare(
    "SELECT file_path AS filePath FROM symbol_versions WHERE node_id=? AND status='fresh' ORDER BY start_line LIMIT 1",
  ).get(resolution.nodeId) as { filePath: string | null } | undefined;
  // Preserve the requested symbol as the traversal seed. File-level affected
  // remains a separate operation; widening here would pull unrelated sibling
  // symbols and their callers into a node-targeted answer.
  const graph = exploreGraph(store, "impact", resolution.nodeId, {
    depth: options?.depth,
    limit: options?.limit,
    repoId: options?.repoId,
    revision: options?.revision,
    includeDiagnostics: false,
    includeEvidence: false,
  });
  const ids = [resolution.nodeId, ...graph.nodes.map((node) => node.nodeId)];
  const placeholders = ids.map(() => "?").join(",");
  const related = ids.length > 0
    ? store.db.prepare(
        `SELECT DISTINCT src AS id, edge_type AS edgeType FROM edges
           WHERE dst IN (${placeholders}) AND status='active' AND edge_type IN ('tests','handles')`,
    ).all(...ids) as Array<{ id: string; edgeType: string }>
    : [];
  const brief = (id: string): ContextBrief => nodeBrief(store, id);
  const dependencies = affectedDependencies(store, [resolution.nodeId], options);
  const tests = related.filter((row) => row.edgeType === "tests").map((row) => brief(row.id));
  const routes = related.filter((row) => row.edgeType === "handles").map((row) => brief(row.id).title);
  const impactEdges = affectedImpactEdges(store, ids, options);
  const result: AffectedResult = {
    files: location?.filePath ? [location.filePath] : [],
    changed: [brief(resolution.nodeId)],
    impacted: graph.nodes,
    dependencies,
    tests,
    routes,
    suggestedVerification: suggestedVerification(location?.filePath ? [location.filePath] : []),
    target: { requested, nodeId: resolution.nodeId, nodeType: target.node_type },
    candidateCount: 1 + graph.nodes.length,
    totalIsExact: false,
    completeness: graph.completeness === "partial" ? "partial" : "lower_bound",
    coverageGaps: graph.coverageGaps ?? ["impact_edges_are_static_only"],
    impactEdges,
  };
  return publicEvidenceFields(store, result, {
    repoId: options?.repoId ?? target.repo_id ?? undefined,
    branchId: options?.revision?.branchId,
    revision: options?.revision,
    completeness: result.completeness ?? "unknown",
    proofStatus: "candidate",
    candidateCount: result.candidateCount ?? result.changed.length + result.impacted.length,
    returnedCount: result.changed.length + result.impacted.length,
    truncated: result.completeness === "partial",
    cursor: null,
  }) as unknown as AffectedResult;
}

export function affectedByFiles(
  store: KnowledgeStore,
  files: string[],
  options?: { depth?: number; limit?: number; revision?: RevisionContext; branchId?: string },
): AffectedResult {
  const depth = options?.depth ?? 3;
  const limit = options?.limit ?? 200;
  const completeEmptyFileLookup = (): boolean => {
    const branchId = revisionBranchId(options);
    const repoId = options?.revision?.repoId;
    if (!branchId || !repoId || files.length === 0) return false;
    return files.every((filePath) => Boolean(store.db.prepare(
      `SELECT 1
         FROM files_index fi
        WHERE fi.repo_id=? AND fi.branch_id=? AND fi.file_path=? AND fi.status='indexed'
          AND NOT EXISTS (
            SELECT 1 FROM symbol_versions sv
             WHERE sv.branch_id=fi.branch_id AND sv.file_path=fi.file_path AND sv.status='fresh'
          )
        LIMIT 1`,
    ).get(repoId, branchId, filePath)));
  };
  const attach = (result: AffectedResult): AffectedResult => {
    const resultCount = result.changed.length + result.impacted.length;
    const exactEmpty = resultCount === 0 && completeEmptyFileLookup();
    return {
      ...publicEvidenceFields(store, result, {
        branchId: options?.branchId,
        revision: options?.revision,
        completeness: resultCount >= limit ? "partial" : "lower_bound",
        proofStatus: resultCount > 0 ? "candidate" : exactEmpty ? "proven" : "not_proven",
        candidateCount: resultCount,
        returnedCount: resultCount,
        truncated: resultCount >= limit,
        cursor: null,
      }),
      totalIsExact: exactEmpty,
    } as unknown as AffectedResult;
  };
  if (files.length === 0) return attach({ files, changed: [], impacted: [], dependencies: [], tests: [], routes: [], suggestedVerification: suggestedVerification(files) });
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const view = openRevisionView(store, options.revision);
    const changedIds = view.symbolVersionsForFiles(files).map((row) => row.nodeId);
    const seen = new Set(changedIds); let frontier = [...changedIds];
    for (let d = 0; d < (options.depth ?? 3) && frontier.length && seen.size < (options.limit ?? 200); d++) {
      const next: string[] = [];
      const frontierSet = new Set(frontier);
      const remaining = Math.max(1, (options.limit ?? 200) - seen.size);
      const pairs = snapshotEdgePairsForNodes(store, options.revision, frontier, {
        edgeTypes: [...IMPACT_EDGE_TYPES],
        direction: "in",
        limit: Math.min(50_000, Math.max(1_000, remaining * 50)),
      });
      for (const edge of pairs) {
        if (!edge.dst || !frontierSet.has(edge.dst) || seen.has(edge.src)) continue;
        seen.add(edge.src);
        next.push(edge.src);
        if (seen.size >= (options.limit ?? 200)) break;
      }
      frontier = next;
    }
    const related = snapshotEdgePairsForNodes(store, options.revision, [...seen], {
      edgeTypes: ["tests", "handles"],
      direction: "in",
      limit: Math.min(10_000, Math.max(1_000, (options.limit ?? 200) * 10)),
    });
    const testIds = [...new Set(related.filter((edge) => edge.edgeType === "tests").map((edge) => edge.src))];
    const routeIds = [...new Set(related.filter((edge) => edge.edgeType === "handles").map((edge) => edge.src))];
    const brief = (ids: string[]) => ids.map((id) => { const b = nodeBrief(store, id); return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType }; });
    return attach({
      files,
      changed: brief(changedIds),
      impacted: brief([...seen].filter((id) => !changedIds.includes(id))),
      dependencies: affectedDependencies(store, changedIds, options),
      tests: brief(testIds),
      routes: routeIds.map((id) => nodeBrief(store, id).title),
      suggestedVerification: suggestedVerification(files),
      impactEdges: [],
    });
  }
  const ph = files.map(() => "?").join(",");
  const branchId = revisionBranchId(options);
  const changedIds = (store.db
    .prepare(`SELECT DISTINCT node_id AS id FROM symbol_versions WHERE file_path IN (${ph}) AND status='fresh'${branchId ? " AND branch_id=?" : ""}`)
    .all(...(branchId ? [...files, branchId] : files)) as { id: string }[]).map((r) => r.id);

  // transitive who_calls from the changed set = blast radius.
  const seen = new Set(changedIds);
  let frontier = [...changedIds];
  for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.size >= limit) break;
      // both "calls" and "references" mean "depends on this" — a DTO/type change
      // ripples through its type-users just as a fn change ripples through callers.
      const callers = store.db.prepare(`SELECT DISTINCT src FROM edges WHERE dst=? AND edge_type IN (${IMPACT_EDGE_TYPES.map(() => "?").join(",")}) AND status='active'${branchId ? " AND (branch_id=? OR branch_id IS NULL)" : ""}`).all(id, ...IMPACT_EDGE_TYPES, ...(branchId ? [branchId] : [])) as { src: string }[];
      for (const c of callers) if (!seen.has(c.src)) { seen.add(c.src); next.push(c.src); }
    }
    frontier = next;
  }
  const impactedIds = [...seen].filter((id) => !changedIds.includes(id));

  const allIds = [...seen];
  const p2 = allIds.map(() => "?").join(",");
  const tests = allIds.length
    ? (store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='tests' AND status='active' AND dst IN (${p2})${branchId ? " AND (branch_id=? OR branch_id IS NULL)" : ""} LIMIT ?`).all(...(branchId ? [...allIds, branchId, limit] : [...allIds, limit])) as { id: string }[])
    : [];
  const routes = allIds.length
    ? (store.db.prepare(`SELECT DISTINCT src AS id FROM edges WHERE edge_type='handles' AND status='active' AND dst IN (${p2})${branchId ? " AND (branch_id=? OR branch_id IS NULL)" : ""} LIMIT ?`).all(...(branchId ? [...allIds, branchId, limit] : [...allIds, limit])) as { id: string }[])
    : [];

  const brief = (ids: string[]): ContextBrief[] => ids.map((id) => { const b = nodeBrief(store, id); return { nodeId: b.nodeId, title: b.title, nodeType: b.nodeType }; });
  return attach({
    files,
    changed: brief(changedIds),
    impacted: brief(impactedIds),
    dependencies: affectedDependencies(store, changedIds, options),
    impactEdges: affectedImpactEdges(store, [...seen], options),
    tests: brief(tests.map((t) => t.id)),
    routes: routes.map((r) => nodeBrief(store, r.id).title),
    suggestedVerification: suggestedVerification(files),
  });
}

// Keep the shared affected contract on the existing public core export so
// adapters do not grow their own target-vs-file selection rules.
export namespace affectedByFiles {
  export const normalize = normalizeAffectedRequest;
  export const dispatch = dispatchAffectedRequest;
  export const RequestError = AffectedRequestError;
  // Existing public core namespace keeps adapter access stable without a
  // second inventory-specific adapter rule.
  export const endpointInventory = listEndpointInventory;
  export const endpointInventoryPage = listEndpointInventoryPage;
  export const materializeEndpointOccurrences = materializeRevisionEndpointOccurrences;
  export const inventoryRevision = endpointInventoryRevision;
  export const endpointScope = resolveEndpointInventoryScope;
  export const listEnvelope = buildKnowledgeListEnvelope;
}

// —— architecture: one-call project overview (AI onboarding, § parity) ——
export interface ArchitectureOverview {
  repos: Array<{ name: string; branches: number }>;
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  languages: Array<{ lang: string; symbols: number }>;
  hubs: Array<{ title: string; nodeType: string; degree: number }>;
  entryPoints: string[];
}
const GENERIC_UTILITY_HUB_NAMES = new Set([
  "get", "set", "find", "findone", "map", "filter", "reduce", "resolve",
  "log", "error", "warn", "info", "debug", "trace", "handle", "call",
  "apply", "create", "update", "delete", "read", "write", "parse", "format",
  "t", "$translate", "translate", "logerror", "emitter", "size", "populate",
]);

export function architecture(
  store: KnowledgeStore,
  options?: { repoId?: string },
): ArchitectureOverview {
  const rows = <T,>(sql: string, ...p: unknown[]) => store.db.prepare(sql).all(...p) as T[];
  // Every count below narrows to one repo when asked. Ignoring the scope meant
  // "tell me about THIS service" answered with a 26-repo estate whose top hubs
  // were parseInt and isNaN — an answer nobody can act on.
  const repoId = options?.repoId;
  const nodeScope = repoId ? "WHERE repo_id=?" : "";
  const nodeArgs = repoId ? [repoId] : [];
  const edgeJoin = repoId ? "JOIN nodes n ON n.id = e.src AND n.repo_id=?" : "";
  const edgeArgs = repoId ? [repoId] : [];
  const repos = rows<{ name: string; n: number }>(
    `SELECT r.name AS name, (SELECT COUNT(*) FROM branches b WHERE b.repo_id=r.id) AS n
       FROM repos r ${repoId ? "WHERE r.id=?" : ""} ORDER BY r.name`,
    ...(repoId ? [repoId] : []),
  ).map((r) => ({ name: r.name, branches: r.n }));
  const countMap = (sql: string, ...p: unknown[]) =>
    Object.fromEntries(rows<{ k: string; n: number }>(sql, ...p).map((r) => [r.k, r.n]));
  const nodeCounts = countMap(
    `SELECT node_type AS k, COUNT(*) AS n FROM nodes ${nodeScope} GROUP BY node_type ORDER BY n DESC`,
    ...nodeArgs,
  );
  // Endpoint nodes may be global contract identities (`repo_id IS NULL`) and
  // acquire repository ownership through endpoint_memberships. Architecture
  // must use the same rule as knowledge_endpoints or the two public counts
  // can differ by orders of magnitude for shared gRPC contracts.
      const endpointFilter = endpointInventoryFilter(repoId, {});
  const endpointCount = store.db.prepare(
    `SELECT COUNT(*) AS n FROM nodes n WHERE ${endpointFilter.where.join(" AND ")}`,
  ).get(...endpointFilter.params) as { n: number };
  nodeCounts.endpoint = Number(endpointCount.n ?? 0);
  const edgeCounts = countMap(
    `SELECT e.edge_type AS k, COUNT(*) AS n FROM edges e ${edgeJoin}
      WHERE e.status='active' GROUP BY e.edge_type ORDER BY n DESC`,
    ...edgeArgs,
  );
  const languages = rows<{ lang: string; symbols: number }>(
    `SELECT sv.lang AS lang, COUNT(*) AS symbols FROM symbol_versions sv
       ${repoId ? "JOIN branches b ON b.id = sv.branch_id AND b.repo_id=?" : ""}
      WHERE sv.status='fresh' GROUP BY sv.lang ORDER BY symbols DESC LIMIT 12`,
    ...(repoId ? [repoId] : []),
  );
  const hubs = rows<{ id: string; degree: number }>(
    `SELECT node AS id, COUNT(*) AS degree FROM (
        SELECT e.src AS node FROM edges e ${edgeJoin}
         WHERE e.status='active' AND e.edge_type IN ('calls','references')
        UNION ALL
        SELECT e.dst AS node FROM edges e ${repoId ? "JOIN nodes n ON n.id = e.dst AND n.repo_id=?" : ""}
         WHERE e.status='active' AND e.edge_type IN ('calls','references') AND e.dst IS NOT NULL
     ) GROUP BY node ORDER BY degree DESC LIMIT 40`,
    ...edgeArgs, ...(repoId ? [repoId] : []),
  ).map((h) => { const b = nodeBrief(store, h.id); return { title: b.title, nodeType: b.nodeType, degree: h.degree }; })
   .filter((h) => h.nodeType === "symbol" && !GENERIC_UTILITY_HUB_NAMES.has(h.title.toLowerCase())).slice(0, 12);
  const entryPoints = rows<{ title: string }>(
    `SELECT n.title FROM nodes n WHERE ${endpointFilter.where.join(" AND ")} ORDER BY n.title LIMIT 30`,
    ...endpointFilter.params,
  ).map((r) => r.title);
  return { repos, nodeCounts, edgeCounts, languages, hubs, entryPoints };
}

export interface Community {
  id: number;
  size: number;
  repos: string[]; // repo names the community spans, most-represented first
  topMembers: Array<{ title: string; nodeType: string; degree: number }>; // god node first
}
export interface CommunityResult {
  communities: Community[];
  totalNodes: number;
  totalCommunities: number;
  suppressedHubs: Array<{ nodeId: string; title: string; degree: number; reason: "generic_utility_name" }>;
}

// Module/community detection over the active structural graph via label
// propagation (§P3): each node adopts the majority label among its neighbours,
// iterated to convergence. Deterministic (smallest-label tie-break) so repeated
// runs agree. Returns the largest communities, each with its highest-degree
// "god node" first and the repos it spans.
export function communities(store: KnowledgeStore, opts: { limit?: number; minSize?: number; repoId?: string } = {}): CommunityResult {
  const limit = opts.limit ?? 20;
  const minSize = opts.minSize ?? 3;
  const edgeScope = opts.repoId ? " AND (src IN (SELECT id FROM nodes WHERE repo_id=?) OR dst IN (SELECT id FROM nodes WHERE repo_id=?))" : "";
  const rawEdges = store.db
    .prepare(
      `SELECT src, dst FROM edges WHERE status='active' AND dst IS NOT NULL AND edge_type IN ('calls','references','imports','defines')${edgeScope}`,
    )
    .all(...(opts.repoId ? [opts.repoId, opts.repoId] : [])) as { src: string; dst: string }[];
  const rawDegree = new Map<string, number>();
  for (const edge of rawEdges) {
    rawDegree.set(edge.src, (rawDegree.get(edge.src) ?? 0) + 1);
    rawDegree.set(edge.dst, (rawDegree.get(edge.dst) ?? 0) + 1);
  }
  const nodeRows = store.db
    .prepare(`SELECT id, title, repo_id AS repoId FROM nodes${opts.repoId ? " WHERE repo_id=?" : ""}`)
    .all(...(opts.repoId ? [opts.repoId] : [])) as Array<{ id: string; title: string; repoId: string | null }>;
  const suppressedIds = new Set(
    nodeRows
      .filter((node) => GENERIC_UTILITY_HUB_NAMES.has(node.title.toLowerCase()))
      .map((node) => node.id),
  );
  const suppressedHubs = nodeRows
    .filter((node) => suppressedIds.has(node.id) && (rawDegree.get(node.id) ?? 0) >= Math.max(minSize, 3))
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      degree: rawDegree.get(node.id) ?? 0,
      reason: "generic_utility_name" as const,
    }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 50);
  const edges = rawEdges.filter((edge) => !suppressedIds.has(edge.src) && !suppressedIds.has(edge.dst));

  const adj = new Map<string, string[]>();
  const degree = new Map<string, number>();
  const link = (a: string, b: string) => {
    let n = adj.get(a);
    if (!n) adj.set(a, (n = []));
    n.push(b);
    degree.set(a, (degree.get(a) ?? 0) + 1);
  };
  for (const e of edges) {
    link(e.src, e.dst);
    link(e.dst, e.src);
  }
  const nodes = [...adj.keys()];

  const label = new Map<string, string>();
  for (const n of nodes) label.set(n, n);
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const n of nodes) {
      const counts = new Map<string, number>();
      for (const m of adj.get(n)!) {
        const l = label.get(m)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(n)!;
      let bestC = -1;
      for (const [l, c] of counts) {
        if (c > bestC || (c === bestC && l < best)) {
          best = l;
          bestC = c;
        }
      }
      if (best !== label.get(n)) {
        label.set(n, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const l = label.get(n)!;
    let g = groups.get(l);
    if (!g) groups.set(l, (g = []));
    g.push(n);
  }

  // node → repo name (one pass, avoids a huge IN clause per community).
  const repoName = new Map<string, string>(
    (store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
  );
  const nodeRepo = new Map<string, string | null>(nodeRows.map((row) => [row.id, row.repoId]));

  const chosen = [...groups.values()].filter((g) => g.length >= minSize).sort((a, b) => b.length - a.length).slice(0, limit);
  const communitiesOut: Community[] = chosen.map((members, i) => {
    const topMembers = members
      .map((id) => ({ id, deg: degree.get(id) ?? 0 }))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 6)
      .map((x) => {
        const b = nodeBrief(store, x.id);
        return { title: b.title, nodeType: b.nodeType, degree: x.deg };
      });
    const repoCount = new Map<string, number>();
    for (const id of members) {
      const rid = nodeRepo.get(id);
      const name = rid ? repoName.get(rid) : undefined;
      if (name) repoCount.set(name, (repoCount.get(name) ?? 0) + 1);
    }
    const repos = [...repoCount.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return { id: i + 1, size: members.length, repos, topMembers };
  });

  return { communities: communitiesOut, totalNodes: nodes.length, totalCommunities: groups.size, suppressedHubs };
}

export interface TimelineEntry {
  sha: string;
  subject: string;
  author: string | null;
  date: string | null; // ISO
  merge: boolean;
  repo: string | null;
  tags: string[];
}
export interface TimelineResult {
  entries: TimelineEntry[];
  revision?: RevisionContext;
}

// Recent history across the graph (§P3 timeline): commit nodes ordered by their
// authored date, newest first, with author/merge flag/repo and any tags that
// point at them. Optional repo filter.
export function timeline(store: KnowledgeStore, opts: { limit?: number; repoId?: string; revision?: RevisionContext } = {}): TimelineResult {
  const limit = opts.limit ?? 50;
  const rows = store.db
    .prepare(
      `SELECT n.id AS id, n.title AS subject, n.repo_id AS repoId,
              json_extract(n.meta,'$.author') AS author,
              json_extract(n.meta,'$.date')   AS date,
              json_extract(n.meta,'$.merge')  AS merge
         FROM nodes n
        WHERE n.node_type='commit' ${opts.repoId ? "AND n.repo_id = @repoId" : ""}
        ORDER BY date DESC NULLS LAST
        LIMIT @limit`,
    )
    .all({ limit, repoId: opts.repoId }) as Array<{
    id: string; subject: string; repoId: string | null;
    author: string | null; date: string | null; merge: number | null;
  }>;

  const repoName = new Map<string, string>(
    (store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
  );
  const tagRows = store.db
    .prepare(
      "SELECT e.dst AS commitId, t.title AS tag FROM edges e JOIN nodes t ON t.id=e.src WHERE e.edge_type='tagged' AND e.status='active'",
    )
    .all() as { commitId: string; tag: string }[];
  const tagsByCommit = new Map<string, string[]>();
  for (const t of tagRows) {
    const arr = tagsByCommit.get(t.commitId) ?? [];
    arr.push(t.tag);
    tagsByCommit.set(t.commitId, arr);
  }

  return {
    entries: rows.map((r) => ({
      sha: r.subject.length > 12 && /^[0-9a-f]{7,}$/i.test(r.subject) ? r.subject.slice(0, 10) : r.id.slice(0, 10),
      subject: r.subject,
      author: r.author,
      date: r.date,
      merge: r.merge === 1,
      repo: r.repoId ? repoName.get(r.repoId) ?? null : null,
      tags: tagsByCommit.get(r.id) ?? [],
    })),
    revision: opts.revision,
  };
}

export interface ResponseSample {
  id: string;
  endpointKey: string;
  status: string | null;
  contentType: string | null;
  sample: string;
  capturedAt: string;
}

// Resolve an endpoint node id from its public selector (node:<id>), id, title,
// or canonical identity (e.g. "gRPC Svc.method", "grpc::Svc.method",
// "GET /users"). Returns the raw string if no node matches (samples may be
// keyed by a global gRPC id).
export function resolveEndpointId(store: KnowledgeStore, endpoint: string): string {
  const selector = normalizeNodeSelector(endpoint);
  const row = store.db
    .prepare("SELECT id FROM nodes WHERE node_type='endpoint' AND (id=? OR title=? OR identity_key=? OR id=? OR title=? OR identity_key=?) LIMIT 1")
    .get(endpoint, endpoint, endpoint, selector, selector, selector) as { id: string } | undefined;
  if (row?.id) return row.id;
  const grpc = resolveGrpcEndpoint(store, endpoint);
  return grpc.kind === "unique" ? grpc.nodeId : endpoint;
}

// Captured runtime responses for an endpoint, newest first (§P2 runtime channel).
export function endpointSamples(store: KnowledgeStore, endpoint: string): ResponseSample[] {
  const endpointId = resolveEndpointId(store, endpoint);
  const rows = store.db
    .prepare(
      "SELECT id, endpoint_key AS endpointKey, status, content_type AS contentType, sample, captured_at AS capturedAt FROM response_samples WHERE endpoint_id=? ORDER BY captured_at DESC",
    )
    .all(endpointId) as ResponseSample[];
  return rows;
}

// —— dead code: symbols nothing references (best-effort; DI/reflection/entry
// points inflate false positives → callers must treat as candidates) ——
export interface DeadCodeResult {
  /** Each candidate carries `fileImportedBy`: how many files import the file it
   * lives in. Zero is the strong case. A positive count means something pulls
   * the file in without calling this symbol — DI and decorator wiring look
   * exactly like that, and are the usual false positives here. */
  candidates: Array<ContextBrief & { fileImportedBy?: number }>;
  note: string;
  /** What the answer actually covers, so a filtered result is not mistaken for
   * a whole-graph one. */
  scope: { repo: string | null; path: string | null; branch: string | null };
  /** True when the limit cut the list — the rest exists, it just was not returned. */
  truncated: boolean;
  /** Total candidates in the selected scope, independent of page size. */
  candidateCount: number;
  /** Candidates after the final item on this page. */
  remainingCount: number;
  totalIsExact: boolean;
}

export interface DeadCodeOptions {
  limit?: number;
  /** Repo name or id. Without it the answer spans every indexed repo, which for
   * a multi-repo install is a list nobody can act on. */
  repo?: string;
  /** Repo-relative path prefix, e.g. "apps/promotion/src". */
  path?: string;
  branchId?: string;
  /** Exclusive stable cursor over filePath/startLine/nodeId. */
  after?: { filePath: string; startLine: number; nodeId: string };
}

export function deadCode(store: KnowledgeStore, options?: DeadCodeOptions): DeadCodeResult {
  const limit = options?.limit ?? 100;

  // A repo can be named or addressed by id; a name that matches nothing is an
  // empty result rather than a silent whole-graph scan.
  let repoId: string | null = null;
  let repoLabel: string | null = null;
  if (options?.repo) {
    const row = store.db
      .prepare("SELECT id, name FROM repos WHERE id=? OR name=? LIMIT 1")
      .get(options.repo, options.repo) as { id: string; name: string } | undefined;
    if (!row) {
      return {
        candidates: [],
        note: `no indexed repo matches "${options.repo}" — check \`penguin status\` for the indexed repo names.`,
        scope: { repo: options.repo, path: options.path ?? null, branch: options.branchId ?? null },
        truncated: false,
        candidateCount: 0,
        remainingCount: 0,
        totalIsExact: true,
      };
    }
    repoId = row.id;
    repoLabel = row.name;
  }

  // Scope to ONE branch's fresh symbols. Without this the candidate list mixes
  // every branch of every repo and, worse, counts superseded symbol_versions
  // rows: a symbol that moved keeps its stale row, that row has no inbound
  // edges, and it shows up as dead code forever.
  const branchId = options?.branchId
    ?? (repoId
      ? (store.db
          .prepare("SELECT id FROM branches WHERE repo_id=? AND status='live' ORDER BY last_indexed_at DESC LIMIT 1")
          .get(repoId) as { id: string } | undefined)?.id ?? null
      : null);

  const baseWhere: string[] = ["n.node_type='symbol'", "sv.status='fresh'"];
  const baseParams: unknown[] = [];
  if (repoId) { baseWhere.push("n.repo_id=?"); baseParams.push(repoId); }
  if (branchId) { baseWhere.push("sv.branch_id=?"); baseParams.push(branchId); }
  if (options?.path) {
    // Prefix match on the repo-relative path. LIKE would treat _ and % in a
    // real path as wildcards, so compare the prefix directly.
    baseWhere.push("substr(sv.file_path, 1, ?) = ?");
    baseParams.push(options.path.length, options.path);
  }
  const pageWhere = [...baseWhere];
  const pageParams = [...baseParams];
  if (options?.after) {
    pageWhere.push("(sv.file_path > ? OR (sv.file_path = ? AND (sv.start_line > ? OR (sv.start_line = ? AND n.id > ?))))");
    pageParams.push(options.after.filePath, options.after.filePath, options.after.startLine, options.after.startLine, options.after.nodeId);
  }

  const count = (store.db.prepare(
    `SELECT COUNT(DISTINCT n.id) AS count
       FROM nodes n
       JOIN symbol_versions sv ON sv.node_id = n.id
      WHERE ${baseWhere.join(" AND ")}
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst=n.id AND e.status='active'
                          AND e.edge_type IN ('calls','references','handles','tests'))`,
  ).get(...baseParams) as { count: number }).count;

  const rows = store.db.prepare(
    `SELECT DISTINCT n.id AS id, sv.file_path AS filePath, sv.start_line AS startLine, sv.end_line AS endLine
       FROM nodes n
       JOIN symbol_versions sv ON sv.node_id = n.id
      WHERE ${pageWhere.join(" AND ")}
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst=n.id AND e.status='active'
                          AND e.edge_type IN ('calls','references','handles','tests'))
      ORDER BY sv.file_path, sv.start_line, n.id
      LIMIT ?`,
  ).all(...pageParams, limit + 1) as Array<{ id: string; filePath: string | null; startLine: number | null; endLine: number | null }>;

  const truncated = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const remainingCount = !last ? 0 : (store.db.prepare(
    `SELECT COUNT(DISTINCT n.id) AS count
       FROM nodes n
       JOIN symbol_versions sv ON sv.node_id = n.id
      WHERE ${baseWhere.join(" AND ")}
        AND (sv.file_path > ? OR (sv.file_path = ? AND (sv.start_line > ? OR (sv.start_line = ? AND n.id > ?))))
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst=n.id AND e.status='active'
                          AND e.edge_type IN ('calls','references','handles','tests'))`,
  ).get(...baseParams, last.filePath ?? "", last.filePath ?? "", last.startLine ?? -1, last.startLine ?? -1, last.id) as { count: number }).count;
  const scopeNote = repoLabel || options?.path
    ? ` Scope: ${[repoLabel && `repo ${repoLabel}`, options?.path && `under ${options.path}`].filter(Boolean).join(", ")}.`
    : " Scope: every indexed repo — pass repo/path to get a list you can act on.";

  // Per-candidate evidence, not just a blanket disclaimer. A NestJS interceptor
  // wired by a decorator has no call edge, so it lands here — but its FILE is
  // imported by the two controllers that use it, and that is computable. A
  // reviewer found exactly that case presented as dead code with nothing to
  // distinguish it from a symbol nothing references at all.
  // A file node carries its repo-relative path as its TITLE; it has no
  // symbol_versions row, so joining through that table returned nothing and
  // every candidate looked equally unreferenced.
  const fileImportedBy = new Map(
    (store.db.prepare(`
      SELECT d.title AS filePath, COUNT(DISTINCT e.src) AS importers
        FROM edges e
        JOIN nodes d ON d.id = e.dst AND d.node_type = 'file'
       WHERE e.edge_type = 'imports' AND e.status = 'active'
         ${repoId ? "AND d.repo_id = ?" : ""}
       GROUP BY d.title
    `).all(...(repoId ? [repoId] : [])) as Array<{ filePath: string; importers: number }>)
      .map((row) => [row.filePath, row.importers] as const),
  );

  return {
    candidates: pageRows.map((r) => {
      const brief = nodeBrief(store, r.id);
      const importers = r.filePath ? fileImportedBy.get(r.filePath) ?? 0 : 0;
      return {
        nodeId: brief.nodeId,
        title: brief.title,
        nodeType: brief.nodeType,
        filePath: r.filePath ?? undefined,
        startLine: r.startLine ?? undefined,
        endLine: r.endLine ?? undefined,
        // Zero means nothing even imports the file — the strong case. A
        // positive count means something pulls this file in without calling
        // this symbol, which is what DI and decorator wiring look like.
        fileImportedBy: importers,
      };
    }),
    note: "no inbound calls/references/handles/tests — verify: DI, reflection, framework magic, dynamic import, and public entry points are false positives."
      + scopeNote
      + (truncated ? ` More than ${limit} candidates exist; raise limit to see the rest.` : ""),
    scope: { repo: repoLabel, path: options?.path ?? null, branch: branchId },
    truncated,
    candidateCount: count,
    remainingCount,
    totalIsExact: true,
  };
}

// —— serviceGraph: the system-level microservice map ("main graph") ——
// Nodes = repos (services). Edges = consumer→provider (a real cross-service call
// via a shared global endpoint, where BOTH ends are indexed). Endpoints that are
// invoked but whose provider/handler isn't indexed (no source) are NOT shown —
// they were dangling noise. This answers "how do the services relate" without a
// symbol focus.
type ServiceGraphOptions = {
  repo?: string;
  repoId?: string;
  includeDirectNeighbours?: boolean;
  revision?: RevisionContext;
  branchId?: string;
};

function resolveServiceRepoId(store: KnowledgeStore, options: ServiceGraphOptions): string | undefined {
  const selector = options.repo ?? options.repoId;
  if (!selector) return options.revision?.repoId;
  const ids = store.resolveRepoIds(selector);
  if (ids.length === 0) {
    throw new KnowledgeContractError(
      "REPOSITORY_NOT_FOUND",
      "no indexed repo matches " + selector,
      { repo: selector, remediation: "call index_status({\"mode\":\"detailed\"}) and choose an indexed repository" },
    );
  }
  if (ids.length > 1) {
    throw new KnowledgeContractError(
      "INVALID_ARGUMENT",
      "repository selector is ambiguous: " + selector,
      { repo: selector, candidates: ids, remediation: "specify the repository id" },
    );
  }
  if (options.revision?.repoId && options.revision.repoId !== ids[0]) {
    throw new KnowledgeContractError(
      "INVALID_ARGUMENT",
      "repository does not own the selected revision",
      { repo: ids[0], revisionRepoId: options.revision.repoId, remediation: "use a revision from the selected repository" },
    );
  }
  return ids[0];
}

function typedServiceIdentity(repoId: string): string {
  return "service:" + repoId;
}

export function serviceGraph(store: KnowledgeStore, options: ServiceGraphOptions = {}): GraphView {
  const selectedRepoId = resolveServiceRepoId(store, options);
  const requestedBranchId = options.branchId ?? options.revision?.branchId ?? null;
  if (options?.revision && !options.revision.snapshotId.startsWith("legacy:") && !isCurrentRevisionSnapshot(store, options.revision)) {
    const repos = store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[];
    const repoName = new Map(repos.map((r) => [r.id, r.name]));
    const pairs = snapshotEdgePairs(store, options.revision, { edgeTypes: ["handles", "invokes"], limit: 50_000 });
    const pairNodeIds = [...new Set(pairs.flatMap((edge) => [edge.src, edge.dst].filter((id): id is string => Boolean(id))))];
    const repoByNode = new Map<string, string>();
    for (let offset = 0; offset < pairNodeIds.length; offset += 2_000) {
      const chunk = pairNodeIds.slice(offset, offset + 2_000);
      const rows = store.db.prepare(
        `SELECT id,repo_id AS repoId FROM nodes WHERE id IN (${chunk.map(() => "?").join(",")}) AND repo_id IS NOT NULL`,
      ).all(...chunk) as Array<{ id: string; repoId: string }>;
      for (const row of rows) repoByNode.set(row.id, row.repoId);
    }
    const providers = new Map<string, Set<string>>();
    for (const edge of pairs.filter((e) => e.edgeType === "handles" && e.dst)) { const repo = repoByNode.get(edge.dst!); if (repo) (providers.get(edge.src) ?? providers.set(edge.src, new Set()).get(edge.src)!).add(repo); }
    const nodes = new Map<string, GraphView["nodes"][number]>(); const edges = new Map<string, GraphView["edges"][number]>();
    const use = (id: string) => { if (!nodes.has(id)) nodes.set(id, { nodeId: typedServiceIdentity(id), title: repoName.get(id) ?? id, nodeType: "service" }); };
    for (const edge of pairs.filter((e) => e.edgeType === "invokes" && e.dst)) { const consumer = repoByNode.get(edge.src); if (!consumer) continue; for (const provider of providers.get(edge.dst!) ?? []) if (provider !== consumer) { use(consumer); use(provider); const graphEvidence = graphEdgeEvidence({ edgeType: "invokes", method: edge.method, confidence: edge.confidence, provenance: edge.provenance, scope: "revision", branchId: options.revision.branchId }); edges.set(`${consumer}|${provider}`, { src: typedServiceIdentity(consumer), dst: typedServiceIdentity(provider), edgeType: "invokes", sourceType: "service_graph", revisionId: options.revision.snapshotId, graphEvidence }); } }
    for (const repo of repos) use(repo.id);
    const visible = selectedRepoId
      ? new Set([typedServiceIdentity(selectedRepoId), ...(options.includeDirectNeighbours === false ? [] : [...edges.values()].filter((edge) => edge.src === typedServiceIdentity(selectedRepoId) || edge.dst === typedServiceIdentity(selectedRepoId)).flatMap((edge) => [edge.src, edge.dst]))])
      : new Set([...nodes.values()].map((node) => node.nodeId));
    const visibleEdges = [...edges.values()].filter((edge) => visible.has(edge.src) && visible.has(edge.dst));
    const scope = { repoId: selectedRepoId ?? null, branchId: options.revision.branchId ?? null, revisionId: options.revision.snapshotId };
    return { focus: null, nodes: [...nodes.values()].filter((node) => visible.has(node.nodeId)), edges: visibleEdges, revision: options.revision, scope, evidence: buildEvidenceEnvelope(store, { repoId: selectedRepoId, branchId: options.revision.branchId, revision: options.revision, scope, completeness: "lower_bound", proofStatus: "not_proven", candidateCount: visibleEdges.length, returnedCount: visibleEdges.length, coverageGaps: visibleEdges.length ? ["service_graph_is_aggregated"] : ["service_edges_not_observed"] }) };
  }
  const repos = store.db.prepare("SELECT id, name FROM repos").all() as { id: string; name: string }[];
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const providers = store.db.prepare(
    "SELECT e.src AS endpoint, n.repo_id AS repo FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.edge_type='handles' AND e.status='active' AND n.repo_id IS NOT NULL",
  ).all() as { endpoint: string; repo: string }[];
  const consumers = store.db.prepare(
    "SELECT e.dst AS endpoint, n.repo_id AS repo, e.origin, e.method, e.confidence, e.provenance, e.branch_id AS branchId FROM edges e JOIN nodes n ON n.id=e.src WHERE e.edge_type='invokes' AND e.status='active' AND n.repo_id IS NOT NULL" + (requestedBranchId ? " AND (e.branch_id=? OR e.branch_id IS NULL)" : ""),
  ).all(...(requestedBranchId ? [requestedBranchId] : [])) as Array<{ endpoint: string; repo: string; origin: string | null; method: string | null; confidence: number | null; provenance: unknown; branchId: string | null }>;

  const provBy = new Map<string, Set<string>>();
  for (const p of providers) { (provBy.get(p.endpoint) ?? provBy.set(p.endpoint, new Set()).get(p.endpoint)!).add(p.repo); }

  const nodes = new Map<string, GraphView["nodes"][number]>();
  const useRepo = (id: string) => { if (!nodes.has(id)) nodes.set(id, { nodeId: typedServiceIdentity(id), title: repoName.get(id) ?? id, nodeType: "service" }); };
  const edgeSet = new Map<string, GraphView["edges"][number]>();
  const addEdge = (src: string, dst: string, t: string, evidence?: GraphEdgeEvidenceEnvelope, revisionId?: string | null) => { const k = `${src}|${dst}|${t}`; if (!edgeSet.has(k)) edgeSet.set(k, { src: typedServiceIdentity(src), dst: typedServiceIdentity(dst), edgeType: t, sourceType: "service_graph", revisionId: revisionId ?? null, ...(evidence ? { graphEvidence: evidence } : {}) }); };

  for (const c of consumers) {
    useRepo(c.repo);
    const provs = provBy.get(c.endpoint);
    if (provs && provs.size) {
      for (const p of provs) if (p !== c.repo) { useRepo(p); addEdge(c.repo, p, "invokes", graphEdgeEvidence({ edgeType: "invokes", origin: c.origin, method: c.method, confidence: c.confidence, provenance: c.provenance, scope: c.branchId ? "revision" : "environment", branchId: c.branchId }), c.branchId ?? requestedBranchId); }
    }
    // else: the endpoint has no indexed handler (no source) → skip it. We don't
    // surface "invoked but unimplemented-in-index" endpoints as standalone nodes;
    // they were graph noise (dangling red nodes with nothing behind them).
  }
  // always include every repo as a node (even isolated ones)
  for (const r of repos) useRepo(r.id);

  // ── Package dependency edges: npm-package → npm-package (depends_on) ──
  // Resolves each @snsoft/* dependency to a provider repo, creating cross-repo
  // links for the service graph (e.g. auth depends_on @snsoft/player-grpc →
  // link auth repo → flyover repo).
  const pkgDeps = store.db.prepare(
    `SELECT sn.repo_id AS consumerRepo, dn.repo_id AS providerRepo,
            e.origin, e.method, e.confidence, e.provenance, e.branch_id AS branchId
     FROM edges e
     JOIN nodes sn ON sn.id = e.src
     JOIN nodes dn ON dn.id = e.dst
     WHERE e.edge_type='depends_on' AND e.status='active'
       AND sn.repo_id IS NOT NULL AND dn.repo_id IS NOT NULL`,
  ).all() as Array<{ consumerRepo: string; providerRepo: string; origin: string | null; method: string | null; confidence: number | null; provenance: unknown; branchId: string | null }>;
  for (const d of pkgDeps) {
    if (d.consumerRepo !== d.providerRepo) {
      useRepo(d.consumerRepo);
      useRepo(d.providerRepo);
      addEdge(d.consumerRepo, d.providerRepo, "depends_on", graphEdgeEvidence({ edgeType: "depends_on", origin: d.origin, method: d.method, confidence: d.confidence, provenance: d.provenance, scope: d.branchId ? "revision" : "environment", branchId: d.branchId }), d.branchId ?? requestedBranchId);
    }
  }

  const visible = selectedRepoId
    ? new Set([
        typedServiceIdentity(selectedRepoId),
        ...(options.includeDirectNeighbours === false
          ? []
          : [...edgeSet.values()]
              .filter((edge) => edge.src === typedServiceIdentity(selectedRepoId) || edge.dst === typedServiceIdentity(selectedRepoId))
              .flatMap((edge) => [edge.src, edge.dst])),
      ])
    : new Set([...nodes.values()].map((node) => node.nodeId));
  const visibleEdges = [...edgeSet.values()].filter((edge) => visible.has(edge.src) && visible.has(edge.dst));
  const scope = {
    repoId: selectedRepoId ?? null,
    branchId: requestedBranchId,
    revisionId: options.revision?.snapshotId ?? requestedBranchId,
  };
  return {
    focus: null,
    nodes: [...nodes.values()].filter((node) => visible.has(node.nodeId)),
    edges: visibleEdges,
    revision: options.revision ?? null,
    scope,
    evidence: buildEvidenceEnvelope(store, {
      repoId: selectedRepoId,
      branchId: requestedBranchId ?? undefined,
      revision: options.revision,
      scope,
      completeness: "lower_bound",
      proofStatus: "not_proven",
      candidateCount: visibleEdges.length,
      returnedCount: visibleEdges.length,
      coverageGaps: visibleEdges.length ? ["service_graph_is_aggregated"] : ["service_edges_not_observed"],
    }),
  };
}

export interface ServiceContextResult {
  target: {
    nodeId: string;
    nodeType: "service";
    repoId: string;
    identityKey: string;
    locator: { filePath: null; startLine: null };
  };
  graph: GraphView;
}

/** Resolve a typed service identity and return its scoped graph context. */
export function serviceContext(store: KnowledgeStore, target: string, options: ServiceGraphOptions = {}): ServiceContextResult {
  const selector = target.startsWith("service:") ? target.slice("service:".length) : target;
  const repoId = resolveServiceRepoId(store, { ...options, repo: selector });
  if (!repoId) throw new KnowledgeContractError("REPOSITORY_NOT_FOUND", "service target has no repository", { target });
  return {
    target: {
      nodeId: typedServiceIdentity(repoId),
      nodeType: "service",
      repoId,
      identityKey: typedServiceIdentity(repoId),
      locator: { filePath: null, startLine: null },
    },
    graph: serviceGraph(store, { ...options, repo: repoId }),
  };
}

/** Bounded path continuation over stable service identities. */
export function servicePath(
  store: KnowledgeStore,
  from: string,
  to: string,
  options: Pick<ServiceGraphOptions, "revision" | "branchId"> = {},
): GraphResult {
  // A path may cross repositories. Resolve both typed identities independently;
  // a revision belongs to the graph snapshot's owner, not to every service
  // that appears as a neighbour in that graph.
  const fromRepo = resolveServiceRepoId(store, { repo: from.startsWith("service:") ? from.slice("service:".length) : from });
  const toRepo = resolveServiceRepoId(store, { repo: to.startsWith("service:") ? to.slice("service:".length) : to });
  if (!fromRepo || !toRepo) return { mode: "path", nodes: [], candidateCount: 0, totalIsExact: true, completeness: "complete", coverageGaps: ["service_target_not_found"] };
  const graph = serviceGraph(store, { ...options, repo: fromRepo });
  const start = typedServiceIdentity(fromRepo);
  const goal = typedServiceIdentity(toRepo);
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const nextById = new Map<string, string[]>();
  for (const edge of graph.edges) nextById.set(edge.src, [...(nextById.get(edge.src) ?? []), edge.dst]);
  const queue = [start];
  const previous = new Map<string, string>();
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === goal) break;
    for (const next of nextById.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!seen.has(goal)) return { mode: "path", nodes: [], candidateCount: 0, totalIsExact: true, completeness: "complete", coverageGaps: ["service_path_not_found"], revision: options.revision };
  const ids: string[] = [];
  for (let current: string | undefined = goal; current; current = previous.get(current)) ids.unshift(current);
  const nodes = ids.map((id) => nodeById.get(id)).filter((node): node is GraphView["nodes"][number] => Boolean(node)).map((node) => ({ nodeId: node.nodeId, title: node.title, nodeType: node.nodeType }));
  return { mode: "path", nodes, candidateCount: nodes.length, totalIsExact: true, completeness: "complete", coverageGaps: [], revision: options.revision, evidence: graph.evidence };
}
