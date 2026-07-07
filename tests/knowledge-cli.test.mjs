import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pk-cli-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const lines = [];
  const errs = [];
  const deps = {
    cwd: dir,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
  };
  return { dir, deps, lines, errs };
}

test("read verb without a DB refuses (exit 3) and does not create one", async () => {
  const { deps, errs } = harness();
  const code = await runCli(["search", "foo"], deps);
  assert.equal(code, 3);
  assert.match(errs.join("\n"), /penguin init/);
  assert.equal(deps.storeExists(), false);
});

test("init indexes a repo, then status + search + callers work", async () => {
  const { dir, deps, lines } = harness();
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "function outer(){ return inner(); }\nfunction inner(){}");

  assert.equal(await runCli(["init"], deps), 0);
  assert.equal(deps.storeExists(), true);

  lines.length = 0;
  assert.equal(await runCli(["status", "--json"], deps), 0);
  const status = JSON.parse(lines[0]);
  assert.ok(status.repos.some((r) => r.branches.some((b) => b.name === "main")));

  lines.length = 0;
  assert.equal(await runCli(["search", "inner", "--json"], deps), 0);
  const hits = JSON.parse(lines[0]);
  assert.ok(hits.some((h) => h.title === "inner"));

  lines.length = 0;
  assert.equal(await runCli(["callers", "inner", "--json"], deps), 0);
  const callers = JSON.parse(lines[0]);
  assert.ok(callers.nodes.some((n) => n.title === "outer"), "outer calls inner");
});

test("help + unknown command exit codes", async () => {
  const { deps, lines, errs } = harness();
  assert.equal(await runCli(["help"], deps), 0);
  assert.match(lines.join("\n"), /penguin init/);
  assert.equal(await runCli(["frobnicate"], deps), 2);
  assert.match(errs.join("\n"), /unknown command/);
});
