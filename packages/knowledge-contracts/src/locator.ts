export type WorktreeState = "clean" | "dirty" | "snapshot" | "unknown";
export type ScopeAlignment = "aligned" | "revision_behind" | "fallback" | "explicit";

export interface KnowledgeLocator {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchId?: string;
  branchName?: string;
  commitSha?: string;
  snapshotId: string;
  worktreeState: WorktreeState;
  indexedAt?: string;
}

export type WarningCode =
  | "BRANCH_NOT_INDEXED_FALLBACK"
  | "SCOPE_DIFFERS_FROM_CHECKOUT"
  | "REVISION_BEHIND"
  | "WORKTREE_DRIFT"
  | "GIT_UNAVAILABLE"
  | "FALLBACK_LIVE_BRANCH"
  | "SCOPE_UNRESOLVED";

export interface StructuredWarning {
  code: WarningCode;
  message: string;
  data?: Record<string, unknown>;
}

export interface ScopeEnvelope {
  locator: KnowledgeLocator;
  alignment: ScopeAlignment;
  warnings: StructuredWarning[];
}

export function warning(code: WarningCode, message: string, data?: Record<string, unknown>): StructuredWarning {
  return { code, message, ...(data ? { data } : {}) };
}
