import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, TargetResolutionError, resolveRevisionContext, resolveTarget } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-target-resolution-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoA = store.registerRepo({ name: "target-a", rootPath: join(dir, "a") });
  const repoB = store.registerRepo({ name: "target-b", rootPath: join(dir, "b") });
  const branchA = store.registerBranch({ repoId: repoA, name: "main", headCommit: "commit-a", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("commit-a", branchA);
  const symbol = store.upsertNode({ nodeType: "symbol", identityKey: `${repoA}::Thing.run`, title: "run", repoId: repoA });
  store.upsertSymbolVersion({ nodeId: symbol, branchId: branchA, commitSha: "commit-a", filePath: "src/thing.ts", lang: "typescript", kind: "method", signature: "run()", contentHash: "thing-run", status: "fresh", startLine: 3, endLine: 5 });
  const endpoint = store.upsertGrpcEndpoint({ service: "TargetService", method: "getThing" });
  store.replaceEndpointMembershipsForFile({
    repoId: repoA,
    filePath: "src/target.grpc.ts",
    memberships: [{ endpointId: endpoint, role: "provider", locatorNodeId: symbol }],
  });
  const duplicate = store.upsertNode({ nodeType: "symbol", identityKey: `${repoB}::Thing.run`, title: "run", repoId: repoB });
  return { store, repoA, repoB, branchA, symbol, endpoint, duplicate };
}

test("resolveTarget accepts public ID, path, repo/path, and gRPC spellings", () => {
  const { store, repoA, symbol, endpoint } = fixture();
  const revision = resolveRevisionContext(store, { repoId: repoA, commitSha: "commit-a" });
  assert.equal(revision.status, "resolved");
  for (const spelling of [`node:${symbol}`, `symbol:${symbol}`, symbol, "src/thing.ts#run", "target-a:src/thing.ts#run", "run"]) {
    const result = resolveTarget(store, spelling, { repoId: repoA, revision: revision.context });
    assert.equal(result.nodeId, symbol, spelling);
    assert.equal(result.repoId, repoA);
    assert.equal(result.locator.filePath, "src/thing.ts");
  }
  for (const spelling of ["gRPC TargetService.getThing", "TargetService.getThing", "grpc::TargetService.getThing", "/TargetService/getThing"]) {
    const result = resolveTarget(store, spelling, { repoId: repoA });
    assert.equal(result.nodeId, endpoint, spelling);
    assert.equal(result.nodeType, "endpoint");
  }
  store.close();
});

test("Service.Method ambiguity is narrowed inside the requested repository before resolution", () => {
  const { store, repoA, repoB } = fixture();
  const endpointA = store.upsertGrpcEndpoint({ packageName: "alpha.v1", service: "VersionService", method: "Version" });
  const endpointB = store.upsertGrpcEndpoint({ packageName: "beta.v1", service: "VersionService", method: "Version" });
  store.replaceEndpointMembershipsForFile({
    repoId: repoA,
    filePath: "src/alpha-version.ts",
    memberships: [{ endpointId: endpointA, role: "declaration" }],
  });
  store.replaceEndpointMembershipsForFile({
    repoId: repoB,
    filePath: "src/beta-version.ts",
    memberships: [{ endpointId: endpointB, role: "declaration" }],
  });

  assert.equal(resolveTarget(store, "VersionService.Version", { repoId: repoA }).nodeId, endpointA);
  assert.equal(resolveTarget(store, "VersionService.Version", { repoId: repoB }).nodeId, endpointB);
  assert.throws(() => resolveTarget(store, "VersionService.Version"), (error) => (
    error instanceof TargetResolutionError
    && error.code === "TARGET_AMBIGUOUS"
    && error.details.candidates.length === 2
  ));
  store.close();
});

test("resolveTarget returns canonical scope details for foreign nodes and global endpoints", () => {
  const { store, repoA, repoB, symbol, duplicate } = fixture();
  assert.throws(() => resolveTarget(store, `node:${symbol}`, { repoId: repoB }), (error) => (
    error instanceof TargetResolutionError
    && error.code === "SCOPE_MISMATCH"
    && error.details.requestedRepoId === repoB
    && error.details.actualRepoId === repoA
    && error.details.actualRevisionId === "commit-a"
  ));
  const endpoint = store.findNodeIdByIdentity("grpc::TargetService.getthing");
  assert.ok(endpoint);
  assert.throws(() => resolveTarget(store, `node:${endpoint}`, { repoId: repoB }), (error) => (
    error instanceof TargetResolutionError
    && error.code === "SCOPE_MISMATCH"
    && error.details.requestedRepoId === repoB
    && error.details.actualRepoId === repoA
    && error.details.actualRevisionId === "commit-a"
  ));

  const stale = store.upsertNode({ nodeType: "symbol", identityKey: `${repoA}::Stale.run`, title: "Stale", repoId: repoA });
  assert.throws(() => resolveTarget(store, `node:${stale}`, { repoId: repoA }), (error) => error instanceof TargetResolutionError && error.code === "TARGET_STALE");
  const revision = resolveRevisionContext(store, { repoId: repoA, commitSha: "not-indexed" });
  assert.equal(revision.status, "not_found");
  assert.throws(() => resolveTarget(store, `node:${duplicate}`, { repoId: repoA }), (error) => error instanceof TargetResolutionError && error.code === "SCOPE_MISMATCH");
  store.close();
});

test("resolveTarget reports a foreign target's own fresh branch and revision", () => {
  const { store, repoA, repoB } = fixture();
  const featureBranch = store.registerBranch({ repoId: repoA, name: "feature", headCommit: "commit-feature", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("commit-feature", featureBranch);
  const featureOnly = store.upsertNode({ nodeType: "symbol", identityKey: `${repoA}::Feature.only`, title: "Feature.only", repoId: repoA });
  store.upsertSymbolVersion({ nodeId: featureOnly, branchId: featureBranch, commitSha: "commit-feature", filePath: "src/feature.ts", lang: "typescript", kind: "function", contentHash: "feature-only", status: "fresh" });

  assert.throws(() => resolveTarget(store, `node:${featureOnly}`, { repoId: repoB }), (error) => (
    error instanceof TargetResolutionError
    && error.code === "SCOPE_MISMATCH"
    && error.details.actualRepoId === repoA
    && error.details.actual?.branchId === featureBranch
    && error.details.actualRevisionId === "commit-feature"
  ));
  store.close();
});

test("resolveTarget keeps valid same-repository public node resolution", () => {
  const { store, repoA, symbol } = fixture();
  const result = resolveTarget(store, `node:${symbol}`, { repoId: repoA });
  assert.equal(result.nodeId, symbol);
  store.close();
});

test("target remediation is MCP-native and ambiguous candidates carry source coordinates", () => {
  const { store, repoB, duplicate } = fixture();
  const branchB = store.registerBranch({ repoId: repoB, name: "main", headCommit: "commit-b", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("commit-b", branchB);
  store.upsertSymbolVersion({
    nodeId: duplicate,
    branchId: branchB,
    commitSha: "commit-b",
    filePath: "src/other-thing.ts",
    lang: "typescript",
    kind: "method",
    signature: "run()",
    contentHash: "other-thing-run",
    status: "fresh",
    startLine: 7,
    endLine: 9,
  });

  assert.throws(() => resolveTarget(store, "run"), (error) => {
    assert.ok(error instanceof TargetResolutionError);
    assert.equal(error.code, "TARGET_AMBIGUOUS");
    assert.match(error.details.remediation, /knowledge_search/);
    assert.doesNotMatch(error.details.remediation, /--repo|--branch|penguin\s/);
    assert.ok(error.details.candidates.every((candidate) => candidate.filePath && Number.isInteger(candidate.startLine)));
    return true;
  });
  store.close();
});
