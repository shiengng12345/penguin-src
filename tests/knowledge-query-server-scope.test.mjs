import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore } from "../packages/knowledge-core/dist/index.js";
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

// Fixture: `feature` is a snapshot-status branch that was indexed for real at
// some point -- it has a genuine, ready revision_snapshots row wired up via
// current_snapshot_id, unlike `fixture()` above where every branch is purely
// legacy (current_snapshot_id stays NULL). This exercises the "prefer the
// branch's real current_snapshot_id over the legacy:<branchId> synthetic
// form" half of the resolver, via the source lane (which -- unlike the
// symbol lane -- can only find a hit when handed the exact real snapshot id,
// since effective_snapshot_sources is keyed by revision_snapshots.id).
function fixtureWithRealSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-query-server-scope-real-snap-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "demo", rootPath: join(dir, "repo") });
  store.registerBranch({ repoId, name: "main", headCommit: "main-sha", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature", headCommit: "feature-sha", status: "snapshot" });

  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({ snapshotKey: "feature-snap", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 11 });

  const raw = Buffer.from("export const BetaSource = true;\n", "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store);
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString("utf8"), encoding: "utf8" });
  const fact = source.putSourceFact({ repoId, filePath: "src/beta.ts", factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
  store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(repoId, "src/beta.ts", "tracked", "admitted", "text_searchable", "source", raw.length, "ok", new Date().toISOString());
  // Overlay/manifest must be written while the snapshot is still "building".
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/beta.ts", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);

  topology.markSnapshotReady(snapshot.id);
  // Point the (still snapshot-status, not live) feature branch at the real,
  // ready snapshot -- a branch that was indexed for real once and later
  // superseded, as opposed to a purely legacy never-snapshotted branch.
  topology.pointBranchAtSnapshot(featureId, snapshot.id);

  return { store, repoId, featureId, snapshotId: snapshot.id };
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

test("knowledge.search prefers a branch's real current_snapshot_id over the legacy:<branchId> placeholder when resolving repoName+branch", async () => {
  const { store, snapshotId } = fixtureWithRealSnapshot();
  const response = await sendSearchRequest(store, {
    query: "BetaSource",
    mode: "exact",
    scope: { revisions: [{ repoName: "demo", branch: "feature" }] },
    page: { limit: 20 },
  });
  assert.equal(response.ok, true, `expected ok response: ${JSON.stringify(response)}`);
  const hitFiles = response.result.hits.map((hit) => hit.locator.filePath);
  // Only reachable if the resolved scope's snapshotId is the real
  // revision_snapshots id -- effective_snapshot_sources is keyed by that
  // real id, never by the legacy:<branchId> placeholder, so a regression
  // back to always using resolution.context.snapshotId would find nothing.
  assert.ok(hitFiles.includes("src/beta.ts"), `expected src/beta.ts among hits, got ${JSON.stringify(hitFiles)}`);
  const resolved = response.result.diagnostics.resolvedScopes;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].snapshotId, snapshotId, "expected the resolved scope to use the branch's real snapshot id, not a legacy:<branchId> placeholder");
  assert.equal(resolved[0].branch, "feature");
  store.close();
});
