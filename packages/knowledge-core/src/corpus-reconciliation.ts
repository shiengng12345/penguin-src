import { canonicalGrpcIdentity } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";

export const CORPUS_RECONCILIATION_VERSION = "1";

export type CorpusLayer = "files" | "symbols" | "edges" | "endpoints" | "coverage" | "semantic";

export interface CorpusCountVector {
  files?: number | null;
  symbols?: number | null;
  edges?: number | null;
  endpoints?: number | null;
  coverage?: number | null;
  semantic?: number | null;
}

export interface CorpusScope {
  repoId: string;
  branchId: string;
  snapshotId?: string | null;
}

export interface CorpusSourceTruth {
  rootPath?: string;
  gitCommit?: string | null;
  worktreeState?: "clean" | "dirty" | "unknown" | "not_applicable";
  worktreeFingerprint?: string | null;
  discoveredFiles?: number;
  admittedFiles?: number;
  excludedFiles?: number;
  failedFiles?: number;
  staleFiles?: number;
  parserEligibleFiles?: number;
  endpointKeys?: string[];
  endpointOccurrences?: number;
}

export interface CorpusParserTruth {
  counts?: CorpusCountVector;
  endpointKeys?: string[];
  reportId?: string;
}

export interface CorpusTransportTruth {
  counts?: CorpusCountVector;
  endpointKeys?: string[];
  status?: string;
  statusPath?: string;
}

export interface CorpusPersistedTruth {
  counts: Required<CorpusCountVector>;
  coverage: {
    discovered: number;
    admitted: number;
    excluded: number;
    failed: number;
    stale: number;
  };
  filesIndex: number;
  parserFiles: number;
  readySnapshot: boolean;
  snapshotId: string | null;
  endpointKeys: string[];
  endpointAliasCanonical: Record<string, string>;
  endpointExclusions: Array<{
    discoveryKey: string;
    reasonCode: string;
    filePath: string;
    startLine: number;
    candidateEndpointIds: string[];
  }>;
  semantic: {
    chunks: number;
    ready: number;
    pending: number;
    failed: number;
  };
  databaseInstanceId: string | null;
  lastIndexedCommit: string | null;
  headCommit: string | null;
  indexedWorktreeState: string;
  indexedWorktreeFingerprint: string | null;
  snapshotCommit: string | null;
  snapshotWorktreeFingerprint: string | null;
}

export interface CorpusLayerReconciliation {
  layer: CorpusLayer;
  source: number | null;
  parser: number | null;
  persisted: number;
  cli: number | null;
  mcp: number | null;
  tauri: number | null;
  comparable: boolean;
  matched: boolean;
  differences: Array<{
    left: "source" | "parser" | "persisted" | "cli" | "mcp" | "tauri";
    right: "source" | "parser" | "persisted" | "cli" | "mcp" | "tauri";
    leftValue: number;
    rightValue: number;
  }>;
}

export interface CorpusCanonicalCount {
  discovered: number | null;
  persisted: number | null;
  queryable: number | null;
  excluded: number | null;
  delta: number | null;
  equation: string;
}

export interface CorpusCanonicalProjection {
  files: CorpusCanonicalCount;
  symbols: CorpusCanonicalCount;
  edges: CorpusCanonicalCount;
  endpoints: CorpusCanonicalCount;
  coverage: CorpusCanonicalCount;
  semantic: CorpusCanonicalCount;
  exclusions: {
    endpoints: CorpusPersistedTruth["endpointExclusions"];
  };
}

export interface CorpusEndpointReconciliation {
  source: string[] | null;
  parser: string[] | null;
  persisted: string[];
  cli: string[] | null;
  mcp: string[] | null;
  tauri: string[] | null;
  missingFromPersisted: string[];
  unexpectedInPersisted: string[];
  differences: string[];
}

export interface CorpusReconciliationResult {
  version: string;
  scope: CorpusScope;
  persisted: CorpusPersistedTruth;
  layers: Record<CorpusLayer, CorpusLayerReconciliation>;
  endpoints: CorpusEndpointReconciliation;
  canonical: CorpusCanonicalProjection;
  identity: {
    requestedSnapshotId: string | null;
    actualSnapshotId: string | null;
    readySnapshot: boolean;
    databaseInstanceId: string | null;
    lastIndexedCommit: string | null;
  };
  gaps: string[];
  status: "passed" | "failed" | "incomplete";
}

type NamedCounts = Record<"source" | "parser" | "persisted" | "cli" | "mcp" | "tauri", number | null>;

