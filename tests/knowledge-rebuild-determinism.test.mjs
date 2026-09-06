import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  KnowledgeStore,
  exportCanonicalCorpus,
} from "../packages/knowledge-core/dist/index.js";
import {
  discoverFullCorpusRepositories,
  runFullCorpus,
} from "../packages/knowledge-indexer/dist/index.js";
import { runDeterminism } from "../scripts/knowledge-rebuild-determinism.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin Determinism Test",
  GIT_AUTHOR_EMAIL: "penguin-determinism@example.invalid",
  GIT_COMMITTER_NAME: "Penguin Determinism Test",
  GIT_COMMITTER_EMAIL: "penguin-determinism@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function createRepo(parent) {
  const root = join(parent, "determinism-repo");
  mkdirSync(join(root, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: GIT_ENV });
  writeFileSync(join(root, "src", "alpha.ts"), "export function alpha(): string { return beta(); }\nfunction beta(): string { return 'ok'; }\n");
  writeFileSync(join(root, "README.md"), "# deterministic fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "deterministic fixture");
  return root;
}

function exportFor(store, receipt) {
  return exportCanonicalCorpus({
    store,
    repoId: receipt.repoId,
    branchId: receipt.branchId,
    snapshotId: receipt.snapshotId,
  });
}

test("three fresh full rebuilds produce the same canonical corpus digest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-determinism-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  const root = createRepo(projects);
  const digests = [];
  const projections = [];
  try {
    assert.deepEqual(discoverFullCorpusRepositories(projects), [realpathSync.native(root)]);
    for (let run = 0; run < 3; run += 1) {
      const store = KnowledgeStore.open({
        dbPath: join(directory, `knowledge-${run}.db`),
        ledgerPath: join(directory, `ledger-${run}.jsonl`),
      });
      try {
        const result = await runFullCorpus({
          store,
          rootPath: projects,
          modes: ["rebuild"],
          statusPath: join(directory, `run-${run}.json`),
          semantic: { enabled: false },
        });
        assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
        assert.equal(result.job.state, "completed");
        assert.ok(result.repositories.rebuild[0].parsed > 0);
        const exported = exportFor(store, result.repositories.rebuild[0]);
        digests.push(exported.digest);
        projections.push(exported.stable);
        assert.ok(exported.stable.nodes.length > 0);
        assert.ok(exported.stable.files.length > 0);
      } finally {
        store.close();
      }
    }
    assert.deepEqual(projections[1], projections[0]);
    assert.deepEqual(projections[2], projections[0]);
    assert.equal(new Set(digests).size, 1, JSON.stringify(digests));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("determinism runner can resume from the current published snapshot without repeating run one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-determinism-resume-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  createRepo(projects);
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  try {
    const initial = await runFullCorpus({
      store,
      rootPath: projects,
      modes: ["rebuild"],
      statusPath: join(directory, "initial.json"),
      semantic: { enabled: false },
    });
    assert.equal(initial.failures.length, 0);
    const report = await runDeterminism({
      store,
      rootPath: projects,
      rebuilds: 3,
      includeCurrent: true,
      statusDirectory: join(directory, "resume-status"),
    });
    assert.equal(report.ok, true, JSON.stringify(report.differences));
    assert.equal(report.runs.length, 3);
    assert.equal(report.runs[0].job.mode, "current");
    assert.equal(report.runs[1].job.mode, "rebuild");
    assert.equal(report.runs[2].job.mode, "rebuild");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
