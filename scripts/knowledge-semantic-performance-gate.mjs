#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const localRequire = createRequire(resolve(dirname(new URL(import.meta.url).pathname), "..", "packages", "knowledge-core", "package.json"));
const BETTER_SQLITE3_ENTRY = localRequire.resolve("better-sqlite3");
const DEFAULTS = Object.freeze({
  baselineSamples: 30, activeSamples: 30, sampleIntervalMs: 250, samplerIntervalMs: 10,
  timeoutMs: 2 * 60 * 60 * 1000, cleanupTimeoutMs: 10_000, queryTimeoutMs: 30_000,
  maximumP95IncreaseRatio: 0.20, maximumPeakRssBytes: 2 * GIB, maximumMainDbBytes: 16 * GIB,
  maximumPeakWalBytes: 512 * MIB, maximumFinalWalBytes: 64 * MIB,
  maximumSemanticStorageAmplification: 12, minimumChunksPerSecond: 0.10,
});

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const allowed = new Set([
    "db", "repo", "launcher", "runtime-manifest", "clone-provenance", "output", "graph-target", "lexical-query", "execute",
    "baseline-samples", "active-samples", "sample-interval-ms", "sampler-interval-ms", "timeout-ms",
    "cleanup-timeout-ms", "query-timeout-ms", "max-p95-increase-ratio", "max-peak-rss-bytes",
    "max-main-db-bytes", "max-peak-wal-bytes", "max-final-wal-bytes", "max-semantic-amplification",
    "min-chunks-per-second",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (!argument.startsWith("--")) throw new Error(`INVALID_ARGUMENT: unexpected positional argument ${argument}`);
    const equals = argument.indexOf("=");
    if (equals > 2) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  for (const name of [...values.keys(), ...flags]) {
    if (!allowed.has(name)) throw new Error(`INVALID_ARGUMENT: unknown option --${name}`);
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`INVALID_ARGUMENT: --${name} is required`);
    return value;
  };
  const number = (name, fallback, { integer = false, minimum = 0, exclusiveMinimum = false } = {}) => {
    const raw = values.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    const outside = exclusiveMinimum ? value <= minimum : value < minimum;
    if (!Number.isFinite(value) || outside || (integer && !Number.isInteger(value))) {
      throw new Error(`INVALID_ARGUMENT: --${name} must be ${integer ? "an integer" : "a number"} ${exclusiveMinimum ? ">" : ">="} ${minimum}`);
    }
    return value;
  };
  return {
    execute: flags.has("execute"), dbPath: resolve(required("db")), repo: required("repo"),
    launcherPath: resolve(values.get("launcher") ?? resolve(homedir(), ".local", "bin", "penguin")),
    runtimeManifestPath: resolve(values.get("runtime-manifest") ?? resolve(homedir(), ".penguin", "runtimes", "current", "manifest.json")),
    cloneProvenancePath: values.has("clone-provenance") ? resolve(values.get("clone-provenance")) : null,
    outputPath: values.has("output") ? resolve(values.get("output")) : null,
    graphTarget: values.get("graph-target") ?? null, lexicalQuery: values.get("lexical-query") ?? null,
    thresholds: {
      minimumBaselineSamples: number("baseline-samples", DEFAULTS.baselineSamples, { integer: true, minimum: 1 }),
      minimumActiveSamples: number("active-samples", DEFAULTS.activeSamples, { integer: true, minimum: 1 }),
      sampleIntervalMs: number("sample-interval-ms", DEFAULTS.sampleIntervalMs, { integer: true, minimum: 0 }),
      samplerIntervalMs: number("sampler-interval-ms", DEFAULTS.samplerIntervalMs, { integer: true, minimum: 1 }),
      timeoutMs: number("timeout-ms", DEFAULTS.timeoutMs, { integer: true, minimum: 1 }),
      cleanupTimeoutMs: number("cleanup-timeout-ms", DEFAULTS.cleanupTimeoutMs, { integer: true, minimum: 1 }),
      queryTimeoutMs: number("query-timeout-ms", DEFAULTS.queryTimeoutMs, { integer: true, minimum: 1 }),
      maximumP95IncreaseRatio: number("max-p95-increase-ratio", DEFAULTS.maximumP95IncreaseRatio, { minimum: 0 }),
      maximumPeakRssBytes: number("max-peak-rss-bytes", DEFAULTS.maximumPeakRssBytes, { minimum: 1 }),
      maximumMainDbBytes: number("max-main-db-bytes", DEFAULTS.maximumMainDbBytes, { minimum: 1 }),
      maximumPeakWalBytes: number("max-peak-wal-bytes", DEFAULTS.maximumPeakWalBytes, { minimum: 0 }),
      maximumFinalWalBytes: number("max-final-wal-bytes", DEFAULTS.maximumFinalWalBytes, { minimum: 0 }),
      maximumSemanticStorageAmplification: number("max-semantic-amplification", DEFAULTS.maximumSemanticStorageAmplification, { minimum: 0, exclusiveMinimum: true }),
      minimumChunksPerSecond: number("min-chunks-per-second", DEFAULTS.minimumChunksPerSecond, { minimum: 0, exclusiveMinimum: true }),
    },
  };
}

