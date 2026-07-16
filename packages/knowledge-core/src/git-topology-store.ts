import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

export interface GitCommitRecord {
  repoId: string;
  commitSha: string;
  treeHash?: string;
  parentShas: string[];
  committedAt?: string;
  historyState: "complete" | "shallow" | "missing_history";
}

export interface CreateSnapshotInput {
  snapshotKey: string;
  repoId: string;
  commitSha?: string;
  worktreeFingerprint?: string;
  parserVersion: string;
  resolverVersion: string;
  schemaVersion: number;
  baseSnapshotId?: string;
  mergeBaseSha?: string;
}

export interface RevisionSnapshot extends CreateSnapshotInput {
  id: string;
  state: "building" | "ready" | "failed" | "cold";
  failureReason?: string;
  createdAt: string;
  publishedAt?: string;
  lastAccessedAt: string;
  pinned: boolean;
}

export interface DeploymentRevision {
  targetId: string;
  repoId: string;
  commitSha: string;
  deployedFrom: string;
  deployedTo?: string;
  source: string;
}

export interface RevisionReference {
  refType: "evidence_note" | "api_doc_draft" | "api_doc_conflict" | "manual";
  refKey: string;
  repoId: string;
  commitSha: string;
  snapshotId?: string;
}

interface SnapshotRow {
  id: string;
  snapshot_key: string;
  repo_id: string;
  commit_sha: string | null;
  worktree_fingerprint: string | null;
  parser_version: string;
  resolver_version: string;
  schema_version: number;
  base_snapshot_id: string | null;
  merge_base_sha: string | null;
  state: RevisionSnapshot["state"];
  failure_reason: string | null;
  created_at: string;
  published_at: string | null;
  last_accessed_at: string;
  pinned: number;
}

function snapshotOf(row: SnapshotRow): RevisionSnapshot {
  return {
    id: row.id,
    snapshotKey: row.snapshot_key,
    repoId: row.repo_id,
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    ...(row.worktree_fingerprint ? { worktreeFingerprint: row.worktree_fingerprint } : {}),
    parserVersion: row.parser_version,
    resolverVersion: row.resolver_version,
    schemaVersion: row.schema_version,
    ...(row.base_snapshot_id ? { baseSnapshotId: row.base_snapshot_id } : {}),
    ...(row.merge_base_sha ? { mergeBaseSha: row.merge_base_sha } : {}),
    state: row.state,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    lastAccessedAt: row.last_accessed_at,
    pinned: row.pinned === 1,
  };
}

export class GitTopologyStore {
  constructor(private readonly store: KnowledgeStore) {}

  upsertCommit(input: GitCommitRecord): void {
    this.store.db.prepare(
      `INSERT INTO git_commits (repo_id, commit_sha, tree_hash, parent_shas, committed_at, history_state)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, commit_sha) DO UPDATE SET
         tree_hash=excluded.tree_hash, parent_shas=excluded.parent_shas,
         committed_at=excluded.committed_at, history_state=excluded.history_state`,
    ).run(
      input.repoId,
      input.commitSha,
      input.treeHash ?? null,
      JSON.stringify(input.parentShas),
      input.committedAt ?? null,
      input.historyState,
    );
  }

  createBuildingSnapshot(input: CreateSnapshotInput): RevisionSnapshot {
    const now = new Date().toISOString();
    const row = this.store.db.prepare(
      `INSERT INTO revision_snapshots
       (id, snapshot_key, repo_id, commit_sha, worktree_fingerprint, parser_version,
        resolver_version, schema_version, base_snapshot_id, merge_base_sha, state,
        created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?, ?)
       ON CONFLICT(snapshot_key) DO UPDATE SET last_accessed_at=excluded.last_accessed_at
       RETURNING *`,
    ).get(
      `snapshot_${randomUUID()}`,
      input.snapshotKey,
      input.repoId,
      input.commitSha ?? null,
      input.worktreeFingerprint ?? null,
      input.parserVersion,
      input.resolverVersion,
      input.schemaVersion,
      input.baseSnapshotId ?? null,
      input.mergeBaseSha ?? null,
      now,
      now,
    ) as SnapshotRow;
    return snapshotOf(row);
  }

  getSnapshot(snapshotId: string): RevisionSnapshot | null {
    const row = this.store.db.prepare("SELECT * FROM revision_snapshots WHERE id=? OR snapshot_key=?").get(snapshotId, snapshotId) as SnapshotRow | undefined;
    return row ? snapshotOf(row) : null;
  }

  markSnapshotReady(snapshotId: string): void {
    const result = this.store.db.prepare(
      "UPDATE revision_snapshots SET state='ready', published_at=COALESCE(published_at, ?), last_accessed_at=? WHERE id=? AND state='building'",
    ).run(new Date().toISOString(), new Date().toISOString(), snapshotId);
    if (result.changes !== 1) throw new Error(`snapshot ${snapshotId} is not building or does not exist`);
  }

