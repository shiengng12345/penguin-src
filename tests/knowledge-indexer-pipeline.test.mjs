import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import {
  readGitContext,
  walkRepoFiles,
  indexRepo,
  IndexTaskLock,
} from "../packages/knowledge-indexer/dist/index.js";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "pk-repo-"));
}
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-pipe-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}
function writeGit(root, headContent, refs = {}) {
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), headContent);
  for (const [name, sha] of Object.entries(refs)) {
    writeFileSync(join(root, ".git", "refs", "heads", name), sha + "\n");
  }
}

test("readGitContext: branch, detached, and non-git degrade", () => {
  const a = tempRepo();
  writeGit(a, "ref: refs/heads/main\n", { main: "abc123def456" });
  const ga = readGitContext(a);
  assert.equal(ga.isGit, true);
  assert.equal(ga.branch, "main");
  assert.equal(ga.commit, "abc123def456");

  const b = tempRepo();
  writeGit(b, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
  const gb = readGitContext(b);
  assert.equal(gb.branch, "(detached)");
  assert.equal(gb.commit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

  const c = tempRepo();
  const gc = readGitContext(c);
  assert.equal(gc.isGit, false);
  assert.equal(gc.branch, "(workdir)");
  assert.equal(gc.commit, null);
});

test("readGitContext: repoName from origin remote, null without one", () => {
  const a = tempRepo();
  writeGit(a, "ref: refs/heads/main\n", { main: "c0" });
  writeFileSync(
    join(a, ".git", "config"),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/penguin-src.git\n',
  );
  assert.equal(readGitContext(a).repoName, "penguin-src");

  const b = tempRepo();
  writeGit(b, "ref: refs/heads/main\n", { main: "c0" });
  assert.equal(readGitContext(b).repoName, null); // no config/remote → fall back to folder name
});

test("walkRepoFiles skips ignored dirs and oversize files", () => {
  const root = tempRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
  writeFileSync(join(root, "node_modules", "x", "b.ts"), "export const b = 2;");
  writeFileSync(join(root, "big.ts"), "x".repeat(2000));
  const rels = [...walkRepoFiles(root, { maxBytes: 1000 })].map((f) => f.relPath).sort();
  assert.deepEqual(rels, ["src/a.ts"]);
});

test("indexRepo: full index then incremental skip; rename detection", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "svc.ts"),
    "class Svc {\n  login() { return helper(); }\n}\nfunction helper() { return 1; }",
  );
  const store = openStore();

  const r1 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(r1.branchName, "main");
  assert.ok(r1.parsed >= 1);
  // symbols got nodes + versions
  const svcLogin = store.resolveIdentity(`${r1.repoId}::Svc.login`);
  assert.ok(svcLogin, "Svc.login node exists");
  // a calls edge Svc.login → helper was resolved
  const edges = store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='calls'").get();
  assert.ok(edges.n >= 1, "at least one calls edge");

  // second run, nothing changed → all skipped, none parsed
  const r2 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(r2.parsed, 0);
  assert.ok(r2.skipped >= 1);

  // rename helper → helper2 (same body) → alias appended
  writeFileSync(
    join(root, "src", "svc.ts"),
    "class Svc {\n  login() { return helper2(); }\n}\nfunction helper2() { return 1; }",
  );
  const r3 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.ok(r3.renamed >= 1, "rename detected → alias");
  // old qualified name still resolves via alias
  assert.ok(store.resolveIdentity(`${r1.repoId}::src/svc.ts::helper`), "old name resolves via alias");
  store.close();
});

test("indexRepo: delete detection marks gone file's symbols stale", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "gone.ts"), "export function willVanish() {}");
  const store = openStore();
  const r1 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  const nodeId = store.resolveIdentity(`${r1.repoId}::src/gone.ts::willVanish`).nodeId;
  const branch = store.getBranch(r1.repoId, "main");
  assert.equal(store.getSymbolVersion(nodeId, branch.id).status, "fresh");

  rmSync(join(root, "src", "gone.ts"));
  const r2 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.ok(r2.deleted >= 1);
  assert.equal(store.getSymbolVersion(nodeId, branch.id).status, "stale");
  const cp = store.getFileCheckpoint(r1.repoId, branch.id, "src/gone.ts");
  assert.equal(cp.status, "deleted");
  store.close();
});