function quoteSql(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function sha256Json(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function verifyCloneProvenance(options, identity, runtimeManifest) {
  if (!options.cloneProvenancePath) throw new Error("CLONE_PROVENANCE_REQUIRED: --clone-provenance is required with --execute");
  if (!existsSync(options.cloneProvenancePath)) throw new Error(`CLONE_PROVENANCE_NOT_FOUND: ${options.cloneProvenancePath}`);
  let artifact;
  try { artifact = JSON.parse(readFileSync(options.cloneProvenancePath, "utf8")); }
  catch (error) { throw new Error(`CLONE_PROVENANCE_INVALID: ${error.message}`); }
  const { artifactDigest, ...payload } = artifact ?? {};
  if (!/^[a-f0-9]{64}$/iu.test(artifactDigest ?? "") || sha256Json(payload) !== String(artifactDigest).toLowerCase()) {
    throw new Error("CLONE_PROVENANCE_DIGEST_MISMATCH: artifact content does not match artifactDigest");
  }
  if (artifact.schemaVersion !== 1 || artifact.kind !== "penguin-semantic-performance-clone" || artifact.status !== "READY") {
    throw new Error("CLONE_PROVENANCE_INVALID: artifact is not a ready semantic performance clone");
  }
  const clonePath = artifact.clone?.path;
  const sourcePath = artifact.source?.path;
  if (typeof clonePath !== "string" || !existsSync(clonePath) || !sameRealPath(clonePath, options.dbPath)) {
    throw new Error("CLONE_PROVENANCE_TARGET_MISMATCH: artifact clone path is not the execution database");
  }
  const dbStat = statSync(options.dbPath);
  const sourceMatchesTarget = typeof sourcePath !== "string" || resolve(sourcePath) === resolve(clonePath)
    || (Number(artifact.source?.dev) === Number(dbStat.dev) && Number(artifact.source?.ino) === Number(dbStat.ino));
  if (sourceMatchesTarget) throw new Error("CLONE_PROVENANCE_SOURCE_TARGET_COLLISION: execution database is identified as the source database");
  if (artifact.source?.logicalHashBefore !== artifact.source?.logicalHashAfter
    || artifact.source?.logicalHashBefore !== artifact.clone?.backupLogicalHash) {
    throw new Error("CLONE_PROVENANCE_SOURCE_CHANGED: source and backup logical hashes are not identical");
  }
  if (artifact.clone?.quickCheck !== "ok" || artifact.clone?.integrityCheck !== "ok"
    || artifact.clone?.backupIncludedWalState !== true
    || artifact.safety?.sourceOpenedReadOnly !== true || artifact.safety?.targetWasAbsent !== true
    || artifact.safety?.sourceAndTargetDistinct !== true || artifact.safety?.stagingCreatedOnlyOnClone !== true) {
    throw new Error("CLONE_PROVENANCE_SAFETY_UNPROVEN: clone integrity or safety evidence is incomplete");
  }
  const workloadMatches = artifact.workload?.repoId === identity.repo.id
    && artifact.workload?.repoName === identity.repo.name
    && artifact.workload?.scopeKey === identity.scopeKey
    && artifact.workload?.generationId === identity.generation.id
    && Number(artifact.workload?.expectedChunks) === Number(identity.generation.expected);
  if (!workloadMatches) throw new Error("CLONE_PROVENANCE_WORKLOAD_MISMATCH: artifact workload does not match the selected generation");
  const runtimeMatches = artifact.runtime?.buildId === runtimeManifest.buildId
    && artifact.runtime?.capabilityHash === runtimeManifest.capabilityHash
    && Number(artifact.runtime?.schemaVersion) === Number(runtimeManifest.schemaVersion)
    && artifact.runtime?.modelHash === runtimeManifest.modelHash
    && artifact.runtime?.manifestSha256 === runtimeManifest.manifestSha256;
  if (!runtimeMatches) throw new Error("CLONE_PROVENANCE_RUNTIME_MISMATCH: artifact runtime does not match the selected manifest");
  const actualDbHash = await sha256File(options.dbPath);
  if (actualDbHash !== String(artifact.clone?.sha256 ?? "").toLowerCase()) {
    throw new Error("CLONE_PROVENANCE_DB_HASH_MISMATCH: execution database bytes changed after clone artifact creation");
  }
  return {
    path: options.cloneProvenancePath, artifactDigest: String(artifactDigest).toLowerCase(),
    cloneSha256: actualDbHash, source: artifact.source, clone: artifact.clone,
    workload: artifact.workload, runtime: artifact.runtime, safety: artifact.safety,
  };
}

function runProcess(command, args, options = {}) {
  // A synchronous launcher timeout must not wait for a child that ignores
  // SIGTERM or leaves a descendant holding stdio open. SIGKILL makes the
  // measurement deadline an actual upper bound under host load.
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * MIB, killSignal: "SIGKILL", ...options });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`MEASUREMENT_TIMEOUT: ${command} exceeded the remaining measurement time`);
  if (result.error) throw new Error(`PROCESS_UNAVAILABLE: ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`PROCESS_FAILED: ${command} ${args.join(" ")}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  return result.stdout;
}

function safeProcess(command, args) {
  try { return { ok: true, stdout: runProcess(command, args) }; }
  catch (error) { return { ok: false, stdout: "", error: String(error.message) }; }
}

function sqliteRows(dbPath, sql) {
  const output = runProcess("sqlite3", ["-readonly", "-cmd", ".timeout 5000", "-json", dbPath, sql]);
  if (!output.trim()) return [];
  try {
    const rows = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error("not an array");
    return rows;
  } catch (error) { throw new Error(`SQLITE_OUTPUT_INVALID: ${error.message}`); }
}

function fileBytes(path) { try { return statSync(path).size; } catch { return 0; } }

function normalizeGeneration(row) {
  return {
    id: String(row.id), scopeKey: String(row.scopeKey), status: String(row.status),
    expected: Number(row.expected), ready: Number(row.ready), running: Number(row.running),
    pending: Number(row.pending), failed: Number(row.failed), terminal: Number(row.terminal),
    modelHash: row.modelHash == null ? null : String(row.modelHash),
  };
}

function databaseIdentity(dbPath, repoName) {
  const repos = sqliteRows(dbPath, `
    SELECT id,name,root_path AS rootPath FROM repos
     WHERE id=${quoteSql(repoName)} OR name=${quoteSql(repoName)} COLLATE NOCASE
     ORDER BY CASE WHEN name=${quoteSql(repoName)} THEN 0 ELSE 1 END,id;
  `);
  if (repos.length === 0) throw new Error(`REPOSITORY_NOT_FOUND: ${repoName}`);
  if (repos.length > 1) throw new Error(`REPOSITORY_AMBIGUOUS: ${repoName}`);
  const repo = repos[0];
  const scopeKey = `repo:${repo.id}`;
  const generations = sqliteRows(dbPath, `
    SELECT g.id,g.scope_key AS scopeKey,g.status,g.expected_chunks AS expected,s.identity_hash AS modelHash,
           COALESCE(SUM(j.status='ready'),0) AS ready,COALESCE(SUM(j.status='running'),0) AS running,
           COALESCE(SUM(j.status='pending'),0) AS pending,COALESCE(SUM(j.status='failed'),0) AS failed,
           COALESCE(SUM(j.status='failed' AND j.attempts>=5),0) AS terminal
      FROM embedding_generations g JOIN embedding_spaces s ON s.id=g.space_id
      LEFT JOIN embedding_jobs j ON j.generation_id=g.id
     WHERE g.scope_key=${quoteSql(scopeKey)} AND g.status IN ('staging','active') GROUP BY g.id
     ORDER BY CASE g.status WHEN 'staging' THEN 0 ELSE 1 END,g.rowid DESC LIMIT 1;
  `);
  if (generations.length === 0) throw new Error(`REAL_GENERATION_REQUIRED: no staging or active generation for ${repo.name}`);
  const targetRows = sqliteRows(dbPath, `
    SELECT id,title FROM nodes WHERE repo_id=${quoteSql(repo.id)}
     ORDER BY CASE node_type WHEN 'symbol' THEN 0 WHEN 'method' THEN 1 ELSE 2 END,LENGTH(title) DESC,id LIMIT 1;
  `);
  if (targetRows.length === 0) throw new Error(`QUERY_FIXTURE_UNAVAILABLE: no graph node for ${repo.name}`);
  return { repo, scopeKey, generation: normalizeGeneration(generations[0]), graphTarget: targetRows[0].id, lexicalQuery: targetRows[0].title };
}

function generationSnapshot(dbPath, generationId) {
  const rows = sqliteRows(dbPath, `
    SELECT g.id,g.scope_key AS scopeKey,g.status,g.expected_chunks AS expected,s.identity_hash AS modelHash,
           COALESCE(SUM(j.status='ready'),0) AS ready,COALESCE(SUM(j.status='running'),0) AS running,
           COALESCE(SUM(j.status='pending'),0) AS pending,COALESCE(SUM(j.status='failed'),0) AS failed,
           COALESCE(SUM(j.status='failed' AND j.attempts>=5),0) AS terminal
      FROM embedding_generations g JOIN embedding_spaces s ON s.id=g.space_id
      LEFT JOIN embedding_jobs j ON j.generation_id=g.id
     WHERE g.id=${quoteSql(generationId)} GROUP BY g.id;
  `);
  if (rows.length !== 1) throw new Error(`GENERATION_DISAPPEARED: ${generationId}`);
  return normalizeGeneration(rows[0]);
}

function launcherJson(options, args, timeoutMs = options.thresholds.queryTimeoutMs) {
  const stdout = runProcess(options.launcherPath, args, {
    cwd: process.cwd(), env: { ...process.env, PENGUIN_KNOWLEDGE_DB: options.dbPath }, timeout: Math.max(1, Math.floor(timeoutMs)),
  });
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  try { return JSON.parse(lines.at(-1) ?? ""); }
  catch (error) { throw new Error(`LAUNCHER_JSON_INVALID: ${args.join(" ")}: ${error.message}`); }
}

