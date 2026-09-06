import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, FileFactStore, ResolutionStore, affectedByFiles, affectedByNode } from "../packages/knowledge-core/dist/index.js";

test("snapshot graph queries use bounded bulk readers instead of full-graph N+1 scans", () => {
  const source = readFileSync(new URL("../packages/knowledge-core/src/query.ts", import.meta.url), "utf8");
  const affectedBlock = source.slice(source.indexOf("export function affectedByFiles"), source.indexOf("export namespace affectedByFiles"));
  const affectedNodeBlock = source.slice(source.indexOf("export function affectedByNode"), source.indexOf("export function affectedByFiles"));
  const serviceBlock = source.slice(source.indexOf("export function serviceGraph"), source.indexOf("export interface ServiceContextResult"));
  const edgeReaderBlock = source.slice(source.indexOf("function snapshotEdgePairs("), source.indexOf("function revisionBranchId"));

  assert.match(affectedBlock, /snapshotEdgePairsForNodes\(/, "snapshot affected must traverse only the current frontier");
  assert.doesNotMatch(affectedBlock, /const pairs = snapshotEdgePairs\(/, "snapshot affected must not materialize the whole graph");
  assert.match(edgeReaderBlock, /resolveIdentityNodeIds\(/, "snapshot edge reads must bulk-resolve identities");
  const exploreBlock = source.slice(source.indexOf("export function exploreGraph"), source.indexOf("// —— Explore v2"));
  assert.match(exploreBlock, /view\.edges\(\{[\s\S]*nodeIds: nodeKeys/, "snapshot node traversal must push the frontier into the revision reader");
  assert.doesNotMatch(exploreBlock, /const all = view\.edges\(\{ limit: 10000 \}\)/, "snapshot node traversal must not materialize the whole graph");
  assert.match(affectedNodeBlock, /includeDiagnostics: false/, "node affected must not rebuild public diagnostics inside its internal graph traversal");
  assert.match(affectedNodeBlock, /includeEvidence: false/, "node affected must not rebuild public evidence inside its internal graph traversal");
  assert.match(serviceBlock, /!isCurrentRevisionSnapshot\(store, options\.revision\)/, "the published head must use its complete branch projection");
  assert.doesNotMatch(serviceBlock, /store\.getNode\(edge\.(?:src|dst)/, "service graph must not perform one node lookup per edge");
});

test("snapshot affected traversal preserves transitive callers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-aff-snapshot-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "snapshot-r", rootPath: join(dir, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live", headCommit: "c1" });
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({ snapshotKey: "snapshot-aff", repoId, commitSha: "c1", parserVersion: "p", resolverVersion: "r", schemaVersion: 18 });
  const facts = new FileFactStore(store);
  const resolutions = new ResolutionStore(store);
  const targetKey = `${repoId}::src/target.ts::target`;
  const callerKey = `${repoId}::src/caller.ts::caller`;
  const targetId = store.upsertNode({ nodeType: "symbol", identityKey: targetKey, title: "target", repoId });
  const callerId = store.upsertNode({ nodeType: "symbol", identityKey: callerKey, title: "caller", repoId });
  // Keep a current live symbol projection but deliberately omit its live edge.
  // Snapshot-resolved edges remain authoritative for revision-scoped affected.
  store.upsertSymbolVersion({ nodeId: targetId, branchId, commitSha: "c1", filePath: "src/target.ts", lang: "ts", kind: "function", contentHash: "target", status: "fresh" });
  store.upsertSymbolVersion({ nodeId: callerId, branchId, commitSha: "c1", filePath: "src/caller.ts", lang: "ts", kind: "function", contentHash: "caller", status: "fresh" });
  const targetFact = facts.upsertFileFact({ repoId, filePath: "src/target.ts", contentHash: "target", language: "typescript", parserVersion: "p", exportsHash: "target", symbols: [{ identityKey: targetKey, title: "target", kind: "function", contentHash: "target" }], imports: [], unresolvedReferences: [], endpoints: [], logSites: [] });
  const callerFact = facts.upsertFileFact({ repoId, filePath: "src/caller.ts", contentHash: "caller", language: "typescript", parserVersion: "p", exportsHash: "caller", symbols: [{ identityKey: callerKey, title: "caller", kind: "function", contentHash: "caller" }], imports: [], unresolvedReferences: [], endpoints: [], logSites: [] });
  facts.replaceOverlay(snapshot.id, [
    { op: "add", path: "src/target.ts", fileFactId: targetFact },
    { op: "add", path: "src/caller.ts", fileFactId: callerFact },
  ]);
  const resolution = resolutions.replaceResolutionSet({ fileFactId: callerFact, contextFingerprint: "ctx", resolverVersion: "r", edges: [{ srcIdentityKey: callerKey, dstIdentityKey: targetKey, edgeType: "calls", method: "resolved", confidence: 1, provenance: {} }] });
  resolutions.attachSnapshotResolution({ snapshotId: snapshot.id, filePath: "src/caller.ts", resolutionSetId: resolution.id });
  topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: "c1" });

  const revision = { repoId, branch: "main", branchId, commitSha: "c1", snapshotId: snapshot.id, trust: "exact_commit" };
  const result = affectedByFiles(store, ["src/target.ts"], { revision });
  assert.deepEqual(result.changed.map((item) => item.nodeId), [targetId]);
  assert.ok(result.impacted.some((item) => item.nodeId === callerId));
  store.close();
});

test("affectedByFiles: changed file → its symbols + transitive callers + tests + routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-aff-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const mk = (n, file) => { const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${n}`, title: n, repoId }); store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: file, lang: "ts", kind: "function", contentHash: `h_${n}`, status: "fresh" }); return id; };
  const helper = mk("helper", "svc/util.ts");
  const svc = mk("svc", "svc/svc.ts");
  const ctrl = mk("ctrl", "svc/ctrl.ts");
  const specFile = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::svc/util.spec.ts`, title: "svc/util.spec.ts", repoId });
  const route = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::S.m", title: "gRPC S.m", repoId: null });
  store.replaceFileEdges({ branchId, filePath: "svc/svc.ts", edges: [{ src: svc, dst: helper, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "svc/ctrl.ts", edges: [{ src: ctrl, dst: svc, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "svc/util.spec.ts", edges: [{ src: specFile, dst: helper, edgeType: "tests", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "svc/ctrl.ts.route", edges: [{ src: route, dst: ctrl, edgeType: "handles", origin: "parser", method: "EXTRACTED" }] });

  const a = affectedByFiles(store, ["svc/util.ts"]);
  assert.ok(a.changed.some((x) => x.title === "helper"), "helper is changed");
  assert.ok(a.impacted.some((x) => x.title === "svc"), "svc impacted (calls helper)");
  assert.ok(a.impacted.some((x) => x.title === "ctrl"), "ctrl impacted (transitive)");
  assert.ok(a.tests.some((x) => x.title.includes("util.spec")), "covering test found");
  assert.ok(a.routes.some((r) => r.includes("S.m")), "reaching route found");
  store.close();
});

test("architecture + deadCode overviews (§ parity)", async () => {
  const { KnowledgeStore, architecture, deadCode } = await import("../packages/knowledge-core/dist/index.js");
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pk-arch-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const mk = (n) => { const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${n}`, title: n, repoId }); store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: "a.ts", lang: "ts", kind: "function", contentHash: `h_${n}`, status: "fresh" }); return id; };
  const used = mk("used"); const caller = mk("caller"); const orphan = mk("orphan");
  store.replaceFileEdges({ branchId, filePath: "a.ts", edges: [{ src: caller, dst: used, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });

  const o = architecture(store);
  assert.ok(o.repos.some((r) => r.name === "r"));
  assert.equal(o.nodeCounts.symbol, 3);
  assert.ok(o.edgeCounts.calls >= 1);
  assert.ok(o.languages.some((l) => l.lang === "ts"));

  const d = deadCode(store, { limit: 50 });
  assert.ok(d.candidates.some((c) => c.title === "orphan"), "orphan flagged");
  assert.ok(!d.candidates.some((c) => c.title === "used"), "used symbol not flagged");
  store.close();
});

