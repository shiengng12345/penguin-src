import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
