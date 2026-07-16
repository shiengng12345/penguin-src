import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderApiDocumentation, syncManagedDocument } from "../packages/api-doc-generator/dist/index.js";

function preview() {
  const ir = { documentKey: "doc:test", title: "Test", revisions: [{ revisionId: "r1", repoId: "repo", repo: "repo", commitSha: "abc", trust: "exact_commit", resolutionSource: "commit" }], enums: [], endpoints: [{ endpointKey: "ep", revisionId: "r1", service: "Auth", method: "Login", route: "/login", protocol: "grpc", description: "", dependencies: [], headers: [], requestSchema: [], responseSchema: [], requestClasses: [], responseClasses: [], examples: [], frontendGuidance: [], evidenceIds: [], gaps: [], coverage: { level: "partial", analyzedRequestPartitions: 0, unresolvedRequestConstraints: 0, discoveredStaticExits: 0, resolvedStaticExits: 0, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "not_requested", blockers: [] } }], websocketEvents: [], commonResponses: [], frontendChecklist: [], evidence: [], gaps: [], coverage: { level: "partial", analyzedRequestPartitions: 0, unresolvedRequestConstraints: 0, discoveredStaticExits: 0, resolvedStaticExits: 0, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "not_requested", blockers: [] } };
  const rendered = renderApiDocumentation(ir); return { manifest: { previewId: "p", documentKey: ir.documentKey, revisionSetHash: rendered.revisionSetHash, mode: "preview", title: ir.title, subjects: [], searchTerms: [], coverage: "partial", sectionHashes: Object.fromEntries(rendered.sections.map((s) => [s.sectionKey, s.contentHash])), revisionIds: ["r1"], sourceCommits: { repo: "abc" }, createdAt: "", updatedAt: "", protectedBy: [] }, ir, rendered };
}
function fakeClient(initial) { let doc = { nodeToken: "node", documentId: "doc", revisionId: 1, blocks: initial }; return { get doc() { return doc; }, async fetchFull() { return structuredClone(doc); }, async replaceSection({ sectionKey, xml, revisionId }) { const marker = `PENGUIN_API_DOC_BEGIN:v1:doc:test:${sectionKey}`; const blocks = doc.blocks.filter((block) => !block.xml.includes(marker) && !block.xml.includes(`PENGUIN_API_DOC_END:v1:doc:test:${sectionKey}`)); const parts = xml.match(/<p style="color:#999999">.*?<\/p>|<h2>.*?<\/h2>|<p>.*?<\/p>/g) ?? [xml]; blocks.push(...parts.map((part, index) => ({ blockId: `b${doc.revisionId + 1}-${index}`, topLevelIndex: blocks.length + index, xml: part }))); doc = { ...doc, revisionId: revisionId + 1, blocks }; return { revisionId: doc.revisionId }; }, async deleteSection() { return { revisionId: ++doc.revisionId }; }, async createDraft() { return { nodeToken: "draft", revisionId: 1 }; } }; }

test("managed Lark sync is idempotent and refetches after writes", async () => {
  const desired = preview(); const client = fakeClient([]); const dir = mkdtempSync(join(tmpdir(), "penguin-lark-sync-"));
  const binding = { documentKey: "doc:test", nodeToken: "node", documentId: "doc", lastRevisionId: 1, sectionHashes: {}, previewId: "p", sourceRevisions: ["r1"] };
  const first = await syncManagedDocument({ preview: desired, binding, client, journalDir: dir }); assert.equal(first.status, "synced");
  const second = await syncManagedDocument({ preview: desired, binding: first.binding, client, journalDir: dir }); assert.equal(second.status, "no_change");
});

test("managed Lark sync refuses human edits instead of overwriting them", async () => {
  const desired = preview();
  const client = fakeClient([
    { blockId: "begin", topLevelIndex: 0, xml: '<p style="color:#999999">PENGUIN_API_DOC_BEGIN:v1:doc:test:summary</p>' },
    { blockId: "human", topLevelIndex: 1, xml: "<p>human content</p>" },
    { blockId: "end", topLevelIndex: 2, xml: '<p style="color:#999999">PENGUIN_API_DOC_END:v1:doc:test:summary</p>' },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "penguin-lark-conflict-"));
  const binding = { documentKey: "doc:test", nodeToken: "node", documentId: "doc", lastRevisionId: 1, sectionHashes: { summary: "old" }, previewId: "p", sourceRevisions: ["r1"] };
  const result = await syncManagedDocument({ preview: desired, binding, client, journalDir: dir }); assert.equal(result.status, "conflict"); assert.deepEqual(result.conflict?.sectionKeys, ["summary"]); assert.equal(client.doc.revisionId, 1);
});
