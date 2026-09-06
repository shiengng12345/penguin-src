#!/usr/bin/env node
/**
 * Shared reporting primitives for the bounded Penguin heavy-use harness.
 *
 * This module intentionally has no Penguin database side effects. It only
 * measures the current process/files, classifies an operation result, and
 * writes an immutable JSON receipt when the caller asks it to.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const LOAD_REPORT_VERSION = 2;
export const RAW_LOCK_PATTERN = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|cannot start a transaction within a transaction/i;
export const TIMEOUT_PATTERN = /timed out|timeout|ETIMEDOUT|deadline exceeded|ABORT_ERR/i;
export const MIN_LOAD_GATE_REQUESTS = 100;
export const DEFAULT_LOAD_GATE_BUDGETS = Object.freeze({
  p95Ms: 2_000,
  p99Ms: 2_000,
  maxRssBytes: 2 * 1024 ** 3,
  maxFdDelta: 32,
  maxDiskGrowthBytes: 1024 ** 3,
});

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function percentile(values, requestedPercentile) {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const percentileValue = Math.max(0, Math.min(100, requestedPercentile));
  const index = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function latencySummary(latencies) {
  return {
    count: latencies.filter((value) => Number.isFinite(value)).length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: latencies.length ? Math.min(...latencies) : null,
    max: latencies.length ? Math.max(...latencies) : null,
  };
}

function errorCode(error) {
  if (!error || typeof error !== "object") return null;
  const code = error.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/**
 * Keep raw SQLite lock failures separate from typed operational errors. A
 * retryable `INDEX_WRITER_BUSY` is expected contention; a leaked
 * `SQLITE_BUSY` means the coordination contract failed.
 */
export function classifyError(error) {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (RAW_LOCK_PATTERN.test(`${code ?? ""} ${message}`)) return { type: "raw_lock", code, message };
  if (TIMEOUT_PATTERN.test(`${code ?? ""} ${message}`)) return { type: "timeout", code, message };
  if (code && /^[A-Z][A-Z0-9_.-]+$/u.test(code)) return { type: "typed", code, message };
  if (error && typeof error === "object" && (error.name === "Error" || error.name === "ErrorEvent")) {
    return { type: "typed", code, message };
  }
  return { type: "infrastructure", code, message };
}

function countFileDescriptors() {
  try { return readdirSync("/dev/fd").length; } catch { return null; }
}

