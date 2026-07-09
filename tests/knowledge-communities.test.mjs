import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, communities } from "../packages/knowledge-core/dist/index.js";

// Two densely-linked clusters (one per repo) with NO edge between them → label
// propagation must recover exactly two communities.
function seedTwoClusters() {
  const dir = mkdtempSync(join(tmpdir(), "pk-comm-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const mkRepo = (name, prefix) => {
    const repoId = store.registerRepo({ name, rootPath: `/${name}` });
    const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
    const ids = ["x", "y", "z"].map((s) => {
      const nm = `${prefix}${s}`;
      const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${nm}`, title: nm, repoId });
      store.upsertSymbolVersion({
        nodeId: id, branchId, commitSha: "c0", filePath: "f.ts", lang: "ts", kind: "function",
        contentHash: `h_${nm}`, status: "fresh",
      });
      return id;
    });
    store.upsertFileCheckpoint({ repoId, branchId, filePath: "f.ts", lang: "ts", status: "indexed" });
    // fully connect the three within the cluster
    store.replaceFileEdges({ branchId, filePath: "f.ts", edges: [
      { src: ids[0], dst: ids[1], edgeType: "calls", origin: "parser", method: "EXTRACTED" },
      { src: ids[1], dst: ids[2], edgeType: "calls", origin: "parser", method: "EXTRACTED" },
      { src: ids[2], dst: ids[0], edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    ] });
    return { name, ids };
  };
  const a = mkRepo("alpha", "a_");
  const b = mkRepo("beta", "b_");
  return { store, a, b };
}

test("communities recovers two disconnected clusters", () => {
  const { store, a, b } = seedTwoClusters();
  const res = communities(store, { minSize: 3 });
  assert.equal(res.communities.length, 2, "two communities");
  const repos = res.communities.map((c) => c.repos[0]).sort();
  assert.deepEqual(repos, [a.name, b.name].sort());
  for (const c of res.communities) {
    assert.equal(c.size, 3);
    assert.ok(c.topMembers.length === 3, "god node + members listed");
    assert.ok(c.topMembers[0].degree >= c.topMembers[c.topMembers.length - 1].degree, "sorted by degree");
  }
  store.close();
});

test("communities honors minSize (drops tiny clusters)", () => {
  const { store } = seedTwoClusters();
  const res = communities(store, { minSize: 4 }); // each cluster is only 3
  assert.equal(res.communities.length, 0);
  store.close();
});
