import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function open(dir) { return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); }

test("existing-index rebuild publishes a revision snapshot, and deleting the DB then reindexing reconstructs code facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-recovery-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "feature.ts"), "export function firstFeature() { return 1; }\n");
  const store = open(root);
  const first = await indexRepo({ store, rootPath: repo, mode: "incremental" });
  const firstSnapshot = store.db.prepare("SELECT state, id FROM revision_snapshots WHERE repo_id=? ORDER BY created_at DESC LIMIT 1").get(first.repoId);
  assert.equal(firstSnapshot.state, "ready");
  assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(first.branchId).current_snapshot_id, firstSnapshot.id);
  writeFileSync(join(repo, "feature.ts"), "export function firstFeature() { return 2; }\nexport function secondFeature() { return 3; }\n");
  const rebuilt = await indexRepo({ store, rootPath: repo, mode: "rebuild" });
  assert.ok(store.db.prepare("SELECT 1 FROM nodes WHERE title='secondFeature'").get());
  assert.equal(store.db.prepare("SELECT state FROM revision_snapshots WHERE id=(SELECT current_snapshot_id FROM branches WHERE id=?)").get(rebuilt.branchId).state, "ready");
  store.close();
  rmSync(join(root, "knowledge.db"), { force: true });
  rmSync(join(root, "ledger.jsonl"), { force: true });
  const fresh = open(root);
  const reindexed = await indexRepo({ store: fresh, rootPath: repo, mode: "incremental" });
  assert.ok(reindexed.parsed > 0);
  assert.ok(fresh.db.prepare("SELECT 1 FROM nodes WHERE title='secondFeature'").get());
  assert.ok(fresh.db.prepare("SELECT COUNT(*) AS count FROM revision_snapshots WHERE state='ready'").get().count >= 1);
  fresh.close();
});

test("CLI rebuild works when an index already exists and does not require deleting the DB first", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-cli-rebuild-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "app.ts"), "export function appValue() { return 1; }\n");
  const dbDir = join(root, "state"); mkdirSync(dbDir);
  const deps = { cwd: repo, out: () => {}, err: () => {}, openStore: () => open(dbDir), storeExists: () => existsSync(join(dbDir, "knowledge.db")) };
  assert.equal(await runCli(["init", repo], deps), 0);
  writeFileSync(join(repo, "app.ts"), "export function appValue() { return 2; }\nexport function rebuiltValue() { return 3; }\n");
  assert.equal(await runCli(["rebuild", repo], deps), 0);
  const store = open(dbDir);
  assert.ok(store.db.prepare("SELECT 1 FROM nodes WHERE title='rebuiltValue'").get());
  store.close();
});

test("CLI revision GC defaults to a dry-run and exposes an explicit apply switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-cli-gc-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "app.ts"), "export function gcValue() { return 1; }\n");
  const dbDir = join(root, "state"); mkdirSync(dbDir); const outputs = [];
  const deps = { cwd: repo, out: (line) => outputs.push(line), err: (line) => outputs.push(`ERR:${line}`), openStore: () => open(dbDir), storeExists: () => existsSync(join(dbDir, "knowledge.db")) };
  assert.equal(await runCli(["init", repo], deps), 0);
  assert.equal(await runCli(["revisions", "gc", "repo", "--json"], deps), 0);
  assert.ok(JSON.parse(outputs.at(-1)).keep);
});

test("CLI materialize creates an on-demand clean revision without moving a branch pointer", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-cli-materialize-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "app.ts"), "export function materializedValue() { return 1; }\n");
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git(["init", "-q"]); git(["config", "user.email", "penguin@test"]); git(["config", "user.name", "Penguin Test"]); git(["add", "."]); git(["commit", "-qm", "initial"]);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dbDir = join(root, "state"); mkdirSync(dbDir); const outputs = [];
  const deps = { cwd: repo, out: (line) => outputs.push(line), err: (line) => outputs.push(`ERR:${line}`), openStore: () => open(dbDir), storeExists: () => existsSync(join(dbDir, "knowledge.db")) };
  assert.equal(await runCli(["init", repo], deps), 0);
  const store = open(dbDir); const branch = store.db.prepare("SELECT current_snapshot_id FROM branches LIMIT 1").get().current_snapshot_id; store.close();
  assert.equal(await runCli(["materialize", "repo", "--commit", sha, "--json"], deps), 0);
  const result = JSON.parse(outputs.at(-1)); assert.equal(result.context.commitSha, sha); assert.equal(result.context.trust, "exact_commit");
  const after = open(dbDir); assert.equal(after.db.prepare("SELECT current_snapshot_id FROM branches LIMIT 1").get().current_snapshot_id, branch); assert.ok(after.db.prepare("SELECT 1 FROM revision_snapshots WHERE commit_sha=? AND state='ready'").get(sha)); after.close();
});
