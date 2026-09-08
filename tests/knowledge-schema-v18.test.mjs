import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import * as core from "../packages/knowledge-core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/knowledge-core/package.json", import.meta.url));
const Database = requireFromCore("better-sqlite3");

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-schema-v18-"));
  return core.KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

function journalMode(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return db.pragma("journal_mode", { simple: true }); }
  finally { db.close(); }
}

function manifestFileIdentity(path) {
  const stat = statSync(path);
  return {
    path,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function differentWellFormedProcessStartToken(token) {
  if (!token.startsWith("darwin-v2:")) return `${token}:different`;
  const identity = JSON.parse(Buffer.from(token.slice("darwin-v2:".length), "base64url").toString("utf8"));
  identity.commandSha256 = identity.commandSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  return `darwin-v2:${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
}

function encodedDarwinToken(identity) {
  return `darwin-v2:${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
}

test("revision endpoint traversal has covering indexes for both publication directions", () => {
  const store = freshStore();
  const indexes = new Set(
    store.db.prepare("PRAGMA index_list('resolved_edges')").all().map((row) => row.name),
  );
  assert.ok(indexes.has("idx_resolved_edges_set_type_src"), JSON.stringify([...indexes]));
  assert.ok(indexes.has("idx_resolved_edges_set_type_dst"), JSON.stringify([...indexes]));
  store.close();
});

test("identity resolution has both exact and case-insensitive covering indexes", () => {
  const store = freshStore();
  const indexes = new Set(
    store.db.prepare("PRAGMA index_list('nodes')").all().map((row) => row.name),
  );
  assert.ok(indexes.has("idx_nodes_identity"), JSON.stringify([...indexes]));
  assert.ok(indexes.has("idx_nodes_identity_nocase"), JSON.stringify([...indexes]));
  store.close();
});

function crashedOrphanAttemptFixture({ token, publisherPid } = {}) {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "before-publish");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const attemptManifestName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(`${basename(manifestPath)}.attempt-`) && name.endsWith(".tmp"));
  assert.ok(attemptManifestName);
  const attemptManifestPath = join(dirname(dbPath), attemptManifestName);
  const manifest = JSON.parse(readFileSync(attemptManifestPath, "utf8"));
  const originalPublisherPid = manifest.publisherPid;
  assert.throws(
    () => process.kill(originalPublisherPid, 0),
    (error) => error?.code === "ESRCH",
    "SIGKILL fixture PID must be observably dead before recovery",
  );
  const nextToken = typeof token === "function" ? token(manifest.publisherProcessStartToken) : token;
  manifest.publisherPid = publisherPid ?? originalPublisherPid;
  if (nextToken === undefined) delete manifest.publisherProcessStartToken;
  else manifest.publisherProcessStartToken = nextToken;
  writeFileSync(attemptManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const ownerPath = `${backupPath}.attempt-${manifest.attemptId}.owner.json`;
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.ownerPid = manifest.publisherPid;
  if (nextToken !== undefined) owner.ownerProcessStartToken = nextToken;
  owner.manifestIdentity = manifestFileIdentity(attemptManifestPath);
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  linkSync(attemptManifestPath, manifestPath);
  return {
    dbPath,
    manifestPath,
    attemptManifestPath,
    ownerPath,
    retainedAttemptManifest: readFileSync(attemptManifestPath),
    retainedPublishedManifest: readFileSync(manifestPath),
    retainedOwner: readFileSync(ownerPath),
  };
}

function assertOrphanCleanupFailsClosed(fixture, open = () => core.openDatabase(fixture.dbPath)) {
  assert.throws(open, (error) => error?.code === "SCHEMA_BACKUP_BUSY");
  assert.deepEqual(readFileSync(fixture.attemptManifestPath), fixture.retainedAttemptManifest);
  assert.deepEqual(readFileSync(fixture.manifestPath), fixture.retainedPublishedManifest);
  assert.deepEqual(readFileSync(fixture.ownerPath), fixture.retainedOwner);
  const source = new Database(fixture.dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
}

function spawnMigrationChild(dbPath) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import * as core from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
     process.stdout.write("READY\\n");
     try {
       const db = core.openDatabase(process.argv[1]);
       process.stdout.write(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value) + "\\n");
       db.close();
     } catch (error) {
       process.stderr.write(String(error?.code ?? error?.stack ?? error) + "\\n");
       process.exitCode = 1;
     }`,
    dbPath,
  ], { encoding: "utf8" });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.includes("READY\n")) reject(new Error(`migration child exited before ready: ${code}: ${stderr}`));
    });
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { ready, done };
}

function spawnBarrierMigrationChild(dbPath, readyPath, releasePath) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { existsSync, writeFileSync } from "node:fs";
     import * as core from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
     let released = false;
     try {
       const db = core.openDatabase(process.argv[1], {
         onSchemaMaintenance(event) {
           if (released || event.operation !== "schema-migration-backup" || event.phase !== "before-publish") return;
           writeFileSync(process.argv[2], "ready", { flag: "wx" });
           while (!existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
           released = true;
         },
       });
       process.stdout.write(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value) + "\\n");
       db.close();
     } catch (error) {
       process.stderr.write(String(error?.code ?? error?.stack ?? error) + "\\n");
       process.exitCode = 1;
     }`,
    dbPath,
    readyPath,
    releasePath,
  ], { encoding: "utf8" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function waitForPaths(paths, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function crashMigrationAtPhase(dbPath, phase) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import * as core from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
     core.openDatabase(process.argv[1], {
       onSchemaMaintenance(event) {
         if (event.operation === "schema-migration-backup" && event.phase === process.argv[2]) {
           process.kill(process.pid, "SIGKILL");
         }
       },
     });`,
    dbPath,
    phase,
  ], { encoding: "utf8" });
}

test("a runtime compiled for schema 17 fails closed through the real open path without changing journal mode", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.pragma("journal_mode=DELETE");
  store.close();
  assert.equal(journalMode(dbPath), "delete");
  assert.throws(
    () => core.openDatabase(dbPath, { allowSchemaMutation: false, supportedSchemaVersion: 17 }),
    (error) => error?.code === "SCHEMA_VERSION_MISMATCH"
      && error?.storedVersion === 18
      && error?.supportedVersion === 17
      && /upgrade Penguin|newer than this build/i.test(error.message),
  );
  assert.equal(journalMode(dbPath), "delete");
});

test("newer and read-only outdated schemas fail before persistent PRAGMA writes", () => {
  for (const [storedVersion, options, expectedCode] of [
    [999, {}, "SCHEMA_VERSION_MISMATCH"],
    [17, { allowSchemaMutation: false }, "SCHEMA_OUTDATED"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `penguin-schema-no-write-${storedVersion}-`));
    const dbPath = join(directory, "knowledge.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta(key,value) VALUES ('schema_version',?)").run(String(storedVersion));
    db.pragma("journal_mode=DELETE");
    db.close();
    assert.throws(() => core.openDatabase(dbPath, options), (error) => error?.code === expectedCode);
    assert.equal(journalMode(dbPath), "delete", `${expectedCode} must leave the file untouched`);
  }
});

test("migration backup includes the latest committed WAL frame while an older reader is open", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const writer = new Database(dbPath);
  writer.pragma("journal_mode=WAL");
  writer.pragma("wal_autocheckpoint=0");
  writer.exec("CREATE TABLE migration_sentinel(value TEXT NOT NULL)");
  writer.pragma("wal_checkpoint(TRUNCATE)");
  const reader = new Database(dbPath, { readonly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) AS n FROM migration_sentinel").get();
  writer.prepare("INSERT INTO migration_sentinel(value) VALUES (?)").run("latest-committed-frame");

  const migrated = core.openDatabase(dbPath);
  migrated.close();
  const backup = new Database(core.schemaMigrationBackupPath(dbPath, 17, 18), { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare("SELECT value FROM migration_sentinel").get().value, "latest-committed-frame");
  backup.close();
  reader.exec("ROLLBACK");
  reader.close();
  writer.close();
});

test("migration backup includes a writer commit after backup publication but before migration locking", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_gap_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  const migrated = core.openDatabase(dbPath, {
    onSchemaMaintenance(event) {
      if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
      const writer = spawnSync(process.execPath, [
        "--eval",
        `const Database = require(process.argv[1]);
         const db = new Database(process.argv[2]);
         try {
           db.prepare("INSERT INTO migration_gap_sentinel(value) VALUES (?)")
             .run("committed-after-backup-before-migration");
         } finally {
           db.close();
         }`,
        requireFromCore.resolve("better-sqlite3"),
        dbPath,
      ], { encoding: "utf8" });
      assert.equal(writer.status, 0, writer.stderr || writer.stdout);
      writerCommitted = true;
    },
  });

  assert.equal(writerCommitted, true, "the independent writer must commit in the backup-to-lock window");
  assert.equal(
    migrated.prepare("SELECT value FROM migration_gap_sentinel").get().value,
    "committed-after-backup-before-migration",
  );
  migrated.close();

  const backup = new Database(core.schemaMigrationBackupPath(dbPath, 17, 18), { readonly: true, fileMustExist: true });
  assert.equal(
    backup.prepare("SELECT value FROM migration_gap_sentinel").get().value,
    "committed-after-backup-before-migration",
    "the retained pre-migration image must include every commit visible before migration locking",
  );
  backup.close();
});

test("a publication retry re-reads schema state before creating another v17 backup", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_retry_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  let retryBarrierReached = false;
  let backupStarts = 0;
  let competingMigration;
  const migrated = core.openDatabase(dbPath, {
    onSchemaMaintenance(event) {
      if (event.operation !== "schema-migration-backup") return;
      if (event.phase === "start") backupStarts += 1;
      if (!writerCommitted && event.phase === "complete") {
        const writer = spawnSync(process.execPath, [
          "--eval",
          `const Database = require(process.argv[1]);
           const db = new Database(process.argv[2]);
           try {
             db.prepare("INSERT INTO migration_retry_sentinel(value) VALUES (?)")
               .run("force-first-attempt-retry");
           } finally {
             db.close();
           }`,
          requireFromCore.resolve("better-sqlite3"),
          dbPath,
        ], { encoding: "utf8" });
        assert.equal(writer.status, 0, writer.stderr || writer.stdout);
        writerCommitted = true;
      }
      if (!retryBarrierReached && event.phase === "before-backup-retry") {
        retryBarrierReached = true;
        competingMigration = spawnSync(process.execPath, [
          "--input-type=module",
          "--eval",
          `import * as core from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
           const db = core.openDatabase(process.argv[1]);
           db.close();`,
          dbPath,
        ], { encoding: "utf8" });
        assert.equal(competingMigration.status, 0, competingMigration.stderr || competingMigration.stdout);
      }
    },
  });

  assert.equal(writerCommitted, true);
  assert.equal(retryBarrierReached, true, "the retry hook must run before the next schema observation");
  assert.equal(competingMigration?.status, 0);
  assert.equal(backupStarts, 1, "the loser must not VACUUM again using stale fromVersion=17");
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
});

test("a crash after backup publication rebuilds a stale same-source backup on the next open", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_crash_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = spawnSync(process.execPath, [
          "--eval",
          `const Database = require(process.argv[1]);
           const db = new Database(process.argv[2]);
           try {
             db.prepare("INSERT INTO migration_crash_sentinel(value) VALUES (?)")
               .run("committed-before-simulated-crash");
           } finally {
             db.close();
           }`,
          requireFromCore.resolve("better-sqlite3"),
          dbPath,
        ], { encoding: "utf8" });
        assert.equal(writer.status, 0, writer.stderr || writer.stdout);
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );
  assert.equal(writerCommitted, true);

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const staleBackup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(staleBackup.prepare("SELECT COUNT(*) AS n FROM migration_crash_sentinel").get().n, 0);
  staleBackup.close();

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  assert.equal(migrated.prepare("SELECT value FROM migration_crash_sentinel").get().value, "committed-before-simulated-crash");
  migrated.close();

  const rebuiltBackup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(rebuiltBackup.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  assert.equal(rebuiltBackup.prepare("SELECT value FROM migration_crash_sentinel").get().value, "committed-before-simulated-crash");
  rebuiltBackup.close();
});

test("backup publication never clobbers an unrelated file that appears immediately before publish", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  let inserted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (inserted || event.operation !== "schema-migration-backup" || event.phase !== "before-publish") return;
        const sentinel = new Database(backupPath);
        sentinel.exec(`
          CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          INSERT INTO meta VALUES ('schema_version','17');
          CREATE TABLE unrelated_publish_sentinel(value TEXT NOT NULL);
          INSERT INTO unrelated_publish_sentinel VALUES ('must-survive');
        `);
        sentinel.close();
        inserted = true;
      },
    }),
    (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH",
  );

  assert.equal(inserted, true, "the sentinel must appear after initial absence checks and immediately before publication");
  assert.equal(existsSync(manifestPath), false, "a losing publish attempt must not leave provenance beside an unrelated backup");
  const sentinel = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(sentinel.prepare("SELECT value FROM unrelated_publish_sentinel").get().value, "must-survive");
  sentinel.close();
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("two concurrent migrators never let the loser erase the winner's retained v17 backup", async () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (event.operation === "schema-migration-backup" && event.phase === "complete") {
          throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
        }
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const retainedBackup = readFileSync(backupPath);
  const retainedManifest = readFileSync(manifestPath);

  const blocker = new Database(dbPath);
  blocker.exec("BEGIN IMMEDIATE");
  const first = spawnMigrationChild(dbPath);
  const second = spawnMigrationChild(dbPath);
  await Promise.all([first.ready, second.ready]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  blocker.exec("COMMIT");
  blocker.close();

  const results = await Promise.all([first.done, second.done]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /READY\n18\n/);
  }
  assert.deepEqual(readFileSync(backupPath), retainedBackup, "the losing attempt must not erase or replace the winner's backup");
  assert.deepEqual(readFileSync(manifestPath), retainedManifest, "the losing attempt must not erase or replace the winner's manifest");
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  backup.close();
});

test("two processes released deterministically from the same before-publish barrier publish one consistent backup 20 times", async () => {
  for (let repetition = 1; repetition <= 20; repetition += 1) {
    const store = freshStore();
    const dbPath = store.db.name;
    store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
    store.close();

    const barrierDir = mkdtempSync(join(tmpdir(), "penguin-schema-publish-barrier-"));
    const readyOne = join(barrierDir, "one.ready");
    const readyTwo = join(barrierDir, "two.ready");
    const releaseOne = join(barrierDir, "one.release");
    const releaseTwo = join(barrierDir, "two.release");
    const first = spawnBarrierMigrationChild(dbPath, readyOne, releaseOne);
    const second = spawnBarrierMigrationChild(dbPath, readyTwo, releaseTwo);
    await waitForPaths([readyOne, readyTwo]);
    assert.equal(first.child.exitCode, null, `first publisher must be blocked in repetition ${repetition}`);
    assert.equal(second.child.exitCode, null, `second publisher must be blocked in repetition ${repetition}`);

    writeFileSync(releaseOne, "release", { flag: "wx" });
    const firstResult = await first.done;
    assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
    assert.match(firstResult.stdout, /^18\n$/);
    assert.equal(second.child.exitCode, null, `loser must remain blocked until winner commits in repetition ${repetition}`);
    writeFileSync(releaseTwo, "release", { flag: "wx" });
    const secondResult = await second.done;
    assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);
    assert.match(secondResult.stdout, /^18\n$/);

    const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
    const manifestPath = `${backupPath}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.format, 3);
    assert.ok(existsSync(backupPath));
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    assert.equal(Number(backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
    assert.equal(backup.pragma("quick_check", { simple: true }), "ok");
    backup.close();
    assert.deepEqual(
      readdirSync(dirname(dbPath)).filter((name) => name.includes(".attempt-") && name.endsWith(".owner.json")),
      [],
    );
  }
});

test("source logicalDigest-only manifest tampering fails closed without deleting the backup", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (event.operation === "schema-migration-backup" && event.phase === "complete") {
          throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
        }
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.source.logicalDigest = manifest.source.logicalDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
  const tamperedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, tamperedManifest);
  const retainedBackup = readFileSync(backupPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.deepEqual(readFileSync(backupPath), retainedBackup);
  assert.equal(readFileSync(manifestPath, "utf8"), tamperedManifest);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("unusable source file provenance fails closed without deleting the backup", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_unusable_identity_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = new Database(dbPath);
        writer.prepare("INSERT INTO migration_unusable_identity_sentinel(value) VALUES (?)").run("post-backup-commit");
        writer.close();
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sourceFile = manifest.source.files.find((file) => file.suffix === "");
  manifest.source.files.push({
    ...sourceFile,
    size: 0,
    mtimeMs: 0,
    device: 0,
    ino: 0,
    birthtimeMs: 0,
  });
  const unusableManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, unusableManifest);
  const retainedBackup = readFileSync(backupPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.deepEqual(readFileSync(backupPath), retainedBackup);
  assert.equal(readFileSync(manifestPath, "utf8"), unusableManifest);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(source.prepare("SELECT value FROM migration_unusable_identity_sentinel").get().value, "post-backup-commit");
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("stale-backup cleanup revalidates identity immediately before deletion", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_replacement_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = new Database(dbPath);
        writer.prepare("INSERT INTO migration_replacement_sentinel(value) VALUES (?)").run("post-backup-commit");
        writer.close();
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const replacementPath = `${backupPath}.replacement`;
  copyFileSync(backupPath, replacementPath);
  const replacement = new Database(replacementPath);
  replacement.exec("CREATE TABLE replacement_identity(value TEXT NOT NULL); INSERT INTO replacement_identity VALUES ('do-not-delete')");
  replacement.close();
  const replacementBytes = readFileSync(replacementPath);
  const retainedManifest = readFileSync(manifestPath);
  let replaced = false;

  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (replaced || event.operation !== "schema-migration-backup" || event.phase !== "start") return;
        renameSync(replacementPath, backupPath);
        replaced = true;
      },
    }),
    (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH",
  );
  assert.equal(replaced, true, "the replacement must occur after validation and immediately before cleanup");
  assert.deepEqual(readFileSync(backupPath), replacementBytes, "a path replacement must never be removed");
  assert.deepEqual(readFileSync(manifestPath), retainedManifest);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  assert.equal(source.prepare("SELECT value FROM migration_replacement_sentinel").get().value, "post-backup-commit");
  source.close();
});

