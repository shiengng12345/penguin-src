import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "pk-recover-"));
  return { dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") };
}

function seedKnowledge(store) {
  const noteId = store.upsertNode({
    nodeType: "note", identityKey: "cases/demo.md", title: "Demo",
  });
  const symId = store.upsertNode({
    nodeType: "symbol", identityKey: "repo:GetLoginURL", title: "GetLoginURL",
  });
  const ev = store.recordKnowledge({
    type: "manual_edge_created",
    origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "shieng" },
    target: { node_id: noteId },
    payload: { src: noteId, dst: symId, edge_type: "wikilink" },
  });
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "system", method: "EXTRACTED",
    actor: { type: "system", id: "knowledge-indexer" },
    target: { node_id: symId },
    payload: { alias_key: "repo:OldLoginURL", alias_type: "qualified_name", reason: "rename" },
  });
  return { noteId, symId, edgeEventId: ev.id };
}

test("deleting knowledge.db and reopening replays ledger deterministically", () => {
  const p = paths();
  const store1 = KnowledgeStore.open(p);
  const { edgeEventId } = seedKnowledge(store1);
  store1.close();

  rmSync(p.dbPath);
  rmSync(p.dbPath + "-wal", { force: true });
  rmSync(p.dbPath + "-shm", { force: true });

  const store2 = KnowledgeStore.open(p);
  // 账本物化内容重现（node 是解析衍生，重建由上层索引器负责——
  // 这里验证 Ledger 部分：events + edges + aliases 全部回来了，且 id 一致）
  const edge = store2.db
    .prepare("SELECT * FROM edges WHERE id = ?").get(`edge_${edgeEventId}`);
  assert.ok(edge, "manual edge must be rematerialized with the same id");
  assert.equal(
    store2.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2,
  );
  assert.equal(
    store2.db.prepare("SELECT COUNT(*) AS n FROM node_aliases").get().n, 1,
  );
  const state = store2.db
    .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'").get();
  assert.equal(state.materialized_seq, 2);
  store2.close();
});

test("consistencyCheck reports and repairs index_behind", () => {
  const p = paths();
  const store = KnowledgeStore.open(p);
  seedKnowledge(store);
  // 人为回拨 materialized_seq，模拟「账本已写、物化未完成」的崩溃
  store.db
    .prepare("UPDATE ledger_state SET materialized_seq = 0 WHERE id='main'")
    .run();
  store.db.prepare("DELETE FROM events").run();
  store.db.prepare("DELETE FROM node_aliases").run();
  store.db.prepare("DELETE FROM edges WHERE origin != 'parser'").run();

  const result = store.consistencyCheck();
  assert.equal(result.status, "ok"); // 自动追平后返回
  assert.equal(result.ledgerSeq, 2);
  assert.equal(result.materializedSeq, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
  store.close();
});

test("consistencyCheck surfaces ledger truncation info", () => {
  const p = paths();
  const store = KnowledgeStore.open(p);
  seedKnowledge(store);
  appendFileSync(p.ledgerPath, "corrupted-tail\n");
  const result = store.consistencyCheck();
  assert.equal(result.ledgerTruncatedAtLine, 3);
  assert.equal(result.status, "ok");
  store.close();
});
