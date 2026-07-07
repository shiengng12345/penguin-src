import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-store-"));
  return {
    dir,
    store: KnowledgeStore.open({
      dbPath: join(dir, "knowledge.db"),
      ledgerPath: join(dir, "ledger.jsonl"),
    }),
  };
}

test("recordKnowledge appends to ledger first, then materializes", () => {
  const { dir, store } = openTemp();
  const noteId = store.upsertNode({
    nodeType: "note", identityKey: "cases/demo.md", title: "Demo",
  });
  const symId = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:GetLoginURL", title: "GetLoginURL",
  });
  const event = store.recordKnowledge({
    type: "manual_edge_created",
    origin: "user",
    method: "ASSERTED",
    actor: { type: "user", id: "shieng" },
    target: { node_id: noteId },
    payload: { src: noteId, dst: symId, edge_type: "wikilink" },
  });

  const ledgerLines = readFileSync(join(dir, "ledger.jsonl"), "utf8")
    .trim().split("\n");
  assert.equal(ledgerLines.length, 1);
  assert.equal(JSON.parse(ledgerLines[0]).id, event.id);

  const edge = store.db
    .prepare("SELECT * FROM edges WHERE id = ?").get(`edge_${event.id}`);
  assert.equal(edge.src, noteId);
  assert.equal(edge.dst, symId);
  store.close();
});

test("upsertNode is idempotent on (node_type, identity_key)", () => {
  const { store } = openTemp();
  const id1 = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:X.foo", title: "foo",
  });
  const id2 = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:X.foo", title: "foo (updated)",
  });
  assert.equal(id1, id2);
  assert.equal(store.getNode(id1).title, "foo (updated)");
  store.close();
});

test("replaceFileEdges rejects non-parser edges (§2.2 iron rule)", () => {
  const { store } = openTemp();
  const a = store.upsertNode({ nodeType: "symbol", identityKey: "r:a", title: "a" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: "r:b", title: "b" });
  store.db.prepare(
    "INSERT INTO repos (id, name, root_path, created_at) VALUES ('repo1','r','/tmp/r','2026-07-07T00:00:00Z')",
  ).run();
  store.db.prepare(
    "INSERT INTO branches (id, repo_id, name, status) VALUES ('br1','repo1','main','live')",
  ).run();

  assert.throws(
    () =>
      store.replaceFileEdges({
        branchId: "br1",
        filePath: "src/a.ts",
        edges: [{ src: a, dst: b, edgeType: "calls", origin: "user", method: "ASSERTED" }],
      }),
    /recordKnowledge/,
  );
  store.close();
});

test("replaceFileEdges replaces edges for the same file+branch", () => {
  const { store } = openTemp();
  const a = store.upsertNode({ nodeType: "symbol", identityKey: "r:a", title: "a" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: "r:b", title: "b" });
  const c = store.upsertNode({ nodeType: "symbol", identityKey: "r:c", title: "c" });
  store.db.prepare(
    "INSERT INTO repos (id, name, root_path, created_at) VALUES ('repo1','r','/tmp/r','2026-07-07T00:00:00Z')",
  ).run();
  store.db.prepare(
    "INSERT INTO branches (id, repo_id, name, status) VALUES ('br1','repo1','main','live')",
  ).run();

  const mk = (dst) => ({
    src: a, dst, edgeType: "calls", origin: "parser", method: "EXTRACTED",
  });
  store.replaceFileEdges({ branchId: "br1", filePath: "src/a.ts", edges: [mk(b)] });
  store.replaceFileEdges({ branchId: "br1", filePath: "src/a.ts", edges: [mk(c)] });

  const rows = store.db
    .prepare("SELECT dst FROM edges WHERE src = ? AND branch_id = 'br1'").all(a);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dst, c);
  store.close();
});

test("resolveIdentity falls back to alias after rename (D13)", () => {
  const { store } = openTemp();
  const nodeId = store.upsertNode({
    nodeType: "symbol",
    identityKey: "repo:UserService.signIn",
    title: "UserService.signIn",
  });
  // rename 检测产生的 alias：旧名 login → 同一节点
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system",
    method: "EXTRACTED",
    actor: { type: "system", id: "knowledge-indexer" },
    target: { node_id: nodeId },
    payload: { alias_key: "repo:UserService.login", alias_type: "qualified_name", reason: "rename" },
  });

  assert.deepEqual(store.resolveIdentity("repo:UserService.signIn"), {
    nodeId, via: "identity",
  });
  assert.deepEqual(store.resolveIdentity("repo:UserService.login"), {
    nodeId, via: "alias",
  });
  assert.equal(store.resolveIdentity("repo:NoSuch"), null);

  const aliases = store.getAliases(nodeId);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].aliasKey, "repo:UserService.login");
  assert.equal(aliases[0].reason, "rename");
  store.close();
});

test("undone alias no longer resolves", () => {
  const { store } = openTemp();
  const nodeId = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:A.b", title: "A.b",
  });
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system", method: "EXTRACTED",
    actor: { type: "system", id: "knowledge-indexer" },
    target: { node_id: nodeId },
    payload: { alias_key: "repo:A.old", alias_type: "qualified_name", reason: "rename" },
  });
  store.recordKnowledge({
    type: "alias_merge_undone",
    origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "shieng" },
    target: { node_id: nodeId },
    payload: { alias_key: "repo:A.old", alias_type: "qualified_name" },
  });
  assert.equal(store.resolveIdentity("repo:A.old"), null);
  store.close();
});

test("upsertNode preserves existing meta when meta is omitted", () => {
  const { store } = openTemp();
  const id1 = store.upsertNode({
    nodeType: "symbol",
    identityKey: "r:keepmeta",
    title: "keepmeta",
    meta: { kind: "function" },
  });
  const id2 = store.upsertNode({
    nodeType: "symbol",
    identityKey: "r:keepmeta",
    title: "keepmeta (touched)",
  });
  assert.equal(id1, id2);
  const node = store.getNode(id1);
  assert.equal(node.title, "keepmeta (touched)");
  assert.deepEqual(JSON.parse(node.meta), { kind: "function" });
  store.close();
});
