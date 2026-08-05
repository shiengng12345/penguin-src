import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runQueryServer } from "../packages/knowledge-cli/dist/query-server.js";

// Fixture: one repo, two branches. `main` is live and indexes symbol Alpha;
// `feature` is a snapshot-status branch (checked out and indexed once, then
// superseded) that indexes a distinct symbol Beta. Mirrors the branch/store
// shape used by tests/knowledge-revision-isolation.test.mjs.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-query-server-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "demo", rootPath: join(dir, "repo") });
  const mainId = store.registerBranch({ repoId, name: "main", headCommit: "main-sha", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature", headCommit: "feature-sha", status: "snapshot" });
  const alpha = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Alpha`, repoId, title: "Alpha" });
  const beta = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Beta`, repoId, title: "Beta" });
  store.upsertSymbolVersion({ nodeId: alpha, branchId: mainId, commitSha: "main-sha", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "Alpha()", contentHash: "h-alpha" });
  store.indexSymbolText({ nodeId: alpha, name: "Alpha", signature: "Alpha()" });
  store.upsertSymbolVersion({ nodeId: beta, branchId: featureId, commitSha: "feature-sha", filePath: "src/b.ts", lang: "typescript", kind: "function", signature: "Beta()", contentHash: "h-beta" });
  store.indexSymbolText({ nodeId: beta, name: "Beta", signature: "Beta()" });
  return { store, dir, repoId, mainId, featureId };
}

function deps(store) {
  return { openStore: () => store, storeExists: () => true, out: () => {}, err: () => {} };
}

async function sendSearchRequest(store, requestInput) {
  const input = new Readable({ read() {} });
  const frames = [];
  let resolveResponse;
  const responseArrived = new Promise((resolve) => { resolveResponse = resolve; });
  const output = {
    write: (chunk) => {
      const frame = JSON.parse(chunk);
      frames.push(frame);
      if (frame.type === "response" && frame.id === "req-1") resolveResponse(frame);
      return true;
    },
  };
  const serverExit = runQueryServer(deps(store), input, output);
  input.push(`${JSON.stringify({ type: "request", id: "req-1", capabilityId: "knowledge.search", input: requestInput })}\n`);
  const response = await responseArrived;
  input.push(null);
  await serverExit;
  return response;
}

test("knowledge.search resolves a repoName+branch scope entry to the branch's snapshot instead of dropping it", async () => {
  const { store } = fixture();
  const response = await sendSearchRequest(store, {
    query: "Beta",
    mode: "lexical",
    scope: { revisions: [{ repoName: "demo", branch: "feature" }] },
    page: { limit: 20 },
  });
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  const titles = response.result.hits.map((hit) => hit.title);
  assert.ok(titles.includes("Beta"), `expected Beta among hits, got ${JSON.stringify(titles)}`);
  assert.ok(!titles.includes("Alpha"), `expected Alpha to be excluded from the feature-scoped search, got ${JSON.stringify(titles)}`);
  store.close();
});

test("knowledge.search with an unresolvable repoName scope entry answers ok with a SCOPE_UNRESOLVED warning instead of dropping the request", async () => {
  const { store } = fixture();
  const response = await sendSearchRequest(store, {
    query: "Alpha",
    mode: "lexical",
    scope: { revisions: [{ repoName: "does-not-exist", branch: "main" }] },
    page: { limit: 20 },
  });
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  assert.ok(
    response.result.diagnostics.warnings.some((w) => w.code === "SCOPE_UNRESOLVED"),
    `expected a SCOPE_UNRESOLVED warning, got ${JSON.stringify(response.result.diagnostics.warnings)}`,
  );
  // The unresolvable scope entry must degrade to the default (live) scope
  // rather than erroring the whole request or silently returning nothing.
  const titles = response.result.hits.map((hit) => hit.title);
  assert.ok(titles.includes("Alpha"), `expected results from the default scope, got ${JSON.stringify(titles)}`);
  store.close();
});