const CANONICAL_COUNT_EQUATION = "discovered = queryable + excluded + delta";

function firstKnown(...values: Array<number | null | undefined>): number | null {
  const value = values.find((candidate) => candidate != null);
  return value == null ? null : value;
}

function sourceFileExclusions(source: CorpusSourceTruth | undefined): number | null {
  if (!source) return null;
  const values = [source.excludedFiles, source.failedFiles, source.staleFiles].filter((value): value is number => value != null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function canonicalCount(
  discovered: number | null,
  persisted: number | null,
  queryable: number | null,
  excluded: number | null,
): CorpusCanonicalCount {
  const delta = discovered != null && queryable != null && excluded != null
    ? discovered - queryable - excluded
    : null;
  return { discovered, persisted, queryable, excluded, delta, equation: CANONICAL_COUNT_EQUATION };
}

function scalar(db: KnowledgeStore["db"], sql: string, ...parameters: unknown[]): number {
  const row = db.prepare(sql).get(...parameters) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function listStrings(db: KnowledgeStore["db"], sql: string, ...parameters: unknown[]): string[] {
  return (db.prepare(sql).all(...parameters) as Array<{ value: string }>).map((row) => row.value).filter(Boolean).sort();
}

function endpointAliasCanonicalMap(db: KnowledgeStore["db"], repoId: string): Record<string, string> {
  const rows = db.prepare(`
    SELECT n.title AS canonical, a.alias_key AS alias
      FROM endpoint_memberships em
      JOIN nodes n ON n.id=em.endpoint_id
      LEFT JOIN endpoint_aliases a ON a.endpoint_id=n.id
     WHERE em.repo_id=?
       AND em.role IN ('provider','declaration')
       AND n.node_type='endpoint'
  `).all(repoId) as Array<{ canonical: string; alias: string | null }>;
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const alias of [row.canonical, row.alias]) {
      if (!alias) continue;
      const values = candidates.get(alias) ?? new Set<string>();
      values.add(row.canonical);
      candidates.set(alias, values);
    }
  }
  return Object.fromEntries(
    [...candidates.entries()]
      .filter(([, values]) => values.size === 1)
      .map(([alias, values]) => [alias, [...values][0]]),
  );
}

function uniqueSorted(values: readonly string[] | null | undefined): string[] | null {
  return values == null ? null : [...new Set(values)].filter(Boolean).sort();
}

function grpcComparisonIdentity(value: string): string | null {
  if (value.startsWith("grpc::")) return value.replace(/\.([^.]+)$/, (_match, method) => `.${String(method).toLowerCase()}`);
  const match = value.match(/^(?:gRPC\s+)?(.+)\.([^.]+)$/i);
  if (!match) return null;
  try { return canonicalGrpcIdentity({ service: match[1], method: match[2] }); }
  catch { return null; }
}

function excludedEndpointKeys(
  sourceKeys: readonly string[] | undefined,
  exclusions: CorpusPersistedTruth["endpointExclusions"],
): Set<string> {
  const excludedIdentities = new Set(exclusions.map((item) => grpcComparisonIdentity(item.discoveryKey)).filter(Boolean));
  return new Set((sourceKeys ?? []).filter((key) => {
    const identity = grpcComparisonIdentity(key);
    return identity ? excludedIdentities.has(identity) : false;
  }));
}

function sourceCounts(
  source: CorpusSourceTruth | undefined,
  exclusions: CorpusPersistedTruth["endpointExclusions"],
  aliasCanonical: Record<string, string> = {},
): CorpusCountVector {
  if (!source) return {};
  // Endpoint transport reconciliation canonicalizes aliases before comparing
  // sets. Apply the same projection to layer counts; otherwise a source that
  // reports both `gRPC Pkg.Svc.Method` and `Pkg.Svc.Method` is counted twice
  // even though both spellings identify one persisted endpoint.
  const sourceEndpoints = source.endpointKeys
    ? new Set(source.endpointKeys.map((key) => aliasCanonical[key] ?? key))
    : null;
  const excluded = sourceEndpoints ? excludedEndpointKeys([...sourceEndpoints], exclusions) : new Set<string>();
  return {
    files: source.admittedFiles ?? null,
    endpoints: sourceEndpoints ? sourceEndpoints.size - excluded.size : null,
    coverage: source.admittedFiles ?? null,
  };
}

function endpointVector(value: CorpusParserTruth | CorpusTransportTruth | undefined): string[] | null {
  return uniqueSorted(value?.endpointKeys);
}

/** Read only the current repository/branch/snapshot projection from SQLite. */
export function readPersistedCorpusTruth(
  store: KnowledgeStore,
  scope: CorpusScope,
): CorpusPersistedTruth {
  const branch = store.db.prepare(
    `SELECT current_snapshot_id AS snapshotId,
            last_indexed_commit AS lastIndexedCommit,
            head_commit AS headCommit,
            indexed_worktree_state AS indexedWorktreeState,
            indexed_worktree_fingerprint AS indexedWorktreeFingerprint
       FROM branches WHERE id=? AND repo_id=?`,
  ).get(scope.branchId, scope.repoId) as {
    snapshotId?: string | null;
    lastIndexedCommit?: string | null;
    headCommit?: string | null;
    indexedWorktreeState?: string;
    indexedWorktreeFingerprint?: string | null;
  } | undefined;
  const snapshotId = scope.snapshotId ?? branch?.snapshotId ?? null;
  const snapshotRevision = snapshotId
    ? store.db.prepare(
        "SELECT commit_sha AS snapshotCommit, worktree_fingerprint AS snapshotWorktreeFingerprint FROM revision_snapshots WHERE id=? AND repo_id=?",
      ).get(snapshotId, scope.repoId) as { snapshotCommit?: string | null; snapshotWorktreeFingerprint?: string | null } | undefined
    : undefined;
  const coverage = {
    discovered: scalar(store.db, "SELECT COUNT(*) AS n FROM coverage_records WHERE repo_id=?", scope.repoId),
    admitted: scalar(store.db, "SELECT COUNT(*) AS n FROM coverage_records WHERE repo_id=? AND coverage_status='admitted'", scope.repoId),
    excluded: scalar(store.db, "SELECT COUNT(*) AS n FROM coverage_records WHERE repo_id=? AND coverage_status='excluded'", scope.repoId),
    failed: scalar(store.db, "SELECT COUNT(*) AS n FROM coverage_records WHERE repo_id=? AND coverage_status='failed'", scope.repoId),
    stale: scalar(store.db, "SELECT COUNT(*) AS n FROM coverage_records WHERE repo_id=? AND coverage_status='stale'", scope.repoId),
  };
  const filesIndex = scalar(store.db, "SELECT COUNT(*) AS n FROM files_index WHERE repo_id=? AND branch_id=? AND status <> 'deleted'", scope.repoId, scope.branchId);
  const parserFiles = scalar(store.db, "SELECT COUNT(*) AS n FROM file_facts WHERE repo_id=?", scope.repoId);
  const symbols = scalar(store.db, "SELECT COUNT(DISTINCT node_id) AS n FROM symbol_versions WHERE branch_id=? AND status='fresh'", scope.branchId);
  const edges = scalar(store.db, `
    SELECT COUNT(*) AS n
      FROM edges e
     WHERE e.status='active'
       AND (
         e.branch_id=?
         OR (e.branch_id IS NULL AND e.origin='parser'
             AND json_extract(e.provenance, '$.repo')=?)
       )
  `, scope.branchId, scope.repoId);
  const endpointKeys = listStrings(store.db, `
    SELECT DISTINCT n.title AS value
      FROM nodes n
      JOIN endpoint_memberships em ON em.endpoint_id=n.id
     WHERE em.repo_id=?
       AND em.role IN ('provider','declaration')
       AND n.node_type='endpoint'
  `, scope.repoId);
  const endpointAliasCanonical = endpointAliasCanonicalMap(store.db, scope.repoId);
  const endpointExclusions = snapshotId
    ? (store.db.prepare(`
        SELECT raw_target AS discoveryKey, reason_code AS reasonCode,
               file_path AS filePath, start_line AS startLine, reason
          FROM unresolved_reference_items
         WHERE repo_id=? AND branch_id=? AND revision_id=?
           AND reason_code IN ('ambiguous-grpc-handler','ambiguous-grpc-declaration')
         ORDER BY file_path,start_line,raw_target
      `).all(scope.repoId, scope.branchId, snapshotId) as Array<{
        discoveryKey: string;
        reasonCode: string;
        filePath: string;
        startLine: number;
        reason: string | null;
      }>).map((row) => {
        let candidateEndpointIds: string[] = [];
        try {
          const parsed = JSON.parse(row.reason ?? "{}") as { candidateEndpointIds?: unknown };
          if (Array.isArray(parsed.candidateEndpointIds)) {
            candidateEndpointIds = parsed.candidateEndpointIds.filter((value): value is string => typeof value === "string").sort();
          }
        } catch { /* malformed legacy evidence remains a named exclusion with no candidates */ }
        return {
          discoveryKey: row.discoveryKey,
          reasonCode: row.reasonCode,
          filePath: row.filePath,
          startLine: row.startLine,
          candidateEndpointIds,
        };
      })
    : [];
  const readySnapshot = snapshotId
    ? scalar(store.db, "SELECT COUNT(*) AS n FROM revision_snapshots WHERE id=? AND repo_id=? AND state='ready'", snapshotId, scope.repoId) === 1
    : false;
  const chunks = snapshotId
    ? scalar(store.db, "SELECT COUNT(*) AS n FROM semantic_chunks WHERE snapshot_id=? AND repo_id=?", snapshotId, scope.repoId)
    : 0;
  const ready = snapshotId
    ? scalar(store.db, `
        SELECT COUNT(*) AS n
          FROM semantic_embedding_refs r
          JOIN semantic_chunks c ON c.id=r.chunk_id
         WHERE c.snapshot_id=? AND c.repo_id=? AND r.status='ready'
      `, snapshotId, scope.repoId)
    : 0;
  const pending = snapshotId
    ? scalar(store.db, `
        SELECT COUNT(*) AS n
          FROM semantic_embedding_refs r
          JOIN semantic_chunks c ON c.id=r.chunk_id
         WHERE c.snapshot_id=? AND c.repo_id=? AND r.status IN ('pending','running')
      `, snapshotId, scope.repoId)
    : 0;
  const failed = snapshotId
    ? scalar(store.db, `
        SELECT COUNT(*) AS n
          FROM semantic_embedding_refs r
          JOIN semantic_chunks c ON c.id=r.chunk_id
         WHERE c.snapshot_id=? AND c.repo_id=? AND r.status='failed'
      `, snapshotId, scope.repoId)
    : 0;
  const instance = store.db.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get() as { value?: string } | undefined;
  return {
    counts: {
      files: snapshotId ? scalar(store.db, "SELECT COUNT(*) AS n FROM effective_snapshot_sources WHERE snapshot_id=?", snapshotId) : filesIndex,
      symbols,
      edges,
      endpoints: endpointKeys.length,
      coverage: coverage.admitted,
      semantic: chunks,
    },
    coverage,
    filesIndex,
    parserFiles,
    readySnapshot,
    snapshotId,
    endpointKeys,
    endpointAliasCanonical,
    endpointExclusions,
    semantic: { chunks, ready, pending, failed },
    databaseInstanceId: instance?.value ?? null,
    lastIndexedCommit: branch?.lastIndexedCommit ?? null,
    headCommit: branch?.headCommit ?? null,
    indexedWorktreeState: branch?.indexedWorktreeState ?? "unknown",
    indexedWorktreeFingerprint: branch?.indexedWorktreeFingerprint ?? null,
    snapshotCommit: snapshotRevision?.snapshotCommit ?? null,
    snapshotWorktreeFingerprint: snapshotRevision?.snapshotWorktreeFingerprint ?? null,
  };
}

function reconcileLayer(
  layer: CorpusLayer,
  values: NamedCounts,
): CorpusLayerReconciliation {
  const differences: CorpusLayerReconciliation["differences"] = [];
  const present = (Object.entries(values) as Array<[keyof NamedCounts, number | null]>)
    .filter((entry): entry is [keyof NamedCounts, number] => entry[1] !== null);
  for (let leftIndex = 0; leftIndex < present.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < present.length; rightIndex += 1) {
      const [left, leftValue] = present[leftIndex];
      const [right, rightValue] = present[rightIndex];
      if (leftValue !== rightValue) differences.push({ left, right, leftValue, rightValue });
    }
  }
  return {
    layer,
    source: values.source,
    parser: values.parser,
    persisted: values.persisted ?? 0,
    cli: values.cli,
    mcp: values.mcp,
    tauri: values.tauri,
    comparable: present.length >= 2,
    matched: present.length < 2 || differences.length === 0,
    differences,
  };
}

