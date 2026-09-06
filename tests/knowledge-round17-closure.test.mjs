import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { ApiDocPreviewStore, renderApiDocumentation } from "../packages/api-doc-generator/dist/index.js";
import { KnowledgeStore, buildContextPack, buildFlow, resolveGrpcEndpoint, resolveRevisionContext, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

async function loadMcpTools() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-round17-mcp-"));
  try { symlinkSync(new URL("../packages/mcp/node_modules", import.meta.url).pathname, join(dir, "node_modules")); } catch { /* workspace dependency remains optional */ }
  const handler = join(dir, "knowledge-tools.mjs");
  await build({
    entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: handler,
    alias: { "@penguin/knowledge-core": new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname },
  });
  return import(`file://${handler}`);
}

const { runKnowledgeTool } = await loadMcpTools();

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
  }).trim();
}

function createRepo(dir, name) {
  const rootPath = join(dir, name);
  mkdirSync(rootPath);
  git(["init", "-b", "main"], rootPath);
  git(["commit", "--allow-empty", "-m", "fixture"], rootPath);
  return { rootPath, commitSha: git(["rev-parse", "HEAD"], rootPath) };
}

function seedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-round17-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repo = createRepo(dir, "repo-a");
  const repoId = store.registerRepo({ name: "repo-a", rootPath: repo.rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: repo.commitSha, status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run(repo.commitSha, branchId);
  const symbol = (title, filePath) => {
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${title}`, repoId, title });
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: repo.commitSha, filePath, lang: "typescript", kind: "function", contentHash: `${title}-hash`, status: "fresh" });
    store.indexSymbolText({ nodeId, name: title, signature: `${title}()` });
    return nodeId;
  };
  const changed = symbol("changed", "src/changed.ts");
  const caller = symbol("caller", "src/caller.ts");
  const testFile = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::src/changed.test.ts`, repoId, title: "src/changed.test.ts" });
  const endpoint = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::fixture.v1.ChangeService.Change", repoId, title: "gRPC fixture.v1.ChangeService.Change", meta: { protocol: "grpc" } });
  store.replaceFileEdges({ branchId, filePath: "src/caller.ts", edges: [{ src: caller, dst: changed, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "src/changed.test.ts", edges: [{ src: testFile, dst: changed, edgeType: "tests", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "src/change.route.ts", edges: [{ src: endpoint, dst: caller, edgeType: "handles", origin: "parser", method: "EXTRACTED" }] });
  return { dir, store, repo, repoId, branchId, changed, caller, endpoint };
}

function publishDeterministicReadySnapshot(fixture) {
  const snapshotId = "snapshot_round17_ready_fixture";
  const timestamp = "2026-08-30T00:00:00.000Z";
  fixture.store.db.prepare(`
    INSERT INTO revision_snapshots
      (id, snapshot_key, repo_id, commit_sha, worktree_fingerprint,
       parser_version, resolver_version, schema_version, state,
       created_at, published_at, last_accessed_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'ready', ?, ?, ?)
  `).run(
    snapshotId,
    "round17-ready-fixture",
    fixture.repoId,
    fixture.repo.commitSha,
    "round17-fixture-parser",
    "round17-fixture-resolver",
    SCHEMA_VERSION,
    timestamp,
    timestamp,
    timestamp,
  );
  fixture.store.db.prepare(
    "UPDATE branches SET current_snapshot_id=?, indexed_schema_version=? WHERE id=?",
  ).run(snapshotId, SCHEMA_VERSION, fixture.branchId);
  return snapshotId;
}

function assertEmbeddedRevisionParity(value, expectedSnapshotId) {
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (current.locator && typeof current.locator === "object") {
      const locatorRevision = current.locator.revisionId ?? current.locator.snapshotId;
      if (locatorRevision != null) assert.equal(locatorRevision, expectedSnapshotId, JSON.stringify(current.locator));
    }
    if (current.scope?.revision && typeof current.scope.revision === "object") {
      const scopeRevision = current.scope.revision.snapshotId ?? current.scope.revision.revisionId ?? current.scope.revision.id;
      assert.equal(scopeRevision, expectedSnapshotId, JSON.stringify(current.scope));
    }
    for (const nested of Array.isArray(current) ? current : Object.values(current)) visit(nested);
  };
  visit(value);
}

async function cliAffected(store, cwd, repo, filePath) {
  return cliJson(store, cwd, ["affected", filePath, "--repo", repo, "--json"]);
}

async function cliJson(store, cwd, argv, { keepStoreOpen = false } = {}) {
  const out = [];
  const err = [];
  const close = store.close;
  if (keepStoreOpen) store.close = () => {};
  let exitCode;
  try {
    exitCode = await runCli(argv, {
      cwd,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      storeExists: () => true,
      openStore: () => store,
      notesDir: join(cwd, "notes"),
    });
  } finally {
    if (keepStoreOpen) store.close = close;
  }
  const lines = [...out, ...err];
  const json = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean) ?? null;
  return { exitCode, json, out, err };
}

function affectedProjection(result) {
  const nodeIds = (items) => (items ?? []).map((item) => item.nodeId ?? item.id ?? item).sort();
  return {
    changed: nodeIds(result?.changed),
    impacted: nodeIds(result?.impacted),
    tests: nodeIds(result?.tests),
    routes: [...(result?.routes ?? [])].sort(),
    proofStatus: result?.proofStatus ?? null,
    scope: result?.scope ?? result?.locator?.repoId ?? null,
    revision: result?.revision?.id ?? result?.revision?.revisionId ?? result?.locator?.revisionId ?? null,
  };
}

function affectedExactEmptyProjection(result) {
  return {
    proofStatus: result?.proofStatus ?? null,
    totalIsExact: result?.totalIsExact ?? null,
    candidateCount: result?.candidateCount ?? null,
    returnedCount: result?.returnedCount ?? null,
    counts: {
      changed: result?.changed?.length ?? null,
      impacted: result?.impacted?.length ?? null,
      tests: result?.tests?.length ?? null,
      routes: result?.routes?.length ?? null,
    },
    scope: result?.scope ?? null,
    revision: result?.revision ?? null,
  };
}

function scopeErrorProjection(result) {
  const error = result?.error ?? result?.json?.error ?? {};
  return {
    code: error.code ?? null,
    details: {
      requestedRepoId: error.details?.requestedRepoId ?? null,
      requestedRevisionId: error.details?.requestedRevisionId ?? null,
      actualRepoId: error.details?.actualRepoId ?? null,
      actualRevisionId: error.details?.actualRevisionId ?? null,
    },
  };
}

test("Round17 G1: CLI and MCP expose one non-empty build and capability identity", async () => {
  const fixture = seedFixture();
  try {
    const cli = await cliJson(fixture.store, fixture.repo.rootPath, ["capabilities", "--json"], { keepStoreOpen: true });
    const mcp = await runKnowledgeTool("knowledge_capabilities", { compact: true }, { store: fixture.store });
    const projection = (value) => ({
      buildId: value?.buildId ?? null,
      capabilityHash: value?.capabilityHash ?? null,
      schemaVersion: value?.schemaVersion ?? null,
      contractVersion: value?.contractVersion ?? null,
    });
    assert.equal(cli.exitCode, 0, JSON.stringify(cli));
    assert.ok(Object.values(projection(cli.json)).every((value) => typeof value === "string" && value.length > 0), JSON.stringify(cli.json));
    assert.deepEqual(projection(cli.json), projection(mcp));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G1: CLI affected matches MCP affected for changed file", async () => {
  const fixture = seedFixture();
  try {
    const mcp = await runKnowledgeTool("knowledge_affected", { repo: "repo-a", files: ["src/changed.ts"] }, { store: fixture.store });
    const cli = await cliAffected(fixture.store, fixture.repo.rootPath, "repo-a", "src/changed.ts");
    assert.equal(cli.exitCode, 0, JSON.stringify(cli));
    assert.ok(!mcp?.error, JSON.stringify(mcp));
    assert.deepEqual(affectedProjection(cli.json), affectedProjection(mcp));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G1: affected rejects mixed file and node inputs", async () => {
  const fixture = seedFixture();
  try {
    const result = await runKnowledgeTool("knowledge_affected", {
      repo: "repo-a",
      files: ["src/changed.ts"],
      target: `node:${fixture.changed}`,
    }, { store: fixture.store });
    assert.equal(result?.error?.code, "INVALID_ARGUMENT");
  } finally {
    fixture.store.close();
  }
});

test("Round17 G1: indexed file with no symbols is an exact empty CLI/MCP result", async () => {
  const fixture = seedFixture();
  try {
    fixture.store.upsertFileCheckpoint({
      repoId: fixture.repoId,
      branchId: fixture.branchId,
      filePath: "src/empty.ts",
      status: "indexed",
    });

    const mcp = await runKnowledgeTool("knowledge_affected", {
      repo: "repo-a",
      files: ["src/empty.ts"],
    }, { store: fixture.store });
    const cli = await cliAffected(fixture.store, fixture.repo.rootPath, "repo-a", "src/empty.ts");

    assert.equal(cli.exitCode, 0, JSON.stringify(cli));
    assert.ok(!cli.err.some((line) => line.includes("no indexed file matches")), JSON.stringify(cli));
    assert.ok(!mcp?.error, JSON.stringify(mcp));
    assert.equal(cli.json?.proofStatus, "proven");
    assert.equal(cli.json?.totalIsExact, true);
    assert.deepEqual(affectedExactEmptyProjection(cli.json), affectedExactEmptyProjection(mcp));
  } finally {
    fixture.store.close();
  }
});

function addScopedRepo(fixture, name) {
  const repo = createRepo(fixture.dir, name);
  const repoId = fixture.store.registerRepo({ name, rootPath: repo.rootPath });
  const branchId = fixture.store.registerBranch({ repoId, name: "main", headCommit: repo.commitSha, status: "live" });
  fixture.store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run(repo.commitSha, branchId);
  return { ...repo, repoId, branchId };
}

function addSymbol(fixture, repo, title, filePath) {
  const nodeId = fixture.store.upsertNode({ nodeType: "symbol", identityKey: `${repo.repoId}::${title}`, repoId: repo.repoId, title });
  fixture.store.upsertSymbolVersion({ nodeId, branchId: repo.branchId, commitSha: repo.commitSha, filePath, lang: "typescript", kind: "function", contentHash: `${title}-hash`, status: "fresh" });
  fixture.store.indexSymbolText({ nodeId, name: title, signature: `${title}()` });
  return nodeId;
}

test("Round17 G2: CLI and MCP return one canonical ownership error and inventory excludes foreign endpoints", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const foreignEndpoint = fixture.store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::foreign.v1.ForeignService.Call", repoId: null, title: "gRPC foreign.v1.ForeignService.Call", meta: { protocol: "grpc" } });
    fixture.store.replaceFileEdges({ branchId: fixture.branchId, filePath: "src/foreign.route.ts", edges: [{ src: foreignEndpoint, dst: fixture.changed, edgeType: "handles", origin: "parser", method: "EXTRACTED" }] });

    const foreignTarget = `node:${fixture.changed}`;
    const [context, flow, inventory] = await Promise.all([
      runKnowledgeTool("knowledge_context", { target: foreignTarget, repo: "repo-b" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_flow", { target: foreignTarget, repo: "repo-b" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_endpoints", { repo: "repo-b", protocol: "grpc", page: { limit: 50 } }, { store: fixture.store }),
    ]);
    const cliContext = await cliJson(fixture.store, fixture.repo.rootPath, ["context", foreignTarget, "--repo", "repo-b", "--json"], { keepStoreOpen: true });
    const cliFlow = await cliJson(fixture.store, fixture.repo.rootPath, ["flow", foreignTarget, "--repo", "repo-b", "--json"], { keepStoreOpen: true });
    const expected = scopeErrorProjection(context);
    assert.equal(expected.code, "SCOPE_MISMATCH", JSON.stringify(context));
    assert.equal(expected.details.requestedRepoId, repoB.repoId, JSON.stringify(context));
    assert.equal(expected.details.actualRepoId, fixture.repoId, JSON.stringify(context));
    assert.ok(expected.details.actualRevisionId, JSON.stringify(context));
    assert.deepEqual(scopeErrorProjection(flow), expected, JSON.stringify(flow));
    assert.equal(cliContext.exitCode, 1, JSON.stringify(cliContext));
    assert.equal(cliFlow.exitCode, 1, JSON.stringify(cliFlow));
    assert.deepEqual(scopeErrorProjection(cliContext), expected, JSON.stringify(cliContext));
    assert.deepEqual(scopeErrorProjection(cliFlow), expected, JSON.stringify(cliFlow));
    assert.equal(inventory?.error, undefined, JSON.stringify(inventory));
    assert.equal((inventory?.items ?? []).some((item) => item.nodeId === foreignEndpoint), false, JSON.stringify(inventory));
    assert.ok(repoB.repoId);
  } finally {
    fixture.store.close();
  }
});

test("Round17 G2: valid non-handler cross-service flow preserves each source revision and marks the boundary", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const related = addSymbol(fixture, repoB, "foreignRelated", "src/foreign-related.ts");
    const endpoint = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "ChangeService", method: "CrossService" });
    fixture.store.replaceFileEdges({
      branchId: fixture.branchId,
      filePath: "src/cross-client.ts",
      edges: [{ src: fixture.caller, dst: endpoint, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true }],
    });
    fixture.store.replaceFileEdges({
      branchId: repoB.branchId,
      filePath: "src/foreign-related.ts",
      edges: [{ src: endpoint, dst: related, edgeType: "references", origin: "parser", method: "EXTRACTED", branchless: true }],
    });

    const flow = await runKnowledgeTool("knowledge_flow", { target: `node:${endpoint}`, repo: "repo-a" }, { store: fixture.store });
    assert.equal(flow?.error, undefined, JSON.stringify(flow));
    const root = flow?.steps?.find((step) => step.nodeId === endpoint);
    const foreignRelated = flow?.steps?.find((step) => step.nodeId === related);
    assert.deepEqual(root?.source?.repoId, fixture.repoId, JSON.stringify(flow));
    assert.equal(root?.source?.revisionId, fixture.repo.commitSha, JSON.stringify(flow));
    assert.equal(foreignRelated?.source?.repoId, repoB.repoId, JSON.stringify(flow));
    assert.equal(foreignRelated?.source?.revisionId, repoB.commitSha, JSON.stringify(flow));
    assert.equal(foreignRelated?.boundary, true, JSON.stringify(flow));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G2: path rejects an out-of-scope destination identically through CLI and MCP", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const foreignDestination = addSymbol(fixture, repoB, "foreignDestination", "src/foreign-destination.ts");
    const from = `node:${fixture.caller}`;
    const to = `node:${foreignDestination}`;
    const mcp = await runKnowledgeTool("knowledge_path", { from, to, repo: "repo-a" }, { store: fixture.store });
    const cli = await cliJson(fixture.store, fixture.repo.rootPath, ["path", from, to, "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    const expected = scopeErrorProjection(mcp);
    assert.equal(expected.code, "SCOPE_MISMATCH", JSON.stringify(mcp));
    assert.equal(expected.details.requestedRepoId, fixture.repoId, JSON.stringify(mcp));
    assert.equal(expected.details.actualRepoId, repoB.repoId, JSON.stringify(mcp));
    assert.equal(cli.exitCode, 1, JSON.stringify(cli));
    assert.deepEqual(scopeErrorProjection(cli), expected, JSON.stringify(cli));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G2: repo-scoped endpoint inventory does not leak a foreign provider handler", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const endpoint = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "ScopedService", method: "ScopedHandler" });
    fixture.store.replaceFileEdges({
      branchId: fixture.branchId,
      filePath: "src/scoped-provider.ts",
      edges: [{ src: endpoint, dst: fixture.caller, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }],
    });
    fixture.store.replaceEndpointMembershipsForFile({
      repoId: repoB.repoId,
      filePath: "proto/scoped.proto",
      memberships: [{ endpointId: endpoint, role: "declaration" }],
    });

    const inventory = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-b", protocol: "grpc", page: { limit: 50 } }, { store: fixture.store });
    const item = inventory?.items?.find((candidate) => candidate.nodeId === endpoint);
    assert.equal(inventory?.error, undefined, JSON.stringify(inventory));
    assert.ok(item, JSON.stringify(inventory));
    assert.deepEqual(item.handlers, [], JSON.stringify(item));
    assert.equal(item.handlerStatus, "proto_only", JSON.stringify(item));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G2: endpoint provenance retains the requested feature branch through its locator", () => {
  const fixture = seedFixture();
  try {
    const featureBranchId = fixture.store.registerBranch({ repoId: fixture.repoId, name: "feature", headCommit: "commit-feature", status: "live" });
    fixture.store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("commit-feature", featureBranchId);
    fixture.store.db.prepare("UPDATE branches SET default_branch=CASE WHEN id=? THEN 1 ELSE 0 END WHERE repo_id=?").run(fixture.branchId, fixture.repoId);
    fixture.store.upsertSymbolVersion({
      nodeId: fixture.caller,
      branchId: featureBranchId,
      commitSha: "commit-feature",
      filePath: "src/caller.ts",
      lang: "typescript",
      kind: "function",
      contentHash: "caller-feature-hash",
      status: "fresh",
    });
    const endpoint = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "FeatureService", method: "FeatureHandler" });
    fixture.store.replaceFileEdges({
      branchId: featureBranchId,
      filePath: "src/feature.route.ts",
      edges: [{ src: endpoint, dst: fixture.caller, edgeType: "handles", origin: "parser", method: "EXTRACTED" }],
    });
    const revision = resolveRevisionContext(fixture.store, { repoId: fixture.repoId, branch: "feature" });
    assert.equal(revision.status, "resolved");
    const flow = buildFlow(fixture.store, `node:${endpoint}`, { repoId: fixture.repoId, revision: revision.context });
    const root = flow.steps.find((step) => step.nodeId === endpoint);
    assert.equal(root?.source?.branchId, featureBranchId, JSON.stringify(flow));
    assert.equal(root?.source?.revisionId, "commit-feature", JSON.stringify(flow));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G3: endpoint aliases collapse to one canonical endpoint and proto-only linkage stays incomplete", async () => {
  const fixture = seedFixture();
  try {
    const bare = fixture.store.upsertGrpcEndpoint({ service: "Inventory", method: "GetThing" });
    const qualified = fixture.store.upsertGrpcEndpoint({ packageName: "acme.inventory.v1", service: "Inventory", method: "GetThing" });
    const client = addSymbol(fixture, { ...fixture.repo, repoId: fixture.repoId, branchId: fixture.branchId }, "clientCall", "src/client.ts");
    const provider = addSymbol(fixture, { ...fixture.repo, repoId: fixture.repoId, branchId: fixture.branchId }, "providerCall", "src/provider.ts");
    const proto = fixture.store.upsertNode({ nodeType: "file", identityKey: `${fixture.repoId}::proto::inventory.proto`, repoId: fixture.repoId, title: "proto/inventory.proto" });
    fixture.store.replaceFileEdges({ branchId: fixture.branchId, filePath: "src/client.ts", edges: [{ src: client, dst: qualified, edgeType: "invokes", origin: "parser", method: "EXTRACTED" }] });
    fixture.store.replaceFileEdges({ branchId: fixture.branchId, filePath: "src/provider.ts", edges: [{ src: qualified, dst: provider, edgeType: "handles", origin: "parser", method: "EXTRACTED" }] });

    const protoOnly = fixture.store.upsertGrpcEndpoint({ packageName: "acme.inventory.v1", service: "Inventory", method: "DeclaredOnly" });
    fixture.store.replaceFileEdges({ branchId: fixture.branchId, filePath: "proto/inventory.proto", edges: [{ src: protoOnly, dst: proto, edgeType: "declares", origin: "parser", method: "EXTRACTED" }] });

    const forms = ["gRPC Inventory.GetThing", "grpc::acme.inventory.v1.Inventory.GetThing", "/acme.inventory.v1.Inventory/GetThing", `node:${qualified}`];
    const resolutions = forms.map((form) => resolveGrpcEndpoint(fixture.store, form));
    assert.ok(resolutions.every((result) => result.kind === "unique"), JSON.stringify(resolutions));
    assert.deepEqual(new Set(resolutions.map((result) => result.nodeId)), new Set([qualified]));
    assert.equal(bare, qualified, "package discovery preserves one canonical node id");
    assert.equal(fixture.store.endpointHandlerStatus(qualified, fixture.repoId), "handled");
    assert.equal(fixture.store.endpointHandlerStatus(protoOnly, fixture.repoId), "proto_only");
    const inventory = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 50 } }, { store: fixture.store });
    const declaration = inventory.items.find((item) => item.nodeId === protoOnly);
    assert.equal(declaration.handlerStatus, "proto_only", JSON.stringify(declaration));
    assert.deepEqual(declaration.handlers, [], JSON.stringify(declaration));
    assert.equal((declaration.firstHopRelations ?? []).some((relation) => relation.edgeType === "handles"), false, JSON.stringify(declaration));
  } finally {
    fixture.store.close();
  }
});