function semanticStatus(options, timeoutMs = options.thresholds.queryTimeoutMs) {
  const response = launcherJson(options, ["semantic", "status", "--scope", options.repo, "--json"], timeoutMs);
  const statuses = Array.isArray(response?.statuses) ? response.statuses : [];
  const status = statuses.find((candidate) => candidate.generationId === options.generationId)
    ?? statuses.find((candidate) => candidate.scopeKey === options.scopeKey);
  if (!status) throw new Error(`SEMANTIC_STATUS_MISSING: ${options.generationId}`);
  return status;
}

function validateGraphResponse(options, result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.nodes) || !Array.isArray(result.edges)
    || typeof result.focus !== "string" || result.focus !== options.graphTarget) {
    throw new Error("GRAPH_QUERY_INVALID: response must contain the requested focus plus nodes and edges arrays");
  }
  if (result.scope?.repoId !== options.repoId) {
    throw new Error(`GRAPH_QUERY_SCOPE_MISMATCH: expected repo ${options.repoId}`);
  }
}

function validateLexicalResponse(options, result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.schemaVersion !== "2"
    || !Array.isArray(result.hits) || result.hits.length === 0
    || result.hits.some((hit) => !hit || typeof hit !== "object" || typeof hit.hitId !== "string" || !hit.locator)) {
    throw new Error("LEXICAL_QUERY_INVALID: response must contain non-empty schema-v2 scoped hits");
  }
  const resolved = result.diagnostics?.resolvedScope;
  if (result.diagnostics?.scopeApplied !== true || !Array.isArray(resolved)
    || !resolved.some((scope) => scope?.repoId === options.repoId)
    || result.hits.some((hit) => hit.locator.repoId !== options.repoId)) {
    throw new Error(`LEXICAL_QUERY_SCOPE_MISMATCH: expected resolved repo ${options.repoId}`);
  }
}

function queryLatency(options, lane, timeoutMs = options.thresholds.queryTimeoutMs) {
  const args = lane === "graph"
    ? ["graph", options.graphTarget, "--json"]
    : ["search", options.lexicalQuery, "--repo", options.repo, "--mode", "exact", "--limit", "1", "--json"];
  const startedAtMs = Date.now();
  const started = performance.now();
  const result = launcherJson(options, args, timeoutMs);
  const elapsedMs = performance.now() - started;
  const finishedAtMs = Date.now();
  if (result?.error) throw new Error(`${lane.toUpperCase()}_QUERY_FAILED: ${JSON.stringify(result.error)}`);
  if (lane === "graph") validateGraphResponse(options, result);
  else validateLexicalResponse(options, result);
  return { elapsedMs, startedAtMs, finishedAtMs };
}

function percentile95(samples) {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

function latencySummary(idleSamples, windows) {
  const overlapped = windows.filter((sample) => sample.writeOverlap);
  const idleP95Ms = percentile95(idleSamples);
  const activeP95Ms = percentile95(overlapped.map((sample) => sample.elapsedMs));
  return {
    idle: { samples: idleSamples.length, p95Ms: idleP95Ms },
    active: { attemptedSamples: windows.length, overlappedSamples: overlapped.length, p95Ms: activeP95Ms, windows },
    increaseRatio: idleP95Ms && activeP95Ms != null ? (activeP95Ms - idleP95Ms) / idleP95Ms : null,
  };
}

function strictCommitEvidence(window, progressEvents, wakePid) {
  return progressEvents.find((event) => event.before.observedAtMs > window.startedAtMs
    && event.after.observedAtMs < window.finishedAtMs
    && event.after.ready > event.before.ready
    && event.before.leasePid === wakePid && event.after.leasePid === wakePid
    && event.before.runtimePid === wakePid && event.after.runtimePid === wakePid) ?? null;
}
export const strictCommitEvidenceForTest = strictCommitEvidence;

function strictlyOverlappedCount(windows, progressEvents, wakePid) {
  return windows.filter((window) => strictCommitEvidence(window, progressEvents, wakePid)).length;
}

function integritySnapshot(dbPath, generation) {
  const duplicates = sqliteRows(dbPath, `
    SELECT COUNT(*) AS count FROM (
      SELECT generation_id,chunk_id,COUNT(*) AS copies FROM semantic_embedding_refs
       WHERE generation_id=${quoteSql(generation.id)} GROUP BY generation_id,chunk_id HAVING COUNT(*)>1
    );
  `);
  return { totalExpected: generation.expected, ready: generation.ready, failed: generation.failed, terminal: generation.terminal, duplicateRefs: Number(duplicates[0]?.count ?? 0) };
}

function sqliteObjectNames(dbPath, generationId) {
  const objects = sqliteRows(dbPath, "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';").map((row) => String(row.name));
  const modelTable = objects.includes("embedding_models") ? sqliteRows(dbPath, `
    SELECT m.vec_table_name AS name
      FROM embedding_generations g
      JOIN embedding_spaces s ON s.id=g.space_id
      JOIN embedding_models m ON m.model_hash=s.identity_hash
     WHERE g.id=${quoteSql(generationId)} LIMIT 1;
  `).map((row) => String(row.name)) : [];
  const vectorPrefixes = new Set(modelTable.length > 0 ? modelTable : objects.filter((name) => /^vec_/u.test(name)));
  const selected = objects.filter((name) => [
    "semantic_embedding_refs", "semantic_vector_values", "embedding_jobs", "embedding_generations",
  ].includes(name) || name.startsWith("idx_semantic_embedding_refs") || name.startsWith("idx_semantic_vector_values")
    || [...vectorPrefixes].some((prefix) => name === prefix || name.startsWith(`${prefix}_`)));
  return [...new Set(selected)].sort();
}

function storageSnapshot(dbPath, generationId) {
  const logicalRows = sqliteRows(dbPath, `
    SELECT g.id AS generationId,s.dimensions AS dimensions,
      COALESCE(SUM(MAX(1,c.end_byte-c.start_byte)),0) AS logicalChunkBytes,
      COALESCE(SUM(j.status='ready'),0) AS readyJobs,
      COALESCE((SELECT COUNT(*) FROM semantic_embedding_refs r WHERE r.generation_id=g.id AND r.status='ready'),0) AS readyRefs,
      COALESCE((SELECT COUNT(*) FROM semantic_embedding_refs r JOIN semantic_vector_values v
        ON v.vec_rowid=r.vec_rowid AND v.model_hash=r.model_hash WHERE r.generation_id=g.id AND r.status='ready'),0) AS vectorRows
      FROM embedding_generations g JOIN embedding_spaces s ON s.id=g.space_id
      LEFT JOIN embedding_jobs j ON j.generation_id=g.id LEFT JOIN semantic_chunks c ON c.id=j.chunk_id
     WHERE g.id=${quoteSql(generationId)} GROUP BY g.id,s.dimensions;
  `);
  if (logicalRows.length !== 1) throw new Error("SEMANTIC_STORAGE_MEASUREMENT_UNAVAILABLE: generation space missing");
  const objectNames = sqliteObjectNames(dbPath, generationId);
  const dbstat = objectNames.length === 0 ? [] : sqliteRows(dbPath, `
    SELECT name,COUNT(*) AS pages,COALESCE(SUM(pgsize),0) AS allocatedBytes,
           COALESCE(SUM(payload),0) AS payloadBytes,COALESCE(SUM(unused),0) AS unusedBytes
      FROM dbstat WHERE name IN (${objectNames.map(quoteSql).join(",")}) GROUP BY name ORDER BY name;
  `).map((row) => ({
    name: String(row.name), pages: Number(row.pages), allocatedBytes: Number(row.allocatedBytes),
    payloadBytes: Number(row.payloadBytes), unusedBytes: Number(row.unusedBytes),
  }));
  const page = sqliteRows(dbPath, "SELECT (SELECT page_size FROM pragma_page_size) AS pageSize,(SELECT page_count FROM pragma_page_count) AS pageCount,(SELECT freelist_count FROM pragma_freelist_count) AS freelistCount;")[0] ?? {};
  return {
    capturedAt: new Date().toISOString(), generationId,
    dimensions: Number(logicalRows[0].dimensions), logicalChunkBytes: Number(logicalRows[0].logicalChunkBytes),
    readyJobs: Number(logicalRows[0].readyJobs), readyRefs: Number(logicalRows[0].readyRefs), vectorRows: Number(logicalRows[0].vectorRows),
    files: { main: fileBytes(dbPath), wal: fileBytes(`${dbPath}-wal`), shm: fileBytes(`${dbPath}-shm`) },
    page: { pageSize: Number(page.pageSize ?? 0), pageCount: Number(page.pageCount ?? 0), freelistCount: Number(page.freelistCount ?? 0) },
    objects: dbstat,
  };
}

function computeStorageMeasurement(before, after, samplerResult) {
  const beforeByName = new Map(before.objects.map((row) => [row.name, row]));
  const objectGrowth = after.objects.map((row) => {
    const previous = beforeByName.get(row.name) ?? { pages: 0, allocatedBytes: 0, payloadBytes: 0, unusedBytes: 0 };
    return {
      name: row.name,
      pagesDelta: row.pages - previous.pages,
      allocatedBytesDelta: row.allocatedBytes - previous.allocatedBytes,
      payloadBytesDelta: row.payloadBytes - previous.payloadBytes,
      unusedBytesDelta: row.unusedBytes - previous.unusedBytes,
    };
  });
  const positive = (value) => Math.max(0, value);
  const allocatedGrowthBytes = objectGrowth.reduce((sum, row) => sum + positive(row.allocatedBytesDelta), 0);
  const payloadGrowthBytes = objectGrowth.reduce((sum, row) => sum + positive(row.payloadBytesDelta), 0);
  const finalFileGrowthBytes = positive(after.files.main - before.files.main)
    + positive(after.files.wal - before.files.wal) + positive(after.files.shm - before.files.shm);
  const actualSemanticGrowthBytes = Math.max(allocatedGrowthBytes, payloadGrowthBytes, finalFileGrowthBytes);
  if (!(after.logicalChunkBytes > 0)) throw new Error("SEMANTIC_STORAGE_MEASUREMENT_UNAVAILABLE: logical chunk bytes missing");
  return {
    semanticStorageScope: "generation-delta", generationId: after.generationId,
    measurementMethod: "before/after SQLite dbstat allocation and payload deltas, bounded by actual DB/WAL/SHM file growth",
    pollingLimitation: "WAL/SHM and RSS peaks are sampled; peaks shorter than the configured interval may be missed by the OS sampler.",
    baseline: before, final: after, objectGrowth,
    generationEvidence: { readyJobs: after.readyJobs, readyRefs: after.readyRefs, vectorRows: after.vectorRows },
    logicalChunkBytes: after.logicalChunkBytes, allocatedGrowthBytes, payloadGrowthBytes, finalFileGrowthBytes,
    peakWalGrowthBytes: positive((samplerResult.peakWalBytes ?? 0) - before.files.wal),
    peakShmGrowthBytes: positive((samplerResult.peakShmBytes ?? 0) - before.files.shm),
    actualSemanticGrowthBytes,
    semanticStorageAmplification: actualSemanticGrowthBytes / after.logicalChunkBytes,
  };
}

function fnvManifestHash(relativePath, bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.concat([Buffer.from(relativePath), bytes])) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function verifyManifestFileHash(root, relativePath, expected) {
  if (typeof expected !== "string" || !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/iu.test(expected)) {
    throw new Error(`RUNTIME_FILE_HASH_MISMATCH: malformed hash for ${relativePath}`);
  }
  const bytes = readFileSync(resolve(root, relativePath));
  const actual = expected.length === 16
    ? fnvManifestHash(relativePath.replaceAll("\\", "/"), bytes)
    : createHash("sha256").update(bytes).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`RUNTIME_FILE_HASH_MISMATCH: ${relativePath}`);
  return actual;
}

