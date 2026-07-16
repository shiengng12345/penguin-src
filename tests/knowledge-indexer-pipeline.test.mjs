import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { search } from "../packages/knowledge-core/dist/index.js";
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

function initRealGitRepo(root) {
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "penguin-test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Penguin Test"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "clean.ts"), "export function clean() { return 1; }\n");
  execFileSync("git", ["-C", root, "add", "src/clean.ts"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"]);
}

test("readGitContext: reports clean, modified, and untracked worktree fingerprints", () => {
  const root = tempRepo();
  initRealGitRepo(root);
  const clean = readGitContext(root);
  assert.equal(clean.worktreeState, "clean");
  assert.deepEqual(clean.dirtyFiles, []);
  assert.match(clean.worktreeFingerprint, /^[a-f0-9]{64}$/);

  writeFileSync(join(root, "src", "clean.ts"), "export function clean() { return 2; }\n");
  writeFileSync(join(root, "src", "new.ts"), "export const fresh = true;\n");
  const dirty = readGitContext(root);
  assert.equal(dirty.worktreeState, "dirty");
  assert.deepEqual(dirty.dirtyFiles, ["src/clean.ts", "src/new.ts"]);
  assert.notEqual(dirty.worktreeFingerprint, clean.worktreeFingerprint);
  rmSync(root, { recursive: true, force: true });
});

test("indexRepo: dirty overlay is not attributed to HEAD commit", async () => {
  const root = tempRepo();
  initRealGitRepo(root);
  writeFileSync(join(root, "src", "clean.ts"), "export function clean() { return 2; }\n");
  const store = openStore();
  const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(report.worktreeState, "dirty");
  assert.equal(report.headCommit, report.commit);
  assert.equal(report.indexedCommit, null);
  assert.equal(report.staleReason, "worktree_dirty");
  assert.deepEqual(report.dirtyFiles, ["src/clean.ts"]);
  assert.match(report.worktreeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(typeof report.parserVersion, "string");
  assert.equal(typeof report.schemaVersion, "number");

  const branchTrust = store.db
    .prepare("SELECT indexed_worktree_state, indexed_worktree_fingerprint, indexed_dirty_files, stale_reason FROM branches WHERE id=?")
    .get(report.branchId);
  assert.equal(branchTrust.indexed_worktree_state, "dirty");
  assert.equal(branchTrust.indexed_worktree_fingerprint, report.worktreeFingerprint);
  assert.deepEqual(JSON.parse(branchTrust.indexed_dirty_files), ["src/clean.ts"]);
  assert.equal(branchTrust.stale_reason, "worktree_dirty");

  const version = store.db
    .prepare("SELECT commit_sha FROM symbol_versions WHERE file_path=? LIMIT 1")
    .get("src/clean.ts");
  assert.equal(version.commit_sha, "(worktree)");
  store.close();
  rmSync(root, { recursive: true, force: true });
});

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

test("indexRepo: a new branch reuses the master manifest and stores only changed overlays", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0", feature: "c1" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "shared.ts"), "export const shared = 1;\n");
  writeFileSync(join(root, "src", "main-only.ts"), "export const mainOnly = 1;\n");
  const store = openStore();
  const main = await indexRepo({ store, rootPath: root, mode: "incremental" });
  const mainSnapshot = store.getBranch(main.repoId, "main").current_snapshot_id;

  writeGit(root, "ref: refs/heads/feature\n", { main: "c0", feature: "c1" });
  rmSync(join(root, "src", "main-only.ts"));
  writeFileSync(join(root, "src", "feature-only.ts"), "export const featureOnly = 1;\n");
  const feature = await indexRepo({ store, rootPath: root, mode: "incremental" });
  const featureSnapshot = store.getBranch(feature.repoId, "feature").current_snapshot_id;
  assert.equal(store.db.prepare("SELECT base_snapshot_id FROM revision_snapshots WHERE id=?").get(featureSnapshot).base_snapshot_id, mainSnapshot);
  assert.deepEqual(
    store.db.prepare("SELECT file_path AS filePath, operation FROM snapshot_overlays WHERE snapshot_id=? ORDER BY file_path").all(featureSnapshot),
    [
      { filePath: "src/feature-only.ts", operation: "add" },
      { filePath: "src/main-only.ts", operation: "delete" },
    ],
  );
  assert.equal(store.db.prepare("SELECT 1 FROM snapshot_overlays WHERE snapshot_id=? AND file_path='src/shared.ts'").get(featureSnapshot), undefined);
  store.close();
});

test("indexRepo: log literal is a searchable log_site linked to its enclosing method", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "closure.ts"),
    [
      "export class BpAccountClosureService {",
      "  closeAccount() {",
      "    this.logger.info('[BpAccountClosureService] closeAccount started'); this.logger.warn('closure warning');",
      "  }",
      "}",
    ].join("\n"),
  );
  const store = openStore();
  const report = await indexRepo({ store, rootPath: root, mode: "rebuild" });

  const hits = search(store, "[BpAccountClosureService] closeAccount started");
  const log = hits.find((hit) => hit.nodeType === "log_site");
  assert.ok(log, JSON.stringify(hits));
  assert.equal(log.filePath, "src/closure.ts");
  assert.equal(log.startLine, 3);
  assert.equal(log.snippet, "[BpAccountClosureService] closeAccount started");

  const method = store.resolveIdentity(`${report.repoId}::BpAccountClosureService.closeAccount`);
  const edge = store.db.prepare(
    "SELECT edge_type FROM edges WHERE src=? AND dst=?",
  ).get(method.nodeId, log.nodeId);
  assert.equal(edge?.edge_type, "emits_log");
  const emitted = store.db.prepare(
    "SELECT COUNT(DISTINCT dst) AS n FROM edges WHERE src=? AND edge_type='emits_log'",
  ).get(method.nodeId);
  assert.equal(emitted.n, 2, "two logger calls on one source line keep distinct destinations");
  store.close();
});

