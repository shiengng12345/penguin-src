import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as boundaryAudit from "../scripts/knowledge-projects-boundary-audit.mjs";

const { scoreRelationSets } = boundaryAudit;
const require = createRequire(import.meta.url);
const ts = require("typescript");
const knowledgeCoreRequire = createRequire(new URL("../packages/knowledge-core/package.json", import.meta.url));
const Database = knowledgeCoreRequire("better-sqlite3");

test("projects boundary audit scores exact, missing, and extra relations", () => {
  assert.deepEqual(scoreRelationSets(["a", "b"], ["a", "b"]), {
    expected: 2, actual: 2, tp: 2, fp: 0, fn: 0, precision: 1, recall: 1,
  });
  assert.deepEqual(scoreRelationSets(["a", "b"], ["a", "c"]), {
    expected: 2, actual: 2, tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5,
  });
});

test("projects boundary audit can read SQLite JSON results larger than spawnSync default buffer", () => {
  assert.equal(typeof boundaryAudit.sql, "function");
  const dir = mkdtempSync(join(tmpdir(), "penguin-boundary-buffer-"));
  const dbPath = join(dir, "audit.db");
  const db = new Database(dbPath);
  db.close();
  try {
    const [row] = boundaryAudit.sql("SELECT hex(zeroblob(600000)) AS payload", dbPath);
    assert.equal(row.payload.length, 1_200_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects boundary audit read-only SQL sees committed WAL rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-boundary-wal-"));
  const dbPath = join(dir, "audit.db");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE repos(id INTEGER PRIMARY KEY); INSERT INTO repos VALUES (1)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("INSERT INTO repos VALUES (2)");
    const [row] = boundaryAudit.sql("SELECT COUNT(*) AS value FROM repos", dbPath);
    assert.equal(row.value, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projects boundary audit exposes missing and extra relation keys", () => {
  assert.equal(typeof boundaryAudit.relationSetDifferences, "function");
  assert.deepEqual(boundaryAudit.relationSetDifferences(["a", "b"], ["b", "c"]), {
    missing: ["a"],
    extra: ["c"],
  });
});

test("projects boundary audit cannot pass while candidates lack enclosing symbols", () => {
  assert.equal(typeof boundaryAudit.auditPassed, "function");
  assert.equal(boundaryAudit.auditPassed({
    precisionFailures: [],
    unsupportedCandidates: [{ reason: "no_enclosing_symbol" }],
    perRepo: [{ precision: 1, recall: 1 }],
    flyoverProto: { precision: 1, recall: 1 },
  }), false);
});

test("projects boundary audit enumerates direct frontend handleApiRequest calls", () => {
  assert.equal(typeof boundaryAudit.handleApiRequestCalls, "function");
  const sourceFile = ts.createSourceFile(
    "service.ts",
    "async function load() { return grpcClientService.handleApiRequest('getPlatforms', () => adminClient.getPlatforms({})); }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.deepEqual(boundaryAudit.handleApiRequestCalls(sourceFile), [{ method: "getPlatforms", line: 1 }]);
});

test("projects boundary audit enumerates RPC methods called on getter-created clients", () => {
  assert.equal(typeof boundaryAudit.getterClientCalls, "function");
  const sourceFile = ts.createSourceFile(
    "service.ts",
    [
      "const client = grpcClientService.getClient();",
      "const wsClient = serverInstance.getWebSocketMessageClient();",
      "async function load() {",
      "  await client.getPlayerAllLevel({});",
      "  await (client as any).getComponentV2({});",
      "  wsClient.sendMessage({});",
      "}",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.deepEqual(boundaryAudit.getterClientCalls(sourceFile), [
    { method: "getPlayerAllLevel", line: 4 },
    { method: "getComponentV2", line: 5 },
  ]);
});