function relationTuple(edgeType, item, fallback) {
  const source = item?.source ?? {};
  return [edgeType, item?.nodeId ?? item?.id ?? null, source.repoId ?? item?.repoId ?? fallback?.repoId ?? null, source.revisionId ?? item?.revisionId ?? fallback?.revisionId ?? null, item?.evidenceState ?? fallback?.proofStatus ?? null];
}

test("Round17 G4: context and flow expose the same endpoint first-hop tuples", async () => {
  const fixture = seedFixture();
  try {
    fixture.store.replaceFileEdges({
      branchId: fixture.branchId,
      filePath: "src/change-reference.ts",
      edges: [{ src: fixture.endpoint, dst: fixture.changed, edgeType: "references", origin: "parser", method: "EXTRACTED" }],
    });
    const [context, flow, inventory] = await Promise.all([
      runKnowledgeTool("knowledge_context", { target: `node:${fixture.endpoint}`, repo: "repo-a" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_flow", { target: `node:${fixture.endpoint}`, repo: "repo-a" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 50 } }, { store: fixture.store }),
    ]);
    const cliContext = await cliJson(fixture.store, fixture.repo.rootPath, ["context", `node:${fixture.endpoint}`, "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    const cliFlow = await cliJson(fixture.store, fixture.repo.rootPath, ["flow", `node:${fixture.endpoint}`, "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    assert.equal(context?.error, undefined, JSON.stringify(context));
    assert.equal(flow?.error, undefined, JSON.stringify(flow));
    assert.equal(inventory?.error, undefined, JSON.stringify(inventory));
    const contextTuples = (context?.firstHopRelations ?? []).map((item) => relationTuple(item.edgeType, item, context)).sort();
    const flowTuples = (flow?.steps ?? []).filter((step) => step.depth === 1).map((step) => relationTuple(step.via, step, flow)).sort();
    const inventoryItem = inventory?.items?.find((item) => item.nodeId === fixture.endpoint);
    const inventoryTuples = (inventoryItem?.firstHopRelations ?? []).map((item) => relationTuple(item.edgeType, item, inventory)).sort();
    const cliContextTuples = (cliContext.json?.firstHopRelations ?? []).map((item) => relationTuple(item.edgeType, item, cliContext.json)).sort();
    const cliFlowTuples = (cliFlow.json?.steps ?? []).filter((step) => step.depth === 1).map((step) => relationTuple(step.via, step, cliFlow.json)).sort();
    assert.deepEqual((context?.handles ?? []).map((item) => relationTuple("handles", item, context)).sort(), flowTuples.filter((tuple) => tuple[0] === "handles"));
    assert.deepEqual(contextTuples, flowTuples);
    assert.deepEqual(inventoryTuples, flowTuples);
    assert.deepEqual(cliContextTuples, flowTuples);
    assert.deepEqual(cliFlowTuples, flowTuples);
  } finally {
    fixture.store.close();
  }
});

test("Round17 G4: repo scope removes a foreign branchless provider handle from inventory, context, and flow", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const foreignHandler = addSymbol(fixture, repoB, "foreignProvider", "src/foreign-provider.ts");
    const endpoint = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "ScopedService", method: "ForeignProvider" });
    fixture.store.replaceEndpointMembershipsForFile({
      repoId: fixture.repoId,
      filePath: "proto/scoped-service.proto",
      memberships: [{ endpointId: endpoint, role: "declaration" }],
    });
    fixture.store.replaceFileEdges({
      repoId: repoB.repoId,
      branchId: repoB.branchId,
      filePath: "src/foreign-provider.ts",
      edges: [
        { src: endpoint, dst: foreignHandler, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true },
        { src: endpoint, dst: foreignHandler, edgeType: "references", origin: "parser", method: "EXTRACTED", branchless: true },
      ],
    });

    const [inventory, context, flow] = await Promise.all([
      runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 50 } }, { store: fixture.store }),
      runKnowledgeTool("knowledge_context", { target: `node:${endpoint}`, repo: "repo-a" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_flow", { target: `node:${endpoint}`, repo: "repo-a" }, { store: fixture.store }),
    ]);
    const item = inventory.items.find((candidate) => candidate.nodeId === endpoint);
    for (const relations of [item.firstHopRelations, context.firstHopRelations, flow.steps.filter((step) => step.depth === 1)]) {
      assert.equal(relations.some((relation) => (relation.edgeType ?? relation.via) === "handles" && relation.nodeId === foreignHandler), false, JSON.stringify(relations));
      const crossRepoReference = relations.find((relation) => (relation.edgeType ?? relation.via) === "references" && relation.nodeId === foreignHandler);
      assert.equal(crossRepoReference?.boundary, true, JSON.stringify(relations));
      assert.equal(crossRepoReference?.source?.repoId, repoB.repoId, JSON.stringify(relations));
    }
    assert.deepEqual(item.handlers, []);
    assert.deepEqual(context.handles, []);
  } finally {
    fixture.store.close();
  }
});

