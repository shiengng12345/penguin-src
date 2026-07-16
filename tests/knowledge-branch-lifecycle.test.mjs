// tests/knowledge-branch-lifecycle.test.mjs
// P0 of the branch-retention plan (3-way design review):
//  1. auto-flip demotes the old live branch only AFTER a successful index —
//     a failed run must not mark the new branch trustworthy or demote anything.
//  2. per-branch delete purges branch-scoped rows and GCs only truly-orphaned
//     nodes; branchless gRPC edges are never touched.
//  3. pinned branches refuse deletion (CLI) and are exempt from auto mechanisms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo, IndexTaskLock } from "../packages/knowledge-indexer/dist/pipeline.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-bl-"));
  return { store: KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }), dir };
}

// Fake .git (same shape knowledge-indexer-pipeline.test.mjs uses): HEAD ref +
// refs so readGitContext resolves branch/commit without a real git binary.
function writeGit(root, headRef, refs) {
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), headRef);
  for (const [name, sha] of Object.entries(refs)) {
    writeFileSync(join(root, ".git", "refs", "heads", name), `${sha}\n`);
  }
}

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "pk-bl-repo-"));
}

test("failed index run does NOT demote the previous live branch", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function shared() {}");
  const { store } = openStore();
  const r1 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(store.getBranch(r1.repoId, "main").status, "live");

  // switch checkout to feature, but make the run FAIL: pre-register the
  // feature branch row (as snapshot — nothing has earned live yet) and hold
  // its index lock so indexRepo throws.
  writeGit(root, "ref: refs/heads/feature\n", { feature: "c1" });
  const featBranchId = store.registerBranch({
    repoId: r1.repoId, name: "feature", headCommit: "c1", checkoutPath: root, status: "snapshot",
  });
  const lock = IndexTaskLock.tryAcquire(`${r1.repoId}:${featBranchId}:${root}`);
  assert.ok(lock, "test holds the lock");
  await assert.rejects(() => indexRepo({ store, rootPath: root, mode: "incremental" }), /already running/);
  lock.release();

  assert.equal(store.getBranch(r1.repoId, "main").status, "live", "failed run must not demote main");
  assert.equal(store.getBranch(r1.repoId, "feature").status, "snapshot", "failed run must not promote the new branch to live");

  // now succeed → main flips
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(store.getBranch(r1.repoId, "main").status, "snapshot");
  assert.equal(store.getBranch(r1.repoId, "feature").status, "live");
  store.close();
});

test("first successful named Git branch becomes canonical master", async () => {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/feature-first\n", { "feature-first": "c1" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "first.ts"), "export function first() { return 1; }");
  const { store } = openStore();
  const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(store.getDefaultBranch(report.repoId).name, "feature-first");
  store.close();
});

test("first non-Git workdir remains master-unresolved", async () => {
  const root = tempRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "workdir.ts"), "export function workdir() { return 1; }");
  const { store } = openStore();
  const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(report.branchName, "(workdir)");
  assert.equal(store.getDefaultBranch(report.repoId), null);
  store.close();
});

async function twoBranchStore() {
  const root = tempRepo();
  writeGit(root, "ref: refs/heads/main\n", { main: "c0" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "shared.ts"), "export function keepMe() { return 1; }");
  writeFileSync(join(root, "src", "only.ts"), "export function mainOnly() { return keepMe(); }\nimport { keepMe } from './shared';");
  const { store } = openStore();
  const r1 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  // switch to feature: only.ts is gone there, shared.ts identical
  writeGit(root, "ref: refs/heads/feature\n", { feature: "c1" });
  rmSync(join(root, "src", "only.ts"));
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  // a branchless "gRPC-style" edge that must survive branch deletion
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::Svc.m", repoId: null, title: "gRPC Svc.m" });
  const sym = store.db.prepare("SELECT id FROM nodes WHERE title='keepMe'").get().id;
  store.replaceFileEdges({ repoId: r1.repoId, filePath: "src/shared.ts", edges: [
    { src: sym, dst: ep, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true },
  ] });
  return { store, root, repoId: r1.repoId };
}

