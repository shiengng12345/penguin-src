#!/usr/bin/env node

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  KnowledgeStore,
  exportCanonicalCorpus,
} from "../packages/knowledge-core/dist/index.js";
import {
  discoverFullCorpusRepositories,
  readGitContext,
  runFullCorpus,
} from "../packages/knowledge-indexer/dist/index.js";

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`missing --${name}=...`);
  return value;
}

function currentExports(store, receipts) {
  const summaries = [];
  for (const receipt of receipts) {
    const exported = exportCanonicalCorpus({
      store,
      repoId: receipt.repoId,
      branchId: receipt.branchId,
      snapshotId: receipt.snapshotId,
    });
    summaries.push({
      rootPath: exported.scope.repository.rootPath,
      repo: exported.scope.repository.name,
      branch: exported.scope.branch.name,
      head: exported.scope.snapshot.commitSha,
      digest: exported.digest,
      formatVersion: exported.formatVersion,
      stableDigest: exported.digest,
    });
    // Do not retain the complete projection for every repository. Real
    // corpora can exceed the process RSS budget even though each digest is
    // streamed; only the stable summary is required across rebuild runs.
  }
  return summaries;
}

function currentLiveReceipts(store, roots) {
  const select = store.db.prepare(`
    SELECT r.id AS repoId,b.id AS branchId,b.current_snapshot_id AS snapshotId,
           b.head_commit AS head
      FROM repos r
      JOIN branches b ON b.repo_id=r.id
     WHERE r.root_path=? AND b.status='live' AND b.current_snapshot_id IS NOT NULL
  `);
  return roots.map((rootPath) => {
    const receipt = select.get(realpathSync.native(rootPath));
    if (!receipt) throw new Error(`DETERMINISM_CURRENT_SNAPSHOT_MISSING:${rootPath}`);
    return { ...receipt, parsed: 0, errors: 0 };
  });
}

export async function runDeterminism(options) {
  const rootPath = realpathSync.native(resolve(options.rootPath));
  const roots = discoverFullCorpusRepositories(rootPath);
  if (roots.length === 0) throw new Error(`FULL_CORPUS_NO_GIT_REPOSITORIES:${rootPath}`);
  const rebuilds = Math.max(1, Math.min(10, Math.floor(options.rebuilds ?? 3)));
  const statusDirectory = resolve(options.statusDirectory ?? mkdtempSync(join("/tmp", "penguin-determinism-")));
  mkdirSync(statusDirectory, { recursive: true, mode: 0o700 });
  const runs = [];
  if (options.includeCurrent) {
    const receipts = currentLiveReceipts(options.store, roots);
    runs.push({
      run: 1,
      statusPath: null,
      job: { state: "completed", mode: "current", completedRepos: receipts.length, totalRepos: receipts.length },
      failures: [],
      repositories: receipts.map(({ repoId, branchId, head, parsed, errors, snapshotId }) => ({
        repoId, branchId, head, parsed, errors, snapshotId,
      })),
      exports: currentExports(options.store, receipts),
    });
  }
  for (let index = runs.length; index < rebuilds; index += 1) {
    const statusPath = join(statusDirectory, `rebuild-${index + 1}.json`);
    const result = await runFullCorpus({
      store: options.store,
      rootPath,
      modes: ["rebuild"],
      statusPath,
      semantic: { enabled: false },
    });
    const exports = result.failures.length === 0
      ? currentExports(options.store, result.repositories.rebuild)
      : [];
    runs.push({
      run: index + 1,
      statusPath,
      job: result.job,
      failures: result.failures,
      repositories: result.repositories.rebuild.map((receipt) => ({
        repoId: receipt.repoId,
        branchId: receipt.branchId,
        head: receipt.head,
        parsed: receipt.parsed,
        errors: receipt.errors,
        snapshotId: receipt.snapshotId,
      })),
      exports,
    });
  }
  const digestByRoot = new Map();
  for (const run of runs) for (const item of run.exports) {
    const key = `${item.rootPath}::${item.repo}::${item.branch}`;
    const values = digestByRoot.get(key) ?? [];
    values.push(item.stableDigest);
    digestByRoot.set(key, values);
  }
  const differences = [...digestByRoot.entries()]
    .filter(([, digests]) => new Set(digests).size !== 1)
    .map(([key, digests]) => ({ key, digests }));
  return {
    formatVersion: 1,
    rootPath,
    repositories: roots,
    rebuilds,
    volatileFields: runs[0]?.exports.length
      ? "see packages/knowledge-core/src/corpus-export.ts"
      : [],
    runs,
    differences,
    ok: runs.every((run) => run.failures.length === 0 && run.job.state === "completed") && differences.length === 0,
  };
}

async function main() {
  const rootPath = resolve(required("root"));
  const dbPath = resolve(option("db") ?? join(homedir(), ".penguin", "knowledge", "knowledge.db"));
  const ledgerPath = resolve(option("ledger") ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl"));
  if (!existsSync(dbPath)) throw new Error(`KNOWLEDGE_DB_NOT_FOUND:${dbPath}`);
  const roots = discoverFullCorpusRepositories(rootPath);
  const heads = roots.map((root) => {
    const git = readGitContext(root);
    return { rootPath: realpathSync.native(root), branch: git.branch, head: git.commit, worktreeState: git.worktreeState };
  });
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({
      ok: false,
      mode: "dry-run",
      message: "No rebuild was run. Add --execute only after reviewing the repository/HEAD set.",
      rootPath: realpathSync.native(rootPath),
      repositories: heads,
    }, null, 2));
    return;
  }

  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  try {
    const report = await runDeterminism({
      store,
      rootPath,
      rebuilds: Number(option("rebuilds") ?? 3),
      statusDirectory: option("status-dir"),
      includeCurrent: process.argv.includes("--include-current"),
    });
    const outputPath = option("report");
    if (outputPath) {
      writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
    process.exitCode = 1;
  });
}
