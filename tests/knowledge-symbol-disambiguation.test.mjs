// tests/knowledge-symbol-disambiguation.test.mjs
// Real repro of the reported bug: 4 classes with an identically-named method
// (getPlayerProfileByJwt) make `resolveNodeId`'s friendly-name fallback see 4
// rows, fail its `rows.length === 1` check, and return null — context/search
// then treat "ambiguous" identically to "doesn't exist" (both print nothing
// useful). Fixed behavior: ambiguity is a DISTINCT, actionable result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import {
  buildContextPack, search, getNodeDetail,
} from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-disambig-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

// Reproduces the exact reported shape: 4 classes across 4 files, each with a
// method named identically, one of them a NestJS gRPC handler.
async function ambiguousRepo() {
  const root = mkdtempSync(join(tmpdir(), "pk-disambig-src-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "frontend-player.controller.ts"), `
import { GetPlayerProfileByJwtProcessor } from './processors/get-player-profile-by-jwt-processor';
export class FrontendPlayerController {
  constructor(private readonly getPlayerProfileByJwtProcessor: GetPlayerProfileByJwtProcessor) {}
  async getPlayerProfileByJwt(data) {
    return this.getPlayerProfileByJwtProcessor.getPlayerProfileByJwt(data);
  }
}
`);
  writeFileSync(join(root, "src", "player.controller.ts"), `
export class PlayerController {
  async getPlayerProfileByJwt(data) { return { ok: true }; }
}
`);
  mkdirSync(join(root, "src", "processors"), { recursive: true });
  writeFileSync(join(root, "src", "processors", "get-player-profile-by-jwt-processor.ts"), `
export class GetPlayerProfileByJwtProcessor {
  async getPlayerProfileByJwt(data) { return { profile: data }; }
}
`);
  writeFileSync(join(root, "src", "player-client-grpc.ts"), `
export class PlayerClientGrpc {
  async getPlayerProfileByJwt(data) { return { remote: true }; }
}
`);
  const store = openStore();
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  return { store, root };
}

test("buildContextPack returns an ambiguous candidate list, not a silent empty focus", async () => {
  const { store } = await ambiguousRepo();
  const pack = buildContextPack(store, "getPlayerProfileByJwt");
  assert.equal(pack.focus, null, "no single focus when ambiguous");
  assert.ok(pack.ambiguous, "ambiguous candidates populated");
  assert.equal(pack.ambiguous.length, 4, "all 4 same-named methods surfaced");
  const titles = pack.ambiguous.map((c) => c.identityKey);
  assert.ok(titles.some((t) => t.includes("FrontendPlayerController")));
  assert.ok(titles.some((t) => t.includes("PlayerController.getPlayerProfileByJwt") && !t.includes("Frontend")));
  assert.ok(titles.some((t) => t.includes("GetPlayerProfileByJwtProcessor")));
  assert.ok(titles.some((t) => t.includes("PlayerClientGrpc")));
  // every candidate carries enough to act on: type, file, node id
  for (const c of pack.ambiguous) {
    assert.ok(c.nodeId && c.nodeType === "symbol" && c.filePath);
  }
  store.close();
});

test("a candidate's nodeId resolves deterministically via buildContextPack", async () => {
  const { store } = await ambiguousRepo();
  const first = buildContextPack(store, "getPlayerProfileByJwt");
  const pick = first.ambiguous[0];
  const resolved = buildContextPack(store, pick.nodeId);
  assert.equal(resolved.focus?.nodeId, pick.nodeId);
  assert.equal(resolved.ambiguous, null);
  store.close();
});

test("unique exact match is unaffected by the ambiguity fix", async () => {
  const { store } = await ambiguousRepo();
  const pack = buildContextPack(store, "GetPlayerProfileByJwtProcessor.getPlayerProfileByJwt");
  assert.ok(pack.focus, "qualified name still resolves uniquely");
  assert.equal(pack.ambiguous, null);
  store.close();
});

test("repo display-name prefix resolves a full or legacy symbol identity", async () => {
  const { store } = await ambiguousRepo();
  const repo = store.db.prepare("SELECT id, name FROM repos LIMIT 1").get();
  store.db.prepare("UPDATE repos SET name='auth' WHERE id=?").run(repo.id);
  const full = buildContextPack(
    store,
    "auth::src/player.controller.ts::PlayerController.getPlayerProfileByJwt",
  );
  assert.ok(full.focus);
  assert.match(
    store.getNode(full.focus.nodeId).identity_key,
    /^repo_[^:]+::src\/player\.controller\.ts::/,
  );

  const legacy = buildContextPack(store, "auth::PlayerController.getPlayerProfileByJwt");
  assert.equal(legacy.focus?.nodeId, full.focus.nodeId);
  store.close();
});

test("global gRPC endpoint identity resolves regardless of RPC name casing", () => {
  const store = openStore();
  const endpointId = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::PlayerService.getplayerprofilebyjwt",
    title: "PlayerService.GetPlayerProfileByJwt",
  });

  const pack = buildContextPack(store, "grpc::PlayerService.GetPlayerProfileByJwt");
  assert.equal(pack.focus?.nodeId, endpointId);
  assert.equal(pack.ambiguous, null);
  store.close();
});

test("truly nonexistent symbol is zero matches, distinguishable from ambiguous", async () => {
  const { store } = await ambiguousRepo();
  const pack = buildContextPack(store, "thisSymbolDoesNotExistAnywhere");
  assert.equal(pack.focus, null);
  assert.equal(pack.ambiguous, null, "zero-match must NOT look like ambiguous (empty array vs null)");
  store.close();
});

test("getNodeDetail: a raw node id always resolves uniquely even for an ambiguous title", async () => {
  const { store } = await ambiguousRepo();
  const pack = buildContextPack(store, "getPlayerProfileByJwt");
  const id = pack.ambiguous[1].nodeId;
  const detail = getNodeDetail(store, id);
  assert.equal(detail.node.id, id);
  store.close();
});

test("search returns distinguishable rows: identityKey + filePath present, not 4 identical lines", async () => {
  const { store } = await ambiguousRepo();
  const hits = search(store, "getPlayerProfileByJwt");
  const symbolHits = hits.filter((h) => h.nodeType === "symbol");
  assert.ok(symbolHits.length >= 4, `expected >=4 hits, got ${symbolHits.length}`);
  const identities = new Set(symbolHits.map((h) => h.identityKey));
  assert.equal(identities.size, symbolHits.length, "every hit has a DISTINCT identityKey");
  for (const h of symbolHits) {
    assert.ok(h.filePath, `hit for ${h.identityKey} carries a filePath`);
    assert.ok(h.nodeId, "hit carries the node id (usable directly by context/flow)");
  }
  store.close();
});

test("same qualified class method in different files remains two source-grounded symbols", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-file-scoped-symbols-"));
  mkdirSync(join(root, "src", "legacy"), { recursive: true });
  mkdirSync(join(root, "src", "current"), { recursive: true });
  const clientSource = `
export class PlayerClientGrpc {
  private playerService;
  constructor(client) {
    this.playerService = client.getService('PlayerService');
  }
  async getPlayerInfo(request) {
    return this.playerService.getPlayerInfo(request);
  }
}
`;
  writeFileSync(join(root, "src", "legacy", "player-client-grpc.ts"), clientSource);
  writeFileSync(join(root, "src", "current", "player-client-grpc.ts"), clientSource);

  const store = openStore();
  await indexRepo({ store, rootPath: root, mode: "incremental" });

  const symbols = store.db.prepare(`
    SELECT n.id, n.identity_key AS identityKey, sv.file_path AS filePath
      FROM nodes n
      JOIN symbol_versions sv ON sv.node_id=n.id
     WHERE n.node_type='symbol' AND n.title='getPlayerInfo' AND sv.status='fresh'
     ORDER BY sv.file_path
  `).all();
  assert.equal(symbols.length, 2, "both physical source methods must remain queryable");
  assert.equal(new Set(symbols.map((row) => row.id)).size, 2, "files must not collapse onto one node");
  assert.deepEqual(symbols.map((row) => row.filePath), [
    "src/current/player-client-grpc.ts",
    "src/legacy/player-client-grpc.ts",
  ]);
  assert.equal(new Set(symbols.map((row) => row.identityKey)).size, 2);

  const invokes = store.db.prepare(`
    SELECT DISTINCT e.src
      FROM edges e
      JOIN nodes d ON d.id=e.dst
     WHERE e.edge_type='invokes'
       AND d.identity_key='grpc::PlayerService.getplayerinfo'
  `).all();
  assert.equal(invokes.length, 2, "each physical caller must retain its own invokes edge");
  store.close();
});
