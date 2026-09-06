import { canonicalJson, sha256Hex } from "./canonical.js";
import type { RevisionContext } from "./revision.js";

/** Stable marker used for snapshots derived from a checkout but deliberately
 * not published as the branch's committed revision. */
export const WORKING_TREE_OVERLAY_PREFIX = "working-tree-overlay:";

export interface WorkingTreeOverlayStatus {
  repoId: string;
  branchId: string;
  branch: string;
  baseSnapshotId: string;
  snapshotId: string;
  commitSha: string | null;
  worktreeFingerprint: string;
  state: "clean" | "dirty" | "unknown" | "not_applicable";
  applied: boolean;
  modifiedPaths: string[];
  addedPaths: string[];
  deletedPaths: string[];
  untrackedPaths: string[];
  generatedPaths: string[];
  gaps: string[];
}

export interface WorkingTreeOverlayResult {
  context: RevisionContext;
  status: WorkingTreeOverlayStatus;
}

export function workingTreeOverlaySnapshotKey(input: {
  repoId: string;
  branchId: string;
  baseSnapshotId: string;
  commitSha: string | null;
  worktreeFingerprint: string;
  parserVersion: string;
  resolverVersion: string;
}): string {
  return `${WORKING_TREE_OVERLAY_PREFIX}${sha256Hex(canonicalJson([
    input.repoId,
    input.branchId,
    input.baseSnapshotId,
    input.commitSha,
    input.worktreeFingerprint,
    input.parserVersion,
    input.resolverVersion,
  ]))}`;
}

export function isWorkingTreeOverlaySnapshotKey(value: string): boolean {
  return value.startsWith(WORKING_TREE_OVERLAY_PREFIX);
}

export function isWorkingTreeRevision(context: Pick<RevisionContext, "trust">): boolean {
  return context.trust === "exact_worktree";
}

export function workingTreeRevisionKind(context: Pick<RevisionContext, "trust">): "commit" | "working_tree" {
  return isWorkingTreeRevision(context) ? "working_tree" : "commit";
}