test("node-targeted affected never treats node:<id> as a filename", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-aff-node-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const target = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::target`, title: "target", repoId });
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::caller`, title: "caller", repoId });
  store.upsertSymbolVersion({ nodeId: target, branchId, commitSha: "c0", filePath: "src/target.ts", lang: "ts", kind: "function", contentHash: "ht", status: "fresh" });
  store.upsertSymbolVersion({ nodeId: caller, branchId, commitSha: "c0", filePath: "src/caller.ts", lang: "ts", kind: "function", contentHash: "hc", status: "fresh" });
  store.replaceFileEdges({ branchId, filePath: "src/caller.ts", edges: [{ src: caller, dst: target, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  const result = affectedByNode(store, `node:${target}`);
  assert.equal(result.target.nodeId, target);
  assert.deepEqual(result.files, ["src/target.ts"]);
  assert.ok(result.impacted.some((item) => item.nodeId === caller));
  store.close();
});

test("affectedByFiles marks an unresolved file as non-exact, not-proven evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-aff-unresolved-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  store.registerBranch({ repoId, name: "main", status: "live" });

  const result = affectedByFiles(store, ["src/not-indexed.ts"]);

  assert.equal(result.changed.length, 0);
  assert.equal(result.proofStatus, "not_proven");
  assert.equal(result.totalIsExact, false);
  store.close();
});

test("deadCode cursor pages the full candidate set", async () => {
  const { KnowledgeStore, deadCode } = await import("../packages/knowledge-core/dist/index.js");
  const dir = mkdtempSync(join(tmpdir(), "pk-dead-cursor-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  for (const name of ["a", "b", "c"]) {
    const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${name}`, title: name, repoId });
    store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: `${name}.ts`, lang: "ts", kind: "function", contentHash: name, status: "fresh" });
  }
  const first = deadCode(store, { repo: "r", limit: 1 });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidateCount, 3);
  assert.equal(first.truncated, true);
  const last = first.candidates[0];
  const second = deadCode(store, { repo: "r", limit: 1, after: { filePath: last.filePath, startLine: last.startLine ?? -1, nodeId: last.nodeId } });
  assert.equal(second.candidates.length, 1);
  assert.notEqual(second.candidates[0].nodeId, last.nodeId);
  store.close();
});
