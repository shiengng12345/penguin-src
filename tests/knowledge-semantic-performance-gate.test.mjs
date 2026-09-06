import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { strictCommitEvidenceForTest } from "../scripts/knowledge-semantic-performance-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const GATE = join(ROOT, "scripts", "knowledge-semantic-performance-gate.mjs");
const temporaryDirectories = [];

test("commit observations before query start or after query finish never prove overlap", () => {
  const window = { startedAtMs: 1_000, finishedAtMs: 2_000 };
  const observation = (beforeObservedAtMs, commitObservedAtMs) => ({
    before: { observedAtMs: beforeObservedAtMs, ready: 10, leasePid: 42, runtimePid: 42 },
    after: { observedAtMs: commitObservedAtMs, ready: 11, updatedAt: "commit-11", leasePid: 42, runtimePid: 42 },
  });
  assert.equal(strictCommitEvidenceForTest(window, [observation(900, 1_100)], 42), null, "before-start state is outside the query");
  assert.equal(strictCommitEvidenceForTest(window, [observation(1_900, 2_100)], 42), null, "after-finish commit is outside the query");
  assert.ok(strictCommitEvidenceForTest(window, [observation(1_100, 1_900)], 42), "both observations strictly inside prove overlap");
});

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      const statePath = join(directory, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (Number.isInteger(state.workerPid) && isAlive(state.workerPid)) process.kill(state.workerPid, "SIGTERM");
      }
    } catch { /* worker already exited */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

function sqlite(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function provenanceDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function rewriteProvenance(path, mutate) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  delete artifact.artifactDigest;
  mutate(artifact);
  writeFileSync(path, `${JSON.stringify({ ...artifact, artifactDigest: provenanceDigest(artifact) }, null, 2)}\n`);
}

function createFixture({
  expected = 48,
  baselineDelayMs = 70,
  activeDelayMs = 45,
  workerMode = "stream",
  progressIntervalMs = 30,
  transientWalBytes = 0,
  terminal = false,
  duplicate = false,
  secondRepoVectorBytes = 0,
  wakePidOffset = 0,
  statusPidOffset = 0,
  graphResponse = "valid",
  lexicalResponse = "valid",
  rssMegabytes = 0,
  includeManifestModelHash = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-perf-gate-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "knowledge.db");
  const outputPath = join(directory, "measurement.json");
  const statePath = join(directory, "state.json");
  const launcherPath = join(directory, "penguin-fake.mjs");
  const runtimeDirectory = join(directory, "runtime");
  const runtimeManifestPath = join(runtimeDirectory, "manifest.json");
  const workerPath = join(runtimeDirectory, "fake-worker.mjs");
  const runtimeIdentity = {
    buildId: "fixture-build-1",
    capabilityHash: "a".repeat(64),
    schemaVersion: 18,
    modelHash: "b".repeat(64),
  };

  mkdirSync(runtimeDirectory, { recursive: true });
  symlinkSync(process.execPath, join(runtimeDirectory, "node"));
  const runtimeManifest = {
    schemaVersion: 1,
    ready: true,
    buildId: runtimeIdentity.buildId,
    capabilityHash: runtimeIdentity.capabilityHash,
    contractSchemaVersion: runtimeIdentity.schemaVersion,
    nodePath: "node",
    cliEntry: "fake-worker.mjs",
  };
  if (includeManifestModelHash) runtimeManifest.modelHash = runtimeIdentity.modelHash;
  writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest));

  const chunkRows = [];
  const jobRows = [];
  for (let index = 0; index < expected; index += 1) {
    const chunkId = `chunk-${String(index + 1).padStart(3, "0")}`;
    const status = terminal && index === 0 ? "failed" : "pending";
    const attempts = status === "failed" ? 5 : 0;
    chunkRows.push(`('${chunkId}','repo-1','snapshot-1',0,4096)`);
    jobRows.push(`('job-${chunkId}','generation-1','${chunkId}','${status}',${attempts},'2026-09-01T00:00:00.000Z')`);
  }
  sqlite(dbPath, `
    PRAGMA journal_mode=WAL;
    CREATE TABLE repos(id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,node_type TEXT NOT NULL,identity_key TEXT NOT NULL,repo_id TEXT,title TEXT NOT NULL);
    CREATE TABLE semantic_chunks(id TEXT PRIMARY KEY,repo_id TEXT,snapshot_id TEXT,start_byte INTEGER,end_byte INTEGER);
    CREATE TABLE embedding_spaces(id TEXT PRIMARY KEY,identity_hash TEXT,dimensions INTEGER);
    CREATE TABLE embedding_models(model_hash TEXT PRIMARY KEY,provider_id TEXT,model_id TEXT,dimensions INTEGER,vec_table_name TEXT);
    CREATE TABLE embedding_generations(id TEXT PRIMARY KEY,space_id TEXT,scope_key TEXT,status TEXT,expected_chunks INTEGER,created_at TEXT);
    CREATE TABLE embedding_jobs(id TEXT PRIMARY KEY,generation_id TEXT,chunk_id TEXT,status TEXT,attempts INTEGER,updated_at TEXT);
    CREATE TABLE semantic_embedding_refs(model_hash TEXT,chunk_id TEXT,vec_rowid INTEGER,status TEXT,generation_id TEXT);
    CREATE TABLE semantic_vector_values(vec_rowid INTEGER PRIMARY KEY,model_hash TEXT,dimensions INTEGER,vector_json TEXT,created_at TEXT);
    CREATE TABLE vec_embeddings_fixture(embedding BLOB);
    CREATE TABLE vec_embeddings_fixture_chunks(vector_id INTEGER PRIMARY KEY,chunk BLOB);
    CREATE INDEX idx_semantic_vector_values_model ON semantic_vector_values(model_hash);
    CREATE INDEX idx_semantic_embedding_refs_generation ON semantic_embedding_refs(generation_id,status,chunk_id);
    CREATE TABLE semantic_worker_leases(lock_name TEXT PRIMARY KEY,owner_id TEXT,owner_pid INTEGER,build_id TEXT,heartbeat_at TEXT,lease_expires_at TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO repos VALUES('repo-1','FPMS-NT','/fixture/FPMS-NT');
    INSERT INTO nodes VALUES('node-1','symbol','FPMS-NT::FixtureSymbol','repo-1','FixtureSymbol');
    INSERT INTO embedding_spaces VALUES('space-1','${runtimeIdentity.modelHash}',2);
    INSERT INTO embedding_models VALUES('${runtimeIdentity.modelHash}','fixture','fixture',2,'vec_embeddings_fixture');
    INSERT INTO embedding_generations VALUES('generation-1','space-1','repo:repo-1','staging',${expected},'2026-09-01T00:00:00.000Z');
    INSERT INTO semantic_chunks VALUES ${chunkRows.join(",")};
    INSERT INTO embedding_jobs VALUES ${jobRows.join(",")};
  `);
  if (duplicate) {
    sqlite(dbPath, `INSERT INTO semantic_embedding_refs VALUES('${runtimeIdentity.modelHash}','chunk-001',900001,'pending','generation-1');`);
  }
  if (secondRepoVectorBytes > 0) {
    sqlite(dbPath, `
      INSERT INTO repos VALUES('repo-2','Other-Repo','/fixture/Other-Repo');
      INSERT INTO embedding_spaces VALUES('space-2','${"c".repeat(64)}',2);
      INSERT INTO embedding_generations VALUES('generation-2','space-2','repo:repo-2','active',1,'2026-09-01T00:00:00.000Z');
      INSERT INTO semantic_chunks VALUES('other-chunk','repo-2','snapshot-2',0,1);
      INSERT INTO embedding_jobs VALUES('other-job','generation-2','other-chunk','ready',0,'2026-09-01T00:00:00.000Z');
      INSERT INTO semantic_embedding_refs VALUES('${"c".repeat(64)}','other-chunk',999999,'ready','generation-2');
      INSERT INTO semantic_vector_values VALUES(999999,'${"c".repeat(64)}',2,hex(zeroblob(${secondRepoVectorBytes})),'2026-09-01T00:00:00.000Z');
    `);
  }

  writeFileSync(statePath, JSON.stringify({
    dbPath, expected, awake: false, wakeCount: 0, pauseCount: 0,
    baselineDelayMs, activeDelayMs, workerPid: null, workerMode,
    progressIntervalMs, transientWalBytes, runtimeDirectory, workerPath, runtimeIdentity,
    wakePidOffset, statusPidOffset, graphResponse, lexicalResponse, rssMegabytes,
  }));

  writeFileSync(workerPath, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const db = value("--db");
const statePath = value("--state");
const config = JSON.parse(readFileSync(statePath, "utf8"));
const retainedRss = config.rssMegabytes > 0 ? Buffer.alloc(config.rssMegabytes * 1024 * 1024, 1) : null;
const sql = (statement) => execFileSync("sqlite3", [db, statement]);
const quote = (input) => "'" + String(input).replaceAll("'", "''") + "'";
let descriptor = null;
if (config.workerMode !== "spoof") descriptor = openSync(db, "r");
const runtimeState = JSON.stringify({ status: "running", reason: null, identity: config.runtimeIdentity, ownerId: "fixture-owner", ownerPid: process.pid, startToken: "fixture-token", updatedAt: new Date().toISOString() });
sql(\`INSERT INTO meta(key,value) VALUES('semantic_worker_runtime',\${quote(runtimeState)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  INSERT INTO semantic_worker_leases VALUES('semantic-drain','fixture-owner',\${process.pid},\${quote(config.runtimeIdentity.buildId)},datetime('now'),datetime('now','+1 hour'))
  ON CONFLICT(lock_name) DO UPDATE SET owner_id=excluded.owner_id,owner_pid=excluded.owner_pid,build_id=excluded.build_id,heartbeat_at=excluded.heartbeat_at,lease_expires_at=excluded.lease_expires_at;\`);
const stop = () => {
  try { sql("UPDATE semantic_worker_leases SET lease_expires_at=datetime('now') WHERE lock_name='semantic-drain' AND owner_pid=" + process.pid); } catch {}
  if (descriptor != null) { try { closeSync(descriptor); } catch {} }
  process.exit(0);
};
process.on("SIGTERM", stop);
if (config.transientWalBytes > 0) {
  sql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS wal_pressure(payload BLOB); BEGIN IMMEDIATE; DELETE FROM wal_pressure; INSERT INTO wal_pressure VALUES(zeroblob(" + config.transientWalBytes + ")); COMMIT;");
  setTimeout(() => {
    try { sql("BEGIN IMMEDIATE; DELETE FROM wal_pressure; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  }, 500);
}
const advance = (limit) => {
  sql(\`BEGIN IMMEDIATE;
    CREATE TEMP TABLE selected_chunks(chunk_id TEXT PRIMARY KEY,vec_rowid INTEGER);
    INSERT INTO selected_chunks
      SELECT chunk_id,100000 + CAST(substr(chunk_id,7) AS INTEGER) FROM embedding_jobs
       WHERE generation_id='generation-1' AND status='pending' ORDER BY rowid LIMIT \${limit};
    INSERT OR REPLACE INTO semantic_vector_values(vec_rowid,model_hash,dimensions,vector_json,created_at)
      SELECT vec_rowid,\${quote(config.runtimeIdentity.modelHash)},2,'[0.1,0.2]',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM selected_chunks;
    INSERT INTO semantic_embedding_refs(model_hash,chunk_id,vec_rowid,status,generation_id)
      SELECT \${quote(config.runtimeIdentity.modelHash)},chunk_id,vec_rowid,'ready','generation-1' FROM selected_chunks;
    INSERT OR REPLACE INTO vec_embeddings_fixture(rowid,embedding) SELECT vec_rowid,zeroblob(8) FROM selected_chunks;
    INSERT OR REPLACE INTO vec_embeddings_fixture_chunks(vector_id,chunk) SELECT vec_rowid,zeroblob(64) FROM selected_chunks;
    UPDATE embedding_jobs SET status='ready',attempts=0 WHERE id IN (
      SELECT j.id FROM embedding_jobs j JOIN selected_chunks s ON s.chunk_id=j.chunk_id
    );
    UPDATE embedding_jobs SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chunk_id IN (SELECT chunk_id FROM selected_chunks);
    UPDATE embedding_generations SET status='active' WHERE id='generation-1'
      AND NOT EXISTS (SELECT 1 FROM embedding_jobs WHERE generation_id='generation-1' AND status<>'ready');
    DROP TABLE selected_chunks;
    COMMIT;\`);
  const row = JSON.parse(execFileSync("sqlite3", ["-cmd", ".timeout 5000", "-json", db, "SELECT SUM(status='pending') AS pending,SUM(status='failed') AS failed FROM embedding_jobs WHERE generation_id='generation-1';"], { encoding: "utf8" }))[0];
  if (Number(row.pending) === 0 && Number(row.failed) === 0) setTimeout(stop, 100);
};
if (config.workerMode === "stalled") {
  setInterval(() => {}, 1000);
} else if (config.workerMode === "bulk" || config.workerMode === "spoof") {
  setTimeout(() => advance(config.expected), 400);
  setInterval(() => {}, 1000);
} else {
  setInterval(() => advance(1), config.progressIntervalMs);
}
`);
  chmodSync(workerPath, 0o755);

  writeFileSync(launcherPath, `#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_PERF_STATE;
const read = () => JSON.parse(readFileSync(statePath, "utf8"));
const write = (value) => writeFileSync(statePath, JSON.stringify(value));
const state = read();
const args = process.argv.slice(2);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const query = (statement) => JSON.parse(execFileSync("sqlite3", ["-cmd", ".timeout 5000", "-json", state.dbPath, statement], { encoding: "utf8" }));
if (args[0] === "semantic" && args[1] === "wake") {
  const child = spawn(state.runtimeDirectory + "/node", [state.workerPath, "semantic", "worker", "--db", state.dbPath, "--state", statePath], { detached: true, stdio: "ignore" });
  child.unref();
  state.awake = true;
  state.wakeCount += 1;
  state.workerPid = child.pid;
  write(state);
  console.log(JSON.stringify({ status: "started", pid: child.pid + state.wakePidOffset }));
} else if (args[0] === "semantic" && args[1] === "status") {
  const row = query(\`SELECT g.status,g.expected_chunks AS expected,
    COALESCE(SUM(j.status='ready'),0) AS ready,COALESCE(SUM(j.status='running'),0) AS running,
    COALESCE(SUM(j.status='pending'),0) AS pending,COALESCE(SUM(j.status='failed'),0) AS failed,
    COALESCE(SUM(j.status='failed' AND j.attempts>=5),0) AS terminal
    FROM embedding_generations g LEFT JOIN embedding_jobs j ON j.generation_id=g.id
    WHERE g.id='generation-1' GROUP BY g.id;\`)[0];
  const active = Number.isInteger(state.workerPid) && alive(state.workerPid) && row.status === "staging";
  console.log(JSON.stringify({ statuses: [{
    state: row.status === "active" ? "active" : active ? "embedding" : "queued",
    scopeKey: "repo:repo-1", repoId: "repo-1", generationId: "generation-1",
    expected: Number(row.expected), ready: Number(row.ready), running: active ? 1 : Number(row.running),
    pending: Number(row.pending), retryableFailed: Number(row.failed) - Number(row.terminal), terminalFailed: Number(row.terminal),
    workerBuildId: state.runtimeIdentity.buildId, modelHash: state.runtimeIdentity.modelHash,
    lease: { active, ownerPid: active ? state.workerPid + state.statusPidOffset : null },
  }] }));
} else if (args[0] === "semantic" && args[1] === "pause" && args.includes("--dry-run")) {
  console.log(JSON.stringify({ operationToken: "fixture-pause-token", mutated: false }));
} else if (args[0] === "semantic" && args[1] === "pause") {
  if (state.workerPid && alive(state.workerPid)) process.kill(state.workerPid, "SIGTERM");
  state.pauseCount += 1;
  write(state);
  console.log(JSON.stringify({ status: { state: "paused", lease: { active: false, ownerPid: null } } }));
} else if (args[0] === "graph" || args[0] === "search") {
  const active = state.workerPid && alive(state.workerPid);
  const delay = active ? state.activeDelayMs : state.baselineDelayMs;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  const graph = state.graphResponse === "empty" ? { focus: null, nodes: [], edges: [], scope: { repoId: "repo-1" } }
    : state.graphResponse === "wrong-repo" ? { focus: "node-1", nodes: [], edges: [], scope: { repoId: "repo-2" } }
    : { focus: "node-1", nodes: [{ nodeId: "node-1" }], edges: [], scope: { repoId: "repo-1" } };
  const lexical = state.lexicalResponse === "empty" ? { schemaVersion: "2", hits: [], diagnostics: { scopeApplied: true, resolvedScope: [{ repoId: "repo-1" }] } }
    : state.lexicalResponse === "wrong-repo" ? { schemaVersion: "2", hits: [{ hitId: "hit-1", locator: { repoId: "repo-2" } }], diagnostics: { scopeApplied: true, resolvedScope: [{ repoId: "repo-2" }] } }
    : { schemaVersion: "2", hits: [{ hitId: "hit-1", locator: { repoId: "repo-1" } }], diagnostics: { scopeApplied: true, resolvedScope: [{ repoId: "repo-1" }] } };
  console.log(JSON.stringify(args[0] === "graph" ? graph : lexical));
} else {
  console.error("unsupported fake command: " + args.join(" "));
  process.exitCode = 2;
}
`);
  chmodSync(launcherPath, 0o755);

  const provenancePath = join(directory, "clone-provenance.json");
  const sourceDbPath = join(directory, "source.db");
  writeFileSync(sourceDbPath, "fixture source identity\n");
  const sourceStat = statSync(sourceDbPath);
  const logicalHash = "c".repeat(64);
  const provenance = {
    schemaVersion: 1,
    kind: "penguin-semantic-performance-clone",
    status: "READY",
    createdAt: "2026-09-01T00:00:00.000Z",
    source: {
      path: realpathSync(sourceDbPath), dev: sourceStat.dev, ino: sourceStat.ino,
      size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, schemaVersion: runtimeIdentity.schemaVersion,
      logicalHashBefore: logicalHash, logicalHashAfter: logicalHash,
    },
    clone: {
      path: realpathSync(dbPath), backupLogicalHash: logicalHash, preparedLogicalHash: "d".repeat(64),
      sha256: sha256File(dbPath), quickCheck: "ok", integrityCheck: "ok", backupIncludedWalState: true,
    },
    runtime: {
      manifestPath: runtimeManifestPath, buildId: runtimeIdentity.buildId,
      capabilityHash: runtimeIdentity.capabilityHash, schemaVersion: runtimeIdentity.schemaVersion,
      modelHash: runtimeIdentity.modelHash,
      modelHashSource: includeManifestModelHash ? "manifest" : "active-generation",
      manifestSha256: sha256File(runtimeManifestPath), verifiedFiles: [],
    },
    workload: {
      repoId: "repo-1", repoName: "FPMS-NT", scopeKey: "repo:repo-1",
      generationId: "generation-1", expectedChunks: expected,
    },
    safety: {
      sourceOpenedReadOnly: true, targetWasAbsent: true,
      sourceAndTargetDistinct: true, stagingCreatedOnlyOnClone: true,
    },
  };
  writeFileSync(provenancePath, `${JSON.stringify({ ...provenance, artifactDigest: provenanceDigest(provenance) }, null, 2)}\n`);
  return { directory, dbPath, outputPath, statePath, launcherPath, runtimeManifestPath, provenancePath, sourceDbPath };
}

