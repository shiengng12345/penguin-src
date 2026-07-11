// tests/pipeline-native-uniqueness.test.mjs
// Native method-name uniqueness mode: facade wrappers (e.g. casino-plus-app
// PromotionService) whose methods span MULTIPLE backend proto services. No
// single enum→service mapping exists, so the stitch resolves by METHOD NAME
// against backend endpoints, linking ONLY when a method name resolves to
// EXACTLY ONE backend service (skip ambiguous/missing — only-correct edges).
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
// services (so there is no single enum→service mapping possible).
function nativeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "native-"));
  writeFileSync(join(repo, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: {},
    wrappers: {},
    methodNameResolution: {
      enums: ["NT_SERVICE_INTERFACE.PROMOTION"],
      wrappers: ["PromotionService"],
    },
  }));
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
        return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.PROMOTION, functionName: 'getCurrentMissionConfig' });
      }
      async function getPlayerTaskProgress() {
        return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.PROMOTION, functionName: 'getPlayerTaskProgress' });
      }
      async function getOrphanFeature() {
        return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.PROMOTION, functionName: 'getOrphanFeature' });
      }
      async function claimReward() {
        return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.PROMOTION, functionName: 'claimReward' });
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