function countThreads() {
  try {
    const value = execFileSync("/bin/ps", ["-o", "nlwp=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    // macOS has no /proc; a single Node process is the conservative fallback
    // when ps does not expose NLWP on a particular runner.
    return 1;
  }
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

export function databaseFileSizes(dbPath) {
  return {
    mainBytes: fileSize(dbPath),
    walBytes: fileSize(`${dbPath}-wal`),
    shmBytes: fileSize(`${dbPath}-shm`),
    totalBytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`),
  };
}

export function sampleResources(dbPath) {
  const memory = process.memoryUsage();
  const disk = dbPath ? databaseFileSizes(dbPath) : { mainBytes: 0, walBytes: 0, shmBytes: 0, totalBytes: 0 };
  return {
    sampledAt: new Date().toISOString(),
    rssBytes: finiteNumber(memory.rss),
    heapUsedBytes: finiteNumber(memory.heapUsed),
    externalBytes: finiteNumber(memory.external),
    diskBytes: disk.totalBytes,
    dbBytes: disk.mainBytes,
    walBytes: disk.walBytes,
    shmBytes: disk.shmBytes,
    fdCount: countFileDescriptors(),
    threadCount: countThreads(),
    cpu: process.resourceUsage ? process.resourceUsage() : null,
  };
}

export function resourcePeaks(samples) {
  const max = (key) => {
    const values = samples.map((sample) => sample?.[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
    return values.length ? Math.max(...values) : null;
  };
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  return {
    peakRssBytes: max("rssBytes"),
    peakDiskBytes: max("diskBytes"),
    peakWalBytes: max("walBytes"),
    fdStart: first.fdCount ?? null,
    fdEnd: last.fdCount ?? null,
    threadStart: first.threadCount ?? null,
    threadEnd: last.threadCount ?? null,
    rssStart: first.rssBytes ?? null,
    rssEnd: last.rssBytes ?? null,
    diskStart: first.diskBytes ?? null,
    diskEnd: last.diskBytes ?? null,
  };
}

export function assertDatabaseIntegrity(store) {
  const quick = store.db.pragma("quick_check")?.[0]?.quick_check ?? store.db.pragma("quick_check", { simple: true });
  const full = store.db.pragma("integrity_check")?.[0]?.integrity_check ?? store.db.pragma("integrity_check", { simple: true });
  return {
    quickCheck: String(quick ?? "unknown"),
    integrityCheck: String(full ?? "unknown"),
    ok: String(quick ?? "").toLowerCase() === "ok" && String(full ?? "").toLowerCase() === "ok",
  };
}

export function createLoadAccumulator({ profile, rootPath, dbPath, argv = [] }) {
  return {
    reportVersion: LOAD_REPORT_VERSION,
    mode: "fixture",
    profile,
    argv: [...argv],
    rootPath: rootPath ? resolve(rootPath) : null,
    databasePath: dbPath ? resolve(dbPath) : null,
    startedAt: new Date().toISOString(),
    requestCount: 0,
    successCount: 0,
    typedErrorCount: 0,
    rawLockErrorCount: 0,
    timeoutCount: 0,
    infrastructureErrorCount: 0,
    latenciesMs: [],
    errorsByType: {},
    errorSamples: [],
    operationIds: [],
    jobIds: [],
    actualWorkerCount: 0,
    workerReadyCount: 0,
    workerCompletedCount: 0,
    peakActiveWorkers: 0,
    peakActiveRequests: 0,
    workerErrors: 0,
    operationIntervals: [],
    resourceSamples: [],
    gaps: [],
  };
}

export function recordOperation(accumulator, operation) {
  accumulator.requestCount += 1;
  if (Number.isFinite(operation.latencyMs)) accumulator.latenciesMs.push(operation.latencyMs);
  if (Number.isFinite(operation.startedAt) && Number.isFinite(operation.finishedAt) && operation.finishedAt >= operation.startedAt) {
    accumulator.operationIntervals.push({ startAt: operation.startedAt, finishedAt: operation.finishedAt });
  }
  if (operation.operationId) accumulator.operationIds.push(operation.operationId);
  if (operation.jobId) accumulator.jobIds.push(operation.jobId);
  if (operation.ok) {
    accumulator.successCount += 1;
    return;
  }
  const classified = operation.errorType ? { type: operation.errorType, code: operation.code ?? null, message: operation.message ?? "" } : classifyError(operation.error);
  const bucket = classified.type;
  accumulator.errorsByType[bucket] = (accumulator.errorsByType[bucket] ?? 0) + 1;
  if (bucket === "typed") accumulator.typedErrorCount += 1;
  else if (bucket === "raw_lock") accumulator.rawLockErrorCount += 1;
  else if (bucket === "timeout") accumulator.timeoutCount += 1;
  else accumulator.infrastructureErrorCount += 1;
  if (classified.code) accumulator.errorsByType[`code:${classified.code}`] = (accumulator.errorsByType[`code:${classified.code}`] ?? 0) + 1;
  if (accumulator.errorSamples.length < 100) {
    accumulator.errorSamples.push({
      operationId: operation.operationId ?? null,
      type: classified.type,
      code: classified.code ?? null,
      message: String(classified.message ?? "").slice(0, 300),
    });
  }
}

function condition(status, observed, expected, details = {}) {
  return { status, observed, expected, ...details };
}

function intervalOverlap(intervals) {
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

function gateConditionStatus(conditions) {
  const values = Object.values(conditions).map((item) => item.status);
  if (values.includes("fail")) return "fail";
  if (values.includes("insufficient_sample") || values.includes("not_observed")) return "insufficient_sample";
  return "pass";
}

export function evaluateLoadGate({ profile = {}, requestCount, latency, rawLockErrorCount, timeoutCount, infrastructureErrorCount, workerErrors = 0, integrity, resources = [], concurrency = {} } = {}) {
  const budgets = {
    ...DEFAULT_LOAD_GATE_BUDGETS,
    ...(profile?.loadGateBudgets ?? {}),
  };
  const minimumRequests = Number.isInteger(profile?.minimumSampleRequests)
    ? profile.minimumSampleRequests
    : MIN_LOAD_GATE_REQUESTS;
  const requestedConcurrency = Number.isInteger(profile?.concurrentReaders) ? profile.concurrentReaders : null;
  const configuredMaxRequests = Number.isInteger(profile?.maxRequests) ? profile.maxRequests : null;
  const requiredConcurrentWorkers = requestedConcurrency == null || configuredMaxRequests == null
    ? requestedConcurrency
    : Math.min(requestedConcurrency, configuredMaxRequests);
  const actualWorkerCount = Number.isInteger(concurrency.actualWorkerCount) ? concurrency.actualWorkerCount : 0;
  const peakActiveWorkers = Number.isInteger(concurrency.peakActiveWorkers) ? concurrency.peakActiveWorkers : 0;
  const peakActiveRequests = Number.isInteger(concurrency.peakActiveRequests) ? concurrency.peakActiveRequests : 0;
  const sampleStatus = requestCount >= minimumRequests ? "pass" : "insufficient_sample";
  const sampleReason = sampleStatus === "pass" ? null : "sample_count_below_minimum";
  const p95Status = Number.isFinite(latency?.p95) && requestCount >= minimumRequests
    ? (latency.p95 <= budgets.p95Ms ? "pass" : "fail")
    : "insufficient_sample";
  const p99Status = Number.isFinite(latency?.p99) && requestCount >= minimumRequests
    ? (latency.p99 <= budgets.p99Ms ? "pass" : "fail")
    : "insufficient_sample";
  const requiredRequestOverlap = requiredConcurrentWorkers == null ? null : Math.min(2, requiredConcurrentWorkers);
  const concurrencyObserved = requiredConcurrentWorkers == null
    ? false
    : actualWorkerCount >= requiredConcurrentWorkers
      && peakActiveWorkers >= requiredConcurrentWorkers;
  const concurrencyStatus = requiredConcurrentWorkers == null
    ? "not_observed"
    : actualWorkerCount === 0 || peakActiveWorkers === 0
      ? "not_observed"
      : concurrencyObserved ? "pass" : "fail";
  const firstResource = resources[0] ?? {};
  const lastResource = resources.at(-1) ?? {};
  const fdDelta = Number.isFinite(firstResource.fdCount) && Number.isFinite(lastResource.fdCount)
    ? Math.abs(lastResource.fdCount - firstResource.fdCount)
    : null;
  const diskGrowthBytes = Number.isFinite(firstResource.diskBytes) && Number.isFinite(lastResource.diskBytes)
    ? Math.max(0, lastResource.diskBytes - firstResource.diskBytes)
    : null;
  const peakRssBytes = resources
    .map((sample) => sample?.rssBytes)
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  const resourceObserved = resources.length >= 2 && peakRssBytes > 0 && fdDelta != null && diskGrowthBytes != null;
  const resourceWithinBudget = resourceObserved
    && peakRssBytes <= budgets.maxRssBytes
    && fdDelta <= budgets.maxFdDelta
    && diskGrowthBytes <= budgets.maxDiskGrowthBytes;
  const conditions = {
    sampleSize: condition(sampleStatus, requestCount, minimumRequests, sampleReason ? { reason: sampleReason } : {}),
    latencyP95: condition(p95Status, latency?.p95 ?? null, budgets.p95Ms, { unit: "ms" }),
    latencyP99: condition(p99Status, latency?.p99 ?? null, budgets.p99Ms, { unit: "ms" }),
    concurrency: condition(concurrencyStatus, {
      actualWorkerCount,
      peakActiveWorkers,
      peakActiveRequests,
    }, requiredConcurrentWorkers, {
      requestedConcurrency,
      actualRequestCount: requestCount,
      requiredRequestOverlap,
      requestOverlapStatus: requiredRequestOverlap == null || requiredRequestOverlap <= 1
        ? "not_required"
        : peakActiveRequests >= requiredRequestOverlap ? "observed" : "not_observed_fast_operations",
    }),
    rawSqliteLocks: condition(rawLockErrorCount === 0 ? "pass" : "fail", rawLockErrorCount, 0),
    timeouts: condition(timeoutCount === 0 ? "pass" : "fail", timeoutCount, 0),
    infrastructureErrors: condition(infrastructureErrorCount === 0 ? "pass" : "fail", infrastructureErrorCount, 0),
    workerProcessErrors: condition(workerErrors === 0 ? "pass" : "fail", workerErrors, 0),
    integrity: condition(integrity?.ok === true ? "pass" : integrity ? "fail" : "not_observed", integrity?.ok ?? null, true),
    resources: condition(resourceObserved ? (resourceWithinBudget ? "pass" : "fail") : "not_observed", {
      sampleCount: resources.length,
      peakRssBytes: resourceObserved ? peakRssBytes : null,
      fdDelta,
      diskGrowthBytes,
    }, {
      maxRssBytes: budgets.maxRssBytes,
      maxFdDelta: budgets.maxFdDelta,
      maxDiskGrowthBytes: budgets.maxDiskGrowthBytes,
    }),
  };
  const reasons = [];
  for (const [name, item] of Object.entries(conditions)) {
    if (item.status === "fail") reasons.push(`${name}_failed`);
    if (item.status === "insufficient_sample") reasons.push(`${name}_insufficient_sample`);
    if (item.status === "not_observed") reasons.push(`${name}_not_observed`);
    if (item.reason) reasons.push(item.reason);
  }
  return {
    status: gateConditionStatus(conditions),
    scope: "bounded_concurrent_reader_load",
    policy: {
      minimumRequests,
      budgets,
      requiredConcurrentWorkers,
    },
    conditions,
    reasons,
  };
}

export function finalizeLoadReport(accumulator, { resources = [], integrity = null, gaps = [], mode = "fixture", finishedAt = new Date().toISOString() } = {}) {
  const peak = resourcePeaks(resources);
  const latencies = latencySummary(accumulator.latenciesMs);
  const concurrency = {
    requested: accumulator.profile?.concurrentReaders ?? null,
    actualWorkerCount: accumulator.actualWorkerCount ?? 0,
    workerReadyCount: accumulator.workerReadyCount ?? 0,
    workerCompletedCount: accumulator.workerCompletedCount ?? 0,
    peakActiveWorkers: accumulator.peakActiveWorkers ?? 0,
    peakActiveRequests: accumulator.peakActiveRequests ?? 0,
    actualRequestCount: accumulator.requestCount,
    requestedMaxRequests: accumulator.profile?.maxRequests ?? null,
  };
  const gate = evaluateLoadGate({
    profile: accumulator.profile,
    requestCount: accumulator.requestCount,
    latency: latencies,
    rawLockErrorCount: accumulator.rawLockErrorCount,
    timeoutCount: accumulator.timeoutCount,
    infrastructureErrorCount: accumulator.infrastructureErrorCount,
    workerErrors: accumulator.workerErrors,
    integrity,
    resources,
    concurrency,
  });
  const report = {
    reportVersion: accumulator.reportVersion,
    mode,
    profile: accumulator.profile,
    argv: accumulator.argv,
    rootPath: accumulator.rootPath,
    databasePath: accumulator.databasePath,
    startedAt: accumulator.startedAt,
    finishedAt,
    requestCount: accumulator.requestCount,
    successCount: accumulator.successCount,
    typedErrorCount: accumulator.typedErrorCount,
    rawLockErrorCount: accumulator.rawLockErrorCount,
    timeoutCount: accumulator.timeoutCount,
    infrastructureErrorCount: accumulator.infrastructureErrorCount,
    latencyMs: latencies,
    errorsByType: { ...accumulator.errorsByType },
    errorSamples: [...accumulator.errorSamples],
    operationIds: [...new Set(accumulator.operationIds)],
    jobIds: [...new Set(accumulator.jobIds)],
    resource: {
      samples: resources,
      ...peak,
    },
    dbIntegrity: integrity?.ok ? "ok" : integrity ? "failed" : "not_checked",
    integrity,
    gaps: [...new Set([...accumulator.gaps, ...gaps])],
    concurrency,
    gate,
    validRequestsPassed: gate.status === "pass",
  };
  return report;
}

/** Write once and fail if a previous report exists; never truncate/overwrite. */
export function writeImmutableJson(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(target, "wx", 0o600);
    writeSync(fd, payload, undefined, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(new Error(`LOAD_REPORT_EXISTS:${target}`), { code: "LOAD_REPORT_EXISTS", retryable: false, details: { path: target } });
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return target;
}

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function smokeReportShape(report) {
  return Boolean(report)
    && report.reportVersion === LOAD_REPORT_VERSION
    && (typeof report.profile === "string" || Array.isArray(report.profile) || (report.profile && typeof report.profile === "object"))
    && Number.isInteger(report.requestCount)
    && report.requestCount >= 0
    && Number.isInteger(report.successCount)
    && report.successCount >= 0
    && typeof report.latencyMs === "object"
    && Object.hasOwn(report.latencyMs, "p50")
    && Object.hasOwn(report.latencyMs, "p95")
    && Object.hasOwn(report.latencyMs, "p99")
    && typeof report.dbIntegrity === "string"
    && Array.isArray(report.gaps)
    && typeof report.concurrency === "object"
    && typeof report.gate === "object";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: knowledge-load-report.mjs <report.json>");
    process.exit(2);
  }
  const report = readJson(input);
  console.log(JSON.stringify({ valid: smokeReportShape(report), profile: report.profile, requestCount: report.requestCount, dbIntegrity: report.dbIntegrity }, null, 2));
}
