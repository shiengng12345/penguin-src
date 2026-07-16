import { GitTopologyStore } from "./git-topology-store.js";
import { resolveRevisionContext, type RevisionContext } from "./revision.js";
import type { KnowledgeStore } from "./store.js";

export interface CodeVersionRequest {
  repoId: string;
  targetId?: string;
  observedAt: string;
  logCommitSha?: string;
  environmentBranch?: string;
}

export interface CodeVersionResolution {
  context: RevisionContext;
  source: "log_commit" | "deployment_record" | "indexed_commit" | "environment_branch" | "live_fallback";
  degradationReason?: string;
}

export interface CodeVersionResolverDeps {
  store: KnowledgeStore;
  materializeCommit(input: { repoId: string; commitSha: string }): Promise<RevisionContext>;
}

function snapshotContext(store: KnowledgeStore, repoId: string, commitSha: string, snapshotId: string): RevisionContext {
  const branch = store.db.prepare("SELECT id,name FROM branches WHERE repo_id=? AND current_snapshot_id=? LIMIT 1").get(repoId, snapshotId) as { id: string; name: string } | undefined;
  return { repoId, ...(branch ? { branch: branch.name, branchId: branch.id } : {}), commitSha, snapshotId, trust: "exact_commit" };
}

export class CodeVersionResolver {
  constructor(private readonly deps: CodeVersionResolverDeps) {}

  async resolve(request: CodeVersionRequest): Promise<CodeVersionResolution> {
    const { store } = this.deps;
    const exact = async (commitSha: string, source: CodeVersionResolution["source"]): Promise<CodeVersionResolution> => {
      const snapshots = new GitTopologyStore(store).snapshotsForCommit(request.repoId, commitSha).filter((snapshot) => snapshot.state === "ready" || snapshot.state === "cold");
      const snapshot = snapshots[0];
      if (snapshot) {
        if (snapshot.state === "cold") {
          const context = await this.deps.materializeCommit({ repoId: request.repoId, commitSha });
          return { context, source };
        }
        return { context: snapshotContext(store, request.repoId, commitSha, snapshot.id), source };
      }
      return { context: await this.deps.materializeCommit({ repoId: request.repoId, commitSha }), source };
    };

    if (request.logCommitSha) return exact(request.logCommitSha, "log_commit");
    if (request.targetId) {
      const deployment = store.db.prepare(
        `SELECT commit_sha AS commitSha FROM deployment_revisions
         WHERE target_id=? AND repo_id=? AND deployed_from<=? AND (deployed_to IS NULL OR deployed_to>?)
         ORDER BY deployed_from DESC LIMIT 1`,
      ).get(request.targetId, request.repoId, request.observedAt, request.observedAt) as { commitSha: string } | undefined;
      if (deployment) return exact(deployment.commitSha, "deployment_record");
    }
    const indexed = store.db.prepare(
      "SELECT commit_sha AS commitSha, id FROM revision_snapshots WHERE repo_id=? AND commit_sha IS NOT NULL AND state IN ('ready','cold') ORDER BY published_at DESC, created_at DESC LIMIT 1",
    ).get(request.repoId) as { commitSha: string; id: string } | undefined;
    if (indexed) return exact(indexed.commitSha, "indexed_commit");
    if (request.environmentBranch) {
      const result = resolveRevisionContext(store, { repoId: request.repoId, branch: request.environmentBranch });
      if (result.status === "resolved") return { context: result.context, source: "environment_branch" };
    }
    const fallback = resolveRevisionContext(store, { repoId: request.repoId });
    if (fallback.status === "resolved") return { context: { ...fallback.context, trust: "fallback_live", degradationReason: "exact runtime commit and deployment evidence unavailable" }, source: "live_fallback", degradationReason: "exact runtime commit and deployment evidence unavailable" };
    throw new Error(fallback.reason);
  }
}
