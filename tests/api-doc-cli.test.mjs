import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

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
  const listed = await runCli(["api-doc", "list", "--json"], deps); assert.equal(listed, 0); assert.equal(JSON.parse(output.at(-1)).length, 1);
  assert.equal(await runCli(["api-doc", "show", saved.previewId, "--format", "markdown", "--json"], deps), 0); assert.match(output.at(-1), /API Documentation/);
  assert.deepEqual(errors, []);
});
