import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, graphNeighborhood, repoGraph } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-gst-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

// Seed a frontend `invokes` edge (source_type="frontend_web") from a repo
// symbol to a global (repo-less, branch-less) gRPC endpoint node — same
// shape Task 6's frontend extractor produces via replaceFileEdges — then
// check graphNeighborhood surfaces sourceType on the edge (it centers on
// `a`, so the branch-less cross-service edge is included as a 1-hop
// neighbour regardless of repo/branch scoping).
function seedCrossService() {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "cp", rootPath: "/cp" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });

  const a = store.upsertNode({ nodeType: "symbol", identityKey: "cp::claim", repoId, title: "claim" });
  store.upsertSymbolVersion({
    nodeId: a, branchId, commitSha: "c0", filePath: "vm.tsx", lang: "ts", kind: "function",
    contentHash: "h_claim", status: "fresh",
  });
  const b = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "ep" });

  store.replaceFileEdges({
    repoId, branchId, filePath: "vm.tsx",
    edges: [{ src: a, dst: b, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true, sourceType: "frontend_web" }],
  });

  return { store, repoId, branchId, a, b };
}

test("graphNeighborhood: edges expose sourceType from frontend invokes edges", () => {
  const { store, a, b } = seedCrossService();
  const g = graphNeighborhood(store, a, { depth: 1 });
  const e = g.edges.find((x) => x.dst === b);
  assert.ok(e, "invokes edge to endpoint should be present");
  assert.equal(e.edgeType, "invokes");
  assert.equal(e.sourceType, "frontend_web");
  store.close();
});

// repoGraph shares the same collectGraph() SELECT as graphNeighborhood, so a
// same-repo, branch-scoped edge with a sourceType tag should also surface it
// (repoGraph's top-node ranking only includes nodes owned by the target
// repo, so this uses a same-repo pair rather than the cross-service one above).
test("repoGraph: edges expose sourceType (shares collectGraph with graphNeighborhood)", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "cp", rootPath: "/cp" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const mk = (name) => {
    const id = store.upsertNode({ nodeType: "symbol", identityKey: `cp::${name}`, repoId, title: name });
    store.upsertSymbolVersion({
      nodeId: id, branchId, commitSha: "c0", filePath: `${name}.tsx`, lang: "ts", kind: "function",
      contentHash: `h_${name}`, status: "fresh",
    });
    return id;
  };
  const caller = mk("caller");
  const callee = mk("callee");
  store.replaceFileEdges({
    repoId, branchId, filePath: "caller.tsx",
    edges: [{ src: caller, dst: callee, edgeType: "calls", origin: "parser", method: "EXTRACTED", sourceType: "frontend_web" }],
  });

  const g = repoGraph(store, repoId, branchId, { limit: 10 });
  const e = g.edges.find((x) => x.src === caller && x.dst === callee);
  assert.ok(e, "calls edge should be present");
  assert.equal(e.sourceType, "frontend_web");
  store.close();
});
