#!/usr/bin/env node

import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { KnowledgeStore, exportCanonicalCorpus } from "../packages/knowledge-core/dist/index.js";
import { discoverFullCorpusRepositories, runFullCorpus } from "../packages/knowledge-indexer/dist/index.js";

function option(name, fallback) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}

function scalar(db, sql) {
  const row = db.prepare(sql).get();
  return Number(row?.n ?? row?.value ?? Object.values(row ?? {})[0] ?? 0);
}

const COUNT_TABLES = [
  "revision_snapshots", "source_blobs", "source_facts", "file_facts",
  "nodes", "edges", "resolution_sets", "resolved_edges",
  "endpoint_memberships", "endpoint_aliases", "coverage_records",
  "embedding_generations", "embedding_jobs", "semantic_chunks",
  "semantic_embedding_refs", "semantic_vector_values", "semantic_active_spaces",
];

function databaseState(store, dbPath) {
  return {
    counts: Object.fromEntries(COUNT_TABLES.map((table) => [
      table,
      scalar(store.db, `SELECT COUNT(*) AS n FROM ${table}`),
    ])),
    pageCount: scalar(store.db, "PRAGMA page_count"),
    freelistCount: scalar(store.db, "PRAGMA freelist_count"),
    mainBytes: statSync(dbPath).size,
    walBytes: existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0,
  };
}

function liveReceipts(store, roots) {
  const select = store.db.prepare(`
    SELECT r.id AS repoId,b.id AS branchId,b.current_snapshot_id AS snapshotId
      FROM repos r JOIN branches b ON b.repo_id=r.id
     WHERE r.root_path=? AND b.status='live' AND b.current_snapshot_id IS NOT NULL
  `);
  return roots.map((rootPath) => {
    const row = select.get(realpathSync.native(rootPath));
    if (!row) throw new Error(`IDEMPOTENCY_LIVE_SNAPSHOT_MISSING:${rootPath}`);
    return { rootPath: realpathSync.native(rootPath), ...row };
  });
}

function digestMap(store, receipts) {
  return Object.fromEntries(receipts.map((receipt) => {
    const exported = exportCanonicalCorpus({
      store,
      repoId: receipt.repoId,
      branchId: receipt.branchId,
      snapshotId: receipt.snapshotId,
    });
    return [receipt.rootPath, exported.stableDigest ?? exported.digest];
  }));
}

async function main() {
  const rootPath = realpathSync.native(resolve(option("root", "/Users/shieng/Desktop/Projects")));
  const dbPath = resolve(option("db", join(homedir(), ".penguin", "knowledge", "knowledge.db")));
  const ledgerPath = resolve(option("ledger", join(homedir(), ".penguin", "knowledge", "ledger.jsonl")));
  const reportPath = resolve(option("report", join(homedir(), ".penguin", "jobs", "index-truth-idempotency-20.json")));
  const statusDirectory = resolve(option("status-dir", join(homedir(), ".penguin", "jobs", "index-truth-idempotency-20")));
  const attempts = Math.max(1, Math.min(100, Number(option("attempts", "20"))));
  if (!process.argv.includes("--execute")) throw new Error("IDEMPOTENCY_EXECUTE_REQUIRED");
  mkdirSync(statusDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });

  const roots = discoverFullCorpusRepositories(rootPath);
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  try {
    const beforeReceipts = liveReceipts(store, roots);
    const before = databaseState(store, dbPath);
    const beforeDigests = digestMap(store, beforeReceipts);
    const runs = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await runFullCorpus({
        store,
        rootPath,
        modes: ["index"],
        statusPath: join(statusDirectory, `attempt-${attempt}.json`),
        semantic: { enabled: false },
      });
      const snapshotIds = Object.fromEntries(liveReceipts(store, roots).map((row) => [row.rootPath, row.snapshotId]));
      const changedSnapshots = beforeReceipts
        .filter((row) => snapshotIds[row.rootPath] !== row.snapshotId)
        .map((row) => ({ rootPath: row.rootPath, before: row.snapshotId, after: snapshotIds[row.rootPath] }));
      runs.push({
        attempt,
        state: result.job.state,
        completedRepos: result.job.completedRepos,
        totalRepos: result.job.totalRepos,
        parsed: result.job.parsed,
        skipped: result.job.skipped,
        errors: result.job.errors,
        failures: result.failures,
        changedSnapshots,
      });
    }
    const afterReceipts = liveReceipts(store, roots);
    const after = databaseState(store, dbPath);
    const afterDigests = digestMap(store, afterReceipts);
    const countDeltas = Object.fromEntries(COUNT_TABLES.map((table) => [table, after.counts[table] - before.counts[table]]));
    const digestMismatches = roots
      .map((root) => realpathSync.native(root))
      .filter((root) => beforeDigests[root] !== afterDigests[root]);
    const ok = runs.length === attempts
      && runs.every((run) => run.state === "completed" && run.completedRepos === roots.length
        && run.parsed === 0 && run.errors === 0 && run.failures.length === 0
        && run.changedSnapshots.length === 0)
      && Object.values(countDeltas).every((delta) => delta === 0)
      && digestMismatches.length === 0;
    const report = {
      formatVersion: 1,
      rootPath,
      attempts,
      repositories: roots.length,
      before,
      after,
      beforeDigests,
      afterDigests,
      countDeltas,
      digestMismatches,
      runs,
      physicalSizeNote: "SQLite main/WAL byte counts may fluctuate; rebuildable and semantic row deltas plus canonical digests are the truth gate.",
      ok,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ reportPath, ok, attempts, repositories: roots.length, countDeltas, digestMismatches: digestMismatches.length }));
    if (!ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exitCode = 1;
});