test("removeBranch purges the branch, GCs orphans, spares shared nodes and branchless edges", async () => {
  const { store, repoId } = await twoBranchStore();
  const mainBranch = store.getBranch(repoId, "main");

  store.removeBranch(mainBranch.id);

  assert.equal(store.getBranch(repoId, "main"), null, "branch row gone");
  const q = (sql, p) => store.db.prepare(sql).get(p).c;
  assert.equal(q("SELECT COUNT(*) c FROM edges WHERE branch_id=?", mainBranch.id), 0);
  assert.equal(q("SELECT COUNT(*) c FROM symbol_versions WHERE branch_id=?", mainBranch.id), 0);
  assert.equal(q("SELECT COUNT(*) c FROM files_index WHERE branch_id=?", mainBranch.id), 0);
  // mainOnly existed only on main → GC'd; keepMe lives on feature → stays
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE title='mainOnly'").get().c, 0, "orphan symbol GC'd");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE title='keepMe'").get().c, 1, "shared symbol survives");
  // branchless gRPC edge untouched
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM edges WHERE edge_type='invokes' AND branch_id IS NULL AND status='active'").get().c,
    1, "branchless edge survives",
  );
  // no orphan fts rows
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM fts_symbols f LEFT JOIN nodes n ON n.id=f.node_id WHERE n.id IS NULL").get().c,
    0, "fts consistent",
  );
  store.close();
});

test("removeBranch spares endpoint nodes kept alive only by a response sample (endpoint_key)", async () => {
  const { store, repoId } = await twoBranchStore();
  // A repo-scoped endpoint whose ONLY liveness is a captured response sample —
  // and, as after a ledger replay (audit F-2), the sample's endpoint_id is a
  // DEAD id; only endpoint_key still matches. GC must honor the key match.
  const epId = store.upsertNode({
    nodeType: "endpoint",
    identityKey: `${repoId}::endpoint::GET /solo`,
    repoId,
    title: "GET /solo",
  });
  store.db
    .prepare(
      `INSERT INTO response_samples (id, endpoint_id, endpoint_key, status, content_type, sample, captured_at)
       VALUES ('rs1', 'node_dead_after_wipe', ?, '200', 'application/json', '{}', '2026-01-01T00:00:00Z')`,
    )
    .run(`${repoId}::endpoint::GET /solo`);

  store.removeBranch(store.getBranch(repoId, "main").id);

  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE id=?").get(epId).c,
    1,
    "endpoint kept alive by response sample's endpoint_key",
  );
  store.close();
});

test("CLI: penguin remove <repo> <branch>; pinned branch refuses; pin verb toggles", async () => {
  const { store, repoId } = await twoBranchStore();
  const repoName = store.db.prepare("SELECT name FROM repos WHERE id=?").get(repoId).name;
  store.close();
  const dir = store.ledgerPath.replace(/\/l\.jsonl$/, "");
  const outs = [], errs = [];
  const deps = {
    cwd: dir,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    openStore: () => KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }),
    storeExists: () => true,
  };

  // pin main, deletion refused
  assert.equal(await runCli(["pin", repoName, "main"], deps), 0);
  assert.equal(await runCli(["remove", repoName, "main"], deps), 1);
  assert.ok(errs.some((l) => l.includes("pinned")), `refusal mentions pinned: ${errs}`);
  // unpin (toggle), deletion succeeds
  assert.equal(await runCli(["pin", repoName, "main"], deps), 0);
  assert.equal(await runCli(["remove", repoName, "main"], deps), 0);
  const s2 = deps.openStore();
  assert.equal(s2.getBranch(repoId, "main"), null);
  assert.equal(s2.db.prepare("SELECT COUNT(*) c FROM repos WHERE id=?").get(repoId).c, 1, "repo itself stays");
  s2.close();
});

