// tests/knowledge-cli-multirepo.test.mjs
// `penguin init` aimed at a NON-git parent folder full of checkouts
// (~/Desktop/Projects) must not silently index the whole tree as one repo —
// it offers a picker (TTY) or refuses with the candidate list (non-TTY).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { discoverSubRepos, isGitRepo } from "../packages/knowledge-cli/dist/multi-repo.js";

function parentWithRepos() {
  const parent = mkdtempSync(join(tmpdir(), "pk-multi-"));
  for (const name of ["alpha", "beta"]) {
    const repo = join(parent, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, `${name}.ts`), `export function ${name}Fn() { return 1; }\n`);
    execSync("git init -q", { cwd: repo });
  }
  mkdirSync(join(parent, "not-a-repo"));
  return parent;
}

function makeDeps(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pk-multi-db-"));
  const outs = [];
  const errs = [];
  return {
    outs, errs,
    deps: {
      cwd: dir,
      out: (l) => outs.push(l),
      err: (l) => errs.push(l),
      openStore: () => KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }),
      storeExists: () => true,
      ...overrides,
    },
  };
}

test("discoverSubRepos lists one-level git checkouts only; isGitRepo detects .git", () => {
  const parent = parentWithRepos();
  assert.equal(isGitRepo(parent), false);
  assert.equal(isGitRepo(join(parent, "alpha")), true);
  const subs = discoverSubRepos(parent);
  assert.deepEqual(subs.map((s) => s.name), ["alpha", "beta"]);
  assert.ok(subs[0].path.endsWith("/alpha"));
});

test("init on a multi-repo parent consults the picker and indexes only the selection", async () => {
  const parent = parentWithRepos();
  let offered = null;
  const { deps } = makeDeps({
    pickRepos: async (candidates) => {
      offered = candidates.map((c) => c.name);
      return [candidates[1].path]; // pick beta only
    },
  });
  const code = await runCli(["init", parent], deps);
  assert.equal(code, 0);
  assert.deepEqual(offered, ["alpha", "beta"], "picker saw both repos");
  const store = deps.openStore();
  const names = store.db.prepare("SELECT name FROM repos ORDER BY name").all().map((r) => r.name);
  store.close();
  assert.deepEqual(names, ["beta"], "only the picked repo was indexed");
});

test("init on a multi-repo parent without a picker refuses with the candidate list", async () => {
  const parent = parentWithRepos();
  const { deps, errs } = makeDeps();
  const code = await runCli(["init", parent], deps);
  assert.equal(code, 2);
  assert.ok(errs.some((l) => l.includes("alpha")) && errs.some((l) => l.includes("beta")), `candidates listed: ${errs}`);
});

test("init directly on a git repo never consults the picker", async () => {
  const parent = parentWithRepos();
  let consulted = false;
  const { deps } = makeDeps({ pickRepos: async () => { consulted = true; return null; } });
  const code = await runCli(["init", join(parent, "alpha")], deps);
  assert.equal(code, 0);
  assert.equal(consulted, false);
});

test("picker cancel (null) aborts cleanly without indexing", async () => {
  const parent = parentWithRepos();
  const { deps } = makeDeps({ pickRepos: async () => null });
  const code = await runCli(["init", parent], deps);
  assert.equal(code, 0);
  const store = deps.openStore();
  const n = store.db.prepare("SELECT COUNT(*) c FROM repos").get().c;
  store.close();
  assert.equal(n, 0);
});
