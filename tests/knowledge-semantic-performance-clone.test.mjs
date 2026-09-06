import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "scripts", "knowledge-semantic-performance-clone.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sql(dbPath, statement) {
  return execFileSync("sqlite3", ["-cmd", ".timeout 5000", dbPath, statement], { encoding: "utf8" }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture({ includeManifestModelHash = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-clone-"));
  temporaryDirectories.push(directory);
  const sourceDb = join(directory, "source.db");
  const targetDb = join(directory, "clone.db");
  const output = join(directory, "clone-provenance.json");
  const runtime = join(directory, "runtime");
  mkdirSync(runtime);
  symlinkSync(process.execPath, join(runtime, "node"));
  writeFileSync(join(runtime, "penguin.mjs"), "fixture-cli\n");
  const manifest = {
    schemaVersion: 1,
    ready: true,
    buildId: "clone-fixture-build",
    capabilityHash: "a".repeat(64),
    contractSchemaVersion: 18,
    nodePath: "node",
    cliEntry: "penguin.mjs",
    fileHashes: {},
  };
  if (includeManifestModelHash) manifest.modelHash = "b".repeat(64);
  writeFileSync(join(runtime, "manifest.json"), JSON.stringify(manifest));
  sql(sourceDb, `
    PRAGMA journal_mode=WAL;
    PRAGMA user_version=18;
    CREATE TABLE repos(id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE semantic_chunks(
      id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,source_blob_id INTEGER,node_id TEXT,repo_id TEXT,
      snapshot_id TEXT,canonical_file_path TEXT,identity_hash TEXT,chunker_version TEXT,start_byte INTEGER,
      end_byte INTEGER,chunk_kind TEXT NOT NULL,text_hash TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE embedding_spaces(
      id TEXT PRIMARY KEY,identity_hash TEXT NOT NULL,provider_id TEXT,model_id TEXT,weights_digest TEXT,
      tokenizer_digest TEXT,preprocessing_digest TEXT,dimensions INTEGER,pooling TEXT,normalization TEXT,
      chunker_version TEXT,created_at TEXT
    );
    CREATE TABLE embedding_generations(
      id TEXT PRIMARY KEY,space_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,scope_key TEXT NOT NULL,status TEXT NOT NULL,
      expected_chunks INTEGER NOT NULL,created_at TEXT NOT NULL,activated_at TEXT,retired_at TEXT,failure_reason TEXT,
      UNIQUE(space_id,snapshot_id,scope_key)
    );
    CREATE TABLE embedding_jobs(
      id TEXT PRIMARY KEY,generation_id TEXT NOT NULL,chunk_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,
      error TEXT,lease_owner TEXT,lease_expires_at TEXT,next_attempt_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(generation_id,chunk_id)
    );
    INSERT INTO repos VALUES('repo-1','FPMS-NT','/fixture/FPMS-NT');
    INSERT INTO meta VALUES('schema_version','18');
    INSERT INTO embedding_spaces VALUES('space-1','${"b".repeat(64)}','nomic','nomic',
      '${"1".repeat(64)}','${"2".repeat(64)}','${"3".repeat(64)}',768,'mean','l2','v1','2026-09-01T00:00:00.000Z');
    INSERT INTO embedding_generations VALUES('active-1','space-1','snapshot-1','repo:repo-1','active',3,
      '2026-09-01T00:00:00.000Z','2026-09-01T00:01:00.000Z',NULL,NULL);
    INSERT INTO semantic_chunks VALUES
      ('chunk-1','c1',1,'node-1','repo-1','snapshot-1','a.ts','i1','v1',0,100,'symbol','t1','2026-09-01T00:00:00.000Z'),
      ('chunk-2','c2',1,'node-2','repo-1','snapshot-1','b.ts','i2','v1',100,200,'symbol','t2','2026-09-01T00:00:00.000Z'),
      ('chunk-3','c3',1,'node-3','repo-1','snapshot-1','c.ts','i3','v1',200,300,'symbol','t3','2026-09-01T00:00:00.000Z');
    INSERT INTO embedding_jobs VALUES
      ('job-1','active-1','chunk-1','ready',1,NULL,NULL,NULL,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:01.000Z'),
      ('job-2','active-1','chunk-2','ready',1,NULL,NULL,NULL,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:01.000Z'),
      ('job-3','active-1','chunk-3','ready',1,NULL,NULL,NULL,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:01.000Z');
  `);
  return { directory, sourceDb, targetDb, output, manifest: join(runtime, "manifest.json") };
}

function runHarness(value, extra = []) {
  return spawnSync(process.execPath, [HARNESS,
    "--source-db", value.sourceDb,
    "--target-db", value.targetDb,
    "--repo", "FPMS-NT",
    "--runtime-manifest", value.manifest,
    "--output", value.output,
    ...extra,
  ], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
}

test("production manifest without modelHash binds its content hash and active generation model", () => {
  const value = fixture({ includeManifestModelHash: false });
  const result = runHarness(value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(readFileSync(value.output, "utf8"));
  assert.equal(artifact.runtime.modelHash, "b".repeat(64));
  assert.equal(artifact.runtime.modelHashSource, "active-generation");
  assert.equal(artifact.runtime.manifestSha256, sha256(value.manifest));
  assert.equal(artifact.source.logicalHashMethod, "readonly-backup-dump-v1");
  assert.equal(artifact.source.logicalHashCheckpoint, "sqlite-online-backup-from-readonly-source");
  assert.equal(artifact.safety.sourceOpenedReadOnly, true);
});

test("creates a consistent WAL-aware clone and stages fresh clone-only jobs", () => {
  const value = fixture();
  const sourceHashBefore = sha256(value.sourceDb);
  const result = runHarness(value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(sha256(value.sourceDb), sourceHashBefore);
  assert.equal(sql(value.sourceDb, "SELECT COUNT(*) FROM embedding_generations WHERE status='staging';"), "0");
  assert.equal(sql(value.targetDb, "PRAGMA quick_check;"), "ok");
  assert.equal(sql(value.targetDb, "PRAGMA integrity_check;"), "ok");
  assert.equal(sql(value.targetDb, "SELECT COUNT(*) FROM embedding_generations WHERE status='staging';"), "1");
  assert.equal(sql(value.targetDb, "SELECT COUNT(*) FROM embedding_jobs WHERE status='pending';"), "3");
  assert.equal(sql(value.targetDb, "SELECT COUNT(*) FROM semantic_chunks WHERE id LIKE 'perf_%';"), "3");
  const artifact = JSON.parse(readFileSync(value.output, "utf8"));
  assert.equal(artifact.status, "READY");
  assert.equal(artifact.source.logicalHashBefore, artifact.clone.backupLogicalHash);
  assert.equal(artifact.source.logicalHashBefore, artifact.source.logicalHashAfter);
  assert.equal(artifact.clone.backupLogicalHashMethod, artifact.source.logicalHashMethod);
  assert.equal(artifact.clone.backupLogicalHashCheckpoint, artifact.source.logicalHashCheckpoint);
  assert.equal(artifact.clone.quickCheck, "ok");
  assert.equal(artifact.clone.integrityCheck, "ok");
  assert.equal(artifact.workload.expectedChunks, 3);
  assert.match(artifact.artifactDigest, /^[a-f0-9]{64}$/u);
  assert.equal(statSync(value.output).mode & 0o777, 0o400, "provenance artifact must be owner-read-only");
});

test("refuses to use the source path or an existing target", () => {
  const same = fixture();
  same.targetDb = same.sourceDb;
  const sameResult = runHarness(same);
  assert.equal(sameResult.status, 1, sameResult.stderr || sameResult.stdout);
  assert.match(sameResult.stdout, /CLONE_TARGET_IS_SOURCE/u);

  const existing = fixture();
  writeFileSync(existing.targetDb, "operator-owned\n");
  const existingResult = runHarness(existing);
  assert.equal(existingResult.status, 1, existingResult.stderr || existingResult.stdout);
  assert.equal(readFileSync(existing.targetDb, "utf8"), "operator-owned\n");
  assert.match(existingResult.stdout, /CLONE_TARGET_ALREADY_EXISTS/u);
});

test("refuses to overwrite an existing provenance artifact before cloning", () => {
  const value = fixture();
  writeFileSync(value.output, "operator-owned\n");
  const result = runHarness(value);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(readFileSync(value.output, "utf8"), "operator-owned\n");
  assert.equal(existsSync(value.targetDb), false);
});