test("stale-backup cleanup never unlinks a replacement installed after its final identity check", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_final_toctou_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = new Database(dbPath);
        writer.prepare("INSERT INTO migration_final_toctou_sentinel(value) VALUES (?)").run("post-backup-commit");
        writer.close();
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const replacementPath = `${backupPath}.after-final-check`;
  copyFileSync(backupPath, replacementPath);
  const replacement = new Database(replacementPath);
  replacement.exec("CREATE TABLE final_toctou_replacement(value TEXT NOT NULL); INSERT INTO final_toctou_replacement VALUES ('must-survive')");
  replacement.close();
  const replacementBytes = readFileSync(replacementPath);
  const retainedManifest = readFileSync(manifestPath);
  let replaced = false;

  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (replaced || event.operation !== "schema-migration-backup" || event.phase !== "before-remove") return;
        renameSync(replacementPath, backupPath);
        replaced = true;
      },
    }),
    (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH",
  );

  assert.equal(replaced, true, "the replacement must occur after the final fixed-path identity check");
  assert.deepEqual(readFileSync(backupPath), replacementBytes, "cleanup must restore and retain the unrelated replacement");
  assert.deepEqual(readFileSync(manifestPath), retainedManifest);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  assert.equal(source.prepare("SELECT value FROM migration_final_toctou_sentinel").get().value, "post-backup-commit");
  source.close();
});

