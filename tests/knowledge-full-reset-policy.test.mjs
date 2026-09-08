import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  createFullResetPlan,
  executeFullReset,
  recoverFullReset,
  reissueFullResetPlan,
  rollbackFullReset,
  captureProtectedAssets,
  fullResetPlanDigest,
  readResetManifest,
} from "../packages/knowledge-core/dist/index.js";

test("protected reset node scope is derived from the immutable asset bundle", async () => {
  const core = await import("../packages/knowledge-core/dist/index.js");
  assert.equal(typeof core.protectedNodeIdsFromAssets, "function");
  const table = (key, columns, rows) => ({
    key,
    table: key,
    selector: "all",
    columns,
    rows,
    rowCount: rows.length,
    rowHash: "fixture",
  });
  const ids = core.protectedNodeIdsFromAssets({
    formatVersion: 1,
    capturedAt: "2026-09-02T00:00:00.000Z",
    databaseInstanceId: "db_fixture",
    missingTables: [],
    bundleHash: "fixture",
    tables: {
      node_aliases: table("node_aliases", ["alias", "node_id"], [["alias", "node-alias"]]),
      notes_index: table("notes_index", ["id", "node_id"], [["note", "node-note"]]),
      credential_entries: table("credential_entries", ["id", "node_id"], [["credential", "node-credential"]]),
      response_samples: table("response_samples", ["id", "endpoint_id"], [["response", "node-response"]]),
      events: table("events", ["id", "node_id"], [["event", "node-event"], ["empty", null]]),
      durable_edges: table("durable_edges", ["id", "src", "dst"], [["edge", "node-src", "node-dst"]]),
    },
  });
  assert.deepEqual(ids, [
    "node-alias",
    "node-credential",
    "node-dst",
    "node-event",
    "node-note",
    "node-response",
    "node-src",
  ]);
});

test("full-corpus reset selects all unprotected nodes without parser-edge expansion", async () => {
  const reset = await import("../packages/knowledge-core/dist/index-reset.js");
  assert.equal(typeof reset.fullCorpusNodeSelectionMode, "function");
  assert.equal(reset.fullCorpusNodeSelectionMode(21, 21), "all_unprotected_nodes");
  assert.equal(reset.fullCorpusNodeSelectionMode(20, 21), "scoped_edge_expansion");
});

test("full-corpus reset uses direct SQL predicates instead of materializing corpus IDs", async () => {
  const reset = await import("../packages/knowledge-core/dist/index-reset.js");
  assert.equal(typeof reset.fullCorpusResetPredicate, "function");
  assert.deepEqual(reset.fullCorpusResetPredicate("nodes", ["keep-b", "keep-a"]), {
    sql: "id NOT IN (SELECT value FROM json_each(?))",
    args: ['["keep-a","keep-b"]'],
  });
  assert.deepEqual(reset.fullCorpusResetPredicate("edges", []), {
    sql: "origin='parser'",
    args: [],
  });
  assert.deepEqual(reset.fullCorpusResetPredicate("source_facts", []), {
    sql: "1",
    args: [],
  });
  assert.equal(reset.fullCorpusResetPredicate("embedding_models", []), null);
  assert.equal(reset.fullCorpusResetPredicate("embedding_spaces", []), null);
  assert.equal(reset.fullCorpusResetPredicate("repos", []), null);
});

