import type { KnowledgeStore } from "./store.js";

export interface RevisionRetentionPolicy {
  maxHotFeatureViews: number;
  coldAfterDays: number;
  deletedBranchRecoveryDays: number;
  factGcGraceDays: number;
}
export const DEFAULT_REVISION_RETENTION: RevisionRetentionPolicy = { maxHotFeatureViews: 20, coldAfterDays: 14, deletedBranchRecoveryDays: 30, factGcGraceDays: 7 };
export interface RevisionCollectionPlan {
  keep: Array<{ snapshotId: string; reasons: string[] }>;
  cool: Array<{ snapshotId: string; reason: string }>;
  collect: Array<{ snapshotId: string; reason: string }>;
  factsToCollect: string[];
  resolutionSetsToCollect: string[];
  policy: RevisionRetentionPolicy;
}
export interface RevisionCollectionApplyResult {
  cooledSnapshotIds: string[];
  collectedSnapshotIds: string[];
  collectedFactIds: string[];
  collectedResolutionSetIds: string[];
  skipped: Array<{ id: string; reason: "reference_changed" | "lock_unavailable" | "not_collectible" }>;
}

type Snapshot = { id: string; state: string; repo_id: string; created_at: string; last_accessed_at: string; pinned: number; base_snapshot_id: string | null };

export function planRevisionCollection(store: KnowledgeStore, repoId: string, policy: RevisionRetentionPolicy = DEFAULT_REVISION_RETENTION): RevisionCollectionPlan {
  const snapshots = store.db.prepare("SELECT id,state,repo_id,created_at,last_accessed_at,pinned,base_snapshot_id FROM revision_snapshots WHERE repo_id=? AND state IN ('ready','cold') ORDER BY last_accessed_at DESC, id").all(repoId) as Snapshot[];
  const reasons = new Map<string, Set<string>>();
  const protect = (id: string, reason: string) => { if (!reasons.has(id)) reasons.set(id, new Set()); reasons.get(id)!.add(reason); };
  for (const row of store.db.prepare("SELECT current_snapshot_id, default_branch, pinned, status, deleted_at, recover_until FROM branches WHERE repo_id=?").all(repoId) as Array<{ current_snapshot_id: string | null; default_branch: number; pinned: number; status: string; deleted_at: string | null; recover_until: string | null }>) {
    if (!row.current_snapshot_id) continue;
    if (row.default_branch === 1) protect(row.current_snapshot_id, "default");
    if (row.pinned === 1) protect(row.current_snapshot_id, "pinned");
    if (row.status === "live") protect(row.current_snapshot_id, "live_branch");
    if (row.recover_until && Date.parse(row.recover_until) > Date.now()) protect(row.current_snapshot_id, "deleted_branch_recovery");
    if (row.deleted_at && !row.recover_until) protect(row.current_snapshot_id, "deleted_branch");
  }
  for (const row of store.db.prepare("SELECT snapshot_id FROM revision_references WHERE repo_id=? AND snapshot_id IS NOT NULL").all(repoId) as Array<{ snapshot_id: string }>) protect(row.snapshot_id, "reference");
  for (const row of store.db.prepare("SELECT id FROM revision_snapshots WHERE repo_id=? AND pinned=1").all(repoId) as Array<{ id: string }>) protect(row.id, "snapshot_pin");
  for (const row of store.db.prepare("SELECT s.id FROM revision_snapshots s JOIN deployment_revisions d ON d.repo_id=s.repo_id AND d.commit_sha=s.commit_sha WHERE s.repo_id=?").all(repoId) as Array<{ id: string }>) protect(row.id, "deployed");
  for (const row of snapshots) if (snapshots.some((candidate) => candidate.base_snapshot_id === row.id)) protect(row.id, "overlay_base");

  const unprotected = snapshots.filter((row) => !reasons.has(row.id) && row.state === "ready");
  for (const row of unprotected.slice(0, policy.maxHotFeatureViews)) protect(row.id, "hot_feature_limit");
  const keep = [...reasons.entries()].map(([snapshotId, values]) => ({ snapshotId, reasons: [...values].sort() }));
  const cool: RevisionCollectionPlan["cool"] = [], collect: RevisionCollectionPlan["collect"] = [];
  const cutoff = Date.now() - policy.coldAfterDays * 86400000;
  for (const row of unprotected.slice(policy.maxHotFeatureViews)) {
    if (Date.parse(row.last_accessed_at) >= cutoff) cool.push({ snapshotId: row.id, reason: "exceeds_hot_feature_limit" });
    else collect.push({ snapshotId: row.id, reason: "cold_and_unreferenced" });
  }
  const keptIds = new Set(keep.map((item) => item.snapshotId));
  const factsToCollect = (store.db.prepare("SELECT f.id FROM file_facts f WHERE f.repo_id=? AND f.created_at < ? AND NOT EXISTS (SELECT 1 FROM effective_snapshot_files e JOIN revision_snapshots s ON s.id=e.snapshot_id WHERE e.file_fact_id=f.id AND s.id IN (" + (keptIds.size ? [...keptIds].map(() => "?").join(",") : "NULL") + "))").all(repoId, new Date(Date.now() - policy.factGcGraceDays * 86400000).toISOString(), ...keptIds) as Array<{ id: string }>).map((row) => row.id);
  const resolutionSetsToCollect = (store.db.prepare("SELECT rs.id FROM resolution_sets rs WHERE rs.created_at < ? AND NOT EXISTS (SELECT 1 FROM snapshot_resolution_refs r WHERE r.resolution_set_id=rs.id AND r.snapshot_id IN (" + (keptIds.size ? [...keptIds].map(() => "?").join(",") : "NULL") + "))").all(new Date(Date.now() - policy.factGcGraceDays * 86400000).toISOString(), ...keptIds) as Array<{ id: string }>).map((row) => row.id);
  return { keep, cool, collect, factsToCollect, resolutionSetsToCollect, policy };
}

