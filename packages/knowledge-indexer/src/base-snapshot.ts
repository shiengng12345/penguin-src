import type { BranchBaseResolution } from "@penguin/knowledge-core";

export interface BaseSnapshotMaterializer {
  materialize(commitSha: string): Promise<{ snapshotId: string }>;
}

/**
 * Resolve a missing merge-base into one immutable ready snapshot. The caller
 * owns the revision-indexing implementation and deliberately does not publish
 * a branch pointer for this snapshot.
 */
export async function ensureBaseSnapshot(
  resolution: BranchBaseResolution,
  materializer: BaseSnapshotMaterializer,
  headCommitSha?: string,
): Promise<BranchBaseResolution> {
  if (!resolution.materializationRequired || !resolution.baseCommitSha || resolution.baseCommitSha === headCommitSha) return resolution;
  const result = await materializer.materialize(resolution.baseCommitSha);
  return { ...resolution, baseSnapshotId: result.snapshotId, materializationRequired: false };
}