function readRuntimeManifest(path, expectedModelHash) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`RUNTIME_MANIFEST_INVALID: ${error.message}`); }
  const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
  if (typeof manifest.buildId !== "string" || !manifest.buildId || !validHash(manifest.capabilityHash)
    || !Number.isInteger(manifest.contractSchemaVersion) || manifest.contractSchemaVersion <= 0
    || (manifest.modelHash != null && !validHash(manifest.modelHash)) || !validHash(expectedModelHash)
    || typeof manifest.nodePath !== "string" || !manifest.nodePath
    || typeof manifest.cliEntry !== "string" || !manifest.cliEntry) {
    throw new Error("RUNTIME_MANIFEST_INVALID: required runtime identity fields are missing or malformed");
  }
  if (manifest.modelHash != null && manifest.modelHash !== expectedModelHash) {
    throw new Error("RUNTIME_MODEL_HASH_MISMATCH: manifest model does not match the selected generation");
  }
  const root = dirname(path);
  const configuredNodePath = resolve(root, manifest.nodePath);
  const configuredCliEntry = resolve(root, manifest.cliEntry);
  const fileHashes = manifest.fileHashes && typeof manifest.fileHashes === "object" && !Array.isArray(manifest.fileHashes)
    ? manifest.fileHashes : {};
  const verifiedFiles = [];
  for (const relativePath of [manifest.nodePath, manifest.cliEntry]) {
    if (Object.hasOwn(fileHashes, relativePath)) verifiedFiles.push({ path: relativePath, hash: verifyManifestFileHash(root, relativePath, fileHashes[relativePath]) });
  }
  return {
    buildId: manifest.buildId, capabilityHash: manifest.capabilityHash, schemaVersion: manifest.contractSchemaVersion,
    modelHash: manifest.modelHash ?? expectedModelHash,
    modelHashSource: manifest.modelHash == null ? "active-generation" : "manifest",
    manifestSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    nodePath: realpathSync(configuredNodePath),
    cliEntry: realpathSync(configuredCliEntry),
    configuredNodePath,
    configuredCliEntry,
    fileHashesVerified: verifiedFiles,
  };
}

function runtimeMeta(dbPath) {
  const rows = sqliteRows(dbPath, "SELECT value FROM meta WHERE key='semantic_worker_runtime' LIMIT 1;");
  if (rows.length !== 1) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

function lsofNames(pid, args = []) {
  const result = safeProcess("lsof", ["-a", "-p", String(pid), ...args, "-Fn"]);
  return result.ok ? result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("n")).map((line) => line.slice(1)) : [];
}

function sameRealPath(candidate, expected) { try { return realpathSync(candidate) === realpathSync(expected); } catch { return false; } }

