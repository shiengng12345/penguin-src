import type { KnowledgeStore } from "./store.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";

/**
 * Versioned, semantically stable projection of one published repository
 * revision. SQLite row ids, timestamps, job ids, and the database instance id
 * are deliberately excluded from the digest; they describe a process or a
 * database copy, not the indexed corpus. Every other field in this projection
 * is an explicit part of the determinism contract.
 */
export const CORPUS_EXPORT_VERSION = 1 as const;

export const CORPUS_EXPORT_VOLATILE_FIELDS = [
  "internal row ids and UUID primary keys",
  "created_at, updated_at, indexed_at, published_at, last_accessed_at",
  "database_instance_id",
  "job ids, status/control paths, heartbeats, retry counters, execution times",
] as const;

export interface CanonicalCorpusExport {
  formatVersion: typeof CORPUS_EXPORT_VERSION;
  scope: {
    repository: { name: string; rootPath: string; remoteUrl: string | null };
    branch: { name: string };
    snapshot: {
      commitSha: string | null;
      worktreeFingerprint: string | null;
      parserVersion: string;
      resolverVersion: string;
      schemaVersion: number;
      state: string;
    };
  };
  stable: {
    gitCommits: unknown[];
    coverage: unknown[];
    files: unknown[];
    sourceFacts: unknown[];
    fileFacts: unknown[];
    symbols: unknown[];
    nodes: unknown[];
    edges: unknown[];
    endpoints: unknown[];
    resolutionSets: unknown[];
    semantic: unknown[];
  };
  volatileFields: readonly string[];
  digest: string;
}

type Row = Record<string, unknown>;

function rowValue<T>(row: Row | undefined, key: string, fallback: T): T {
  return row && row[key] !== undefined ? row[key] as T : fallback;
}

function tableExists(store: KnowledgeStore, name: string): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function rows(store: KnowledgeStore, sql: string, ...params: unknown[]): Row[] {
  return store.db.prepare(sql).all(...params) as Row[];
}

function sorted(values: unknown[]): unknown[] {
  return values.slice().sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function stableNodeKey(row: Row, repoId: string, repoKey: string): string {
  const identity = String(row.identity_key ?? row.id ?? "").replaceAll(repoId, repoKey);
  return `${String(row.node_type ?? "")}::${identity}`;
}

function stableRepoKey(row: Row): string {
  return String(row.root_path ?? row.remote_url ?? row.name ?? row.id ?? "");
}

function stableSnapshotKey(row: Row): string {
  return [
    row.commit_sha ?? null,
    row.worktree_fingerprint ?? null,
    row.parser_version ?? null,
    row.resolver_version ?? null,
    row.schema_version ?? null,
  ].map((value) => value ?? "").join("::");
}

function normalizeStableValue(value: unknown, repoId: string, repoKey: string): unknown {
  if (typeof value === "string") return value.replaceAll(repoId, repoKey);
  if (Array.isArray(value)) return value.map((entry) => normalizeStableValue(entry, repoId, repoKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      normalizeStableValue(entry, repoId, repoKey),
    ]));
  }
  return value;
}

function stableFileFactKey(row: Row, repoKey: string): string {
  return [repoKey, row.file_path, row.content_hash, row.language, row.parser_version]
    .map((value) => String(value ?? ""))
    .join("::");
}

function stableSourceFactKey(row: Row, repoKey: string): string {
  return [repoKey, row.file_path, row.fact_fingerprint, row.content_hash ?? null]
    .map((value) => value ?? "")
    .join("::");
}

function stableEdge(
  row: Row,
  nodeKeys: Map<string, string>,
  repoId: string,
  repoKey: string,
  branchName: string,
): unknown {
  const source = nodeKeys.get(String(row.src)) ?? String(row.src ?? "").replaceAll(repoId, repoKey);
  const destination = row.dst == null
    ? null
    : nodeKeys.get(String(row.dst)) ?? String(row.dst).replaceAll(repoId, repoKey);
  return {
    source,
    destination,
    rawTarget: row.raw_target ?? null,
    edgeType: row.edge_type ?? null,
    branch: row.branch_id == null ? null : branchName,
    origin: row.origin ?? null,
    method: row.method ?? null,
    confidence: row.confidence ?? null,
    provenance: normalizeStableValue(parseJson(row.provenance ?? "{}"), repoId, repoKey),
    status: row.status ?? null,
    sourceType: row.source_type ?? null,
    boundary: row.boundary ?? null,
  };
}