function gitRepo(root, name) {
  const repoPath = join(root, name);
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["-C", repoPath, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "penguin@example.test"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Penguin Test"]);
  writeFileSync(join(repoPath, "src.ts"), `export const ${name.replaceAll("-", "_")} = 1;\n`);
  execFileSync("git", ["-C", repoPath, "add", "src.ts"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "-m", "fixture"]);
  return {
    path: repoPath,
    head: execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

function openStore(directory, name = "knowledge") {
  return KnowledgeStore.open({
    dbPath: join(directory, `${name}.db`),
    ledgerPath: join(directory, `${name}.ledger.jsonl`),
  });
}

function seedRepo(store, repo, name) {
  const repoId = store.registerRepo({ name, rootPath: repo.path });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: repo.head, status: "live" });
  const parserNode = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::${name}::ParserOnly`,
    title: "ParserOnly",
    repoId,
  });
  const parserTarget = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repoId}::${name}::ParserTarget`,
    title: "ParserTarget",
    repoId,
  });
  store.upsertSymbolVersion({
    nodeId: parserNode,
    branchId,
    commitSha: repo.head,
    filePath: "src.ts",
    lang: "ts",
    kind: "const",
    startLine: 1,
    endLine: 1,
    contentHash: `${name}-symbol-hash`,
    status: "fresh",
  });
  store.indexSymbolText({ nodeId: parserNode, name: "ParserOnly", signature: "const ParserOnly = 1" });
  store.upsertFileCheckpoint({
    repoId,
    branchId,
    filePath: "src.ts",
    lang: "ts",
    sizeBytes: 10,
    contentHash: `${name}-file-hash`,
    status: "indexed",
  });
  store.replaceFileEdges({
    repoId,
    branchId,
    filePath: "src.ts",
    edges: [{
      src: parserNode,
      dst: parserTarget,
      edgeType: "calls",
      origin: "parser",
      method: "EXTRACTED",
      confidence: 0.9,
    }],
  });

  const noteNode = store.upsertNode({
    nodeType: "note",
    identityKey: `${repoId}::note:keep`,
    title: "Keep me",
    repoId,
  });
  const secondNote = store.upsertNode({
    nodeType: "note",
    identityKey: `${repoId}::note:second`,
    title: "Second note",
    repoId,
  });
  store.db.prepare(
    "INSERT INTO notes_index(node_id,path,frontmatter,sensitive,ai_access,mcp_access,content_hash) VALUES (?,?,?,?,?,?,?)",
  ).run(noteNode, `${name}/keep.md`, "{}", 0, "allowed", "allowed", `${name}-note-hash`);
  store.recordKnowledge({
    type: "manual_edge_created",
    origin: "user",
    method: "ASSERTED",
    actor: { type: "user", id: "fixture" },
    target: { node_id: noteNode, repo_id: repoId, branch_id: branchId },
    payload: { src: noteNode, dst: secondNote, edge_type: "references", confidence: 1 },
  });
  store.recordKnowledge({
    type: "node_alias_added",
    origin: "user",
    method: "ASSERTED",
    actor: { type: "user", id: "fixture" },
    target: { node_id: noteNode, repo_id: repoId },
    payload: { alias_key: `${name}-keep`, alias_type: "fixture" },
  });

  const snapshotId = `${name}-snapshot`;
  store.db.prepare(
    "INSERT INTO revision_snapshots(id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(snapshotId, `${name}-snapshot-key`, repoId, repo.head, "parser-1", "resolver-1", 18, "ready", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  store.db.prepare(
    "INSERT INTO file_facts(id,repo_id,file_path,content_hash,language,parser_version,facts_json,exports_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(`${name}-fact`, repoId, "src.ts", `${name}-fact-hash`, "typescript", "parser-1", "{}", `${name}-exports`, "2026-09-01T00:00:00.000Z");
  store.db.prepare(
    "INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(repoId, "src.ts", "tracked", "complete", "NONE", "source", 10, "fixture", "2026-09-01T00:00:00.000Z");

  const sourceBlob = store.db.prepare(
    "INSERT INTO source_blobs(content_hash,byte_size,encoding,raw_bytes,decoded_content,created_at) VALUES (?,?,?,?,?,?)",
  ).run(`${name}-blob`, 10, "utf8", null, "fixture text", "2026-09-01T00:00:00.000Z").lastInsertRowid;
  store.db.prepare(
    "INSERT INTO source_facts(id,repo_id,file_path,fact_fingerprint,content_hash,source_blob_id,coverage_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(`${name}-source-fact`, repoId, "src.ts", `${name}-source-fingerprint`, `${name}-blob`, sourceBlob, "{}", "2026-09-01T00:00:00.000Z");
  store.db.prepare(
    "INSERT INTO effective_snapshot_sources(snapshot_id,file_path,source_fact_id,source_blob_id) VALUES (?,?,?,?)",
  ).run(snapshotId, "src.ts", `${name}-source-fact`, sourceBlob);
  store.db.prepare(
    "INSERT INTO source_blob_line_offsets(source_blob_id,line_count,total_chars,total_bytes,start_chars,start_bytes) VALUES (?,?,?,?,?,?)",
  ).run(sourceBlob, 1, 12, 12, Buffer.from(new Uint32Array([0]).buffer), Buffer.from(new Uint32Array([0]).buffer));

  return { name, repoId, branchId, parserNode, parserTarget, noteNode, secondNote, snapshotId, sourceBlob: Number(sourceBlob) };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-reset-policy-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects, { recursive: true });
  const targetA = gitRepo(projects, "target-a");
  const targetB = gitRepo(projects, "target-b");
  const outside = gitRepo(directory, "outside");
  const store = openStore(directory);
  const a = seedRepo(store, targetA, "target-a");
  const b = seedRepo(store, targetB, "target-b");
  const outsideSeed = seedRepo(store, outside, "outside");
  return {
    directory,
    projects,
    dbPath: join(directory, "knowledge.db"),
    manifestPath: join(directory, "reset-manifest.json"),
    backupPath: join(directory, "knowledge.db.backup"),
    store,
    a,
    b,
    outside: outsideSeed,
  };
}

test("unconsumed reset recovery clears a dead fence without rescanning the full database", async () => {
  const f = await fixture();
  try {
    const { plan } = await createFullResetPlan({ db: f.store.db }, {
      rootPath: f.projects,
      databasePath: f.dbPath,
      backupPath: f.backupPath,
      manifestPath: f.manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    const deadPid = 99999999;
    f.store.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(
      "index_lock::global",
      JSON.stringify({ pid: deadPid, startedAt: "2026-09-01T00:00:00.000Z", kind: "full_corpus_reset", operationId: plan.operationId }),
    );
    writeFileSync(`${f.dbPath}.full-reset.lock`, JSON.stringify({ formatVersion: 1, operationId: plan.operationId, pid: deadPid }));

    const originalPragma = f.store.db.pragma.bind(f.store.db);
    const pragmaCalls = [];
    f.store.db.pragma = (sql, options) => {
      pragmaCalls.push(String(sql));
      return originalPragma(sql, options);
    };

    const recovered = recoverFullReset(f.store, {
      databasePath: f.dbPath,
      manifestPath: f.manifestPath,
      confirmed: true,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(pragmaCalls.some((sql) => sql.includes("integrity_check")), false);
    assert.equal(pragmaCalls.some((sql) => sql.includes("wal_checkpoint")), false);
    assert.equal(existsSync(`${f.dbPath}.full-reset.lock`), false);
  } finally {
    f.store.close();
  }
});

test("consumed pre-delete reset can be reissued without copying the backup again", async () => {
  const f = await fixture();
  try {
    const { plan } = await createFullResetPlan({ db: f.store.db }, {
      rootPath: f.projects,
      databasePath: f.dbPath,
      backupPath: f.backupPath,
      manifestPath: f.manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    const failed = executeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      manifestPath: f.manifestPath,
      token: plan.confirmationToken,
      failAt: "after_fence",
    });
    assert.equal(failed.phase, "failed");
    const reissuedPath = join(f.directory, "reissued-manifest.json");
    const reissued = reissueFullResetPlan(f.store, {
      sourceManifestPath: f.manifestPath,
      manifestPath: reissuedPath,
      confirmed: true,
    });
    assert.equal(reissued.reusedBackupPath, f.backupPath);
    assert.equal(reissued.plan.manifestPath, reissuedPath);
    assert.equal(readResetManifest(reissuedPath).tokenConsumed, false);
  } finally {
    f.store.close();
  }
});

test("full reset plan scopes Projects repos and refuses unsafe execution", async () => {
  const f = await fixture();
  const planResult = await createFullResetPlan({ db: f.store.db }, {
    rootPath: f.projects,
    databasePath: f.dbPath,
    backupPath: f.backupPath,
    manifestPath: f.manifestPath,
    minimumFreeBytesAfterBackup: 0,
  });
  const { plan } = planResult;
  assert.equal(plan.databasePath, f.dbPath);
  assert.deepEqual(plan.repositories.map((repo) => repo.canonicalRoot).sort(), [
    realpathSync(join(f.projects, "target-a")),
    realpathSync(join(f.projects, "target-b")),
  ]);
  assert.equal(plan.repositories.some((repo) => repo.repoId === f.outside.repoId), false);
  assert.equal(existsSync(f.backupPath), true);
  assert.equal(plan.risk, "full_corpus_reset");
  assert.equal(fullResetPlanDigest(plan), plan.planDigest);
  assert.notEqual(fullResetPlanDigest({ ...plan, rootPath: join(f.directory, "other") }), plan.planDigest);

  const beforeTarget = f.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(f.a.repoId, f.b.repoId).n;
  const wrongPath = executeFullReset({ db: f.store.db }, plan, {
    databasePath: join(f.directory, "unrelated.db"),
    token: plan.confirmationToken,
    manifestPath: f.manifestPath,
  });
  assert.equal(wrongPath.phase, "failed");
  assert.match(wrongPath.gaps.join("\n"), /RESET_DATABASE_PATH_MISMATCH/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(f.a.repoId, f.b.repoId).n, beforeTarget);

  const wrongToken = executeFullReset({ db: f.store.db }, plan, {
    databasePath: f.dbPath,
    token: "reset_invalid",
    manifestPath: f.manifestPath,
  });
  assert.equal(wrongToken.phase, "failed");
  assert.match(wrongToken.gaps.join("\n"), /RESET_CONFIRMATION_TOKEN_MISMATCH/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(f.a.repoId, f.b.repoId).n, beforeTarget);
  f.store.close();
});

test("full reset planning fails before backup when its post-copy disk reserve is unavailable", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      createFullResetPlan({ db: f.store.db }, {
        rootPath: f.projects,
        databasePath: f.dbPath,
        backupPath: f.backupPath,
        manifestPath: f.manifestPath,
        minimumFreeBytesAfterBackup: Number.MAX_SAFE_INTEGER,
      }),
      (error) => {
        assert.equal(error.code, "DATABASE_BACKUP_INSUFFICIENT_SPACE");
        assert.match(error.message, /^DATABASE_BACKUP_INSUFFICIENT_SPACE:/);
        return true;
      },
    );
    assert.equal(existsSync(f.backupPath), false);
    assert.equal(existsSync(f.manifestPath), false);
    assert.deepEqual(
      readdirSync(f.directory).filter((entry) => entry.includes("knowledge.db.backup.tmp-")),
      [],
    );
  } finally {
    f.store.close();
  }
});

test("full reset planning never reuses an existing backup from the same database instance", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.backupPath, "stale backup must not be trusted", { mode: 0o600 });
    await assert.rejects(
      createFullResetPlan({ db: f.store.db }, {
        rootPath: f.projects,
        databasePath: f.dbPath,
        backupPath: f.backupPath,
        manifestPath: f.manifestPath,
      }),
      /RESET_BACKUP_PATH_EXISTS/,
    );
    assert.equal(existsSync(f.manifestPath), false);
  } finally {
    f.store.close();
  }
});

