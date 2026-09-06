#!/usr/bin/env node

/**
 * Real-corpus branch isolation rehearsal.
 *
 * This intentionally works on disposable shared clones. It reads the real
 * repository refs/status, but never checks out, commits, or indexes against a
 * source checkout under the requested corpus root.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo, discoverFullCorpusRepositories } from "../packages/knowledge-indexer/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin Real Branch Matrix",
  GIT_AUTHOR_EMAIL: "penguin-real-branch-matrix@example.invalid",
  GIT_COMMITTER_NAME: "Penguin Real Branch Matrix",
  GIT_COMMITTER_EMAIL: "penguin-real-branch-matrix@example.invalid",
};
const DEFAULT_MINIMUM_FREE_BYTES = 8 * 1024 * 1024 * 1024;
const testMinimumFreeBytes = process.env.NODE_ENV === "test"
  ? Number(process.env.PENGUIN_TEST_BRANCH_MATRIX_MINIMUM_FREE_BYTES)
  : Number.NaN;
const MINIMUM_FREE_BYTES = Number.isSafeInteger(testMinimumFreeBytes) && testMinimumFreeBytes >= 0
  ? testMinimumFreeBytes
  : DEFAULT_MINIMUM_FREE_BYTES;
const RUNNER_HASH = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");

function parseArgs(argv) {
  const options = {
    root: resolve("/Users/shieng/Desktop/Projects"),
    report: null,
    limit: null,
    keep: false,
    resume: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--resume") {
      options.resume = true;
      continue;
    }
    const [key, inline] = arg.split("=", 2);
    if (key === "--root") options.root = resolve(inline ?? argv[++index]);
    else if (key === "--report") options.report = resolve(inline ?? argv[++index]);
    else if (key === "--limit") options.limit = Math.max(1, Number(inline ?? argv[++index]));
    else if (key === "--help" || key === "-h") {
      console.log("usage: node scripts/knowledge-real-branch-matrix.mjs [--root PATH] [--report PATH] [--limit N] [--resume] [--keep]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.report) {
    options.report = resolve(`/tmp/penguin-real-branch-matrix-${Date.now()}.json`);
  }
  return options;
}

function availableBytes(path) {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function writeFinalJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { linkSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function resumableResult(result, sourceRoot) {
  if (!result?.passed || result.sourceRoot !== sourceRoot || result.runnerHash !== RUNNER_HASH) return false;
  const current = sourceState(sourceRoot);
  return JSON.stringify(current) === JSON.stringify(result.sourceBefore)
    && JSON.stringify(current) === JSON.stringify(result.sourceAfter);
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(root, ...args) {
  try {
    return { ok: true, value: git(root, ...args) };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: String(error?.stderr?.toString?.() ?? error?.message ?? error).trim(),
    };
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceState(root) {
  const status = tryGit(root, "status", "--porcelain=v1", "--untracked-files=all");
  const lines = status.ok ? status.value.split(/\r?\n/).filter(Boolean) : [];
  const head = tryGit(root, "rev-parse", "HEAD");
  const branch = tryGit(root, "symbolic-ref", "--short", "HEAD");
  return {
    head: head.ok ? head.value : null,
    branch: branch.ok ? branch.value : "(detached)",
    dirtyFiles: lines.length,
    statusHash: sha256(status.ok ? status.value : `status-error:${status.error}`),
    statusReadable: status.ok,
  };
}

function branchInventory(root) {
  const local = tryGit(root, "for-each-ref", "refs/heads", "--format=%(refname:short)");
  const remote = tryGit(root, "for-each-ref", "refs/remotes", "--format=%(refname:short)");
  const localBranches = local.ok ? local.value.split(/\r?\n/).filter(Boolean).sort() : [];
  const remoteBranches = remote.ok ? remote.value.split(/\r?\n/).filter(Boolean).sort() : [];
  const upstream = tryGit(root, "rev-parse", "--verify", "refs/remotes/upstream/master");
  return {
    local: localBranches,
    remote: remoteBranches,
    usableCount: new Set([...localBranches, ...remoteBranches]).size,
    upstreamMaster: upstream.ok ? upstream.value : null,
  };
}

function chooseLanguage(root) {
  if (existsSync(join(root, "Cargo.toml"))) return { extension: ".rs", language: "rust" };
  if (existsSync(join(root, "tsconfig.json")) || existsSync(join(root, "nest-cli.json"))) return { extension: ".ts", language: "typescript" };
  if (existsSync(join(root, "go.mod"))) return { extension: ".go", language: "go" };
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "setup.py"))) return { extension: ".py", language: "python" };
  if (existsSync(join(root, "package.json"))) return { extension: ".js", language: "javascript" };
  return { extension: ".ts", language: "typescript" };
}

function markerSource(language, featureSymbol, marker) {
  switch (language) {
    case "rust":
      return `pub fn ${featureSymbol}() -> &'static str { \"${marker}\" }\n`;
    case "go":
      return `package branchmatrix\n\nfunc ${featureSymbol}() string { return \"${marker}\" }\n`;
    case "python":
      return `def ${featureSymbol}():\n    return \"${marker}\"\n`;
    case "javascript":
      return `export function ${featureSymbol}() { return \"${marker}\"; }\n`;
    default:
      return `export function ${featureSymbol}(): string { return \"${marker}\"; }\n`;
  }
}

function shortResult(value) {
  const error = value?.error;
  const errorCode = typeof error === "object" && error !== null ? error.code : typeof error === "string" ? error : null;
  return {
    errorCode: errorCode ?? null,
    alignment: value?.alignment ?? null,
    branchName: value?.locator?.branchName ?? value?.scope?.branchName ?? null,
    repoId: value?.locator?.repoId ?? value?.scope?.repoId ?? null,
    snapshotId: value?.locator?.snapshotId ?? value?.scope?.snapshotId ?? null,
    hasFacts: Array.isArray(value?.facts) ? value.facts.length > 0 : Array.isArray(value?.results) ? value.results.length > 0 : value?.error === undefined,
    bytes: Buffer.byteLength(JSON.stringify(value ?? null), "utf8"),
  };
}

function context(store, repoId, target, allowFallback = false) {
  // Deliberately omit branch here. This models an MCP consumer tied to the
  // registered checkout: the resolver reads the clone's current branch and
  // must return BRANCH_NOT_INDEXED before publication. Explicit branch names
  // that do not yet exist in the index correctly produce SCOPE_NOT_FOUND and
  // would test a different contract.
  return handleKnowledgeTool("knowledge_context", {
    repo: repoId,
    target,
    allow_fallback: allowFallback,
  }, store);
}

function indexOptions(store, rootPath, mode) {
  return indexRepo({ store, rootPath, mode, semantic: { enabled: false } });
}

function checkoutBranch(root, branch, startPoint) {
  git(root, "checkout", "-q", "--detach", startPoint);
  git(root, "checkout", "-q", "-b", branch);
}

function commitMarker(root, relativePath, content, message) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  git(root, "add", "-f", relativePath);
  git(root, "commit", "-q", "-m", message);
}

function cloneSource(sourceRoot, workspaceRoot, name) {
  const cloneRoot = join(workspaceRoot, name);
  execFileSync("git", ["clone", "--shared", "--no-tags", "-q", sourceRoot, cloneRoot], {
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return cloneRoot;
}

async function runRepository({ sourceRoot, index, total, workspaceRoot, store, keepWorkspace }) {
  const startedAt = Date.now();
  const name = basename(sourceRoot);
  const sourceBefore = sourceState(sourceRoot);
  const inventory = branchInventory(sourceRoot);
  const language = chooseLanguage(sourceRoot);
  const slug = name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32) || `repo_${index}`;
  const featureBranch = "matrix/feature-from-upstream";
  const diffBranch = "matrix/diff-from-base";
  const featureSymbol = `PenguinBranchMatrix_${slug}_Feature`;
  const diffSymbol = `PenguinBranchMatrix_${slug}_Diff`;
  const featureMarker = `PENGUIN_BRANCH_MATRIX_FEATURE_${slug}`;
  const diffMarker = `PENGUIN_BRANCH_MATRIX_DIFF_${slug}`;
  const relativeDirectory = existsSync(join(sourceRoot, "src")) ? "src" : "penguin-branch-matrix";
  const featurePath = `${relativeDirectory}/penguin_branch_matrix_feature${language.extension}`;
  const diffPath = `${relativeDirectory}/penguin_branch_matrix_diff${language.extension}`;
  const result = {
    index,
    total,
    runnerHash: RUNNER_HASH,
    sourceRoot,
    name,
    sourceBefore,
    inventory,
    language,
    featureBranch,
    diffBranch,
    featureSource: { path: featurePath, symbol: featureSymbol, marker: featureMarker },
    diffSource: { path: diffPath, symbol: diffSymbol, marker: diffMarker },
    stages: {},
    passed: false,
    durationMs: 0,
    failure: null,
  };
  let cloneRoot = null;
  try {
    cloneRoot = cloneSource(sourceRoot, workspaceRoot, `${String(index).padStart(2, "0")}-${slug}`);
    const cloneHead = git(cloneRoot, "rev-parse", "HEAD");
    const baseStart = inventory.upstreamMaster ?? cloneHead;
    const upstreamScenario = inventory.upstreamMaster !== null;

    // The clone has the same object store, but local clones do not necessarily
    // carry the source checkout's upstream tracking refs. Recreate only that
    // ref inside the disposable clone so the checkout shape is genuine.
    if (inventory.upstreamMaster) git(cloneRoot, "update-ref", "refs/remotes/upstream/master", inventory.upstreamMaster);
    checkoutBranch(cloneRoot, "matrix/base", baseStart);
    const baseReport = await indexOptions(store, cloneRoot, "incremental");
    result.stages.baseIndex = {
      branch: baseReport.branchName,
      repoId: baseReport.repoId,
      parsed: baseReport.parsed,
      skipped: baseReport.skipped,
      errors: baseReport.errors,
      indexedCommit: baseReport.indexedCommit,
      revisionAligned: baseReport.revisionTruth?.aligned ?? null,
    };
    assert.equal(baseReport.branchName, "matrix/base");
    assert.equal(baseReport.errors, 0, "base index has parser errors");
    const repoId = baseReport.repoId;
    result.repoId = repoId;
    const baseContext = context(store, repoId, featureSymbol);
    result.stages.baseFeatureAbsent = shortResult(baseContext);
    assert.notEqual(result.stages.baseFeatureAbsent.errorCode, null, "feature fact leaked into base before feature branch exists");

    checkoutBranch(cloneRoot, featureBranch, baseStart);
    assert.equal(tryGit(cloneRoot, "rev-parse", "--verify", "refs/remotes/upstream/master").ok, upstreamScenario);
    commitMarker(cloneRoot, featurePath, markerSource(language.language, featureSymbol, featureMarker), "matrix feature from upstream master");
    const featureBefore = context(store, repoId, featureSymbol);
    result.stages.featureBeforeIndex = shortResult(featureBefore);
    assert.equal(result.stages.featureBeforeIndex.errorCode, "BRANCH_NOT_INDEXED");
    const featureReport = await indexOptions(store, cloneRoot, "incremental");
    const featureAfter = context(store, repoId, featureSymbol);
    result.stages.featureIndex = {
      branch: featureReport.branchName,
      parsed: featureReport.parsed,
      skipped: featureReport.skipped,
      errors: featureReport.errors,
      indexedCommit: featureReport.indexedCommit,
      revisionAligned: featureReport.revisionTruth?.aligned ?? null,
      query: shortResult(featureAfter),
    };
    assert.equal(featureReport.branchName, featureBranch);
    assert.equal(featureReport.errors, 0, "feature index has parser errors");
    assert.equal(result.stages.featureIndex.query.errorCode, null);
    assert.equal(result.stages.featureIndex.query.branchName, featureBranch);

    checkoutBranch(cloneRoot, diffBranch, baseStart);
    commitMarker(cloneRoot, diffPath, markerSource(language.language, diffSymbol, diffMarker), "matrix divergent diff branch");
    const diffBefore = context(store, repoId, diffSymbol);
    result.stages.diffBeforeRebuild = shortResult(diffBefore);
    assert.equal(result.stages.diffBeforeRebuild.errorCode, "BRANCH_NOT_INDEXED");
    const featureOnDiffBefore = context(store, repoId, featureSymbol);
    result.stages.featureOnDiffBeforeRebuild = shortResult(featureOnDiffBefore);
    assert.notEqual(result.stages.featureOnDiffBeforeRebuild.errorCode, null, "feature branch fact leaked before diff rebuild");

    const diffReport = await indexOptions(store, cloneRoot, "rebuild");
    const diffAfter = context(store, repoId, diffSymbol);
    const featureOnDiffAfter = context(store, repoId, featureSymbol);
    result.stages.diffRebuild = {
      branch: diffReport.branchName,
      parsed: diffReport.parsed,
      skipped: diffReport.skipped,
      errors: diffReport.errors,
      indexedCommit: diffReport.indexedCommit,
      revisionAligned: diffReport.revisionTruth?.aligned ?? null,
      query: shortResult(diffAfter),
      featureLeakCheck: shortResult(featureOnDiffAfter),
    };
    assert.equal(diffReport.branchName, diffBranch);
    assert.equal(diffReport.errors, 0, "diff rebuild has parser errors");
    assert.equal(result.stages.diffRebuild.query.errorCode, null);
    assert.equal(result.stages.diffRebuild.query.branchName, diffBranch);
    assert.notEqual(result.stages.diffRebuild.featureLeakCheck.errorCode, null, "feature symbol leaked into divergent branch");

    git(cloneRoot, "checkout", "-q", "matrix/base");
    const baseAfter = context(store, repoId, featureSymbol);
    result.stages.baseFeatureStillAbsent = shortResult(baseAfter);
    assert.notEqual(result.stages.baseFeatureStillAbsent.errorCode, null, "feature fact leaked into base snapshot");
    const sourceAfter = sourceState(sourceRoot);
    result.sourceAfter = sourceAfter;
    assert.deepEqual(sourceAfter, sourceBefore, "source checkout changed during disposable branch matrix");
    result.sourceUnchanged = true;
    result.passed = true;
  } catch (error) {
    result.failure = {
      message: String(error?.message ?? error),
      stack: error?.stack ?? null,
    };
    result.sourceAfter = sourceState(sourceRoot);
    result.sourceUnchanged = JSON.stringify(result.sourceAfter) === JSON.stringify(sourceBefore);
  } finally {
    if (cloneRoot && result.sourceAfter === undefined) result.sourceAfter = sourceState(sourceRoot);
    if (cloneRoot && !keepWorkspace) {
      try { rmSync(cloneRoot, { recursive: true, force: true }); } catch { /* report owns the failure */ }
    }
  }
  result.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    event: result.passed ? "repo-passed" : "repo-failed",
    index,
    total,
    repo: name,
    upstreamMaster: Boolean(inventory.upstreamMaster),
    dirtyFiles: sourceBefore.dirtyFiles,
    durationMs: result.durationMs,
    failure: result.failure?.message ?? null,
  }));
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  const discovered = discoverFullCorpusRepositories(root);
  const repositories = options.limit ? discovered.slice(0, options.limit) : discovered;
  if (repositories.length === 0) throw new Error(`BRANCH_MATRIX_NO_REPOSITORIES:${root}`);
  const partialPath = `${options.report}.partial.json`;
  if (existsSync(options.report)) throw new Error(`BRANCH_MATRIX_REPORT_EXISTS:${options.report}`);
  let previous = null;
  if (options.resume && existsSync(partialPath)) {
    previous = JSON.parse(readFileSync(partialPath, "utf8"));
    if (previous.root !== root) throw new Error("BRANCH_MATRIX_RESUME_ROOT_MISMATCH");
    if (previous.runnerHash !== RUNNER_HASH) previous = null;
  } else if (!options.resume && existsSync(partialPath)) {
    throw new Error(`BRANCH_MATRIX_PARTIAL_EXISTS:${partialPath}; rerun with --resume or choose a new report path`);
  }
  const startedAt = previous?.startedAt ?? new Date().toISOString();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "penguin-real-branch-matrix-"));
  const results = [];
  const previousByRoot = new Map((previous?.repositories ?? []).map((item) => [item.sourceRoot, item]));
  console.log(JSON.stringify({ event: "matrix-start", root, repositories: repositories.length, report: options.report }));
  try {
    for (let index = 0; index < repositories.length; index += 1) {
      const sourceRoot = repositories[index];
      const prior = previousByRoot.get(sourceRoot);
      if (options.resume && resumableResult(prior, sourceRoot)) {
        const resumed = { ...prior, index: index + 1, total: repositories.length, resumed: true };
        results.push(resumed);
        console.log(JSON.stringify({ event: "repo-resumed", index: index + 1, total: repositories.length, repo: basename(sourceRoot) }));
        continue;
      }
      const freeBefore = availableBytes(workspaceRoot);
      if (freeBefore < MINIMUM_FREE_BYTES) {
        throw new Error(`BRANCH_MATRIX_INSUFFICIENT_SPACE:available=${freeBefore}:required=${MINIMUM_FREE_BYTES}`);
      }
      console.log(JSON.stringify({ event: "repo-start", index: index + 1, total: repositories.length, repo: basename(sourceRoot) }));
      const repositoryWorkspace = mkdtempSync(join(workspaceRoot, `${String(index + 1).padStart(2, "0")}-${basename(sourceRoot)}-`));
      const dbPath = join(repositoryWorkspace, "knowledge.db");
      const ledgerPath = join(repositoryWorkspace, "ledger.jsonl");
      const store = KnowledgeStore.open({ dbPath, ledgerPath });
      let result;
      try {
        result = await runRepository({
          sourceRoot,
          index: index + 1,
          total: repositories.length,
          workspaceRoot: repositoryWorkspace,
          store,
          keepWorkspace: true,
        });
        result.temporaryDatabaseBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
        result.temporaryWalBytes = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
        result.freeBytesBefore = freeBefore;
      } finally {
        store.close();
        if (!options.keep) rmSync(repositoryWorkspace, { recursive: true, force: true });
      }
      results.push(result);
      const sourceUnchangedSoFar = results.every((item) => item.sourceUnchanged === true);
      atomicWriteJson(partialPath, {
        schemaVersion: 2,
        status: "running",
        kind: "penguin-real-branch-matrix",
        runnerHash: RUNNER_HASH,
        startedAt,
        updatedAt: new Date().toISOString(),
        root,
        repositoryCount: repositories.length,
        discoveredRepositoryCount: discovered.length,
        passed: results.filter((item) => item.passed).length,
        failed: results.filter((item) => !item.passed).length,
        sourceUnchanged: sourceUnchangedSoFar,
        repositories: results,
      });
    }
  } finally { /* per-repository stores are closed before cleanup */ }
  const sourceUnchanged = results.every((item) => item.sourceUnchanged !== false && JSON.stringify(item.sourceAfter) === JSON.stringify(item.sourceBefore));
  const report = {
    schemaVersion: 2,
    status: "completed",
    kind: "penguin-real-branch-matrix",
    runnerHash: RUNNER_HASH,
    startedAt,
    completedAt: new Date().toISOString(),
    root,
    repositoryCount: repositories.length,
    discoveredRepositoryCount: discovered.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    sourceUnchanged,
    disposableWorkspace: options.keep ? workspaceRoot : null,
    contract: {
      sourceCheckoutsUntouched: true,
      featureScenario: "checkout -b matrix/feature-from-upstream upstream/master when available, add marker, query before index, then index and query",
      diffScenario: "checkout -b matrix/diff-from-base from the base commit, add a different marker, query before rebuild, then rebuild and query",
      negativeCase: "repositories without upstream/master use an explicit documented fallback base and are not falsely reported as upstream-derived",
      failClosedBeforePublication: true,
      branchIsolation: true,
    },
    repositories: results,
  };
  writeFinalJson(options.report, report);
  rmSync(partialPath, { force: true });
  console.log(JSON.stringify({ event: "matrix-complete", report: options.report, passed: report.passed, failed: report.failed, sourceUnchanged }));
  if (!options.keep) rmSync(workspaceRoot, { recursive: true, force: true });
  if (report.failed > 0 || !sourceUnchanged) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "matrix-failed", error: String(error?.message ?? error), stack: error?.stack ?? null }));
  process.exitCode = 1;
});
