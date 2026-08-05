import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, buildFlow, buildContextPack } from "../packages/knowledge-core/dist/index.js";

import { resolveRevisionContext } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-fallback-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "demo", rootPath: join(dir, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha", status: "live" });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::A`, repoId, title: "A" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::B`, repoId, title: "B" });
  store.upsertSymbolVersion({ nodeId: a, branchId, commitSha: "sha", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "A()", contentHash: "ha" });
  store.upsertSymbolVersion({ nodeId: b, branchId, commitSha: "sha", filePath: "src/b.ts", lang: "typescript", kind: "function", signature: "B()", contentHash: "hb" });
  store.indexSymbolText({ nodeId: a, name: "A", signature: "A()" });
  store.db.prepare("INSERT INTO edges (id, src, dst, edge_type, branch_id, origin, method, status) VALUES ('e1', ?, ?, 'calls', ?, 'parser', 'EXTRACTED', 'active')").run(a, b, branchId);
  return { store, repoId, a, branchId };
}

test("buildFlow without a revision marks the live-branch fallback", () => {
  const { store, branchId } = fixture();
  const flow = buildFlow(store, "A");
  assert.deepEqual(flow.scopeFallback, { branchId });
  store.close();
});

test("buildFlow with an explicit revision does NOT mark fallback", () => {
  const { store, repoId } = fixture();
  const revision = resolveRevisionContext(store, { repoId, branch: "main" }).context;
  const flow = buildFlow(store, "A", { revision });
  assert.equal(flow.scopeFallback, undefined);
  store.close();
});

test("buildContextPack marks fallback the same way", () => {
  const { store, repoId, a, branchId } = fixture();
  const noRevision = buildContextPack(store, a);
  assert.deepEqual(noRevision.scopeFallback, { branchId });
  const revision = resolveRevisionContext(store, { repoId, branch: "main" }).context;
  assert.equal(buildContextPack(store, a, { revision }).scopeFallback, undefined);
  store.close();
});