function runGate(fixture, extra = [], { includeLauncher = true, includeProvenance = true, env = {} } = {}) {
  return spawnSync(process.execPath, [GATE,
    "--db", fixture.dbPath,
    "--repo", "FPMS-NT",
    ...(includeLauncher ? ["--launcher", fixture.launcherPath] : []),
    "--runtime-manifest", fixture.runtimeManifestPath,
    ...(includeProvenance ? ["--clone-provenance", fixture.provenancePath] : []),
    "--output", fixture.outputPath,
    "--baseline-samples", "3",
    "--active-samples", "3",
    "--sample-interval-ms", "5",
    "--sampler-interval-ms", "5",
    "--max-p95-increase-ratio", "5",
    "--cleanup-timeout-ms", "1000",
    "--timeout-ms", "10000",
    ...extra,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, FAKE_PERF_STATE: fixture.statePath, ...env },
  });
}

function artifact(fixture) {
  return JSON.parse(readFileSync(fixture.outputPath, "utf8"));
}

test("execute requires immutable clone provenance before wake", () => {
  const fixture = createFixture();
  const result = runGate(fixture, ["--execute"], { includeProvenance: false });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).failures[0].code, "CLONE_PROVENANCE_REQUIRED");
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("execute rejects a tampered clone provenance artifact before wake", () => {
  const fixture = createFixture();
  const provenance = JSON.parse(readFileSync(fixture.provenancePath, "utf8"));
  provenance.workload.repoId = "repo-tampered";
  writeFileSync(fixture.provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).failures[0].code, "CLONE_PROVENANCE_DIGEST_MISMATCH");
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("execute rejects provenance that identifies the source database as its clone", () => {
  const fixture = createFixture();
  rewriteProvenance(fixture.provenancePath, (provenance) => {
    const cloneStat = statSync(fixture.dbPath);
    provenance.source.path = realpathSync(fixture.dbPath);
    provenance.source.dev = cloneStat.dev;
    provenance.source.ino = cloneStat.ino;
  });
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).failures[0].code, "CLONE_PROVENANCE_SOURCE_TARGET_COLLISION");
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("execute rejects clone bytes that no longer match immutable provenance", () => {
  const fixture = createFixture();
  sqlite(fixture.dbPath, "CREATE TABLE post_clone_tamper(value TEXT);");
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).failures[0].code, "CLONE_PROVENANCE_DB_HASH_MISMATCH");
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("execute proves worker identity and requires every latency sample to overlap real progress", () => {
  const fixture = createFixture();
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.equal(report.status, "PASS");
  assert.equal(report.worker.identityProof.verified, true);
  assert.equal(report.worker.identityProof.dbPathVerified, true);
  assert.equal(report.worker.identityProof.runtimeIdentityVerified, true);
  assert.equal(report.latency.graph.active.overlappedSamples, 3);
  assert.equal(report.latency.lexical.active.overlappedSamples, 3);
  assert.ok(report.latency.graph.active.windows.every((sample) => sample.writeOverlap === true));
  assert.ok(report.latency.lexical.active.windows.every((sample) => sample.writeOverlap === true));
  assert.equal(report.cleanup.proven, true);
});

test("execute binds a production manifest without top-level modelHash to the generation model", () => {
  const fixture = createFixture({ includeManifestModelHash: false });
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.equal(report.worker.identityProof.expected.modelHash, "b".repeat(64));
  assert.equal(report.inputs.cloneProvenanceDigest.length, 64);
});

test("high-load execute remains deterministic across three independent clone fixtures", () => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const fixture = createFixture({ expected: 180, progressIntervalMs: 8, baselineDelayMs: 40, activeDelayMs: 35 });
    const result = runGate(fixture, ["--execute"]);
    assert.equal(result.status, 0, `attempt ${attempt}: ${result.stderr || result.stdout}`);
    const report = artifact(fixture);
    assert.equal(report.status, "PASS", `attempt ${attempt}`);
    assert.equal(report.generation.final.ready, 180, `attempt ${attempt}`);
    assert.equal(report.latency.graph.active.overlappedSamples, 3, `attempt ${attempt}`);
    assert.equal(report.latency.lexical.active.overlappedSamples, 3, `attempt ${attempt}`);
    assert.equal(report.cleanup.proven, true, `attempt ${attempt}`);
  }
});