test("removeBranch refuses while a fresh cross-process index marker exists", async () => {
  const { store, repoId } = await twoBranchStore();
  const main = store.getBranch(repoId, "main");
  store.acquireIndexMarker(main.id);
  assert.throws(() => store.removeBranch(main.id), /currently running/);
  store.releaseIndexMarker(main.id);
  store.removeBranch(main.id); // released → proceeds
  assert.equal(store.getBranch(repoId, "main"), null);
  // stale marker (fabricated old timestamp) does not block
  const feat = store.getBranch(repoId, "feature");
  store.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    `index_lock::${feat.id}`,
    JSON.stringify({ pid: 1, startedAt: "2020-01-01T00:00:00Z" }),
  );
  store.removeBranch(feat.id);
  assert.equal(store.getBranch(repoId, "feature"), null, "stale marker ignored");
  store.close();
});

test("acquireIndexMarker does not block on a RECENT marker whose owning process has died", async () => {
  // Real-world repro: an indexer crashes/gets killed mid-run without reaching
  // its cleanup (releaseIndexMarker). The marker's age-only staleness check
  // then blocks every retry for up to 30 minutes even though nothing is
  // actually running — the exact bug reported (fpms: "index already running"
  // on both `index` and `rebuild`, ~15 min after the crashed run, no process
  // matching the recorded pid anywhere on the machine).
  const { store, repoId } = await twoBranchStore();
  const main = store.getBranch(repoId, "main");

  // A genuinely-dead pid: spawn a child, kill it, and wait for it to actually
  // exit (not just request the signal) before reusing its pid number.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const deadPid = child.pid;
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill();
  });

  // Fresh timestamp (seconds ago, well inside the 30-min window) + the now-dead pid.
  store.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    `index_lock::${main.id}`,
    JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
  );
  // Must NOT throw — the recorded pid is dead, so the marker is stale
  // regardless of how recent its timestamp is.
  store.acquireIndexMarker(main.id);
  store.releaseIndexMarker(main.id);
  store.close();
});

test("removeBranch drops pending frontend rows of GC'd sources; replay skips dead src ids", async () => {
  const { store, repoId } = await twoBranchStore();
  // pending row whose src is a main-only symbol (will be GC'd with main)
  const mainOnly = store.db.prepare("SELECT id FROM nodes WHERE title='mainOnly'").get().id;
  store.enqueuePendingFrontendEdge({
    repoId, filePath: "src/only.ts", srcNodeId: mainOnly, service: "", functionName: "ghostCall", sourceType: "frontend_web",
  });
  // a second pending row pointing at an ALREADY-dead id (post-wipe replay shape)
  store.enqueuePendingFrontendEdge({
    repoId, filePath: "src/other.ts", srcNodeId: "node_dead", service: "", functionName: "ghostCall", sourceType: "frontend_web",
  });
  store.removeBranch(store.getBranch(repoId, "main").id);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM pending_frontend_edges WHERE src_node_id=?").get(mainOnly).c,
    0, "pending row of GC'd source dropped with it",
  );
  // make ghostCall uniquely resolvable, then replay: dead-src row must be
  // discarded, and no orphan edge created
  store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::GhostSvc.ghostcall", repoId: null, title: "gRPC GhostSvc.ghostcall" });
  store.replayPendingFrontendEdges();
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM edges e LEFT JOIN nodes n ON n.id=e.src WHERE n.id IS NULL").get().c,
    0, "no orphan-src edges after replay",
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) c FROM pending_frontend_edges").get().c,
    0, "dead-src pending row discarded",
  );
  store.close();
});

test("real git repo: commits + checkout -b flips statuses through actual git plumbing", async () => {
  const root = tempRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export function realMain() { return 1; }\n");
  const g = (cmd) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: root });
  g("init -q"); g("add -A"); g("commit -qm baseline"); g("branch -m main");
  const { store } = openStore();
  const r1 = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(store.getBranch(r1.repoId, "main").status, "live");

  g("checkout -q -b test/real-e2e");
  writeFileSync(join(root, "src", "app.ts"), "export function realMain() { return 2; }\nexport function probeFn() { return 42; }\n");
  g("commit -qam change");
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.equal(store.getBranch(r1.repoId, "main").status, "snapshot", "real branch switch demotes main");
  assert.equal(store.getBranch(r1.repoId, "test/real-e2e").status, "live");
  assert.equal(store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE title='probeFn'").get().c, 1);
  store.close();
});
