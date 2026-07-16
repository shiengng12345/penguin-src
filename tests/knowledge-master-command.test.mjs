import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-master-command-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git", "refs", "heads", "feature"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
  writeFileSync(join(repo, ".git", "refs", "heads", "feature", "x"), "abc\n");
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "demo", rootPath: repo });
  const mainId = store.registerBranch({ repoId, name: "main", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature/x", status: "snapshot" });
  store.close();
  const output = [];
  const errors = [];
  return {
    dir,
    output,
    errors,
    repoId,
    mainId,
    featureId,
    deps: {
      cwd: repo,
      out: (line) => output.push(line),
      err: (line) => errors.push(line),
      openStore: () => KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }),
      storeExists: () => true,
    },
  };
}

test("penguin master explicitly selects the canonical base branch", async () => {
  const f = fixture();
  assert.equal(await runCli(["master", "demo", "feature/x"], f.deps), 0);
  const store = f.deps.openStore();
  assert.equal(store.db.prepare("SELECT default_branch FROM branches WHERE id=?").get(f.featureId).default_branch, 1);
  assert.equal(store.db.prepare("SELECT default_branch FROM branches WHERE id=?").get(f.mainId).default_branch, 0);
  assert.equal(store.db.prepare("SELECT base_branch_name FROM branches WHERE id=?").get(f.mainId).base_branch_name, "feature/x");
  store.close();
});

test("penguin master without arguments selects the current checkout branch", async () => {
  const f = fixture();
  assert.equal(await runCli(["master"], f.deps), 0);
  const store = f.deps.openStore();
  assert.equal(store.db.prepare("SELECT default_branch FROM branches WHERE name='feature/x'").get().default_branch, 1);
  store.close();
});

test("penguin master replaces an existing master without deleting its index", async () => {
  const f = fixture();
  assert.equal(await runCli(["master", "demo", "main"], f.deps), 0);
  const store = f.deps.openStore();
  assert.equal(store.db.prepare("SELECT default_branch FROM branches WHERE name='main'").get().default_branch, 1);
  assert.equal(store.db.prepare("SELECT default_branch FROM branches WHERE name='feature/x'").get().default_branch, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM branches").get().n, 2);
  store.close();
});
