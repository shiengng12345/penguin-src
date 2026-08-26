import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, getSourceHit, searchSource } from "../packages/knowledge-core/dist/index.js";

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
