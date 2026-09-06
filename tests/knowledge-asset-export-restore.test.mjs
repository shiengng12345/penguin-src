import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  captureProtectedAssets,
  createConsistentDatabaseBackup,
  restoreProtectedAssets,
} from "../packages/knowledge-core/dist/index.js";

function openStore(directory, name) {
  return KnowledgeStore.open({
    dbPath: join(directory, `${name}.db`),
    ledgerPath: join(directory, `${name}.ledger.jsonl`),
  });
}

function insertProtectedFixtures(store) {
  const repoId = store.registerRepo({ name: "protected", rootPath: "/fixture/protected" });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "head-1", status: "live" });
  const noteNodeId = store.upsertNode({ nodeType: "note", identityKey: "note:architecture", repoId, title: "Architecture" });
  const credentialNodeId = store.upsertNode({ nodeType: "credential", identityKey: "credential:test", repoId, title: "Test credential" });
  const now = "2026-09-01T00:00:00.000Z";
  store.db.prepare(
    "INSERT INTO notes_index(node_id,path,frontmatter,sensitive,ai_access,mcp_access,content_hash) VALUES (?,?,?,?,?,?,?)",
  ).run(noteNodeId, "notes/architecture.md", '{"owner":"penguin"}', 0, "allowed", "allowed", "note-hash");
  store.db.prepare(
    "INSERT INTO fts_notes(node_id,title,body) VALUES (?,?,?)",
  ).run(noteNodeId, "Architecture", "Protected architecture note");
  store.db.prepare(
    "INSERT INTO note_properties(note_node_id,property_key,ordinal,value_type,value_text,value_number,value_boolean,value_date,source_line) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(noteNodeId, "owner", 0, "text", "penguin", null, null, null, 1);
  store.db.prepare(
    "INSERT INTO note_links(source_node_id,source_line,raw_target,target_node_id,target_anchor,display_text,embedded,resolution_status) VALUES (?,?,?,?,?,?,?,?)",
  ).run(noteNodeId, 3, "[[Architecture]]", noteNodeId, null, "Architecture", 0, "resolved");
  store.db.prepare(
    "INSERT INTO credential_entries(node_id,title,kind,body,created_at) VALUES (?,?,?,?,?)",
  ).run(credentialNodeId, "Test credential", "token", "protected-secret", now);
  store.db.prepare(
    "INSERT INTO response_samples(id,endpoint_id,endpoint_key,status,content_type,sample,captured_at) VALUES (?,?,?,?,?,?,?)",
  ).run("sample-1", "endpoint-1", "VersionService.Version", "200", "application/json", '{"version":"1.0.0"}', now);
  store.db.prepare(
    "INSERT INTO why_cards(id,subject_json,question,answer,decision,alternatives_json,constraints_json,consequences_json,evidence_json,gaps_json,status,revision_id,owners_json,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("why-1", '{"subject":"index"}', "Why?", "Because evidence matters", "keep", "[]", "[]", "[]", "[]", "[]", "accepted", null, '["penguin"]', now, null);
  store.db.prepare(
    "INSERT INTO memory_items(id,class,scope_json,subject,body,source_json,confidence,retention,status,expires_at,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("memory-1", "decision", "{}", "index policy", "Never trust an unverified snapshot", "{}", 0.99, "persistent", "active", null, "memory-hash", now, now);
  store.db.prepare(
    "INSERT INTO ontology_terms(id,canonical_name,aliases_json,scope_json,term_type,definition,evidence_json,status) VALUES (?,?,?,?,?,?,?,?)",
  ).run("term-1", "protected asset", "[]", "{}", "concept", "An asset that survives rebuild", "[]", "active");
  store.db.prepare(
    "INSERT INTO ontology_links(from_id,to_id,relation,evidence_json) VALUES (?,?,?,?)",
  ).run("term-1", "term-1", "self", "[]");
  store.db.prepare(
    "INSERT INTO saved_queries(id,name,request_json,scope_json,contract_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("query-1", "protected query", "{}", "{}", "2", now, now);
  store.db.prepare(
    "INSERT INTO trust_evidence(id,status,source_type,locator,revision_id,environment,content_hash,query_hash,observed_at,expires_at,redaction_policy,claim_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("evidence-1", "verified", "test", "test://evidence/1", null, "test", "evidence-hash", "query-hash", now, null, "default", "[]");
  store.db.prepare(
    "INSERT INTO validated_findings(id,title,severity,claim,affected_scopes_json,reproduction_json,status,gaps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run("finding-1", "baseline finding", "low", "baseline is restorable", "[]", "{}", "open", "[]", now, now);
  store.db.prepare(
    "INSERT INTO finding_evidence(finding_id,evidence_id,evidence_role) VALUES (?,?,?)",
  ).run("finding-1", "evidence-1", "supports");
  store.db.prepare(
    "INSERT INTO search_feedback(id,query_hash,hit_id,verdict,correction_json,scope_hash,capability_hash,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("feedback-1", "query-hash", "hit-1", "useful", null, "scope-hash", "capability-hash", now);
  store.db.prepare(
    "INSERT INTO reflection_suggestions(id,status,reproduction_json,evidence_json,created_at,reviewed_at) VALUES (?,?,?,?,?,?)",
  ).run("reflection-1", "pending", "{}", "[]", now, null);
  store.db.prepare(
    "INSERT INTO external_knowledge_sources(id,source_type,location,config_json,status,content_hash,final_url,content_type,retrieved_at,license_warning,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("external-1", "markdown", "file:///fixture", "{}", "ready", "external-hash", null, "text/markdown", now, null, now);
  return { repoId, branchId, noteNodeId };
}

test("protected assets export, SQLite backup, exact restore, and tamper detection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-assets-"));
  const source = openStore(directory, "source");
  insertProtectedFixtures(source);
  const sourceAssets = captureProtectedAssets(source, { ensureDatabaseInstanceId: false });
  assert.ok(sourceAssets.databaseInstanceId.startsWith("db_"));
  assert.ok(sourceAssets.tables.credential_entries.rows.length === 1);
  assert.ok(sourceAssets.tables.why_cards.rows.length === 1);
  assert.ok(sourceAssets.bundleHash.length === 64);

  const backupPath = join(directory, "knowledge.db.backup");
  const backup = await createConsistentDatabaseBackup({ db: source.db }, backupPath);
  assert.equal(backup.integrity, "ok");
  assert.ok(backup.bytes > 0);
  assert.ok(backup.estimatedBytes >= backup.bytes);
  assert.ok(backup.availableBytesBefore > backup.estimatedBytes);
  assert.equal(backup.minimumFreeBytesAfterBackup, 512 * 1024 * 1024);
  assert.equal(
    backup.availableBytesAfterEstimate,
    backup.availableBytesBefore - backup.estimatedBytes,
  );
  assert.equal(existsSync(backupPath), true);
  assert.equal(statSync(backupPath).size, backup.bytes);

  const destination = openStore(directory, "destination");
  assert.throws(
    () => restoreProtectedAssets({ db: destination.db }, sourceAssets, { confirmed: true }),
    /DESTINATION_NOT_EMPTY/,
  );
  const receipt = restoreProtectedAssets(
    { db: destination.db },
    sourceAssets,
    { confirmed: true, replaceExisting: true, backupPath },
  );
  assert.equal(receipt.exact, true);
  assert.equal(receipt.backupPath, backupPath);
  assert.equal(receipt.restoredDatabaseInstanceId, sourceAssets.databaseInstanceId);
  assert.deepEqual(receipt.gaps, []);
  const restoredAssets = captureProtectedAssets(destination, { ensureDatabaseInstanceId: false });
  assert.equal(restoredAssets.bundleHash, sourceAssets.bundleHash);
  assert.equal(destination.db.prepare("SELECT body FROM credential_entries").get().body, "protected-secret");
  assert.equal(destination.db.prepare("SELECT COUNT(*) AS n FROM why_cards").get().n, 1);

  const tampered = structuredClone(sourceAssets);
  tampered.tables.meta.rows[0][1] = "tampered";
  assert.throws(
    () => restoreProtectedAssets({ db: destination.db }, tampered, { confirmed: true, replaceExisting: true }),
    /CHECKSUM_MISMATCH/,
  );
  destination.close();
  source.close();
});

test("database backup fails before writing when the post-backup reserve is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-backup-space-"));
  const source = openStore(directory, "source");
  const backupPath = join(directory, "knowledge.db.backup");
  try {
    await assert.rejects(
      createConsistentDatabaseBackup({ db: source.db }, backupPath, {
        minimumFreeBytesAfterBackup: Number.MAX_SAFE_INTEGER,
      }),
      (error) => {
        assert.equal(error.code, "DATABASE_BACKUP_INSUFFICIENT_SPACE");
        assert.match(error.message, /^DATABASE_BACKUP_INSUFFICIENT_SPACE:/);
        assert.ok(error.estimatedBytes > 0);
        assert.equal(error.minimumFreeBytesAfterBackup, Number.MAX_SAFE_INTEGER);
        return true;
      },
    );
    assert.equal(existsSync(backupPath), false);
    assert.deepEqual(
      readdirSync(directory).filter((entry) => entry.includes("knowledge.db.backup.tmp-")),
      [],
    );
  } finally {
    source.close();
  }
});

test("corpus baseline CLI forwards its disk reserve and fails before backup output", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-baseline-space-"));
  const rootPath = join(directory, "Projects");
  const outputPath = join(directory, "baseline");
  mkdirSync(rootPath, { recursive: true });
  const source = openStore(directory, "source");
  source.close();

  const result = spawnSync(process.execPath, [
    join(process.cwd(), "scripts", "knowledge-corpus-baseline.mjs"),
    `--root=${rootPath}`,
    `--db=${join(directory, "source.db")}`,
    `--out=${outputPath}`,
    `--minimum-free-after-bytes=${Number.MAX_SAFE_INTEGER}`,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_BACKUP_INSUFFICIENT_SPACE/);
  assert.equal(existsSync(join(outputPath, "knowledge.db.backup")), false);
  assert.deepEqual(
    existsSync(outputPath)
      ? readdirSync(outputPath).filter((entry) => entry.includes("knowledge.db.backup.tmp-"))
      : [],
    [],
  );
});
