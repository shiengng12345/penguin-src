import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, FileFactStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

function git(root, args, encoding) {
  return execFileSync("git", ["-C", root, ...args], encoding ? { encoding } : { stdio: "ignore" });
}

function filesAt(root, ref) {
  return git(root, ["ls-tree", "-r", "--name-only", ref], "utf8").trim().split("\n").filter(Boolean).sort();
}

test("canonical master acceptance: five branches keep exact isolated COW manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-canonical-acceptance-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/shared.ts"), "export const shared = 1;\n");
  writeFileSync(join(root, "src/removed.ts"), "export const removed = 1;\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "penguin@test"]); git(root, ["config", "user.name", "Penguin Test"]);
  git(root, ["add", "."]); git(root, ["commit", "-qm", "main"]);
  const branches = ["feature/a", "feature/b", "feature/master-like", "feature/c"];
  for (const branch of branches) { git(root, ["branch", branch]); }
  const commits = new Map();
  const checkoutAndCommit = (branch, edit) => {
    git(root, ["checkout", "-q", branch]);
    edit(); git(root, ["add", "-A"]); git(root, ["commit", "-qm", branch]);
    commits.set(branch, git(root, ["rev-parse", "HEAD"], "utf8").trim());
  };
  checkoutAndCommit("feature/a", () => writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n"));
  checkoutAndCommit("feature/b", () => { rmSync(join(root, "src/removed.ts")); writeFileSync(join(root, "src/shared.ts"), "export const shared = 2;\n"); });
  checkoutAndCommit("feature/master-like", () => { rmSync(join(root, "src/removed.ts")); writeFileSync(join(root, "src/renamed.ts"), "export const removed = 1;\n"); });
  checkoutAndCommit("feature/c", () => writeFileSync(join(root, "src/c.ts"), "export const c = 1;\n"));
  git(root, ["checkout", "-q", "main"]);
  commits.set("main", git(root, ["rev-parse", "HEAD"], "utf8").trim());

  const dir = mkdtempSync(join(tmpdir(), "penguin-canonical-db-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const snapshots = new Map();
  for (const branch of ["main", "feature/b", "feature/a", "feature/master-like", "feature/c"]) {
    git(root, ["checkout", "-q", branch]);
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    snapshots.set(branch, store.getBranch(report.repoId, branch).current_snapshot_id);
  }
  const repoId = store.db.prepare("SELECT id FROM repos LIMIT 1").get().id;
  assert.equal(store.getDefaultBranch(repoId).name, "main");
  const facts = new FileFactStore(store);
  for (const [branch, snapshotId] of snapshots) {
    const actual = [...facts.effectiveManifest(snapshotId).keys()].sort();
    assert.deepEqual(actual, filesAt(root, commits.get(branch)), branch);
  }
  const mainManifest = facts.effectiveManifest(snapshots.get("main"));
  assert.equal(facts.effectiveManifest(snapshots.get("feature/a")).get("src/shared.ts"), mainManifest.get("src/shared.ts"));
  assert.equal(store.getDefaultBranch(repoId).name, "main", "branch name containing master must not become canonical");
  store.close();
});
