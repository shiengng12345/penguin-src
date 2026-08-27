import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// app-db reads the DESKTOP app's sqlite state from the MCP server. The
// regression these tests guard: reads must be key-scoped and time-bounded —
// a full-table `sqlite3 -json` read of app_kv once spun 14+ minutes at 100%
// CPU on a single 8.6MB row (the CLI's JSON escaping is quadratic in value
// length) and, because the server waits synchronously, wedged EVERY tool
// call including mcp_health.

async function loadAppDbModule() {
  const source = await readFile(
    new URL("../packages/mcp/src/app-db.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  // In this data:-URL module, createRequire(import.meta.url) throws, so the
  // module exercises its sqlite3-CLI fallback path — the one with the
  // quadratic-JSON history and the timeout guard.
  return import(`data:text/javascript;base64,${encoded}`);
}

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-app-db-"));
  const dbPath = join(dir, "penguin.sqlite3");
  // ~2MB pathological row: with the old whole-table -json read this
  // dominates every query; with key-scoped reads it must cost nothing.
  const giant = "x".repeat(2 * 1024 * 1024).replace(/x/g, '"');
  const sqlPath = join(dir, "seed.sql");
  writeFileSync(
    sqlPath,
    [
      "CREATE TABLE app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
      `INSERT INTO app_kv VALUES ('penguin-default-headers', '{"grpc-web":[{"key":"x-env-tag","value":"QAT","enabled":true}]}', 0);`,
      `INSERT INTO app_kv VALUES ('penguin-tabs', '${giant.replace(/'/g, "''").replace(/"/g, '""')}', 0);`,
      `INSERT INTO app_kv VALUES ('rest:secret:token', 'sensitive-value', 0);`,
      `INSERT INTO app_kv VALUES ('it''s-a-quoted-key', 'quoted-ok', 0);`,
    ].join("\n"),
  );
  execFileSync("/usr/bin/sqlite3", [dbPath, `.read ${sqlPath}`], { stdio: "ignore" });
  return dbPath;
}

test("readAppValues is key-scoped: giant unrelated rows cost nothing", async () => {
  const { readAppValues } = await loadAppDbModule();
  const dbPath = makeDb();
  const started = Date.now();
  const values = readAppValues(dbPath, ["penguin-default-headers"]);
  const elapsed = Date.now() - started;
  assert.equal(Object.keys(values).length, 1);
  assert.match(values["penguin-default-headers"], /x-env-tag/);
  // The old full-table read took minutes on a DB like this; scoped reads are
  // sub-second even through the CLI fallback. Generous bound to stay
  // load-tolerant while still failing hard on a full-table regression.
  assert.ok(elapsed < 5000, `key-scoped read took ${elapsed}ms`);
});

test("readAppValues never returns sensitive keys, even when asked", async () => {
  const { readAppValues } = await loadAppDbModule();
  const dbPath = makeDb();
  const values = readAppValues(dbPath, ["rest:secret:token", "penguin-default-headers"]);
  assert.equal(values["rest:secret:token"], undefined);
  assert.equal(Object.keys(values).length, 1);
});

test("readAppValues CLI fallback quotes parameter values safely", async () => {
  const { readAppValues } = await loadAppDbModule();
  const dbPath = makeDb();
  const values = readAppValues(dbPath, ["it's-a-quoted-key"]);
  assert.equal(values["it's-a-quoted-key"], "quoted-ok");
});

test("listAppValueKeys returns names only and hides sensitive keys", async () => {
  const { listAppValueKeys } = await loadAppDbModule();
  const dbPath = makeDb();
  const keys = listAppValueKeys(dbPath);
  assert.ok(keys.includes("penguin-tabs"));
  assert.ok(keys.includes("penguin-default-headers"));
  assert.ok(!keys.includes("rest:secret:token"));
});

test("readDefaultHeaders reads only its key", async () => {
  const { readDefaultHeaders } = await loadAppDbModule();
  const dbPath = makeDb();
  const headers = readDefaultHeaders({ dbPath, protocol: "grpc-web" });
  assert.equal(headers["grpc-web"]?.[0]?.key, "x-env-tag");
  assert.equal(headers["grpc-web"]?.[0]?.value, "QAT");
});

test("missing DB returns empty results, not errors", async () => {
  const { readAppValues, listAppValueKeys } = await loadAppDbModule();
  const missing = join(tmpdir(), `penguin-nope-${Date.now()}`, "penguin.sqlite3");
  assert.deepEqual(readAppValues(missing, ["penguin-default-headers"]), {});
  assert.deepEqual(listAppValueKeys(missing), []);
});
