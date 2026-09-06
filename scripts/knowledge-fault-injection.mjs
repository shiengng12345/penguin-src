#!/usr/bin/env node
/**
 * Bounded crash-recovery harness for the indexer.
 *
 * The default is a dry-run. SIGKILL is only sent to a child process that was
 * started with explicit --root/--db/--ledger paths; the parent reopens that
 * database, checks SQLite, and runs one normal recovery index. Reports are
 * immutable when --report is supplied.
 */
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { KnowledgeStore, canonicalPathForCheck } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { assertDatabaseIntegrity, classifyError, writeImmutableJson } from "./knowledge-load-report.mjs";

export const FAULT_CHECKPOINTS = ["scan", "parse", "publish", "maintenance", "semantic"];
const MAX_CHECKPOINTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

function usageError(message) {
  return Object.assign(new Error(message), { code: "FAULT_ARGUMENT_INVALID", retryable: false });
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseFaultArgs(argv = process.argv.slice(2)) {
  const checkpointValue = optionValue(argv, "checkpoint") ?? "all";
  const checkpoints = checkpointValue === "all" ? [...FAULT_CHECKPOINTS] : checkpointValue.split(",").map((value) => value.trim()).filter(Boolean);
  if (!checkpoints.length || checkpoints.length > MAX_CHECKPOINTS || checkpoints.some((value) => !FAULT_CHECKPOINTS.includes(value))) {
    throw usageError(`--checkpoint must be one or more of ${FAULT_CHECKPOINTS.join(", ")} or all`);
  }
  const timeoutValue = optionValue(argv, "timeout-ms");
  const timeoutMs = timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw usageError("--timeout-ms must be an integer between 1000 and 120000");
  return {
    argv: [...argv],
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
    rootPath: optionValue(argv, "root"),
    dbPath: optionValue(argv, "db"),
    ledgerPath: optionValue(argv, "ledger"),
    reportPath: optionValue(argv, "report"),
    checkpoints,
    timeoutMs,
  };
}

function requireInputs(options) {
  if (!options.rootPath || !options.dbPath || !options.ledgerPath) throw usageError("--execute requires explicit --root, --db, and --ledger paths");
  const rootPath = canonicalPathForCheck(resolve(options.rootPath));
  const dbPath = resolve(options.dbPath);
  const ledgerPath = resolve(options.ledgerPath);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw usageError(`root does not exist or is not a directory: ${rootPath}`);
  if (!isAbsolute(dbPath) || !isAbsolute(ledgerPath)) throw usageError("--db and --ledger must be absolute paths");
  return { rootPath, dbPath, ledgerPath };
}

function childScript({ rootPath, dbPath, ledgerPath, checkpoint }) {
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const indexerUrl = new URL("../packages/knowledge-indexer/dist/index.js", import.meta.url).href;
  const space = {
    providerId: "fixture",
    modelId: "fault-injection",
    weightsDigest: "1".repeat(64),
    tokenizerDigest: "2".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "semantic-chunker-v1",
  };
  return `
    import { KnowledgeStore } from ${JSON.stringify(coreUrl)};
    import { indexRepo } from ${JSON.stringify(indexerUrl)};
    const checkpoint = ${JSON.stringify(checkpoint)};
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(dbPath)}, ledgerPath: ${JSON.stringify(ledgerPath)} });
    const kill = () => process.kill(process.pid, "SIGKILL");
    const hooks = {
      // Scan/parse are stage-entry boundaries. Semantic is intentionally
      // injected after its generation is enqueued below, so this harness
      // proves that a durable semantic job also survives an abrupt death.
      beforeStage: ({ stage }) => { if (checkpoint === stage && stage !== "semantic") kill(); },
      beforeSnapshotPublish: () => { if (checkpoint === "publish") kill(); },
      beforeMaintenance: () => { if (checkpoint === "maintenance") kill(); },
      afterSemanticEnqueue: () => { if (checkpoint === "semantic") kill(); },
    };
    await indexRepo({
      store,
      rootPath: ${JSON.stringify(rootPath)},
      mode: "rebuild",
      semantic: checkpoint === "semantic" ? { enabled: true, space: ${JSON.stringify(space)} } : { enabled: false },
      testHooks: hooks,
    });
    store.close();
  `;
}

function runKilledChild(input) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(input)], {
      cwd: input.rootPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null) child.kill("SIGKILL");
    }, input.timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, timedOut, stderr });
    });
  });
}

