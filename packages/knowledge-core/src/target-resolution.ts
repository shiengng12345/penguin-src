import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { KnowledgeStore } from "./store.js";
import { resolveGrpcEndpoint, resolveSymbolMatches, type SymbolCandidate } from "./query.js";
import type { RevisionContext } from "./revision.js";
import { openRevisionView } from "./revision-view.js";
import type { ScopeMismatchDetails } from "@penguin/knowledge-contracts";
import { canonicalExistingPath, isPathWithinWorkspace } from "./workspace-scope.js";

export type MutationTargetResolutionErrorCode =
  | "ROOT_PATH_REQUIRED"
  | "MUTATION_PREFLIGHT_INVALID"
  | "ROOT_PATH_OUT_OF_SCOPE"
  | "MUTATION_TARGET_CHANGED";

export class MutationTargetResolutionError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: MutationTargetResolutionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MutationTargetResolutionError";
  }
}

export interface MutationTargetRootRequest {
  action: "register" | "index" | "rebuild";
  requestedRoot: string;
  ownerApprovedRoots: readonly string[];
  expectedCanonicalRoot?: string;
  requireCanonicalInput?: boolean;
}

export interface MutationTargetRoot {
  rootPath: string;
  repositoryRoot: string;
}

/** Strict, side-effect-free validation used before and after mutation confirmation. */
export function resolveMutationTargetRoot(input: MutationTargetRootRequest): MutationTargetRoot {
  const requested = input.requestedRoot.trim();
  if (!requested) throw new MutationTargetResolutionError("ROOT_PATH_REQUIRED", "repository root is required");
  if (!isAbsolute(requested) || !existsSync(requested)) {
    throw new MutationTargetResolutionError("MUTATION_PREFLIGHT_INVALID", "repository root must be an existing absolute directory", { requestedRoot: requested });
  }
  let canonical: string;
  try {
    if (!statSync(requested).isDirectory()) throw new Error("not a directory");
    canonical = realpathSync.native(requested).replace(/\/+$/u, "") || "/";
  } catch {
    throw new MutationTargetResolutionError("MUTATION_PREFLIGHT_INVALID", "repository root must be an existing readable directory", { requestedRoot: requested });
  }
  const approved = input.ownerApprovedRoots
    .map((root) => canonicalExistingPath(root))
    .filter((root): root is string => root !== null);
  if (approved.length === 0 || !isPathWithinWorkspace(canonical, approved)) {
    throw new MutationTargetResolutionError("ROOT_PATH_OUT_OF_SCOPE", "repository root is outside owner-approved workspace roots", { requestedRoot: requested, canonicalRoot: canonical });
  }
  if (input.requireCanonicalInput) {
    try {
      if (lstatSync(requested).isSymbolicLink()) {
        throw new MutationTargetResolutionError("MUTATION_TARGET_CHANGED", "confirmed mutation root must be the canonical repository directory", { requestedRoot: requested, canonicalRoot: canonical });
      }
    } catch (error) {
      if (error instanceof MutationTargetResolutionError) throw error;
      throw new MutationTargetResolutionError("MUTATION_TARGET_CHANGED", "mutation target changed after confirmation", { requestedRoot: requested });
    }
  }
  if (input.expectedCanonicalRoot && canonical !== input.expectedCanonicalRoot) {
    throw new MutationTargetResolutionError("MUTATION_TARGET_CHANGED", "mutation target changed after confirmation", { expectedCanonicalRoot: input.expectedCanonicalRoot, canonicalRoot: canonical });
  }
  let repositoryRoot: string;
  try {
    const discovered = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    repositoryRoot = canonicalExistingPath(discovered) ?? "";
  } catch {
    repositoryRoot = "";
  }
  if (!repositoryRoot || repositoryRoot !== canonical) {
    throw new MutationTargetResolutionError("MUTATION_PREFLIGHT_INVALID", "mutation target must be the root of a valid Git repository", { requestedRoot: requested, canonicalRoot: canonical, repositoryRoot: repositoryRoot || null });
  }
  return { rootPath: canonical, repositoryRoot };
}

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
  | "SCOPE_MISMATCH"
  | "REPO_SCOPE_MISMATCH"
  | "BRANCH_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "UNSUPPORTED_TARGET_KIND";

