import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { grpcEndpointKey } from "../packages/knowledge-indexer/dist/grpc-client.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-storefe-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

test("findNodeIdByIdentity + pending replay", () => {
  const store = openTemp();
  const src = store.upsertNode({ nodeType: "symbol", identityKey: "casino::useSF.claim", repoId: "cp", title: "claim" });

  assert.equal(store.findNodeIdByIdentity("nope::does-not-exist"), null);

  // endpoint does NOT exist yet → enqueue
  store.enqueuePendingFrontendEdge({ repoId: "cp", filePath: "vm.tsx", srcNodeId: src, service: "SkinFragment", functionName: "claimDailyFragment", sourceType: "frontend_web" });
  assert.equal(store.replayPendingFrontendEdges(), 0); // still no endpoint

  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  assert.equal(store.replayPendingFrontendEdges(), 1); // now replayed
  assert.equal(store.replayPendingFrontendEdges(), 0); // idempotent (row deleted)
  assert.equal(store.findNodeIdByIdentity(grpcEndpointKey("SkinFragment", "ClaimDailyFragment")), ep);

  const edge = store.db
    .prepare("SELECT * FROM edges WHERE src = ? AND dst = ?")
    .get(src, ep);
  assert.ok(edge, "invokes edge should exist");
  assert.equal(edge.edge_type, "invokes");
  assert.equal(edge.branch_id, null);
  assert.equal(edge.source_type, "frontend_web");

  store.close();
});
