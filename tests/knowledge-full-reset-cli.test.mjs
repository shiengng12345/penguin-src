import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeStore, executeFullReset, readResetManifest } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";

function gitRepo(root) {
  const repoPath = join(root, "reset-target");
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["-C", repoPath, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "penguin@example.test"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Penguin Test"]);
  writeFileSync(join(repoPath, "index.ts"), "export function ResetCliNeedle() { return 17; }\n");
  execFileSync("git", ["-C", repoPath, "add", "index.ts"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "-m", "fixture"]);
  return repoPath;
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-reset-cli-"));
  const projects = join(directory, "Projects");
  const repoPath = gitRepo(projects);
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const backupPath = join(directory, "knowledge.db.backup");
  const manifestPath = join(directory, "reset-manifest.json");
  const lines = [];
  const errors = [];
  const deps = {
    cwd: repoPath,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    storeExists: () => existsSync(dbPath),
    openStore: (options = {}) => KnowledgeStore.open({ dbPath, ledgerPath, ...options }),
    requireOperationConfirmation: true,
  };
  return { directory, projects, repoPath, dbPath, backupPath, manifestPath, lines, errors, deps };
}

test("owner-only corpus reset CLI plans, reports, executes once, and prepares rollback", async () => {
  const h = harness();

  assert.equal(await runCli(["index", h.repoPath, "--dry-run", "--json"], h.deps), 0);
  const indexPlan = JSON.parse(h.lines.pop());
  assert.equal(await runCli(["index", h.repoPath, `--confirm=${indexPlan.operationToken}`, "--json"], h.deps), 0);

  assert.equal(await runCli([
    "corpus", "reset", "plan", h.projects,
    "--backup", h.backupPath,
    "--manifest", h.manifestPath,
    "--minimum-free-after-bytes", "0",
    "--json",
  ], h.deps), 0);
  const planned = JSON.parse(h.lines.at(-1));
  assert.equal(planned.plan.risk, "full_corpus_reset");
  assert.equal(planned.plan.manifestPath, h.manifestPath);
  assert.equal(existsSync(h.backupPath), true);
  assert.equal(existsSync(h.manifestPath), true);

  const mcpStore = h.deps.openStore({ allowSchemaMutation: false });
  try {
    const mcpStatus = handleKnowledgeTool("knowledge_index_status", {
      reset_manifest_path: h.manifestPath,
    }, mcpStore);
    assert.equal(mcpStatus.phase, "backed_up");
    assert.equal(mcpStatus.plan.confirmationToken, "redacted");
    assert.equal(mcpStatus.mutationAvailableThroughMcp, false);
    assert.match(mcpStatus.ownerCommands.status, /penguin corpus reset status/);

    const outside = handleKnowledgeTool("knowledge_index_status", {
      reset_manifest_path: join(h.directory, "outside", "manifest.json"),
    }, mcpStore);
    assert.equal(outside.error.code, "RESET_MANIFEST_OUTSIDE_DATABASE_DIRECTORY");
  } finally {
    mcpStore.close();
  }

  h.lines.length = 0;
  assert.equal(await runCli([
    "corpus", "reset", "status", "--manifest", h.manifestPath, "--json",
  ], h.deps), 0);
  assert.equal(JSON.parse(h.lines.at(-1)).phase, "backed_up");

  assert.equal(await runCli([
    "corpus", "reset", "execute", "--manifest", h.manifestPath, "--json",
  ], h.deps), 6);
  assert.equal(readResetManifest(h.manifestPath).tokenConsumed, false);

  h.lines.length = 0;
  assert.equal(await runCli([
    "corpus", "reset", "execute", "--manifest", h.manifestPath,
    `--confirm=${planned.plan.confirmationToken}`, "--json",
  ], h.deps), 0);
  const executed = JSON.parse(h.lines.at(-1));
  assert.equal(executed.phase, "reset");
  assert.equal(executed.sourceRepositoriesUntouched, true);
  assert.equal(readResetManifest(h.manifestPath).tokenConsumed, true);

  h.lines.length = 0;
  assert.equal(await runCli([
    "corpus", "reset", "recover", "--manifest", h.manifestPath,
    `--confirm=${planned.plan.operationId}:recover`, "--json",
  ], h.deps), 0);
  const recovery = JSON.parse(h.lines.at(-1));
  assert.equal(recovery.recovered, false);
  assert.deepEqual(recovery.gaps, ["RESET_FENCE_NOT_PRESENT"]);

  assert.equal(await runCli([
    "corpus", "reset", "execute", "--manifest", h.manifestPath,
    `--confirm=${planned.plan.confirmationToken}`, "--json",
  ], h.deps), 1);

  const destinationPath = join(h.directory, "rollback.db");
  h.lines.length = 0;
  assert.equal(await runCli([
    "corpus", "reset", "rollback", "--manifest", h.manifestPath,
    "--out", destinationPath,
    `--confirm=${planned.plan.operationId}:rollback`, "--json",
  ], h.deps), 0);
  const rollback = JSON.parse(h.lines.at(-1));
  assert.equal(rollback.integrity, "ok");
  assert.equal(rollback.destinationPath, destinationPath);
  assert.equal(existsSync(destinationPath), true);
});

test("owner-only corpus reset CLI finalizes a consumed post-delete failure", async () => {
  const h = harness();
  assert.equal(await runCli(["index", h.repoPath, "--dry-run", "--json"], h.deps), 0);
  const indexPlan = JSON.parse(h.lines.pop());
  assert.equal(await runCli(["index", h.repoPath, `--confirm=${indexPlan.operationToken}`, "--json"], h.deps), 0);
  assert.equal(await runCli([
    "corpus", "reset", "plan", h.projects,
    "--backup", h.backupPath,
    "--manifest", h.manifestPath,
    "--minimum-free-after-bytes", "0",
    "--json",
  ], h.deps), 0);
  const planned = JSON.parse(h.lines.at(-1));
  const store = h.deps.openStore();
  try {
    const failed = executeFullReset({ db: store.db }, planned.plan, {
      databasePath: h.dbPath,
      token: planned.plan.confirmationToken,
      manifestPath: h.manifestPath,
      failAt: "after_reset",
    });
    assert.equal(failed.phase, "failed");
  } finally {
    store.close();
  }

  assert.equal(await runCli([
    "corpus", "reset", "finalize", "--manifest", h.manifestPath, "--json",
  ], h.deps), 6);
  h.lines.length = 0;
  assert.equal(await runCli([
    "corpus", "reset", "finalize", "--manifest", h.manifestPath,
    `--confirm=${planned.plan.operationId}:finalize`, "--json",
  ], h.deps), 0);
  const finalized = JSON.parse(h.lines.at(-1));
  assert.equal(finalized.phase, "reset", JSON.stringify(finalized.gaps));
  assert.notEqual(finalized.databaseInstanceId, planned.plan.databaseInstanceId);
  assert.equal(readResetManifest(h.manifestPath).phase, "reset");
});