export class TargetResolutionError extends Error {
  readonly details: Record<string, unknown>;
  readonly retryable = false;

  constructor(
    readonly code: TargetResolutionErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TargetResolutionError";
    this.details = {
      ...details,
      remediation: details.remediation ?? targetRemediation(code),
    };
  }
}

function targetRemediation(code: TargetResolutionErrorCode): string {
  switch (code) {
    case "TARGET_REQUIRED": return "call knowledge_search, then provide a returned stable nodeId as target";
    case "TARGET_AMBIGUOUS": return "call knowledge_search with repo and branch fields, then retry with an exact nodeId from candidates";
    case "TARGET_STALE": return "call knowledge_search for a current nodeId; the owner may refresh the repository with knowledge_index";
    case "SCOPE_MISMATCH":
    case "REPO_SCOPE_MISMATCH": return "specify the repository that owns the target";
    case "BRANCH_NOT_FOUND": return "call index_status and retry with an indexed branch; the owner may refresh it with knowledge_index";
    case "REVISION_MISMATCH": return "use the matching commit or snapshot from index_status, or ask the owner to call knowledge_index";
    case "UNSUPPORTED_TARGET_KIND": return "use a symbol, endpoint, service, file, or note target";
    case "TARGET_NOT_FOUND": return "call knowledge_search to find a current stable nodeId";
  }
}

export interface ResolveTargetOptions {
  repoId?: string;
  branchId?: string;
  revision?: RevisionContext;
  allowedKinds?: ResolvedTargetNodeType[];
}

export interface TargetScopeRequest {
  repoId?: string;
  revision?: RevisionContext;
}

type TargetScopeCandidate = Pick<ResolvedTarget, "nodeId" | "nodeType" | "repoId">;

type TargetSource = {
  repoId: string | null;
  branchId: string | null;
  revisionId: string | null;
  membershipRepoIds: string[];
};

function sourceBranchForRepo(
  store: KnowledgeStore,
  repoId: string,
  preferredBranchId?: string,
): Omit<TargetSource, "membershipRepoIds"> {
  const branch = store.db.prepare(
    `SELECT id AS branchId,
            COALESCE(current_snapshot_id, last_indexed_commit, head_commit) AS revisionId
       FROM branches
      WHERE repo_id=? AND status <> 'gone'
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, default_branch DESC, last_indexed_at DESC, id
      LIMIT 1`,
  ).get(repoId, preferredBranchId ?? "") as { branchId: string; revisionId: string | null } | undefined;
  return {
    repoId,
    branchId: branch?.branchId ?? null,
    revisionId: branch?.revisionId ?? null,
  };
}

function sourceBranchForFreshTarget(
  store: KnowledgeStore,
  nodeId: string,
  preferredBranchId?: string,
): Omit<TargetSource, "membershipRepoIds"> | null {
  const version = store.db.prepare(
    `SELECT b.repo_id AS repoId, b.id AS branchId,
            COALESCE(b.current_snapshot_id, b.last_indexed_commit, b.head_commit) AS revisionId
       FROM symbol_versions sv
       JOIN branches b ON b.id=sv.branch_id
      WHERE sv.node_id=? AND sv.status='fresh' AND b.status <> 'gone'
      ORDER BY CASE WHEN b.id=? THEN 0 ELSE 1 END,
               b.default_branch DESC, b.last_indexed_at DESC, sv.start_line, sv.id
      LIMIT 1`,
  ).get(nodeId, preferredBranchId ?? "") as {
    repoId: string; branchId: string; revisionId: string | null;
  } | undefined;
  return version ?? null;
}

