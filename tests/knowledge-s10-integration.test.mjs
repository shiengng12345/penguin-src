import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, compareBranches } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

// §10 integration coverage: cross-branch versions/compare, ledger→index rebuild
// determinism (§2.2), and the CLI index-browse/graph verbs end-to-end.

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-s10-"));
  return {
    dir,
    store: KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }),
  };
}

test("§10 two-branch fixture: same symbol → two versions; compare identical vs differs", () => {
  const { store } = openStore();
  const repoId = store.registerRepo({ name: "auth", rootPath: "/auth" });
  const brA = store.registerBranch({ repoId, name: "main", status: "live" });
  const brB = store.registerBranch({ repoId, name: "feature", status: "live" });

  const same = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::same`, title: "same", repoId });
  const diff = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::diff`, title: "diff", repoId });
  const ver = (nodeId, branchId, hash) =>
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: branchId, filePath: "a.ts", lang: "ts", kind: "function", contentHash: hash, status: "fresh" });
  ver(same, brA, "H1"); ver(same, brB, "H1"); // identical across branches
  ver(diff, brA, "H1"); ver(diff, brB, "H2"); // diverged

  // each symbol has a row per branch it lives on (versions 双行)
  const rows = store.db.prepare("SELECT branch_id FROM symbol_versions WHERE node_id=?").all(same);
  assert.equal(rows.length, 2);

  assert.equal(compareBranches(store, same, brA, brB).identical, true, "equal hash → identical");
  assert.equal(compareBranches(store, diff, brA, brB).identical, false, "differing hash → differs");
  store.close();
});

test("§2.2 rebuild determinism: a fresh DB re-materialized from the SAME ledger restores non-rebuildable edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-s10-rebuild-"));
  const ledgerPath = join(dir, "ledger.jsonl");

  // Store A: parser-derived nodes (direct) + one human decision (ledgered).
  const a = KnowledgeStore.open({ dbPath: join(dir, "k1.db"), ledgerPath });
  const n1 = a.upsertNode({ nodeType: "symbol", identityKey: "r::a", title: "a" });
  const n2 = a.upsertNode({ nodeType: "symbol", identityKey: "r::b", title: "b" });
  a.recordKnowledge({
    type: "manual_edge_created", origin: "user", method: "ASSERTED",
    actor: { type: "user", id: "t" }, target: { node_id: n1 },
    payload: { src: n1, dst: n2, edge_type: "wikilink" },
  });
  const edgesA = a.db.prepare("SELECT src, dst, edge_type FROM edges WHERE edge_type='wikilink' ORDER BY src").all();
  assert.equal(edgesA.length, 1);
  a.close();

  // Store B: a brand-new empty DB pointed at the SAME ledger. open() replays the
  // ledger → the non-rebuildable edge is restored byte-for-byte (deterministic).
  const b = KnowledgeStore.open({ dbPath: join(dir, "k2.db"), ledgerPath });
  const edgesB = b.db.prepare("SELECT src, dst, edge_type FROM edges WHERE edge_type='wikilink' ORDER BY src").all();
  assert.deepEqual(edgesB, edgesA, "ledger replay rebuilds the same edges");
  // consistency: index caught up to the ledger
  assert.equal(b.consistencyCheck().status, "ok");
  b.close();
});

// —— CLI index-browse / graph verbs end-to-end (§8.3 + Plan 8 ①) ——

function cliHarness() {
  const dir = mkdtempSync(join(tmpdir(), "pk-s10-cli-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const lines = [];
  const errs = [];
  const deps = {
    cwd: dir,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
  };
  return { dir, deps, lines, errs };
}

test("§10 CLI files/graph/repograph verbs after init", async () => {
  const { dir, deps, lines } = cliHarness();
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "function outer(){ return inner(); }\nfunction inner(){}");

  assert.equal(await runCli(["init"], deps), 0);

  const json = async (args) => {
    lines.length = 0;
    assert.equal(await runCli([...args, "--json"], deps), 0, args.join(" "));
    return JSON.parse(lines[0]);
  };

  const status = await json(["status"]);
  const repo = status.repos[0];
  const branch = repo.branches.find((b) => b.name === "main");

  // files: our src/a.ts was indexed
  const files = await json(["files", repo.repoId, branch.branchId]);
  assert.ok(files.some((f) => f.filePath === "src/a.ts" && f.status === "indexed"), "src/a.ts indexed");

  // repograph: outer + inner + the calls edge among them
  const rg = await json(["repograph", repo.repoId, branch.branchId]);
  const titles = rg.nodes.map((n) => n.title).sort();
  assert.deepEqual(titles, ["inner", "outer"]);
  assert.equal(rg.edges.length, 1);

  // graph (local): focus inner → its caller outer is a neighbour
  const g = await json(["graph", "inner"]);
  assert.ok(g.focus, "focus resolved");
  assert.ok(g.nodes.some((n) => n.title === "outer"), "outer is a neighbour of inner");
});
