import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, buildExplorePack, GitTopologyStore } from "../packages/knowledge-core/dist/index.js";

test("[explain-repo-scope] Explore candidates honor the repository carried by an explicit revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-explore-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  try {
    const repoA = store.registerRepo({ name: "repo-a", rootPath: join(dir, "repo-a") });
    const repoB = store.registerRepo({ name: "repo-b", rootPath: join(dir, "repo-b") });
    const branchA = store.registerBranch({ repoId: repoA, name: "main", status: "live" });
    const snapshotA = new GitTopologyStore(store).createBuildingSnapshot({
      snapshotKey: "explore-scope-a",
      repoId: repoA,
      parserVersion: "p",
      resolverVersion: "r",
      schemaVersion: 17,
    });
    store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run(snapshotA.id, branchA);
    const local = store.upsertNode({ nodeType: "symbol", identityKey: `${repoA}::src/local.ts::SharedExploreTarget`, repoId: repoA, title: "SharedExploreTarget" });
    const foreign = store.upsertNode({ nodeType: "symbol", identityKey: `${repoB}::src/foreign.ts::SharedExploreTarget`, repoId: repoB, title: "SharedExploreTarget" });

    const result = buildExplorePack(store, "SharedExploreTarget", {
      revision: {
        repoId: repoA,
        branchId: branchA,
        commitSha: "explore-scope-a",
        snapshotId: snapshotA.id,
        trust: "exact_commit",
      },
    });

    assert.equal(result.focus?.nodeId, local, JSON.stringify(result));
    assert.notEqual(result.focus?.nodeId, foreign, JSON.stringify(result));
    assert.equal(result.ambiguousCandidates, undefined, JSON.stringify(result));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