function sourceForTarget(
  store: KnowledgeStore,
  target: TargetScopeCandidate,
  requested: TargetScopeRequest,
): TargetSource {
  const requestedRepoId = requested.repoId ?? requested.revision?.repoId;
  const requestedBranchId = requested.revision?.branchId;
  if (target.repoId) {
    // Scope errors must describe the target's own fresh symbol version, not
    // whichever branch happens to be the repository default.
    const branch = sourceBranchForFreshTarget(
      store,
      target.nodeId,
      requestedRepoId === target.repoId ? requestedBranchId : undefined,
    ) ?? sourceBranchForRepo(
      store,
      target.repoId,
      requestedRepoId === target.repoId ? requestedBranchId : undefined,
    );
    return { ...branch, membershipRepoIds: [target.repoId] };
  }
  if (target.nodeType !== "endpoint") {
    return { repoId: null, branchId: null, revisionId: null, membershipRepoIds: [] };
  }
  const memberships = store.listEndpointMemberships(target.nodeId);
  const membershipRepoIds = [...new Set(memberships.map((membership) => membership.repoId))];
  const membership = memberships.find((item) => item.repoId === requestedRepoId) ?? memberships[0];
  if (!membership) return { repoId: null, branchId: null, revisionId: null, membershipRepoIds };
  const branch = sourceBranchForRepo(
    store,
    membership.repoId,
    membership.repoId === requestedRepoId ? requestedBranchId : undefined,
  );
  return { ...branch, membershipRepoIds };
}

/**
 * Enforces one ownership rule after a target has been resolved and before a
 * graph traversal starts. Global endpoints are scoped only through Task 3's
 * durable endpoint memberships; a NULL node repo is never wildcard access.
 */
export function assertTargetInScope(
  store: KnowledgeStore,
  target: TargetScopeCandidate,
  requested: TargetScopeRequest = {},
): TargetSource {
  const requestedRepoId = requested.repoId ?? requested.revision?.repoId ?? null;
  const requestedRevisionId = requested.revision?.snapshotId ?? null;
  const actual = sourceForTarget(store, target, requested);
  const inScope = !requestedRepoId
    || (target.repoId ? target.repoId === requestedRepoId : target.nodeType === "endpoint" && actual.membershipRepoIds.includes(requestedRepoId));
  if (inScope) return actual;

  const details: ScopeMismatchDetails = {
    target: target.nodeId,
    requestedRepoId,
    requestedRevisionId,
    actualRepoId: actual.repoId,
    actualRevisionId: actual.revisionId,
    requested: {
      repoId: requestedRepoId,
      branchId: requested.revision?.branchId ?? null,
      revisionId: requestedRevisionId,
    },
    actual: {
      repoId: actual.repoId,
      branchId: actual.branchId,
      revisionId: actual.revisionId,
      membershipRepoIds: actual.membershipRepoIds,
    },
  };
  throw new TargetResolutionError(
    "SCOPE_MISMATCH",
    `target ${target.nodeId} is outside the requested repository scope`,
    details as unknown as Record<string, unknown>,
  );
}

function candidateIds(store: KnowledgeStore, input: string, repoId?: string): { ids: string[]; candidates?: SymbolCandidate[] } {
  const result = resolveSymbolMatches(store, input, repoId ? { repoId } : undefined);
  if (result.kind === "unique") return { ids: [result.nodeId] };
  if (result.kind === "ambiguous") return { ids: [], candidates: result.candidates };
  return { ids: [] };
}

function endpointVisibleInRequestedScope(
  store: KnowledgeStore,
  nodeId: string,
  options: ResolveTargetOptions,
): boolean {
  const node = store.getNode(nodeId);
  if (!node || node.node_type !== "endpoint") return false;
  if (options.revision && !options.revision.snapshotId.startsWith("legacy:")) {
    const identityKey = node.identity_key;
    return openRevisionView(store, options.revision).edges({
      nodeIds: [identityKey],
      edgeTypes: ["handles", "declares", "invokes"],
      direction: "both",
      limit: 2,
      includeGlobal: false,
    }).some((edge) => edge.srcIdentityKey === identityKey || edge.dstIdentityKey === identityKey);
  }
  const repoId = options.repoId ?? options.revision?.repoId;
  return !repoId || store.listEndpointMemberships(nodeId, repoId).length > 0;
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
  if (grpc.kind === "ambiguous") {
    const scopedCandidates = grpc.candidates.filter((candidate) => endpointVisibleInRequestedScope(store, candidate.nodeId, options));
    if (scopedCandidates.length === 1) return { ids: [scopedCandidates[0].nodeId] };
    if (scopedCandidates.length > 1) return { ids: [], candidates: scopedCandidates };
    if (!options.repoId && !options.revision) return { ids: [], candidates: grpc.candidates };
  }
  const scoped = candidateIds(store, input, options.repoId);
  if (scoped.ids.length || scoped.candidates?.length || !options.repoId) return scoped;
  // Resolve the foreign node too, so the shared ownership assertion can emit
  // SCOPE_MISMATCH rather than lying that the target was not found.
  return candidateIds(store, input);
}