test("a SIGKILL after backup quarantine is ownership-proven and recovered on the next open", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_cleanup_crash_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = new Database(dbPath);
        writer.prepare("INSERT INTO migration_cleanup_crash_sentinel(value) VALUES (?)").run("post-backup-commit");
        writer.close();
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const crash = crashMigrationAtPhase(dbPath, "after-backup-quarantine");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  assert.equal(existsSync(backupPath), false);
  assert.equal(existsSync(manifestPath), true);
  const cleanupPrefix = `${basename(backupPath)}.cleanup-`;
  assert.equal(readdirSync(dirname(dbPath)).filter((name) => name.startsWith(cleanupPrefix)).length, 1);
  assert.equal(existsSync(`${manifestPath}.cleanup-claim.json`), true, "the crash must retain its ownership claim");

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  assert.equal(migrated.prepare("SELECT value FROM migration_cleanup_crash_sentinel").get().value, "post-backup-commit");
  migrated.close();
  assert.equal(readdirSync(dirname(dbPath)).some((name) => name.startsWith(cleanupPrefix)), false);
  assert.equal(existsSync(`${manifestPath}.cleanup-claim.json`), false);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare("SELECT value FROM migration_cleanup_crash_sentinel").get().value, "post-backup-commit");
  backup.close();
});