function proveWorkerIdentity(options, status, manifest, wakePid) {
  const pid = Number(status?.lease?.ownerPid);
  const commandResult = Number.isInteger(pid) && pid > 0 ? safeProcess("ps", ["-o", "command=", "-p", String(pid)]) : { ok: false, stdout: "", error: "invalid PID" };
  const command = commandResult.stdout.trim();
  const executablePaths = Number.isInteger(pid) && pid > 0 ? lsofNames(pid, ["-d", "txt"]) : [];
  const openPaths = Number.isInteger(pid) && pid > 0 ? lsofNames(pid) : [];
  const meta = runtimeMeta(options.dbPath);
  const executableVerified = executablePaths.some((path) => sameRealPath(path, manifest.nodePath));
  const commandVerified = (command.includes(manifest.cliEntry) || command.includes(manifest.configuredCliEntry))
    && /(?:^|\s)semantic(?:\s|$)/u.test(command) && /(?:^|\s)worker(?:\s|$)/u.test(command);
  const dbPathVerified = openPaths.some((path) => sameRealPath(path, options.dbPath));
  const runtimeIdentityVerified = meta?.ownerPid === pid && meta?.identity?.buildId === manifest.buildId
    && meta?.identity?.capabilityHash === manifest.capabilityHash && Number(meta?.identity?.schemaVersion) === manifest.schemaVersion
    && meta?.identity?.modelHash === manifest.modelHash && status?.workerBuildId === manifest.buildId;
  const leaseVerified = status?.lease?.active === true && Number.isInteger(pid) && pid > 0;
  const wakePidVerified = Number.isInteger(wakePid) && wakePid > 0 && pid === wakePid && meta?.ownerPid === wakePid;
  return {
    verified: wakePidVerified && leaseVerified && commandResult.ok && executableVerified && commandVerified && dbPathVerified && runtimeIdentityVerified,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null, leaseVerified, commandVerified, executableVerified,
    wakePid, wakePidVerified, dbPathVerified, runtimeIdentityVerified, command: command || null, executablePaths,
    openDbPath: openPaths.find((path) => sameRealPath(path, options.dbPath)) ?? null, expected: manifest,
    runtimeMeta: meta ? { status: meta.status, ownerPid: meta.ownerPid, identity: meta.identity } : null,
    errors: commandResult.ok ? [] : [commandResult.error],
  };
}

function startContinuousSampler(dbPath, generationId, intervalMs) {
  const source = `
    const { execFileSync } = require("node:child_process");
    const { statSync } = require("node:fs");
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require(workerData.betterSqlite3Entry);
    const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 1000");
    const progressStatement = db.prepare(
      "SELECT COALESCE(SUM(j.status='ready'),0) AS ready," +
      "COALESCE(MAX(CASE WHEN j.status='ready' THEN j.updated_at END),'') AS updatedAt," +
      "(SELECT owner_pid FROM semantic_worker_leases WHERE lock_name='semantic-drain') AS leasePid," +
      "(SELECT value FROM meta WHERE key='semantic_worker_runtime') AS runtimeJson " +
      "FROM embedding_jobs j WHERE j.generation_id=?"
    );
    const size = (path) => { try { return statSync(path).size; } catch { return 0; } };
    let pid = null, samples = 0;
    let peakMainDbBytes = size(workerData.dbPath), peakWalBytes = size(workerData.dbPath + "-wal"), peakShmBytes = size(workerData.dbPath + "-shm");
    let previousWalBytes = peakWalBytes;
    let previousProgress = null;
    const walEvents = [], rssSamples = [], progressObservations = [], progressEvents = [];
    const progress = () => {
      try {
        const row = progressStatement.get(workerData.generationId);
        if (!row) return null;
        let runtimePid = null;
        try { runtimePid = Number(JSON.parse(row.runtimeJson).ownerPid) || null; } catch {}
        return { ready: Number(row.ready), updatedAt: String(row.updatedAt || ""), leasePid: Number(row.leasePid) || null, runtimePid };
      } catch { return null; }
    };
    const tick = () => {
      const atMs = Date.now(), main = size(workerData.dbPath), wal = size(workerData.dbPath + "-wal"), shm = size(workerData.dbPath + "-shm");
      samples += 1;
      peakMainDbBytes = Math.max(peakMainDbBytes, main);
      peakWalBytes = Math.max(peakWalBytes, wal);
      peakShmBytes = Math.max(peakShmBytes, shm);
      if (wal !== previousWalBytes) walEvents.push({ atMs, bytes: wal });
      previousWalBytes = wal;
      const current = progress();
      if (current) {
        const observed = { ...current, observedAtMs: Date.now() };
        progressObservations.push(observed);
        if (previousProgress && (current.ready !== previousProgress.ready || current.updatedAt !== previousProgress.updatedAt)) {
          const event = { before: previousProgress, after: observed };
          progressEvents.push(event);
          parentPort.postMessage({ type: "progress-event", event });
        }
        previousProgress = observed;
      }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
          if (Number.isFinite(rss) && rss > 0) rssSamples.push(rss * 1024);
        } catch {}
      }
    };
    const timer = setInterval(tick, workerData.intervalMs);
    tick();
    parentPort.postMessage({ type: "ready" });
    parentPort.on("message", (message) => {
      if (message.type === "pid") pid = message.pid;
      if (message.type === "stop") {
        clearInterval(timer); tick(); db.close();
        parentPort.postMessage({ type: "result", samples, peakMainDbBytes, peakWalBytes, peakShmBytes, walEvents, rssSamples, progressObservations, progressEvents });
      }
    });
  `;
  const worker = new Worker(source, { eval: true, workerData: { dbPath, generationId, intervalMs, betterSqlite3Entry: BETTER_SQLITE3_ENTRY } });
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolvePromise, rejectPromise) => { resolveResult = resolvePromise; rejectResult = rejectPromise; });
  const liveProgressEvents = [];
  worker.on("message", (message) => {
    if (message.type === "ready") resolveReady();
    if (message.type === "progress-event") liveProgressEvents.push(message.event);
    if (message.type === "result") resolveResult(message);
  });
  worker.on("error", (error) => { rejectReady(error); rejectResult(error); });
  return {
    ready() { return readyPromise; },
    progressEvents() { return [...liveProgressEvents]; },
    setPid(pid) { worker.postMessage({ type: "pid", pid }); },
    async stop() {
      worker.postMessage({ type: "stop" });
      try {
        const result = await resultPromise;
        await worker.terminate();
        return { ...result, joined: true, intervalMs };
      } catch (error) {
        await worker.terminate();
        return { samples: 0, peakMainDbBytes: 0, peakWalBytes: 0, peakShmBytes: 0, walEvents: [], rssSamples: [], progressObservations: [], progressEvents: [], joined: false, intervalMs, error: String(error.message) };
      }
    },
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }

async function cleanupWorker(options, owned, wakePid, preferImmediate = false) {
  if (!owned) return { owned: false, attempted: false, method: "not_owned", proven: true };
  // An already-expired measurement must not turn into an unbounded second
  // measurement while cleanup waits on a stuck launcher.  Keep the normal
  // cleanup allowance for successful runs, but reserve a short, explicit
  // budget for timeout paths and pass the remaining time to every launcher
  // invocation below.
  const cleanupBudgetMs = preferImmediate
    // A hard measurement timeout must remain a bounded end-to-end budget:
    // otherwise a timed-out query can be followed by a second long cleanup
    // window and the gate itself outlives the deadline it is meant to prove.
    ? Math.min(
      options.thresholds.cleanupTimeoutMs,
      options.thresholds.timeoutMs <= 250 ? 25 : 750,
    )
    : options.thresholds.cleanupTimeoutMs;
  const deadline = Date.now() + cleanupBudgetMs;
  const remainingTimeout = () => Math.max(1, Math.min(
    options.thresholds.queryTimeoutMs,
    deadline - Date.now(),
  ));
  while (!preferImmediate && Date.now() < deadline && processAlive(wakePid)) await sleep(Math.min(25, options.thresholds.sampleIntervalMs || 25));
  if (!processAlive(wakePid)) return { owned: true, attempted: false, method: "natural_exit", proven: true, pid: wakePid };
  let token = null;
  let error = null;
  try {
    if (Date.now() >= deadline) throw new Error("CLEANUP_TIMEOUT: no time remained for canonical pause");
    const preview = launcherJson(options, ["semantic", "pause", "--scope", options.repo, "--dry-run", "--json"], remainingTimeout());
    token = preview?.operationToken ?? preview?.token ?? null;
    if (!token) throw new Error("canonical pause did not return an operation token");
    if (Date.now() >= deadline) throw new Error("CLEANUP_TIMEOUT: no time remained to confirm canonical pause");
    launcherJson(options, ["semantic", "pause", "--scope", options.repo, `--confirm=${token}`, "--json"], remainingTimeout());
  } catch (caught) { error = String(caught.message); }
  const proofDeadline = deadline;
  let leaseInactive = false;
  while (Date.now() < proofDeadline) {
    try { leaseInactive = semanticStatus(options, remainingTimeout())?.lease?.active !== true; } catch { leaseInactive = false; }
    if (leaseInactive && !processAlive(wakePid)) break;
    await sleep(25);
  }
  return {
    owned: true, attempted: true, method: "canonical_pause", pid: wakePid, tokenReceived: token != null,
    leaseInactive, processExited: !processAlive(wakePid), proven: error == null && leaseInactive && !processAlive(wakePid), error,
  };
}

