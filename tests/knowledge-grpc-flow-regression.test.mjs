// tests/knowledge-grpc-flow-regression.test.mjs
// Regression coverage for the reported bug: penguin context/search/flow could
// not deal with a NestJS gRPC handler whose bare method name (getPlayerProfileByJwt)
// is shared by 4 unrelated symbols across 2 distinct @GrpcMethod services.
// Covers the 8 explicitly-required scenarios (symbol disambiguation tests 1/2/3/7
// live in tests/knowledge-symbol-disambiguation.test.mjs; this file covers the
// gRPC-route-specific 4/5/6, plus 8 — the internal-assembly-failure case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import {
  buildFlow, renderFlowMarkdown, resolveGrpcEndpoint, buildContextPack,
} from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-grpcflow-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

// Real-shape repro: two services (FrontendPlayerService, PlayerService) each
// exposing a gRPC method named identically (GetPlayerProfileByJwt); the
// Frontend one's handler calls a constructor-injected processor, which in
// turn calls a constructor-injected SPI provider, which calls a repository —
// the exact chain the user's spec says `flow` must be able to walk.
async function grpcRepo() {
  const root = mkdtempSync(join(tmpdir(), "pk-grpcflow-src-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "frontend-player.controller.ts"), `
import { GrpcMethod } from '@nestjs/microservices';
import { GetPlayerProfileByJwtProcessor } from './get-player-profile-by-jwt-processor';
export class FrontendPlayerController {
  constructor(private readonly getPlayerProfileByJwtProcessor: GetPlayerProfileByJwtProcessor) {}
  @GrpcMethod('FrontendPlayerService', 'GetPlayerProfileByJwt')
  async getPlayerProfileByJwt(data) {
    return this.getPlayerProfileByJwtProcessor.getPlayerProfileByJwt(data);
  }
}
`);
  writeFileSync(join(root, "src", "player.controller.ts"), `
import { GrpcMethod } from '@nestjs/microservices';
export class PlayerController {
  @GrpcMethod('PlayerService', 'GetPlayerProfileByJwt')
  async getPlayerProfileByJwt(data) { return { ok: true }; }
}
`);
  writeFileSync(join(root, "src", "get-player-profile-by-jwt-processor.ts"), `
import { BpPlayerProfileProvider } from './bp-player-profile-provider';
export class GetPlayerProfileByJwtProcessor {
  constructor(private readonly bpPlayerProfileProvider: BpPlayerProfileProvider) {}
  async getPlayerProfileByJwt(data) {
    return this.bpPlayerProfileProvider.buildProfile(data);
  }
}
`);
  writeFileSync(join(root, "src", "bp-player-profile-provider.ts"), `
import { PlayerLoginRecordRepository } from './player-login-record.repository';
export class BpPlayerProfileProvider {
  constructor(private readonly playerLoginRecordRepository: PlayerLoginRecordRepository) {}
  async buildProfile(data) {
    return this.playerLoginRecordRepository.getPreviousLoginInfoByPlayer(data);
  }
}
`);
  writeFileSync(join(root, "src", "player-login-record.repository.ts"), `
export class PlayerLoginRecordRepository {
  async getPreviousLoginInfoByPlayer(data) { return { lastLogin: null }; }
}
`);
  const store = openStore();
  const r = await indexRepo({ store, rootPath: root, mode: "incremental" });
  return { store, root, repoId: r.repoId };
}

// Scenario 4: @GrpcMethod('Service','Method') generates an endpoint → handler edge.
test("@GrpcMethod(service, method) generates a global endpoint -> handler `handles` edge", async () => {
  const { store } = await grpcRepo();
  const ep = store.db
    .prepare("SELECT id, repo_id FROM nodes WHERE node_type='endpoint' AND identity_key='grpc::FrontendPlayerService.getplayerprofilebyjwt'")
    .get();
  assert.ok(ep, "global gRPC endpoint node exists");
  assert.equal(ep.repo_id, null, "endpoint is repo-less/global (shared across services)");
  const handler = store.db
    .prepare("SELECT id FROM nodes WHERE node_type='symbol' AND identity_key LIKE ?")
    .get("%::FrontendPlayerController.getPlayerProfileByJwt");
  assert.ok(handler, "handler symbol indexed");
  const handles = store.db
    .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='handles' AND src=? AND dst=? AND status='active'")
    .get(ep.id, handler.id);
  assert.equal(handles.n, 1, "endpoint -handles-> handler edge exists");
  store.close();
});

// Scenario 5: package-qualified gRPC path variants all resolve to the SAME endpoint node.
test("bare/dot/single-slash/double-slash route formats all resolve to the same endpoint", async () => {
  const { store } = await grpcRepo();
  const dot = resolveGrpcEndpoint(store, "FrontendPlayerService.GetPlayerProfileByJwt");
  const slash1 = resolveGrpcEndpoint(store, "/player.FrontendPlayerService/GetPlayerProfileByJwt");
  const slash2 = resolveGrpcEndpoint(store, "/player/player.FrontendPlayerService/GetPlayerProfileByJwt");
  assert.equal(dot.kind, "unique");
  assert.equal(slash1.kind, "unique");
  assert.equal(slash2.kind, "unique");
  assert.equal(dot.nodeId, slash1.nodeId, "dot-form and single-slash resolve to the same node");
  assert.equal(dot.nodeId, slash2.nodeId, "dot-form and double-slash resolve to the same node");

  const literal = resolveGrpcEndpoint(store, "grpc::FrontendPlayerService.getplayerprofilebyjwt");
  assert.equal(literal.kind, "unique");
  assert.equal(literal.nodeId, dot.nodeId, "literal identity key matches too");
  store.close();
});

// Scenario 6: handler -> injected processor method call edge is walked by flow,
// through processor -> SPI provider -> repository (the full chain from the spec).
test("flow walks endpoint -> handler -> injected processor -> provider -> repository", async () => {
  const { store, repoId } = await grpcRepo();
  // node.title is just the bare method name (e.g. "getPlayerProfileByJwt") —
  // identity_key carries the class-qualified name, so look up expected node
  // ids by the source-qualified name rather than matching on title text.
  const idFor = (suffix) => {
    const rows = store.db.prepare(
      "SELECT id FROM nodes WHERE repo_id=? AND json_extract(meta, '$.qualifiedName')=?",
    ).all(repoId, suffix);
    assert.equal(rows.length, 1, `expected one node for qualified name ${suffix}`);
    const row = rows[0];
    return row.id;
  };
  const handlerId = idFor("FrontendPlayerController.getPlayerProfileByJwt");
  const processorId = idFor("GetPlayerProfileByJwtProcessor.getPlayerProfileByJwt");
  const providerId = idFor("BpPlayerProfileProvider.buildProfile");
  const repoMethodId = idFor("PlayerLoginRecordRepository.getPreviousLoginInfoByPlayer");

  for (const target of [
    // NOTE: the bare method name "GetPlayerProfileByJwt" is deliberately NOT
    // included here — both services expose it, so it's legitimately ambiguous
    // (covered by the dedicated "ambiguous" test below), not a unique flow.
    "FrontendPlayerService.GetPlayerProfileByJwt",
    "/player.FrontendPlayerService/GetPlayerProfileByJwt",
    "/player/player.FrontendPlayerService/GetPlayerProfileByJwt",
  ]) {
    const flow = buildFlow(store, target);
    assert.ok(flow.root, `flow resolves for "${target}"`);
    const nodeIds = flow.steps.map((s) => s.nodeId);
    assert.ok(nodeIds.includes(handlerId), `${target}: reaches controller handler`);
    assert.ok(nodeIds.includes(processorId), `${target}: reaches processor`);
    assert.ok(nodeIds.includes(providerId), `${target}: reaches SPI provider`);
    assert.ok(nodeIds.includes(repoMethodId), `${target}: reaches repository`);
    assert.ok(flow.steps.filter((step) => step.nodeType === "symbol").every((step) => step.source?.filePath && step.source.startLine > 0), `${target}: every cross-service hop carries source`);
  }
  store.close();
});

// Scenario 5b (documented via Goal 4): a bare method name shared by 2 services
// is an ambiguous flow target, not silently resolved to one and not "no flow".
test("flow on the bare shared method name reports ambiguous, with Did-you-mean candidates", async () => {
  const { store } = await grpcRepo();
  const flow = buildFlow(store, "getPlayerProfileByJwt");
  assert.equal(flow.root, null);
  assert.equal(flow.diagnostic?.reason, "ambiguous");
  assert.ok(flow.ambiguous?.length >= 2, "both services surfaced as candidates");
  const md = renderFlowMarkdown(flow);
  assert.match(md, /Multiple symbols found/);
  store.close();
});

// Goal 4: unrecognized-format / truly-missing gRPC route gives a specific diagnostic.
test("flow on a nonexistent route gives a not_indexed diagnostic, not a bare failure", async () => {
  const { store } = await grpcRepo();
  const flow = buildFlow(store, "/totally.MadeUpService/NoSuchMethod");
  assert.equal(flow.root, null);
  assert.equal(flow.diagnostic?.reason, "not_indexed");
  assert.match(flow.diagnostic.message, /MadeUpService/);
  store.close();
});

// Goal 4: an endpoint that resolves uniquely but has no handler edge yet.
test("flow on an endpoint with no handler gives an endpoint_no_handler diagnostic", async () => {
  const { store } = await grpcRepo();
  store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::OrphanService.orphanmethod", title: "gRPC OrphanService.OrphanMethod" });
  const flow = buildFlow(store, "OrphanService.OrphanMethod");
  assert.ok(flow.root, "the orphan endpoint itself resolves uniquely");
  assert.equal(flow.diagnostic?.reason, "endpoint_no_handler");
  store.close();
});

// Scenario 8: index exists (symbol resolves uniquely) but assembling its
// context pack throws -> a distinct "assemblyError", never disguised as a
// zero-match. Simulated by corrupting the DB after a known-good resolution.
test("buildContextPack surfaces an internal assemblyError distinctly from zero-match", async () => {
  const { store } = await grpcRepo();
  const before = buildContextPack(store, "GetPlayerProfileByJwtProcessor.getPlayerProfileByJwt");
  assert.ok(before.focus, "sanity: resolves fine before corruption");
  assert.equal(before.assemblyError, null);

  store.db.exec("DROP TABLE symbol_versions");
  const after = buildContextPack(store, "GetPlayerProfileByJwtProcessor.getPlayerProfileByJwt");
  assert.equal(after.focus, null, "no focus once assembly fails");
  assert.equal(after.ambiguous, null, "must NOT look like an ambiguous match");
  assert.ok(after.assemblyError, "assemblyError populated with the real internal failure reason");
  assert.match(after.assemblyError, /symbol_versions/);
  store.close();
});
