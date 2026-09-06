import assert from "node:assert/strict";
import { test } from "node:test";

import { filterWorkerExecArgv, parseStressArgs, runStressProfile } from "../scripts/knowledge-stress.mjs";
import { createIndexedC6Fixture, closeFixture } from "./helpers/knowledge-c6-fixture.mjs";
import { createLoadAccumulator, finalizeLoadReport, recordOperation } from "../scripts/knowledge-load-report.mjs";

test("C6 burst drives bounded concurrent scoped reads without raw locks", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 2, filesPerRepo: 4 });
  closeFixture(fixture);
  const report = await runStressProfile({
    rootPath: fixture.parent,
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    profileName: "burst",
    options: {
      rootPath: fixture.parent,
      durationOverride: 0.05,
      concurrencyOverride: 12,
      sessionsOverride: 5,
      maxRequestsOverride: 400,
    },
    argv: ["--execute", "--profile", "burst", "--duration-seconds=0.25", "--concurrency=12"],
  });

  assert.ok(report.requestCount >= 100, `burst must execute a meaningful bounded sample: ${report.requestCount}`);
  assert.equal(report.rawLockErrorCount, 0, JSON.stringify(report.errorsByType));
  assert.equal(report.timeoutCount, 0, JSON.stringify(report.errorsByType));
  assert.equal(report.infrastructureErrorCount, 0, JSON.stringify(report.errorsByType));
  assert.equal(report.dbIntegrity, "ok", JSON.stringify(report.integrity));
  assert.ok(Number.isFinite(report.latencyMs.p95), "p95 must be measured");
  assert.ok(report.latencyMs.p95 < 2_000, `fixture p95 unexpectedly high: ${report.latencyMs.p95}`);
  assert.equal(report.profile.concurrentReaders, 12);
  assert.equal(report.profile.mcpSessions, 5);
  assert.ok(report.resource.samples.length >= 2);
  assert.equal(report.concurrency.requested, 12);
  assert.equal(report.concurrency.actualWorkerCount, 12);
  assert.equal(report.concurrency.workerReadyCount, 12);
  assert.equal(report.concurrency.workerCompletedCount, 12);
  assert.equal(report.concurrency.peakActiveWorkers, 12, JSON.stringify(report.concurrency));
  assert.ok(Number.isInteger(report.concurrency.peakActiveRequests), JSON.stringify(report.concurrency));
  assert.equal(report.concurrency.actualRequestCount, report.requestCount);
  assert.ok(report.requestCount <= report.profile.maxRequests, "bounded reader quota must not be exceeded");
  assert.equal(report.concurrency.requestedMaxRequests, 400);
  assert.equal(report.gate.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.sampleSize.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.latencyP95.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.latencyP99.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.concurrency.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.gate.conditions.rawSqliteLocks.observed, 0);
  assert.equal(report.gate.conditions.integrity.status, "pass");
  assert.equal(report.gate.conditions.resources.status, "pass", JSON.stringify(report.gate));
  assert.equal(report.execution.readerTransport, "independent_node_processes");
  assert.equal(report.execution.requestedMcpSessions, 5);
  assert.equal(report.execution.actualMcpSessions, 0);
  assert.equal(report.execution.mcpLoadExecuted, false);
  assert.ok(report.gaps.includes("mcp_sessions_not_executed_by_reader_harness"));
  assert.equal(report.validRequestsPassed, true);
});