test("full reset scopes and deletes more IDs than SQLite's variable limit", async () => {
  const f = await fixture();
  try {
    const insert = f.store.db.prepare(
      "INSERT INTO nodes(id,node_type,identity_key,title,repo_id,created_at) VALUES (?,?,?,?,?,?)",
    );
    const now = "2026-09-02T00:00:00.000Z";
    f.store.db.transaction(() => {
      for (let index = 0; index < 33_000; index += 1) {
        insert.run(
          `large-node-${index}`,
          "symbol",
          `${f.a.repoId}::large::${index}`,
          `LargeNode${index}`,
          f.a.repoId,
          now,
        );
      }
    }).immediate();

    const { plan } = await createFullResetPlan({ db: f.store.db }, {
      rootPath: f.projects,
      databasePath: f.dbPath,
      backupPath: f.backupPath,
      manifestPath: f.manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    const plannedRepo = plan.repositories.find((repo) => repo.repoId === f.a.repoId);
    assert.ok(plannedRepo.rowCounts.nodes > 32_766, JSON.stringify(plannedRepo.rowCounts));
    const receipt = executeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      token: plan.confirmationToken,
      manifestPath: f.manifestPath,
    });
    assert.equal(receipt.phase, "reset", JSON.stringify(receipt.gaps));
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE id LIKE 'large-node-%'").get().count, 0);
  } finally {
    f.store.close();
  }
});