test("a reused cleanup-claim PID with a different process start token is reaped", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_cleanup_pid_reuse_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = new Database(dbPath);
        writer.prepare("INSERT INTO migration_cleanup_pid_reuse_sentinel(value) VALUES (?)").run("post-backup-commit");
        writer.close();
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const crash = crashMigrationAtPhase(dbPath, "after-backup-quarantine");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const claimPath = `${manifestPath}.cleanup-claim.json`;
  const claim = JSON.parse(readFileSync(claimPath, "utf8"));
  claim.ownerPid = process.pid;
  claim.ownerProcessStartToken = differentWellFormedProcessStartToken(claim.ownerProcessStartToken);
  writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.equal(existsSync(claimPath), false);
  assert.equal(
    readdirSync(dirname(dbPath)).some((name) => name.startsWith(`${basename(backupPath)}.cleanup-`)),
    false,
  );
});

test("an unrelated replacement at a crashed cleanup quarantine fails closed and survives", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec("CREATE TABLE migration_cleanup_mismatch_sentinel(value TEXT NOT NULL)");
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  let writerCommitted = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (writerCommitted || event.operation !== "schema-migration-backup" || event.phase !== "complete") return;
        const writer = new Database(dbPath);
        writer.prepare("INSERT INTO migration_cleanup_mismatch_sentinel(value) VALUES (?)").run("post-backup-commit");
        writer.close();
        writerCommitted = true;
        throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const crash = crashMigrationAtPhase(dbPath, "after-backup-quarantine");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const cleanupPrefix = `${basename(backupPath)}.cleanup-`;
  const cleanupName = readdirSync(dirname(dbPath)).find((name) => name.startsWith(cleanupPrefix));
  assert.ok(cleanupName);
  const cleanupPath = join(dirname(dbPath), cleanupName);
  const replacementPath = `${cleanupPath}.replacement`;
  const unrelated = new Database(replacementPath);
  unrelated.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version','17');
    CREATE TABLE unrelated_cleanup_quarantine(value TEXT NOT NULL);
    INSERT INTO unrelated_cleanup_quarantine VALUES ('must-survive');
  `);
  unrelated.close();
  renameSync(replacementPath, cleanupPath);
  const unrelatedBytes = readFileSync(cleanupPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.deepEqual(readFileSync(cleanupPath), unrelatedBytes);
  assert.equal(existsSync(backupPath), false);
  assert.equal(existsSync(manifestPath), true);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("repeated SIGKILL after VACUUM keeps owned attempt leftovers bounded and preserves unrelated lookalikes", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const directory = dirname(dbPath);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const unrelatedName = `${attemptPrefix}00000000-0000-4000-8000-000000000000.tmp`;
  const unrelatedPath = join(directory, unrelatedName);
  writeFileSync(unrelatedPath, "unrelated-lookalike");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const crash = crashMigrationAtPhase(dbPath, "after-vacuum");
    assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
    const ownedLeftovers = readdirSync(directory)
      .filter((name) => name.startsWith(attemptPrefix) && name !== unrelatedName);
    assert.ok(ownedLeftovers.length > 0, "SIGKILL must leave an owned attempt artifact to recover");
    assert.ok(ownedLeftovers.length <= 2, `dead attempt leftovers must stay bounded, found ${ownedLeftovers.join(",")}`);
    assert.equal(readFileSync(unrelatedPath, "utf8"), "unrelated-lookalike");
  }

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.startsWith(attemptPrefix)),
    [unrelatedName],
  );
  assert.equal(readFileSync(unrelatedPath, "utf8"), "unrelated-lookalike");
});

test("a completed VACUUM killed before identity persistence is recovered on restart", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum-before-identity");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const attemptName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptName, "the crash must leave the completed VACUUM output");
  const attemptPath = join(dirname(dbPath), attemptName);
  const unprovenBytes = readFileSync(attemptPath);

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.deepEqual(readFileSync(attemptPath), unprovenBytes, "recovery must not delete an unproven physical candidate");
  assert.equal(
    readdirSync(dirname(dbPath)).some((name) => name.startsWith(attemptPrefix) && name.endsWith(".owner.json")),
    false,
  );
});

test("an unrelated replacement in the pre-identity VACUUM window is preserved while an independent retry migrates", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum-before-identity");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const attemptName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptName);
  const attemptPath = join(dirname(dbPath), attemptName);
  renameSync(attemptPath, `${attemptPath}.owned-original`);
  const replacement = new Database(attemptPath);
  replacement.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version','17');
    CREATE TABLE unrelated_pre_identity_replacement(value TEXT NOT NULL);
    INSERT INTO unrelated_pre_identity_replacement VALUES ('must-survive');
  `);
  replacement.close();
  const replacementBytes = readFileSync(attemptPath);

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.deepEqual(readFileSync(attemptPath), replacementBytes);
  const preserved = new Database(attemptPath, { readonly: true, fileMustExist: true });
  assert.equal(preserved.prepare("SELECT value FROM unrelated_pre_identity_replacement").pluck().get(), "must-survive");
  preserved.close();
});