function reconcileEndpoints(
  source: string[] | null,
  parser: string[] | null,
  persisted: string[],
  cli: string[] | null,
  mcp: string[] | null,
  tauri: string[] | null,
  aliasCanonical: Record<string, string>,
  exclusions: CorpusPersistedTruth["endpointExclusions"],
): CorpusEndpointReconciliation {
  const canonicalize = (values: string[] | null): string[] | null => values
    ? [...new Set(values.map((value) => aliasCanonical[value] ?? value))].sort()
    : null;
  source = canonicalize(source);
  parser = canonicalize(parser);
  cli = canonicalize(cli);
  mcp = canonicalize(mcp);
  tauri = canonicalize(tauri);
  const expected = source ?? parser;
  const persistedSet = new Set(persisted);
  const expectedSet = expected ? new Set(expected) : null;
  const excludedKeys = expected ? excludedEndpointKeys(expected, exclusions) : new Set<string>();
  const missingFromPersisted = expectedSet
    ? [...expectedSet].filter((key) => !persistedSet.has(key) && !excludedKeys.has(key)).sort()
    : [];
  const unexpectedInPersisted = expectedSet
    ? [...persistedSet].filter((key) => !expectedSet.has(key)).sort()
    : [];
  const differences: string[] = [];
  const compare = (name: string, value: string[] | null) => {
    if (!value) return;
    if (value.length !== persisted.length || value.some((key, index) => key !== persisted[index])) {
      differences.push(`${name}_endpoint_set_diff`);
    }
  };
  // Source discovery is reconciled against queryable endpoints plus typed,
  // revision-scoped exclusions. A known ambiguity is not publication loss.
  if (source && (missingFromPersisted.length > 0 || unexpectedInPersisted.length > 0)) {
    differences.push("source_endpoint_set_diff");
  }
  compare("parser", parser);
  compare("cli", cli);
  compare("mcp", mcp);
  compare("tauri", tauri);
  if (missingFromPersisted.length > 0) differences.push("endpoint_missing_from_persisted");
  if (unexpectedInPersisted.length > 0) differences.push("endpoint_unexpected_in_persisted");
  return {
    source,
    parser,
    persisted,
    cli,
    mcp,
    tauri,
    missingFromPersisted,
    unexpectedInPersisted,
    differences: [...new Set(differences)].sort(),
  };
}

