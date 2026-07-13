// tests/knowledge-cli-watch.test.mjs
// `penguin watch <path>` — the missing wire-up for startWatcher(): the app's
// "自动同步" toggle spawns this as a long-running child process
// (--progress-events) instead of the one-shot index/rebuild verbs, so the
// user doesn't have to manually re-index after every change.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pk-cliwatch-"));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export function fn0(){ return 0; }");
  return dir;
}

test("watch refuses without an existing knowledge database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-cliwatch-nodb-"));
  const errs = [];
  const deps = {
    cwd: dir, out: () => {}, err: (l) => errs.push(l),
    storeExists: () => false,
    openStore: () => { throw new Error("must not open a store"); },
  };
  assert.equal(await runCli(["watch", dir], deps), 3);
  assert.match(errs.join("\n"), /penguin init/);
});

test("watch --progress-events: emits watch-started, then watch-run on a file change, stops cleanly on SIGTERM", async () => {
  const dir = tempRepo();
  // DB/ledger MUST live outside the watched root — chokidar watching the repo
  // would otherwise see the indexer's own DB writes as more file changes and
  // keep resetting the debounce timer, so the run never settles.
  const dbDir = mkdtempSync(join(tmpdir(), "pk-cliwatch-db-"));
  const dbPath = join(dbDir, "knowledge.db");
  const ledgerPath = join(dbDir, "ledger.jsonl");
  const events = [];
  const deps = {
    cwd: dir, out: () => {}, err: () => {},
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
    progressEvent: (p) => events.push(p),
  };
  // watch (like context/flow/search) refuses without an existing DB — index
  // once first so storeExists() is true when the watch verb checks it.
  assert.equal(await runCli(["index", dir], deps), 0);

  const run = runCli(["watch", dir, "--progress-events"], deps);
  // A failed assertion below must not leave the watcher (chokidar + open DB)
  // running forever — that hangs the WHOLE node --test process (nothing left
  // to empty the event loop). Always stop it before this test returns.
  try {
    // wait for the watcher to actually be ready before writing (matches the
    // startWatcher unit test's own "wait for chokidar ready" pattern).
    for (let i = 0; i < 80 && !events.some((e) => e.phase === "watch-started"); i++) await delay(25);
    assert.ok(events.some((e) => e.phase === "watch-started"), "watch-started emitted");

    writeFileSync(join(dir, "src", "a.ts"), "export function fn1(){ return 1; }");

    for (let i = 0; i < 160 && !events.some((e) => e.phase === "watch-run"); i++) await delay(25);
    const runEvent = events.find((e) => e.phase === "watch-run");
    assert.ok(runEvent, "watch-run emitted after a file change");
    assert.equal(runEvent.report.parsed, 1, "the changed file was (re)parsed");
  } finally {
    process.emit("SIGTERM");
    await run;
  }
});
