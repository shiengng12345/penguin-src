import { execFileSync } from "node:child_process";
import type { KnowledgeStore } from "./store.js";
import { canonicalPathForCheck } from "./workspace-scope.js";
import { resolveRevisionContext, type RevisionContext, type RevisionSelector } from "./revision.js";
import {
  warning,
  type KnowledgeLocator,
  type ScopeEnvelope,
  type StructuredWarning,
  type WorktreeState,
} from "@penguin/knowledge-contracts";

// ---------------------------------------------------------------------------
// Git state — the only I/O this module performs directly. Injectable via
// ResolveQueryScopeInput.readGitState so callers (and tests) can supply a
// fake without touching the filesystem/subprocess.
// ---------------------------------------------------------------------------

export interface GitState {
  branch: string | null; // null when detached HEAD
  headSha: string | null;
  dirty: boolean;
}

export type GitStateReader = (rootPath: string) => GitState | null; // null = git unavailable

function git(rootPath: string, args: string[]): string {
  return execFileSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Reads real git state for `rootPath` using the same execFileSync(-C) idiom
 * as knowledge-indexer's git-topology.ts `git()` helper (not imported from
 * there — knowledge-core must not depend on knowledge-indexer).
 */
export function readGitStateDefault(rootPath: string): GitState | null {
  try {
    const branchRaw = git(rootPath, ["branch", "--show-current"]);
    const branch = branchRaw === "" ? null : branchRaw;
    const headSha = git(rootPath, ["rev-parse", "HEAD"]);
    const dirty = git(rootPath, ["status", "--porcelain=v1"]).length > 0;
    return { branch, headSha, dirty };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// REPO_AMBIGUOUS is reserved for repo-level ambiguity in multi-repo path
// matching; it is currently unreachable because resolveRepoForPath's
// longest-root_path-prefix match returns at most one repo.
export type ScopeResolutionErrorCode = "BRANCH_NOT_INDEXED" | "REPO_REQUIRED" | "REPO_AMBIGUOUS" | "SCOPE_NOT_FOUND";

export class ScopeResolutionError extends Error {
  readonly code: ScopeResolutionErrorCode;
  readonly candidates: Array<{ branchName: string; commitSha: string }>;

  constructor(
    code: ScopeResolutionErrorCode,
    message: string,
    candidates: Array<{ branchName: string; commitSha: string }> = [],
  ) {
    super(message);
    this.name = "ScopeResolutionError";
    this.code = code;
    this.candidates = candidates;
  }
}

// ---------------------------------------------------------------------------
// Public input/output shapes
// ---------------------------------------------------------------------------

export interface ResolveQueryScopeInput {
  repoId?: string; // explicit repo (id, already resolved)
  cwd?: string; // used only to infer repo when repoId absent
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  allowFallback?: boolean;
  readGitState?: GitStateReader; // injectable; defaults to real git
}

export interface ResolvedQueryScope extends ScopeEnvelope {
  revision: RevisionContext;
}

// ---------------------------------------------------------------------------
// Repo resolution — ported from knowledge-cli's resolveRepoForCwd
// (command-dispatch.ts, longest root_path-prefix match). Lives here so
// knowledge-core has no dependency on knowledge-cli.
// ---------------------------------------------------------------------------

export function resolveRepoForPath(store: KnowledgeStore, path: string): { repoId: string; rootPath: string } | null {
  const normalized = canonicalPathForCheck(path);
  const rows = store.db
    .prepare("SELECT id, root_path AS rootPath FROM repos ORDER BY length(root_path) DESC")
    .all() as Array<{ id: string; rootPath: string }>;
  for (const row of rows) {
    const root = canonicalPathForCheck(row.rootPath);
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return { repoId: row.id, rootPath: row.rootPath };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal row lookups (kept local — the fields we need aren't all part of
// the exported RepoRow/BranchRow types, e.g. indexed_worktree_state).
// ---------------------------------------------------------------------------

interface RepoRowLite {
  id: string;
  name: string;
  rootPath: string;
}

interface BranchRowLite {
  id: string;
  lastIndexedCommit: string | null;
  lastIndexedAt: string | null;
  indexedWorktreeState: string;
}

function getRepoRow(store: KnowledgeStore, repoId: string): RepoRowLite | null {
  const row = store.db
    .prepare("SELECT id, name, root_path AS rootPath FROM repos WHERE id = ?")
    .get(repoId) as RepoRowLite | undefined;
  return row ?? null;
}

function getBranchRow(store: KnowledgeStore, branchId: string | undefined): BranchRowLite | null {
  if (!branchId) return null;
  const row = store.db
    .prepare(
      `SELECT id,
              last_indexed_commit AS lastIndexedCommit,
              last_indexed_at AS lastIndexedAt,
              indexed_worktree_state AS indexedWorktreeState
       FROM branches WHERE id = ?`,
    )
    .get(branchId) as BranchRowLite | undefined;
  return row ?? null;
}

function mapWorktreeState(raw: string | null | undefined): WorktreeState {
  if (raw === "clean" || raw === "dirty" || raw === "snapshot" || raw === "unknown") return raw;
  return "unknown";
}

function toCandidates(contexts: RevisionContext[]): Array<{ branchName: string; commitSha: string }> {
  return contexts.map((context) => ({ branchName: context.branch ?? "(unnamed)", commitSha: context.commitSha }));
}

function buildLocator(
  repoRow: RepoRowLite,
  revision: RevisionContext,
  branchRow: BranchRowLite | null,
): KnowledgeLocator {
  return {
    repoId: revision.repoId,
    repoName: repoRow.name,
    rootPath: repoRow.rootPath,
    ...(revision.branchId ? { branchId: revision.branchId } : {}),
    ...(revision.branch ? { branchName: revision.branch } : {}),
    ...(revision.commitSha ? { commitSha: revision.commitSha } : {}),
    snapshotId: revision.snapshotId,
    worktreeState: mapWorktreeState(branchRow?.indexedWorktreeState),
    ...(branchRow?.lastIndexedAt ? { indexedAt: branchRow.lastIndexedAt } : {}),
  };
}

/** Resolves via resolveRevisionContext, mapping ambiguous/not_found to ScopeResolutionError(SCOPE_NOT_FOUND). */
function resolveOrThrowScopeNotFound(store: KnowledgeStore, selector: RevisionSelector): RevisionContext {
  const resolution = resolveRevisionContext(store, selector);
  if (resolution.status === "resolved") return resolution.context;
  throw new ScopeResolutionError("SCOPE_NOT_FOUND", resolution.reason, toCandidates(resolution.candidates));
}

// ---------------------------------------------------------------------------
// The chokepoint
// ---------------------------------------------------------------------------

export function resolveQueryScope(store: KnowledgeStore, input: ResolveQueryScopeInput): ResolvedQueryScope {
  const repoId = input.repoId ?? (input.cwd ? resolveRepoForPath(store, input.cwd)?.repoId : undefined);
  if (!repoId) {
    throw new ScopeResolutionError(
      "REPO_REQUIRED",
      "a repository could not be determined: pass repoId explicitly, or cwd inside a registered repo root",
    );
  }

  const repoRow = getRepoRow(store, repoId);
  if (!repoRow) {
    throw new ScopeResolutionError("SCOPE_NOT_FOUND", `repository not found: ${repoId}`);
  }

  const hasExplicitSelector = Boolean(input.branch || input.commitSha || input.snapshotId);

  // --- 2. Explicit selector -------------------------------------------------
  if (hasExplicitSelector) {
    const context = resolveOrThrowScopeNotFound(store, {
      repoId,
      branch: input.branch,
      commitSha: input.commitSha,
      snapshotId: input.snapshotId,
    });

    const warnings: StructuredWarning[] = [];
    const gitState = input.readGitState ? input.readGitState(repoRow.rootPath) : readGitStateDefault(repoRow.rootPath);
    if (gitState?.branch && context.branch && gitState.branch !== context.branch) {
      warnings.push(
        warning(
          "SCOPE_DIFFERS_FROM_CHECKOUT",
          `requested scope (branch "${context.branch}") differs from the checked-out branch "${gitState.branch}"`,
        ),
      );
    }

    const branchRow = getBranchRow(store, context.branchId);
    return { revision: context, locator: buildLocator(repoRow, context, branchRow), alignment: "explicit", warnings };
  }

  // --- 3. No selector — read git state at the repo root --------------------
  const gitState = input.readGitState ? input.readGitState(repoRow.rootPath) : readGitStateDefault(repoRow.rootPath);

  if (!gitState || !gitState.branch) {
    // git unavailable or detached HEAD → sole-live-branch fallback rule.
    const context = resolveOrThrowScopeNotFound(store, { repoId });
    const branchRow = getBranchRow(store, context.branchId);
    const warnings = [
      warning(
        "GIT_UNAVAILABLE",
        gitState
          ? "HEAD is detached; scope resolved via the repository's sole live branch"
          : "git state is unavailable; scope resolved via the repository's sole live branch",
      ),
    ];
    return { revision: context, locator: buildLocator(repoRow, context, branchRow), alignment: "fallback", warnings };
  }

  const resolution = resolveRevisionContext(store, { repoId, branch: gitState.branch });

  if (resolution.status === "resolved") {
    const context = resolution.context;
    const branchRow = getBranchRow(store, context.branchId);
    const warnings: StructuredWarning[] = [];

    if ((branchRow?.lastIndexedCommit ?? null) !== gitState.headSha) {
      warnings.push(
        warning(
          "REVISION_BEHIND",
          `indexed commit "${branchRow?.lastIndexedCommit ?? "(none)"}" for branch "${gitState.branch}" is behind checked-out HEAD "${gitState.headSha}"`,
        ),
      );
    }
    if (gitState.dirty) {
      warnings.push(warning("WORKTREE_DRIFT", `worktree at "${repoRow.rootPath}" has uncommitted changes`));
    }

    return { revision: context, locator: buildLocator(repoRow, context, branchRow), alignment: "aligned", warnings };
  }

  if (resolution.status === "not_found") {
    if (input.allowFallback) {
      const context = resolveOrThrowScopeNotFound(store, { repoId });
      const branchRow = getBranchRow(store, context.branchId);
      const warnings = [
        warning(
          "BRANCH_NOT_INDEXED_FALLBACK",
          `checked-out branch "${gitState.branch}" is not indexed; falling back to branch "${context.branch ?? "(unnamed)"}"`,
        ),
      ];
      return { revision: context, locator: buildLocator(repoRow, context, branchRow), alignment: "fallback", warnings };
    }
    throw new ScopeResolutionError(
      "BRANCH_NOT_INDEXED",
      `checked-out branch "${gitState.branch}" is not indexed; run \`penguin index\` to index branch "${gitState.branch}"`,
      toCandidates(resolution.candidates),
    );
  }

  // ambiguous — the sole-live-branch rule found 2+ live branches with no
  // selector to disambiguate. Not REPO_AMBIGUOUS (reserved for repo-level
  // ambiguity in multi-repo path matching, which longest-prefix matching
  // above precludes).
  throw new ScopeResolutionError("SCOPE_NOT_FOUND", resolution.reason, toCandidates(resolution.candidates));
}
