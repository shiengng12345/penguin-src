import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadMcpAppDbModule() {
  const source = await readFile(new URL("../packages/mcp/src/app-db.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("parses protocol default headers from SQLite app_kv values", async () => {
  const { parseDefaultHeadersValue } = await loadMcpAppDbModule();
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
  const { filterStoredRequests, summarizeStoredRequest } = await loadMcpAppDbModule();
  const entries = [
    {
      id: "hist_1",
      timestamp: 100,
      protocol: "grpc-web",
      methodFullName: "pengvi.auth.Auth.PhoneNumberLoginWithPassword",
      serviceName: "pengvi.auth.Auth",
      packageName: "@snsoft/auth-grpc-web",
      url: "{{URL}}",
      requestBody: JSON.stringify({ phoneNumber: "6012", password: "secret" }),
      metadata: [{ key: "x-env-tag", value: "QAT", enabled: true }],
    },
    {
      id: "hist_2",
      timestamp: 200,
      protocol: "sdk",
      methodFullName: "Auth.lookupNationalId",
      serviceName: "Auth",
      packageName: "@snsoft/js-sdk",
      url: "{{URL}}",
      requestBody: "x".repeat(5000),
      metadata: [],
    },
  ];

  const filtered = filterStoredRequests(entries, {
    protocol: "grpc-web",
    query: "phone",
    limit: 10,
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "hist_1");
  assert.equal(filtered[0].requestBodyTruncated, false);

  const summarized = summarizeStoredRequest(entries[1]);
  assert.equal(summarized.requestBody.length, 4000);
  assert.equal(summarized.requestBodyTruncated, true);
  assert.equal(summarized.methodFullName, "Auth.lookupNationalId");
});

test("SQLite query failures are reported instead of looking like empty desktop state", async () => {
  const { desktopStateStatus, readAppValues } = await loadMcpAppDbModule();
  const existingDirectory = new URL("../packages/mcp/src", import.meta.url).pathname;

  assert.throws(() => readAppValues(existingDirectory), /SQLite read failed/);

  const status = desktopStateStatus(existingDirectory);
  assert.equal(status.exists, true);
  assert.equal(status.ok, false);
  assert.match(status.error, /SQLite read failed/);
});

test("large SQLite JSON output does not fail at the child-process buffer boundary", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readAppValues } = await loadMcpAppDbModule();
  const dir = await mkdtemp(join(tmpdir(), "penguin-large-app-db-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, "penguin.sqlite3");
  execFileSync("sqlite3", [db, `CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_kv VALUES ('large', printf('%.*c', 2000000, 'x'));`]);
  const values = readAppValues(db);
  assert.equal(values.large.length, 2000000);
});

test("MCP exposes SQLite-backed desktop state tools", async () => {
  const source = await readFile(new URL("../packages/mcp/src/index.ts", import.meta.url), "utf8");

  for (const toolName of [
    "get_default_headers",
    "list_saved_requests",
    "search_request_history",
  ]) {
    assert.match(source, new RegExp(`name: "${toolName}"`), toolName);
  }
  assert.match(source, /readDefaultHeaders/);
  assert.match(source, /readSavedRequests/);
  assert.match(source, /readRequestHistory/);
  assert.match(source, /sqlite/);
});

test("readRequestHistory prefers the request_history table and falls back to the legacy blob", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readRequestHistory, desktopStateStatus } = await loadMcpAppDbModule();

  const dir = await mkdtemp(join(tmpdir(), "penguin-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const entry = (id, method) => JSON.stringify({
    id,
    timestamp: 100,
    protocol: "grpc",
    methodFullName: method,
    serviceName: "Svc",
    packageName: "@snsoft/pkg",
    url: "http://localhost:5006",
    requestBody: "{}",
    metadata: [],
    response: { status: "OK", statusCode: 200, body: "{}" },
  });

  // v1.9+ layout: request_history table rows win.
  const tableDb = join(dir, "table.sqlite3");
  execFileSync("sqlite3", [tableDb, `
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

  // Pre-v1.9 layout: only the app_kv blob exists.
  const blobDb = join(dir, "blob.sqlite3");
  execFileSync("sqlite3", [blobDb, `
    CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO app_kv VALUES ('penguin-history', '[${entry("hist_b", "pkg.Svc.FromBlob").replaceAll("'", "''")}]', 1);
  `]);
  const fromBlob = readRequestHistory({ dbPath: blobDb });
  assert.equal(fromBlob.length, 1);
  assert.equal(fromBlob[0].methodFullName, "pkg.Svc.FromBlob");
});
