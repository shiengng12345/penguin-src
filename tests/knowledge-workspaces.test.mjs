import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, search } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-ws-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("workspace groups repos and scopes search", () => {
  const store = openStore();
  const r1 = store.registerRepo({ name: "auth", rootPath: "/w/auth" });
  const r2 = store.registerRepo({ name: "player", rootPath: "/w/player" });
  const nA = store.upsertNode({ nodeType: "symbol", identityKey: `${r1}::Login`, title: "Login", repoId: r1 });
  const nB = store.upsertNode({ nodeType: "symbol", identityKey: `${r2}::Login`, title: "Login", repoId: r2 });
  store.indexSymbolText({ nodeId: nA, name: "Login", signature: null });
  store.indexSymbolText({ nodeId: nB, name: "Login", signature: null });

  const ws = store.createWorkspace("brazil");
  store.addRepoToWorkspace(ws, r1);

  // unscoped → both repos' Login
  assert.equal(search(store, "Login").length, 2);
  // workspace scope → only auth's
  const scoped = search(store, "Login", { workspace: ws });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].nodeId, nA);

  const list = store.listWorkspaces();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "brazil");
  assert.deepEqual(list[0].repoIds, [r1]);
  store.close();
});