function canonicalProjection(
  input: {
    source?: CorpusSourceTruth;
    parser?: CorpusParserTruth;
    cli?: CorpusTransportTruth;
    mcp?: CorpusTransportTruth;
    tauri?: CorpusTransportTruth;
  },
  persisted: CorpusPersistedTruth,
  endpoints: CorpusEndpointReconciliation,
): CorpusCanonicalProjection {
  const transportDiscovery = (layer: CorpusLayer): number | null => firstKnown(
    input.parser?.counts?.[layer],
    input.cli?.counts?.[layer],
    input.mcp?.counts?.[layer],
    input.tauri?.counts?.[layer],
  );
  const endpointDiscovery = endpoints.source?.length
    ?? endpoints.parser?.length
    ?? endpoints.cli?.length
    ?? endpoints.mcp?.length
    ?? endpoints.tauri?.length
    ?? null;
  const endpointExcluded = input.source?.endpointKeys
    ? excludedEndpointKeys(input.source.endpointKeys, persisted.endpointExclusions).size
    : endpointDiscovery == null ? null : 0;
  const persistedFiles = persisted.counts.files;
  const persistedSymbols = persisted.counts.symbols;
  const persistedEdges = persisted.counts.edges;
  const persistedEndpoints = persisted.counts.endpoints;
  const persistedCoverage = persisted.coverage.admitted;
  const persistedSemantic = persisted.semantic.chunks;
  const coverageExcluded = persisted.coverage.excluded + persisted.coverage.failed + persisted.coverage.stale;
  return {
    files: canonicalCount(
      firstKnown(input.source?.discoveredFiles, transportDiscovery("files")),
      persistedFiles,
      persistedFiles,
      sourceFileExclusions(input.source),
    ),
    symbols: canonicalCount(
      transportDiscovery("symbols"),
      persistedSymbols,
      persistedSymbols,
      null,
    ),
    edges: canonicalCount(
      transportDiscovery("edges"),
      persistedEdges,
      persistedEdges,
      null,
    ),
    endpoints: canonicalCount(
      endpointDiscovery,
      persistedEndpoints,
      persistedEndpoints,
      endpointExcluded,
    ),
    coverage: canonicalCount(
      firstKnown(input.source?.discoveredFiles, persisted.coverage.discovered),
      persistedCoverage,
      persistedCoverage,
      input.source ? sourceFileExclusions(input.source) : coverageExcluded,
    ),
    semantic: canonicalCount(
      persistedSemantic,
      persistedSemantic,
      persisted.semantic.ready,
      persisted.semantic.failed,
    ),
    exclusions: {
      endpoints: persisted.endpointExclusions,
    },
  };
}

