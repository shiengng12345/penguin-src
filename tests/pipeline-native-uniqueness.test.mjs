// tests/pipeline-native-uniqueness.test.mjs
// Zero-config method-name uniqueness: NO `.penguin-frontend-grpc.json`
// anywhere. Facade wrappers (e.g. casino-plus-app PromotionService) whose
// methods span MULTIPLE backend proto services have no single enum→service
// mapping possible in a config-free world — every call site is resolved by
// METHOD NAME against backend endpoints, linking ONLY when a method name
// resolves to EXACTLY ONE backend service (skip ambiguous/missing —
// only-correct edges). This is now the ONLY linking mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { grpcEndpointKey } from "../packages/knowledge-indexer/dist/grpc-client.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-nu-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

// A native-style repo: `PromotionService` is a FACADE whose static methods
// forward 1:1 to `this._net.<name>(...)` but span multiple backend proto
// services (so there is no single enum→service mapping possible, config or
// not). No config file is written anywhere in this repo.
function nativeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "native-"));
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc", "wrapper.ts"), `
    export class PromotionService {
      // UNIQUE: exactly one backend service defines this method
      static getCurrentMissionConfig = (r) => this._net.getCurrentMissionConfig(r);
      // AMBIGUOUS: two backend services define this method
      static getPlayerTaskProgress = (r) => this._net.getPlayerTaskProgress(r);
      // MISSING: no backend service defines this method
      static getOrphanFeature = (r) => this._net.getOrphanFeature(r);
      // NOT a sole-forward (renames the RPC) — must never verify
      static claimReward = (r) => this._net.renamedClaimRpc(r);
    }
  `);
  writeFileSync(join(repo, "svc", "vm.tsx"), `
    export function usePromotion() {
      async function getCurrentMissionConfig() {
        return WebServices.requestApi({ functionName: 'getCurrentMissionConfig' });
      }
      async function getPlayerTaskProgress() {
        return WebServices.requestApi({ functionName: 'getPlayerTaskProgress' });
      }
      async function getOrphanFeature() {
        return WebServices.requestApi({ functionName: 'getOrphanFeature' });
      }
      async function claimReward() {
        return WebServices.requestApi({ functionName: 'claimReward' });
      }
      return { getCurrentMissionConfig, getPlayerTaskProgress, getOrphanFeature, claimReward };
    }
  `);
  return repo;
}

test("UNIQUE: method resolves to exactly one backend service → invokes edge", async () => {
  const store = openStore();
  const ep = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("FrontendSpecialEventService", "GetCurrentMissionConfig"),
    repoId: null, title: "ep",
  });
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  const edges = store.db.prepare("SELECT edge_type, source_type FROM edges WHERE dst = ?").all(ep);
  assert.ok(edges.some((e) => e.edge_type === "invokes" && e.source_type === "frontend_web"));
  store.close();
});

test("AMBIGUOUS: method exists in TWO backend services → no edge", async () => {
  const store = openStore();
  const epA = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("ServiceA", "GetPlayerTaskProgress"),
    repoId: null, title: "epA",
  });
  const epB = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("ServiceB", "GetPlayerTaskProgress"),
    repoId: null, title: "epB",
  });
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  const edgesA = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ?").get(epA);
  const edgesB = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ?").get(epB);
  assert.equal(edgesA.c, 0);
  assert.equal(edgesB.c, 0);
  store.close();
});

test("UNVERIFIED: functionName not a sole-forward wrapper method → no edge", async () => {
  const store = openStore();
  // Backend endpoint DOES exist for the renamed RPC target, but that's
  // irrelevant — claimReward is a rename (not a sole forward), so it must
  // never even reach the uniqueness lookup.
  const ep = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("FrontendLeaderboardService", "RenamedClaimRpc"),
    repoId: null, title: "ep",
  });
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ?").get(ep).c, 0);
  store.close();
});

test("MISSING: method has zero backend endpoints → no edge, no crash", async () => {
  const store = openStore();
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  const n = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE source_type = 'frontend_web'").get();
  assert.equal(n.c, 0);
  store.close();
});

test("idempotent: index twice → exactly one edge", async () => {
  const store = openStore();
  const ep = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("FrontendSpecialEventService", "GetCurrentMissionConfig"),
    repoId: null, title: "ep",
  });
  const repo = nativeRepo();
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  const n = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ? AND edge_type = 'invokes'").get(ep);
  assert.equal(n.c, 1, "exactly one invokes edge despite two index runs");
  store.close();
});

// ── Order-independence: a native frontend repo may be indexed BEFORE its
// backend (fresh-clone / new-user scenario). The uniqueness stitch must
// persist a deferred row (service="") rather than silently dropping the call
// site, so a LATER backend index recovers the edge.
test("ORDER-INDEPENDENCE: frontend indexed before backend → deferred row, then replay materializes edge", async () => {
  const store = openStore();
  // No backend endpoint exists yet at index time.
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  const before = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE source_type = 'frontend_web'").get();
  assert.equal(before.c, 0, "no edge yet: backend not indexed");
  const pendingBefore = store.db
    .prepare("SELECT * FROM pending_frontend_edges WHERE function_name = ?")
    .all("getCurrentMissionConfig");
  assert.equal(pendingBefore.length, 1, "deferred pending row persisted for the UNIQUE-but-missing method");
  assert.equal(pendingBefore[0].service, "", 'service="" is the resolve-by-method-later marker');

  // Backend now appears (e.g. a later index of the backend repo).
  const ep = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("FrontendSpecialEventService", "GetCurrentMissionConfig"),
    repoId: null, title: "ep",
  });
  const replayed = store.replayPendingFrontendEdges();
  assert.ok(replayed >= 1);
  const edges = store.db.prepare("SELECT edge_type, source_type FROM edges WHERE dst = ?").all(ep);
  assert.ok(edges.some((e) => e.edge_type === "invokes" && e.source_type === "frontend_web"), "edge now exists");
  const pendingAfter = store.db
    .prepare("SELECT * FROM pending_frontend_edges WHERE function_name = ?")
    .all("getCurrentMissionConfig");
  assert.equal(pendingAfter.length, 0, "pending row consumed");
  store.close();
});

test("ORDER-INDEPENDENCE: deferred miss that later becomes AMBIGUOUS → row deleted, no edge", async () => {
  const store = openStore();
  // No backend endpoint exists yet → deferred row queued for getCurrentMissionConfig.
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  const pendingBefore = store.db
    .prepare("SELECT * FROM pending_frontend_edges WHERE function_name = ?")
    .all("getCurrentMissionConfig");
  assert.equal(pendingBefore.length, 1);

  // TWO backend services now define this method → ambiguous.
  const epA = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("ServiceX", "GetCurrentMissionConfig"),
    repoId: null, title: "epA",
  });
  const epB = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("ServiceY", "GetCurrentMissionConfig"),
    repoId: null, title: "epB",
  });
  store.replayPendingFrontendEdges();

  const pendingAfter = store.db
    .prepare("SELECT * FROM pending_frontend_edges WHERE function_name = ?")
    .all("getCurrentMissionConfig");
  assert.equal(pendingAfter.length, 0, "ambiguous deferred row is dropped, not left pending forever");
  const edgesA = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ?").get(epA);
  const edgesB = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ?").get(epB);
  assert.equal(edgesA.c, 0, "never link an ambiguous edge");
  assert.equal(edgesB.c, 0, "never link an ambiguous edge");
  store.close();
});

test("ORDER-INDEPENDENCE: deferred miss still missing on replay → row remains for later", async () => {
  const store = openStore();
  await indexRepo({ store, rootPath: nativeRepo(), mode: "incremental" });
  const pendingBefore = store.db
    .prepare("SELECT * FROM pending_frontend_edges WHERE function_name = ?")
    .all("getCurrentMissionConfig");
  assert.equal(pendingBefore.length, 1);

  // No backend endpoint appears — replay again, still 0 services.
  store.replayPendingFrontendEdges();
  const pendingAfter = store.db
    .prepare("SELECT * FROM pending_frontend_edges WHERE function_name = ?")
    .all("getCurrentMissionConfig");
  assert.equal(pendingAfter.length, 1, "row kept for a still-later replay");
  assert.equal(pendingAfter[0].service, "");
  store.close();
});

test("store unit: findEndpointServicesByMethod — unique / ambiguous / none", () => {
  const store = openStore();
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("UniqueSvc", "SoloMethod"), repoId: null, title: "ep1" });
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SvcA", "SharedMethod"), repoId: null, title: "ep2" });
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SvcB", "SharedMethod"), repoId: null, title: "ep3" });

  assert.deepEqual(store.findEndpointServicesByMethod("solomethod"), ["UniqueSvc"]);
  const shared = store.findEndpointServicesByMethod("sharedmethod").sort();
  assert.deepEqual(shared, ["SvcA", "SvcB"]);
  assert.deepEqual(store.findEndpointServicesByMethod("nonexistentmethod"), []);

  // must not false-positive on suffix-only similarity (e.g. "bx" vs "x")
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SvcC", "GetBx"), repoId: null, title: "ep4" });
  assert.deepEqual(store.findEndpointServicesByMethod("x"), []);

  store.close();
});
