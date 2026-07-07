import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-symver-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function setup(store) {
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const nodeId = store.upsertNode({
    nodeType: "symbol", identityKey: "fpms:GetLoginURL", title: "GetLoginURL", repoId,
  });
  return { repoId, branchId, nodeId };
}

test("upsertSymbolVersion is idempotent on (node_id, branch_id) and preserves first_seen_at", () => {
  const store = openTemp();
  const { branchId, nodeId } = setup(store);
  const v1 = store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "abc", filePath: "src/login.ts",
    lang: "ts", kind: "function", contentHash: "h1",
  });
  const first = store.getSymbolVersion(nodeId, branchId);
  assert.equal(first.status, "fresh");
  assert.equal(first.content_hash, "h1");
  assert.ok(first.first_seen_at);

  const v2 = store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "def", filePath: "src/login.ts",
    lang: "ts", kind: "function", contentHash: "h2",
  });
  assert.equal(v1, v2);
  const after = store.getSymbolVersion(nodeId, branchId);
  assert.equal(after.commit_sha, "def");
  assert.equal(after.content_hash, "h2");
  assert.equal(after.first_seen_at, first.first_seen_at);
  store.close();
});

test("markFileSymbolsStale marks only the matching branch+file and reports count", () => {
  const store = openTemp();
  const { repoId, branchId, nodeId } = setup(store);
  const other = store.upsertNode({
    nodeType: "symbol", identityKey: "fpms:Helper", title: "Helper", repoId,
  });
  store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "abc", filePath: "src/login.ts",
    lang: "ts", kind: "function", contentHash: "h1",
  });
  store.upsertSymbolVersion({
    nodeId: other, branchId, commitSha: "abc", filePath: "src/other.ts",
    lang: "ts", kind: "function", contentHash: "h9",
  });

  const n = store.markFileSymbolsStale({ branchId, filePath: "src/login.ts" });
  assert.equal(n, 1);
  assert.equal(store.getSymbolVersion(nodeId, branchId).status, "stale");
  assert.equal(store.getSymbolVersion(other, branchId).status, "fresh");
  store.close();
});
