import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, searchRegex } from "../packages/knowledge-core/dist/index.js";

function setup(content) {
  const dir = mkdtempSync(join(tmpdir(), "pk-regex-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "regex", repoId: "repo-1", parserVersion: "p", resolverVersion: "r", schemaVersion: 11 });
  const raw = Buffer.from(content, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store);
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: content, encoding: "utf8" });
  const fact = source.putSourceFact({ repoId: "repo-1", filePath: "src/a.ts", factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/a.ts", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  return { store, snapshot };
}

test("regex search uses RE2 and returns verified locations", () => {
  const { store, snapshot } = setup("const userId = 'u1';\nconst userId = 'u2';\n");
  const result = searchRegex(store, { snapshotId: snapshot.id }, "userId = '[^']+'", { flags: "g" });
  assert.equal(result.status, "ok");
  assert.equal(result.hits.length, 2);
  store.close();
});

test("unsupported regex syntax is an explicit error and never falls back to JS RegExp", () => {
  const { store, snapshot } = setup("abc\n");
  const result = searchRegex(store, { snapshotId: snapshot.id }, "(?<=a)bc");
  assert.equal(result.status, "error");
  assert.equal(result.code, "REGEX_UNSUPPORTED");
  store.close();
});

test("regex budget is explicit unless partial results are opted in", () => {
  const { store, snapshot } = setup("needle\nneedle\n");
  const blocked = searchRegex(store, { snapshotId: snapshot.id }, "needle", { maxScannedBytes: 1 });
  assert.equal(blocked.status, "error");
  assert.equal(blocked.code, "SEARCH_BUDGET_EXCEEDED");
  const partial = searchRegex(store, { snapshotId: snapshot.id }, "needle", { maxScannedBytes: 1, allowPartial: true });
  assert.equal(partial.status, "ok");
  assert.equal(partial.truncated, true);
  store.close();
});
