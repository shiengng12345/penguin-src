import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  serviceGraph,
  resolveTarget,
} from "../packages/knowledge-core/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-service-graph-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repos = {};
  const branches = {};
  for (const name of ["consumer", "provider", "unrelated"]) {
    repos[name] = store.registerRepo({ name, rootPath: join(dir, name) });
    branches[name] = store.registerBranch({ repoId: repos[name], name: "main", status: "live", headCommit: "c1" });
  }
  const endpoint = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::Billing.getBalance", title: "gRPC Billing.getBalance" });
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repos.consumer}::BillingClient.getBalance`, title: "getBalance", repoId: repos.consumer });
  const handler = store.upsertNode({ nodeType: "symbol", identityKey: `${repos.provider}::BalanceHandler.getBalance`, title: "getBalance", repoId: repos.provider });
  store.upsertSymbolVersion({ nodeId: caller, branchId: branches.consumer, commitSha: "c1", filePath: "src/client.ts", lang: "ts", kind: "method", contentHash: "caller", status: "fresh" });
  store.upsertSymbolVersion({ nodeId: handler, branchId: branches.provider, commitSha: "c1", filePath: "src/handler.ts", lang: "ts", kind: "method", contentHash: "handler", status: "fresh" });
  store.replaceFileEdges({
    branchId: branches.consumer,
    filePath: "src/client.ts",
    edges: [{ src: caller, dst: endpoint, edgeType: "invokes", origin: "parser", method: "EXTRACTED", confidence: 0.96, provenance: { filePath: "src/client.ts", startLine: 8, evidenceId: "invoke-1" } }],
  });
  store.replaceFileEdges({
    branchId: branches.provider,
    filePath: "src/handler.ts",
    edges: [{ src: endpoint, dst: handler, edgeType: "handles", origin: "parser", method: "EXTRACTED", confidence: 0.99, provenance: { filePath: "src/handler.ts", startLine: 12, evidenceId: "handle-1" } }],
  });
  return { store, repos, dir };
}

test("scoped service graph returns typed service identities and direct neighbours", () => {
  const { store, repos } = fixture();
  const result = serviceGraph(store, { repo: "consumer" });
  assert.deepEqual(result.nodes.map((node) => node.nodeId).sort(), [
    `service:${repos.consumer}`,
    `service:${repos.provider}`,
  ].sort());
  assert.equal(result.edges.length, 1);
  assert.deepEqual(result.edges[0].src, `service:${repos.consumer}`);
  assert.deepEqual(result.edges[0].dst, `service:${repos.provider}`);
  assert.ok(result.edges[0].revisionId);
  assert.equal(result.edges[0].graphEvidence.evidenceState, "proven");
  assert.equal(result.edges[0].graphEvidence.scope, "revision");
  assert.equal(result.evidence.scope.repoId, repos.consumer);

  const target = resolveTarget(store, `service:${repos.consumer}`);
  assert.equal(target.nodeType, "service");
  assert.equal(target.repoId, repos.consumer);
  assert.equal(target.identityKey, `service:${repos.consumer}`);
  store.close();
});

test("unknown service graph scope fails with a typed repository error", () => {
  const { store } = fixture();
  assert.throws(
    () => serviceGraph(store, { repo: "does-not-exist" }),
    (error) => error.code === "REPOSITORY_NOT_FOUND",
  );
  store.close();
});

test("includeDirectNeighbours false keeps only the selected service", () => {
  const { store, repos } = fixture();
  const result = serviceGraph(store, { repo: repos.consumer, includeDirectNeighbours: false });
  assert.deepEqual(result.nodes.map((node) => node.nodeId), [`service:${repos.consumer}`]);
  assert.equal(result.edges.length, 0);
  store.close();
});

test("MCP service identities round-trip through graph, context, flow and path", () => {
  const { store, repos } = fixture();
  const consumer = `service:${repos.consumer}`;
  const provider = `service:${repos.provider}`;

  const graph = handleKnowledgeTool("knowledge_service_graph", { repo: "consumer" }, store);
  assert.deepEqual(graph.nodes.map((node) => node.nodeId).sort(), [consumer, provider].sort());
  assert.equal(graph.edges[0].src, consumer);
  assert.equal(graph.edges[0].dst, provider);
  assert.equal(graph.edges[0].graphEvidence.evidenceState, "proven");

  const context = handleKnowledgeTool("knowledge_context", { target: consumer }, store);
  assert.equal(context.target.nodeId, consumer);
  assert.equal(context.target.nodeType, "service");
  assert.equal(context.graph.edges[0].src, consumer);

  const explored = handleKnowledgeTool("explore_graph", { node: consumer }, store);
  assert.equal(explored.nodes.some((node) => node.nodeId === provider), true);

  const flowed = handleKnowledgeTool("knowledge_flow", { target: consumer }, store);
  assert.equal(flowed.target.nodeId, consumer);
  assert.equal(flowed.graph.edges[0].dst, provider);

  const path = handleKnowledgeTool("knowledge_path", { from: consumer, to: provider }, store);
  assert.equal(path.error, undefined, JSON.stringify(path));
  assert.deepEqual(path.nodes.map((node) => node.nodeId), [consumer, provider]);
  store.close();
});

test("CLI services command keeps repository scope and returns typed unknown-repo errors", async () => {
  const { store, repos, dir } = fixture();
  store.close();
  const lines = [];
  const errors = [];
  const deps = {
    cwd: dir,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    storeExists: () => true,
    openStore: () => KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }),
  };

  assert.equal(await runCli(["services", "--repo", "consumer", "--json"], deps), 0);
  const scoped = JSON.parse(lines.at(-1));
  assert.deepEqual(scoped.nodes.map((node) => node.nodeId).sort(), [
    `service:${repos.consumer}`,
    `service:${repos.provider}`,
  ].sort());
  assert.equal(scoped.edges[0].src, `service:${repos.consumer}`);

  lines.length = 0;
  assert.equal(await runCli(["services", "--repo", "missing", "--json"], deps), 2);
  assert.equal(JSON.parse(lines.at(-1)).error.code, "REPOSITORY_NOT_FOUND");
  assert.equal(errors.length, 0, "JSON errors stay machine-readable on stdout");
});