test("Round17 G4: unscoped CLI and MCP inventory preserve every repo membership and provider source", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const providerA = addSymbol(fixture, {
      repoId: fixture.repoId,
      branchId: fixture.branchId,
      commitSha: fixture.repo.commitSha,
    }, "sharedProviderA", "src/shared-provider-a.ts");
    const providerB = addSymbol(fixture, repoB, "sharedProviderB", "src/shared-provider-b.ts");
    const endpoint = fixture.store.upsertGrpcEndpoint({
      packageName: "fixture.v1",
      service: "SharedService",
      method: "AcrossRepos",
    });
    fixture.store.replaceFileEdges({
      repoId: fixture.repoId,
      branchId: fixture.branchId,
      filePath: "src/shared-provider-a.ts",
      edges: [{ src: endpoint, dst: providerA, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }],
    });
    fixture.store.replaceFileEdges({
      repoId: repoB.repoId,
      branchId: repoB.branchId,
      filePath: "src/shared-provider-b.ts",
      edges: [{ src: endpoint, dst: providerB, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }],
    });

    const mcp = await runKnowledgeTool("knowledge_endpoints", {
      protocol: "grpc",
      page: { limit: 100 },
    }, { store: fixture.store });
    const cli = await cliJson(fixture.store, fixture.repo.rootPath, [
      "endpoints", "--protocol", "grpc", "--limit", "100", "--json",
    ], { keepStoreOpen: true });
    assert.equal(cli.exitCode, 0, JSON.stringify(cli));
    assert.equal(mcp?.error, undefined, JSON.stringify(mcp));

    const projection = (result) => {
      const item = result.items.find((candidate) => candidate.nodeId === endpoint);
      assert.ok(item, JSON.stringify(result));
      return {
        source: item.source,
        memberships: item.memberships
          .filter((membership) => membership.role === "provider")
          .map((membership) => [membership.repoId, membership.locatorNodeId])
          .sort(),
        handlers: item.handlers
          .map((handler) => [handler.nodeId, handler.source?.repoId ?? null])
          .sort(),
      };
    };
    const expected = {
      source: null,
      memberships: [[fixture.repoId, providerA], [repoB.repoId, providerB]].sort(),
      handlers: [[providerA, fixture.repoId], [providerB, repoB.repoId]].sort(),
    };
    assert.deepEqual(projection(mcp), expected);
    assert.deepEqual(projection(cli.json), expected);
  } finally {
    fixture.store.close();
  }
});