test("full-corpus reset treats endpoint inventory generation as an intentional cache invalidation", async () => {
  const f = await fixture();
  try {
    f.store.db.prepare("UPDATE nodes SET node_type='endpoint' WHERE id=?").run(f.a.parserNode);
    f.store.db.prepare(`
      UPDATE branches
         SET current_snapshot_id=?, last_indexed_commit='fixture-head',
             last_indexed_at='2026-09-02T00:00:00.000Z', indexed_worktree_state='clean'
       WHERE id=?
    `).run(f.a.snapshotId, f.a.branchId);
    const before = Number(f.store.db.prepare(
      "SELECT value FROM meta WHERE key='endpoint_inventory_generation'",
    ).get().value);
    const { plan } = await createFullResetPlan({ db: f.store.db }, {
      rootPath: f.directory,
      databasePath: f.dbPath,
      backupPath: f.backupPath,
      manifestPath: f.manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    const receipt = executeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      token: plan.confirmationToken,
      manifestPath: f.manifestPath,
    });
    assert.equal(receipt.phase, "reset", JSON.stringify(receipt.gaps));
    assert.ok(receipt.intentionalProtectedAssetChanges.includes("meta.endpoint_inventory_generation"));
    assert.ok(receipt.intentionalProtectedAssetChanges.includes("branches.current_snapshot_id"));
    const branch = f.store.db.prepare(
      "SELECT current_snapshot_id,last_indexed_commit,last_indexed_at,indexed_worktree_state FROM branches WHERE id=?",
    ).get(f.a.branchId);
    assert.equal(branch.current_snapshot_id, null);
    assert.equal(branch.last_indexed_commit, null);
    assert.equal(branch.last_indexed_at, null);
    assert.equal(branch.indexed_worktree_state, "unknown");
    const after = Number(f.store.db.prepare(
      "SELECT value FROM meta WHERE key='endpoint_inventory_generation'",
    ).get().value);
    assert.ok(after > before, `${before} -> ${after}`);
  } finally {
    f.store.close();
  }
});

