import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runFullCorpus } from "../packages/knowledge-indexer/dist/index.js";

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

test("independent source oracle catches the published endpoint set without trusting CLI output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-independent-oracle-"));
  const projects = join(directory, "Projects");
  const repoRoot = join(projects, "auth");
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "version.controller.ts"), `
    import { Controller } from "@nestjs/common";
    import { GrpcMethod } from "@nestjs/microservices";
    @Controller()
    export class VersionController {
      @GrpcMethod("VersionService", "Version")
      version(): string { return "1.0.0"; }
    }
  `);
  gitCommit(repoRoot);
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  try {
    const run = await runFullCorpus({
      store,
      rootPath: projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    assert.equal(run.failures.length, 0, JSON.stringify(run.failures));
  } finally {
    store.close();
  }

  const raw = execFileSync(process.execPath, [
    "scripts/knowledge-corpus-reconcile.mjs",
    `--root=${projects}`,
    `--db=${dbPath}`,
    `--ledger=${ledgerPath}`,
    "--strict",
  ], { encoding: "utf8" });
  const report = JSON.parse(raw);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.repositories.length, 1);
  const repository = report.repositories[0];
  assert.equal(repository.status, "passed", JSON.stringify(repository.gaps));
  assert.deepEqual(repository.sourceOracle.endpointRecords.map((record) => record.key), ["gRPC VersionService.Version"]);
  assert.deepEqual(repository.endpoints.missingFromPersisted, []);
  assert.deepEqual(repository.endpoints.unexpectedInPersisted, []);
  assert.equal(repository.identity.readySnapshot, true);
});
