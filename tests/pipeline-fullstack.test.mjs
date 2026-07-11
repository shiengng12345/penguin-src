// tests/pipeline-fullstack.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { grpcEndpointKey } from "../packages/knowledge-indexer/dist/grpc-client.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-fs-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function cpRepo() {
  const repo = mkdtempSync(join(tmpdir(), "cp-"));
  writeFileSync(join(repo, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
    wrappers: { "SkinFragment": "NtSkinFragmentService" },
  }));
  mkdirSync(join(repo, "svc"), { recursive: true });
  // wrapper (1:1) — required for the verified gate
  writeFileSync(join(repo, "svc", "wrapper.ts"),
    `export class NtSkinFragmentService { static claimDailyFragment = (r) => this._net.claimDailyFragment(r) }`);
  // real call shape: functionName + requestParam
  writeFileSync(join(repo, "svc", "vm.tsx"),
    `export function useSF(){ async function claim(){ return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: 'claimDailyFragment' }) } return {claim} }`);
  return repo;
}

test("golden trace: endpoint exists first → edge emitted", async () => {
  const store = openStore();
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  await indexRepo({ store, rootPath: cpRepo(), mode: "incremental" });
  const edges = store.db.prepare("SELECT edge_type, source_type FROM edges WHERE dst = ?").all(ep);
  assert.ok(edges.some((e) => e.edge_type === "invokes" && e.source_type === "frontend_web"));
  store.close();
});

test("deferred: frontend first, endpoint later → replay links it", async () => {
  const store = openStore();
  await indexRepo({ store, rootPath: cpRepo(), mode: "incremental" });
  // endpoint appears later (e.g. flyover indexed after)
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  assert.equal(store.replayPendingFrontendEdges(), 1);
  store.close();
});

test("no wrapper verification → no edge, no pending", async () => {
  const store = openStore();
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  const repo = cpRepo();
  writeFileSync(join(repo, "svc", "wrapper.ts"), `export class NtSkinFragmentService { static claimDailyFragment = (r) => this._net.renamedRpc(r) }`);
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  const n = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE source_type = 'frontend_web'").get();
  assert.equal(n.c, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM pending_frontend_edges").get().c, 0);
  store.close();
});

test("re-index a frontend file twice before endpoint exists → no duplicate pending rows", async () => {
  const store = openStore();
  const repo = cpRepo();
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  // touch the frontend file so it's reparsed (content changes → hash changes)
  writeFileSync(join(repo, "svc", "vm.tsx"),
    `export function useSF(){ async function claim(){ return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: 'claimDailyFragment' }) } return {claim} }\n// touch`);
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  const n = store.db.prepare("SELECT COUNT(*) c FROM pending_frontend_edges").get();
  assert.equal(n.c, 1, "exactly one pending row despite two parses");
  store.close();
});

test("incremental re-parse of ONLY the caller file (wrapper unchanged, checkpoint-skipped) does not wipe a confirmed edge", async () => {
  const store = openStore();
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  const repo = cpRepo();
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  const before = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ? AND edge_type='invokes'").get(ep);
  assert.equal(before.c, 1, "edge confirmed on first index");

  // Only the call-site file changes; wrapper.ts is untouched so its checkpoint
  // (mtime+size unchanged) causes the incremental quick-filter to SKIP
  // reprocessing it — verifiedMethodsByService must still be correct.
  writeFileSync(join(repo, "svc", "vm.tsx"),
    `export function useSF(){ async function claim(){ return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: 'claimDailyFragment' }) } return {claim} }\n// unrelated touch`);
  await indexRepo({ store, rootPath: repo, mode: "incremental" });

  const after = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE dst = ? AND edge_type='invokes'").get(ep);
  assert.equal(after.c, 1, "edge still present after caller-only reparse (wrapper file was checkpoint-skipped)");
  store.close();
});