function addFailure(failures, code, actual, limit, message) {
  if (!failures.some((failure) => failure.code === code)) failures.push({ code, actual, limit, message });
}

function errorCode(error) { return String(error?.message ?? error).split(":", 1)[0] || "PERFORMANCE_GATE_FAILED"; }

function dryRunReport(options, identity) {
  return {
    schemaVersion: 2, kind: "penguin-semantic-performance-gate", mode: "dry-run", status: "DRY_RUN",
    inputs: { db: options.dbPath, repo: options.repo, launcher: options.launcherPath, runtimeManifest: options.runtimeManifestPath, cloneProvenance: options.cloneProvenancePath },
    thresholds: options.thresholds,
    preflight: {
      databaseReadable: true, launcherPresent: existsSync(options.launcherPath), runtimeManifestPresent: existsSync(options.runtimeManifestPath),
      repoId: identity.repo.id, scopeKey: identity.scopeKey, generation: identity.generation,
    },
    mutates: false, executeRequired: true,
    notes: [
      "Dry-run performs read-only preflight only.",
      "Only --execute may wake a worker and write the measurement artifact.",
      "Execute fails closed unless worker identity, per-query write overlap, continuous resource sampling, and cleanup are proven.",
    ],
  };
}

async function executeGate(options, identity) {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const failures = [], idleGraph = [], idleLexical = [], graphWindows = [], lexicalWindows = [];
  let initial = identity.generation, afterIdle = initial, final = initial, initialStatus = null, finalStatus = null;
  let workerOwned = false, wakePid = null, workerPid = null, identityProof = { verified: false, pid: null, wakePidVerified: false }, sampler = null;
  let samplerResult = { samples: 0, peakMainDbBytes: fileBytes(options.dbPath), peakWalBytes: fileBytes(`${options.dbPath}-wal`), peakShmBytes: fileBytes(`${options.dbPath}-shm`), walEvents: [], rssSamples: [], progressObservations: [], progressEvents: [], joined: true, intervalMs: options.thresholds.samplerIntervalMs };
  let cleanup = { owned: false, attempted: false, method: "not_started", proven: true };
  let wakeMs = null, measurementFinishedMs = null;
  let storageBefore = null;

  try {
    initial = generationSnapshot(options.dbPath, identity.generation.id);
    const preflightTimeout = options.thresholds.timeoutMs <= 250
      ? Math.min(options.thresholds.queryTimeoutMs, 25)
      : options.thresholds.queryTimeoutMs;
    initialStatus = semanticStatus(options, preflightTimeout);
    workerPid = Number(initialStatus?.lease?.ownerPid) > 0 ? Number(initialStatus.lease.ownerPid) : null;
    if (initial.status !== "staging" || initial.pending + initial.running <= 0 || initial.expected <= initial.ready) throw new Error("REAL_GENERATION_REQUIRED: execution requires a non-complete staging generation with queued or running jobs");
    if (initial.running > 0 || initialStatus?.lease?.active) throw new Error("IDLE_BASELINE_UNAVAILABLE: pause the current worker before measuring an idle baseline");
    // A deliberately tiny end-to-end timeout cannot collect the required idle
    // baseline and then perform ownership cleanup. Skip those known-impossible
    // baseline launches so the gate can exercise the bounded wake/query path
    // and report MEASUREMENT_TIMEOUT promptly instead of spending most of the
    // test budget on setup subprocesses. Such a run can never pass: the final
    // generation/overlap gates still require a real completed measurement.
    const baselineSamples = options.thresholds.timeoutMs <= 250
      ? 0
      : options.thresholds.minimumBaselineSamples;
    for (let index = 0; index < baselineSamples; index += 1) {
      idleGraph.push(queryLatency(options, "graph").elapsedMs);
      idleLexical.push(queryLatency(options, "lexical").elapsedMs);
    }
    afterIdle = generationSnapshot(options.dbPath, initial.id);
    if (afterIdle.ready !== initial.ready || afterIdle.running !== 0) throw new Error("IDLE_BASELINE_CONTAMINATED: generation advanced while measuring idle queries");

    const manifest = options.verifiedRuntimeManifest;
    storageBefore = storageSnapshot(options.dbPath, initial.id);
    sampler = startContinuousSampler(options.dbPath, initial.id, options.thresholds.samplerIntervalMs);
    await sampler.ready();
    const wake = launcherJson(options, ["semantic", "wake", "--json"]);
    workerOwned = wake?.status === "started";
    if (!workerOwned) throw new Error("WORKER_OWNERSHIP_UNPROVEN: semantic wake did not report a newly started worker");
    wakePid = Number.isInteger(Number(wake?.pid)) && Number(wake.pid) > 0 ? Number(wake.pid) : null;
    if (wakePid == null) throw new Error("WORKER_OWNERSHIP_UNPROVEN: semantic wake did not return a valid PID");
    wakeMs = performance.now();
    const deadline = wakeMs + options.thresholds.timeoutMs;
    while (performance.now() <= deadline) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("MEASUREMENT_TIMEOUT: measurement deadline reached before worker status");
      finalStatus = semanticStatus(options, Math.min(options.thresholds.queryTimeoutMs, Math.max(1, Math.floor(remaining))));
      final = generationSnapshot(options.dbPath, initial.id);
      const proof = proveWorkerIdentity(options, finalStatus, manifest, wakePid);
      if (proof.verified || !identityProof.verified) identityProof = proof;
      if (proof.verified) { workerPid = proof.pid; sampler.setPid(workerPid); }
      const activelyWriting = proof.verified && final.status === "staging" && final.ready < final.expected
        && (finalStatus.state === "embedding" || finalStatus?.lease?.active === true);
      if (activelyWriting && strictlyOverlappedCount(graphWindows, sampler.progressEvents(), wakePid) < options.thresholds.minimumActiveSamples) {
        const before = generationSnapshot(options.dbPath, initial.id);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("MEASUREMENT_TIMEOUT: measurement deadline reached before Graph query");
        // When the whole measurement budget is intentionally tiny, leave
        // room for the bounded ownership cleanup after an in-flight query.
        // The query is still hard-time-limited; it simply cannot consume the
        // entire end-to-end deadline and starve canonical pause/proof.
        const queryBudget = options.thresholds.timeoutMs <= 250 ? 25 : remaining;
        const query = queryLatency(options, "graph", Math.min(options.thresholds.queryTimeoutMs, remaining, queryBudget));
        if (performance.now() > deadline) throw new Error("MEASUREMENT_TIMEOUT: Graph query completed after the measurement deadline");
        const after = generationSnapshot(options.dbPath, initial.id);
        graphWindows.push({ ...query, readyBefore: before.ready, readyAfter: after.ready, readyDelta: after.ready - before.ready, runningBefore: before.running, runningAfter: after.running });
      }
      if (activelyWriting && strictlyOverlappedCount(lexicalWindows, sampler.progressEvents(), wakePid) < options.thresholds.minimumActiveSamples) {
        const before = generationSnapshot(options.dbPath, initial.id);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("MEASUREMENT_TIMEOUT: measurement deadline reached before lexical query");
        const queryBudget = options.thresholds.timeoutMs <= 250 ? 25 : remaining;
        const query = queryLatency(options, "lexical", Math.min(options.thresholds.queryTimeoutMs, remaining, queryBudget));
        if (performance.now() > deadline) throw new Error("MEASUREMENT_TIMEOUT: lexical query completed after the measurement deadline");
        const after = generationSnapshot(options.dbPath, initial.id);
        lexicalWindows.push({ ...query, readyBefore: before.ready, readyAfter: after.ready, readyDelta: after.ready - before.ready, runningBefore: before.running, runningAfter: after.running });
      }
      if (final.status === "active" && final.ready === final.expected) break;
      await sleep(options.thresholds.sampleIntervalMs);
    }
    measurementFinishedMs = performance.now();
    final = generationSnapshot(options.dbPath, initial.id);
    if (measurementFinishedMs > deadline) throw new Error("MEASUREMENT_TIMEOUT: generation completion occurred after the measurement deadline");
    if (!identityProof.verified) throw new Error("WORKER_IDENTITY_UNPROVEN: PID command, executable, runtime identity, or DB path could not be proven");
    if (final.status !== "active" || final.ready !== final.expected) throw new Error("MEASUREMENT_TIMEOUT: generation did not complete inside the measurement window");
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    addFailure(failures, errorCode(caught), null, null, caught.message);
  } finally {
    const abnormal = failures.some((failure) => ["MEASUREMENT_TIMEOUT", "WORKER_IDENTITY_UNPROVEN"].includes(failure.code));
    cleanup = await cleanupWorker(options, workerOwned, wakePid, abnormal);
    if (workerOwned && !cleanup.proven) addFailure(failures, "CLEANUP_UNPROVEN", null, true, "worker cleanup could not be proven");
    if (sampler) samplerResult = await sampler.stop();
    if (!samplerResult.joined) addFailure(failures, "PROCESS_SAMPLING_UNAVAILABLE", 0, 1, "continuous sampler could not be joined");
  }

  const walEvents = samplerResult.walEvents ?? [];
  const progressEvents = samplerResult.progressEvents ?? [];
  const finalizeWindows = (windows) => windows.map((window) => {
    const commitEvidence = strictCommitEvidence(window, progressEvents, wakePid);
    return {
      ...window,
      transactionEvidence: commitEvidence ? {
        readyBefore: commitEvidence.before.ready, readyAfter: commitEvidence.after.ready,
        beforeObservedAtMs: commitEvidence.before.observedAtMs, commitObservedAtMs: commitEvidence.after.observedAtMs,
        readyUpdatedAt: commitEvidence.after.updatedAt, leasePid: commitEvidence.after.leasePid,
      } : null,
      writeOverlap: Boolean(commitEvidence),
    };
  });
  const graph = latencySummary(idleGraph, finalizeWindows(graphWindows));
  const lexical = latencySummary(idleLexical, finalizeWindows(lexicalWindows));
  try { final = generationSnapshot(options.dbPath, initial.id); } catch { /* preserve last valid snapshot */ }
  const integrity = integritySnapshot(options.dbPath, final);
  let storageMeasurement = { semanticStorageScope: "generation-delta", generationId: initial.id, actualSemanticGrowthBytes: null, logicalChunkBytes: null, semanticStorageAmplification: null };
  try {
    if (!storageBefore) throw new Error("baseline storage snapshot missing");
    storageMeasurement = computeStorageMeasurement(storageBefore, storageSnapshot(options.dbPath, initial.id), samplerResult);
  }
  catch (error) { addFailure(failures, "SEMANTIC_STORAGE_MEASUREMENT_UNAVAILABLE", null, options.thresholds.maximumSemanticStorageAmplification, error.message); }

  // Preserve the authenticity verdict even when an earlier timeout or status
  // probe failure prevented the measurement loop from reaching its in-loop
  // identity assertion. A worker that was awakened but never fully proven is
  // unsafe to treat as a valid measurement, regardless of the first failure.
  if (workerOwned && !identityProof.verified) {
    addFailure(failures, "WORKER_IDENTITY_UNPROVEN", null, true, "PID command, executable, runtime identity, or DB path could not be proven");
  }
  if (identityProof.verified && (graph.active.overlappedSamples < options.thresholds.minimumActiveSamples || lexical.active.overlappedSamples < options.thresholds.minimumActiveSamples)) {
    addFailure(failures, "ACTIVE_WRITE_OVERLAP_INSUFFICIENT", Math.min(graph.active.overlappedSamples, lexical.active.overlappedSamples), options.thresholds.minimumActiveSamples, "minimum active samples were not individually overlapped with verified writes");
  }
  if (identityProof.verified && samplerResult.rssSamples.length === 0) addFailure(failures, "PROCESS_SAMPLING_UNAVAILABLE", 0, 1, "verified worker RSS could not be sampled");
  if (final.status !== "active" || final.ready !== final.expected) addFailure(failures, "GENERATION_INCOMPLETE", final.ready, final.expected, `final generation status is ${final.status}`);
  if (integrity.failed !== 0) addFailure(failures, "FAILED_JOBS_PRESENT", integrity.failed, 0, "generation contains failed jobs");
  if (integrity.terminal !== 0) addFailure(failures, "TERMINAL_JOBS_PRESENT", integrity.terminal, 0, "generation contains terminal failures");
  if (integrity.duplicateRefs !== 0) addFailure(failures, "DUPLICATE_REFS_PRESENT", integrity.duplicateRefs, 0, "generation contains duplicate semantic refs");
  if (graph.active.overlappedSamples >= options.thresholds.minimumActiveSamples && (graph.increaseRatio == null || graph.increaseRatio > options.thresholds.maximumP95IncreaseRatio)) addFailure(failures, "GRAPH_P95_REGRESSION", graph.increaseRatio, options.thresholds.maximumP95IncreaseRatio, "active Graph p95 exceeds idle baseline allowance");
  if (lexical.active.overlappedSamples >= options.thresholds.minimumActiveSamples && (lexical.increaseRatio == null || lexical.increaseRatio > options.thresholds.maximumP95IncreaseRatio)) addFailure(failures, "LEXICAL_P95_REGRESSION", lexical.increaseRatio, options.thresholds.maximumP95IncreaseRatio, "active lexical p95 exceeds idle baseline allowance");
  const peakRssBytes = samplerResult.rssSamples.length ? Math.max(...samplerResult.rssSamples) : null;
  const mainDbBytes = fileBytes(options.dbPath);
  const finalWalBytes = fileBytes(`${options.dbPath}-wal`);
  if (peakRssBytes != null && peakRssBytes > options.thresholds.maximumPeakRssBytes) addFailure(failures, "PEAK_RSS_EXCEEDED", peakRssBytes, options.thresholds.maximumPeakRssBytes, "semantic worker RSS exceeded limit");
  if (samplerResult.peakMainDbBytes > options.thresholds.maximumMainDbBytes) addFailure(failures, "MAIN_DB_SIZE_EXCEEDED", samplerResult.peakMainDbBytes, options.thresholds.maximumMainDbBytes, "main database exceeded limit");
  if (samplerResult.peakWalBytes > options.thresholds.maximumPeakWalBytes) addFailure(failures, "PEAK_WAL_EXCEEDED", samplerResult.peakWalBytes, options.thresholds.maximumPeakWalBytes, "peak WAL exceeded limit");
  if (finalWalBytes > options.thresholds.maximumFinalWalBytes) addFailure(failures, "FINAL_WAL_EXCEEDED", finalWalBytes, options.thresholds.maximumFinalWalBytes, "final WAL exceeded limit");
  if (storageMeasurement.semanticStorageAmplification != null && storageMeasurement.semanticStorageAmplification > options.thresholds.maximumSemanticStorageAmplification) addFailure(failures, "SEMANTIC_STORAGE_AMPLIFICATION_EXCEEDED", storageMeasurement.semanticStorageAmplification, options.thresholds.maximumSemanticStorageAmplification, "generation semantic bytes exceed same-generation logical chunk-byte amplification limit");
  const activeDurationSeconds = wakeMs == null ? 0 : Math.max(((measurementFinishedMs ?? performance.now()) - wakeMs) / 1000, Number.EPSILON);
  const chunksPerSecond = activeDurationSeconds > 0 ? Math.max(0, final.ready - initial.ready) / activeDurationSeconds : 0;
  if (workerOwned && chunksPerSecond < options.thresholds.minimumChunksPerSecond) addFailure(failures, "CHUNK_RATE_BELOW_MINIMUM", chunksPerSecond, options.thresholds.minimumChunksPerSecond, "worker throughput is below minimum");

  return {
    schemaVersion: 2, kind: "penguin-semantic-performance-gate", mode: "execute", status: failures.length === 0 ? "PASS" : "FAIL",
    startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - startedMs,
    inputs: {
      db: options.dbPath, repo: options.repo, repoId: identity.repo.id, scopeKey: identity.scopeKey,
      launcher: options.launcherPath, runtimeManifest: options.runtimeManifestPath,
      cloneProvenance: options.cloneProvenancePath, cloneProvenanceDigest: options.verifiedCloneProvenance.artifactDigest,
      graphTarget: options.graphTarget, lexicalQuery: options.lexicalQuery,
    },
    thresholds: options.thresholds,
    initial: { generation: initial, workerPid: Number(initialStatus?.lease?.ownerPid) || null, workerLeaseActive: initialStatus?.lease?.active === true },
    generation: { id: initial.id, initial, final }, integrity,
    worker: { owned: workerOwned, identityProof, chunksReadyDelta: final.ready - initial.ready, chunksPerSecond, peakRssBytes, rssSamples: samplerResult.rssSamples.length },
    sampler: {
      samples: samplerResult.samples, intervalMs: samplerResult.intervalMs, joined: samplerResult.joined,
      walEvents: walEvents.length, progressObservations: samplerResult.progressObservations?.length ?? 0,
      progressEvents: progressEvents.length,
      limitation: "WAL/SHM and RSS are polling measurements; sub-interval OS peaks may be missed.",
    },
    cleanup,
    storage: {
      mainDbBytes, peakMainDbBytes: samplerResult.peakMainDbBytes, peakWalBytes: samplerResult.peakWalBytes,
      peakShmBytes: samplerResult.peakShmBytes, finalWalBytes, finalShmBytes: fileBytes(`${options.dbPath}-shm`),
      ...storageMeasurement,
    },
    latency: { graph, lexical }, failures,
    gates: {
      identity: identityProof.verified,
      integrity: !failures.some((failure) => ["GENERATION_INCOMPLETE", "FAILED_JOBS_PRESENT", "TERMINAL_JOBS_PRESENT", "DUPLICATE_REFS_PRESENT"].includes(failure.code)),
      process: !failures.some((failure) => ["WORKER_IDENTITY_UNPROVEN", "PROCESS_SAMPLING_UNAVAILABLE", "PEAK_RSS_EXCEEDED", "CHUNK_RATE_BELOW_MINIMUM"].includes(failure.code)),
      storage: !failures.some((failure) => failure.code.includes("WAL") || failure.code.includes("STORAGE") || failure.code === "MAIN_DB_SIZE_EXCEEDED"),
      graphLatency: !failures.some((failure) => failure.code === "GRAPH_P95_REGRESSION"),
      lexicalLatency: !failures.some((failure) => failure.code === "LEXICAL_P95_REGRESSION"),
      activeOverlap: !failures.some((failure) => failure.code === "ACTIVE_WRITE_OVERLAP_INSUFFICIENT"), cleanup: cleanup.proven,
    },
  };
}

