import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runQueryServer } from "../packages/knowledge-cli/dist/query-server.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function initGitRepo(rootPath, branchName) {
  execFileSync("git", ["init", "-b", branchName, rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: GIT_ENV });
  return execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function deps(store) {
  return { openStore: () => store, storeExists: () => true, out: () => {}, err: () => {} };
}

async function sendStatusPanelRequest(store) {
  const input = new Readable({ read() {} });
  const frames = [];
  let resolveResponse;
  const responseArrived = new Promise((resolve) => { resolveResponse = resolve; });
  const output = {
    write: (chunk) => {
      const frame = JSON.parse(chunk);
      frames.push(frame);
      if (frame.type === "response" && frame.id === "req-1") resolveResponse(frame);
      return true;
    },
  };
  const serverExit = runQueryServer(deps(store), input, output);
  input.push(`${JSON.stringify({ type: "request", id: "req-1", capabilityId: "knowledge.status_panel", input: {} })}\n`);
  const response = await responseArrived;
  input.push(null);
  await serverExit;
  return response;
}

function insertCoverageRow(store, repoId, filePath, coverageStatus) {
  store.db
    .prepare(
      `INSERT INTO coverage_records(repo_id, file_path, git_state, coverage_status, reason_code, classification, byte_size, reason, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(repoId, filePath, "tracked", coverageStatus, "text_searchable", "source", 10, "ok", new Date().toISOString());
}

test("knowledge.status_panel: repo on main indexed at head reports aligned, with coverage counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-status-panel-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const headSha = initGitRepo(rootPath, "main");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: headSha, status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=?, last_indexed_at=? WHERE id=?").run(headSha, "2026-08-01T00:00:00.000Z", branchId);

  insertCoverageRow(store, repoId, "src/a.ts", "admitted");
  insertCoverageRow(store, repoId, "src/b.ts", "admitted");
  insertCoverageRow(store, repoId, "src/c.ts", "excluded");
  insertCoverageRow(store, repoId, "src/d.ts", "failed");

  const response = await sendStatusPanelRequest(store);
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  assert.equal(response.result.db.connected, true);
  assert.equal(response.result.db.schemaVersion, 14);
  assert.equal(response.result.repos.length, 1);
  const repo = response.result.repos[0];
  assert.equal(repo.repoId, repoId);
  assert.equal(repo.repoName, "demo");
  assert.equal(repo.rootPath, rootPath);
  assert.equal(repo.branchName, "main");
  assert.equal(repo.revisionAlignment, "aligned");
  assert.equal(repo.indexedBranch, "main");
  assert.equal(repo.lastIndexedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(repo.staleReason, null);
  assert.deepEqual(repo.coverage, { admitted: 2, excluded: 1, failed: 1 });
  store.close();
});

test("knowledge.status_panel: git checked out on an un-indexed branch reports branch_not_indexed with a live fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-status-panel-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  initGitRepo(rootPath, "feature-x");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=?, last_indexed_at=? WHERE id=?").run("sha-main", "2026-08-01T00:00:00.000Z", branchId);

  const response = await sendStatusPanelRequest(store);
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  assert.equal(response.result.repos.length, 1);
  const repo = response.result.repos[0];
  assert.equal(repo.branchName, "feature-x");
  assert.equal(repo.revisionAlignment, "branch_not_indexed");
  assert.equal(repo.indexedBranch, "main");
  assert.equal(repo.lastIndexedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(repo.coverage, null);
  store.close();
});

test("knowledge.status_panel: indexed commit differs from head reports behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-status-panel-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  initGitRepo(rootPath, "main");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "stale-sha", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=?, stale_reason=? WHERE id=?").run("stale-sha", "worktree changed since last index", branchId);

  const response = await sendStatusPanelRequest(store);
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  const repo = response.result.repos[0];
  assert.equal(repo.revisionAlignment, "behind");
  assert.equal(repo.indexedBranch, "main");
  assert.equal(repo.staleReason, "worktree changed since last index");
  store.close();
});

test("knowledge.status_panel: repo root with no git repo reports git_unavailable and falls back to the sole live branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-status-panel-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo-no-git");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=?, last_indexed_at=? WHERE id=?").run("sha-main", "2026-08-01T00:00:00.000Z", branchId);

  const response = await sendStatusPanelRequest(store);
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  const repo = response.result.repos[0];
  assert.equal(repo.branchName, null);
  assert.equal(repo.revisionAlignment, "git_unavailable");
  assert.equal(repo.indexedBranch, "main");
  assert.equal(repo.lastIndexedAt, "2026-08-01T00:00:00.000Z");
  store.close();
});

test("knowledge.status_panel: detached HEAD reports git_unavailable, not branch_not_indexed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-status-panel-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  initGitRepo(rootPath, "main");
  execFileSync("git", ["-C", rootPath, "checkout", "--detach"], { env: GIT_ENV });
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=?, last_indexed_at=? WHERE id=?").run("sha-main", "2026-08-01T00:00:00.000Z", branchId);

  const response = await sendStatusPanelRequest(store);
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  const repo = response.result.repos[0];
  assert.equal(repo.branchName, null);
  assert.equal(repo.revisionAlignment, "git_unavailable");
  assert.equal(repo.indexedBranch, "main");
  store.close();
});

test("knowledge.status_panel: no registered repos returns an empty repos array without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-status-panel-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const response = await sendStatusPanelRequest(store);
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  assert.equal(response.result.db.schemaVersion, 14);
  assert.deepEqual(response.result.repos, []);
  store.close();
});