test("indexRepo: branch switch flips old→snapshot, keeps node identity", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function shared() {}");
  const store = openStore();
  const r1 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  const nodeBefore = store.resolveIdentity(`${r1.repoId}::src/a.ts::shared`).nodeId;

  // switch branch
  writeGit(root, "ref: refs/heads/feature\n", { feature: "c1" });
  const r2 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(r2.branchName, "feature");
  assert.equal(store.getBranch(r1.repoId, "main").status, "snapshot", "old branch auto-flipped on switch");
  assert.equal(store.getBranch(r1.repoId, "feature").status, "live");
  // node identity stable across branches
  const nodeAfter = store.resolveIdentity(`${r1.repoId}::src/a.ts::shared`).nodeId;
  assert.equal(nodeAfter, nodeBefore);
  store.close();
});

test("indexRepo: file nodes + defines edges + relative-import edges (Plan B P1)", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export function helper() { return 1; }");
  writeFileSync(
    join(root, "src", "svc.ts"),
    "import { helper } from './util';\nexport function run() { return helper(); }",
  );
  const store = openStore();
  await indexRepo({ store, rootPath: root, mode: "incremental" }); // pass 1: create all nodes
  const r = await indexRepo({ store, rootPath: root, mode: "rebuild" }); // pass 2: resolve cross-file with full symbol table

  // file nodes exist for both files
  const svcFile = store.db
    .prepare("SELECT id FROM nodes WHERE node_type='file' AND identity_key=?")
    .get(`${r.repoId}::file::src/svc.ts`);
  const utilFile = store.db
    .prepare("SELECT id FROM nodes WHERE node_type='file' AND identity_key=?")
    .get(`${r.repoId}::file::src/util.ts`);
  assert.ok(svcFile && utilFile, "both file nodes created");

  // defines: svc file → run symbol
  const defines = store.db
    .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='defines' AND src=?")
    .get(svcFile.id);
  assert.ok(defines.n >= 1, "file defines its symbols");

  // imports: svc file → util file (resolved from './util')
  const imports = store.db
    .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='imports' AND src=? AND dst=?")
    .get(svcFile.id, utilFile.id);
  assert.equal(imports.n, 1, "relative import resolved to a file→file edge");

  // import scoping made run→helper an EXTRACTED calls edge (helper is imported)
  const call = store.db
    .prepare("SELECT method FROM edges WHERE edge_type='calls' LIMIT 1")
    .get();
  assert.ok(call, "run→helper calls edge exists");
  store.close();
});

test("indexRepo: spec file gets tests edges to exercised symbols (Plan B P1)", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "calc.ts"), "export function add(a, b) { return a + b; }");
  writeFileSync(
    join(root, "src", "calc.spec.ts"),
    "import { add } from './calc';\nfunction testAdd() { return add(1, 2); }",
  );
  const store = openStore();
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  const r = await indexRepo({ store, rootPath: root, mode: "rebuild" });

  const specFile = store.db
    .prepare("SELECT id FROM nodes WHERE identity_key=?")
    .get(`${r.repoId}::file::src/calc.spec.ts`);
  const addSym = store.resolveIdentity(`${r.repoId}::src/calc.ts::add`);
  const testsEdge = store.db
    .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='tests' AND src=? AND dst=?")
    .get(specFile.id, addSym.nodeId);
  assert.equal(testsEdge.n, 1, "spec file → add() tests edge");
  store.close();
});

test("IndexTaskLock: only one active per key", () => {
  const a = IndexTaskLock.tryAcquire("repo:branch:/co");
  assert.ok(a);
  assert.equal(IndexTaskLock.tryAcquire("repo:branch:/co"), null);
  a.release();
  const b = IndexTaskLock.tryAcquire("repo:branch:/co");
  assert.ok(b);
  b.release();
});
