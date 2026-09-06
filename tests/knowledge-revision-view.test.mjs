import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, GitTopologyStore, FileFactStore, ResolutionStore, openRevisionView, searchLegacyRows, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

test("revision view reads COW facts and resolution edges after legacy rows are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-revision-view-")); const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }); const repoId = store.registerRepo({ name: "view", rootPath: join(dir, "repo") }); const topology = new GitTopologyStore(store); const snapshot = topology.createBuildingSnapshot({ snapshotKey: "view-snapshot", repoId, commitSha: "abc", parserVersion: "p1", resolverVersion: "r1", schemaVersion: SCHEMA_VERSION });
  const facts = new FileFactStore(store); const callerKey = `${repoId}::src/caller.ts::caller`; const targetKey = `${repoId}::src/target.ts::target`; const caller = store.upsertNode({ nodeType: "symbol", identityKey: callerKey, repoId, title: "caller" }); const target = store.upsertNode({ nodeType: "symbol", identityKey: targetKey, repoId, title: "target" }); const factId = facts.upsertFileFact({ repoId, filePath: "src/caller.ts", contentHash: "h1", language: "typescript", parserVersion: "p1", exportsHash: "e1", symbols: [{ identityKey: callerKey, title: "caller", kind: "function", contentHash: "h1" }], imports: [], unresolvedReferences: [], endpoints: [], logSites: [] }); facts.replaceOverlay(snapshot.id, [{ op: "add", path: "src/caller.ts", fileFactId: factId }]); facts.materializeManifest(snapshot.id); const resolutions = new ResolutionStore(store); const set = resolutions.replaceResolutionSet({ fileFactId: factId, contextFingerprint: "ctx", resolverVersion: "r1", edges: [{ srcIdentityKey: callerKey, dstIdentityKey: targetKey, edgeType: "calls", method: "resolved", confidence: 1, provenance: {} }] }); resolutions.attachSnapshotResolution({ snapshotId: snapshot.id, filePath: "src/caller.ts", resolutionSetId: set.id }); topology.markSnapshotReady(snapshot.id);
  const context = { repoId, commitSha: "abc", snapshotId: snapshot.id, trust: "exact_commit" }; const view = openRevisionView(store, context); assert.equal(view.listFiles().length, 1); assert.equal(view.symbolVersions([caller]).length, 1); assert.equal(view.edges({ nodeIds: [callerKey], direction: "out" })[0].dstIdentityKey, targetKey); store.db.prepare("DELETE FROM symbol_versions WHERE branch_id IN (SELECT id FROM branches WHERE repo_id=?)").run(repoId); store.db.prepare("DELETE FROM files_index WHERE repo_id=?").run(repoId); store.db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(caller, target); assert.equal(view.symbolVersions([caller]).length, 1); assert.equal(view.edges({ nodeIds: [callerKey], direction: "out" }).length, 1); store.close();
});

test("published revision views read the materialized manifest after overlays are retired", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-materialized-view-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "materialized", rootPath: join(dir, "repo") });
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({ snapshotKey: "materialized-snapshot", repoId, commitSha: "abc", parserVersion: "p1", resolverVersion: "r1", schemaVersion: SCHEMA_VERSION });
  const facts = new FileFactStore(store);
  const identityKey = `${repoId}::src/kept.ts::kept`;
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey, repoId, title: "kept" });
  store.indexSymbolText({ nodeId, name: "kept", signature: "kept()" });
  const factId = facts.upsertFileFact({ repoId, filePath: "src/kept.ts", contentHash: "kept", language: "typescript", parserVersion: "p1", exportsHash: "kept", symbols: [{ identityKey, title: "kept", kind: "function", contentHash: "kept" }], imports: [], unresolvedReferences: [], endpoints: [], logSites: [] });
  facts.replaceOverlay(snapshot.id, [{ op: "add", path: "src/kept.ts", fileFactId: factId }]);
  facts.materializeManifest(snapshot.id);
  topology.markSnapshotReady(snapshot.id);
  store.db.prepare("DELETE FROM snapshot_overlays WHERE snapshot_id=?").run(snapshot.id);

  const view = openRevisionView(store, { repoId, commitSha: "abc", snapshotId: snapshot.id, trust: "exact_commit" });
  assert.deepEqual(view.listFiles().map((file) => file.filePath), ["src/kept.ts"]);
  assert.equal(view.symbolVersionsForFiles(["src/kept.ts"])[0]?.identityKey, identityKey);
  assert.equal(searchLegacyRows(store, "kept", { revision: view.context })[0]?.nodeId, nodeId);
  store.close();
});