export function applyRevisionCollection(store: KnowledgeStore, plan: RevisionCollectionPlan): RevisionCollectionApplyResult {
  const cooledSnapshotIds: string[] = [], collectedSnapshotIds: string[] = [], skipped: RevisionCollectionApplyResult["skipped"] = [];
  const tx = store.db.transaction(() => {
    for (const item of plan.cool) {
      const result = store.db.prepare("UPDATE revision_snapshots SET state='cold', last_accessed_at=? WHERE id=? AND state='ready' AND NOT EXISTS (SELECT 1 FROM branches WHERE current_snapshot_id=? )").run(new Date().toISOString(), item.snapshotId, item.snapshotId);
      if (result.changes) cooledSnapshotIds.push(item.snapshotId); else skipped.push({ id: item.snapshotId, reason: "reference_changed" });
    }
    for (const item of plan.collect) {
      const result = store.db.prepare("DELETE FROM revision_snapshots WHERE id=? AND state='cold' AND NOT EXISTS (SELECT 1 FROM branches WHERE current_snapshot_id=? ) AND NOT EXISTS (SELECT 1 FROM revision_references WHERE snapshot_id=? ) AND NOT EXISTS (SELECT 1 FROM revision_snapshots WHERE base_snapshot_id=? )").run(item.snapshotId, item.snapshotId, item.snapshotId, item.snapshotId);
      if (result.changes) { collectedSnapshotIds.push(item.snapshotId); store.db.prepare("DELETE FROM effective_snapshot_files WHERE snapshot_id=?").run(item.snapshotId); store.db.prepare("DELETE FROM snapshot_overlays WHERE snapshot_id=?").run(item.snapshotId); store.db.prepare("DELETE FROM snapshot_rename_events WHERE snapshot_id=?").run(item.snapshotId); store.db.prepare("DELETE FROM snapshot_resolution_refs WHERE snapshot_id=?").run(item.snapshotId); } else skipped.push({ id: item.snapshotId, reason: "reference_changed" });
    }
    for (const id of plan.resolutionSetsToCollect) { const used = store.db.prepare("SELECT 1 FROM snapshot_resolution_refs WHERE resolution_set_id=? UNION SELECT 1 FROM resolution_sets WHERE id=? AND created_at >= ?").get(id, id, new Date(Date.now() - plan.policy.factGcGraceDays * 86400000).toISOString()); if (used) skipped.push({ id, reason: "not_collectible" }); else { store.db.prepare("DELETE FROM resolved_edges WHERE resolution_set_id=?").run(id); store.db.prepare("DELETE FROM resolution_sets WHERE id=?").run(id); } }
    for (const id of plan.factsToCollect) { const used = store.db.prepare("SELECT 1 FROM effective_snapshot_files WHERE file_fact_id=?").get(id); if (used) skipped.push({ id, reason: "not_collectible" }); else { store.db.prepare("DELETE FROM file_fact_symbols WHERE file_fact_id=?").run(id); store.db.prepare("DELETE FROM file_facts WHERE id=?").run(id); } }
  }); tx();
  return { cooledSnapshotIds, collectedSnapshotIds, collectedFactIds: plan.factsToCollect.filter((id) => !store.db.prepare("SELECT 1 FROM file_facts WHERE id=?").get(id)), collectedResolutionSetIds: plan.resolutionSetsToCollect.filter((id) => !store.db.prepare("SELECT 1 FROM resolution_sets WHERE id=?").get(id)), skipped };
}
