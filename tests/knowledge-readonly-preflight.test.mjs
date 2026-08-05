import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { runQueryServer } from "../packages/knowledge-cli/dist/query-server.js";

const knowledgeCoreRequire = createRequire(new URL("../packages/knowledge-core/package.json", import.meta.url));
const Database = knowledgeCoreRequire("better-sqlite3");

// Mirrors bin.ts's real openStore: forwards allowSchemaMutation so the CLI
// dispatch's read-only gate (command-dispatch.ts, READ_VERBS block) is
// actually exercised end-to-end, not bypassed by a test double.
function cliHarness() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-readonly-cli-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const lines = [];
  const errs = [];
  const deps = {
    cwd: dir,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    storeExists: () => existsSync(dbPath),
    openStore: (opts) => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: opts?.allowSchemaMutation }),
  };
  return { dbPath, ledgerPath, deps, lines, errs };
}

test("outdated schema + read-only open throws SCHEMA_OUTDATED instead of migrating", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-readonly-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  store.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run();
  store.close();

  assert.throws(
    () => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false }),
    (err) => err.code === "SCHEMA_OUTDATED",
  );
  // Stored version untouched by the failed read-only open:
  const writable = KnowledgeStore.open({ dbPath, ledgerPath });
  // (writable open migrates as before)
  const stored = writable.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  writable.close();
});

test("CLI read verb against a stale-schema DB fails loud (exit 3, SCHEMA_OUTDATED) without migrating", async () => {
  const { dbPath, ledgerPath, deps, errs } = cliHarness();
  const seed = KnowledgeStore.open({ dbPath, ledgerPath });
  seed.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run();
  seed.close();

  const code = await runCli(["status"], deps);

  assert.equal(code, 3);
  assert.match(errs.join("\n"), /SCHEMA_OUTDATED|schema is outdated/);
  assert.match(errs.join("\n"), /penguin index/);

  // The failed read-only dispatch must not have run DDL/migration: open the
  // raw file directly (bypassing openDatabase entirely) to check the on-disk
  // stored version is still untouched.
  const db = new Database(dbPath);
  const stored = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 12);
  db.close();
});

test("CLI read verb against a current-schema DB succeeds through the read-only gate (exit 0)", async () => {
  const { dbPath, ledgerPath, deps, lines } = cliHarness();
  const seed = KnowledgeStore.open({ dbPath, ledgerPath });
  seed.close();

  const code = await runCli(["status", "--json"], deps);

  assert.equal(code, 0);
  assert.ok(lines.length > 0);
});

// The resident query-server (`__query-server`) is long-lived: two callers
// (the Tauri app and, separately, this test) both used to be able to open it
// with mutation allowed, so merely launching it silently migrated an
// outdated on-disk schema (Phase 1B Task 9). It must refuse exactly like the
// CLI's READ_VERBS gate above -- but it can't use the normal exit-3
// stderr-message path (its whole protocol is newline-delimited JSON frames on
// stdout), so it reports the failure as a hello-shaped error frame instead of
// the normal `queryHello(...)` handshake.
function queryServerHarness() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-readonly-qs-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const deps = {
    cwd: dir,
    out: () => {},
    err: () => {},
    storeExists: () => existsSync(dbPath),
    openStore: (opts) => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: opts?.allowSchemaMutation }),
  };
  return { dbPath, ledgerPath, deps };
}

test("runQueryServer against a version-spoofed store emits an error hello frame instead of migrating", async () => {
  const { dbPath, ledgerPath, deps } = queryServerHarness();
  const seed = KnowledgeStore.open({ dbPath, ledgerPath });
  seed.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run();
  seed.close();

  const input = new Readable({ read() {} });
  const frames = [];
  const output = { write: (chunk) => { frames.push(JSON.parse(chunk)); return true; } };
  input.push(null); // the handshake open fails before any request frame would be read

  const code = await runQueryServer(deps, input, output);

  assert.equal(code, 3);
  assert.equal(frames.length, 1, JSON.stringify(frames));
  assert.equal(frames[0].type, "hello");
  assert.equal(frames[0].error?.code, "SCHEMA_OUTDATED");
  assert.match(frames[0].error?.message ?? "", /penguin index/);
  // Must NOT also carry a real handshake's fields -- the Rust bridge treats
  // an error hello and a normal hello as mutually exclusive shapes.
  assert.equal(frames[0].schemaVersion, undefined);
  assert.equal(frames[0].capabilityHash, undefined);

  // The failed read-only open must not have run DDL/migration: read the raw
  // file directly (bypassing openDatabase entirely).
  const db = new Database(dbPath);
  const stored = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 12);
  db.close();
});
