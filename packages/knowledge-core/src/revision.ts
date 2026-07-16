import type { KnowledgeStore } from "./store.js";

export interface RevisionSelector {
  repoId: string;
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  worktreeFingerprint?: string;
}

export interface RevisionContext {
  repoId: string;
  branch?: string;
  branchId?: string;
  commitSha: string;
  snapshotId: string;
  mergeBaseSha?: string;
  worktreeFingerprint?: string;
  trust: "exact_commit" | "exact_worktree" | "fallback_live" | "trust_unavailable";
  degradationReason?: string;
}

export type RevisionResolution =
  | { status: "resolved"; context: RevisionContext }
  | { status: "ambiguous"; candidates: RevisionContext[]; reason: string }
  | { status: "not_found"; candidates: RevisionContext[]; reason: string };

export class RevisionResolutionError extends Error {
  constructor(
    readonly status: "ambiguous" | "not_found",
    message: string,
    readonly candidates: RevisionContext[],
  ) {
    super(message);
    this.name = "RevisionResolutionError";
  }
}

interface BranchRecord {
  id: string;
  repo_id: string;
  name: string;
  head_commit: string | null;
  last_indexed_commit: string | null;
  checkout_path: string | null;
  status: string;
  indexed_worktree_fingerprint: string | null;
  current_snapshot_id: string | null;
}

function branchRows(store: KnowledgeStore, repoId: string): BranchRecord[] {
  return store.db
    .prepare(
      `SELECT id, repo_id, name, head_commit, last_indexed_commit, checkout_path,
              status, indexed_worktree_fingerprint, current_snapshot_id
       FROM branches
       WHERE repo_id=? AND status <> 'gone'`,
    )
    .all(repoId) as BranchRecord[];
}

function contextOf(branch: BranchRecord, selector: RevisionSelector, reason?: string): RevisionContext {
  const commitSha = branch.last_indexed_commit ?? branch.head_commit ?? "(worktree)";
  const fingerprint = branch.indexed_worktree_fingerprint ?? undefined;
  const exactWorktree = Boolean(
    selector.worktreeFingerprint && fingerprint && selector.worktreeFingerprint === fingerprint,
  );
  const trust = exactWorktree
    ? "exact_worktree"
    : branch.current_snapshot_id && (branch.last_indexed_commit || branch.head_commit)
      ? "exact_commit"
      : branch.status === "live"
        ? "fallback_live"
        : "trust_unavailable";
  return {
    repoId: branch.repo_id,
    branch: branch.name,
    branchId: branch.id,
    commitSha,
    snapshotId: `legacy:${branch.id}`,
    ...(fingerprint ? { worktreeFingerprint: fingerprint } : {}),
    trust,
    ...(reason ? { degradationReason: reason } : {}),
  };
}

export function resolveRevisionContext(
  store: KnowledgeStore,
  selector: RevisionSelector,
): RevisionResolution {
  const rows = branchRows(store, selector.repoId);
  if (rows.length === 0) {
    return { status: "not_found", candidates: [], reason: `repository not found: ${selector.repoId}` };
  }

  // Before immutable snapshot storage exists, branch rows are addressable as
  // legacy snapshots. Keep this compatibility path explicit and deterministic.
  if (selector.snapshotId) {
    const id = selector.snapshotId.startsWith("legacy:")
      ? selector.snapshotId.slice("legacy:".length)
      : selector.snapshotId;
    const snapshotRows = rows.filter((row) => row.id === id);
    if (snapshotRows.length === 1) {
      return { status: "resolved", context: contextOf(snapshotRows[0], selector) };
    }
    const snapshot = store.db.prepare(
      "SELECT id, repo_id, commit_sha, worktree_fingerprint, state FROM revision_snapshots WHERE id=? AND repo_id=?",
    ).get(selector.snapshotId, selector.repoId) as { id: string; repo_id: string; commit_sha: string | null; worktree_fingerprint: string | null; state: string } | undefined;
    if (snapshot?.state === "ready") {
      const branch = rows.find((row) => row.current_snapshot_id === snapshot.id);
      if (branch) {
        const context = contextOf(branch, { ...selector, worktreeFingerprint: snapshot.worktree_fingerprint ?? selector.worktreeFingerprint });
        return {
          status: "resolved",
          context: {
            ...context,
            snapshotId: snapshot.id,
            commitSha: snapshot.commit_sha ?? context.commitSha,
            trust: snapshot.worktree_fingerprint && selector.worktreeFingerprint === snapshot.worktree_fingerprint
              ? "exact_worktree"
              : snapshot.commit_sha
                ? "exact_commit"
                : "trust_unavailable",
          },
        };
      }
    }
  }

  if (selector.commitSha) {
    const commitRows = rows.filter(
      (row) => row.last_indexed_commit === selector.commitSha || row.head_commit === selector.commitSha,
    );
    if (commitRows.length === 1) {
      return { status: "resolved", context: contextOf(commitRows[0], selector) };
    }
    if (commitRows.length > 1) {
      return {
        status: "ambiguous",
        candidates: commitRows.map((row) => contextOf(row, selector)),
        reason: `commit ${selector.commitSha} resolves to multiple branches; pass --branch or --snapshot`,
      };
    }
  }

  if (selector.branch) {
    const explicitRows = rows.filter((row) => row.id === selector.branch || row.name === selector.branch);
    if (explicitRows.length === 1) {
      return { status: "resolved", context: contextOf(explicitRows[0], selector) };
    }
    return {
      status: "not_found",
      candidates: rows.map((row) => contextOf(row, selector)),
      reason: `branch not found: ${selector.branch}`,
    };
  }

  const liveRows = rows.filter((row) => row.status === "live");
  if (liveRows.length === 1) {
    return { status: "resolved", context: contextOf(liveRows[0], selector) };
  }
  if (liveRows.length > 1) {
    return {
      status: "ambiguous",
      candidates: liveRows.map((row) => contextOf(row, selector)),
      reason: "multiple live branches; pass --branch, --commit, or --snapshot",
    };
  }

  return {
    status: "not_found",
    candidates: rows.map((row) => contextOf(row, selector)),
    reason: "no live branch is available; pass --branch or --commit",
  };
}

export function requireRevisionContext(
  store: KnowledgeStore,
  selector: RevisionSelector,
): RevisionContext {
  const result = resolveRevisionContext(store, selector);
  if (result.status === "resolved") return result.context;
  throw new RevisionResolutionError(result.status, result.reason, result.candidates);
}
