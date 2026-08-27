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

// —— Restored coverage (originally lost in the key-scoped-read rewrite) ——
// These pin still-shipping behaviors: default-header parsing, request-body
// truncation, error reporting on a corrupt DB, buffer headroom, tool wiring,
// and the request_history-table vs legacy-blob fallback.

test("parses protocol default headers from SQLite app_kv values", async () => {
  const { parseDefaultHeadersValue } = await loadAppDbModule();
  const raw = JSON.stringify({
    "grpc-web": [
      { key: "x-env-tag", value: "{{X_ENV_TAG}}", enabled: true },
      { key: "x-disabled", value: "no", enabled: false },
    ],
    grpc: [{ key: "authorization", value: "Bearer token", enabled: true }],
  });
  assert.deepEqual(parseDefaultHeadersValue(raw, "grpc-web"), {
    "grpc-web": [
      { key: "x-env-tag", value: "{{X_ENV_TAG}}", enabled: true },
      { key: "x-disabled", value: "no", enabled: false },
    ],
  });
  assert.deepEqual(parseDefaultHeadersValue(raw), {
    "grpc-web": [
      { key: "x-env-tag", value: "{{X_ENV_TAG}}", enabled: true },
      { key: "x-disabled", value: "no", enabled: false },
    ],
    grpc: [{ key: "authorization", value: "Bearer token", enabled: true }],
  });
});

test("filters and summarizes stored history without leaking huge bodies", async () => {
  const { filterStoredRequests, summarizeStoredRequest } = await loadAppDbModule();
  const entries = [
    {
      id: "hist_1", timestamp: 100, protocol: "grpc-web",
      methodFullName: "pengvi.auth.Auth.PhoneNumberLoginWithPassword",
      serviceName: "pengvi.auth.Auth", packageName: "@snsoft/auth-grpc-web",
      url: "{{URL}}",
      requestBody: JSON.stringify({ phoneNumber: "6012", password: "secret" }),
      metadata: [{ key: "x-env-tag", value: "QAT", enabled: true }],
    },
    {
      id: "hist_2", timestamp: 200, protocol: "sdk",
      methodFullName: "Auth.lookupNationalId", serviceName: "Auth",
      packageName: "@snsoft/js-sdk", url: "{{URL}}",
      requestBody: "x".repeat(5000), metadata: [],
    },
  ];
  const filtered = filterStoredRequests(entries, { protocol: "grpc-web", query: "phone", limit: 10 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "hist_1");
  assert.equal(filtered[0].requestBodyTruncated, false);
  const summarized = summarizeStoredRequest(entries[1]);
  assert.equal(summarized.requestBody.length, 4000);
  assert.equal(summarized.requestBodyTruncated, true);
});

test("SQLite query failures are reported instead of looking like empty desktop state", async () => {
  const { desktopStateStatus, readAppValues } = await loadAppDbModule();
  const existingDirectory = new URL("../packages/mcp/src", import.meta.url).pathname;
  assert.throws(() => readAppValues(existingDirectory, ["penguin-default-headers"]), /SQLite read failed/);
  const status = desktopStateStatus(existingDirectory);
  assert.equal(status.exists, true);
  assert.equal(status.ok, false);
  assert.match(status.error, /SQLite read failed/);
});

test("large values survive the read path (buffer headroom)", async () => {
  const { readAppValues } = await loadAppDbModule();
  const dir = mkdtempSync(join(tmpdir(), "penguin-large-app-db-"));
  const db = join(dir, "penguin.sqlite3");
  execFileSync("/usr/bin/sqlite3", [db,
    "CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO app_kv VALUES ('large', printf('%.*c', 2000000, 'x'), 0);",
  ]);
  const values = readAppValues(db, ["large"]);
  assert.equal(values.large.length, 2000000);
});

test("MCP exposes SQLite-backed desktop state tools", async () => {
  const source = await readFile(new URL("../packages/mcp/src/index.ts", import.meta.url), "utf8");
  for (const toolName of ["get_default_headers", "list_saved_requests", "search_request_history"]) {
    assert.match(source, new RegExp(`name: "${toolName}"`), toolName);
  }
  assert.match(source, /readDefaultHeaders/);
  assert.match(source, /readSavedRequests/);
  assert.match(source, /readRequestHistory/);
});

test("readRequestHistory prefers the request_history table and falls back to the legacy blob", async () => {
  const { readRequestHistory, desktopStateStatus } = await loadAppDbModule();
  const dir = mkdtempSync(join(tmpdir(), "penguin-history-"));
  const entry = (id, method) => JSON.stringify({
    id, timestamp: 100, protocol: "grpc", methodFullName: method,
    serviceName: "Svc", packageName: "@snsoft/pkg", url: "http://localhost:5006",
    requestBody: "{}", metadata: [],
    response: { status: "OK", statusCode: 200, body: "{}" },
  });
  const tableDb = join(dir, "table.sqlite3");
  execFileSync("/usr/bin/sqlite3", [tableDb, `
    CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE saved_requests (id TEXT PRIMARY KEY, name TEXT, saved_at INTEGER, protocol TEXT,
      method_full_name TEXT, service_name TEXT, package_name TEXT, url TEXT, entry_json TEXT);
    CREATE TABLE request_history (
      id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, protocol TEXT NOT NULL,
      method_full_name TEXT NOT NULL, service_name TEXT NOT NULL,
      package_name TEXT NOT NULL, url TEXT NOT NULL, entry_json TEXT NOT NULL
    );
    INSERT INTO request_history VALUES ('hist_t', 100, 'grpc', 'pkg.Svc.FromTable', 'Svc', '@snsoft/pkg', 'http://x', '${entry("hist_t", "pkg.Svc.FromTable")}');
  `]);
  const fromTable = readRequestHistory({ dbPath: tableDb });
  assert.equal(fromTable.length, 1);
  assert.equal(fromTable[0].methodFullName, "pkg.Svc.FromTable");
  assert.equal(desktopStateStatus(tableDb).historyCount, 1);

  const blobDb = join(dir, "blob.sqlite3");
  execFileSync("/usr/bin/sqlite3", [blobDb, `
    CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO app_kv VALUES ('penguin-history', '[${entry("hist_b", "pkg.Svc.FromBlob").replaceAll("'", "''")}]', 1);
  `]);
  const fromBlob = readRequestHistory({ dbPath: blobDb });
  assert.equal(fromBlob.length, 1);
  assert.equal(fromBlob[0].methodFullName, "pkg.Svc.FromBlob");
});
