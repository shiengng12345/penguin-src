import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function gitCommit(root) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.test",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.test",
  };
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env });
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-cli-corpus-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  for (const [name, symbol] of [["alpha", "alpha"], ["beta", "beta"]]) {
    const root = join(projects, name);
    mkdirSync(root);
    writeFileSync(join(root, "src.ts"), `export function ${symbol}(): string { return "${name}"; }\n`);
    gitCommit(root);
  }
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  return { directory, projects, dbPath, ledgerPath };
}

function cli(fixture, argv, overrides = {}) {
  const out = [];
  const err = [];
  const code = runCli(argv, {
    cwd: fixture.projects,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    storeExists: () => true,
    requireOperationConfirmation: false,
    openStore: () => KnowledgeStore.open({ dbPath: fixture.dbPath, ledgerPath: fixture.ledgerPath }),
    ...overrides,
  });
  return Promise.resolve(code).then((exitCode) => ({ exitCode, out, err }));
}

test("CLI corpus discover, dry-run, run, and status share a durable contract", async () => {
  const fixture = createFixture();
  const statusPath = join(fixture.directory, "job.json");
  const discovered = await cli(fixture, ["corpus", "discover", fixture.projects, "--json"]);
  assert.equal(discovered.exitCode, 0, discovered.err.join("\n"));
  const discoveredPayload = JSON.parse(discovered.out.at(-1));
  assert.equal(discoveredPayload.totalRepos, 2);
  assert.equal(discoveredPayload.repositories.length, 2);

  const dryRun = await cli(fixture, ["corpus", "run", fixture.projects, "--mode", "both", "--status", statusPath, "--dry-run", "--json"]);
  assert.equal(dryRun.exitCode, 0, dryRun.err.join("\n"));
  const dryPayload = JSON.parse(dryRun.out.at(-1));
  assert.equal(dryPayload.operation, "corpus.run");
  assert.equal(dryPayload.mutated, false);
  assert.equal(dryPayload.repositories.length, 2);
  assert.equal(dryPayload.modes.join(","), "index,rebuild");
  assert.equal(typeof dryPayload.operationToken, "string");

  const run = await cli(fixture, ["corpus", "run", fixture.projects, "--mode", "both", "--status", statusPath, "--json"]);
  assert.equal(run.exitCode, 0, `${run.err.join("\n")}\n${run.out.join("\n")}`);
  const result = JSON.parse(run.out.at(-1));
  assert.equal(result.job.state, "completed");
  assert.equal(result.repositories.index.length, 2);
  assert.equal(result.repositories.rebuild.length, 2);
  assert.equal(readFileSync(statusPath, "utf8").includes('"state": "completed"'), true);

  const status = await cli(fixture, ["corpus", "status", "--status", statusPath, "--json"]);
  assert.equal(status.exitCode, 0, status.err.join("\n"));
  const statusPayload = JSON.parse(status.out.at(-1));
  assert.equal(statusPayload.state, "completed");
  assert.equal(statusPayload.jobId, result.job.jobId);
});

test("CLI corpus reconciliation uses the host oracle boundary once per repository shard", async () => {
  const fixture = createFixture();
  const statusPath = join(fixture.directory, "job.json");
  const run = await cli(fixture, ["corpus", "run", fixture.projects, "--mode", "rebuild", "--status", statusPath, "--json"]);
  assert.equal(run.exitCode, 0, run.err.join("\n"));

  const calls = [];
  const reconciled = await cli(fixture, ["corpus", "reconcile", fixture.projects, "--json"], {
    collectCorpusOracle: async (rootPath) => {
      calls.push(rootPath);
      const commit = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      return {
        rootPath,
        git: { branch: "main", commit, worktreeState: "clean", worktreeFingerprint: "fixture", dirtyFiles: [] },
        source: {
          discoveredFiles: 1,
          admittedFiles: 1,
          excludedFiles: 0,
          failedFiles: 0,
          staleFiles: 0,
          parserEligibleFiles: 1,
          endpointKeys: [],
          endpointOccurrences: 0,
        },
        endpointRecords: [],
        parserErrors: [],
        discoveryWarnings: [],
      };
    },
  });
  assert.equal(reconciled.exitCode, 0, `${reconciled.err.join("\n")}\n${reconciled.out.join("\n")}`);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.sort(), [realpathSync.native(join(fixture.projects, "alpha")), realpathSync.native(join(fixture.projects, "beta"))].sort());
});