test("a same-logicalDigest saved_queries replacement is never adopted or deleted during pre-identity recovery", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const replacementPath = `${dbPath}.same-digest-replacement`;
  copyFileSync(dbPath, replacementPath);
  const crash = crashMigrationAtPhase(dbPath, "after-vacuum-before-identity");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const attemptName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptName);
  const attemptPath = join(dirname(dbPath), attemptName);
  renameSync(attemptPath, `${attemptPath}.owned-original`);
  const replacement = new Database(replacementPath);
  const now = new Date().toISOString();
  replacement.prepare(`
    INSERT INTO saved_queries(id,name,request_json,scope_json,contract_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).run("adversarial-saved-query", "same digest payload", "{}", "{}", "2", now, now);
  replacement.close();
  renameSync(replacementPath, attemptPath);
  const replacementBytes = readFileSync(attemptPath);

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.deepEqual(readFileSync(attemptPath), replacementBytes, "same-digest physical replacement must stay byte-identical");
  const preserved = new Database(attemptPath, { readonly: true, fileMustExist: true });
  assert.equal(preserved.prepare("SELECT name FROM saved_queries WHERE id=?").pluck().get("adversarial-saved-query"), "same digest payload");
  preserved.close();
  const retained = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(retained.prepare("SELECT COUNT(*) FROM saved_queries WHERE id=?").pluck().get("adversarial-saved-query"), 0);
  retained.close();
});

test("a reused attempt-owner PID with a different process start token does not leave leftovers", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const ownerName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".owner.json"));
  assert.ok(ownerName);
  const ownerPath = join(dirname(dbPath), ownerName);
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.ownerPid = process.pid;
  owner.ownerProcessStartToken = differentWellFormedProcessStartToken(owner.ownerProcessStartToken);
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.deepEqual(
    readdirSync(dirname(dbPath)).filter((name) => name.startsWith(attemptPrefix)),
    [],
  );
});

test("a persisted attempt identity cannot be downgraded to pre-identity recovery", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const ownerName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".owner.json"));
  assert.ok(ownerName);
  const ownerPath = join(dirname(dbPath), ownerName);
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  assert.ok(owner.backupIdentity);
  owner.backupIdentity.path = `${owner.backupIdentity.path}.tampered`;
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.equal(existsSync(ownerPath), true);
  assert.ok(readdirSync(dirname(dbPath)).some((name) => name.startsWith(attemptPrefix) && name.endsWith(".tmp")));
});

test("an orphan format-3 manifest rejects a reused PID and recovers by publisher start token", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "before-publish");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const manifestPrefix = `${basename(manifestPath)}.attempt-`;
  const attemptManifestName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(manifestPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptManifestName);
  const attemptManifestPath = join(dirname(dbPath), attemptManifestName);
  const manifest = JSON.parse(readFileSync(attemptManifestPath, "utf8"));
  assert.equal(typeof manifest.publisherProcessStartToken, "string");
  assert.ok(manifest.publisherProcessStartToken.length > 0);
  manifest.publisherPid = process.pid;
  manifest.publisherProcessStartToken = differentWellFormedProcessStartToken(manifest.publisherProcessStartToken);
  writeFileSync(attemptManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const ownerPath = `${backupPath}.attempt-${manifest.attemptId}.owner.json`;
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.ownerPid = manifest.publisherPid;
  owner.ownerProcessStartToken = manifest.publisherProcessStartToken;
  owner.manifestIdentity = manifestFileIdentity(attemptManifestPath);
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  linkSync(attemptManifestPath, manifestPath);

  const migrated = core.openDatabase(dbPath);
  assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  migrated.close();
  assert.equal(existsSync(attemptManifestPath), false);
  assert.ok(existsSync(manifestPath));
});

test("orphan recovery atomically quarantines the attempt manifest before deleting it", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "before-publish");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const attemptManifestName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(`${basename(manifestPath)}.attempt-`) && name.endsWith(".tmp"));
  assert.ok(attemptManifestName);
  const attemptManifestPath = join(dirname(dbPath), attemptManifestName);
  const originalManifest = JSON.parse(readFileSync(attemptManifestPath, "utf8"));
  const ownerPath = `${backupPath}.attempt-${originalManifest.attemptId}.owner.json`;
  linkSync(attemptManifestPath, manifestPath);

  const displacedOwnedManifestPath = `${attemptManifestPath}.owned-before-race`;
  const replacementBytes = Buffer.from("foreign replacement must survive orphan cleanup\n");
  let replaced = false;
  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (
          replaced ||
          event.operation !== "schema-migration-backup" ||
          event.phase !== "before-orphan-attempt-quarantine"
        ) return;
        renameSync(attemptManifestPath, displacedOwnedManifestPath);
        writeFileSync(attemptManifestPath, replacementBytes, { flag: "wx" });
        replaced = true;
      },
    }),
    (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH",
  );

  assert.equal(replaced, true, "the replacement must occur after validation and before attempt quarantine");
  assert.deepEqual(readFileSync(attemptManifestPath), replacementBytes);
  assert.equal(existsSync(displacedOwnedManifestPath), true);
  assert.equal(existsSync(ownerPath), true, "fail-closed recovery must retain its owner evidence");
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("a malformed Darwin owner token is unknown and never triggers orphan cleanup", { skip: process.platform !== "darwin" }, () => {
  for (const malformedToken of ["darwin-v2:not-valid-base64-json", "darwin:"]) {
    const store = freshStore();
    const dbPath = store.db.name;
    store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
    store.close();

    const crash = crashMigrationAtPhase(dbPath, "before-publish");
    assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
    const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
    const manifestPath = `${backupPath}.manifest.json`;
    const attemptManifestName = readdirSync(dirname(dbPath))
      .find((name) => name.startsWith(`${basename(manifestPath)}.attempt-`) && name.endsWith(".tmp"));
    assert.ok(attemptManifestName);
    const attemptManifestPath = join(dirname(dbPath), attemptManifestName);
    const manifest = JSON.parse(readFileSync(attemptManifestPath, "utf8"));
    manifest.publisherPid = process.pid;
    manifest.publisherProcessStartToken = malformedToken;
    writeFileSync(attemptManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const ownerPath = `${backupPath}.attempt-${manifest.attemptId}.owner.json`;
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    owner.ownerPid = process.pid;
    owner.ownerProcessStartToken = manifest.publisherProcessStartToken;
    owner.manifestIdentity = manifestFileIdentity(attemptManifestPath);
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
    linkSync(attemptManifestPath, manifestPath);
    const retainedAttemptManifest = readFileSync(attemptManifestPath);
    const retainedPublishedManifest = readFileSync(manifestPath);
    const retainedOwner = readFileSync(ownerPath);

    assert.throws(
      () => core.openDatabase(dbPath),
      (error) => error?.code === "SCHEMA_BACKUP_BUSY",
      malformedToken,
    );
    assert.deepEqual(readFileSync(attemptManifestPath), retainedAttemptManifest, malformedToken);
    assert.deepEqual(readFileSync(manifestPath), retainedPublishedManifest, malformedToken);
    assert.deepEqual(readFileSync(ownerPath), retainedOwner, malformedToken);
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
    source.close();
  }
});

test("a dead PID cannot make malformed, incomplete, or incomparable Darwin identity safe to clean", { skip: process.platform !== "darwin" }, () => {
  const cases = [
    () => "darwin-v2:not-valid-base64-json",
    (originalToken) => {
      const identity = JSON.parse(Buffer.from(originalToken.slice("darwin-v2:".length), "base64url").toString("utf8"));
      delete identity.commandSha256;
      return encodedDarwinToken(identity);
    },
    (originalToken) => {
      const identity = JSON.parse(Buffer.from(originalToken.slice("darwin-v2:".length), "base64url").toString("utf8"));
      identity.observedAtMs = Date.now() + 60_000;
      return encodedDarwinToken(identity);
    },
    () => undefined,
  ];
  for (const token of cases) assertOrphanCleanupFailsClosed(crashedOrphanAttemptFixture({ token }));
});

for (const [tokenKind, token] of [
  ["object", { kind: "not-a-process-start-token" }],
  ["array", ["not-a-process-start-token"]],
  ["number", 42],
  ["null", null],
]) {
  for (const [pidState, publisherPid] of [
    ["alive", process.pid],
    ["dead", undefined],
  ]) {
    test(`a persisted ${tokenKind} JSON owner token with an ${pidState} PID is unknown and preserves orphan artifacts`, () => {
      const fixture = crashedOrphanAttemptFixture({
        token: () => token,
        ...(publisherPid === undefined ? {} : { publisherPid }),
      });
      assertOrphanCleanupFailsClosed(fixture);
    });
  }
}

test("a real Darwin ps failure is unknown and preserves orphan artifacts", { skip: process.platform !== "darwin" }, () => {
  const absentPid = 2_147_483_647;
  const fixture = crashedOrphanAttemptFixture({
    publisherPid: absentPid,
    token: (originalToken) => originalToken,
  });
  const originalKill = process.kill;
  process.kill = ((pid, signal) => pid === absentPid ? true : originalKill(pid, signal));
  try {
    assertOrphanCleanupFailsClosed(fixture);
  } finally {
    process.kill = originalKill;
  }
});

test("dead-PID malformed identities fail closed through Linux, Windows, and fallback recovery branches", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(originalPlatform?.configurable);
  for (const fixtureCase of [
    { platform: "linux", token: "linux:missing-start-ticks" },
    { platform: "win32", token: "win32:not-ticks" },
    { platform: "freebsd", token: "freebsd:" },
  ]) {
    const fixture = crashedOrphanAttemptFixture({ token: () => fixtureCase.token });
    try {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: fixtureCase.platform });
      assertOrphanCleanupFailsClosed(fixture);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
});

test("a dead legacy attempt owner with an empty persisted token is unknown and not scavenged", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const ownerName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".owner.json"));
  assert.ok(ownerName);
  const ownerPath = join(dirname(dbPath), ownerName);
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  assert.throws(() => process.kill(owner.ownerPid, 0), (error) => error?.code === "ESRCH");
  owner.format = 2;
  owner.ownerProcessStartToken = "";
  const retainedOwner = `${JSON.stringify(owner, null, 2)}\n`;
  writeFileSync(ownerPath, retainedOwner);
  const attemptPath = join(dirname(dbPath), ownerName.slice(0, -".owner.json".length) + ".tmp");
  const retainedAttempt = readFileSync(attemptPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_BUSY");
  assert.equal(readFileSync(ownerPath, "utf8"), retainedOwner);
  assert.deepEqual(readFileSync(attemptPath), retainedAttempt);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("orphan manifest recovery preserves a replacement attempt manifest that violates persisted owner identity", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "before-publish");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const manifestPrefix = `${basename(manifestPath)}.attempt-`;
  const attemptManifestName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(manifestPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptManifestName);
  const attemptManifestPath = join(dirname(dbPath), attemptManifestName);
  const originalManifest = JSON.parse(readFileSync(attemptManifestPath, "utf8"));
  const ownerPath = `${backupPath}.attempt-${originalManifest.attemptId}.owner.json`;
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  assert.equal(owner.manifestIdentity.path, attemptManifestPath);

  renameSync(attemptManifestPath, `${attemptManifestPath}.owned-original`);
  const replacementManifest = {
    ...originalManifest,
    replacementMarker: "must-survive-owner-identity-mismatch",
  };
  const replacementBytes = `${JSON.stringify(replacementManifest, null, 2)}\n`;
  writeFileSync(attemptManifestPath, replacementBytes, { flag: "wx" });
  linkSync(attemptManifestPath, manifestPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.equal(readFileSync(attemptManifestPath, "utf8"), replacementBytes);
  assert.equal(readFileSync(manifestPath, "utf8"), replacementBytes);
  assert.equal(existsSync(ownerPath), true, "owner evidence must survive a fail-closed recovery");
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("macOS attempt owners persist elapsed-aware process start identity", { skip: process.platform !== "darwin" }, () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const ownerName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(`${basename(backupPath)}.attempt-`) && name.endsWith(".owner.json"));
  assert.ok(ownerName);
  const owner = JSON.parse(readFileSync(join(dirname(dbPath), ownerName), "utf8"));
  assert.match(owner.ownerProcessStartToken, /^darwin-v2:/);
  const identity = JSON.parse(Buffer.from(owner.ownerProcessStartToken.slice("darwin-v2:".length), "base64url").toString("utf8"));
  assert.equal(typeof identity.startedAt, "string");
  assert.ok(identity.startedAt.length > 0);
  assert.equal(Number.isFinite(identity.elapsedSeconds), true);
  assert.equal(Number.isFinite(identity.observedAtMs), true);
  assert.match(identity.commandSha256, /^[a-f0-9]{64}$/);
});

test("a legacy format-3 orphan manifest without a publisher start token remains conservative", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "before-publish");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const manifestPrefix = `${basename(manifestPath)}.attempt-`;
  const attemptManifestName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(manifestPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptManifestName);
  const attemptManifestPath = join(dirname(dbPath), attemptManifestName);
  const manifest = JSON.parse(readFileSync(attemptManifestPath, "utf8"));
  manifest.publisherPid = process.pid;
  delete manifest.publisherProcessStartToken;
  writeFileSync(attemptManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const ownerPath = `${backupPath}.attempt-${manifest.attemptId}.owner.json`;
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.ownerPid = manifest.publisherPid;
  owner.manifestIdentity = manifestFileIdentity(attemptManifestPath);
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  linkSync(attemptManifestPath, manifestPath);
  const retainedManifest = readFileSync(manifestPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_BUSY");
  assert.deepEqual(readFileSync(manifestPath), retainedManifest);
  assert.deepEqual(readFileSync(attemptManifestPath), retainedManifest);
});

test("a replaced owned VACUUM attempt is preserved and fails closed", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  const crash = crashMigrationAtPhase(dbPath, "after-vacuum");
  assert.equal(crash.signal, "SIGKILL", crash.stderr || crash.stdout);
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const attemptPrefix = `${basename(backupPath)}.attempt-`;
  const attemptName = readdirSync(dirname(dbPath))
    .find((name) => name.startsWith(attemptPrefix) && name.endsWith(".tmp"));
  assert.ok(attemptName, "after-vacuum crash must leave its owned backup attempt");
  const attemptPath = join(dirname(dbPath), attemptName);
  renameSync(attemptPath, `${attemptPath}.owned-original`);
  const replacement = new Database(attemptPath);
  replacement.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version','17');
    CREATE TABLE unrelated_attempt_replacement(value TEXT NOT NULL);
    INSERT INTO unrelated_attempt_replacement VALUES ('must-survive');
  `);
  replacement.close();
  const replacementBytes = readFileSync(attemptPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.deepEqual(readFileSync(attemptPath), replacementBytes);
  const preserved = new Database(attemptPath, { readonly: true, fileMustExist: true });
  assert.equal(preserved.prepare("SELECT value FROM unrelated_attempt_replacement").pluck().get(), "must-survive");
  preserved.close();
});