async function runCheckpoint(input) {
  const child = await runKilledChild(input);
  let store;
  const result = {
    checkpoint: input.checkpoint,
    childExitCode: child.code,
    childSignal: child.signal,
    timedOut: child.timedOut,
    stderr: child.stderr,
    integrityBeforeRecovery: null,
    recovery: null,
    integrityAfterRecovery: null,
    orphanWriterMarkersAfterRecovery: null,
    branchPointsToNonReadySnapshot: null,
    passed: false,
  };
  try {
    store = KnowledgeStore.open({ dbPath: input.dbPath, ledgerPath: input.ledgerPath, allowSchemaMutation: false });
    result.integrityBeforeRecovery = assertDatabaseIntegrity(store);
    result.branchPointsToNonReadySnapshot = Number(store.db.prepare(`
      SELECT COUNT(*) AS count
        FROM branches b JOIN revision_snapshots s ON s.id=b.current_snapshot_id
       WHERE s.state <> 'ready'
    `).get().count) === 0;
    try {
      const report = await indexRepo({ store, rootPath: input.rootPath, mode: "incremental", semantic: { enabled: false } });
      result.recovery = { ok: true, parsed: report.parsed, skipped: report.skipped, deleted: report.deleted, errors: report.errors, snapshotId: report.revisionTruth?.snapshotId ?? null };
    } catch (error) {
      const classified = classifyError(error);
      result.recovery = { ok: false, error: classified };
    }
    result.integrityAfterRecovery = assertDatabaseIntegrity(store);
    result.orphanWriterMarkersAfterRecovery = Number(store.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'index_lock::%'").get().count);
    result.passed = child.signal === "SIGKILL"
      && child.timedOut === false
      && result.integrityBeforeRecovery.ok
      && result.branchPointsToNonReadySnapshot
      && result.recovery?.ok === true
      && result.recovery.errors === 0
      && result.integrityAfterRecovery.ok
      && result.orphanWriterMarkersAfterRecovery === 0;
  } catch (error) {
    result.openError = classifyError(error);
  } finally {
    store?.close();
  }
  return result;
}

function dryRun(options) {
  return {
    reportVersion: 1,
    mode: "dry-run",
    profile: "fault",
    argv: options.argv,
    checkpoints: options.checkpoints,
    gaps: ["execution_disabled", "no_database_or_checkout_mutation_performed", "reset_sigkill_and_installed_session_remain_C7_gates"],
    results: [],
    valid: false,
  };
}

export async function runFaultInjection(options) {
  if (!options.execute) return dryRun(options);
  const paths = requireInputs(options);
  const results = [];
  for (const checkpoint of options.checkpoints) {
    results.push(await runCheckpoint({ ...paths, checkpoint, timeoutMs: options.timeoutMs }));
  }
  return {
    reportVersion: 1,
    mode: "execute",
    profile: "fault",
    argv: options.argv,
    rootPath: paths.rootPath,
    databasePath: paths.dbPath,
    checkpoints: options.checkpoints,
    results,
    gaps: ["reset_sigkill_not_run", "installed_fresh_session_not_run"],
    valid: results.length === options.checkpoints.length && results.every((result) => result.passed),
  };
}

async function main() {
  let options;
  try { options = parseFaultArgs(); }
  catch (error) { console.error(`knowledge-fault-injection: ${error.message}`); process.exitCode = 2; return; }
  let report;
  try { report = await runFaultInjection(options); }
  catch (error) { report = { reportVersion: 1, mode: "failed", profile: "fault", argv: options.argv, error: classifyError(error), valid: false }; process.exitCode = 1; }
  if (options.reportPath) {
    try { report.reportPath = writeImmutableJson(options.reportPath, report); }
    catch (error) { console.error(`knowledge-fault-injection: ${error.message}`); process.exitCode = 1; }
  }
  if (options.json) console.log(JSON.stringify(report));
  else console.log(`knowledge-fault-injection ${report.mode}: checkpoints=${report.checkpoints?.join(",") ?? ""}; passed=${report.valid === true}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
