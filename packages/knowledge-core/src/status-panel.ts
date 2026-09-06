import type { KnowledgeStore } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";
import { readGitStateDefault, type GitStateReader } from "./query-scope.js";
import { readStorageFileSizes } from "./storage-report.js";
import { runtimeIndexCompatibility, type RuntimeIndexCompatibility } from "./runtime-compatibility.js";

// The Wiki footer needs a single, never-throwing snapshot of "is what I'm
// looking at trustworthy": which branch git has checked out, whether the
// index is caught up with it, and how much of the repo the index actually
// covers. This is read-only assembly over already-written tables (repos,
// branches, coverage_records) plus one live git read per repo -- no scope
// resolution, no mutation, no capability escalation.

export interface RepoStatusPanel {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchName: string | null; // checked-out git branch from this request, null if git unavailable
  currentHead: string | null;
  indexedCommit: string | null;
  snapshotId: string | null;
  revisionGeneration: number;
  checkedAt: string;
  revisionAlignment: "aligned" | "behind" | "branch_not_indexed" | "git_unavailable";
  indexedBranch: string | null; // best indexed branch for that checkout (or live fallback)
  lastIndexedAt: string | null;
  staleReason: string | null; // branches.stale_reason passthrough
  indexCompatibility: RuntimeIndexCompatibility | null;
  // GROUP BY coverage_status counts; null only when the repo has zero
  // coverage_records rows at all. A repo whose rows are all coverage_status
  // 'stale' still has non-empty coverage_records, so this comes back as
  // {admitted:0, excluded:0, failed:0}, not null -- a renderer that treats
  // null as "not computed yet" must not conflate that with an all-zero
  // result caused entirely by stale rows.
  coverage: { admitted: number; excluded: number; failed: number } | null;
}

export interface StatusPanel {
  // sizeBytes/walBytes: three stat() calls, no dbstat — the footer polls this
  // every 30s and must stay cheap. Null when the file paths can't be read.
  db: { connected: true; schemaVersion: number; sizeBytes: number | null; walBytes: number | null };
  repos: RepoStatusPanel[];
}

interface BranchRow {
  id: string;
  name: string;
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  staleReason: string | null;
  status: string;
  snapshotId: string | null;
}

const EMPTY_REPO_FIELDS = {
  branchName: null,
  currentHead: null,
  indexedCommit: null,
  snapshotId: null,
  revisionGeneration: 0,
  checkedAt: "",
  revisionAlignment: "git_unavailable" as const,
  indexedBranch: null,
  lastIndexedAt: null,
  staleReason: null,
  indexCompatibility: null,
  coverage: null,
};

function buildRepoStatusPanel(
  store: KnowledgeStore,
  repo: { id: string; name: string; rootPath: string },
  revisionGeneration: number,
  readGitState: GitStateReader,
): RepoStatusPanel {
  const checkedAt = new Date().toISOString();
  try {
    const gitState = readGitState(repo.rootPath);
    const branchRows = store.db
      .prepare(
        `SELECT id,name, last_indexed_commit AS lastIndexedCommit, last_indexed_at AS lastIndexedAt,
                stale_reason AS staleReason, status, current_snapshot_id AS snapshotId
           FROM branches
          WHERE repo_id = ? AND status <> 'gone'
          ORDER BY name`,
      )
      .all(repo.id) as BranchRow[];

    const branchName = gitState?.branch ?? null;
    const matched = branchName ? branchRows.find((row) => row.name === branchName) : undefined;

    let revisionAlignment: RepoStatusPanel["revisionAlignment"];
    if (!gitState || !gitState.branch) {
      // No git state at all, OR git state present but branch is null --
      // detached HEAD (mid-rebase, CI checkout, a pinned worktree). Neither
      // case has a checked-out branch name to compare against `branches`,
      // so both fold into the same "can't answer from git" bucket, matching
      // query-scope.ts's GIT_UNAVAILABLE convention for a null branch.
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
    const indexCompatibility = fallback ? runtimeIndexCompatibility(store, fallback.id) : null;
    // `index_status` is backed by the last persisted branch metadata while
    // this panel also observes the live checkout. A repository can therefore
    // move after indexing without a writer having populated stale_reason yet.
    // Never emit an unexplained `behind`: MCP-only consumers need a concrete
    // reason to distinguish live Git drift from contradictory index metadata.
    const staleReason = indexCompatibility?.state === "schema_outdated"
      ? "schema_outdated"
      : fallback?.staleReason
      ?? (revisionAlignment === "behind" ? "git_head_differs_from_indexed_commit" : null);

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
      currentHead: gitState?.headSha ?? null,
      indexedCommit: fallback?.lastIndexedCommit ?? null,
      snapshotId: fallback?.snapshotId ?? null,
      revisionGeneration,
      checkedAt,
      revisionAlignment,
      indexedBranch,
      lastIndexedAt,
      staleReason,
      indexCompatibility,
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
      revisionGeneration,
      checkedAt,
    };
  }
}

export interface BuildStatusPanelOptions {
  readGitState?: GitStateReader;
}

export function buildStatusPanel(
  store: KnowledgeStore,
  options: BuildStatusPanelOptions = {},
): StatusPanel {
  const repos = store.db
    .prepare("SELECT id, name, root_path AS rootPath FROM repos ORDER BY name")
    .all() as Array<{ id: string; name: string; rootPath: string }>;
  let sizeBytes: number | null = null;
  let walBytes: number | null = null;
  try {
    const sizes = readStorageFileSizes(store);
    sizeBytes = sizes.dbBytes == null ? null : sizes.totalBytes;
    walBytes = sizes.walBytes;
  } catch {
    // never let a stat() failure take down the footer
  }
  const revisionGenerationRow = store.db.prepare("SELECT value FROM meta WHERE key='revision_generation'").get() as { value: string } | undefined;
  const revisionGeneration = Number(revisionGenerationRow?.value ?? 0);
  const readGitState = options.readGitState ?? readGitStateDefault;
  return {
    db: { connected: true, schemaVersion: SCHEMA_VERSION, sizeBytes, walBytes },
    repos: repos.map((repo) => buildRepoStatusPanel(
      store,
      repo,
      Number.isSafeInteger(revisionGeneration) ? revisionGeneration : 0,
      readGitState,
    )),
  };
}
