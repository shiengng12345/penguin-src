#!/usr/bin/env node
/**
 * Bounded Penguin Knowledge heavy-use harness.
 *
 * Safety contract:
 *   - Without --execute this is a read-only planning receipt. It does not
 *     open, create, reset, index, or mutate a database.
 *   - With --execute, --root, --db, and --ledger are mandatory. The harness
 *     never deletes a checkout/database; writer profiles only run the normal
 *     incremental indexer against the explicitly supplied database.
 *   - Duration, concurrency, and request count are hard-bounded. A real
 *     8-hour soak is an explicit operator run, not an accidental default.
 */
import { existsSync, statSync } from "node:fs";
import { fork } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  KnowledgeStore,
  assertWorkspacePath,
  canonicalPathForCheck,
  listSemanticStatuses,
} from "../packages/knowledge-core/dist/index.js";
import { discoverFullCorpusRepositories, indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import {
  assertDatabaseIntegrity,
  classifyError,
  createLoadAccumulator,
  finalizeLoadReport,
  latencySummary,
  LOAD_REPORT_VERSION,
  recordOperation,
  resourcePeaks,
  sampleResources,
  writeImmutableJson,
} from "./knowledge-load-report.mjs";
import { defaultProcessPaths, McpSession, mcpStructured, processEnv } from "./knowledge-process-utils.mjs";

const MAX_DURATION_SECONDS = 8 * 60 * 60;
const MAX_READERS = 100;
const MAX_WRITERS = 10;
const MAX_SESSIONS = 20;
const MAX_REQUESTS = 100_000;
const DEFAULT_DURATION_SECONDS = 1;
const MCP_CALL_TIMEOUT_MS = 2_000;
const MCP_CLEANUP_TIMEOUT_MS = 2_000;
const MCP_MINIMUM_SAMPLE_REQUESTS = 100;
const STRESS_ROOT = resolve(import.meta.dirname, "..");
const MCP_READ_ONLY_CALLS = Object.freeze([
  { name: "mcp_health", arguments: {} },
  { name: "knowledge_search", arguments: { query: "service", limit: 5, compact: true } },
  { name: "knowledge_explore", arguments: { target: "service", limit: 5 } },
]);

const PROFILE_DEFAULTS = {
  burst: { durationSeconds: 1, concurrentReaders: 20, concurrentWriters: 0, mcpSessions: 5, maxRequests: 5_000 },
  mixed: { durationSeconds: 2, concurrentReaders: 8, concurrentWriters: 2, mcpSessions: 5, maxRequests: 5_000 },
  soak: { durationSeconds: 60, concurrentReaders: 8, concurrentWriters: 1, mcpSessions: 5, maxRequests: 50_000 },
  writer_race: { durationSeconds: 2, concurrentReaders: 8, concurrentWriters: 2, mcpSessions: 2, maxRequests: 2_000 },
  fault: { durationSeconds: 1, concurrentReaders: 2, concurrentWriters: 1, mcpSessions: 1, maxRequests: 1_000 },
};

function usageError(message) {
  return Object.assign(new Error(message), { code: "STRESS_ARGUMENT_INVALID", retryable: false });
}

function numberOption(value, name, { min, max, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    throw usageError(`${name} must be ${integer ? "an integer " : ""}between ${min} and ${max}`);
  }
  return number;
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function filterWorkerExecArgv(execArgv = process.execArgv) {
  return execArgv.filter((argument) => {
    if (argument === "--test" || argument.startsWith("--test-")) return false;
    if (argument === "--input-type" || argument.startsWith("--input-type=")) return false;
    return true;
  });
}

export function parseStressArgs(argv = process.argv.slice(2)) {
  const profiles = optionValue(argv, "profile") ?? "burst";
  const requestedProfiles = profiles === "all" ? Object.keys(PROFILE_DEFAULTS) : [profiles];
  if (requestedProfiles.some((profile) => !Object.hasOwn(PROFILE_DEFAULTS, profile))) {
    throw usageError(`--profile must be burst, mixed, soak, writer_race, fault, or all`);
  }
  const durationOverride = optionValue(argv, "duration-seconds");
  const concurrencyOverride = optionValue(argv, "concurrency");
  const writerOverride = optionValue(argv, "writer-concurrency");
  const sessionsOverride = optionValue(argv, "mcp-sessions");
  const maxRequestsOverride = optionValue(argv, "max-requests");
  const writerRootsValue = optionValue(argv, "writer-roots");
  return {
    argv: [...argv],
    rootPath: optionValue(argv, "root"),
    dbPath: optionValue(argv, "db"),
    ledgerPath: optionValue(argv, "ledger"),
    reportPath: optionValue(argv, "report"),
    requestedProfiles,
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
    noWriters: argv.includes("--no-writers"),
    durationOverride: durationOverride === undefined ? undefined : numberOption(durationOverride, "--duration-seconds", { min: 0.01, max: MAX_DURATION_SECONDS }),
    concurrencyOverride: concurrencyOverride === undefined ? undefined : numberOption(concurrencyOverride, "--concurrency", { min: 1, max: MAX_READERS, integer: true }),
    writerOverride: writerOverride === undefined ? undefined : numberOption(writerOverride, "--writer-concurrency", { min: 0, max: MAX_WRITERS, integer: true }),
    sessionsOverride: sessionsOverride === undefined ? undefined : numberOption(sessionsOverride, "--mcp-sessions", { min: 1, max: MAX_SESSIONS, integer: true }),
    maxRequestsOverride: maxRequestsOverride === undefined ? undefined : numberOption(maxRequestsOverride, "--max-requests", { min: 1, max: MAX_REQUESTS, integer: true }),
    writerRootsOverride: writerRootsValue === undefined
      ? undefined
      : writerRootsValue.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function requireExecuteInputs(options) {
  if (!options.rootPath || !options.dbPath || !options.ledgerPath) {
    throw usageError("--execute requires explicit --root, --db, and --ledger paths");
  }
  const rootPath = canonicalPathForCheck(resolve(options.rootPath));
  const dbPath = resolve(options.dbPath);
  const ledgerPath = resolve(options.ledgerPath);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw usageError(`root does not exist or is not a directory: ${rootPath}`);
  if (!isAbsolute(dbPath) || !isAbsolute(ledgerPath)) throw usageError("--db and --ledger must be absolute paths");
  return { rootPath, dbPath, ledgerPath };
}

function currentScopes(store) {
  return store.db.prepare(`
    SELECT b.id AS branchId,b.repo_id AS repoId,b.name AS branchName,
           b.current_snapshot_id AS snapshotId,r.name AS repoName,r.root_path AS rootPath
      FROM branches b JOIN repos r ON r.id=b.repo_id
     WHERE b.current_snapshot_id IS NOT NULL AND b.status != 'gone'
     ORDER BY r.root_path,b.name,b.id
  `).all();
}

function tableExists(store, table) {
  return Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function chooseScope(scopes, workerId) {
  if (!scopes.length) throw Object.assign(new Error("KNOWLEDGE_SCOPE_UNAVAILABLE: no ready repository snapshot"), { code: "KNOWLEDGE_SCOPE_UNAVAILABLE" });
  return scopes[workerId % scopes.length];
}

/** These are deliberately bounded, read-only operations. The real MCP load
 * gate runs the packaged sessions separately; this process provides a stable
 * fixture baseline without opening 100 embedded server processes per test. */
function runReadOperation(store, scope, operation, sequence) {
  const limit = 20;
  switch (operation) {
    case "search":
      return store.db.prepare(`SELECT n.id,n.title,n.node_type AS nodeType
        FROM nodes n WHERE n.repo_id=? ORDER BY n.identity_key LIMIT ?`).all(scope.repoId, limit);
    case "context":
      return store.db.prepare(`SELECT n.id,n.title,n.node_type AS nodeType,
          sv.file_path AS filePath,sv.start_line AS startLine
        FROM nodes n LEFT JOIN symbol_versions sv ON sv.node_id=n.id
        WHERE n.repo_id=? AND (sv.branch_id=? OR sv.branch_id IS NULL)
        ORDER BY n.identity_key LIMIT ?`).all(scope.repoId, scope.branchId, limit);
    case "flow":
      return store.db.prepare(`SELECT e.src,e.dst,e.edge_type AS edgeType,e.method
        FROM edges e WHERE e.branch_id=? AND e.status='active'
        ORDER BY e.id LIMIT ?`).all(scope.branchId, limit);
    case "affected":
      return store.db.prepare(`SELECT file_path AS filePath,status,content_hash AS contentHash
        FROM files_index WHERE repo_id=? AND branch_id=? ORDER BY file_path LIMIT ?`).all(scope.repoId, scope.branchId, limit);
    case "domain":
      return store.db.prepare(`SELECT id,title,node_type AS nodeType,repo_id AS repoId
        FROM nodes WHERE repo_id=? AND node_type IN ('entity','service','route','endpoint')
        ORDER BY identity_key LIMIT ?`).all(scope.repoId, limit);
    case "wiki": {
      if (!tableExists(store, "notes_index")) return [];
      return store.db.prepare(`SELECT node_id AS nodeId,path
        FROM notes_index WHERE node_id IN (SELECT id FROM nodes WHERE repo_id=?)
        ORDER BY path LIMIT ?`).all(scope.repoId, limit);
    }
    case "status":
      return store.db.prepare(`SELECT COUNT(*) AS nodes FROM nodes WHERE repo_id=?`).get(scope.repoId);
    default:
      throw Object.assign(new Error(`STRESS_OPERATION_UNKNOWN:${operation}`), { code: "STRESS_OPERATION_UNKNOWN" });
  }
}

function operationMix(profileName) {
  if (profileName === "writer_race") return ["search", "context", "flow", "affected"];
  if (profileName === "fault") return ["search", "status"];
  if (profileName === "soak") return ["search", "context", "flow", "affected", "domain", "wiki", "status"];
  return ["search", "context", "flow", "affected", "domain", "wiki"];
}

function workerSend(message) {
  try {
    if (typeof process.send === "function") process.send(message);
  } catch {
    // The parent owns worker lifecycle and may close IPC after a hard bound.
  }
}

async function runReadWorkerProcess() {
  let config;
  try {
    config = JSON.parse(process.env.PENGUIN_STRESS_WORKER_CONFIG ?? "");
    if (!config?.dbPath || !config?.ledgerPath || !Number.isInteger(config.workerId)) throw new Error("invalid worker configuration");
    const store = KnowledgeStore.open({ dbPath: config.dbPath, ledgerPath: config.ledgerPath, allowSchemaMutation: false });
    const scopes = currentScopes(store);
    workerSend({ type: "ready", workerId: config.workerId, scopeCount: scopes.length, resource: sampleResources(config.dbPath) });
    process.on("message", async (message) => {
      if (message?.type !== "start") return;
      workerSend({ type: "waiting", workerId: config.workerId });
      await new Promise((resolveRelease) => {
        const waitForRelease = (nextMessage) => {
          if (nextMessage?.type === "release") resolveRelease();
          else process.once("message", waitForRelease);
        };
        process.once("message", waitForRelease);
      });
      const mix = operationMix(config.profileName);
      let completed = 0;
      const workerStartAt = performance.timeOrigin + performance.now();
      const workerDeadline = Date.now() + message.durationMs;
      workerSend({ type: "started", workerId: config.workerId, startedAt: workerStartAt });
      for (let sequence = 0; sequence < config.quota && Date.now() < workerDeadline; sequence += 1) {
        const operation = mix[sequence % mix.length];
        const scope = chooseScope(scopes, sequence + config.workerId);
        const started = performance.now();
        const startedAt = performance.timeOrigin + started;
        try {
          runReadOperation(store, scope, operation, sequence);
          workerSend({ type: "operation", workerId: config.workerId, ok: true, latencyMs: performance.now() - started, operationId: `read:${config.profileName}:${config.workerId}:${sequence}`, startedAt, finishedAt: performance.timeOrigin + performance.now() });
        } catch (error) {
          const classified = classifyError(error);
          workerSend({ type: "operation", workerId: config.workerId, ok: false, latencyMs: performance.now() - started, errorType: classified.type, code: classified.code, message: classified.message, operationId: `read:${config.profileName}:${config.workerId}:${sequence}`, startedAt, finishedAt: performance.timeOrigin + performance.now() });
        }
        completed += 1;
      }
      workerSend({ type: "done", workerId: config.workerId, requestCount: completed, finishedAt: performance.timeOrigin + performance.now(), resource: sampleResources(config.dbPath) });
      store.close();
      if (typeof process.disconnect === "function") process.disconnect();
    });
  } catch (error) {
    const classified = classifyError(error);
    workerSend({ type: "worker_error", workerId: config?.workerId ?? null, code: classified.code, message: classified.message });
    process.exitCode = 1;
  }
}

function peakIntervalOverlap(intervals) {
  const events = intervals
    .filter((interval) => Number.isFinite(interval.startAt) && Number.isFinite(interval.finishedAt) && interval.finishedAt >= interval.startAt)
    .flatMap((interval) => [[interval.startAt, 1], [interval.finishedAt, -1]])
    .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of events) {
    active += delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function explicitMcpLoadRequested(argv) {
  return argv.some((argument) => argument === "--mcp-sessions" || argument.startsWith("--mcp-sessions="));
}

function createMcpAccumulator(requestedSessions) {
  return {
    requestedSessions,
    actualSessions: 0,
    initializedSessions: 0,
    requestCount: 0,
    successCount: 0,
    typedErrorCount: 0,
    rawLockErrorCount: 0,
    timeoutCount: 0,
    infrastructureErrorCount: 0,
    workerErrors: 0,
    latenciesMs: [],
    operationIntervals: [],
    errorsByType: {},
    errorSamples: [],
    operationIds: [],
    jobIds: [],
    sessionIntervals: [],
  };
}

function recordMcpLifecycleError(accumulator, error, operationId) {
  const classified = classifyError(error);
  const field = classified.type === "typed"
    ? "typedErrorCount"
    : classified.type === "raw_lock"
      ? "rawLockErrorCount"
      : classified.type === "timeout"
        ? "timeoutCount"
        : "infrastructureErrorCount";
  accumulator[field] += 1;
  accumulator.errorsByType[classified.type] = (accumulator.errorsByType[classified.type] ?? 0) + 1;
  if (classified.code) accumulator.errorsByType[`code:${classified.code}`] = (accumulator.errorsByType[`code:${classified.code}`] ?? 0) + 1;
  if (accumulator.errorSamples.length < 100) {
    accumulator.errorSamples.push({
      operationId,
      type: classified.type,
      code: classified.code ?? null,
      message: String(classified.message ?? "").slice(0, 300),
    });
  }
}

function mcpToolError(response) {
  if (response?.error) return response.error;
  if (response?.result?.isError !== true) return null;
  const structured = mcpStructured(response);
  return structured?.error ?? response.result.error ?? {
    code: "MCP_TOOL_CALL_FAILED",
    message: "MCP tool returned isError=true",
  };
}

async function closeMcpSession(session) {
  const child = session?.child;
  let closeError = null;
  try { await Promise.resolve(session?.close?.()); }
  catch (error) { closeError = error; }
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    if (closeError) throw closeError;
    return;
  }
  await new Promise((resolveClose) => {
    let timer;
    const complete = () => {
      clearTimeout(timer);
      child.off("exit", complete);
      resolveClose();
    };
    child.once("exit", complete);
    timer = setTimeout(complete, MCP_CLEANUP_TIMEOUT_MS);
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolveClose, rejectClose) => {
      let timer;
      const complete = () => {
        clearTimeout(timer);
        child.off("exit", complete);
        resolveClose();
      };
      child.once("exit", complete);
      timer = setTimeout(() => {
        child.off("exit", complete);
        rejectClose(Object.assign(new Error("MCP session did not exit after SIGKILL"), { code: "MCP_SESSION_CLEANUP_TIMEOUT" }));
      }, 500);
    });
  }
  if (closeError) throw closeError;
}

function mcpGate(accumulator, minimumRequests) {
  const latency = latencySummary(accumulator.latenciesMs);
  const condition = (status, observed, expected) => ({ status, observed, expected });
  const sampleReady = accumulator.requestCount >= minimumRequests;
  const conditions = {
    actualSessions: condition(accumulator.actualSessions === accumulator.requestedSessions ? "pass" : "fail", accumulator.actualSessions, accumulator.requestedSessions),
    initializedSessions: condition(accumulator.initializedSessions === accumulator.requestedSessions ? "pass" : "fail", accumulator.initializedSessions, accumulator.requestedSessions),
    sampleSize: condition(sampleReady ? "pass" : "insufficient_sample", accumulator.requestCount, minimumRequests),
    latencyP95: condition(sampleReady && Number.isFinite(latency.p95) ? (latency.p95 <= MCP_CALL_TIMEOUT_MS ? "pass" : "fail") : "insufficient_sample", latency.p95, MCP_CALL_TIMEOUT_MS),
    latencyP99: condition(sampleReady && Number.isFinite(latency.p99) ? (latency.p99 <= MCP_CALL_TIMEOUT_MS ? "pass" : "fail") : "insufficient_sample", latency.p99, MCP_CALL_TIMEOUT_MS),
    typedErrors: condition(accumulator.typedErrorCount === 0 ? "pass" : "fail", accumulator.typedErrorCount, 0),
    rawSqliteLocks: condition(accumulator.rawLockErrorCount === 0 ? "pass" : "fail", accumulator.rawLockErrorCount, 0),
    timeouts: condition(accumulator.timeoutCount === 0 ? "pass" : "fail", accumulator.timeoutCount, 0),
    infrastructureErrors: condition(accumulator.infrastructureErrorCount === 0 ? "pass" : "fail", accumulator.infrastructureErrorCount, 0),
    workerErrors: condition(accumulator.workerErrors === 0 ? "pass" : "fail", accumulator.workerErrors, 0),
    sessionOverlap: condition(accumulator.peakSessionOverlap >= accumulator.requestedSessions ? "pass" : "fail", accumulator.peakSessionOverlap, accumulator.requestedSessions),
  };
  const failed = Object.entries(conditions).filter(([, item]) => item.status === "fail").map(([name]) => `${name}_failed`);
  const insufficient = Object.entries(conditions).filter(([, item]) => item.status === "insufficient_sample").map(([name]) => `${name}_insufficient_sample`);
  return {
    status: failed.length ? "fail" : insufficient.length ? "insufficient_sample" : "pass",
    scope: "bounded_persistent_mcp_session_load",
    policy: { minimumRequests, p95Ms: MCP_CALL_TIMEOUT_MS, p99Ms: MCP_CALL_TIMEOUT_MS },
    conditions,
    reasons: [...failed, ...insufficient],
  };
}

function defaultMcpSessionFactory(config) {
  return new McpSession({
    node: config.node,
    server: config.server,
    cwd: config.cwd,
    env: config.env,
    label: `knowledge-stress-mcp-${config.sessionId}`,
    timeoutMs: MCP_CALL_TIMEOUT_MS,
  });
}

async function runMcpLoad({ rootPath, dbPath, ledgerPath, ledgerInitiallyEmpty, profile, options }) {
  const requestedSessions = profile.mcpSessions;
  const accumulator = createMcpAccumulator(requestedSessions);
  const usesRealSessionFactory = options.mcpSessionFactory === undefined;
  if (usesRealSessionFactory && !ledgerInitiallyEmpty) {
    throw Object.assign(new Error("real MCP load requires an absent or empty temporary ledger"), {
      code: "MCP_TEMP_LEDGER_REQUIRED",
    });
  }
  const paths = defaultProcessPaths(STRESS_ROOT);
  const disabledSemanticWakeLauncher = resolve(dbPath, "..", ".penguin-stress-semantic-wake-disabled");
  if (existsSync(disabledSemanticWakeLauncher)) {
    throw Object.assign(new Error(`MCP safety sentinel must not exist: ${disabledSemanticWakeLauncher}`), {
      code: "MCP_SEMANTIC_WAKE_DISABLE_UNPROVEN",
    });
  }
  const env = processEnv(STRESS_ROOT, {
    PENGUIN_KNOWLEDGE_DB: resolve(dbPath),
    PENGUIN_KNOWLEDGE_LEDGER: resolve(ledgerPath),
    PENGUIN_MCP_WORKSPACE_ROOTS: resolve(rootPath),
    PENGUIN_CLI_LAUNCHER: disabledSemanticWakeLauncher,
  });
  const sessionFactory = options.mcpSessionFactory ?? defaultMcpSessionFactory;
  const baseQuota = Math.floor(profile.maxRequests / requestedSessions);
  const remainder = profile.maxRequests % requestedSessions;
  let initializationSettled = 0;
  let resolveInitializationBarrier;
  const initializationBarrier = new Promise((resolveBarrier) => { resolveInitializationBarrier = resolveBarrier; });
  const markInitializationSettled = () => {
    initializationSettled += 1;
    if (initializationSettled === requestedSessions) resolveInitializationBarrier();
  };
  const workers = Array.from({ length: requestedSessions }, (_, sessionId) => (async () => {
    let session;
    let initialized = false;
    let initializationRecorded = false;
    const sessionInterval = { startAt: null, finishedAt: null };
    try {
      session = sessionFactory({
        sessionId,
        node: paths.node,
        server: paths.mcpBundle,
        cwd: STRESS_ROOT,
        env,
      });
      accumulator.actualSessions += 1;
      sessionInterval.startAt = performance.timeOrigin + performance.now();
      accumulator.sessionIntervals.push(sessionInterval);
      try {
        const initializeResponse = await session.initialize();
        if (initializeResponse?.error || !initializeResponse?.result) {
          throw initializeResponse?.error ?? Object.assign(new Error("MCP initialize returned no result"), { code: "MCP_INITIALIZE_FAILED" });
        }
        initialized = true;
        accumulator.initializedSessions += 1;
      } finally {
        initializationRecorded = true;
        markInitializationSettled();
      }
      await initializationBarrier;
      if (accumulator.initializedSessions !== requestedSessions) return;
      const quota = baseQuota + (sessionId < remainder ? 1 : 0);
      const deadline = Date.now() + profile.durationSeconds * 1_000;
      for (let sequence = 0; sequence < quota && Date.now() < deadline; sequence += 1) {
        const call = MCP_READ_ONLY_CALLS[(sequence + sessionId) % MCP_READ_ONLY_CALLS.length];
        const started = performance.now();
        const startedAt = performance.timeOrigin + started;
        try {
          const response = await session.callTool(call.name, call.arguments);
          const toolError = mcpToolError(response);
          if (toolError) throw toolError;
          recordOperation(accumulator, {
            ok: true,
            latencyMs: performance.now() - started,
            operationId: `mcp:${profile.name}:${sessionId}:${sequence}:${call.name}`,
            startedAt,
            finishedAt: performance.timeOrigin + performance.now(),
          });
        } catch (error) {
          const classified = classifyError(error);
          recordOperation(accumulator, {
            ok: false,
            latencyMs: performance.now() - started,
            errorType: classified.type,
            code: classified.code,
            message: classified.message,
            operationId: `mcp:${profile.name}:${sessionId}:${sequence}:${call.name}`,
            startedAt,
            finishedAt: performance.timeOrigin + performance.now(),
          });
          break;
        }
      }
    } catch (error) {
      accumulator.workerErrors += 1;
      recordMcpLifecycleError(accumulator, error, `mcp:${profile.name}:${sessionId}:${initialized ? "worker" : "initialize"}`);
    } finally {
      if (!initializationRecorded) markInitializationSettled();
      try {
        await closeMcpSession(session);
      } catch (error) {
        accumulator.workerErrors += 1;
        recordMcpLifecycleError(accumulator, error, `mcp:${profile.name}:${sessionId}:cleanup`);
      }
      if (sessionInterval.startAt !== null) sessionInterval.finishedAt = performance.timeOrigin + performance.now();
    }
  })());
  await Promise.all(workers);
  accumulator.peakSessionOverlap = peakIntervalOverlap(accumulator.sessionIntervals);
  const minimumRequests = Number.isInteger(options.mcpMinimumSampleRequests)
    ? options.mcpMinimumSampleRequests
    : Math.min(profile.maxRequests, MCP_MINIMUM_SAMPLE_REQUESTS);
  return {
    requestedSessions,
    actualSessions: accumulator.actualSessions,
    initializedSessions: accumulator.initializedSessions,
    requestCount: accumulator.requestCount,
    successCount: accumulator.successCount,
    typedErrorCount: accumulator.typedErrorCount,
    rawLockErrorCount: accumulator.rawLockErrorCount,
    timeoutCount: accumulator.timeoutCount,
    infrastructureErrorCount: accumulator.infrastructureErrorCount,
    workerErrors: accumulator.workerErrors,
    latencyMs: latencySummary(accumulator.latenciesMs),
    errorsByType: { ...accumulator.errorsByType },
    errorSamples: [...accumulator.errorSamples],
    peakSessionOverlap: accumulator.peakSessionOverlap,
    gate: mcpGate(accumulator, minimumRequests),
    safety: {
      productionDatabaseRequiresClone: true,
      emptyTemporaryLedgerRequired: true,
      schemaMutationDisabledByMcpStore: true,
      semanticWakeDisabled: true,
      semanticWakeLauncher: disabledSemanticWakeLauncher,
      databasePath: resolve(dbPath),
      ledgerPath: resolve(ledgerPath),
      ledgerInitiallyEmpty,
    },
  };
}

function skippedMcpLoad(profile) {
  return {
    requestedSessions: profile.mcpSessions,
    actualSessions: 0,
    initializedSessions: 0,
    requestCount: 0,
    successCount: 0,
    typedErrorCount: 0,
    rawLockErrorCount: 0,
    timeoutCount: 0,
    infrastructureErrorCount: 0,
    workerErrors: 0,
    latencyMs: latencySummary([]),
    errorsByType: {},
    errorSamples: [],
    peakSessionOverlap: 0,
    gate: {
      status: "insufficient_sample",
      scope: "bounded_persistent_mcp_session_load",
      policy: { minimumRequests: MCP_MINIMUM_SAMPLE_REQUESTS, p95Ms: MCP_CALL_TIMEOUT_MS, p99Ms: MCP_CALL_TIMEOUT_MS },
      conditions: {},
      reasons: ["mcp_sessions_not_explicitly_requested"],
    },
    safety: {
      productionDatabaseRequiresClone: true,
      emptyTemporaryLedgerRequired: true,
      schemaMutationDisabledByMcpStore: true,
      semanticWakeDisabled: false,
    },
  };
}

function failedMcpLoad(profile, error) {
  const report = skippedMcpLoad(profile);
  const classified = classifyError(error);
  report.workerErrors = 1;
  report[classified.type === "typed"
    ? "typedErrorCount"
    : classified.type === "raw_lock"
      ? "rawLockErrorCount"
      : classified.type === "timeout"
        ? "timeoutCount"
        : "infrastructureErrorCount"] = 1;
  report.errorsByType = { [classified.type]: 1 };
  report.errorSamples = [{
    operationId: "mcp:lane:setup",
    type: classified.type,
    code: classified.code ?? null,
    message: String(classified.message ?? "").slice(0, 300),
  }];
  report.gate = {
    status: "fail",
    scope: "bounded_persistent_mcp_session_load",
    policy: { minimumRequests: MCP_MINIMUM_SAMPLE_REQUESTS, p95Ms: MCP_CALL_TIMEOUT_MS, p99Ms: MCP_CALL_TIMEOUT_MS },
    conditions: {
      laneSetup: { status: "fail", observed: classified.code ?? classified.type, expected: "initialized" },
      workerErrors: { status: "fail", observed: 1, expected: 0 },
    },
    reasons: ["laneSetup_failed", "workerErrors_failed"],
  };
  return report;
}

function terminateReaderChildren(children) {
  for (const child of children) {
    try {
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill("SIGTERM");
    } catch {
      // A worker that already exited needs no further cleanup.
    }
  }
}

async function runReadWorkers({ scopes, profile, accumulator, resources, dbPath, ledgerPath }) {
  if (!scopes.length) {
    accumulator.gaps.push("no_ready_snapshot");
    accumulator.concurrency = { requested: profile.concurrentReaders, actualWorkerCount: 0, peakActiveWorkers: 0 };
    return;
  }
  const workerCount = Math.min(profile.concurrentReaders, profile.maxRequests);
  const baseQuota = Math.floor(profile.maxRequests / workerCount);
  const remainder = profile.maxRequests % workerCount;
  const scriptPath = fileURLToPath(import.meta.url);
  const children = [];
  const readyWorkers = new Set();
  const waitingWorkers = new Set();
  const completedWorkers = new Set();
  const workerIntervals = new Map();
  const quotas = Array.from({ length: workerCount }, (_, workerId) => baseQuota + (workerId < remainder ? 1 : 0));
  const startupTimeoutMs = Math.max(2_000, Math.min(30_000, profile.durationSeconds * 1_000 + 3_000));
  const durationMs = profile.durationSeconds * 1_000;
  let startAt = null;
  let settled = false;
  let resolveRun;
  const finished = new Promise((resolveRunPromise) => { resolveRun = resolveRunPromise; });
  const complete = () => {
    if (settled) return;
    settled = true;
    accumulator.actualWorkerCount = readyWorkers.size;
    accumulator.workerReadyCount = readyWorkers.size;
    accumulator.workerCompletedCount = completedWorkers.size;
    accumulator.peakActiveWorkers = peakIntervalOverlap([...workerIntervals.values()]);
    accumulator.peakActiveRequests = peakIntervalOverlap(accumulator.operationIntervals);
    accumulator.concurrency = {
      requested: profile.concurrentReaders,
      actualWorkerCount: readyWorkers.size,
      workerReadyCount: readyWorkers.size,
      workerCompletedCount: completedWorkers.size,
      peakActiveWorkers: accumulator.peakActiveWorkers,
      peakActiveRequests: accumulator.peakActiveRequests,
      actualRequestCount: accumulator.requestCount,
      requestedMaxRequests: profile.maxRequests,
    };
    resolveRun();
  };
  const startupTimer = setTimeout(() => {
    if (startAt === null) {
      accumulator.gaps.push(`reader_workers_startup_timeout:${readyWorkers.size}/${workerCount}`);
      accumulator.workerErrors += workerCount - readyWorkers.size;
      terminateReaderChildren(children);
      complete();
    }
  }, startupTimeoutMs);
  let hardTimer = null;
  const spawnWorker = (workerId) => {
    const child = fork(scriptPath, ["--load-worker"], {
      execArgv: filterWorkerExecArgv(process.execArgv),
      env: {
        ...process.env,
        PENGUIN_STRESS_WORKER_CONFIG: JSON.stringify({ dbPath, ledgerPath, profileName: profile.name, workerId, quota: quotas[workerId] }),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    child.on("message", (message) => {
      if (message?.type === "ready") {
        readyWorkers.add(message.workerId);
        if (message.resource) resources.push({ ...message.resource, workerId: message.workerId, processRole: "reader" });
        if (readyWorkers.size === workerCount) {
          clearTimeout(startupTimer);
          startAt = Date.now();
          hardTimer = setTimeout(() => {
            accumulator.gaps.push("reader_worker_hard_bound_reached");
            terminateReaderChildren(children);
            complete();
          }, durationMs + startupTimeoutMs + 5_000);
          for (const reader of children) {
            reader.send({ type: "start", durationMs });
          }
        }
      } else if (message?.type === "waiting") {
        waitingWorkers.add(message.workerId);
        if (waitingWorkers.size === workerCount) {
          const releaseAt = Date.now();
          for (const [workerId, reader] of children.entries()) {
            workerIntervals.set(workerId, { startAt: releaseAt, finishedAt: null });
            reader.send({ type: "release" });
          }
        }
      } else if (message?.type === "started") {
        if (!workerIntervals.has(message.workerId)) workerIntervals.set(message.workerId, { startAt: Date.now(), finishedAt: null });
      } else if (message?.type === "operation") {
        recordOperation(accumulator, message);
      } else if (message?.type === "done") {
        completedWorkers.add(message.workerId);
        const interval = workerIntervals.get(message.workerId);
        if (interval) interval.finishedAt = Date.now();
        if (message.resource) resources.push({ ...message.resource, workerId: message.workerId, processRole: "reader" });
        if (completedWorkers.size === workerCount) {
          clearTimeout(startupTimer);
          if (hardTimer) clearTimeout(hardTimer);
          complete();
        }
      } else if (message?.type === "worker_error") {
        accumulator.workerErrors += 1;
        accumulator.gaps.push(`reader_worker_error:${message.code ?? "unknown"}`);
      }
    });
    child.on("error", (error) => {
      accumulator.workerErrors += 1;
      accumulator.gaps.push(`reader_worker_process_error:${error.code ?? error.name ?? "unknown"}`);
    });
    child.on("exit", (code, signal) => {
      if (!completedWorkers.has(workerId) && !settled) {
        accumulator.workerErrors += 1;
        accumulator.gaps.push(`reader_worker_exit:${workerId}:${code ?? signal ?? "unknown"}`);
        completedWorkers.add(workerId);
        if (startAt !== null && completedWorkers.size === workerCount) {
          if (hardTimer) clearTimeout(hardTimer);
          complete();
        }
      }
    });
  };
  for (let workerId = 0; workerId < workerCount; workerId += 1) spawnWorker(workerId);
  await finished;
  clearTimeout(startupTimer);
  if (hardTimer) clearTimeout(hardTimer);
  terminateReaderChildren(children);
}

async function runWriters({ store, repositories, profile, accumulator, resources }) {
  if (profile.concurrentWriters < 1) return;
  if (!repositories.length) {
    accumulator.gaps.push("writer_profile_skipped:no_repository_discovered");
    return;
  }
  const tasks = Array.from({ length: profile.concurrentWriters }, (_, index) => (async () => {
    const rootPath = repositories[index % repositories.length];
    const started = performance.now();
    try {
      const report = await indexRepo({ store, rootPath, mode: "incremental", semantic: { enabled: false } });
      recordOperation(accumulator, {
        ok: true,
        latencyMs: performance.now() - started,
        operationId: `writer:${profile.name}:${index}`,
        jobId: `index:${report.repoId}:${report.branchId}`,
      });
    } catch (error) {
      const classified = classifyError(error);
      recordOperation(accumulator, {
        ok: false,
        latencyMs: performance.now() - started,
        errorType: classified.type,
        code: classified.code,
        message: classified.message,
        operationId: `writer:${profile.name}:${index}`,
      });
    } finally {
      resources.push(sampleResources(accumulator.databasePath));
    }
  })());
  await Promise.all(tasks);
}

async function runFaultProfile({ store, accumulator, resources }) {
  // C6 intentionally does not send SIGKILL to a user's live process/database.
  // C7 owns destructive crash injection. Here we prove the safe part: a fault
  // probe is classified, the DB remains checkable, and no claim is made about
  // process-kill recovery.
  accumulator.gaps.push("fault_profile_fixture_only:SIGKILL_recovery_is_C7_evidence");
  try {
    const integrity = assertDatabaseIntegrity(store);
    if (!integrity.ok) accumulator.gaps.push("fault_probe:integrity_failed");
  } catch (error) {
    const classified = classifyError(error);
    recordOperation(accumulator, { ok: false, errorType: classified.type, code: classified.code, message: classified.message, operationId: "fault:integrity" });
  }
  resources.push(sampleResources(accumulator.databasePath));
}

function profileConfig(name, options) {
  const defaults = PROFILE_DEFAULTS[name];
  return {
    name,
    durationSeconds: options.durationOverride ?? defaults.durationSeconds,
    concurrentReaders: options.concurrencyOverride ?? defaults.concurrentReaders,
    concurrentWriters: options.noWriters ? 0 : options.writerOverride ?? defaults.concurrentWriters,
    mcpSessions: options.sessionsOverride ?? defaults.mcpSessions,
    queryMix: Object.fromEntries(operationMix(name).map((operation) => [operation, 1])),
    rootPath: options.rootPath,
    maxRequests: options.maxRequestsOverride ?? defaults.maxRequests,
    writerRoots: options.writerRootsOverride,
  };
}

export async function runStressProfile({ rootPath, dbPath, ledgerPath, profileName, options = {}, argv = [] }) {
  const profile = profileConfig(profileName, { ...options, rootPath });
  const accumulator = createLoadAccumulator({ profile, rootPath, dbPath, argv });
  const resources = [sampleResources(dbPath)];
  let store;
  let integrity = null;
  let scopes = [];
  let repositories = [];
  const mcpRequested = explicitMcpLoadRequested(argv);
  const mcpLedgerInitiallyEmpty = !existsSync(ledgerPath) || statSync(ledgerPath).size === 0;
  let mcpReport = skippedMcpLoad(profile);
  try {
    store = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
    scopes = currentScopes(store);
    repositories = existsSync(`${rootPath}/.git`) ? [rootPath] : discoverFullCorpusRepositories(rootPath);
    if (!scopes.length) accumulator.gaps.push("no_ready_snapshot");
    if (profileName === "fault") await runFaultProfile({ store, accumulator, resources });
    const reads = runReadWorkers({ scopes, profile, accumulator, resources, dbPath, ledgerPath });
    const writerRepositories = profile.writerRoots?.length
      ? profile.writerRoots.map((candidate) => assertWorkspacePath(candidate, [rootPath], "stress writer root"))
      : repositories;
    const writers = profile.concurrentWriters > 0
      ? runWriters({ store, repositories: writerRepositories, profile, accumulator, resources })
      : Promise.resolve();
    const mcp = mcpRequested
      ? runMcpLoad({ rootPath, dbPath, ledgerPath, ledgerInitiallyEmpty: mcpLedgerInitiallyEmpty, profile, options }).catch((error) => failedMcpLoad(profile, error))
      : Promise.resolve(mcpReport);
    [, , mcpReport] = await Promise.all([reads, writers, mcp]);
    try {
      const statuses = listSemanticStatuses(store);
      const eligible = statuses.filter((status) => status.expected > 0);
      const unavailable = statuses.filter((status) => ["disabled", "stalled", "cancelled", "superseded"].includes(status.state));
      if (eligible.length === 0) accumulator.gaps.push("semantic_no_eligible_space_or_explicitly_unavailable");
      accumulator.semantic = { spaces: statuses.length, eligible: eligible.length, unavailable: unavailable.length, states: statuses.map((status) => ({ scopeKey: status.scopeKey, state: status.state, ready: status.ready, expected: status.expected })) };
    } catch (error) {
      const classified = classifyError(error);
      accumulator.semantic = { status: "unavailable", error: classified.code ?? classified.type };
      accumulator.gaps.push("semantic_status_unavailable");
    }
    integrity = assertDatabaseIntegrity(store);
  } catch (error) {
    const classified = classifyError(error);
    recordOperation(accumulator, { ok: false, errorType: classified.type, code: classified.code, message: classified.message, operationId: `profile:${profileName}:setup` });
    accumulator.gaps.push(`profile_setup_failed:${classified.code ?? classified.type}`);
  } finally {
    if (store) store.close();
    resources.push(sampleResources(dbPath));
  }
  const report = finalizeLoadReport(accumulator, {
    resources,
    integrity,
    gaps: profileName === "soak" && profile.durationSeconds < 60 ? ["short_fixture_soak_not_8_hours"] : [],
    mode: "fixture_or_explicit_corpus",
  });
  report.repositories = repositories;
  report.writerRepositories = profile.writerRoots?.length
    ? profile.writerRoots.map((candidate) => assertWorkspacePath(candidate, [rootPath], "stress writer root"))
    : repositories;
  report.semantic = accumulator.semantic ?? { status: "not_sampled" };
  report.execution = {
    readerTransport: "independent_node_processes",
    requestedMcpSessions: profile.mcpSessions,
    actualMcpSessions: mcpReport.actualSessions,
    mcpLoadExecuted: mcpRequested && mcpReport.actualSessions > 0,
    mcpLoadGate: mcpReport.gate.status,
  };
  if (!report.execution.mcpLoadExecuted) report.gaps.push("mcp_sessions_not_executed_by_reader_harness");
  report.mcp = mcpReport;
  report.workerErrors = accumulator.workerErrors;
  return report;
}

function dryRunReport(options) {
  const rootPath = options.rootPath ? resolve(options.rootPath) : null;
  return {
    reportVersion: LOAD_REPORT_VERSION,
    mode: "dry-run",
    profile: options.requestedProfiles,
    argv: options.argv,
    rootPath,
    databasePath: options.dbPath ? resolve(options.dbPath) : null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    reports: [],
    gaps: ["execution_disabled", "no_database_or_checkout_mutation_performed"],
    validRequestsPassed: false,
  };
}

export async function runStress(options) {
  if (!options.execute) return dryRunReport(options);
  const paths = requireExecuteInputs(options);
  const reports = [];
  for (const profileName of options.requestedProfiles) {
    reports.push(await runStressProfile({ ...paths, profileName, options, argv: options.argv }));
  }
  const report = {
    reportVersion: LOAD_REPORT_VERSION,
    mode: "execute",
    profile: options.requestedProfiles,
    argv: options.argv,
    rootPath: paths.rootPath,
    databasePath: paths.dbPath,
    startedAt: reports[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: reports.at(-1)?.finishedAt ?? new Date().toISOString(),
    reports,
    requestCount: reports.reduce((sum, item) => sum + item.requestCount, 0),
    successCount: reports.reduce((sum, item) => sum + item.successCount, 0),
    typedErrorCount: reports.reduce((sum, item) => sum + item.typedErrorCount, 0),
    rawLockErrorCount: reports.reduce((sum, item) => sum + item.rawLockErrorCount, 0),
    timeoutCount: reports.reduce((sum, item) => sum + item.timeoutCount, 0),
    infrastructureErrorCount: reports.reduce((sum, item) => sum + item.infrastructureErrorCount, 0),
    latencyMs: {
      count: reports.reduce((sum, item) => sum + (item.latencyMs?.count ?? 0), 0),
      // Child receipts keep only summaries, so a combined percentile cannot be
      // reconstructed exactly. Use the slowest profile as a conservative
      // aggregate and make p50 explicitly unavailable.
      p50: null,
      p95: reports.length ? Math.max(...reports.map((item) => item.latencyMs?.p95 ?? 0)) : null,
      p99: reports.length ? Math.max(...reports.map((item) => item.latencyMs?.p99 ?? 0)) : null,
      min: reports.length ? Math.min(...reports.map((item) => item.latencyMs?.min ?? 0)) : null,
      max: reports.length ? Math.max(...reports.map((item) => item.latencyMs?.max ?? 0)) : null,
    },
    resource: {
      samples: reports.flatMap((item) => item.resource?.samples ?? []),
      ...resourcePeaks(reports.flatMap((item) => item.resource?.samples ?? [])),
    },
    dbIntegrity: reports.every((item) => item.dbIntegrity === "ok")
      ? "ok"
      : reports.some((item) => item.dbIntegrity === "failed") ? "failed" : "not_checked",
    gaps: [...new Set(reports.flatMap((item) => item.gaps))],
    concurrency: {
      scope: "aggregate_profiles",
      profiles: reports.map((item) => ({
        name: item.profile?.name ?? null,
        requested: item.concurrency?.requested ?? null,
        actualWorkerCount: item.concurrency?.actualWorkerCount ?? 0,
        peakActiveWorkers: item.concurrency?.peakActiveWorkers ?? 0,
        peakActiveRequests: item.concurrency?.peakActiveRequests ?? 0,
        actualRequestCount: item.concurrency?.actualRequestCount ?? item.requestCount,
      })),
    },
    gate: {
      scope: "aggregate_profiles",
      status: reports.every((item) => item.gate?.status === "pass")
        ? "pass"
        : reports.some((item) => item.gate?.status === "fail") ? "fail" : "insufficient_sample",
      profiles: reports.map((item) => ({
        name: item.profile?.name ?? null,
        status: item.gate?.status ?? "not_observed",
        reasons: item.gate?.reasons ?? ["profile_gate_not_observed"],
      })),
    },
    validRequestsPassed: reports.every((item) => item.validRequestsPassed),
  };
  return report;
}

async function main() {
  let options;
  try { options = parseStressArgs(); }
  catch (error) {
    console.error(`knowledge-stress: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  let report;
  try { report = await runStress(options); }
  catch (error) {
    const classified = classifyError(error);
    report = { reportVersion: LOAD_REPORT_VERSION, mode: "failed", profile: options.requestedProfiles, argv: options.argv, error: classified, gaps: ["harness_failed_before_report"] };
    process.exitCode = 1;
  }
  if (options.reportPath) {
    try {
      const written = writeImmutableJson(options.reportPath, report);
      report.reportPath = written;
    } catch (error) {
      console.error(`knowledge-stress: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (options.json) console.log(JSON.stringify(report));
  else console.log(`knowledge-stress ${report.mode}: ${Array.isArray(report.profile) ? report.profile.join(",") : report.profile}; requests=${report.requestCount ?? 0}; rawLocks=${report.rawLockErrorCount ?? 0}; gaps=${report.gaps?.length ?? 0}`);
}

if (process.argv.includes("--load-worker")) await runReadWorkerProcess();
else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