test("a consumed post-delete failure can be finalized only after all reset invariants are reverified", async () => {
  const core = await import("../packages/knowledge-core/dist/index.js");
  assert.equal(typeof core.finalizeFullReset, "function");
  const f = await fixture();
  try {
    const { plan } = await createFullResetPlan({ db: f.store.db }, {
      rootPath: f.directory,
      databasePath: f.dbPath,
      backupPath: f.backupPath,
      manifestPath: f.manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    const failed = executeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      token: plan.confirmationToken,
      manifestPath: f.manifestPath,
      failAt: "after_reset",
    });
    assert.equal(failed.phase, "failed");
    assert.equal(failed.databaseInstanceId, plan.databaseInstanceId);

    assert.throws(() => core.finalizeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      manifestPath: f.manifestPath,
      confirmed: false,
    }), /RESET_FINALIZE_CONFIRMATION_REQUIRED/);

    const finalized = core.finalizeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      manifestPath: f.manifestPath,
      confirmed: true,
    });
    assert.equal(finalized.phase, "reset", JSON.stringify(finalized.gaps));
    assert.notEqual(finalized.databaseInstanceId, plan.databaseInstanceId);
    assert.equal(Object.values(finalized.remainingTargetIndexRows).every((count) => count === 0), true);
    assert.equal(readResetManifest(f.manifestPath).phase, "reset");
  } finally {
    f.store.close();
  }
});

test("full reset and normal index writers share one fail-closed global owner", async () => {
  const f = await fixture();
  const { plan } = await createFullResetPlan({ db: f.store.db }, {
    rootPath: f.projects,
    databasePath: f.dbPath,
    backupPath: f.backupPath,
    manifestPath: f.manifestPath,
    minimumFreeBytesAfterBackup: 0,
  });

  f.store.acquireIndexMarker(f.a.branchId);
  try {
    const busy = executeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      token: plan.confirmationToken,
      manifestPath: f.manifestPath,
    });
    assert.equal(busy.phase, "failed");
    assert.match(busy.gaps.join("\n"), /RESET_INDEX_WRITER_BUSY/);
    assert.equal(readResetManifest(f.manifestPath).tokenConsumed, false);
  } finally {
    f.store.releaseIndexMarker(f.a.branchId);
  }

  const fencePath = `${f.dbPath}.full-reset.lock`;
  writeFileSync(fencePath, JSON.stringify({ formatVersion: 1, operationId: plan.operationId, pid: process.pid }));
  try {
    assert.throws(
      () => f.store.acquireIndexMarker(f.a.branchId),
      (error) => error.code === "INDEX_WRITER_BUSY" && /full-corpus reset/.test(error.message),
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='index_lock::global'").get().n,
      0,
    );
  } finally {
    unlinkSync(fencePath);
    f.store.close();
  }
});