test("wake PID must equal the lease and runtime PID", () => {
  const fixture = createFixture({ wakePidOffset: 100_000 });
  const result = runGate(fixture, ["--execute", "--timeout-ms", "3000"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.ok(report.failures.some((failure) => failure.code === "WORKER_IDENTITY_UNPROVEN"));
  assert.equal(report.worker.identityProof.wakePidVerified, false);
});

test("manifest fileHashes bind the exact Node and CLI bytes", () => {
  const fixture = createFixture();
  const manifest = JSON.parse(readFileSync(fixture.runtimeManifestPath, "utf8"));
  manifest.fileHashes = { node: "0".repeat(64), "fake-worker.mjs": "1".repeat(64) };
  writeFileSync(fixture.runtimeManifestPath, JSON.stringify(manifest));
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(artifact(fixture).failures.some((failure) => failure.code === "RUNTIME_FILE_HASH_MISMATCH"));
});

test("empty Graph focus and empty lexical hits are rejected", () => {
  const graphFixture = createFixture({ graphResponse: "empty" });
  const graphResult = runGate(graphFixture, ["--execute"]);
  assert.equal(graphResult.status, 1, graphResult.stderr || graphResult.stdout);
  assert.ok(artifact(graphFixture).failures.some((failure) => failure.code === "GRAPH_QUERY_INVALID"));

  const lexicalFixture = createFixture({ lexicalResponse: "empty" });
  const lexicalResult = runGate(lexicalFixture, ["--execute"]);
  assert.equal(lexicalResult.status, 1, lexicalResult.stderr || lexicalResult.stdout);
  assert.ok(artifact(lexicalFixture).failures.some((failure) => failure.code === "LEXICAL_QUERY_INVALID"));
});

test("cross-repository Graph and lexical responses are rejected", () => {
  const graphFixture = createFixture({ graphResponse: "wrong-repo" });
  const graphResult = runGate(graphFixture, ["--execute"]);
  assert.equal(graphResult.status, 1, graphResult.stderr || graphResult.stdout);
  assert.ok(artifact(graphFixture).failures.some((failure) => failure.code === "GRAPH_QUERY_SCOPE_MISMATCH"));

  const lexicalFixture = createFixture({ lexicalResponse: "wrong-repo" });
  const lexicalResult = runGate(lexicalFixture, ["--execute"]);
  assert.equal(lexicalResult.status, 1, lexicalResult.stderr || lexicalResult.stdout);
  assert.ok(artifact(lexicalFixture).failures.some((failure) => failure.code === "LEXICAL_QUERY_SCOPE_MISMATCH"));
});

test("overall timeout bounds an in-flight query and late completion still fails", () => {
  const fixture = createFixture({ baselineDelayMs: 5, activeDelayMs: 1500, progressIntervalMs: 20 });
  const started = Date.now();
  const result = runGate(fixture, ["--execute", "--timeout-ms", "250", "--query-timeout-ms", "5000"]);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(artifact(fixture).failures.some((failure) => failure.code === "MEASUREMENT_TIMEOUT"));
  assert.ok(elapsed < 1200, `hard timeout took ${elapsed}ms`);
});

test("an unverified wake-owned PID is cleaned through canonical pause", () => {
  const fixture = createFixture({ workerMode: "stalled", statusPidOffset: 100_000 });
  const result = runGate(fixture, ["--execute", "--timeout-ms", "350"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.equal(report.cleanup.pid, state.workerPid);
  assert.equal(report.cleanup.method, "canonical_pause");
  assert.equal(report.cleanup.proven, true);
  assert.equal(isAlive(state.workerPid), false);
});

test("idle PID plus a later bulk update fails worker authenticity", () => {
  const fixture = createFixture({ workerMode: "spoof" });
  const result = runGate(fixture, ["--execute", "--timeout-ms", "1200"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.ok(report.failures.some((failure) => failure.code === "WORKER_IDENTITY_UNPROVEN"));
  assert.equal(report.worker.identityProof.dbPathVerified, false);
  assert.equal(report.cleanup.proven, true);
});

test("authentic bulk update outside most queries fails overlap sampling", () => {
  const fixture = createFixture({ workerMode: "bulk", expected: 24 });
  const result = runGate(fixture, ["--execute", "--timeout-ms", "1500"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(artifact(fixture).failures.some((failure) => failure.code === "ACTIVE_WRITE_OVERLAP_INSUFFICIENT"));
});

test("continuous sampler catches a transient WAL peak during a blocking query", () => {
  const fixture = createFixture({ transientWalBytes: 1024 * 1024, activeDelayMs: 100, progressIntervalMs: 90 });
  const result = runGate(fixture, ["--execute", "--max-peak-wal-bytes", "65536"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.ok(
    report.failures.some((failure) => failure.code === "PEAK_WAL_EXCEEDED"),
    JSON.stringify({ failures: report.failures, storage: report.storage, sampler: report.sampler }),
  );
  assert.ok(report.storage.peakWalBytes >= 1024 * 1024);
  assert.ok(report.sampler.samples > 0);
  assert.equal(report.sampler.joined, true);
  assert.match(report.sampler.limitation, /polling/u);
});

test("continuous sampler fails a verified worker whose RSS exceeds the limit", () => {
  const fixture = createFixture({ rssMegabytes: 96, activeDelayMs: 90, progressIntervalMs: 35 });
  const result = runGate(fixture, ["--execute", "--max-peak-rss-bytes", String(32 * 1024 * 1024)]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.ok(report.failures.some((failure) => failure.code === "PEAK_RSS_EXCEEDED"), JSON.stringify({ failures: report.failures, worker: report.worker, sampler: report.sampler }));
  assert.ok(report.worker.peakRssBytes > 32 * 1024 * 1024);
  assert.ok(report.worker.rssSamples > 0);
});

test("active query latency regression is a direct gate failure", () => {
  const fixture = createFixture({ baselineDelayMs: 10, activeDelayMs: 120, progressIntervalMs: 30 });
  const result = runGate(fixture, ["--execute", "--max-p95-increase-ratio", "0.2"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const failures = artifact(fixture).failures.map((failure) => failure.code);
  assert.ok(failures.includes("GRAPH_P95_REGRESSION") || failures.includes("LEXICAL_P95_REGRESSION"));
});

test("timeout pauses the worker awakened by the gate and leaves no orphan", () => {
  const fixture = createFixture({ workerMode: "stalled" });
  const result = runGate(fixture, ["--execute", "--timeout-ms", "350"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.ok(report.failures.some((failure) => failure.code === "MEASUREMENT_TIMEOUT"));
  assert.equal(report.cleanup.method, "canonical_pause");
  assert.equal(report.cleanup.proven, true);
  assert.equal(state.pauseCount, 1);
  assert.equal(isAlive(state.workerPid), false);
});

test("an already-running worker is not owned, paused, or killed", () => {
  const fixture = createFixture({ workerMode: "stalled" });
  execFileSync(fixture.launcherPath, ["semantic", "wake", "--json"], { env: { ...process.env, FAKE_PERF_STATE: fixture.statePath } });
  waitSync(120);
  const before = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  const result = runGate(fixture, ["--execute", "--timeout-ms", "300"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  const after = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.equal(report.failures[0].code, "CLONE_PROVENANCE_DB_HASH_MISMATCH");
  assert.equal(after.pauseCount, 0);
  assert.equal(after.wakeCount, before.wakeCount, "gate must fail before issuing another wake");
  assert.equal(isAlive(before.workerPid), true);
});

test("amplification is generation-specific and excludes another repository", () => {
  const fixture = createFixture({ secondRepoVectorBytes: 2 * 1024 * 1024 });
  const result = runGate(fixture, ["--execute", "--max-semantic-amplification", "10"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.equal(report.storage.semanticStorageScope, "generation-delta");
  assert.equal(report.storage.generationId, "generation-1");
  assert.equal(report.storage.baseline.vectorRows, 0);
  assert.equal(report.storage.final.vectorRows, 48);
  assert.ok(report.storage.actualSemanticGrowthBytes < 2 * 1024 * 1024, "pre-existing other-repo vector bytes must not enter the delta");
  assert.ok(report.storage.objectGrowth.some((row) => row.name === "semantic_vector_values" && row.payloadBytesDelta > 0));
  assert.ok(report.storage.objectGrowth.some((row) => row.name === "vec_embeddings_fixture_chunks" && row.payloadBytesDelta > 0));
});

test("actual SQLite allocation and sidecar growth can fail where a vector formula would undercount", () => {
  const fixture = createFixture();
  const result = runGate(fixture, ["--execute", "--max-semantic-amplification", "2"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = artifact(fixture);
  assert.ok(report.failures.some((failure) => failure.code === "SEMANTIC_STORAGE_AMPLIFICATION_EXCEEDED"));
  assert.ok(report.storage.actualSemanticGrowthBytes > report.storage.payloadGrowthBytes);
  assert.match(report.storage.measurementMethod, /dbstat/u);
});

test("terminal failures are a direct gate failure", () => {
  const fixture = createFixture({ terminal: true, expected: 12 });
  const result = runGate(fixture, ["--execute", "--timeout-ms", "700"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(artifact(fixture).failures.some((failure) => failure.code === "TERMINAL_JOBS_PRESENT"));
});

test("duplicate generation refs are a direct gate failure", () => {
  const fixture = createFixture({ duplicate: true });
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(artifact(fixture).failures.some((failure) => failure.code === "DUPLICATE_REFS_PRESENT"));
});

test("default mode is read-only and does not wake or write an artifact", () => {
  const fixture = createFixture();
  const result = runGate(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(fixture.outputPath), false);
  assert.equal(JSON.parse(result.stdout).status, "DRY_RUN");
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("unknown options fail before wake", () => {
  const fixture = createFixture();
  const result = runGate(fixture, ["--execute", "--max-peak-rss-btyes", "1"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(JSON.parse(result.stdout).failures[0].message, /INVALID_ARGUMENT: unknown option/);
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("an existing artifact is never overwritten and prevents wake", () => {
  const fixture = createFixture();
  writeFileSync(fixture.outputPath, "operator-owned\n");
  const result = runGate(fixture, ["--execute"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(readFileSync(fixture.outputPath, "utf8"), "operator-owned\n");
  assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).wakeCount, 0);
});

test("default launcher resolves ~/.local/bin/penguin", () => {
  const fixture = createFixture();
  const stableDirectory = join(fixture.directory, ".local", "bin");
  mkdirSync(stableDirectory, { recursive: true });
  const stableLauncher = join(stableDirectory, "penguin");
  symlinkSync(fixture.launcherPath, stableLauncher);
  const result = runGate(fixture, [], { includeLauncher: false, env: { HOME: fixture.directory } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).inputs.launcher, stableLauncher);
});

test("package-run double-dash separator is accepted", () => {
  const fixture = createFixture();
  const result = spawnSync(process.execPath, [GATE, "--",
    "--db", fixture.dbPath,
    "--repo", "FPMS-NT",
    "--launcher", fixture.launcherPath,
    "--runtime-manifest", fixture.runtimeManifestPath,
  ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FAKE_PERF_STATE: fixture.statePath } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "DRY_RUN");
});
