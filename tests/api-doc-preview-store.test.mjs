import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiDocPreviewStore, renderApiDocumentation } from "../packages/api-doc-generator/dist/index.js";
const base = { documentKey: "api-doc:v1:frontend:en-us:bbbbbbbbbbbbbbbb", title: "Doc", revisions: [{ revisionId: "r", repoId: "repo", repo: "repo", commitSha: "abc", trust: "exact_commit", resolutionSource: "commit" }], enums: [], endpoints: [], websocketEvents: [], commonResponses: [], frontendChecklist: [], evidence: [], gaps: [], coverage: { level: "exhaustive", analyzedRequestPartitions: 0, unresolvedRequestConstraints: 0, discoveredStaticExits: 0, resolvedStaticExits: 0, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "not_requested", blockers: [] } };
test("preview store is idempotent, loadable, diffable and protects references", () => {
  const store = new ApiDocPreviewStore(mkdtempSync(join(tmpdir(), "api-doc-preview-")));
  const rendered = renderApiDocumentation(base);
  const first = store.save({ ir: base, rendered, mode: "preview", now: new Date("2026-07-01T00:00:00Z") });
  assert.equal(first.status, "created");
  const same = store.save({ ir: base, rendered, mode: "preview", now: new Date("2026-07-01T00:01:00Z") });
  assert.equal(same.status, "no_change");
  assert.equal(store.load(first.previewId).manifest.documentKey, base.documentKey);
  assert.equal(store.setProtection(first.previewId, "pin", true).protectedBy.includes("pin"), true);
  assert.equal(store.list({ documentKey: base.documentKey }).length, 1);
});

test("empty and stale previews expose conservative evidence state", () => {
  const store = new ApiDocPreviewStore(mkdtempSync(join(tmpdir(), "api-doc-preview-honesty-")));
  const empty = { ...base, revisions: [], coverage: { ...base.coverage } };
  const rendered = renderApiDocumentation(empty);
  const saved = store.save({ ir: empty, rendered, mode: "preview", now: new Date("2026-07-01T00:00:00Z") });
  assert.equal(saved.manifest.coverage, "partial");
  assert.equal(saved.manifest.evidenceState, "empty");
  assert.equal(saved.manifest.proofStatus, "not_proven");
  assert.ok(saved.manifest.gaps.includes("document_evidence_empty"));

  const staleRoot = mkdtempSync(join(tmpdir(), "api-doc-preview-stale-"));
  const staleStore = new ApiDocPreviewStore(staleRoot);
  const current = staleStore.save({ ir: base, rendered: renderApiDocumentation(base), mode: "preview" });
  const staleManifestPath = join(staleRoot, current.previewId.replaceAll(":", "_"), "manifest.json");
  const currentManifest = JSON.parse(readFileSync(staleManifestPath, "utf8"));
  writeFileSync(staleManifestPath, JSON.stringify({
    ...currentManifest,
    coverage: "exhaustive",
    evidenceState: "current",
    proofStatus: "candidate",
    gaps: [],
  }));
  const loaded = staleStore.load(current.previewId, { currentRevisionIds: ["new-revision"] });
  assert.equal(loaded.manifest.evidenceState, "stale");
  assert.equal(loaded.manifest.proofStatus, "not_proven");
  assert.equal(loaded.manifest.coverage, "partial");
  assert.ok(loaded.manifest.gaps.includes("preview_revision_stale"));
  assert.deepEqual(loaded.manifest.currentRevisionIds, ["new-revision"]);
  const list = staleStore.listEnvelope({ currentRevisionIds: ["new-revision"] });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].evidenceState, "stale");
  assert.equal(list.freshness.status, "stale");
  assert.equal(list.completeness, "partial");
  assert.equal(list.proofStatus, "not_proven");
  assert.equal(list.totalIsExact, true);
  assert.equal(list.nextCursor, null);
  assert.ok(list.gaps.includes("preview_revision_stale"));
  assert.equal(list.coverage.unresolvedReferences, null);
  assert.ok(list.gaps.includes("unresolved_reference_coverage_unavailable"));

  const persisted = JSON.parse(readFileSync(staleManifestPath, "utf8"));
  assert.notEqual(persisted.evidenceState, "stale");
  assert.equal(Object.hasOwn(persisted, "currentRevisionIds"), false);
  assert.equal(persisted.gaps.includes("preview_revision_stale"), false);
});

test("preview list reports corrupt and missing manifests instead of silently dropping them", () => {
  const root = mkdtempSync(join(tmpdir(), "api-doc-preview-unreadable-"));
  mkdirSync(join(root, "preview_v1_missing"));
  mkdirSync(join(root, "preview_v1_corrupt"));
  writeFileSync(join(root, "preview_v1_corrupt", "manifest.json"), "{not-json");
  const list = new ApiDocPreviewStore(root).listEnvelope();
  assert.equal(list.items.length, 0);
  assert.equal(list.unreadableCount, 2);
  assert.equal(list.candidateCount, null);
  assert.equal(list.totalIsExact, false);
  assert.equal(list.completeness, "unknown");
  assert.equal(list.proofStatus, "not_proven");
  assert.ok(list.gaps.includes("api_doc_preview_unreadable"));
  assert.deepEqual(new Set(list.unreadable.map((item) => item.reason)), new Set(["missing_manifest", "corrupt_manifest"]));
});

test("preview list exposes injected permission/read failures", () => {
  const root = mkdtempSync(join(tmpdir(), "api-doc-preview-read-error-"));
  const normal = new ApiDocPreviewStore(root);
  normal.save({ ir: base, rendered: renderApiDocumentation(base), mode: "preview" });
  const denied = new ApiDocPreviewStore(root, {
    readText(path) {
      if (path.endsWith("manifest.json")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return readFileSync(path, "utf8");
    },
  });
  const list = denied.listEnvelope();
  assert.equal(list.unreadableCount, 1);
  assert.equal(list.unreadable[0].reason, "read_error");
  assert.equal(list.unreadable[0].code, "EACCES");
  assert.equal(list.candidateCount, null);
  assert.equal(list.totalIsExact, false);
  assert.ok(list.gaps.includes("api_doc_preview_unreadable"));
});