test("full reset planning fences writers across backup and baseline capture", async () => {
  const f = await fixture();
  const concurrent = KnowledgeStore.open({
    dbPath: f.dbPath,
    ledgerPath: join(f.directory, "concurrent.ledger.jsonl"),
  });
  concurrent.db.pragma("busy_timeout = 1");
  try {
    let writerAttempt;
    const writerBlocked = new Promise((resolve, reject) => {
      writerAttempt = setImmediate(() => {
        try {
          concurrent.acquireIndexMarker(f.a.branchId);
          reject(new Error("concurrent writer unexpectedly acquired reset planning lock"));
        } catch (error) {
          if (error?.code === "INDEX_WRITER_BUSY" && error?.details?.scope === "global") resolve();
          else reject(error);
        }
      });
    });
    const directWriteBlocked = new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          concurrent.db.prepare("UPDATE meta SET value=value WHERE key='database_instance_id'").run();
          reject(new Error("direct SQLite writer unexpectedly acquired reset planning lock"));
        } catch (error) {
          if (error?.code === "SQLITE_BUSY" || /database is locked/.test(error.message)) resolve();
          else reject(error);
        }
      });
    });
    writerBlocked.catch(() => {});
    directWriteBlocked.catch(() => {});

    await createFullResetPlan({ db: f.store.db }, {
      rootPath: f.projects,
      databasePath: f.dbPath,
      backupPath: f.backupPath,
      manifestPath: f.manifestPath,
      minimumFreeBytesAfterBackup: 0,
    });
    await writerBlocked;
    await directWriteBlocked;
    clearImmediate(writerAttempt);
  } finally {
    concurrent.close();
    f.store.close();
  }
});

test("full reset writer fence is fail-closed and token is single-use", async () => {
  const f = await fixture();
  const { plan } = await createFullResetPlan({ db: f.store.db }, {
    rootPath: f.projects,
    databasePath: f.dbPath,
    backupPath: f.backupPath,
    manifestPath: f.manifestPath,
    minimumFreeBytesAfterBackup: 0,
  });
  const fencePath = `${f.dbPath}.full-reset.lock`;
  writeFileSync(fencePath, "{\"operationId\":\"other\"}\n", { flag: "wx", mode: 0o600 });
  const busy = executeFullReset({ db: f.store.db }, plan, {
    databasePath: f.dbPath,
    token: plan.confirmationToken,
    manifestPath: f.manifestPath,
  });
  assert.equal(busy.phase, "failed");
  assert.match(busy.gaps.join("\n"), /RESET_WRITER_FENCE_BUSY/);
  unlinkSync(fencePath);

  const receipt = executeFullReset({ db: f.store.db }, plan, {
    databasePath: f.dbPath,
    token: plan.confirmationToken,
    manifestPath: f.manifestPath,
  });
  assert.equal(receipt.phase, "reset");
  assert.equal(receipt.previousDatabaseInstanceId, plan.databaseInstanceId);
  assert.notEqual(receipt.databaseInstanceId, plan.databaseInstanceId);
  assert.deepEqual(receipt.intentionalProtectedAssetChanges, [
    "branches.stale_reason",
    "meta.index_lock::global",
    "meta.database_instance_id",
  ]);
  assert.equal(
    f.store.db.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get().value,
    receipt.databaseInstanceId,
  );
  assert.equal(receipt.sourceRepositoriesUntouched, true);
  assert.equal(receipt.rollbackAvailable, true);
  assert.equal(receipt.gaps.length, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(f.a.repoId, f.b.repoId).n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id=?").get(f.outside.repoId).n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id IN (?,?)").get(f.a.parserNode, f.b.parserNode).n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id=?").get(f.a.noteNode).n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE origin='parser' AND branch_id IN (?,?)").get(f.a.branchId, f.b.branchId).n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE origin<>'parser'").get().n, 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs WHERE id=?").get(f.a.sourceBlob).n, 0);
  const manifest = readResetManifest(f.manifestPath);
  assert.equal(manifest.tokenConsumed, true);
  assert.equal(manifest.phase, "reset");
  const reused = executeFullReset({ db: f.store.db }, plan, {
      databasePath: f.dbPath,
      token: plan.confirmationToken,
      manifestPath: f.manifestPath,
    });
  assert.equal(reused.phase, "failed");
  assert.match(reused.gaps.join("\n"), /RESET_PLAN_ALREADY_CONSUMED/);
  f.store.close();
});

