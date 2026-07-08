import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

test("suggestion flow via CLI: link/suggestions/accept + doctor + snapshots", async () => {
  const { dir, deps, lines } = harness();
  // seed two nodes + a suggested edge directly, then drive accept via CLI
  const store = deps.openStore();
  const a = store.upsertNode({ nodeType: "note", identityKey: "a.md", title: "A" });
  const b = store.upsertNode({ nodeType: "note", identityKey: "b.md", title: "B" });
  const ev = store.suggestEdge({ src: a, dst: b, edgeType: "wikilink" });
  store.createSnapshot({ name: "snap1", nodeIds: [a, b] });
  store.close();

  lines.length = 0;
  assert.equal(await runCli(["suggestions", "--json"], deps), 0);
  const q = JSON.parse(lines[0]);
  assert.equal(q.length, 1);
  assert.equal(q[0].suggestionEventId, ev.id);

  assert.equal(await runCli(["accept", ev.id], deps), 0);
  lines.length = 0;
  assert.equal(await runCli(["suggestions", "--json"], deps), 0);
  assert.equal(JSON.parse(lines[0]).length, 0, "accepted → queue empty");

  lines.length = 0;
  assert.equal(await runCli(["snapshots", "--json"], deps), 0);
  assert.equal(JSON.parse(lines[0])[0].name, "snap1");

  lines.length = 0;
  assert.equal(await runCli(["doctor", "--json"], deps), 0);
  const doc = JSON.parse(lines[0]);
  assert.equal(doc.status, "ok");
  assert.ok(doc.nodes >= 2);

  // accept/reject without id → usage error (exit 2)
  assert.equal(await runCli(["accept"], deps), 2);
});

test("install prints guidance when no installSelf provided", async () => {
  const { deps, lines } = harness();
  assert.equal(await runCli(["install"], deps), 0);
  assert.match(lines.join("\n"), /ln -sf|symlink/i);
});

test("help + unknown command exit codes", async () => {
  const { deps, lines, errs } = harness();
  assert.equal(await runCli(["help"], deps), 0);
  assert.match(lines.join("\n"), /penguin init/);
  assert.equal(await runCli(["frobnicate"], deps), 2);
  assert.match(errs.join("\n"), /unknown command/);
});

test("bin.ts sets process.exitCode (never process.exit) so piped --json can't truncate", async () => {
  // Regression: process.exit() drops un-flushed async pipe writes → the app
  // read truncated JSON ("Unterminated string"). exitCode lets Node drain first.
  const raw = await readFile(new URL("../packages/knowledge-cli/src/bin.ts", import.meta.url), "utf8");
  const code = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // drop comments
  assert.match(code, /process\.exitCode\s*=/);
  assert.doesNotMatch(code, /process\.exit\(/, "must not call process.exit() — it truncates piped stdout");
});
