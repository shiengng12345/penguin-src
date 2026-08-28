import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, buildContextPack, buildExplorePack } from "../packages/knowledge-core/dist/index.js";

// A relation list cut at `limit` used to be indistinguishable from a complete
// one: 25-of-25 and 25-of-500 looked identical, so an agent reading `calls`
// reasoned as if it had seen everything. Every relation now names itself in
// `truncated` when more rows exist — the contract `sourcesOmitted` already
// gives source blocks.

function storeWithCallers(count, { limit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pk-trunc-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = "repo_trunc";
  store.db.prepare("INSERT INTO repos(id,name,root_path,created_at) VALUES (?,?,?,?)")
    .run(repoId, "trunc", "/tmp/trunc", new Date().toISOString());
  const branchId = "branch_trunc";
  store.db.prepare("INSERT INTO branches(id,repo_id,name,status,default_branch) VALUES (?,?,?,?,1)")
    .run(branchId, repoId, "main", "live");

  const version = store.db.prepare(`INSERT INTO symbol_versions
    (node_id,branch_id,commit_sha,file_path,lang,kind,content_hash,status,start_line)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const edge = store.db.prepare(`INSERT INTO edges
    (id,src,dst,edge_type,branch_id,origin,method,confidence,provenance,status)
    VALUES (?,?,?,'calls',?,'parser','EXTRACTED',1,'{}','active')`);

  const focus = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::target`, repoId, title: "target", meta: {} });
  version.run(focus, branchId, "c0", "src/target.ts", "ts", "function", "h0", "fresh", 1);

  for (let i = 0; i < count; i += 1) {
    const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::c${i}`, repoId, title: `caller${i}`, meta: {} });
    version.run(caller, branchId, "c0", `src/c${i}.ts`, "ts", "function", `h${i}`, "fresh", 1);
    edge.run(`e${i}`, caller, focus, branchId);
  }
  return { store, limit };
}

test("a relation cut at the limit says so; one that fits does not", () => {
  // 26 callers against limit 25 — the classic case that read as complete.
  const over = storeWithCallers(26);
  const cut = buildContextPack(over.store, "target", { limit: 25 });
  assert.equal(cut.callers.length, 25, "still returns exactly the limit");
  assert.ok(cut.truncated.includes("callers"), "and admits the list was cut");
  over.store.close();

  // Exactly at the limit is NOT truncated — an off-by-one here would cry wolf
  // on every complete list of 25.
  const exact = storeWithCallers(25);
  const full = buildContextPack(exact.store, "target", { limit: 25 });
  assert.equal(full.callers.length, 25);
  assert.deepEqual(full.truncated, [], "25 of 25 is complete, not truncated");
  exact.store.close();

  const few = storeWithCallers(3);
  const small = buildContextPack(few.store, "target", { limit: 25 });
  assert.equal(small.callers.length, 3);
  assert.deepEqual(small.truncated, []);
  few.store.close();
});

test("truncation names the specific relation, not a bare boolean", () => {
  // A pack carries a dozen relations; "something was cut" would not tell a
  // caller which one to re-query.
  const { store } = storeWithCallers(30);
  const pack = buildContextPack(store, "target", { limit: 5 });
  assert.deepEqual(pack.truncated, ["callers"]);
  assert.equal(pack.calls.length, 0, "unrelated relations stay absent from the list");
  store.close();
});

test("explore carries the truncation state too", () => {
  // Explore is the tool agents actually call — the contract has to survive the
  // hop from ContextPack.
  const { store } = storeWithCallers(26);
  const pack = buildExplorePack(store, "target", { limit: 25 });
  assert.equal(pack.callers.length, 25);
  assert.ok(Array.isArray(pack.truncated), "field exists on ExplorePack");
  assert.ok(pack.truncated.includes("callers"));
  store.close();
});

test("an empty pack reports no truncation rather than undefined", () => {
  const { store } = storeWithCallers(0);
  const pack = buildContextPack(store, "does-not-exist");
  assert.deepEqual(pack.truncated, [], "callers of a missing symbol: complete and empty");
  store.close();
});