test("Round17 G7: endpoint inventory uses one live scope for provenance and cross-adapter cursors", async () => {
  const fixture = seedFixture();
  try {
    fixture.store.db.prepare(
      "INSERT INTO revision_snapshots (id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at,pinned) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
    ).run("snapshot-default", "snapshot-default", fixture.repoId, "default-snapshot-commit", "p", "r", SCHEMA_VERSION, "ready", new Date().toISOString(), new Date().toISOString());
    fixture.store.db.prepare("UPDATE branches SET status='snapshot', default_branch=1, current_snapshot_id=? WHERE id=?").run("snapshot-default", fixture.branchId);
    const featureBranchId = fixture.store.registerBranch({ repoId: fixture.repoId, name: "feature", headCommit: "feature-v1", status: "live" });
    fixture.store.db.prepare("UPDATE branches SET default_branch=0,last_indexed_commit=? WHERE id=?").run("feature-v1", featureBranchId);
    for (const method of ["ScopeOne", "ScopeTwo", "ScopeThree"]) {
      const endpointId = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "ScopeService", method });
      fixture.store.replaceEndpointMembershipsForFile({ repoId: fixture.repoId, filePath: `proto/${method}.proto`, memberships: [{ endpointId, role: "declaration" }] });
    }

    const cliFirst = await cliJson(fixture.store, fixture.repo.rootPath, ["endpoints", "repo-a", "--protocol", "grpc", "--limit", "1", "--json"], { keepStoreOpen: true });
    const mcpFirst = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 1 } }, { store: fixture.store });
    assert.equal(cliFirst.exitCode, 0, JSON.stringify(cliFirst));
    assert.equal(cliFirst.json.items[0].source.branchId, featureBranchId, JSON.stringify(cliFirst.json));
    assert.equal(mcpFirst.items[0].source.branchId, featureBranchId, JSON.stringify(mcpFirst));

    const cliToMcp = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 1, cursor: cliFirst.json.nextCursor } }, { store: fixture.store });
    const mcpToCli = await cliJson(fixture.store, fixture.repo.rootPath, ["endpoints", "repo-a", "--protocol", "grpc", "--limit", "1", "--cursor", mcpFirst.nextCursor, "--json"], { keepStoreOpen: true });
    assert.equal(cliToMcp.error, undefined, JSON.stringify(cliToMcp));
    assert.equal(mcpToCli.exitCode, 0, JSON.stringify(mcpToCli));
    assert.equal(cliToMcp.items[0].nodeId, mcpToCli.json.items[0].nodeId);
    assert.equal(cliToMcp.candidateCount, cliFirst.json.candidateCount);
    assert.equal(mcpToCli.json.candidateCount, mcpFirst.candidateCount);

    fixture.store.db.prepare("UPDATE branches SET last_indexed_commit=?,head_commit=? WHERE id=?").run("feature-v2", "feature-v2", featureBranchId);
    const staleMcp = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 1, cursor: cliFirst.json.nextCursor } }, { store: fixture.store });
    const staleCli = await cliJson(fixture.store, fixture.repo.rootPath, ["endpoints", "repo-a", "--protocol", "grpc", "--limit", "1", "--cursor", mcpFirst.nextCursor, "--json"], { keepStoreOpen: true });
    assert.ok(["CURSOR_STALE", "CURSOR_SCOPE_MISMATCH"].includes(staleMcp.error?.code), JSON.stringify(staleMcp));
    assert.notEqual(staleCli.exitCode, 0, JSON.stringify(staleCli));
    assert.ok(["CURSOR_STALE", "CURSOR_SCOPE_MISMATCH"].includes(staleCli.json?.error?.code), JSON.stringify(staleCli));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G4: non-legacy snapshot first hops preserve inferred evidence", () => {
  const fixture = seedFixture();
  try {
    fixture.store.db.prepare(
      "INSERT INTO revision_snapshots (id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at,pinned) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
    ).run("snapshot-evidence", "snapshot-evidence", fixture.repoId, fixture.repo.commitSha, "p", "r", SCHEMA_VERSION, "ready", new Date().toISOString(), new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO resolution_sets (id,file_fact_id,context_fingerprint,resolver_version,created_at) VALUES (?,?,?,?,?)")
      .run("resolution-evidence", "fact-evidence", "context-evidence", "r", new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO resolved_edges (id,resolution_set_id,src_identity_key,dst_identity_key,edge_type,method,confidence,provenance) VALUES (?,?,?,?,?,?,?,?)")
      .run("edge-evidence", "resolution-evidence", fixture.store.getNode(fixture.endpoint).identity_key, fixture.store.getNode(fixture.caller).identity_key, "handles", "INFERRED", 0.42, JSON.stringify({ file: "src/snapshot-provider.ts", line: 17 }));
    fixture.store.db.prepare("INSERT INTO resolved_edges (id,resolution_set_id,src_identity_key,dst_identity_key,edge_type,method,confidence,provenance) VALUES (?,?,?,?,?,?,?,?)")
      .run("edge-missing-evidence", "resolution-evidence", fixture.store.getNode(fixture.endpoint).identity_key, fixture.store.getNode(fixture.changed).identity_key, "references", "", 1, "{}");
    fixture.store.db.prepare("INSERT INTO snapshot_resolution_refs (snapshot_id,file_path,resolution_set_id) VALUES (?,?,?)")
      .run("snapshot-evidence", "src/snapshot-provider.ts", "resolution-evidence");
    const revision = {
      repoId: fixture.repoId,
      branch: "main",
      branchId: fixture.branchId,
      commitSha: fixture.repo.commitSha,
      snapshotId: "snapshot-evidence",
      trust: "exact_commit",
    };
    const context = buildContextPack(fixture.store, `node:${fixture.endpoint}`, { repoId: fixture.repoId, revision });
    const flow = buildFlow(fixture.store, `node:${fixture.endpoint}`, { repoId: fixture.repoId, revision });
    for (const relation of [context.firstHopRelations[0], flow.steps.find((step) => step.depth === 1)]) {
      assert.equal(relation.evidenceState, "candidate", JSON.stringify(relation));
      assert.equal(relation.edgeEvidence.method, "INFERRED", JSON.stringify(relation));
      assert.equal(relation.edgeEvidence.confidence, 0.42, JSON.stringify(relation));
      assert.deepEqual(relation.edgeEvidence.provenance, { file: "src/snapshot-provider.ts", line: 17 }, JSON.stringify(relation));
      assert.equal(relation.edgeEvidence.scope, "revision", JSON.stringify(relation));
    }
    const contextMissing = context.firstHopRelations.find((relation) => relation.edgeType === "references");
    const flowMissing = flow.steps.find((step) => step.depth === 1 && step.via === "references");
    assert.equal(contextMissing?.evidenceState, "not_proven", JSON.stringify(contextMissing));
    assert.equal(flowMissing?.evidenceState, "not_proven", JSON.stringify(flowMissing));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G4: revision context scans snapshot relations at most twice", () => {
  const fixture = seedFixture();
  const originalPrepare = fixture.store.db.prepare.bind(fixture.store.db);
  try {
    fixture.store.db.prepare(
      "INSERT INTO revision_snapshots (id,snapshot_key,repo_id,commit_sha,parser_version,resolver_version,schema_version,state,created_at,last_accessed_at,pinned) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
    ).run("snapshot-context-scan", "snapshot-context-scan", fixture.repoId, fixture.repo.commitSha, "p", "r", SCHEMA_VERSION, "ready", new Date().toISOString(), new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO resolution_sets (id,file_fact_id,context_fingerprint,resolver_version,created_at) VALUES (?,?,?,?,?)")
      .run("resolution-context-scan", "fact-context-scan", "context-context-scan", "r", new Date().toISOString());
    fixture.store.db.prepare("INSERT INTO resolved_edges (id,resolution_set_id,src_identity_key,dst_identity_key,edge_type,method,confidence,provenance) VALUES (?,?,?,?,?,?,?,?)")
      .run("edge-context-scan", "resolution-context-scan", fixture.store.getNode(fixture.endpoint).identity_key, fixture.store.getNode(fixture.caller).identity_key, "handles", "EXTRACTED", 1, "{}");
    fixture.store.db.prepare("INSERT INTO snapshot_resolution_refs (snapshot_id,file_path,resolution_set_id) VALUES (?,?,?)")
      .run("snapshot-context-scan", "src/context-provider.ts", "resolution-context-scan");

    let snapshotEdgeScans = 0;
    fixture.store.db.prepare = (sql) => {
      if (String(sql).includes("SELECT r.* FROM resolved_edges")) snapshotEdgeScans += 1;
      return originalPrepare(sql);
    };
    const revision = {
      repoId: fixture.repoId,
      branch: "main",
      branchId: fixture.branchId,
      commitSha: fixture.repo.commitSha,
      snapshotId: "snapshot-context-scan",
      trust: "exact_commit",
    };

    const context = buildContextPack(fixture.store, `node:${fixture.endpoint}`, { repoId: fixture.repoId, revision });

    assert.equal(context.assemblyError, null, JSON.stringify(context));
    assert.equal(context.firstHopRelations.some((relation) => relation.edgeType === "handles"), true, JSON.stringify(context));
    assert.ok(snapshotEdgeScans <= 2, `expected one context relation scan plus one endpoint first-hop scan, got ${snapshotEdgeScans}`);
  } finally {
    fixture.store.db.prepare = originalPrepare;
    fixture.store.close();
  }
});

test("Round17 G5: aligned partial coverage is fresh and all read surfaces share one revision", async () => {
  const fixture = seedFixture();
  try {
    const readySnapshotId = publishDeterministicReadySnapshot(fixture);
    const coverageInsert = fixture.store.db.prepare(
      "INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    coverageInsert.run(fixture.repoId, "excluded.generated.ts", "tracked", "excluded", "generated", "generated", 1, "fixture exclusion", new Date().toISOString());
    coverageInsert.run(fixture.repoId, "failed.parse.ts", "tracked", "failed", "parse_failed", "source", 1, "fixture parse failure", new Date().toISOString());
    coverageInsert.run(fixture.repoId, "stale.ts", "tracked", "stale", "stale", "source", 1, "fixture stale coverage row", new Date().toISOString());
    fixture.store.db.prepare(`INSERT INTO unresolved_reference_coverage
      (repo_id,branch_id,file_path,revision_id,resolved,total,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(fixture.repoId, fixture.branchId, "src/changed.ts", readySnapshotId, 1, 3, new Date().toISOString());

    const search = await runKnowledgeTool("knowledge_search", { query: "changed", repo: "repo-a" }, { store: fixture.store });
    assert.equal(search?.error, undefined, JSON.stringify(search));
    assert.equal(search?.freshness?.status, "fresh", JSON.stringify(search));
    assert.equal(search?.coverage?.status, "partial", JSON.stringify(search));
    assert.equal(search?.coverage?.failed, 1, JSON.stringify(search));
    assert.equal(search?.coverage?.stale, 1, JSON.stringify(search));
    assert.equal(search?.coverage?.unresolvedReferences, 2, JSON.stringify(search));
    assert.equal(search?.completeness, "partial", JSON.stringify(search));
    assert.equal(search?.proofStatus, "candidate", JSON.stringify(search));
    assert.deepEqual(search?.evidence?.freshness, search?.freshness, JSON.stringify(search));
    assert.deepEqual(search?.evidence?.coverage, search?.coverage, JSON.stringify(search));
    assert.ok(Array.isArray(search?.results), JSON.stringify(search));

    const revisionResolution = resolveRevisionContext(fixture.store, { repoId: fixture.repoId, branch: "main" });
    assert.equal(revisionResolution.status, "resolved");
    const context = buildContextPack(fixture.store, `node:${fixture.changed}`, { repoId: fixture.repoId, revision: revisionResolution.context });
    const flow = buildFlow(fixture.store, `node:${fixture.changed}`, { repoId: fixture.repoId, revision: revisionResolution.context });
    const affected = await runKnowledgeTool("knowledge_affected", { repo: "repo-a", files: ["src/changed.ts"] }, { store: fixture.store });
    for (const result of [context, flow, affected]) {
      assert.equal(result?.freshness?.status, search.freshness.status, JSON.stringify(result));
      assert.equal(result?.coverage?.status, "partial", JSON.stringify(result));
      assert.equal(result?.evidence?.proofStatus === "proven", false, JSON.stringify(result));
    }

    const revisionKey = (value) => value?.revision?.snapshotId ?? value?.revision?.commitSha ?? value?.revision?.id ?? value?.revision?.revisionId ?? value?.locator?.snapshotId ?? value?.locator?.commitSha ?? null;
    const mcpContext = await runKnowledgeTool("knowledge_context", { repo: "repo-a", target: `node:${fixture.changed}` }, { store: fixture.store });
    const mcpFlow = await runKnowledgeTool("knowledge_flow", { repo: "repo-a", target: `node:${fixture.changed}` }, { store: fixture.store });
    const mcpEndpoints = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 50 } }, { store: fixture.store });
    const cliSearch = await cliJson(fixture.store, fixture.repo.rootPath, ["search", "changed", "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    const cliContext = await cliJson(fixture.store, fixture.repo.rootPath, ["context", `node:${fixture.changed}`, "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    const cliFlow = await cliJson(fixture.store, fixture.repo.rootPath, ["flow", `node:${fixture.changed}`, "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    const cliAffected = await cliJson(fixture.store, fixture.repo.rootPath, ["affected", "src/changed.ts", "--repo", "repo-a", "--json"], { keepStoreOpen: true });
    const cliEndpoints = await cliJson(fixture.store, fixture.repo.rootPath, ["endpoints", "repo-a", "--protocol", "grpc", "--limit", "50", "--json"], { keepStoreOpen: true });
    const surfaces = [search, mcpEndpoints, mcpContext, mcpFlow, affected, cliSearch.json, cliEndpoints.json, cliContext.json, cliFlow.json, cliAffected.json];
    const revisionKeys = surfaces.map(revisionKey);
    assert.deepEqual(revisionKeys, Array(revisionKeys.length).fill(readySnapshotId), JSON.stringify(revisionKeys));
    for (const surface of surfaces) {
      assert.equal(surface?.revision?.snapshotId, readySnapshotId, JSON.stringify(surface?.revision));
      assert.equal(surface?.evidence?.revision?.snapshotId, readySnapshotId, JSON.stringify(surface?.evidence?.revision));
      assertEmbeddedRevisionParity(surface, readySnapshotId);
    }

    const emptyMcp = await runKnowledgeTool("knowledge_search", { query: "   ", repo: "repo-a" }, { store: fixture.store });
    const missingRepoMcp = await runKnowledgeTool("knowledge_search", { query: "changed", repo: "missing-repo" }, { store: fixture.store });
    const missingBranchMcp = await runKnowledgeTool("knowledge_search", { query: "changed", repo: "repo-a", branch: "missing-branch" }, { store: fixture.store });
    const missingFileMcp = await runKnowledgeTool("knowledge_search", {
      query: "changed",
      contract_version: "2",
      scope: { revisions: [{ repoId: fixture.repoId }], paths: ["missing.ts"] },
    }, { store: fixture.store });
    const malformedSearchCursorMcp = await runKnowledgeTool("knowledge_search", {
      query: "changed",
      repo: "repo-a",
      cursor: "malformed",
    }, { store: fixture.store });
    assert.deepEqual(
      [emptyMcp?.error?.code, missingRepoMcp?.error?.code, missingBranchMcp?.error?.code, missingFileMcp?.error?.code, malformedSearchCursorMcp?.error?.code],
      ["INVALID_QUERY", "REPOSITORY_NOT_FOUND", "BRANCH_NOT_FOUND", "FILE_NOT_FOUND", "CURSOR_INVALID"],
      JSON.stringify({ emptyMcp, missingRepoMcp, missingBranchMcp, missingFileMcp, malformedSearchCursorMcp }),
    );

    const commands = [
      ["search", "", "--repo", "repo-a", "--json"],
      ["search", "changed", "--repo", "missing-repo", "--json"],
      ["search", "changed", "--repo", "repo-a", "--branch", "missing-branch", "--json"],
      ["filesymbols", "repo-a", "main", "missing.ts", "--json"],
      ["context", "node:missing-node", "--repo", "repo-a", "--json"],
      ["endpoints", "repo-a", "--cursor", "malformed", "--json"],
      ["search", "changed", "--repo", "repo-a", "--cursor", "malformed", "--json"],
    ];
    const outcomes = [];
    for (const argv of commands) outcomes.push(await cliJson(fixture.store, fixture.repo.rootPath, argv, { keepStoreOpen: true }));
    assert.deepEqual(outcomes.map((outcome) => outcome.exitCode !== 0 && typeof outcome.json?.error?.code === "string"), [true, true, true, true, true, true, true], JSON.stringify(outcomes));
    assert.deepEqual(
      outcomes.map((outcome) => outcome.json?.error?.code),
      ["INVALID_QUERY", "REPOSITORY_NOT_FOUND", "BRANCH_NOT_FOUND", "FILE_NOT_FOUND", "NODE_NOT_FOUND", "CURSOR_INVALID", "CURSOR_INVALID"],
      JSON.stringify(outcomes),
    );
  } finally {
    fixture.store.close();
  }
});

test("Round17 G6: invalid CLI and MCP requests return the exact typed error contract", async () => {
  const fixture = seedFixture();
  try {
    const mcpResults = await Promise.all([
      runKnowledgeTool("knowledge_search", { query: "", repo: "repo-a" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_search", { query: "changed", repo: "missing-repo" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_search", { query: "changed", repo: "repo-a", branch: "missing-branch" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_search", { query: "changed", contract_version: "2", scope: { revisions: [{ repoId: fixture.repoId }], paths: ["missing.ts"] } }, { store: fixture.store }),
      runKnowledgeTool("knowledge_context", { repo: "repo-a", target: "node:missing-node" }, { store: fixture.store }),
      runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", page: { cursor: "malformed" } }, { store: fixture.store }),
    ]);
    assert.deepEqual(mcpResults.map((result) => result?.error?.code), [
      "INVALID_QUERY", "REPOSITORY_NOT_FOUND", "BRANCH_NOT_FOUND", "FILE_NOT_FOUND", "NODE_NOT_FOUND", "CURSOR_INVALID",
    ]);
  } finally {
    fixture.store.close();
  }
});

test("Round17 G5: legacy MCP compatibility results reuse canonical v2 evidence", async () => {
  const fixture = seedFixture();
  try {
    const note = fixture.store.upsertNode({
      nodeType: "note",
      identityKey: `${fixture.repoId}::parity-secret.md`,
      repoId: fixture.repoId,
      title: "Parity Secret",
    });
    fixture.store.indexNoteText({
      nodeId: note,
      path: "parity-secret.md",
      title: "Parity Secret",
      body: "legacyparitysecretneedle",
      sensitive: true,
      mcpAccess: "allowed",
      contentHash: "parity-secret-hash",
    });

    const legacy = await runKnowledgeTool("knowledge_search", { query: "legacyparitysecretneedle", repo: "repo-a" }, { store: fixture.store });
    const canonical = await runKnowledgeTool("knowledge_search", { query: "legacyparitysecretneedle", repo: "repo-a", contract_version: "2" }, { store: fixture.store });
    assert.ok(legacy?.results?.some((item) => item.nodeId === note), JSON.stringify(legacy));
    const evidenceProjection = (result) => ({
      freshness: result?.freshness,
      coverage: result?.coverage,
      completeness: result?.completeness,
      proofStatus: result?.proofStatus,
      candidateCount: result?.candidateCount,
      returnedCount: result?.returnedCount,
      truncated: result?.truncated,
      cursor: result?.cursor,
    });
    assert.deepEqual(evidenceProjection(legacy), evidenceProjection(canonical), JSON.stringify({ legacy, canonical }));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G7: endpoint cursors continue, exhaust, reject malformed input, and reject a foreign scope", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    const second = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "ChangeService", method: "Second" });
    fixture.store.replaceEndpointMembershipsForFile({ repoId: fixture.repoId, filePath: "proto/second.proto", memberships: [{ endpointId: second, role: "declaration" }] });
    fixture.store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::other.v1.OtherService.Only", repoId: repoB.repoId, title: "gRPC other.v1.OtherService.Only", meta: { protocol: "grpc" } });

    const first = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 1 } }, { store: fixture.store });
    assert.equal(first?.error, undefined, JSON.stringify(first));
    assert.equal(typeof first?.nextCursor, "string", JSON.stringify(first));
    assert.equal(first?.candidateCount, 2, JSON.stringify(first));
    assert.equal(first?.remainingCount, 1, JSON.stringify(first));
    const secondPage = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 1, cursor: first.nextCursor } }, { store: fixture.store });
    assert.equal(secondPage?.error, undefined, JSON.stringify(secondPage));
    assert.notEqual(secondPage?.items?.[0]?.nodeId, first?.items?.[0]?.nodeId, JSON.stringify({ first, secondPage }));
    assert.equal(secondPage?.candidateCount, 2, JSON.stringify(secondPage));
    assert.equal(secondPage?.remainingCount, 0, JSON.stringify(secondPage));
    assert.equal(secondPage?.truncated, false, JSON.stringify(secondPage));
    assert.equal(secondPage?.totalIsExact, true, JSON.stringify(secondPage));
    const exhausted = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 10, cursor: secondPage.nextCursor } }, { store: fixture.store });
    assert.equal(exhausted?.error, undefined, JSON.stringify(exhausted));
    assert.equal(exhausted?.nextCursor, null, JSON.stringify(exhausted));
    assert.ok([fixture.endpoint, second].includes(first.items[0].nodeId));

    const malformed = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-a", protocol: "grpc", page: { limit: 1, cursor: "round17-malformed" } }, { store: fixture.store });
    const wrongScope = await runKnowledgeTool("knowledge_endpoints", { repo: "repo-b", protocol: "grpc", page: { limit: 1, cursor: first.nextCursor } }, { store: fixture.store });
    assert.equal(malformed?.error?.code, "CURSOR_INVALID", JSON.stringify(malformed));
    assert.equal(wrongScope?.error?.code, "CURSOR_SCOPE_MISMATCH", JSON.stringify(wrongScope));
  } finally {
    fixture.store.close();
  }
});

test("Round17 G7: endpoints filesymbols and deadcode cursors continue exhaust and reject invalid or wrong scope", async () => {
  const fixture = seedFixture();
  try {
    const repoB = addScopedRepo(fixture, "repo-b");
    for (const [index, title] of ["ManyOne", "ManyTwo", "ManyThree"].entries()) {
      const nodeId = fixture.store.upsertNode({ nodeType: "symbol", identityKey: `${fixture.repoId}::${title}`, repoId: fixture.repoId, title });
      fixture.store.upsertSymbolVersion({ nodeId, branchId: fixture.branchId, commitSha: fixture.repo.commitSha, filePath: "src/many.ts", lang: "typescript", kind: "function", startLine: index + 1, contentHash: `${title}-hash`, status: "fresh" });
      fixture.store.indexSymbolText({ nodeId, name: title, signature: `${title}()` });
    }
    for (const method of ["CursorOne", "CursorTwo", "CursorThree"]) {
      const endpointId = fixture.store.upsertGrpcEndpoint({ packageName: "fixture.v1", service: "CursorService", method });
      fixture.store.replaceEndpointMembershipsForFile({ repoId: fixture.repoId, filePath: `proto/${method}.proto`, memberships: [{ endpointId, role: "declaration" }] });
    }
    addSymbol(fixture, repoB, "ForeignDeadOne", "src/foreign-dead-one.ts");
    addSymbol(fixture, repoB, "ForeignDeadTwo", "src/foreign-dead-two.ts");

    const surfaces = [
      {
        name: "endpoints",
        first: ["endpoints", "repo-a", "--limit", "1", "--json"],
        next: (cursor) => ["endpoints", "repo-a", "--limit", "1", "--cursor", cursor, "--json"],
        invalid: ["endpoints", "repo-a", "--cursor", "malformed", "--json"],
        wrong: (cursor) => ["endpoints", "repo-b", "--limit", "1", "--cursor", cursor, "--json"],
      },
      {
        name: "filesymbols",
        first: ["filesymbols", "repo-a", "main", "src/many.ts", "--limit", "1", "--json"],
        next: (cursor) => ["filesymbols", "repo-a", "main", "src/many.ts", "--limit", "1", "--cursor", cursor, "--json"],
        invalid: ["filesymbols", "repo-a", "main", "src/many.ts", "--cursor", "malformed", "--json"],
        wrong: (cursor) => ["filesymbols", "repo-a", "main", "src/changed.ts", "--limit", "1", "--cursor", cursor, "--json"],
      },
      {
        name: "deadcode",
        first: ["deadcode", "--repo", "repo-a", "--limit", "1", "--json"],
        next: (cursor) => ["deadcode", "--repo", "repo-a", "--limit", "1", "--cursor", cursor, "--json"],
        invalid: ["deadcode", "--repo", "repo-a", "--cursor", "malformed", "--json"],
        wrong: (cursor) => ["deadcode", "--repo", "repo-b", "--limit", "1", "--cursor", cursor, "--json"],
      },
    ];

    for (const surface of surfaces) {
      const first = await cliJson(fixture.store, fixture.repo.rootPath, surface.first, { keepStoreOpen: true });
      assert.equal(first.exitCode, 0, `${surface.name}: ${JSON.stringify(first)}`);
      assert.equal(typeof first.json.nextCursor, "string", `${surface.name}: ${JSON.stringify(first.json)}`);
      const firstIds = new Set((first.json.items ?? []).map((item) => item.nodeId));
      const second = await cliJson(fixture.store, fixture.repo.rootPath, surface.next(first.json.nextCursor), { keepStoreOpen: true });
      assert.equal(second.exitCode, 0, `${surface.name}: ${JSON.stringify(second)}`);
      assert.ok((second.json.items ?? []).every((item) => !firstIds.has(item.nodeId)), `${surface.name}: ${JSON.stringify({ first: first.json, second: second.json })}`);
      let current = second;
      for (let page = 0; page < 20 && current.json.nextCursor; page += 1) {
        current = await cliJson(fixture.store, fixture.repo.rootPath, surface.next(current.json.nextCursor), { keepStoreOpen: true });
        assert.equal(current.exitCode, 0, `${surface.name}: ${JSON.stringify(current)}`);
      }
      assert.equal(current.json.nextCursor, null, `${surface.name}: ${JSON.stringify(current.json)}`);
      assert.equal(current.json.truncated, false, `${surface.name}: ${JSON.stringify(current.json)}`);
      const invalid = await cliJson(fixture.store, fixture.repo.rootPath, surface.invalid, { keepStoreOpen: true });
      const wrong = await cliJson(fixture.store, fixture.repo.rootPath, surface.wrong(first.json.nextCursor), { keepStoreOpen: true });
      assert.equal(invalid.json?.error?.code, "CURSOR_INVALID", `${surface.name}: ${JSON.stringify(invalid)}`);
      assert.equal(wrong.json?.error?.code, "CURSOR_SCOPE_MISMATCH", `${surface.name}: ${JSON.stringify(wrong)}`);
    }
  } finally {
    fixture.store.close();
  }
});

test("Round17 G8: empty and stale API previews never claim exhaustive or proven evidence", () => {
  const base = {
    documentKey: "api-doc:v1:frontend:en-us:round17",
    title: "Round17",
    revisions: [{ revisionId: "old-revision", repoId: "repo-a", repo: "repo-a", commitSha: "old", trust: "exact_commit", resolutionSource: "commit" }],
    enums: [], endpoints: [], websocketEvents: [], commonResponses: [], frontendChecklist: [], evidence: [], gaps: [],
    coverage: { level: "exhaustive", analyzedRequestPartitions: 0, unresolvedRequestConstraints: 0, discoveredStaticExits: 0, resolvedStaticExits: 0, unresolvedDynamicProducers: 0, groupedDynamicProducers: 0, testCoveredClasses: 0, runtimeObservedClasses: 0, runtimeEvidenceState: "not_requested", blockers: [] },
  };
  const emptyStore = new ApiDocPreviewStore(mkdtempSync(join(tmpdir(), "round17-empty-preview-")));
  const empty = { ...base, revisions: [] };
  emptyStore.save({ ir: empty, rendered: renderApiDocumentation(empty), mode: "preview" });
  const emptyList = emptyStore.listEnvelope();
  assert.equal(emptyList.proofStatus, "not_proven", JSON.stringify(emptyList));
  assert.notEqual(emptyList.completeness, "exact", JSON.stringify(emptyList));
  assert.equal(emptyList.items.some((item) => item.coverage === "exhaustive"), false, JSON.stringify(emptyList));

  const staleStore = new ApiDocPreviewStore(mkdtempSync(join(tmpdir(), "round17-stale-preview-")));
  staleStore.save({ ir: base, rendered: renderApiDocumentation(base), mode: "preview" });
  const staleList = staleStore.listEnvelope({ currentRevisionIds: ["current-revision"] });
  assert.equal(staleList.freshness.status, "stale", JSON.stringify(staleList));
  assert.equal(staleList.proofStatus, "not_proven", JSON.stringify(staleList));
  assert.equal(staleList.items.every((item) => item.evidenceState === "stale" && item.proofStatus === "not_proven"), true, JSON.stringify(staleList));
  assert.ok(staleList.gaps.includes("preview_revision_stale"), JSON.stringify(staleList));
});