test("indexRepo: parser version drift forces a rebuild instead of reusing stale identities", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "svc.ts"), "export class Svc { login() { return true; } }");
  const store = openStore();

  const first = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.ok(first.parsed > 0);
  store.db.prepare("UPDATE branches SET parser_version='obsolete-parser' WHERE id=?").run(first.branchId);

  const second = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.ok(second.parsed > 0, "unchanged files must be reparsed after parser identity semantics change");
  store.close();
});

test("indexRepo: rebuild rollback preserves the previously published graph", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function alpha() { return 1; }\n");
  writeFileSync(join(root, "src", "b.ts"), "export function beta() { return alpha(); }\n");
  const store = openStore();
  const initial = await indexRepo({ store, rootPath: root, mode: "rebuild" });

  const snapshot = () => ({
    branches: store.db.prepare("SELECT * FROM branches ORDER BY id").all(),
    files: store.db.prepare("SELECT * FROM files_index ORDER BY repo_id, branch_id, file_path").all(),
    nodes: store.db.prepare("SELECT * FROM nodes ORDER BY id").all(),
    versions: store.db.prepare("SELECT * FROM symbol_versions ORDER BY node_id, branch_id").all(),
    edges: store.db.prepare("SELECT * FROM edges ORDER BY id").all(),
    events: store.db.prepare("SELECT * FROM events ORDER BY ledger_seq, id").all(),
    ledger: existsSync(store.ledgerPath) ? readFileSync(store.ledgerPath, "utf8") : null,
  });
  const before = snapshot();

  writeFileSync(join(root, "src", "a.ts"), "export function alphaRenamed() { return 1; }\n");
  writeFileSync(join(root, "src", "b.ts"), "export function betaRenamed() { return alphaRenamed(); }\n");
  await assert.rejects(
    () => indexRepo({
      store,
      rootPath: root,
      mode: "rebuild",
      onProgress(event) {
        if (event.phase === "index" && event.done === 2) throw new Error("injected rebuild interruption");
      },
    }),
    /injected rebuild interruption/,
  );

  assert.deepEqual(snapshot(), before, "failed rebuild must not publish a partial graph or ledger event");
  assert.equal(store.getBranch(initial.repoId, "main").status, "live");
  store.close();
});

test("indexRepo: delete detection marks gone file's symbols stale and removes log sites", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "gone.ts"),
    "export function willVanish() { console.info('vanishing log literal'); }",
  );
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
  assert.equal(search(store, "vanishing log literal").length, 0);
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

test("indexRepo: anonymous Jest callback maps dynamic-import calls to tested symbols", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "provider.ts"),
    "export class Provider { checkBlacklist() { return false; } }",
  );
  writeFileSync(
    join(root, "src", "provider.spec.ts"),
    [
      "it('checks the provider', async () => {",
      "  const { Provider } = await import('./provider');",
      "  const provider = new Provider();",
      "  return provider.checkBlacklist();",
      "});",
    ].join("\n"),
  );
  const store = openStore();
  const report = await indexRepo({ store, rootPath: root, mode: "rebuild" });

  const specFile = store.db
    .prepare("SELECT id FROM nodes WHERE identity_key=?")
    .get(`${report.repoId}::file::src/provider.spec.ts`);
  const checkedSymbol = store.resolveIdentity(`${report.repoId}::Provider.checkBlacklist`);
  const testsEdge = store.db
    .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='tests' AND src=? AND dst=?")
    .get(specFile.id, checkedSymbol.nodeId);
  assert.equal(testsEdge.n, 1, "anonymous callback should map to the uniquely imported method");
  store.close();
});

test("indexRepo: ambiguous imported test targets are retained as low-confidence INFERRED edges", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "bp.ts"), "export class Bp { checkBlacklist() { return false; } }");
  writeFileSync(join(root, "src", "cp.ts"), "export class Cp { checkBlacklist() { return false; } }");
  writeFileSync(
    join(root, "src", "providers.spec.ts"),
    [
      "it('checks both providers', async () => {",
      "  const { Bp } = await import('./bp');",
      "  const { Cp } = await import('./cp');",
      "  new Bp().checkBlacklist();",
      "  new Cp().checkBlacklist();",
      "});",
    ].join("\n"),
  );
  const store = openStore();
  const report = await indexRepo({ store, rootPath: root, mode: "rebuild" });
  const rows = store.db.prepare(
    `SELECT e.method, e.confidence, n.identity_key AS identityKey
       FROM edges e JOIN nodes n ON n.id=e.dst
      WHERE e.edge_type='tests'
        AND json_extract(n.meta, '$.qualifiedName') IN (?, ?)
      ORDER BY n.identity_key`,
  ).all("Bp.checkBlacklist", "Cp.checkBlacklist");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.method === "INFERRED" && row.confidence === 0.5));
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
