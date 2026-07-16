import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodeVersionResolver, GitTopologyStore, KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-code-version-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "fpms", rootPath: dir });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live", headCommit: "sha-live" });
  return { store, repoId, branchId };
}

test("code version resolver prefers log commit, deployment interval, indexed commit, branch, then degraded live", async () => {
  const { store, repoId } = fixture();
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({ snapshotKey: "sha-indexed", repoId, commitSha: "sha-indexed", parserVersion: "p", resolverVersion: "r", schemaVersion: 9 });
  topology.markSnapshotReady(snapshot.id);
  topology.pinDeployment({ targetId: "platform-fpms-uat", repoId, commitSha: "sha-deployed", deployedFrom: "2026-01-01T00:00:00Z", deployedTo: "2026-12-31T00:00:00Z", source: "fixture" });
  let calls = 0;
  const resolver = new CodeVersionResolver({ store, materializeCommit: async ({ repoId: id, commitSha }) => { calls++; return { repoId: id, commitSha, snapshotId: `materialized:${commitSha}`, trust: "exact_commit" }; } });
  assert.equal((await resolver.resolve({ repoId, observedAt: "2026-06-01T00:00:00Z", logCommitSha: "sha-log", targetId: "platform-fpms-uat" })).source, "log_commit");
  assert.equal((await resolver.resolve({ repoId, observedAt: "2026-06-01T00:00:00Z", targetId: "platform-fpms-uat" })).source, "deployment_record");
  assert.equal((await resolver.resolve({ repoId, observedAt: "2027-06-01T00:00:00Z" })).source, "indexed_commit");
  assert.equal(calls, 2);
  store.close();
});