export function resolveTarget(store: KnowledgeStore, input: string, options: ResolveTargetOptions = {}): ResolvedTarget {
  const requested = input.trim();
  if (!requested) throw new TargetResolutionError("TARGET_REQUIRED", "a target is required", { target: input });
  if (requested.startsWith("service:")) {
    const selector = requested.slice("service:".length).trim();
    const repoIds = selector ? store.resolveRepoIds(selector) : [];
    if (repoIds.length === 0) {
      throw new TargetResolutionError("TARGET_NOT_FOUND", `service target was not found: ${requested}`, { target: requested, repo: selector });
    }
    if (repoIds.length > 1) {
      throw new TargetResolutionError("TARGET_AMBIGUOUS", `service target is ambiguous: ${requested}`, { target: requested, candidates: repoIds });
    }
    const repoId = repoIds[0];
    if (options.allowedKinds?.length && !options.allowedKinds.includes("service")) {
      throw new TargetResolutionError("UNSUPPORTED_TARGET_KIND", "target kind service is not supported by this operation", { target: requested, allowedKinds: options.allowedKinds });
    }
    const serviceTarget = { nodeId: requested, nodeType: "service" as const, repoId };
    const ownership = assertTargetInScope(store, serviceTarget, { repoId: options.repoId, revision: options.revision });
    return {
      nodeId: requested,
      nodeType: "service",
      repoId,
      branchId: options.revision?.branchId ?? ownership.branchId,
      revisionId: options.revision?.snapshotId ?? ownership.revisionId,
      identityKey: requested,
      locator: { filePath: null, startLine: null },
    };
  }
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
  const ownership = assertTargetInScope(store, {
    nodeId,
    nodeType,
    repoId: node.repo_id ?? null,
  }, {
    repoId: options.repoId,
    revision: options.revision,
  });
  const branch = revisionBranch(store, nodeId, options);
  const version = options.revision?.branchId
    ? store.db.prepare("SELECT file_path AS filePath,start_line AS startLine,end_line AS endLine FROM symbol_versions WHERE node_id=? AND branch_id=? AND status='fresh' ORDER BY start_line LIMIT 1").get(nodeId, options.revision.branchId) as { filePath: string | null; startLine: number | null; endLine: number | null } | undefined
    : store.db.prepare("SELECT file_path AS filePath,start_line AS startLine,end_line AS endLine FROM symbol_versions WHERE node_id=? AND status='fresh' ORDER BY start_line LIMIT 1").get(nodeId) as { filePath: string | null; startLine: number | null; endLine: number | null } | undefined;
  if (nodeType === "symbol" && !version) {
    throw new TargetResolutionError(
      options.revision ? "REVISION_MISMATCH" : "TARGET_STALE",
      options.revision
        ? `target has no fresh version in the selected revision: ${requested}`
        : `target is indexed but has no fresh version: ${requested}`,
      { target: requested, nodeId, ...(options.revision ? { revision: options.revision } : {}) },
    );
  }
  return {
    nodeId,
    nodeType,
    repoId: node.repo_id ?? null,
    branchId: options.revision?.branchId ?? branch.branchId ?? ownership.branchId,
    revisionId: options.revision?.snapshotId ?? branch.revisionId ?? ownership.revisionId,
    identityKey: node.identity_key,
    locator: { filePath: version?.filePath ?? null, startLine: version?.startLine ?? null, ...(version?.endLine != null ? { endLine: version.endLine } : {}) },
  };
}