test("a provenance-mismatched existing backup remains untouched and fails closed", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();

  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (event.operation === "schema-migration-backup" && event.phase === "complete") {
          throw Object.assign(new Error("SIMULATED_CRASH"), { code: "SIMULATED_CRASH" });
        }
      },
    }),
    (error) => error?.code === "SIMULATED_CRASH",
  );

  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const manifestPath = `${backupPath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sourceFile = manifest.source.files.find((file) => file.suffix === "");
  sourceFile.ino = Number(sourceFile.ino ?? 0) + 1;
  const mismatchedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, mismatchedManifest);
  const mismatchedBackup = readFileSync(backupPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.equal(existsSync(backupPath), true);
  assert.deepEqual(readFileSync(backupPath), mismatchedBackup);
  assert.equal(readFileSync(manifestPath, "utf8"), mismatchedManifest);
  const source = new Database(dbPath, { readonly: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("an unrelated existing backup is rejected before source migration", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.close();
  const backupPath = core.schemaMigrationBackupPath(dbPath, 17, 18);
  const unrelated = new Database(backupPath);
  unrelated.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','17')");
  unrelated.close();
  const unrelatedBackup = readFileSync(backupPath);

  assert.throws(() => core.openDatabase(dbPath), (error) => error?.code === "SCHEMA_BACKUP_SOURCE_MISMATCH");
  assert.deepEqual(readFileSync(backupPath), unrelatedBackup);
  const source = new Database(dbPath, { readonly: true });
  assert.equal(Number(source.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  source.close();
});

test("a migration failure rolls back partial DDL and safely retries from the retained backup", () => {
  const store = freshStore();
  const dbPath = store.db.name;
  store.db.exec(`
    DROP TABLE fts_symbol_rows;
    DROP TABLE fts_identifier_rows;
    CREATE INDEX idx_edges_src ON edges(src);
    CREATE INDEX idx_edges_dst ON edges(dst);
  `);
  store.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run();
  store.db.pragma("journal_mode=DELETE");
  store.close();
  assert.equal(journalMode(dbPath), "delete");

  assert.throws(
    () => core.openDatabase(dbPath, {
      onSchemaMaintenance(event) {
        if (event.operation === "fts-row-maps" && event.phase === "complete") {
          throw Object.assign(new Error("INJECTED_MIGRATION_FAILURE"), { code: "INJECTED_MIGRATION_FAILURE" });
        }
      },
    }),
    (error) => error?.code === "INJECTED_MIGRATION_FAILURE",
  );
  const afterFailure = new Database(dbPath, { readonly: true });
  assert.equal(Number(afterFailure.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 17);
  assert.deepEqual(
    afterFailure.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fts_symbol_rows','fts_identifier_rows') ORDER BY name").all(),
    [],
    "all migration DDL must roll back with the injected failure",
  );
  assert.equal(journalMode(dbPath), "delete", "failed migration must not persist WAL mode");
  assert.deepEqual(
    afterFailure.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_edges_src','idx_edges_dst') ORDER BY name").all(),
    [{ name: "idx_edges_dst" }, { name: "idx_edges_src" }],
    "superseded indexes must remain until the migration transaction commits",
  );
  afterFailure.close();

  const retried = core.openDatabase(dbPath);
  assert.equal(Number(retried.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), 18);
  assert.equal(retried.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('fts_symbol_rows','fts_identifier_rows')").get().n, 2);
  retried.close();
});
