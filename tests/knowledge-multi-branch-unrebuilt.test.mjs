import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin Multi-Branch Test",
  GIT_AUTHOR_EMAIL: "penguin-multi-branch@example.invalid",
  GIT_COMMITTER_NAME: "Penguin Multi-Branch Test",
  GIT_COMMITTER_EMAIL: "penguin-multi-branch@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  }).trim();
}

function branches(root) {
  return git(root, "for-each-ref", "refs/heads", "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean)
    .sort();
}

function createRepo(parent, name) {
  const root = join(parent, name);
  const upstream = join(parent, `${name}-upstream.git`);
  const safeName = name.replace(/[^a-zA-Z0-9]/g, "_");
  const baseSymbol = `${safeName}Base`;
  const featureSymbol = `${safeName}FromUpstream`;
  const diffSymbol = `${safeName}DiffBranch`;
  const featureBranch = "feature/from-upstream";
  const diffBranch = "diff/from-master";

  mkdirSync(root);
  git(root, "init", "-q", "-b", "master");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "base.ts"), `export function ${baseSymbol}(): string { return "${name}"; }\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");

  // Use an actual local upstream remote so the test exercises the same
  // `checkout -b <branch> upstream/master` shape used by developers.
  execFileSync("git", ["clone", "--bare", "-q", root, upstream], { env: GIT_ENV });
  git(root, "remote", "add", "upstream", upstream);
  git(root, "fetch", "-q", "upstream", "master");
  git(root, "checkout", "-q", "-b", featureBranch, "upstream/master");
  writeFileSync(join(root, "src", "from-upstream.ts"), `export function ${featureSymbol}(): string { return "upstream"; }\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "feature from upstream master");

  git(root, "checkout", "-q", "master");
  git(root, "checkout", "-q", "-b", diffBranch);
  writeFileSync(join(root, "src", "diff.ts"), `export function ${diffSymbol}(): string { return "divergent"; }\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "divergent branch");
  git(root, "checkout", "-q", "master");

  return {
    root,
    name,
    featureBranch,
    diffBranch,
    baseSymbol,
    featureSymbol,
    diffSymbol,
  };
}

function toolContext(store, repo, target, extra = {}) {
  return handleKnowledgeTool(
    "knowledge_context",
    { repo: repo.repoId ?? repo.name, target, ...extra },
    store,
  );
}

test("every repository keeps multiple Git branches isolated before index/rebuild", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-multi-branch-unrebuilt-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  const repositories = [createRepo(projects, "alpha"), createRepo(projects, "beta")];
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });

  try {
    for (const repo of repositories) {
      assert.deepEqual(branches(repo.root), ["diff/from-master", "feature/from-upstream", "master"]);

      const masterReport = await indexRepo({
        store,
        rootPath: repo.root,
        mode: "incremental",
        semantic: { enabled: false },
      });
      const repoId = masterReport.repoId;
      repo.repoId = repoId;
      assert.equal(masterReport.branchName, "master");
      assert.equal(store.getBranch(repoId, repo.featureBranch), null, "feature is not indexed yet");
      assert.equal(store.getBranch(repoId, repo.diffBranch), null, "diff branch is not indexed yet");

      git(repo.root, "checkout", "-q", "-b", "tmp-check-feature", "upstream/master");
      git(repo.root, "checkout", "-q", repo.featureBranch);
      const featureBeforeIndex = toolContext(store, repo, repo.featureSymbol);
      assert.equal(featureBeforeIndex.error?.code, "BRANCH_NOT_INDEXED", JSON.stringify(featureBeforeIndex));
      assert.match(JSON.stringify(featureBeforeIndex), /knowledge_index/);
      const featureFallback = toolContext(store, repo, repo.baseSymbol, { allow_fallback: true });
      assert.equal(featureFallback.alignment, "fallback", JSON.stringify(featureFallback));
      assert.equal(featureFallback.locator?.branchName, "master", JSON.stringify(featureFallback));

      const featureReport = await indexRepo({
        store,
        rootPath: repo.root,
        mode: "incremental",
        semantic: { enabled: false },
      });
      assert.equal(featureReport.branchName, repo.featureBranch);
      assert.equal(store.getBranch(repoId, "master").status, "snapshot");
      assert.equal(store.getBranch(repoId, repo.featureBranch).status, "live");
      assert.equal(toolContext(store, repo, repo.featureSymbol).error, undefined);

      git(repo.root, "checkout", "-q", "master");
      git(repo.root, "checkout", "-q", repo.diffBranch);
      const diffBeforeRebuild = toolContext(store, repo, repo.diffSymbol);
      assert.equal(diffBeforeRebuild.error?.code, "BRANCH_NOT_INDEXED", JSON.stringify(diffBeforeRebuild));
      const featureLeakCheck = toolContext(store, repo, repo.featureSymbol);
      assert.equal(featureLeakCheck.error?.code, "BRANCH_NOT_INDEXED", JSON.stringify(featureLeakCheck));
      assert.equal(store.getBranch(repoId, repo.diffBranch), null, "divergent branch remains unindexed before rebuild");

      const diffReport = await indexRepo({
        store,
        rootPath: repo.root,
        mode: "rebuild",
        semantic: { enabled: false },
      });
      assert.equal(diffReport.branchName, repo.diffBranch);
      assert.equal(store.getBranch(repoId, repo.diffBranch).status, "live");
      assert.equal(toolContext(store, repo, repo.diffSymbol).error, undefined);
      const noFeatureOnDiff = toolContext(store, repo, repo.featureSymbol);
      assert.notEqual(noFeatureOnDiff.error?.code, undefined, JSON.stringify(noFeatureOnDiff));
      assert.doesNotMatch(JSON.stringify(noFeatureOnDiff), new RegExp(repo.featureBranch));
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
