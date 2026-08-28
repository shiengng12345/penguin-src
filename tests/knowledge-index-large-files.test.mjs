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
  const blob = `module.exports = [${"0,".repeat(3_000_000)}0];\n`;
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
    "console.log(JSON.stringify({ parsed: report.parsed, scanned: report.scanned }));",
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
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const symbols = store.db
    .prepare("SELECT n.title FROM nodes n JOIN symbol_versions sv ON sv.node_id=n.id WHERE sv.status='fresh'")
    .all()
    .map((row) => row.title);
  assert.ok(symbols.includes("realFunction"), `real code must survive, got ${JSON.stringify(symbols)}`);
  assert.ok(symbols.includes("helper"));
  store.close();
});
