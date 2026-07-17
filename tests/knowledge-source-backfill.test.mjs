import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, backfillSourceCorpus } from "../packages/knowledge-core/dist/index.js";

test("source backfill reads matching git content and never reconstructs from facts_json", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-source-backfill-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "README.md"), "historical backfill needle\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture"]);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const raw = Buffer.from("historical backfill needle\n", "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const store = KnowledgeStore.open({ dbPath: join(root, "knowledge.db"), ledgerPath: join(root, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "backfill", rootPath: root });
  store.db.prepare("INSERT INTO revision_snapshots (id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at,pinned) VALUES (?,?,?,?,?,?,?,?,?,?,0)").run("snap", "snap", repoId, commit, "p", "r", 11, "ready", new Date().toISOString(), new Date().toISOString());
  store.db.prepare("INSERT INTO file_facts (id,repo_id,file_path,content_hash,language,parser_version,facts_json,exports_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("fact", repoId, "README.md", hash, "markdown", "p", JSON.stringify({ fake: "must not be read" }), "x", new Date().toISOString());
  store.db.prepare("INSERT INTO effective_snapshot_files(snapshot_id,file_path,file_fact_id) VALUES (?,?,?)").run("snap", "README.md", "fact");
  const report = await backfillSourceCorpus({ store, repoId, batchSize: 1, dryRun: false });
  assert.equal(report.processed, 1);
  const source = store.db.prepare("SELECT sf.id,b.decoded_content FROM effective_snapshot_sources e JOIN source_facts sf ON sf.id=e.source_fact_id JOIN source_blobs b ON b.id=e.source_blob_id WHERE e.snapshot_id='snap'").get();
  assert.match(source.decoded_content, /historical backfill needle/);
  assert.ok(store.db.prepare("SELECT 1 FROM source_backfill_checkpoints WHERE scope=?").get(repoId));
  store.close();
});

test("source backfill records revision content mismatch as unavailable coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-source-backfill-mismatch-"));
  writeFileSync(join(root, "README.md"), "current content\n");
  const store = KnowledgeStore.open({ dbPath: join(root, "knowledge.db"), ledgerPath: join(root, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "mismatch", rootPath: root });
  store.db.prepare("INSERT INTO revision_snapshots (id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at,pinned) VALUES (?,?,?,?,?,?,?,?,?,?,0)").run("snap-mismatch", "snap-mismatch", repoId, null, "p", "r", 11, "ready", new Date().toISOString(), new Date().toISOString());
  store.db.prepare("INSERT INTO file_facts (id,repo_id,file_path,content_hash,language,parser_version,facts_json,exports_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("fact-mismatch", repoId, "README.md", "wrong-hash", "markdown", "p", "{}", "x", new Date().toISOString());
  store.db.prepare("INSERT INTO effective_snapshot_files(snapshot_id,file_path,file_fact_id) VALUES (?,?,?)").run("snap-mismatch", "README.md", "fact-mismatch");
  const report = await backfillSourceCorpus({ store, repoId, batchSize: 1, dryRun: false });
  assert.equal(report.unavailable, 1);
  assert.equal(store.db.prepare("SELECT reason_code FROM coverage_records WHERE repo_id=? AND file_path=?").get(repoId, "README.md").reason_code, "revision_content_unavailable");
  store.close();
});

test("source backfill dry-run reports bytes without mutating source corpus", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-source-backfill-dry-"));
  writeFileSync(join(root, "README.md"), "dry run content\n");
  const store = KnowledgeStore.open({ dbPath: join(root, "knowledge.db"), ledgerPath: join(root, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "dry", rootPath: root });
  const raw = Buffer.from("dry run content\n");
  const hash = createHash("sha256").update(raw).digest("hex");
  store.db.prepare("INSERT INTO revision_snapshots (id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at,pinned) VALUES (?,?,?,?,?,?,?,?,?,?,0)").run("snap-dry", "snap-dry", repoId, null, "p", "r", 11, "ready", new Date().toISOString(), new Date().toISOString());
  store.db.prepare("INSERT INTO file_facts (id,repo_id,file_path,content_hash,language,parser_version,facts_json,exports_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("fact-dry", repoId, "README.md", hash, "markdown", "p", "{}", "x", new Date().toISOString());
  store.db.prepare("INSERT INTO effective_snapshot_files(snapshot_id,file_path,file_fact_id) VALUES (?,?,?)").run("snap-dry", "README.md", "fact-dry");
  const report = await backfillSourceCorpus({ store, repoId, batchSize: 1, dryRun: true });
  assert.equal(report.processed, 1);
  assert.equal(report.bytes, raw.byteLength);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_backfill_checkpoints").get().n, 0);
  store.close();
});
