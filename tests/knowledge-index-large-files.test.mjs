import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { EXTRACT_MAX_BYTES } from "../packages/knowledge-indexer/dist/extract.js";

// The parse read-ahead window was bounded by file COUNT, which assumes every
// file is small. A repo carrying generated .js data blobs — 58 of them, average
// 46MB — put 64 in memory at once and killed the process with a 4GB heap. The
// index reported exit 0 having written nothing on the way there.
//
// This runs in a child process so the heap ceiling is ours to set: a 160MB cap
// makes the old behaviour fail and the new behaviour pass, without needing a
// multi-gigabyte fixture.

function bigRepo() {
  const root = mkdtempSync(join(tmpdir(), "pk-big-"));
  const write = (path, body) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  // Real code the index must still find.
  write("src/app.ts", "export function realFunction() { return helper(); }\nexport function helper() { return 1; }\n");

  // 40 data blobs of ~6MB each: 240MB total, far past a 256MB heap if the
  // window holds them all, trivial if it does not. Each is a single huge array
  // literal, which is what these generated files actually look like.
  // Multi-line on purpose: a single enormous line trips the minified-bundle
  // filter and never reaches the size check this test is about.
  const row = `  { id: 0, name: "entry", tags: ["a", "b"], value: 12345 },\n`;
  const blob = `module.exports = [\n${row.repeat(110_000)}];\n`;
  assert.ok(blob.length > EXTRACT_MAX_BYTES, "the fixture must exceed the extractor's limit to be representative");
  for (let i = 0; i < 40; i += 1) write(`data/blob${i}.js`, blob);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  return root;
}

test("a repo of oversized generated files indexes within a small heap", () => {
  const root = bigRepo();
  const dbDir = mkdtempSync(join(tmpdir(), "pk-bigdb-"));
  const dbPath = join(dbDir, "k.db");
  const ledgerPath = join(dbDir, "l.jsonl");

  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const indexerUrl = new URL("../packages/knowledge-indexer/dist/index.js", import.meta.url).href;
  const script = join(dbDir, "run.mjs");
  writeFileSync(script, [
    `const { KnowledgeStore } = await import(${JSON.stringify(coreUrl)});`,
    `const { indexRepo } = await import(${JSON.stringify(indexerUrl)});`,
    `const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(dbPath)}, ledgerPath: ${JSON.stringify(ledgerPath)} });`,
    `const report = await indexRepo({ store, rootPath: ${JSON.stringify(root)}, mode: "rebuild" });`,
    "console.log(JSON.stringify({ parsed: report.parsed, scanned: report.scanned, errors: report.errors, excluded: report.excluded }));",
    "store.close();",
  ].join("\n"));

  const stdout = execFileSync(process.execPath, ["--max-old-space-size=160", script], {
    encoding: "utf8",
    timeout: 300_000,
  });
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.ok(report.scanned > 40, `every file must be scanned, got ${JSON.stringify(report)}`);

  // And the real code is still indexed — the byte cap must skip the blobs, not
  // give up on the repo.
  // A file the policy declines to parse is not a failure. Counting it as one
  // made a real repo print "97 errors" on every index — a permanent false alarm
  // that trains the reader to ignore the error count.
  assert.equal(report.errors, 0, `policy exclusions must not be errors, got ${JSON.stringify(report)}`);
  assert.equal(report.excluded, 40, "and they must still be counted, not silently dropped");

  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const symbols = store.db
    .prepare("SELECT n.title FROM nodes n JOIN symbol_versions sv ON sv.node_id=n.id WHERE sv.status='fresh'")
    .all()
    .map((row) => row.title);
  assert.ok(symbols.includes("realFunction"), `real code must survive, got ${JSON.stringify(symbols)}`);
  assert.ok(symbols.includes("helper"));

  const coverage = store.db
    .prepare("SELECT parser_status, parser_error, COUNT(*) AS n FROM coverage_records GROUP BY parser_status, parser_error")
    .all();
  const excluded = coverage.find((row) => row.parser_status === "excluded");
  assert.ok(excluded, `oversized files must be recorded as excluded, got ${JSON.stringify(coverage)}`);
  assert.equal(excluded.n, 40);
  assert.match(
    excluded.parser_error,
    /exceeds max bytes/,
    "the reason lives in the same column, so 'why is this file not indexed' has one place to look",
  );
  assert.ok(
    !coverage.some((row) => row.parser_status === "failed"),
    `nothing actually failed, got ${JSON.stringify(coverage)}`,
  );
  store.close();
});
