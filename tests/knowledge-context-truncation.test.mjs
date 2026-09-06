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

test("context relation pages are deterministic and do not overlap", () => {
  const { store } = storeWithCallers(12);
  const first = buildContextPack(store, "target", { limit: 5, offset: 0 });
  const second = buildContextPack(store, "target", { limit: 5, offset: 5 });
  const third = buildContextPack(store, "target", { limit: 5, offset: 10 });

  assert.equal(first.callers.length, 5);
  assert.equal(second.callers.length, 5);
  assert.equal(third.callers.length, 2);
  assert.ok(first.truncated.includes("callers"));
  assert.ok(second.truncated.includes("callers"));
  assert.equal(third.truncated.includes("callers"), false);
  const ids = [...first.callers, ...second.callers, ...third.callers].map((item) => item.nodeId);
  assert.equal(new Set(ids).size, 12, "continued pages must not repeat a caller");
  store.close();
});

test("[context-continuation-dedup] context limit is global across relation families and continuation never repeats metadata relations", () => {
  const { store } = storeWithCallers(2);
  const repoId = "repo_trunc";
  const branchId = "branch_trunc";
  const focus = store.db.prepare("SELECT id FROM nodes WHERE identity_key=?").get(`${repoId}::target`).id;
  const targetFile = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::target`, repoId, title: "target.ts", meta: {} });
  const importer = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::importer`, repoId, title: "importer.ts", meta: {} });
  const usedType = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::used-type`, repoId, title: "UsedType", meta: {} });
  const secondUsedType = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::second-used-type`, repoId, title: "SecondUsedType", meta: {} });
  store.db.prepare(`INSERT INTO symbol_versions
    (node_id,branch_id,commit_sha,file_path,lang,kind,content_hash,status,start_line)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(usedType, branchId, "c0", "src/type.ts", "ts", "type", "ht", "fresh", 1);
  store.db.prepare(`INSERT INTO symbol_versions
    (node_id,branch_id,commit_sha,file_path,lang,kind,content_hash,status,start_line)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(secondUsedType, branchId, "c0", "src/second-type.ts", "ts", "type", "ht2", "fresh", 1);
  const edge = store.db.prepare(`INSERT INTO edges
    (id,src,dst,edge_type,branch_id,origin,method,confidence,provenance,status)
    VALUES (?,?,?,?,?,'parser','EXTRACTED',1,'{}','active')`);
  edge.run("defines-target", targetFile, focus, "defines", branchId);
  edge.run("imports-target", importer, targetFile, "imports", branchId);
  edge.run("uses-target", focus, usedType, "references", branchId);
  edge.run("uses-second-target", focus, secondUsedType, "references", branchId);

  const pages = [0, 2, 4].map((offset) => buildContextPack(store, "target", { limit: 2, offset }));
  const relationKeys = (pack) => [
    ...pack.callers.map((item) => `callers:${item.nodeId}`),
    ...pack.usesTypes.map((item) => `usesTypes:${item.nodeId}`),
    ...pack.importers.map((item) => `importers:${item.nodeId}`),
  ];
  assert.deepEqual(pages.map((page) => page.returnedCount), [2, 2, 1]);
  assert.deepEqual(pages.map((page) => relationKeys(page).length), [2, 2, 1]);
  const all = pages.flatMap(relationKeys);
  assert.equal(new Set(all).size, 5, JSON.stringify(all));
  assert.ok(pages[0].truncated.length > 0);
  assert.ok(pages[1].truncated.length > 0);
  assert.deepEqual(pages[2].truncated, []);
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