test("explicit MCP load runs persistent read-only sessions with a separate gate and cleanup", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 2 });
  closeFixture(fixture);
  const sessions = [];
  const lifecycle = [];
  const sessionFactory = (config) => {
    const session = {
      config,
      initialized: 0,
      calls: [],
      closed: 0,
      async initialize() {
        await new Promise((resolveInitialize) => setTimeout(resolveInitialize, config.sessionId * 5));
        this.initialized += 1;
        lifecycle.push(`initialized:${config.sessionId}`);
        return { result: { serverInfo: { name: "fixture" } } };
      },
      async callTool(name) {
        this.calls.push(name);
        lifecycle.push(`call:${config.sessionId}:${name}`);
        return { result: { structuredContent: { status: "ok" } } };
      },
      async close() { this.closed += 1; },
    };
    sessions.push(session);
    return session;
  };

  const report = await runStressProfile({
    rootPath: fixture.parent,
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    profileName: "burst",
    options: {
      rootPath: fixture.parent,
      durationOverride: 0.5,
      concurrencyOverride: 2,
      writerOverride: 0,
      sessionsOverride: 5,
      maxRequestsOverride: 25,
      mcpMinimumSampleRequests: 5,
      mcpSessionFactory: sessionFactory,
    },
    argv: ["--execute", "--profile=burst", "--mcp-sessions=5", "--max-requests=25"],
  });

  assert.equal(sessions.length, 5);
  assert.ok(sessions.every((session) => session.initialized === 1 && session.closed === 1));
  assert.ok(lifecycle.findIndex((event) => event.startsWith("call:")) > lifecycle.findLastIndex((event) => event.startsWith("initialized:")), JSON.stringify(lifecycle));
  assert.ok(sessions.every((session) => session.calls.length > 0));
  assert.ok(sessions.flatMap((session) => session.calls).every((name) => ["mcp_health", "knowledge_search", "knowledge_explore"].includes(name)));
  assert.ok(sessions.every((session) => session.config.env.PENGUIN_KNOWLEDGE_DB === fixture.dbPath));
  assert.ok(sessions.every((session) => session.config.env.PENGUIN_KNOWLEDGE_LEDGER === fixture.ledgerPath));
  assert.ok(sessions.every((session) => session.config.env.PENGUIN_MCP_WORKSPACE_ROOTS === fixture.parent));
  assert.ok(sessions.every((session) => session.config.env.PENGUIN_CLI_LAUNCHER.includes("semantic-wake-disabled")));
  assert.equal(report.execution.requestedMcpSessions, 5);
  assert.equal(report.execution.actualMcpSessions, 5);
  assert.equal(report.execution.mcpLoadExecuted, true);
  assert.equal(report.mcp.initializedSessions, 5);
  assert.equal(report.mcp.requestCount, 25, JSON.stringify({ profile: report.profile, calls: sessions.map((session) => session.calls) }));
  assert.equal(report.mcp.successCount, 25);
  assert.equal(report.mcp.peakSessionOverlap, 5);
  assert.ok(Number.isFinite(report.mcp.latencyMs.p95));
  assert.ok(Number.isFinite(report.mcp.latencyMs.p99));
  assert.equal(report.mcp.gate.status, "pass", JSON.stringify(report.mcp.gate));
  assert.equal(report.mcp.safety.semanticWakeDisabled, true);
  assert.equal(report.mcp.safety.productionDatabaseRequiresClone, true);
  assert.equal(report.gate.status, "insufficient_sample", "the MCP gate must not weaken or replace the reader gate");
});

