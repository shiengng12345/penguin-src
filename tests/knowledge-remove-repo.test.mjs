// tests/knowledge-remove-repo.test.mjs
// Repo removal: `penguin remove <name|path>` purges one repo's derived data
// (nodes/edges/versions/files/fts/pending) without touching other repos.
// Backs the Wiki delete button (accidentally indexed ~/ must be removable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

async function twoRepoStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-rm-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const roots = {};
  for (const name of ["keepme", "dropme"]) {
    const repo = join(dir, name);
    mkdirSync(repo);
    writeFileSync(join(repo, `${name}.ts`), `export function ${name}Fn() { return helper(); }\nfunction helper() { return 1; }\n`);
    execSync("git init -q", { cwd: repo });
    await indexRepo({ store, rootPath: repo, mode: "incremental" });
    roots[name] = repo;
  }
  return { store, dir, roots };
}

function counts(store, repoId) {
  const q = (sql) => store.db.prepare(sql).get(repoId).c;
  return {
    repos: store.db.prepare("SELECT COUNT(*) c FROM repos WHERE id=?").get(repoId).c,
    branches: q("SELECT COUNT(*) c FROM branches WHERE repo_id=?"),
    nodes: q("SELECT COUNT(*) c FROM nodes WHERE repo_id=?"),
    versions: q("SELECT COUNT(*) c FROM symbol_versions sv JOIN branches b ON b.id=sv.branch_id WHERE b.repo_id=?"),
    files: q("SELECT COUNT(*) c FROM files_index WHERE repo_id=?"),
    edges: q("SELECT COUNT(*) c FROM edges e JOIN nodes n ON n.id=e.src WHERE n.repo_id=?"),
    fts: q("SELECT COUNT(*) c FROM fts_symbols f JOIN nodes n ON n.id=f.node_id WHERE n.repo_id=?"),
  };
}

test("removeRepo purges one repo completely and leaves the other intact", async () => {
  const { store } = await twoRepoStore();
  const [keep, drop] = ["keepme", "dropme"].map(
    (n) => store.db.prepare("SELECT id FROM repos WHERE name=?").get(n).id,
  );
  const before = counts(store, keep);
  assert.ok(before.nodes > 0 && before.edges > 0, "fixture indexed");

  store.removeRepo(drop);

  const gone = counts(store, drop);
  for (const [k, v] of Object.entries(gone)) assert.equal(v, 0, `${k} purged`);
  assert.deepEqual(counts(store, keep), before, "other repo untouched");
  store.close();
});

test("CLI: penguin remove <name> works; unknown repo errors", async () => {
  const { store, dir } = await twoRepoStore();
  store.close();
  const outs = [], errs = [];
  const deps = {
    cwd: dir,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    openStore: () => KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }),
    storeExists: () => true,
  };
  assert.equal(await runCli(["remove", "dropme"], deps), 0);
  assert.ok(outs.some((l) => l.includes("dropme")), `summary mentions repo: ${outs}`);
  const s2 = deps.openStore();
  assert.equal(s2.db.prepare("SELECT COUNT(*) c FROM repos").get().c, 1);
  s2.close();
  assert.equal(await runCli(["remove", "no-such-repo"], deps), 1);
  assert.ok(errs.some((l) => l.includes("no-such-repo")));
});
