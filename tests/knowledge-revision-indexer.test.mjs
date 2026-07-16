import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { RevisionIndexCoordinator, indexRevision } from "../packages/knowledge-indexer/dist/index.js";

function git(root, args) { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); }

test("revision indexer publishes clean tree snapshots, facts, and resolution edges, and coalesces same-revision jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-revision-indexer-")); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "main.ts"), "export function helper() { return 1; }\nexport function main() { return helper(); }\n");
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "penguin@test"]); git(root, ["config", "user.name", "Penguin Test"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "initial"]);
  const dir = mkdtempSync(join(tmpdir(), "penguin-revision-db-")); const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); const repoId = store.registerRepo({ name: "fixture", rootPath: root }); const branchId = store.registerBranch({ repoId, name: "main", status: "snapshot" }); const coordinator = new RevisionIndexCoordinator();
  const input = { store, rootPath: root, repoId, revision: { commitSha: "HEAD" }, publishBranchId: branchId, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator };
  const [a, b] = await Promise.all([indexRevision(input), indexRevision(input)]); assert.equal(a.context.snapshotId, b.context.snapshotId); assert.equal(a.context.trust, "exact_commit"); assert.ok(a.totalFiles >= 1); assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM file_fact_symbols").get().n >= 2); assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM resolved_edges").get().n >= 1); assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM snapshot_resolution_refs WHERE snapshot_id=?").get(a.context.snapshotId).n >= 1); assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(branchId).current_snapshot_id, a.context.snapshotId); assert.equal(store.db.prepare("SELECT state FROM revision_snapshots WHERE id=?").get(a.context.snapshotId).state, "ready"); store.close();
});

test("dirty worktree materialization gets a distinct exact_worktree snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-revision-dirty-")); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n"); git(root, ["init", "-q"]); git(root, ["config", "user.email", "penguin@test"]); git(root, ["config", "user.name", "Penguin Test"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "initial"]);
  const dir = mkdtempSync(join(tmpdir(), "penguin-dirty-db-")); const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); const repoId = store.registerRepo({ name: "dirty", rootPath: root }); const branchId = store.registerBranch({ repoId, name: "main", status: "snapshot" }); const coordinator = new RevisionIndexCoordinator();
  const clean = await indexRevision({ store, rootPath: root, repoId, revision: { commitSha: "HEAD" }, publishBranchId: branchId, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator });
  writeFileSync(join(root, "src", "main.ts"), "export const value = 2;\n");
  const dirty = await indexRevision({ store, rootPath: root, repoId, revision: { useWorktree: true }, publishBranchId: branchId, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator });
  assert.equal(dirty.context.trust, "exact_worktree"); assert.notEqual(dirty.context.snapshotId, clean.context.snapshotId); assert.equal(store.db.prepare("SELECT state FROM revision_snapshots WHERE id=?").get(dirty.context.snapshotId).state, "ready"); store.close();
});

test("revision indexer uses immutable base plus changed/deleted overlays and keeps inherited files", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-revision-cow-")); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "shared.ts"), "export const shared = 1;\n"); writeFileSync(join(root, "src", "removed.ts"), "export const removed = 1;\n");
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "penguin@test"]); git(root, ["config", "user.name", "Penguin Test"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "base"]); git(root, ["branch", "feature"]); git(root, ["checkout", "-q", "feature"]);
  execFileSync("git", ["-C", root, "rm", "-q", "src/removed.ts"]); writeFileSync(join(root, "src", "feature.ts"), "export const feature = 1;\n"); git(root, ["add", "-A"]); git(root, ["commit", "-qm", "feature"]);
  const dir = mkdtempSync(join(tmpdir(), "penguin-revision-cow-db-")); const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); const repoId = store.registerRepo({ name: "cow", rootPath: root }); const main = store.registerBranch({ repoId, name: "main", status: "snapshot" }); const feature = store.registerBranch({ repoId, name: "feature", status: "snapshot" }); const coordinator = new RevisionIndexCoordinator();
  const base = await indexRevision({ store, rootPath: root, repoId, revision: { commitSha: "HEAD~1" }, publishBranchId: main, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator });
  store.db.prepare("UPDATE branches SET current_snapshot_id=? WHERE id=?").run(base.context.snapshotId, feature);
  const child = await indexRevision({ store, rootPath: root, repoId, revision: { branch: "feature" }, publishBranchId: feature, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator });
  const overlays = store.db.prepare("SELECT file_path,operation FROM snapshot_overlays WHERE snapshot_id=? ORDER BY file_path").all(child.context.snapshotId);
  assert.deepEqual(overlays, [{ file_path: "src/feature.ts", operation: "add" }, { file_path: "src/removed.ts", operation: "delete" }]);
  assert.equal(store.db.prepare("SELECT file_fact_id FROM effective_snapshot_files WHERE snapshot_id=? AND file_path='src/shared.ts'").get(child.context.snapshotId).file_fact_id, store.db.prepare("SELECT file_fact_id FROM effective_snapshot_files WHERE snapshot_id=? AND file_path='src/shared.ts'").get(base.context.snapshotId).file_fact_id);
  assert.equal(store.db.prepare("SELECT 1 FROM effective_snapshot_files WHERE snapshot_id=? AND file_path='src/removed.ts'").get(child.context.snapshotId), undefined);
  store.close();
});

test("revision indexer uses the configured master branch snapshot as the default COW base", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-revision-master-base-")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "shared.ts"), "export const shared = 1;\n");
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "penguin@test"]); git(root, ["config", "user.name", "Penguin Test"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "base"]); git(root, ["branch", "feature"]); git(root, ["checkout", "-q", "feature"]);
  writeFileSync(join(root, "src", "feature.ts"), "export const feature = 1;\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "feature"]);
  const dir = mkdtempSync(join(tmpdir(), "penguin-revision-master-base-db-")); const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); const repoId = store.registerRepo({ name: "master-base", rootPath: root }); const main = store.registerBranch({ repoId, name: "main", status: "snapshot" }); const feature = store.registerBranch({ repoId, name: "feature", status: "snapshot" }); store.setDefaultBranch(repoId, main); const coordinator = new RevisionIndexCoordinator();
  const base = await indexRevision({ store, rootPath: root, repoId, revision: { commitSha: "HEAD~1" }, publishBranchId: main, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator });
  const child = await indexRevision({ store, rootPath: root, repoId, revision: { branch: "feature" }, publishBranchId: feature, parserVersion: "parser-v1", resolverVersion: "resolver-v1", coordinator });
  const snapshot = store.db.prepare("SELECT base_snapshot_id FROM revision_snapshots WHERE id=?").get(child.context.snapshotId);
  assert.equal(snapshot.base_snapshot_id, base.context.snapshotId);
  assert.ok(child.reusePercent > 0, "unchanged master files should be reused");
  store.close();
});
