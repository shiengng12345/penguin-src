import type { KnowledgeStore } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";
import { cachedGitStateReader } from "./query-scope.js";

// The Wiki footer needs a single, never-throwing snapshot of "is what I'm
// looking at trustworthy": which branch git has checked out, whether the
// index is caught up with it, and how much of the repo the index actually
// covers. This is read-only assembly over already-written tables (repos,
// branches, coverage_records) plus one cached git read per repo -- no scope
// resolution, no mutation, no capability escalation.

export interface RepoStatusPanel {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchName: string | null; // checked-out git branch (cached reader), null if git unavailable
  revisionAlignment: "aligned" | "behind" | "branch_not_indexed" | "git_unavailable";
  indexedBranch: string | null; // best indexed branch for that checkout (or live fallback)
  lastIndexedAt: string | null;
  staleReason: string | null; // branches.stale_reason passthrough
  coverage: { admitted: number; excluded: number; failed: number } | null;
}

export interface StatusPanel {
  db: { connected: true; schemaVersion: number };
  repos: RepoStatusPanel[];
}

// Module-level cached reader: git state (branch/HEAD) rarely changes within
// the span of a status-panel poll, and a fresh reader per call would defeat
// the TTL memoization cachedGitStateReader provides (see query-scope.ts).
const gitReader = cachedGitStateReader();

interface BranchRow {
  name: string;
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  staleReason: string | null;
  status: string;
}

const EMPTY_REPO_FIELDS = {
  branchName: null,
  revisionAlignment: "git_unavailable" as const,
  indexedBranch: null,
  lastIndexedAt: null,
  staleReason: null,
  coverage: null,
};

function buildRepoStatusPanel(
  store: KnowledgeStore,
  repo: { id: string; name: string; rootPath: string },
): RepoStatusPanel {
  try {
    const gitState = gitReader(repo.rootPath);
    const branchRows = store.db
      .prepare(
        `SELECT name, last_indexed_commit AS lastIndexedCommit, last_indexed_at AS lastIndexedAt,
                stale_reason AS staleReason, status
           FROM branches
          WHERE repo_id = ? AND status <> 'gone'
          ORDER BY name`,
      )
      .all(repo.id) as BranchRow[];

    const branchName = gitState?.branch ?? null;
    const matched = branchName ? branchRows.find((row) => row.name === branchName) : undefined;

    let revisionAlignment: RepoStatusPanel["revisionAlignment"];
    if (!gitState) {
      revisionAlignment = "git_unavailable";
    } else if (matched) {
      revisionAlignment = matched.lastIndexedCommit === gitState.headSha ? "aligned" : "behind";
    } else {
      revisionAlignment = "branch_not_indexed";
    }

    // Informational fallback: when the checked-out branch has no matching
    // index row (or git itself is unavailable), surface whatever the sole
    // (or first, by name) live branch is -- mirrors the same GIT_UNAVAILABLE
    // fallback query-scope.ts already applies for scope resolution, so the
    // footer never goes fully blank just because the checkout drifted.
    const fallback = matched ?? branchRows.find((row) => row.status === "live");
    const indexedBranch = fallback?.name ?? null;
    const lastIndexedAt = fallback?.lastIndexedAt ?? null;
    const staleReason = fallback?.staleReason ?? null;

    const coverageRows = store.db
      .prepare(
        `SELECT coverage_status AS status, COUNT(*) AS n
           FROM coverage_records
          WHERE repo_id = ?
          GROUP BY coverage_status`,
      )
      .all(repo.id) as Array<{ status: string; n: number }>;
    const coverage = coverageRows.length === 0
      ? null
      : {
          admitted: coverageRows.find((row) => row.status === "admitted")?.n ?? 0,
          excluded: coverageRows.find((row) => row.status === "excluded")?.n ?? 0,
          failed: coverageRows.find((row) => row.status === "failed")?.n ?? 0,
        };

    return {
      repoId: repo.id,
      repoName: repo.name,
      rootPath: repo.rootPath,
      branchName,
      revisionAlignment,
      indexedBranch,
      lastIndexedAt,
      staleReason,
      coverage,
    };
  } catch {
    // Never throw: any per-repo failure (git subprocess error, unreadable
    // DB row, etc.) degrades that repo's fields to nulls rather than taking
    // down the whole panel -- the footer must always render something.
    return {
      repoId: repo.id,
      repoName: repo.name,
      rootPath: repo.rootPath,
      ...EMPTY_REPO_FIELDS,
    };
  }
}

export function buildStatusPanel(store: KnowledgeStore): StatusPanel {
  const repos = store.db
    .prepare("SELECT id, name, root_path AS rootPath FROM repos ORDER BY name")
    .all() as Array<{ id: string; name: string; rootPath: string }>;
  return {
    db: { connected: true, schemaVersion: SCHEMA_VERSION },
    repos: repos.map((repo) => buildRepoStatusPanel(store, repo)),
  };
}
