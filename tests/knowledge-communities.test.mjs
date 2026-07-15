import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, architecture, communities } from "../packages/knowledge-core/dist/index.js";

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
    return { name, ids, repoId, branchId };
  };
  const a = mkRepo("alpha", "a_");
  const b = mkRepo("beta", "b_");
  return { store, a, b };
}

test("communities recovers two disconnected clusters", () => {
  const { store, a, b } = seedTwoClusters();
  const res = communities(store, { minSize: 3 });
  assert.deepEqual(communities(store, { minSize: 3 }), res, "same graph produces a stable community result");
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

test("communities suppresses generic utility hubs and reports the diagnostic", () => {
  const { store, a, b } = seedTwoClusters();
  const hub = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${a.repoId}::Repository.findOne`,
    title: "findOne",
    repoId: a.repoId,
  });
  store.upsertSymbolVersion({
    nodeId: hub, branchId: a.branchId, commitSha: "c0", filePath: "hub.ts", lang: "ts",
    kind: "method", contentHash: "h_hub", status: "fresh",
  });
  store.replaceFileEdges({
    branchId: a.branchId,
    filePath: "hub.ts",
    edges: [...a.ids, ...b.ids].map((dst) => ({
      src: hub, dst, edgeType: "calls", origin: "parser", method: "INFERRED", confidence: 0.2,
    })),
  });

  const result = communities(store, { minSize: 3 });
  assert.equal(result.communities.length, 2, "utility hub must not merge unrelated modules");
  assert.ok(result.suppressedHubs.some((item) => item.title === "findOne" && item.reason === "generic_utility_name"));
  assert.ok(result.communities.every((community) =>
    community.topMembers.every((member) => member.title !== "findOne")));
  store.close();
});

test("community diagnostics report only material utility hubs and stay bounded", () => {
  const { store, a } = seedTwoClusters();
  const lowDegree = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${a.repoId}::tiny.get`,
    title: "get",
    repoId: a.repoId,
  });
  store.replaceFileEdges({
    branchId: a.branchId,
    filePath: "tiny.ts",
    edges: [{ src: lowDegree, dst: a.ids[0], edgeType: "calls", origin: "parser", method: "EXTRACTED" }],
  });

  const result = communities(store, { minSize: 3 });
  assert.ok(!result.suppressedHubs.some((item) => item.nodeId === lowDegree), "degree-1 utility is not a hub diagnostic");
  assert.ok(result.suppressedHubs.length <= 50, "diagnostics must remain bounded on large repositories");
  store.close();
});

test("architecture excludes high-degree translation and logging utility hubs", () => {
  const { store, a } = seedTwoClusters();
  for (const title of ["t", "$translate", "translate", "logError", "emitter"]) {
    const hub = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${a.repoId}::utility.${title}`,
      title,
      repoId: a.repoId,
    });
    store.replaceFileEdges({
      branchId: a.branchId,
      filePath: `${title}.ts`,
      edges: a.ids.map((dst) => ({ src: hub, dst, edgeType: "calls", origin: "parser", method: "EXTRACTED" })),
    });
  }

  const result = architecture(store);
  const hubNames = new Set(result.hubs.map((hub) => hub.title));
  for (const title of ["t", "$translate", "translate", "logError", "emitter"]) {
    assert.ok(!hubNames.has(title), `${title} must not dominate architecture hubs`);
  }
  store.close();
});