  markSnapshotFailed(snapshotId: string, reason: string): void {
    this.store.db.prepare("UPDATE revision_snapshots SET state='failed', failure_reason=?, last_accessed_at=? WHERE id=? AND state='building'")
      .run(reason.slice(0, 2000), new Date().toISOString(), snapshotId);
  }

  publishSnapshot(input: { branchId: string; snapshotId: string; headCommit: string | null }): void {
    const tx = this.store.db.transaction(() => {
      const snapshot = this.store.db.prepare("SELECT * FROM revision_snapshots WHERE id=?").get(input.snapshotId) as SnapshotRow | undefined;
      if (!snapshot) throw new Error(`snapshot not found: ${input.snapshotId}`);
      if (snapshot.state !== "ready") throw new Error(`snapshot ${input.snapshotId} is not ready`);
      const branch = this.store.db.prepare("SELECT repo_id FROM branches WHERE id=?").get(input.branchId) as { repo_id: string } | undefined;
      if (!branch) throw new Error(`branch not found: ${input.branchId}`);
      if (branch.repo_id !== snapshot.repo_id) throw new Error("snapshot and branch belong to different repositories");
      const now = new Date().toISOString();
      const result = this.store.db.prepare(
        `UPDATE branches SET current_snapshot_id=?, head_commit=?, last_indexed_commit=?,
          last_indexed_at=?, indexed_schema_version=?, last_accessed_at=?, status='live'
         WHERE id=?`,
      ).run(input.snapshotId, input.headCommit, snapshot.commit_sha ?? input.headCommit, now, snapshot.schema_version, now, input.branchId);
      if (result.changes !== 1) throw new Error(`branch not found: ${input.branchId}`);
      this.store.db.prepare("UPDATE revision_snapshots SET last_accessed_at=? WHERE id=?").run(now, input.snapshotId);
    });
    tx();
  }

  pointBranchAtSnapshot(branchId: string, snapshotId: string): void {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot || snapshot.state !== "ready") throw new Error(`snapshot ${snapshotId} is not ready`);
    const branch = this.store.db.prepare("SELECT repo_id FROM branches WHERE id=?").get(branchId) as { repo_id: string } | undefined;
    if (!branch || branch.repo_id !== snapshot.repoId) throw new Error("snapshot and branch belong to different repositories");
    this.store.db.prepare("UPDATE branches SET current_snapshot_id=?, last_accessed_at=? WHERE id=?")
      .run(snapshotId, new Date().toISOString(), branchId);
  }

  pinDeployment(input: DeploymentRevision): void {
    this.store.db.prepare(
      `INSERT INTO deployment_revisions (target_id, repo_id, commit_sha, deployed_from, deployed_to, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_id, repo_id, deployed_from) DO UPDATE SET
         commit_sha=excluded.commit_sha, deployed_to=excluded.deployed_to, source=excluded.source`,
    ).run(input.targetId, input.repoId, input.commitSha, input.deployedFrom, input.deployedTo ?? null, input.source);
  }

  retainRevisionReference(input: RevisionReference): void {
    this.store.db.prepare(
      `INSERT INTO revision_references (ref_type, ref_key, repo_id, commit_sha, snapshot_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref_type, ref_key, repo_id, commit_sha) DO UPDATE SET snapshot_id=COALESCE(excluded.snapshot_id, revision_references.snapshot_id)`,
    ).run(input.refType, input.refKey, input.repoId, input.commitSha, input.snapshotId ?? null, new Date().toISOString());
  }

  releaseRevisionReference(input: RevisionReference): void {
    this.store.db.prepare(
      "DELETE FROM revision_references WHERE ref_type=? AND ref_key=? AND repo_id=? AND commit_sha=?",
    ).run(input.refType, input.refKey, input.repoId, input.commitSha);
  }

  referencesForRevision(repoId: string, commitSha: string): RevisionReference[] {
    const rows = this.store.db.prepare(
      "SELECT ref_type, ref_key, repo_id, commit_sha, snapshot_id FROM revision_references WHERE repo_id=? AND commit_sha=? ORDER BY ref_type, ref_key",
    ).all(repoId, commitSha) as Array<{ ref_type: RevisionReference["refType"]; ref_key: string; repo_id: string; commit_sha: string; snapshot_id: string | null }>;
    return rows.map((row) => ({ refType: row.ref_type, refKey: row.ref_key, repoId: row.repo_id, commitSha: row.commit_sha, ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}) }));
  }

  snapshotsForCommit(repoId: string, commitSha: string): RevisionSnapshot[] {
    return (this.store.db.prepare("SELECT * FROM revision_snapshots WHERE repo_id=? AND commit_sha=? ORDER BY created_at").all(repoId, commitSha) as SnapshotRow[]).map(snapshotOf);
  }
}
