import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { runApiDocCommand } from "../packages/knowledge-cli/dist/api-doc-command.js";
import { ApiDocPreviewStore, renderApiDocumentation } from "../packages/api-doc-generator/dist/index.js";

function adapter() {
  const revision = { revisionId: "rev-1", repoId: "repo-1", repo: "fpms", branch: "main", commitSha: "abc", trust: "exact_commit", resolutionSource: "commit" };
  const subject = { subjectId: "subject-1", identityKey: "endpoint:fpms:Auth:Login", repoId: "repo-1", repo: "fpms", endpointKey: "endpoint:fpms:Auth:Login", service: "Auth", method: "Login", route: "/auth/login", protocol: "grpc" };
  const endpoint = { endpointKey: subject.endpointKey, revisionId: revision.revisionId, service: subject.service, method: subject.method, route: subject.route, protocol: subject.protocol, requestFields: [], responseFields: [], enums: [], schemaGaps: [], evidenceIds: [] };
  return { async resolveSubjects() { return { status: "resolved", subjects: [subject] }; }, async resolveRevisions() { return [revision]; }, async collectEndpoint() { return endpoint; }, async collectRequestConstraints() { return []; }, async collectResponseProducers() { return []; }, async collectCodeFacts() { return []; }, async collectTestFacts() { return []; }, async collectWikiFacts() { return []; }, async collectEvents() { return []; }, async collectChecklistFacts() { return []; } };
}

test("api-doc CLI generates and reads an immutable local preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-api-cli-")); const output = []; const errors = [];
  const deps = { cwd: dir, out: (line) => output.push(line), err: (line) => errors.push(line), openStore: () => { throw new Error("not needed"); }, storeExists: () => false, apiDocPreviewRoot: join(dir, "previews"), apiDocSourceAdapter: adapter(), readStdin: async () => JSON.stringify({ subjects: [{ service: "Auth", method: "Login" }], revision: { commitSha: "abc" }, audience: "frontend", language: "en", mode: "preview", includeRuntimeEvidence: false }) };
  const first = await runCli(["api-doc", "generate", "--request", "-", "--json"], deps); assert.equal(first, 0);
  const saved = JSON.parse(output.at(-1)); assert.equal(saved.status, "created");
  const listed = await runCli(["api-doc", "list", "--json"], deps); assert.equal(listed, 0); assert.equal(JSON.parse(output.at(-1)).items.length, 1);
  assert.equal(await runCli(["api-doc", "show", saved.previewId, "--format", "markdown", "--json"], deps), 0); assert.match(output.at(-1), /API Documentation/);
  assert.deepEqual(errors, []);
});

test("stale preview warns on Markdown XML and export, and bind/sync require explicit override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-api-stale-cli-"));
  const previewRoot = join(dir, "previews");
  const ir = {
    documentKey: "doc:stale", title: "Stale API", revisions: [{ revisionId: "old-revision", repoId: "repo", repo: "repo", commitSha: "old", trust: "exact_commit", resolutionSource: "commit" }],
    enums: [], endpoints: [], websocketEvents: [], commonResponses: [], frontendChecklist: [], evidence: [], gaps: [],
    coverage: { level: "partial", analyzedRequestPartitions: 0, unresolvedRequestConstraints: 0, discoveredStaticExits: 0, resolvedStaticExits: 0, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "unavailable", blockers: [] },
  };
  const saved = new ApiDocPreviewStore(previewRoot).save({ ir, rendered: renderApiDocumentation(ir), mode: "preview" });
  const manifestPath = join(previewRoot, saved.previewId.replaceAll(":", "_"), "manifest.json");
  const persistedBefore = readFileSync(manifestPath, "utf8");
  const output = []; const errors = [];
  let revision = 1;
  const larkClient = {
    async fetchFull() { return { nodeToken: "node", documentId: "doc", revisionId: revision, blocks: [] }; },
    async replaceSection() { revision += 1; return { revisionId: revision }; },
    async deleteSection() { revision += 1; return { revisionId: revision }; },
    async createDraft() { return { nodeToken: "draft", revisionId: 1 }; },
  };
  const deps = { cwd: dir, previewRoot, bindingPath: join(dir, "bindings.json"), larkClient, currentRevisionIds: () => ["current-revision"], out: (line) => output.push(line), err: (line) => errors.push(line), json: true };

  for (const [sub, format] of [["show", "markdown"], ["show", "xml"], ["export", "markdown"]]) {
    output.length = 0;
    assert.equal(await runApiDocCommand([sub, saved.previewId, "--format", format], deps), 0);
    assert.match(output.at(-1), /API_DOC_PREVIEW_STALE/);
    assert.match(output.at(-1), /preview_revision_stale/);
    assert.match(output.at(-1), /current-revision/);
  }

  errors.length = 0;
  assert.equal(await runApiDocCommand(["bind", "doc:stale", "--node-token", "node", "--preview", saved.previewId], deps), 1);
  assert.equal(JSON.parse(errors.at(-1)).error.code, "API_DOC_PREVIEW_STALE");
  assert.equal(await runApiDocCommand(["bind", "doc:stale", "--node-token", "node", "--preview", saved.previewId, "--allow-stale"], deps), 0);

  errors.length = 0;
  assert.equal(await runApiDocCommand(["sync", saved.previewId], deps), 1);
  assert.equal(JSON.parse(errors.at(-1)).error.code, "API_DOC_PREVIEW_STALE");
  errors.length = 0;
  const outputBeforeOverride = output.length;
  assert.ok([0, 1].includes(await runApiDocCommand(["sync", saved.previewId, "--allow-stale"], deps)));
  assert.equal(errors.length, 0, "override proceeds to the sync engine instead of the stale guard");
  assert.ok(output.length > outputBeforeOverride);
  assert.equal(readFileSync(manifestPath, "utf8"), persistedBefore, "stale overlays must not mutate historical manifests");
});