test("full reset failure is transactional and rollback restores protected knowledge with a new instance", async () => {
  const f = await fixture();
  const planResult = await createFullResetPlan({ db: f.store.db }, {
    rootPath: f.projects,
    databasePath: f.dbPath,
    backupPath: f.backupPath,
    manifestPath: f.manifestPath,
    minimumFreeBytesAfterBackup: 0,
  });
  const failed = executeFullReset({ db: f.store.db }, planResult.plan, {
    databasePath: f.dbPath,
    token: planResult.plan.confirmationToken,
    manifestPath: f.manifestPath,
    failAt: "during_reset",
  });
  assert.equal(failed.phase, "failed");
  assert.match(failed.gaps.join("\n"), /RESET_INJECTED_FAILURE_DURING_RESET/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(f.a.repoId, f.b.repoId).n, 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id IN (?,?)").get(f.a.parserNode, f.b.parserNode).n, 2);
  assert.equal(existsSync(`${f.dbPath}.full-reset.lock`), false);
  f.store.close();

  const recovery = await fixture();
  const recoveryPlan = await createFullResetPlan({ db: recovery.store.db }, {
    rootPath: recovery.projects,
    databasePath: recovery.dbPath,
    backupPath: recovery.backupPath,
    manifestPath: recovery.manifestPath,
    minimumFreeBytesAfterBackup: 0,
  });
  const committedThenReportedFailure = executeFullReset({ db: recovery.store.db }, recoveryPlan.plan, {
    databasePath: recovery.dbPath,
    token: recoveryPlan.plan.confirmationToken,
    manifestPath: recovery.manifestPath,
    failAt: "after_reset",
  });
  assert.equal(committedThenReportedFailure.phase, "failed");
  assert.equal(recovery.store.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(recovery.a.repoId, recovery.b.repoId).n, 0);

  const destination = join(recovery.directory, "rollback-restored.db");
  const rollback = rollbackFullReset(
    { db: recovery.store.db },
    recovery.backupPath,
    destination,
    { confirmed: true },
  );
  assert.equal(rollback.integrity, "ok");
  assert.equal(rollback.sourceDatabaseInstanceId, recoveryPlan.plan.databaseInstanceId);
  assert.notEqual(rollback.restoredDatabaseInstanceId, recoveryPlan.plan.databaseInstanceId);
  const restored = KnowledgeStore.open({
    dbPath: destination,
    ledgerPath: join(recovery.directory, "rollback-restored.ledger.jsonl"),
  });
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM files_index WHERE repo_id IN (?,?)").get(recovery.a.repoId, recovery.b.repoId).n, 2);
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE origin='parser' AND branch_id IN (?,?)").get(recovery.a.branchId, recovery.b.branchId).n, 2);
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM notes_index WHERE node_id=?").get(recovery.a.noteNode).n, 1);
  const restoredAssets = captureProtectedAssets(restored, { ensureDatabaseInstanceId: false });
  assert.equal(restoredAssets.databaseInstanceId, rollback.restoredDatabaseInstanceId);
  for (const [key, expected] of Object.entries(recoveryPlan.protectedAssets.tables)) {
    const actual = restoredAssets.tables[key];
    assert.ok(actual, `missing restored protected asset ${key}`);
    if (key !== "meta") {
      assert.equal(actual.rowHash, expected.rowHash, `protected asset changed: ${key}`);
      continue;
    }
    const keyColumn = expected.columns.indexOf("key");
    assert.ok(keyColumn >= 0);
    const withoutInstanceId = (rows) => rows.filter((row) => row[keyColumn] !== "database_instance_id");
    assert.deepEqual(withoutInstanceId(actual.rows), withoutInstanceId(expected.rows));
  }
  assert.throws(
    () => rollbackFullReset({ db: recovery.store.db }, recovery.backupPath, destination, { confirmed: true }),
    /RESET_ROLLBACK_DESTINATION_EXISTS/,
  );
  restored.close();
  recovery.store.close();
});