/**
 * Compare all available truth layers without silently filling missing values.
 * `null` means a transport/parser did not provide that dimension; it is
 * reported as incomplete rather than treated as zero.
 */
export function reconcileCorpus(input: {
  store: KnowledgeStore;
  scope: CorpusScope;
  source?: CorpusSourceTruth;
  parser?: CorpusParserTruth;
  cli?: CorpusTransportTruth;
  mcp?: CorpusTransportTruth;
  tauri?: CorpusTransportTruth;
}): CorpusReconciliationResult {
  const persisted = readPersistedCorpusTruth(input.store, input.scope);
  const source = sourceCounts(input.source, persisted.endpointExclusions, persisted.endpointAliasCanonical);
  const parser = input.parser?.counts ?? {};
  const cli = input.cli?.counts ?? {};
  const mcp = input.mcp?.counts ?? {};
  const tauri = input.tauri?.counts ?? {};
  const layerNames: CorpusLayer[] = ["files", "symbols", "edges", "endpoints", "coverage", "semantic"];
  const layers = Object.fromEntries(layerNames.map((layer) => [layer, reconcileLayer(layer, {
    source: source[layer] ?? null,
    parser: parser[layer] ?? null,
    persisted: persisted.counts[layer],
    cli: cli[layer] ?? null,
    mcp: mcp[layer] ?? null,
    tauri: tauri[layer] ?? null,
  })])) as Record<CorpusLayer, CorpusLayerReconciliation>;
  const endpoints = reconcileEndpoints(
    uniqueSorted(input.source?.endpointKeys),
    uniqueSorted(input.parser?.endpointKeys),
    persisted.endpointKeys,
    uniqueSorted(input.cli?.endpointKeys),
    uniqueSorted(input.mcp?.endpointKeys),
    uniqueSorted(input.tauri?.endpointKeys),
    persisted.endpointAliasCanonical,
    persisted.endpointExclusions,
  );
  const canonical = canonicalProjection(input, persisted, endpoints);
  const gaps: string[] = [];
  for (const layer of layerNames) {
    for (const difference of layers[layer].differences) {
      gaps.push(`${layer}:${difference.left}_vs_${difference.right}`);
    }
  }
  gaps.push(...endpoints.differences.map((difference) => `endpoints:${difference}`));
  if (!persisted.readySnapshot) gaps.push("snapshot:not_ready");
  if (input.scope.snapshotId && persisted.snapshotId !== input.scope.snapshotId) gaps.push("snapshot:scope_mismatch");
  if (!persisted.databaseInstanceId) gaps.push("identity:database_instance_id_missing");
  if (input.source?.gitCommit) {
    if (input.source.worktreeState === "dirty") {
      if (
        persisted.headCommit !== input.source.gitCommit
        || persisted.snapshotCommit !== input.source.gitCommit
        || persisted.indexedWorktreeState !== "dirty"
        || !input.source.worktreeFingerprint
        || persisted.indexedWorktreeFingerprint !== input.source.worktreeFingerprint
        || persisted.snapshotWorktreeFingerprint !== input.source.worktreeFingerprint
      ) {
        gaps.push("revision:indexed_worktree_vs_source_worktree");
      }
    } else if (
      persisted.lastIndexedCommit !== input.source.gitCommit
      || persisted.snapshotCommit !== input.source.gitCommit
    ) {
      gaps.push("revision:last_indexed_commit_vs_source_head");
    }
  }
  const hasComparableSource = Boolean(input.source);
  const hasComparableTransport = Boolean(input.cli || input.mcp || input.tauri);
  const status = gaps.length > 0
    ? "failed"
    : hasComparableSource || hasComparableTransport ? "passed" : "incomplete";
  return {
    version: CORPUS_RECONCILIATION_VERSION,
    scope: input.scope,
    persisted,
    layers,
    endpoints,
    canonical,
    identity: {
      requestedSnapshotId: input.scope.snapshotId ?? null,
      actualSnapshotId: persisted.snapshotId,
      readySnapshot: persisted.readySnapshot,
      databaseInstanceId: persisted.databaseInstanceId,
      lastIndexedCommit: persisted.lastIndexedCommit,
    },
    gaps: [...new Set(gaps)].sort(),
    status,
  };
}
