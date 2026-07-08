import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

// With --progress-events, index/rebuild routes progress to deps.progressEvent
// (structured) instead of the stderr bar — the Rust bridge turns each into a
// knowledge-index-progress Tauri event. stdout stays the --json report.
test("index --progress-events emits structured phase/done/total to progressEvent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-prog-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "function outer(){ return inner(); }\nfunction inner(){}");
  writeFileSync(join(dir, "src", "b.ts"), "export function helper(){ return 1; }");

  const events = [];
  const barChunks = [];
  const deps = {
    cwd: dir,
    out: () => {},
    err: () => {},
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
    progress: (chunk) => barChunks.push(chunk), // human bar sink
    progressEvent: (p) => events.push(p),
  };

  assert.equal(await runCli(["index", "--json", "--progress-events"], deps), 0);

  // structured events flowed; the human bar did NOT (mutually exclusive)
  assert.ok(events.length > 0, "progressEvent received structured updates");
  assert.equal(barChunks.length, 0, "no human bar frames under --progress-events");
  assert.ok(events.some((e) => e.phase === "scan"), "scan phase reported");
  assert.ok(events.some((e) => e.phase === "index" && typeof e.done === "number" && typeof e.total === "number"), "index phase with done/total");
});

test("without --progress-events, no structured events (bar path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-prog2-"));
  const dbPath = join(dir, "knowledge.db");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "function f(){}");

  const events = [];
  const deps = {
    cwd: dir,
    out: () => {},
    err: () => {},
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath: join(dir, "l.jsonl") }),
    progressEvent: (p) => events.push(p),
  };
  // --json (no progress-events) → structured sink untouched
  assert.equal(await runCli(["index", "--json"], deps), 0);
  assert.equal(events.length, 0);
});
