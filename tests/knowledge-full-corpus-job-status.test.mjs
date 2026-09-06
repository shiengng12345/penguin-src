import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import {
  readFullCorpusJob,
  requestFullCorpusCancel,
  requestFullCorpusPause,
  requestFullCorpusResume,
  retryFullCorpus,
  runFullCorpus,
} from "../packages/knowledge-indexer/dist/index.js";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Penguin Test",
      GIT_AUTHOR_EMAIL: "penguin@example.test",
      GIT_COMMITTER_NAME: "Penguin Test",
      GIT_COMMITTER_EMAIL: "penguin@example.test",
    },
  }).trim();
}

function createCorpus() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-full-corpus-status-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  for (const [name, symbol] of [["alpha", "alpha"], ["beta", "beta"]]) {
    const root = join(projects, name);
    mkdirSync(root);
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    writeFileSync(join(root, "src.ts"), `export function ${symbol}(): string { return "${name}"; }\n`);
    execFileSync("git", ["-C", root, "add", "src.ts"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Penguin Test",
        GIT_AUTHOR_EMAIL: "penguin@example.test",
        GIT_COMMITTER_NAME: "Penguin Test",
        GIT_COMMITTER_EMAIL: "penguin@example.test",
      },
    });
  }
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  return { directory, projects, store };
}

async function waitForStatus(path, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const job = readFullCorpusJob(path);
    if (predicate(job)) return job;
    if (Date.now() >= deadline) throw new Error(`status timeout: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runControlled(action) {
  const fixture = createCorpus();
  const statusPath = join(fixture.directory, `${action}.json`);
  let requested = false;
  try {
    const promise = runFullCorpus({
      store: fixture.store,
      rootPath: fixture.projects,
      statusPath,
      modes: ["index"],
      semantic: { enabled: false },
      onProgress: () => {
        if (requested) return;
        requested = true;
        if (action === "pause") requestFullCorpusPause(statusPath, "test pause");
        else requestFullCorpusCancel(statusPath, "test cancel");
      },
    });
    if (action === "pause") {
      const paused = await waitForStatus(statusPath, (job) => job.state === "paused");
      assert.equal(paused.phase, "index");
      assert.equal(readFileSync(`${statusPath}.control.json`, "utf8").includes("pause"), true);
      requestFullCorpusResume(statusPath);
      const result = await promise;
      assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
      assert.equal(result.job.state, "completed");
      assert.equal(result.repositories.index.length, 2);
      return;
    }
    const result = await promise;
    assert.equal(result.job.state, "cancelled");
    assert.equal(result.job.lastError, "FULL_CORPUS_CANCELLED");
    assert.equal(result.repositories.index.length < 2, true);
    assert.equal(result.failures.length, 0);
    assert.equal(readFullCorpusJob(statusPath).state, "cancelled");
  } finally {
    fixture.store.close();
  }
}

test("full corpus pause and resume is durable between repository shards", async () => {
  await runControlled("pause");
});

test("full corpus cancellation never reports a whole-root success", async () => {
  await runControlled("cancel");
});

test("retry starts a new terminal run and preserves the retry count", async () => {
  const fixture = createCorpus();
  const statusPath = join(fixture.directory, "retry.json");
  const controller = new AbortController();
  let aborted = false;
  try {
    const cancelled = await runFullCorpus({
      store: fixture.store,
      rootPath: fixture.projects,
      statusPath,
      modes: ["index"],
      semantic: { enabled: false },
      signal: controller.signal,
      onProgress: () => {
        if (!aborted) {
          aborted = true;
          controller.abort();
        }
      },
    });
    assert.equal(cancelled.job.state, "cancelled");
    assert.equal(cancelled.job.retryCount, 0);

    const retried = await retryFullCorpus({
      store: fixture.store,
      statusPath,
      semantic: { enabled: false },
    });
    assert.equal(retried.job.state, "completed", JSON.stringify(retried.failures));
    assert.equal(retried.job.retryCount, 1);
    assert.equal(retried.job.jobId, cancelled.job.jobId);
    assert.equal(readFullCorpusJob(statusPath).state, "completed");
    assert.throws(
      () => requestFullCorpusPause(statusPath),
      /FULL_CORPUS_JOB_NOT_ACTIVE:completed/,
    );
  } finally {
    fixture.store.close();
  }
});