function stableNode(row: Row, repoId: string, repoKey: string): unknown {
  return {
    key: stableNodeKey(row, repoId, repoKey),
    repo: row.repo_id == null ? null : repoKey,
    title: row.title ?? null,
    meta: normalizeStableValue(parseJson(row.meta ?? "{}"), repoId, repoKey),
  };
}

/**
 * Export the current published snapshot for one repository/branch. The
 * function is read-only and refuses an unready or cross-repository snapshot.
 * Callers can compare `digest` across fresh databases and repeated rebuilds.
 */
export function exportCanonicalCorpus(input: {
  store: KnowledgeStore;
  repoId: string;
  branchId: string;
  snapshotId?: string | null;
}): CanonicalCorpusExport {
  const repo = input.store.db.prepare(
    "SELECT id,name,root_path,remote_url FROM repos WHERE id=?",
  ).get(input.repoId) as Row | undefined;
  if (!repo) throw new Error(`CORPUS_EXPORT_REPO_NOT_FOUND:${input.repoId}`);
  const branch = input.store.db.prepare(
    "SELECT id,repo_id,name,current_snapshot_id FROM branches WHERE id=? AND repo_id=?",
  ).get(input.branchId, input.repoId) as Row | undefined;
  if (!branch) throw new Error(`CORPUS_EXPORT_BRANCH_NOT_FOUND:${input.branchId}`);
  const snapshotId = String(input.snapshotId ?? branch.current_snapshot_id ?? "");
  if (!snapshotId) throw new Error(`CORPUS_EXPORT_SNAPSHOT_NOT_FOUND:${input.branchId}`);
  const snapshot = input.store.db.prepare(
    "SELECT id,repo_id,commit_sha,worktree_fingerprint,parser_version,resolver_version,schema_version,state FROM revision_snapshots WHERE id=? AND repo_id=?",
  ).get(snapshotId, input.repoId) as Row | undefined;
  if (!snapshot || snapshot.state !== "ready") throw new Error(`CORPUS_EXPORT_SNAPSHOT_NOT_READY:${snapshotId}`);

  const repoKey = stableRepoKey(repo);
  const snapshotKey = stableSnapshotKey(snapshot);
  const nodeRows = tableExists(input.store, "nodes")
    ? rows(input.store, `
        SELECT id,node_type,identity_key,repo_id,title,meta
          FROM nodes
         WHERE repo_id=?
            OR (node_type='endpoint' AND EXISTS (
                 SELECT 1 FROM endpoint_memberships em
                  WHERE em.endpoint_id=nodes.id AND em.repo_id=?
               ))
         ORDER BY node_type,identity_key,id`, input.repoId, input.repoId)
    : [];
  const nodeKeys = new Map(nodeRows.map((row) => [String(row.id), stableNodeKey(row, input.repoId, repoKey)]));

  const stableFiles = sorted(rows(input.store, `
    SELECT e.file_path AS filePath,
           f.content_hash AS contentHash,
           f.language AS language,
           f.parser_version AS parserVersion,
           f.exports_hash AS exportsHash
      FROM effective_snapshot_files e
      JOIN file_facts f ON f.id=e.file_fact_id
     WHERE e.snapshot_id=? AND f.repo_id=?`, snapshotId, input.repoId).map((row) => ({
    filePath: row.filePath,
    contentHash: row.contentHash,
    language: row.language,
    parserVersion: row.parserVersion,
    exportsHash: row.exportsHash,
  })));

  const stableFileFacts = sorted(rows(input.store, `
    SELECT f.id,f.file_path,f.content_hash,f.language,f.parser_version,
           f.facts_json,f.exports_hash
      FROM file_facts f
      JOIN effective_snapshot_files e ON e.file_fact_id=f.id
     WHERE e.snapshot_id=? AND f.repo_id=?`, snapshotId, input.repoId).map((row) => ({
    key: stableFileFactKey(row, repoKey),
    filePath: row.file_path,
    contentHash: row.content_hash,
    language: row.language,
    parserVersion: row.parser_version,
    facts: normalizeStableValue(parseJson(row.facts_json), input.repoId, repoKey),
    exportsHash: row.exports_hash,
  })));
  const fileFactKeys = new Map(rows(input.store, `
    SELECT f.id,f.file_path,f.content_hash,f.language,f.parser_version
      FROM file_facts f
      JOIN effective_snapshot_files e ON e.file_fact_id=f.id
     WHERE e.snapshot_id=? AND f.repo_id=?`, snapshotId, input.repoId)
    .map((row) => [String(row.id), stableFileFactKey(row, repoKey)]));

  const stableSourceFacts = sorted(rows(input.store, `
    SELECT DISTINCT f.id,f.file_path,f.fact_fingerprint,f.content_hash,
           f.coverage_json
      FROM source_facts f
      JOIN effective_snapshot_sources e ON e.source_fact_id=f.id
     WHERE e.snapshot_id=? AND f.repo_id=?`, snapshotId, input.repoId).map((row) => ({
    key: stableSourceFactKey(row, repoKey),
    filePath: row.file_path,
    factFingerprint: row.fact_fingerprint,
    contentHash: row.content_hash ?? null,
    coverage: parseJson(row.coverage_json),
  })));

  const stableSymbols = sorted(rows(input.store, `
    SELECT n.node_type,n.identity_key,n.repo_id,n.title,n.meta,
           sv.commit_sha,sv.file_path,sv.lang,sv.kind,sv.signature,
           sv.start_line,sv.end_line,sv.content_hash,sv.status
      FROM symbol_versions sv
      JOIN nodes n ON n.id=sv.node_id
     WHERE sv.branch_id=? AND n.repo_id=?
     ORDER BY n.identity_key`, input.branchId, input.repoId).map((row) => ({
    node: stableNode(row, input.repoId, repoKey),
    commitSha: row.commit_sha,
    filePath: row.file_path,
    language: row.lang,
    kind: row.kind,
    signature: row.signature ?? null,
    startLine: row.start_line ?? null,
    endLine: row.end_line ?? null,
    contentHash: row.content_hash,
    status: row.status,
  })));

  const edgeRows = rows(input.store, `
    SELECT e.*
      FROM edges e
      LEFT JOIN nodes src ON src.id=e.src
      LEFT JOIN nodes dst ON dst.id=e.dst
     WHERE e.status='active'
       AND (
         e.branch_id=?
         OR (e.branch_id IS NULL AND (
              src.repo_id=? OR dst.repo_id=?
              OR EXISTS (SELECT 1 FROM endpoint_memberships em WHERE em.endpoint_id=src.id AND em.repo_id=?)
              OR EXISTS (SELECT 1 FROM endpoint_memberships em WHERE em.endpoint_id=dst.id AND em.repo_id=?)
            ))
       )`, input.branchId, input.repoId, input.repoId, input.repoId, input.repoId);
  const stableEdges = sorted(edgeRows.map((row) => stableEdge(row, nodeKeys, input.repoId, repoKey, String(branch.name))));

  const stableNodes = sorted(nodeRows.map((row) => stableNode(row, input.repoId, repoKey)));
  const stableEndpoints = sorted(rows(input.store, `
    SELECT n.identity_key AS endpointKey,n.title,n.meta,
           em.role,em.file_path AS filePath,
           locator.identity_key AS locatorKey
      FROM endpoint_memberships em
      JOIN nodes n ON n.id=em.endpoint_id
      LEFT JOIN nodes locator ON locator.id=em.locator_node_id
     WHERE em.repo_id=?
     ORDER BY n.identity_key,em.role,em.file_path,locatorKey`, input.repoId).map((row) => ({
    endpointKey: row.endpointKey,
    title: row.title,
    meta: parseJson(row.meta ?? "{}"),
    role: row.role,
    filePath: row.filePath,
    locatorKey: row.locatorKey ?? null,
  })));

  const resolutionRows = rows(input.store, `
    SELECT rs.file_fact_id,rs.context_fingerprint,rs.resolver_version,
           re.src_identity_key,re.dst_identity_key,re.raw_target,re.edge_type,
           re.method,re.confidence,re.provenance
      FROM snapshot_resolution_refs ref
      JOIN resolution_sets rs ON rs.id=ref.resolution_set_id
      JOIN resolved_edges re ON re.resolution_set_id=rs.id
     WHERE ref.snapshot_id=?
     ORDER BY ref.file_path,re.src_identity_key,re.edge_type,re.dst_identity_key`, snapshotId);
  const stableResolutionSets = sorted(resolutionRows.map((row) => ({
    fileFactKey: fileFactKeys.get(String(row.file_fact_id)) ?? String(row.file_fact_id),
    contextKey: `${fileFactKeys.get(String(row.file_fact_id)) ?? String(row.file_fact_id)}::${String(row.resolver_version ?? "")}`,
    resolverVersion: row.resolver_version,
    source: String(row.src_identity_key ?? "").replaceAll(input.repoId, repoKey),
    destination: row.dst_identity_key == null ? null : String(row.dst_identity_key).replaceAll(input.repoId, repoKey),
    rawTarget: row.raw_target ?? null,
    edgeType: row.edge_type,
    method: row.method,
    confidence: row.confidence,
    provenance: normalizeStableValue(parseJson(row.provenance ?? "{}"), input.repoId, repoKey),
  })));

  const stableCoverage = sorted(rows(input.store, `
    SELECT file_path AS filePath,git_state AS gitState,coverage_status AS coverageStatus,
           reason_code AS reasonCode,classification,byte_size AS byteSize,reason,
           parser_status AS parserStatus,parser_language AS parserLanguage,
           parser_version AS parserVersion,parser_error AS parserError,
           unresolved_references AS unresolvedReferences
      FROM coverage_records WHERE repo_id=?`, input.repoId));
  const stableGitCommits = sorted(rows(input.store, `
    SELECT commit_sha AS commitSha,tree_hash AS treeHash,parent_shas AS parentShas,
           committed_at AS committedAt,history_state AS historyState
      FROM git_commits WHERE repo_id=?`, input.repoId).map((row) => ({
    ...row,
    parentShas: parseJson(row.parentShas ?? "[]"),
  })));

  const stableSemantic = tableExists(input.store, "semantic_chunks")
    ? sorted(rows(input.store, `
        SELECT c.content_hash AS contentHash,c.node_id AS nodeId,
               c.canonical_file_path AS filePath,c.identity_hash AS identityHash,
               c.chunker_version AS chunkerVersion,c.start_byte AS startByte,
               c.end_byte AS endByte,c.chunk_kind AS chunkKind,c.text_hash AS textHash,
               r.model_hash AS modelHash,r.status,r.generation_id AS generationId,
               r.space_id AS spaceId
          FROM semantic_chunks c
          LEFT JOIN semantic_embedding_refs r ON r.chunk_id=c.id
         WHERE c.snapshot_id=? AND c.repo_id=?`, snapshotId, input.repoId).map((row) => ({
      contentHash: row.contentHash,
      nodeKey: row.nodeId == null ? null : nodeKeys.get(String(row.nodeId)) ?? String(row.nodeId).replaceAll(input.repoId, repoKey),
      filePath: row.filePath,
      identityHash: row.identityHash,
      chunkerVersion: row.chunkerVersion,
      startByte: row.startByte,
      endByte: row.endByte,
      chunkKind: row.chunkKind,
      textHash: row.textHash,
      modelHash: row.modelHash ?? null,
      status: row.status ?? null,
      // Generation/space ids are process-local implementation ids. Their
      // model/status fields remain visible, but their ids do not enter the
      // stable projection.
      generationStatus: row.generationId == null ? null : row.status ?? null,
      spacePresent: row.spaceId != null,
    })))
    : [];

  const stable = {
    gitCommits: stableGitCommits,
    coverage: stableCoverage,
    files: stableFiles,
    sourceFacts: stableSourceFacts,
    fileFacts: stableFileFacts,
    symbols: stableSymbols,
    nodes: stableNodes,
    edges: stableEdges,
    endpoints: stableEndpoints,
    resolutionSets: stableResolutionSets,
    semantic: stableSemantic,
  };
  const scope = {
    repository: {
      name: String(rowValue(repo, "name", "")),
      rootPath: String(rowValue(repo, "root_path", "")),
      remoteUrl: rowValue<string | null>(repo, "remote_url", null),
    },
    branch: { name: String(rowValue(branch, "name", "")) },
    snapshot: {
      commitSha: rowValue<string | null>(snapshot, "commit_sha", null),
      worktreeFingerprint: rowValue<string | null>(snapshot, "worktree_fingerprint", null),
      parserVersion: String(rowValue(snapshot, "parser_version", "")),
      resolverVersion: String(rowValue(snapshot, "resolver_version", "")),
      schemaVersion: Number(rowValue(snapshot, "schema_version", 0)),
      state: String(rowValue(snapshot, "state", "")),
    },
  };
  const withoutDigest = {
    formatVersion: CORPUS_EXPORT_VERSION,
    scope,
    stable,
    volatileFields: CORPUS_EXPORT_VOLATILE_FIELDS,
  };
  return {
    ...withoutDigest,
    digest: sha256Canonical(withoutDigest),
  };
}
