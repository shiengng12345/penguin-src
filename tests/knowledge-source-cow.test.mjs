import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, searchSource, searchPath } from "../packages/knowledge-core/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-source-cow-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

function source(store, path, text, fingerprint = text) {
  const raw = Buffer.from(text, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const blobs = new SourceStore(store);
  const blobId = blobs.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: text, encoding: "utf8" });
  return blobs.putSourceFact({ repoId: "repo-1", filePath: path, factFingerprint: fingerprint, contentHash: hash, sourceBlobId: blobId,
    coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
}

function snapshot(store, key, baseSnapshotId) {
  return new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: key, repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 10, baseSnapshotId });
}

test("source snapshots inherit by COW and isolate delete/rename", () => {
  const store = openStore();
  const blobs = new SourceStore(store);
  const cow = new SourceSnapshotStore(store);
  const base = snapshot(store, "main@head", undefined);
  const baseFact = source(store, "docs/readme.md", "base universal needle");
  cow.replaceOverlay(base.id, [{ op: "add", path: "docs/readme.md", sourceFactId: baseFact }]);
  cow.materializeManifest(base.id);
  assert.deepEqual([...cow.effectiveManifest(base.id)], [["docs/readme.md", baseFact]]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM file_fact_sources WHERE source_fact_id=?").get(baseFact).n, 0);
  assert.equal(blobs.getEffectiveSource(base.id, "docs/readme.md")?.sourceFactId, baseFact);

  const feature = snapshot(store, "feature@dirty", base.id);
  const changedFact = source(store, "docs/renamed.md", "feature universal needle");
  cow.replaceOverlay(feature.id, [
    { op: "delete", path: "docs/readme.md", sourceFactId: null },
    { op: "add", path: "docs/renamed.md", sourceFactId: changedFact, renamedFrom: "docs/readme.md" },
  ]);
  cow.materializeManifest(feature.id);
  assert.equal(blobs.getEffectiveSource(feature.id, "docs/readme.md"), undefined);
  assert.equal(blobs.getEffectiveSource(feature.id, "docs/renamed.md")?.sourceFactId, changedFact);
  assert.equal(blobs.getEffectiveSource(base.id, "docs/readme.md")?.sourceFactId, baseFact);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM effective_snapshot_sources WHERE snapshot_id=?").get(feature.id).n, 1);
  const request = { query: "universal needle", mode: "substring", options: { caseSensitive: true, wholeWord: false } };
  assert.equal(searchSource(store, { repoId: "repo-1", snapshotId: base.id }, request).length, 1);
  assert.equal(searchSource(store, { repoId: "repo-1", snapshotId: feature.id }, request).length, 1);
  assert.equal(searchSource(store, { repoId: "repo-1", snapshotId: feature.id }, { ...request, query: "base universal needle" }).length, 0);
  assert.equal(searchPath(store, { repoId: "repo-1", snapshotId: feature.id }, "docs/readme.md").length, 0);
  assert.equal(searchPath(store, { repoId: "repo-1", snapshotId: feature.id }, "docs/renamed.md")[0]?.filePath, "docs/renamed.md");
  const before = store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n;
  const sameFact = source(store, "docs/same.md", "base universal needle");
  const second = snapshot(store, "feature@same", base.id);
  cow.replaceOverlay(second.id, [{ op: "add", path: "docs/same.md", sourceFactId: sameFact }]);
  cow.materializeManifest(second.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n, before);
  assert.equal(searchSource(store, { repoId: "repo-1", snapshotId: second.id }, request).length, 2);
  store.close();
});
