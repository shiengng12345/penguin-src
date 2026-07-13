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