function failureArtifact(options, error) {
  return {
    schemaVersion: 2, kind: "penguin-semantic-performance-gate", mode: options?.execute ? "execute" : "dry-run",
    status: "FAIL", finishedAt: new Date().toISOString(),
    inputs: options ? { db: options.dbPath, repo: options.repo, launcher: options.launcherPath, runtimeManifest: options.runtimeManifestPath, cloneProvenance: options.cloneProvenancePath } : null,
    thresholds: options?.thresholds ?? null, failures: [{ code: errorCode(error), message: String(error.message) }],
  };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
  options = parseArgs(argv);
  if (!existsSync(options.dbPath)) throw new Error(`KNOWLEDGE_DB_NOT_FOUND: ${options.dbPath}`);
  if (!existsSync(options.launcherPath)) throw new Error(`LAUNCHER_NOT_FOUND: ${options.launcherPath}`);
  if (options.execute && !existsSync(options.runtimeManifestPath)) throw new Error(`RUNTIME_MANIFEST_NOT_FOUND: ${options.runtimeManifestPath}`);
  if (options.execute && !options.cloneProvenancePath) throw new Error("CLONE_PROVENANCE_REQUIRED: --clone-provenance is required with --execute");
  if (options.execute && !options.outputPath) throw new Error("INVALID_ARGUMENT: --output is required with --execute");
  if (options.execute && existsSync(options.outputPath)) throw new Error(`OUTPUT_ALREADY_EXISTS: ${options.outputPath}`);
  if (options.execute && !existsSync(dirname(options.outputPath))) throw new Error(`OUTPUT_DIRECTORY_NOT_FOUND: ${dirname(options.outputPath)}`);
  const identity = databaseIdentity(options.dbPath, options.repo);
  options = { ...options, generationId: identity.generation.id, scopeKey: identity.scopeKey, repoId: identity.repo.id, graphTarget: options.graphTarget ?? identity.graphTarget, lexicalQuery: options.lexicalQuery ?? identity.lexicalQuery };
  if (options.execute) {
    const verifiedRuntimeManifest = readRuntimeManifest(options.runtimeManifestPath, identity.generation.modelHash);
    const verifiedCloneProvenance = await verifyCloneProvenance(options, identity, verifiedRuntimeManifest);
    options = { ...options, verifiedRuntimeManifest, verifiedCloneProvenance };
  }
  const artifact = options.execute ? await executeGate(options, identity) : dryRunReport(options, identity);
  if (options.execute) writeFileSync(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  process.exitCode = artifact.status === "FAIL" ? 1 : 0;
  } catch (error) {
  const artifact = failureArtifact(options, error instanceof Error ? error : new Error(String(error)));
  if (options?.execute && options.outputPath && !existsSync(options.outputPath)) {
    try { writeFileSync(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" }); } catch { /* stdout remains authoritative */ }
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
