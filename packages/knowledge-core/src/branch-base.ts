export type BranchBaseReason =
  | "prior_branch_snapshot"
  | "canonical_master"
  | "git_merge_base"
  | "no_base"
  | "degraded_history";

export interface BranchBaseResolution {
  repoId: string;
  targetBranch: string | null;
  canonicalMaster: string | null;
  baseSnapshotId: string | null;
  baseCommitSha: string | null;
  mergeBaseSha: string | null;
  reason: BranchBaseReason;
  degraded: boolean;
  degradationReason: string | null;
  materializationRequired: boolean;
}

export interface BranchBaseInput {
  repoId: string;
  targetBranch: string | null;
  canonicalMaster: string | null;
  priorSnapshotId: string | null;
  priorCommitSha: string | null;
  mergeBaseSha: string | null;
  mergeBaseSnapshotId: string | null;
  canonicalSnapshotId: string | null;
  canonicalCommitSha: string | null;
  historyState: "complete" | "shallow" | "missing" | "not_git";
}

export function resolveBranchBase(input: BranchBaseInput): BranchBaseResolution {
  const base = (values: Partial<BranchBaseResolution>): BranchBaseResolution => ({
    repoId: input.repoId,
    targetBranch: input.targetBranch,
    canonicalMaster: input.canonicalMaster,
    baseSnapshotId: null,
    baseCommitSha: null,
    mergeBaseSha: input.mergeBaseSha,
    reason: "no_base",
    degraded: false,
    degradationReason: null,
    materializationRequired: false,
    ...values,
  });

  if (input.priorSnapshotId) {
    return base({ baseSnapshotId: input.priorSnapshotId, baseCommitSha: input.priorCommitSha, reason: "prior_branch_snapshot" });
  }
  if (input.targetBranch && input.targetBranch === input.canonicalMaster) {
    return base({ reason: "canonical_master", baseSnapshotId: null, baseCommitSha: null });
  }
  if (input.mergeBaseSnapshotId) {
    return base({ baseSnapshotId: input.mergeBaseSnapshotId, baseCommitSha: input.mergeBaseSha, reason: "git_merge_base" });
  }
  if (input.mergeBaseSha && input.historyState === "complete") {
    return base({ baseCommitSha: input.mergeBaseSha, reason: "git_merge_base", materializationRequired: true });
  }
  if (input.canonicalSnapshotId) {
    return base({ baseSnapshotId: input.canonicalSnapshotId, baseCommitSha: input.canonicalCommitSha, reason: "degraded_history", degraded: true, degradationReason: input.historyState });
  }
  return base({ reason: input.historyState === "complete" ? "no_base" : "degraded_history", degraded: input.historyState !== "complete", degradationReason: input.historyState === "complete" ? null : input.historyState });
}
