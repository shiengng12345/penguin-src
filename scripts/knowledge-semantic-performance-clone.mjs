#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024;
const LOGICAL_DIGEST_METHOD = "readonly-backup-dump-v1";
const LOGICAL_DIGEST_CHECKPOINT = "sqlite-online-backup-from-readonly-source";

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(["source-db", "target-db", "repo", "runtime-manifest", "output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`INVALID_ARGUMENT: unexpected ${argument}`);
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new Error(`INVALID_ARGUMENT: unknown option --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`INVALID_ARGUMENT: --${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`INVALID_ARGUMENT: --${name} is required`);
    return value;
  };
  return {
    sourceDb: resolve(required("source-db")), targetDb: resolve(required("target-db")),
    repo: required("repo"), runtimeManifest: resolve(required("runtime-manifest")), output: resolve(required("output")),
  };
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * MIB,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`PROCESS_FAILED: ${command} ${JSON.stringify(args)}: ${detail}`);
  }
}

function quoteSql(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function sqlite(dbPath, sql, { readonly = false, json = false } = {}) {
  const args = [...(readonly ? ["-readonly"] : []), "-cmd", ".timeout 10000", ...(json ? ["-json"] : []), dbPath, sql];
  const output = run("sqlite3", args).trim();
  if (!json) return output;
  return output ? JSON.parse(output) : [];
}

async function dumpHash(dbPath) {
  return await new Promise((resolvePromise, rejectPromise) => {
    // The input is always the disposable backup snapshot created by
    // logicalHash(), never the live source database. A normal connection is
    // required here because a freshly-created WAL database has no initialized
    // -shm state yet; asking sqlite3 to dump it in read-only mode can emit a
    // synthetic "unable to open database file" row instead of the database.
    const child = spawn("sqlite3", ["-cmd", ".timeout 10000", dbPath, ".dump"], { stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let stderr = "";
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.once("error", (error) => rejectPromise(new Error(`CLONE_LOGICAL_HASH_UNAVAILABLE: ${error.message}`)));
    child.once("close", (code) => code === 0
      ? resolvePromise(hash.digest("hex"))
      : rejectPromise(new Error(`CLONE_LOGICAL_HASH_UNAVAILABLE: ${stderr.trim() || `sqlite exit ${code}`}`)));
  });
}

function backupDatabase(sourcePath, destinationPath) {
  const readOnlySourceUri = `${pathToFileURL(sourcePath).href}?mode=ro`;
  const escapedDestination = destinationPath.replaceAll('"', '""');
  // The source connection is explicitly read-only. SQLite's online backup
  // takes one consistent snapshot, including committed WAL frames, without
  // asking the source process to checkpoint or mutate the live database.
  run("sqlite3", [
    "-cmd", ".timeout 10000", readOnlySourceUri, `.backup "${escapedDestination}"`,
  ]);
}

async function logicalHash(dbPath, requiredMethod = LOGICAL_DIGEST_METHOD) {
  if (requiredMethod !== LOGICAL_DIGEST_METHOD) throw new Error(`CLONE_LOGICAL_HASH_METHOD_UNSUPPORTED: ${requiredMethod}`);
  const digestDirectory = mkdtempSync(join(tmpdir(), "penguin-clone-logical-digest-"));
  const snapshotPath = join(digestDirectory, "snapshot.db");
  try {
    backupDatabase(dbPath, snapshotPath);
    return {
      method: LOGICAL_DIGEST_METHOD,
      checkpoint: LOGICAL_DIGEST_CHECKPOINT,
      hash: await dumpHash(snapshotPath),
    };
  } finally {
    rmSync(digestDirectory, { recursive: true, force: true });
  }
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function fnvManifestHash(relativePath, bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.concat([Buffer.from(relativePath), bytes])) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function verifyRuntime(path) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`RUNTIME_MANIFEST_INVALID: ${error.message}`); }
  if (manifest?.schemaVersion !== 1 || manifest?.ready !== true || typeof manifest.buildId !== "string"
    || !/^[a-f0-9]{64}$/iu.test(manifest.capabilityHash ?? "")
    || (manifest.modelHash != null && !/^[a-f0-9]{64}$/iu.test(manifest.modelHash))
    || !Number.isInteger(manifest.contractSchemaVersion)
    || typeof manifest.nodePath !== "string" || typeof manifest.cliEntry !== "string") {
    throw new Error("RUNTIME_MANIFEST_INVALID: identity fields are missing");
  }
  const root = dirname(path);
  const verifiedFiles = [];
  for (const relativePath of [manifest.nodePath, manifest.cliEntry]) {
    const absolute = resolve(root, relativePath);
    if (relativePath.startsWith("/") || relativePath.split(/[\\/]/u).includes("..") || !absolute.startsWith(`${resolve(root)}/`) || !existsSync(absolute)) {
      throw new Error(`RUNTIME_MANIFEST_INVALID: ${relativePath} is unavailable or escapes runtime root`);
    }
    const expected = manifest.fileHashes?.[relativePath];
    if (expected) {
      const bytes = readFileSync(absolute);
      const actual = expected.length === 16
        ? fnvManifestHash(relativePath.replaceAll("\\", "/"), bytes)
        : createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== String(expected).toLowerCase()) throw new Error(`RUNTIME_FILE_HASH_MISMATCH: ${relativePath}`);
      verifiedFiles.push({ path: relativePath, hash: actual });
    }
  }
  return {
    manifestPath: path, buildId: manifest.buildId, capabilityHash: manifest.capabilityHash,
    schemaVersion: manifest.contractSchemaVersion, modelHash: manifest.modelHash ?? null,
    manifestSha256: sha256File(path), verifiedFiles,
  };
}

