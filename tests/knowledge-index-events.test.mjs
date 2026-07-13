// tests/knowledge-index-events.test.mjs
// Typed index event stream (stage / metric / discovery) emitted by indexRepo
// alongside the legacy per-file scan/index events. UIs (CLI live renderer,
// Tauri Wiki panel) narrate indexing from these instead of a bare % bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-ev-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "pk-ev-src-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "login.controller.ts"),
    `@Controller('auth')
export class LoginController {
  @Get('me')
  me() { return whoami(); }
}
export function whoami() { return 1; }
`,
  );
  writeFileSync(join(repo, "src", "util.js"), `function add(a, b) { return a + b; }\nmodule.exports = { add };\n`);
  return repo;
}

test("indexRepo emits typed stage/metric/discovery events alongside legacy progress", async () => {
  const store = openStore();
  const events = [];
  await indexRepo({
    store, rootPath: fixtureRepo(), mode: "incremental",
    onProgress: (e) => events.push(e),
  });

  // Legacy events unchanged (existing CLI bar + Tauri bar keep working).
  assert.ok(events.some((e) => e.phase === "scan" && typeof e.total === "number"), "legacy scan event");
  assert.ok(
    events.some((e) => e.phase === "index" && e.file.endsWith("login.controller.ts")),
    "legacy per-file index event",
  );

  // Language breakdown: scan carries per-language totals, index events carry
  // the file's language — the CLI renders one bar per language from these.
  const scan = events.find((e) => e.phase === "scan");
  assert.ok(scan.langs && scan.langs.ts >= 1 && scan.langs.js >= 1, `scan.langs has ts+js (got ${JSON.stringify(scan.langs)})`);
  assert.ok(
    events.some((e) => e.phase === "index" && e.lang === "ts" && e.file.endsWith(".ts")),
    "index events tagged with lang",
  );

  // Stage lifecycle: parse starts before it finishes; the pipeline's stages all complete.
  const stages = events.filter((e) => e.phase === "stage");
  const parseStart = stages.findIndex((e) => e.stage === "parse" && e.state === "start");
  const parseDone = stages.findIndex((e) => e.stage === "parse" && e.state === "done");
  assert.ok(parseStart !== -1 && parseDone > parseStart, "parse stage start→done in order");
  for (const id of ["scan", "parse", "deletes", "proto", "link", "packages", "git"]) {
    assert.ok(stages.some((e) => e.stage === id && e.state === "done"), `stage ${id} completes`);
  }

  // Metric snapshots carry live counts; the final one reflects the fixture.
  const metric = events.filter((e) => e.phase === "metric").at(-1);
  assert.ok(metric, "at least one metric event");
  assert.ok(metric.symbols >= 1 && metric.edges >= 1, `final metric has counts (got ${JSON.stringify(metric)})`);

  // The @Get controller surfaces as an endpoint discovery.
  assert.ok(
    events.some((e) => e.phase === "discovery" && e.kind === "endpoint" && /GET \/auth\/me/.test(e.title)),
    "endpoint discovery emitted",
  );
  store.close();
});

test("unchanged incremental re-run emits no endpoint discoveries (nothing reprocessed)", async () => {
  const store = openStore();
  const repo = fixtureRepo();
  await indexRepo({ store, rootPath: repo, mode: "incremental" });
  const events = [];
  await indexRepo({ store, rootPath: repo, mode: "incremental", onProgress: (e) => events.push(e) });
  assert.ok(!events.some((e) => e.phase === "discovery" && e.kind === "endpoint"), "no re-discoveries");
  assert.ok(events.filter((e) => e.phase === "stage").some((e) => e.stage === "parse" && e.state === "done"));
  store.close();
});
