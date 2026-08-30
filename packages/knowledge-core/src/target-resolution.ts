import type { KnowledgeStore } from "./store.js";
import { resolveGrpcEndpoint, resolveSymbolMatches, type SymbolCandidate } from "./query.js";
import type { RevisionContext } from "./revision.js";

export type ResolvedTargetNodeType = "symbol" | "endpoint" | "service" | "file" | "note";

export type ResolvedTarget = {
  nodeId: string;
  nodeType: ResolvedTargetNodeType;
  repoId: string | null;
  branchId: string | null;
  revisionId: string | null;
  identityKey: string;
  locator: { filePath: string | null; startLine: number | null; endLine?: number | null };
};

export type TargetResolutionErrorCode =
  | "TARGET_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_STALE"
  | "REPO_SCOPE_MISMATCH"
  | "BRANCH_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "UNSUPPORTED_TARGET_KIND";

export class TargetResolutionError extends Error {
  constructor(
    readonly code: TargetResolutionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TargetResolutionError";
  }
}

export interface ResolveTargetOptions {
  repoId?: string;
  branchId?: string;
  revision?: RevisionContext;
  allowedKinds?: ResolvedTargetNodeType[];
}

function candidateIds(store: KnowledgeStore, input: string, repoId?: string): { ids: string[]; candidates?: SymbolCandidate[] } {
  const result = resolveSymbolMatches(store, input, repoId ? { repoId } : undefined);
  if (result.kind === "unique") return { ids: [result.nodeId] };
  if (result.kind === "ambiguous") return { ids: [], candidates: result.candidates };
  return { ids: [] };
}

function revisionBranch(store: KnowledgeStore, target: string, options: ResolveTargetOptions): { branchId: string | null; revisionId: string | null } {
  if (options.revision) return { branchId: options.revision.branchId ?? null, revisionId: options.revision.snapshotId ?? null };
  if (options.branchId) {
    const branch = store.db.prepare("SELECT id FROM branches WHERE id=? AND status <> 'gone'").get(options.branchId) as { id: string } | undefined;
    if (!branch) throw new TargetResolutionError("BRANCH_NOT_FOUND", `branch not found: ${options.branchId}`, { received: options.branchId });
    return { branchId: branch.id, revisionId: null };
  }
  const branch = store.db.prepare(`
    SELECT b.id, b.current_snapshot_id AS revisionId
      FROM branches b
      JOIN symbol_versions sv ON sv.branch_id=b.id
     WHERE sv.node_id=? AND sv.status='fresh' AND b.status <> 'gone'
     ORDER BY b.default_branch DESC, b.last_indexed_at DESC
     LIMIT 1
  `).get(target) as { id: string; revisionId: string | null } | undefined;
  return { branchId: branch?.id ?? null, revisionId: branch?.revisionId ?? null };
}

function resolveIds(store: KnowledgeStore, input: string, options: ResolveTargetOptions): { ids: string[]; candidates?: SymbolCandidate[] } {
  const grpc = resolveGrpcEndpoint(store, input);
  if (grpc.kind === "unique") return { ids: [grpc.nodeId] };
  if (grpc.kind === "ambiguous") return { ids: [], candidates: grpc.candidates };
  const unscoped = options.repoId ? resolveSymbolMatches(store, input) : null;
  if (options.repoId && unscoped?.kind === "unique" && store.getNode(unscoped.nodeId)?.repo_id !== options.repoId && store.getNode(unscoped.nodeId)?.node_type !== "endpoint") {
    throw new TargetResolutionError("REPO_SCOPE_MISMATCH", `target ${input} belongs to another repository`, { target: input, expectedRepoId: options.repoId, actualRepoId: store.getNode(unscoped.nodeId)?.repo_id ?? null });
  }
  return candidateIds(store, input, options.repoId);
}

export function resolveTarget(store: KnowledgeStore, input: string, options: ResolveTargetOptions = {}): ResolvedTarget {
  const requested = input.trim();
  if (!requested) throw new TargetResolutionError("TARGET_REQUIRED", "a target is required", { target: input });
  const { ids, candidates } = resolveIds(store, requested, options);
  if (candidates?.length) throw new TargetResolutionError("TARGET_AMBIGUOUS", `target is ambiguous: ${requested}`, { target: requested, candidates });
  if (ids.length === 0) {
    const direct = requested.replace(/^(?:node|symbol):/u, "");
    const stale = store.getNode(direct);
    if (stale) throw new TargetResolutionError("TARGET_STALE", `target is indexed but has no fresh version: ${requested}`, { target: requested, nodeId: direct });
    throw new TargetResolutionError("TARGET_NOT_FOUND", `target was not found: ${requested}`, { target: requested });
  }
  const nodeId = ids[0];
  const node = store.getNode(nodeId);
  if (!node) throw new TargetResolutionError("TARGET_NOT_FOUND", `target was not found: ${requested}`, { target: requested });
  const nodeType = node.node_type as ResolvedTargetNodeType;
  if (!(["symbol", "endpoint", "service", "file", "note"] as string[]).includes(nodeType)) {
    throw new TargetResolutionError("UNSUPPORTED_TARGET_KIND", `unsupported target kind: ${nodeType}`, { target: requested, nodeId, nodeType });
  }
  if (options.allowedKinds?.length && !options.allowedKinds.includes(nodeType)) {
    throw new TargetResolutionError("UNSUPPORTED_TARGET_KIND", `target kind ${nodeType} is not supported by this operation`, { target: requested, nodeId, nodeType, allowedKinds: options.allowedKinds });
  }
  if (options.repoId && node.repo_id && node.repo_id !== options.repoId && nodeType !== "endpoint") {
    throw new TargetResolutionError("REPO_SCOPE_MISMATCH", `target ${requested} belongs to another repository`, { target: requested, expectedRepoId: options.repoId, actualRepoId: node.repo_id });
  }
  const branch = revisionBranch(store, nodeId, options);
  if (options.revision?.repoId && node.repo_id && options.revision.repoId !== node.repo_id && nodeType !== "endpoint") {
    throw new TargetResolutionError("REPO_SCOPE_MISMATCH", `target ${requested} is outside the selected revision repository`, { target: requested, expectedRepoId: options.revision.repoId, actualRepoId: node.repo_id });
  }
  const version = options.revision?.branchId
    ? store.db.prepare("SELECT file_path AS filePath,start_line AS startLine,end_line AS endLine FROM symbol_versions WHERE node_id=? AND branch_id=? AND status='fresh' ORDER BY start_line LIMIT 1").get(nodeId, options.revision.branchId) as { filePath: string | null; startLine: number | null; endLine: number | null } | undefined
    : store.db.prepare("SELECT file_path AS filePath,start_line AS startLine,end_line AS endLine FROM symbol_versions WHERE node_id=? AND status='fresh' ORDER BY start_line LIMIT 1").get(nodeId) as { filePath: string | null; startLine: number | null; endLine: number | null } | undefined;
  if (nodeType === "symbol" && !version) {
    throw new TargetResolutionError("TARGET_STALE", `target is indexed but has no fresh version: ${requested}`, { target: requested, nodeId });
  }
  return {
    nodeId,
    nodeType,
    repoId: node.repo_id ?? null,
    branchId: options.revision?.branchId ?? branch.branchId,
    revisionId: options.revision?.snapshotId ?? branch.revisionId,
    identityKey: node.identity_key,
    locator: { filePath: version?.filePath ?? null, startLine: version?.startLine ?? null, ...(version?.endLine != null ? { endLine: version.endLine } : {}) },
  };
}
