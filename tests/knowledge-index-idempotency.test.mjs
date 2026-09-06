import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeStore, exportCanonicalCorpus } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin Idempotency Test",
  GIT_AUTHOR_EMAIL: "penguin-idempotency@example.invalid",
  GIT_COMMITTER_NAME: "Penguin Idempotency Test",
  GIT_COMMITTER_EMAIL: "penguin-idempotency@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

test("twenty no-change index attempts reuse one snapshot and do not add corpus rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-idempotency-"));
  const repo = join(directory, "repo");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
    writeFileSync(join(repo, "src", "stable.ts"), "export function stable(): number { return 1; }\n");
    writeFileSync(join(repo, "README.md"), "# Stable documentation\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "idempotent fixture");
    const store = KnowledgeStore.open({
      dbPath: join(directory, "knowledge.db"),
      ledgerPath: join(directory, "ledger.jsonl"),
    });
    try {
      const first = await indexRepo({ store, rootPath: repo, mode: "rebuild", semantic: { enabled: false } });
      const initialSnapshot = first.revisionTruth.snapshotId;
      const stable = exportCanonicalCorpus({ store, repoId: first.repoId, branchId: first.branchId });
      const count = (table) => Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
      const tables = ["revision_snapshots", "source_blobs", "source_facts", "file_facts", "nodes", "edges", "resolution_sets", "resolved_edges"];
      const before = Object.fromEntries(tables.map((table) => [table, count(table)]));
      const generationsBefore = Number(store.db.prepare("SELECT value FROM meta WHERE key='revision_generation'").get().value);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const report = await indexRepo({ store, rootPath: repo, mode: "incremental", semantic: { enabled: false } });
        assert.equal(report.parsed, 0, JSON.stringify(report));
        assert.ok(report.skipped >= 1, JSON.stringify(report));
        assert.equal(report.revisionTruth.snapshotId, initialSnapshot);
        assert.equal(report.revisionTruth.alignment, "aligned");
      }

      const after = Object.fromEntries(tables.map((table) => [table, count(table)]));
      assert.deepEqual(after, before);
      const generationsAfter = Number(store.db.prepare("SELECT value FROM meta WHERE key='revision_generation'").get().value);
      assert.equal(generationsAfter - generationsBefore, 20);
      const current = exportCanonicalCorpus({ store, repoId: first.repoId, branchId: first.branchId });
      assert.equal(current.digest, stable.digest);
      assert.equal(count("revision_snapshots"), 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
