import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  affectedByFiles,
  buildContextPack,
  buildFlow,
  openRevisionView,
  searchKnowledge,
} from "../packages/knowledge-core/dist/index.js";
import {
  KNOWLEDGE_PARSER_VERSION,
  KNOWLEDGE_RESOLVER_VERSION,
  indexRepo,
  prepareWorkingTreeOverlay,
} from "../packages/knowledge-indexer/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "penguin-working-tree-overlay-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "export function main() { return 'base'; }\n");
  writeFileSync(join(root, "src", "removed.ts"), "export const removed = true;\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "penguin@test"]);
  git(root, ["config", "user.name", "Penguin Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const dbDir = mkdtempSync(join(tmpdir(), "penguin-working-tree-db-"));
  const store = KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") });
  return { root, dbDir, store };
}

test("working-tree overlay is isolated, incremental, queryable, and idempotent", async () => {
  const { root, dbDir, store } = fixture();
  try {
    const indexed = await indexRepo({ store, rootPath: root, mode: "rebuild", semantic: { enabled: false } });
    const branchBefore = store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id;

    writeFileSync(join(root, "src", "main.ts"), "export function main() { return 'overlay-marker'; }\n");
    writeFileSync(join(root, "src", "new.ts"), "export const worktreeOnly = 'overlay-only-marker';\n");
    unlinkSync(join(root, "src", "removed.ts"));

    const overlay = await prepareWorkingTreeOverlay({
      store,
      rootPath: root,
      repoId: indexed.repoId,
      parserVersion: KNOWLEDGE_PARSER_VERSION,
      resolverVersion: KNOWLEDGE_RESOLVER_VERSION,
    });

    assert.equal(overlay.context.trust, "exact_worktree");
    assert.equal(overlay.status.applied, true);
    assert.deepEqual(overlay.status.modifiedPaths, ["src/main.ts"]);
    assert.deepEqual(overlay.status.addedPaths, ["src/new.ts"]);
    assert.deepEqual(overlay.status.deletedPaths, ["src/removed.ts"]);
    assert.notEqual(overlay.context.snapshotId, branchBefore);
    assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id, branchBefore);

    const view = openRevisionView(store, overlay.context);
    const paths = view.listFiles().map((row) => row.filePath).sort();
    assert.deepEqual(paths, ["src/main.ts", "src/new.ts"]);
    assert.equal(view.context.worktreeFingerprint, overlay.context.worktreeFingerprint);

    const searchResult = searchKnowledge(
      { query: "overlay-only-marker", mode: "exact", scope: { revisions: [{ repoId: indexed.repoId, snapshotId: overlay.context.snapshotId }] }, page: { limit: 10 } },
      { store, scopes: [{ repoId: indexed.repoId, snapshotId: overlay.context.snapshotId }] },
    );
    assert.equal(searchResult.hits.length, 1, JSON.stringify(searchResult));
    assert.equal(searchResult.hits[0].locator.revisionKind, "working_tree");
    assert.equal(searchResult.diagnostics.resolvedScopes[0].snapshotId, overlay.context.snapshotId);

    const context = buildContextPack(store, "main", { repoId: indexed.repoId, revision: overlay.context });
    assert.ok(!context.assemblyError, JSON.stringify(context));
    const flow = buildFlow(store, "main", { repoId: indexed.repoId, revision: overlay.context, limit: 10 });
    assert.ok(!flow.assemblyError, JSON.stringify(flow));
    const affected = affectedByFiles(store, ["src/main.ts"], { revision: overlay.context, limit: 10 });
    assert.ok(affected.changed.some((row) => row.nodeId?.endsWith("::main")), JSON.stringify(affected));

    const repeat = await prepareWorkingTreeOverlay({
      store,
      rootPath: root,
      repoId: indexed.repoId,
      parserVersion: KNOWLEDGE_PARSER_VERSION,
      resolverVersion: KNOWLEDGE_RESOLVER_VERSION,
    });
    assert.equal(repeat.context.snapshotId, overlay.context.snapshotId);

    writeFileSync(join(root, "src", "main.ts"), "export function main() { return 'overlay-marker-v2'; }\n");
    const changedAgain = await prepareWorkingTreeOverlay({
      store,
      rootPath: root,
      repoId: indexed.repoId,
      parserVersion: KNOWLEDGE_PARSER_VERSION,
      resolverVersion: KNOWLEDGE_RESOLVER_VERSION,
    });
    assert.notEqual(changedAgain.context.snapshotId, overlay.context.snapshotId);
    assert.equal(store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id, branchBefore);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test("CLI --working-tree search returns modified checkout content without moving the branch", async () => {
  const { root, dbDir, store } = fixture();
  const dbPath = join(dbDir, "knowledge.db");
  const ledgerPath = join(dbDir, "ledger.jsonl");
  let storeClosed = false;
  try {
    const indexed = await indexRepo({ store, rootPath: root, mode: "rebuild", semantic: { enabled: false } });
    const branchBefore = store.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id;
    store.close();
    storeClosed = true;

    writeFileSync(join(root, "src", "main.ts"), "export function main() { return 'cli-overlay-only'; }\n");
    const lines = [];
    const code = await runCli(["search", "cli-overlay-only", "--working-tree", "--json"], {
      cwd: root,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      storeExists: () => true,
      openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
    });
    assert.equal(code, 0, lines.join("\n"));
    const payload = JSON.parse(lines.at(-1));
    assert.equal(payload.workingTree.applied, true, JSON.stringify(payload));
    assert.equal(payload.diagnostics.resolvedScopes[0].revisionKind, "working_tree", JSON.stringify(payload));
    assert.ok(payload.hits.some((hit) => hit.snippet?.includes("cli-overlay-only")), JSON.stringify(payload));

    const verifyStore = KnowledgeStore.open({ dbPath, ledgerPath });
    assert.equal(verifyStore.db.prepare("SELECT current_snapshot_id FROM branches WHERE id=?").get(indexed.branchId).current_snapshot_id, branchBefore);
    verifyStore.close();
  } finally {
    if (!storeClosed) store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
