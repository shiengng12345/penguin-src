import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "knowledge-real-branch-matrix.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin Branch Runner Test",
  GIT_AUTHOR_EMAIL: "penguin-branch-runner@example.invalid",
  GIT_COMMITTER_NAME: "Penguin Branch Runner Test",
  GIT_COMMITTER_EMAIL: "penguin-branch-runner@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
}

function createRepository(projects, name, withUpstream) {
  const root = join(projects, name);
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "master");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "base.ts"), `export function ${name}Base(): string { return \"base\"; }\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  if (withUpstream) {
    const upstream = join(projects, `${name}-upstream.git`);
    execFileSync("git", ["clone", "--bare", "-q", root, upstream], { env: GIT_ENV });
    git(root, "remote", "add", "upstream", upstream);
    git(root, "fetch", "-q", "upstream", "master");
  }
  return {
    root,
    head: git(root, "rev-parse", "HEAD"),
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

function runMatrix(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

test("real branch matrix isolates each repository DB, writes durable receipts, and resumes safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-real-branch-runner-test-"));
  const projects = join(directory, "Projects");
  const processTmp = join(directory, "tmp");
  mkdirSync(projects);
  mkdirSync(processTmp);
  const alpha = createRepository(projects, "alpha", true);
  const beta = createRepository(projects, "beta", false);
  const reportPath = join(directory, "matrix.json");
  const env = {
    ...GIT_ENV,
    TMPDIR: processTmp,
    NODE_ENV: "test",
    PENGUIN_TEST_BRANCH_MATRIX_MINIMUM_FREE_BYTES: "0",
  };

  const first = runMatrix(["--root", projects, "--report", reportPath], env);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.status, "completed");
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.repositories.length, 2);
  assert.equal(report.repositories.every((item) => item.temporaryDatabaseBytes > 0), true);
  assert.equal(report.repositories.every((item) => item.stages.featureBeforeIndex.errorCode === "BRANCH_NOT_INDEXED"), true);
  assert.equal(report.repositories.every((item) => item.stages.diffBeforeRebuild.errorCode === "BRANCH_NOT_INDEXED"), true);
  assert.equal(existsSync(`${reportPath}.partial.json`), false);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(processTmp), [], "per-repository workspaces must be deleted after completion");
  assert.equal(git(alpha.root, "rev-parse", "HEAD"), alpha.head);
  assert.equal(git(alpha.root, "status", "--porcelain=v1", "--untracked-files=all"), alpha.status);
  assert.equal(git(beta.root, "rev-parse", "HEAD"), beta.head);
  assert.equal(git(beta.root, "status", "--porcelain=v1", "--untracked-files=all"), beta.status);

  const noClobber = runMatrix(["--root", projects, "--report", reportPath], env);
  assert.notEqual(noClobber.status, 0);
  assert.match(noClobber.stderr, /BRANCH_MATRIX_REPORT_EXISTS/);

  const resumeReport = join(directory, "matrix-resumed.json");
  const partialPath = `${resumeReport}.partial.json`;
  const partial = {
    ...report,
    status: "running",
    completedAt: undefined,
    updatedAt: new Date().toISOString(),
    passed: 1,
    repositories: [report.repositories[0]],
  };
  writeFileSync(partialPath, `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
  const resumed = runMatrix(["--root", projects, "--report", resumeReport, "--resume"], env);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  const resumedReport = JSON.parse(readFileSync(resumeReport, "utf8"));
  assert.equal(resumedReport.passed, 2);
  assert.equal(resumedReport.repositories[0].resumed, true);
  assert.equal(resumedReport.repositories[1].resumed, undefined);
  assert.equal(existsSync(partialPath), false);
  assert.deepEqual(readdirSync(processTmp), [], "resume must also clean per-repository workspaces");
});
