import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createInterface } from "node:readline";

import {
  KnowledgeStore,
  buildEvidenceEnvelope,
  buildStatusPanel,
  compactIndexStatus,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin A1 Test",
  GIT_AUTHOR_EMAIL: "penguin-a1@example.invalid",
  GIT_COMMITTER_NAME: "Penguin A1 Test",
  GIT_COMMITTER_EMAIL: "penguin-a1@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-installed-freshness-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "stable.ts"), "export const stable = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "commit A");
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  return { dir, repo, dbPath, ledgerPath, store };
}

function oneRepo(panel) {
  assert.equal(panel.repos.length, 1);
  return panel.repos[0];
}

function bundledWorker(dbPath, ledgerPath) {
  const workerPath = resolve("packages/mcp/bundle/dist/knowledge-worker.js");
  const bundledNode = resolve("packages/mcp/bundle/node");
  assert.equal(existsSync(workerPath), true, "run the MCP bundle build before this release-fixture test");
  assert.equal(existsSync(bundledNode), true, "the release fixture must execute with its bundled Node runtime");
  const bridge = [
    "const { Worker } = require('node:worker_threads');",
    "const { createInterface } = require('node:readline');",
    "const worker = new Worker(process.argv[1], { workerData: { dbPath: process.argv[2], ledgerPath: process.argv[3] } });",
    "worker.on('message', (message) => process.stdout.write(JSON.stringify(message) + '\\n'));",
    "worker.on('error', (error) => { console.error(error); process.exit(2); });",
    "createInterface({ input: process.stdin }).on('line', (line) => worker.postMessage(JSON.parse(line)));",
  ].join("\n");
  const child = spawn(bundledNode, ["-e", bridge, workerPath, dbPath, ledgerPath], {
    cwd: resolve("packages/mcp/bundle"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (!message.ok) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  let nextId = 0;
  const request = (name, args = {}) => new Promise((resolveResult, reject) => {
    const id = `a1-${++nextId}`;
    pending.set(id, { resolve: resolveResult, reject });
    child.stdin.write(`${JSON.stringify({
      type: "run",
      id,
      capabilityId: "knowledge.mcp_tool",
      input: { name, arguments: args },
    })}\n`);
  });
  const terminate = async () => {
    child.stdin.end();
    child.kill();
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    });
    assert.equal(stderr, "", stderr);
  };
  return { request, terminate };
}

test("each source status request reads live Git HEAD instead of reusing a cross-request TTL cache", async () => {
  const value = fixture();
  try {
    await indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" });
    assert.equal(oneRepo(buildStatusPanel(value.store)).revisionAlignment, "aligned");

    git(value.repo, "commit", "--allow-empty", "-q", "-m", "commit B");
    const commitB = git(value.repo, "rev-parse", "HEAD");
    const behind = oneRepo(buildStatusPanel(value.store));
    assert.equal(behind.revisionAlignment, "behind");
    assert.equal(behind.currentHead, commitB);
  } finally {
    value.store.close();
    rmSync(value.dir, { recursive: true, force: true });
  }
});

test("Git-unavailable status never promotes persisted clean metadata to fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-git-unavailable-freshness-"));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  try {
    const repoId = store.registerRepo({ name: "offline", rootPath: join(dir, "not-a-git-repo") });
    const branchId = store.registerBranch({ repoId, name: "main", headCommit: "commit-a", status: "live" });
    store.db.prepare(`
      UPDATE branches
         SET last_indexed_commit='commit-a', indexed_worktree_state='clean', stale_reason=NULL
       WHERE id=?
    `).run(branchId);

    assert.equal(compactIndexStatus(store).repos[0].freshness, "unknown");
    const evidence = buildEvidenceEnvelope(store, {
      repoId,
      branchId,
      completeness: "complete",
      proofStatus: "proven",
      candidateCount: 1,
      returnedCount: 1,
    });
    assert.equal(evidence.freshness.status, "unknown");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one long-lived bundled MCP worker and a fresh worker both observe no-op commit B as aligned", async () => {
  const value = fixture();
  let resident;
  let fresh;
  try {
    const commitA = git(value.repo, "rev-parse", "HEAD");
    await indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" });
    resident = bundledWorker(value.dbPath, value.ledgerPath);
    const atA = oneRepo(await resident.request("status_panel"));
    assert.equal(atA.currentHead, commitA);
    assert.equal(atA.indexedCommit, commitA);
    assert.equal(atA.revisionAlignment, "aligned");

    git(value.repo, "commit", "--allow-empty", "-q", "-m", "commit B with identical tree");
    const commitB = git(value.repo, "rev-parse", "HEAD");
    const beforeIndex = oneRepo(await resident.request("status_panel"));
    assert.equal(beforeIndex.currentHead, commitB);
    assert.equal(beforeIndex.indexedCommit, commitA);
    assert.equal(beforeIndex.revisionAlignment, "behind");
    const compactBeforeIndex = (await resident.request("index_status", { mode: "compact" })).repos[0];
    assert.equal(compactBeforeIndex.headCommit, commitB);
    assert.equal(compactBeforeIndex.indexedCommit, commitA);
    assert.equal(compactBeforeIndex.freshness, "stale");

    const reportB = await indexRepo({ store: value.store, rootPath: value.repo, mode: "incremental" });
    assert.equal(reportB.parsed, 0);
    const residentAtB = oneRepo(await resident.request("status_panel"));
    assert.equal(residentAtB.currentHead, commitB);
    assert.equal(residentAtB.indexedCommit, commitB);
    assert.equal(residentAtB.revisionAlignment, "aligned");
    assert.equal(residentAtB.revisionGeneration, 2);
    const compactAtB = (await resident.request("index_status", { mode: "compact" })).repos[0];
    assert.equal(compactAtB.headCommit, commitB);
    assert.equal(compactAtB.indexedCommit, commitB);
    assert.equal(compactAtB.freshness, "fresh");

    fresh = bundledWorker(value.dbPath, value.ledgerPath);
    const freshAtB = oneRepo(await fresh.request("status_panel"));
    assert.equal(freshAtB.currentHead, commitB);
    assert.equal(freshAtB.indexedCommit, commitB);
    assert.equal(freshAtB.snapshotId, residentAtB.snapshotId);
    assert.equal(freshAtB.revisionAlignment, "aligned");
    assert.equal(freshAtB.revisionGeneration, residentAtB.revisionGeneration);
  } finally {
    await resident?.terminate();
    await fresh?.terminate();
    value.store.close();
    rmSync(value.dir, { recursive: true, force: true });
  }
});