function sourceIdentity(path) {
  const stat = statSync(path);
  return { path: realpathSync(path), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function schemaVersion(dbPath) {
  const rows = sqlite(dbPath, "SELECT value FROM meta WHERE key='schema_version' LIMIT 1;", { readonly: true, json: true });
  const meta = Number(rows[0]?.value);
  const pragma = Number(sqlite(dbPath, "PRAGMA user_version;", { readonly: true }));
  return Number.isInteger(meta) && meta > 0 ? meta : pragma;
}

function prepareWorkload(dbPath, repoName, token) {
  const repos = sqlite(dbPath, `SELECT id,name FROM repos WHERE id=${quoteSql(repoName)} OR name=${quoteSql(repoName)} COLLATE NOCASE;`, { readonly: true, json: true });
  if (repos.length !== 1) throw new Error(repos.length === 0 ? `REPOSITORY_NOT_FOUND: ${repoName}` : `REPOSITORY_AMBIGUOUS: ${repoName}`);
  const repo = repos[0];
  const scopeKey = `repo:${repo.id}`;
  const staging = Number(sqlite(dbPath, `SELECT COUNT(*) FROM embedding_generations WHERE scope_key=${quoteSql(scopeKey)} AND status='staging';`, { readonly: true }));
  if (staging !== 0) throw new Error("CLONE_STAGING_ALREADY_PRESENT: clone must start from a stable active generation");
  const active = sqlite(dbPath, `
    SELECT g.id,g.space_id AS spaceId,g.snapshot_id AS snapshotId,g.expected_chunks AS expected,
           s.identity_hash AS modelHash
      FROM embedding_generations g JOIN embedding_spaces s ON s.id=g.space_id
     WHERE g.scope_key=${quoteSql(scopeKey)} AND g.status='active'
     ORDER BY g.activated_at DESC,g.created_at DESC LIMIT 1;
  `, { readonly: true, json: true });
  if (active.length !== 1) throw new Error(`ACTIVE_GENERATION_REQUIRED: ${repo.name}`);
  const baseline = active[0];
  const expected = Number(sqlite(dbPath, `SELECT COUNT(DISTINCT chunk_id) FROM embedding_jobs WHERE generation_id=${quoteSql(baseline.id)};`, { readonly: true }));
  if (!(expected > 0) || expected !== Number(baseline.expected)) throw new Error("CLONE_WORKLOAD_INCOMPLETE: active generation chunk count is not exact");
  const compact = token.replaceAll("-", "").slice(0, 20);
  const generationId = `perf_generation_${compact}`;
  const snapshotId = `perf_snapshot_${compact}`;
  const now = new Date().toISOString();
  sqlite(dbPath, `
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE perf_chunk_map(old_id TEXT PRIMARY KEY,new_id TEXT NOT NULL UNIQUE);
    INSERT INTO perf_chunk_map(old_id,new_id)
      SELECT j.chunk_id,'perf_${compact}_' || printf('%08d',ROW_NUMBER() OVER (ORDER BY j.chunk_id))
        FROM embedding_jobs j WHERE j.generation_id=${quoteSql(baseline.id)} GROUP BY j.chunk_id ORDER BY j.chunk_id;
    INSERT INTO semantic_chunks(
      id,content_hash,source_blob_id,node_id,repo_id,snapshot_id,canonical_file_path,identity_hash,
      chunker_version,start_byte,end_byte,chunk_kind,text_hash,created_at
    )
      SELECT m.new_id,c.content_hash,c.source_blob_id,c.node_id,c.repo_id,${quoteSql(snapshotId)},c.canonical_file_path,
             COALESCE(c.identity_hash,c.id) || ':perf:${compact}',c.chunker_version,c.start_byte,c.end_byte,c.chunk_kind,c.text_hash,${quoteSql(now)}
        FROM perf_chunk_map m JOIN semantic_chunks c ON c.id=m.old_id;
    INSERT INTO embedding_generations(
      id,space_id,snapshot_id,scope_key,status,expected_chunks,created_at,activated_at,retired_at,failure_reason
    ) VALUES(${quoteSql(generationId)},${quoteSql(baseline.spaceId)},${quoteSql(snapshotId)},${quoteSql(scopeKey)},'staging',${expected},${quoteSql(now)},NULL,NULL,NULL);
    INSERT INTO embedding_jobs(
      id,generation_id,chunk_id,status,attempts,error,lease_owner,lease_expires_at,next_attempt_at,created_at,updated_at
    )
      SELECT 'perf_job_${compact}_' || printf('%08d',ROW_NUMBER() OVER (ORDER BY new_id)),${quoteSql(generationId)},new_id,
             'pending',0,NULL,NULL,NULL,NULL,${quoteSql(now)},${quoteSql(now)} FROM perf_chunk_map ORDER BY new_id;
    DROP TABLE perf_chunk_map;
    COMMIT;
  `);
  const proof = sqlite(dbPath, `
    SELECT g.id,g.scope_key AS scopeKey,g.status,g.expected_chunks AS expected,
           SUM(j.status='pending') AS pending,COUNT(DISTINCT j.chunk_id) AS distinctChunks,
           SUM(c.id LIKE 'perf_${compact}_%') AS freshChunks
      FROM embedding_generations g JOIN embedding_jobs j ON j.generation_id=g.id JOIN semantic_chunks c ON c.id=j.chunk_id
     WHERE g.id=${quoteSql(generationId)} GROUP BY g.id;
  `, { readonly: true, json: true })[0];
  if (proof?.status !== "staging" || Number(proof.expected) !== expected || Number(proof.pending) !== expected
    || Number(proof.distinctChunks) !== expected || Number(proof.freshChunks) !== expected) {
    throw new Error("CLONE_WORKLOAD_PROOF_FAILED: fresh staging rows are incomplete");
  }
  if (!/^[a-f0-9]{64}$/iu.test(baseline.modelHash ?? "")) throw new Error("CLONE_WORKLOAD_MODEL_INVALID: active generation model identity is missing");
  return {
    repoId: repo.id, repoName: repo.name, scopeKey, baselineGenerationId: baseline.id,
    generationId, snapshotId, expectedChunks: expected, modelHash: baseline.modelHash,
  };
}

function artifactDigest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function main() {
  let options;
  let targetCreated = false;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!existsSync(options.sourceDb)) throw new Error(`SOURCE_DB_NOT_FOUND: ${options.sourceDb}`);
    if (!existsSync(options.runtimeManifest)) throw new Error(`RUNTIME_MANIFEST_NOT_FOUND: ${options.runtimeManifest}`);
    if (existsSync(options.output)) throw new Error(`CLONE_ARTIFACT_ALREADY_EXISTS: ${options.output}`);
    if (!existsSync(dirname(options.targetDb)) || !existsSync(dirname(options.output))) throw new Error("OUTPUT_DIRECTORY_NOT_FOUND: target and artifact parents must exist");
    const source = sourceIdentity(options.sourceDb);
    if (resolve(options.targetDb) === resolve(options.sourceDb)) throw new Error("CLONE_TARGET_IS_SOURCE: target path equals source database");
    if (existsSync(options.targetDb)) {
      const target = sourceIdentity(options.targetDb);
      if (target.dev === source.dev && target.ino === source.ino) throw new Error("CLONE_TARGET_IS_SOURCE: target resolves to source inode");
      throw new Error(`CLONE_TARGET_ALREADY_EXISTS: ${options.targetDb}`);
    }
    let runtime = verifyRuntime(options.runtimeManifest);
    const sourceLogicalBefore = await logicalHash(options.sourceDb);
    const sourceSchemaVersion = schemaVersion(options.sourceDb);
    if (sourceSchemaVersion !== runtime.schemaVersion) throw new Error(`CLONE_SCHEMA_RUNTIME_MISMATCH: database=${sourceSchemaVersion}, runtime=${runtime.schemaVersion}`);
    // URI mode=ro applies only to the source connection, while SQLite's online
    // backup API can create the destination and capture committed WAL state.
    backupDatabase(options.sourceDb, options.targetDb);
    targetCreated = true;
    // SQLite preserves WAL mode in an online-backup destination. Open the
    // clone once before taking its read-only digest so SQLite can initialize
    // the clone-owned -wal/-shm sidecars; this never opens the live source for
    // writing and does not alter any clone rows.
    sqlite(options.targetDb, "SELECT 1;");
    const sourceLogicalAfter = await logicalHash(options.sourceDb, sourceLogicalBefore.method);
    const cloneBackupLogical = await logicalHash(options.targetDb, sourceLogicalBefore.method);
    if (sourceLogicalBefore.hash !== sourceLogicalAfter.hash) throw new Error("CLONE_SOURCE_CHANGED: source logical digest changed during clone");
    if (sourceLogicalBefore.hash !== cloneBackupLogical.hash) throw new Error("CLONE_BACKUP_MISMATCH: backup logical digest differs from the source snapshot");
    const quickCheck = sqlite(options.targetDb, "PRAGMA quick_check;", { readonly: true });
    const integrityCheck = sqlite(options.targetDb, "PRAGMA integrity_check;", { readonly: true });
    if (quickCheck !== "ok" || integrityCheck !== "ok") throw new Error("CLONE_INTEGRITY_FAILED: SQLite validation did not return ok");
    const workload = prepareWorkload(options.targetDb, options.repo, randomUUID());
    if (runtime.modelHash != null && runtime.modelHash !== workload.modelHash) {
      throw new Error("CLONE_RUNTIME_MODEL_MISMATCH: manifest model does not match the active generation");
    }
    runtime = {
      ...runtime,
      modelHash: workload.modelHash,
      modelHashSource: runtime.modelHash == null ? "active-generation" : "manifest",
    };
    const preparedQuickCheck = sqlite(options.targetDb, "PRAGMA quick_check;", { readonly: true });
    const preparedIntegrityCheck = sqlite(options.targetDb, "PRAGMA integrity_check;", { readonly: true });
    if (preparedQuickCheck !== "ok" || preparedIntegrityCheck !== "ok") throw new Error("CLONE_PREPARED_INTEGRITY_FAILED: staged clone is not valid");
    const payload = {
      schemaVersion: 1, kind: "penguin-semantic-performance-clone", status: "READY", createdAt: new Date().toISOString(),
      source: {
        ...source, schemaVersion: sourceSchemaVersion, logicalHashMethod: sourceLogicalBefore.method,
        logicalHashCheckpoint: sourceLogicalBefore.checkpoint,
        logicalHashBefore: sourceLogicalBefore.hash, logicalHashAfter: sourceLogicalAfter.hash,
      },
      clone: {
        path: realpathSync(options.targetDb), backupLogicalHash: cloneBackupLogical.hash,
        backupLogicalHashMethod: cloneBackupLogical.method,
        backupLogicalHashCheckpoint: cloneBackupLogical.checkpoint,
        preparedLogicalHash: (await logicalHash(options.targetDb, sourceLogicalBefore.method)).hash,
        sha256: sha256File(options.targetDb), quickCheck: preparedQuickCheck, integrityCheck: preparedIntegrityCheck,
        backupIncludedWalState: true,
      },
      runtime, workload,
      safety: { sourceOpenedReadOnly: true, targetWasAbsent: true, sourceAndTargetDistinct: true, stagingCreatedOnlyOnClone: true },
    };
    const artifact = { ...payload, artifactDigest: artifactDigest(payload) };
    writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(options.output, 0o400);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    if (targetCreated && options?.targetDb && existsSync(options.targetDb)) rmSync(options.targetDb, { force: true });
    const failure = { schemaVersion: 1, kind: "penguin-semantic-performance-clone", status: "FAIL", failure: String(error.message) };
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