test("MCP load classifies call failures without merging them into reader metrics", async () => {
  const fixture = await createIndexedC6Fixture({ repoCount: 1, filesPerRepo: 2 });
  closeFixture(fixture);
  const failures = [
    Object.assign(new Error("known scope failure"), { code: "KNOWLEDGE_SCOPE_UNAVAILABLE" }),
    new Error("SQLITE_BUSY: database is locked"),
    new Error("MCP request timed out"),
    { message: "stdio pipe disappeared" },
  ];
  const sessions = [];
  const sessionFactory = ({ sessionId, ...config }) => {
    const session = {
      config,
      closed: 0,
      async initialize() { return { result: { serverInfo: { name: "fixture" } } }; },
      async callTool() { throw failures[sessionId]; },
      async close() { this.closed += 1; },
    };
    sessions.push(session);
    return session;
  };

  const report = await runStressProfile({
    rootPath: fixture.parent,
    dbPath: fixture.dbPath,
    ledgerPath: fixture.ledgerPath,
    profileName: "burst",
    options: {
      rootPath: fixture.parent,
      durationOverride: 0.5,
      concurrencyOverride: 2,
      writerOverride: 0,
      sessionsOverride: 4,
      maxRequestsOverride: 4,
      mcpMinimumSampleRequests: 4,
      mcpSessionFactory: sessionFactory,
    },
    argv: ["--execute", "--profile=burst", "--mcp-sessions=4", "--max-requests=4"],
  });

  assert.ok(sessions.every((session) => session.closed === 1));
  assert.equal(report.mcp.typedErrorCount, 1);
  assert.equal(report.mcp.rawLockErrorCount, 1);
  assert.equal(report.mcp.timeoutCount, 1);
  assert.equal(report.mcp.infrastructureErrorCount, 1);
  assert.equal(report.mcp.gate.status, "fail", JSON.stringify(report.mcp.gate));
  assert.equal(report.typedErrorCount, 0, "reader counters must not include MCP failures");
  assert.equal(report.rawLockErrorCount, 0, "reader counters must not include MCP failures");
  assert.equal(report.timeoutCount, 0, "reader counters must not include MCP failures");
  assert.equal(report.infrastructureErrorCount, 0, "reader counters must not include MCP failures");
});

test("load gate refuses a low sample and records the missing proof", () => {
  const accumulator = createLoadAccumulator({
    profile: { name: "burst", concurrentReaders: 4, maxRequests: 100 },
    rootPath: "/tmp/fixture",
    dbPath: "/tmp/fixture/knowledge.db",
  });
  recordOperation(accumulator, { ok: true, latencyMs: 1, operationId: "read:0" });
  recordOperation(accumulator, { ok: true, latencyMs: 1, operationId: "read:1" });

  const report = finalizeLoadReport(accumulator, {
    resources: [
      { rssBytes: 10, diskBytes: 10, fdCount: 3, threadCount: 1 },
      { rssBytes: 11, diskBytes: 10, fdCount: 3, threadCount: 1 },
    ],
    integrity: { ok: true, quickCheck: "ok", integrityCheck: "ok" },
  });

  assert.equal(report.gate.status, "insufficient_sample", JSON.stringify(report.gate));
  assert.equal(report.validRequestsPassed, false);
  assert.equal(report.gate.conditions.sampleSize.status, "insufficient_sample");
  assert.ok(report.gate.reasons.includes("sample_count_below_minimum"));
});

test("worker launch removes parent-only Node flags", () => {
  assert.deepEqual(
    filterWorkerExecArgv(["--input-type=module", "--test", "--test-name-pattern=burst", "--enable-source-maps"]),
    ["--enable-source-maps"],
  );
});

test("stress planning mode is safe and does not require opening a database", async () => {
  const report = await (await import("../scripts/knowledge-stress.mjs")).runStress({
    argv: ["--profile", "all"],
    requestedProfiles: ["burst", "mixed", "soak", "writer_race", "fault"],
    execute: false,
    json: true,
  });
  assert.equal(report.mode, "dry-run");
  assert.deepEqual(report.reports, []);
  assert.ok(report.gaps.includes("no_database_or_checkout_mutation_performed"));
});

test("stress parser preserves explicit writer repository roots", () => {
  const parsed = parseStressArgs([
    "--profile", "mixed",
    "--writer-roots", "/workspace/auth,/workspace/ccmsrust",
  ]);
  assert.deepEqual(parsed.writerRootsOverride, ["/workspace/auth", "/workspace/ccmsrust"]);
});

test("stress parser permits a 100k request ceiling for a full 30 minute mixed run", () => {
  const parsed = parseStressArgs(["--profile", "mixed", "--max-requests", "100000"]);
  assert.equal(parsed.maxRequestsOverride, 100_000);
});
