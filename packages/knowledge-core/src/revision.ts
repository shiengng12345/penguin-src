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

interface ReadySnapshotRecord {
  id: string;
  repo_id: string;
  commit_sha: string | null;
  worktree_fingerprint: string | null;
  merge_base_sha: string | null;
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

function branchForSnapshot(
  rows: BranchRecord[],
  snapshotId: string,
  selector: RevisionSelector,
): BranchRecord | undefined {
  if (selector.branch) {
    return rows.find(
      (row) => (row.id === selector.branch || row.name === selector.branch)
        && row.current_snapshot_id === snapshotId,
    );
  }
  return rows.find((row) => row.current_snapshot_id === snapshotId);
}

function snapshotContextOf(
  snapshot: ReadySnapshotRecord,
  selector: RevisionSelector,
  branch?: BranchRecord,
  reason?: string,
): RevisionContext {
  const exactWorktree = Boolean(
    selector.worktreeFingerprint
      && snapshot.worktree_fingerprint
      && selector.worktreeFingerprint === snapshot.worktree_fingerprint,
  );
  return {
    repoId: snapshot.repo_id,
    ...(branch ? { branch: branch.name, branchId: branch.id } : {}),
    commitSha: snapshot.commit_sha ?? "(worktree)",
    snapshotId: snapshot.id,
    ...(snapshot.merge_base_sha ? { mergeBaseSha: snapshot.merge_base_sha } : {}),
    ...(snapshot.worktree_fingerprint ? { worktreeFingerprint: snapshot.worktree_fingerprint } : {}),
    trust: exactWorktree
      ? "exact_worktree"
      : snapshot.commit_sha
        ? "exact_commit"
        : "trust_unavailable",
    ...(reason ? { degradationReason: reason } : {}),
  };
}

function currentContextOf(
  store: KnowledgeStore,
  branch: BranchRecord,
  selector: RevisionSelector,
  reason?: string,
): RevisionContext {
  const legacy = contextOf(branch, selector, reason);
  if (!branch.current_snapshot_id) return legacy;
  const snapshot = store.db.prepare(
    `SELECT id, repo_id, commit_sha, worktree_fingerprint, merge_base_sha
       FROM revision_snapshots
      WHERE id=? AND repo_id=? AND state='ready'`,
  ).get(branch.current_snapshot_id, branch.repo_id) as ReadySnapshotRecord | undefined;
  if (!snapshot) return legacy;
  if (selector.commitSha && snapshot.commit_sha !== selector.commitSha) return legacy;
  return snapshotContextOf(snapshot, selector, branch, reason);
}

export function resolveRevisionContext(
  store: KnowledgeStore,
  selector: RevisionSelector,
): RevisionResolution {
  const repoExists = store.db.prepare("SELECT 1 FROM repos WHERE id=?").get(selector.repoId);
  if (!repoExists) {
    return { status: "not_found", candidates: [], reason: `repository not found: ${selector.repoId}` };
  }
  const rows = branchRows(store, selector.repoId);

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
      `SELECT id, repo_id, commit_sha, worktree_fingerprint, merge_base_sha
         FROM revision_snapshots
        WHERE id=? AND repo_id=? AND state='ready'`,
    ).get(selector.snapshotId, selector.repoId) as ReadySnapshotRecord | undefined;
    if (snapshot) {
      return {
        status: "resolved",
        context: snapshotContextOf(snapshot, selector, branchForSnapshot(rows, snapshot.id, selector)),
      };
    }
    // An explicitly supplied snapshot is a hard selector. Falling through to
    // the sole-live-branch resolution below would answer from a different
    // revision while presenting an apparently valid context pack.
    return {
      status: "not_found",
      candidates: rows.map((row) => contextOf(row, selector)),
      reason: `snapshot not found: ${selector.snapshotId}`,
    };
  }

  if (selector.commitSha) {
    const readySnapshots = store.db.prepare(
      `SELECT id, repo_id, commit_sha, worktree_fingerprint, merge_base_sha
         FROM revision_snapshots
        WHERE repo_id=? AND commit_sha=? AND state='ready'
        ORDER BY published_at DESC, id`,
    ).all(selector.repoId, selector.commitSha) as ReadySnapshotRecord[];
    if (readySnapshots.length > 0) {
      const currentSnapshots = readySnapshots.filter((snapshot) =>
        branchForSnapshot(rows, snapshot.id, selector));
      const candidates = currentSnapshots.length === 1 ? currentSnapshots : readySnapshots;
      if (candidates.length === 1) {
        const snapshot = candidates[0];
        return {
          status: "resolved",
          context: snapshotContextOf(snapshot, selector, branchForSnapshot(rows, snapshot.id, selector)),
        };
      }
      return {
        status: "ambiguous",
        candidates: candidates.map((snapshot) =>
          snapshotContextOf(snapshot, selector, branchForSnapshot(rows, snapshot.id, selector))),
        reason: `commit ${selector.commitSha} resolves to multiple ready snapshots; provide snapshotId`,
      };
    }

    // A commit selector is an exact knowledge selector. A branch head can be
    // newer than the indexed commit, so accepting head_commit here would
    // silently return last_indexed_commit evidence for a different revision.
    const commitRows = rows.filter(
      (row) =>
        row.last_indexed_commit === selector.commitSha ||
        // A newly registered branch has no indexed commit yet. Allow its
        // declared head only during that bootstrap window; once an indexed
        // commit exists, the head must never masquerade as indexed evidence.
        (row.last_indexed_commit === null && row.head_commit === selector.commitSha),
    );
    if (commitRows.length === 1) {
      return { status: "resolved", context: currentContextOf(store, commitRows[0], selector) };
    }
    if (commitRows.length > 1) {
      return {
        status: "ambiguous",
        candidates: commitRows.map((row) => contextOf(row, selector)),
        reason: `commit ${selector.commitSha} resolves to multiple branches; provide the branch or snapshotId field`,
      };
    }
    // A caller that names a commit is asking for that exact indexed commit;
    // never fall back to the current live branch when it is absent.
    return {
      status: "not_found",
      candidates: rows.map((row) => contextOf(row, selector)),
      reason: `commit not found: ${selector.commitSha}`,
    };
  }

  if (selector.branch) {
    const explicitRows = rows.filter((row) => row.id === selector.branch || row.name === selector.branch);
    if (explicitRows.length === 1) {
      return { status: "resolved", context: currentContextOf(store, explicitRows[0], selector) };
    }
    return {
      status: "not_found",
      candidates: rows.map((row) => contextOf(row, selector)),
      reason: `branch not found: ${selector.branch}`,
    };
  }

  const liveRows = rows.filter((row) => row.status === "live");
  if (liveRows.length === 1) {
    return { status: "resolved", context: currentContextOf(store, liveRows[0], selector) };
  }
  if (liveRows.length > 1) {
    return {
      status: "ambiguous",
      candidates: liveRows.map((row) => contextOf(row, selector)),
      reason: "multiple live branches; provide branch, commitSha, or snapshotId",
    };
  }

  return {
    status: "not_found",
    candidates: rows.map((row) => contextOf(row, selector)),
    reason: "no live branch is available; provide an indexed branch or commitSha from index_status",
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
