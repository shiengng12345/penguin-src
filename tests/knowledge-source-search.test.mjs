import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, getSourceHit, searchSource, searchSourceTerms } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-source-search-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

function addSource(store, path, content) {
  const raw = Buffer.from(content, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const sourceStore = new SourceStore(store);
  const blobId = sourceStore.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: content, encoding: "utf8" });
  return sourceStore.putSourceFact({ repoId: "repo-1", filePath: path, factFingerprint: hash, contentHash: hash, sourceBlobId: blobId,
    coverage: { status: "admitted", reasonCode: "text_searchable", classification: "documentation" } });
}

test("source search returns every verified occurrence in the resolved snapshot", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "main", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const fact = addSource(store, "docs/guide.md", "zero\nUniversalNeedle here\nUniversalNeedle again\n");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "docs/guide.md", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  const hits = searchSource(store, { snapshotId: snapshot.id, repoId: "repo-1" }, { query: "UniversalNeedle", mode: "exact", options: { caseSensitive: true, wholeWord: false } });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((hit) => hit.startLine), [2, 3]);
  assert.equal(hits[0].filePath, "docs/guide.md");
  assert.equal(hits[0].verified, true);
  assert.ok(getSourceHit(store, { snapshotId: snapshot.id, filePath: "docs/guide.md", repoId: "repo-1" }));
  assert.equal(getSourceHit(store, { snapshotId: snapshot.id, filePath: "docs/guide.md", repoId: "other-repo" }), null);
  store.close();
});

test("short punctuation queries use the same scope and can find source text", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "short", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const fact = addSource(store, "src/a.ts", "const x = a?.b;\n");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/a.ts", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  assert.equal(searchSource(store, { snapshotId: snapshot.id }, { query: "?.", mode: "substring", options: { caseSensitive: true, wholeWord: false } }).length, 1);
  store.close();
});

test("source search exposes an indexed scope plan and honours cancellation between blob batches", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "plan", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const fact = addSource(store, "src/plan.ts", "plan-indexed-needle\n");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/plan.ts", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN
    SELECT e.file_path FROM effective_snapshot_sources e
    JOIN source_blobs b ON b.id=e.source_blob_id
    WHERE e.snapshot_id=? AND e.source_blob_id IN
      (SELECT source_blob_id FROM source_blob_trigrams WHERE trigram IN (?, ?, ?) GROUP BY source_blob_id)`).all(snapshot.id, "pla", "lan", "ane");
  assert.equal(plan.some((row) => /SCAN source_facts/i.test(String(row.detail))), false);
  assert.ok(plan.some((row) => /idx_effective_snapshot_sources_snapshot_blob/i.test(String(row.detail))));
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => searchSource(store, { snapshotId: snapshot.id }, { query: "plan-indexed-needle", mode: "exact", options: { caseSensitive: true, wholeWord: false } }, { signal: controller.signal }), /SEARCH_CANCELLED/);
  store.close();
});

test("source search stops materializing occurrences at the caller's cap", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "cap", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const fact = addSource(store, "docs/cap.md", "CapNeedle\nCapNeedle\nCapNeedle\nCapNeedle\nCapNeedle\n");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "docs/cap.md", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  const hits = searchSource(store, { snapshotId: snapshot.id, repoId: "repo-1" }, { query: "CapNeedle", mode: "exact", options: { caseSensitive: true, wholeWord: false } }, { maxOccurrences: 3 });
  assert.equal(hits.length, 3);
  store.close();
});

test("source search restricts occurrences to the requested path prefixes before the cap applies", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "paths", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const noisy = addSource(store, "vendor/noise.md", "PathNeedle\nPathNeedle\nPathNeedle\nPathNeedle\n");
  const wanted = addSource(store, "docs/wanted.md", "PathNeedle\n");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [
    { op: "add", path: "vendor/noise.md", sourceFactId: noisy },
    { op: "add", path: "docs/wanted.md", sourceFactId: wanted },
  ]);
  cow.materializeManifest(snapshot.id);
  const hits = searchSource(store, { snapshotId: snapshot.id, repoId: "repo-1" }, { query: "PathNeedle", mode: "exact", options: { caseSensitive: true, wholeWord: false } }, { paths: ["docs"], maxOccurrences: 2 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].filePath, "docs/wanted.md");
  store.close();
});

test("source search does not materialize a snapshot after an indexed trigram miss", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "miss", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const fact = addSource(store, "src/unrelated.ts", "a completely unrelated source file\n");
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/unrelated.ts", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  const hits = searchSource(store, { snapshotId: snapshot.id, repoId: "repo-1" }, { query: "cpfLookupResults", mode: "exact", options: { caseSensitive: true, wholeWord: false } });
  assert.deepEqual(hits, []);
  store.close();
});

test("source search without trigram prefilters decoded blobs inside SQLite", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "sqlite-prefilter", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const wanted = addSource(store, "src/wanted.ts", "SqlPrefilterNeedle\n");
  const noise = addSource(store, "src/noise.ts", "unrelated\n".repeat(100));
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/wanted.ts", sourceFactId: wanted }, { op: "add", path: "src/noise.ts", sourceFactId: noise }]);
  cow.materializeManifest(snapshot.id);
  const prepare = store.db.prepare.bind(store.db);
  const statements = [];
  store.db.prepare = (sql) => { statements.push(String(sql)); return prepare(sql); };
  try {
    const hits = searchSource(store, { snapshotId: snapshot.id, repoId: "repo-1" }, { query: "sqlprefilterneedle", mode: "substring", options: { caseSensitive: false, wholeWord: false } });
    assert.equal(hits.length, 1);
    assert.ok(statements.some((sql) => /instr\(lower\(b\.decoded_content\), lower\(\?\)\)/i.test(sql)));
  } finally {
    store.db.prepare = prepare;
    store.close();
  }
});

test("multi-term source search scans decoded content once without repeated SQL lowercase transforms", () => {
  const store = openStore();
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "multi-term-prefilter", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10 });
  const both = addSource(store, "src/both.ts", "PLAYER withdrawal Approval\n");
  const one = addSource(store, "src/one.ts", "Player profile\n");
  const noise = addSource(store, "src/noise.ts", "unrelated\n".repeat(100));
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [
    { op: "add", path: "src/both.ts", sourceFactId: both },
    { op: "add", path: "src/one.ts", sourceFactId: one },
    { op: "add", path: "src/noise.ts", sourceFactId: noise },
  ]);
  cow.materializeManifest(snapshot.id);
  const prepare = store.db.prepare.bind(store.db);
  const statements = [];
  store.db.prepare = (sql) => { statements.push(String(sql)); return prepare(sql); };
  try {
    const hits = searchSourceTerms(
      store,
      { snapshotId: snapshot.id, repoId: "repo-1" },
      ["player", "withdrawal", "approval"],
      { mode: "substring", options: { caseSensitive: false, wholeWord: false, includeGenerated: false, includeVendor: false } },
    );
    assert.deepEqual(new Set(hits.map((hit) => hit.term)), new Set(["player", "withdrawal", "approval"]));
    const decodedScans = statements.filter((sql) => /JOIN source_blobs b/i.test(sql));
    assert.equal(decodedScans.length, 1, decodedScans.join("\n---\n"));
    assert.doesNotMatch(decodedScans[0], /instr\(lower\(b\.decoded_content\)/i);
    assert.equal((decodedScans[0].match(/b\.decoded_content LIKE \? ESCAPE/gi) ?? []).length, 3);
  } finally {
    store.db.prepare = prepare;
    store.close();
  }
});
