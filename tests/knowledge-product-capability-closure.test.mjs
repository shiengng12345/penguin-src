import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GitTopologyStore,
  KnowledgeStore,
  affectedByNode,
  listSemanticStatuses,
  searchKnowledge,
} from "../packages/knowledge-core/dist/index.js";
import { normalizeKnowledgeError, validateSemanticStatus } from "../packages/knowledge-contracts/dist/index.js";
import * as core from "../packages/knowledge-core/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";

test("[timeout-remediation] normalized timeout errors always include MCP-usable remediation", () => {
  const error = normalizeKnowledgeError(Object.assign(new Error("query exceeded the hard timeout"), {
    code: "QUERY_TIMEOUT",
  }));
  assert.equal(error.code, "QUERY_TIMEOUT");
  assert.equal(error.retryable, true);
  assert.match(error.remediation, /retry/i);
  assert.match(error.remediation, /scope|filter|limit/i);
});

test("[same-name-repository-ambiguity] MCP rejects duplicate display names with canonical roots", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-capability-same-name-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  try {
    const roots = [join(directory, "team-a", "FPMS-NT-Auth-Player"), join(directory, "team-b", "FPMS-NT-Auth-Player")];
    for (const rootPath of roots) {
      mkdirSync(rootPath, { recursive: true });
      store.registerRepo({ name: "FPMS-NT-Auth-Player", rootPath });
    }
    const result = handleKnowledgeTool("knowledge_search", { query: "Player", repo: "FPMS-NT-Auth-Player" }, store);
    assert.equal(result.error.code, "AMBIGUOUS_REPOSITORY");
    assert.deepEqual(result.error.details.candidates.map((candidate) => candidate.rootPath).sort(), roots.sort());
    assert.match(result.error.remediation, /repository id|canonical root/i);
  } finally {
    store.close();
  }
});

test("[schema-skew] active branch schema skew is a typed incompatible state with owner remediation", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-capability-schema-skew-"));
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  try {
    const repoId = store.registerRepo({ name: "schema-skew", rootPath: join(directory, "repo") });
    const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
    store.db.prepare("UPDATE branches SET indexed_schema_version=? WHERE id=?").run(core.SCHEMA_VERSION - 1, branchId);

    assert.equal(typeof core.runtimeIndexCompatibility, "function");
    assert.deepEqual(core.runtimeIndexCompatibility(store, branchId), {
      state: "schema_outdated",
      compatible: false,
      code: "SCHEMA_OUTDATED",
      runtimeSchemaVersion: core.SCHEMA_VERSION,
      indexedSchemaVersion: core.SCHEMA_VERSION - 1,
      remediation: "penguin index",
    });
  } finally {
    store.close();
  }
});

test("[semantic-empty-state] reports a canonical not_queued state for a registered repository with no generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-capability-semantic-empty-"));
  const rootPath = join(directory, "repo");
  mkdirSync(rootPath);
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "EmptySemanticRepo", rootPath });

  const statuses = listSemanticStatuses(store, `repo:${repoId}`);

  assert.equal(statuses.length, 1);
  assert.deepEqual(validateSemanticStatus(statuses[0]), statuses[0]);
  assert.equal(statuses[0].state, "not_queued");
  assert.equal(statuses[0].scopeKey, `repo:${repoId}`);
  assert.equal(statuses[0].repoId, repoId);
  assert.equal(statuses[0].generationId, null);
  assert.equal(statuses[0].activeGenerationId, null);
  assert.equal(statuses[0].expected, 0);
  assert.equal(statuses[0].ready, 0);
  assert.equal(statuses[0].progressPercent, 0);
  assert.equal(statuses[0].reason, "SEMANTIC_GENERATION_NOT_QUEUED");
  store.close();
});

test("[scope-kinds-symbol] repo and symbol kind scope cannot starve an exact symbol behind global FTS candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-capability-kind-scope-"));
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  try {
    for (let index = 0; index < 12; index += 1) {
      const repoId = store.registerRepo({ name: `decoy-${index}`, rootPath: join(directory, `decoy-${index}`) });
      const nodeId = store.upsertNode({
        nodeType: "symbol",
        identityKey: `decoy-${index}::VaultFetcher`,
        repoId,
        title: "VaultFetcher",
      });
      store.indexSymbolText({ nodeId, name: "VaultFetcher" });
    }

    const repoId = store.registerRepo({ name: "target", rootPath: join(directory, "target") });
    const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
    const snapshot = new GitTopologyStore(store).createBuildingSnapshot({
      snapshotKey: "target-main",
      repoId,
      parserVersion: "p",
      resolverVersion: "r",
      schemaVersion: 18,
    });
    store.db.prepare("UPDATE branches SET current_snapshot_id=?,last_indexed_commit=? WHERE id=?")
      .run(snapshot.id, "target-commit", branchId);
    const targetNodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: "target::VaultFetcher",
      repoId,
      title: "VaultFetcher",
    });
    store.indexSymbolText({ nodeId: targetNodeId, name: "VaultFetcher" });
    store.upsertSymbolVersion({
      nodeId: targetNodeId,
      branchId,
      commitSha: "target-commit",
      filePath: "src/vault-fetcher.ts",
      lang: "typescript",
      kind: "class",
      startLine: 1,
      endLine: 20,
      contentHash: "target-content",
      status: "fresh",
    });

    const response = searchKnowledge({
      query: "VaultFetcher",
      mode: "exact",
      scope: {
        revisions: [{ repoId, snapshotId: snapshot.id }],
        kinds: ["symbol"],
      },
      page: { limit: 1 },
    }, {
      store,
      scopes: [{ repoId, snapshotId: snapshot.id }],
    });

    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.hits.length, 1, JSON.stringify(response, null, 2));
    assert.equal(response.hits[0].nodeId, targetNodeId);
    assert.equal(response.hits[0].kind, "symbol");
    assert.equal(response.hits[0].locator.repoId, repoId);
  } finally {
    store.close();
  }
});

function affectedSymbolFixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-capability-affected-symbol-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "affected-symbol", rootPath: join(directory, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const symbol = (name, filePath) => {
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${filePath}::${name}`, repoId, title: name });
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: "c1", filePath, lang: "ts", kind: "function", startLine: 1, endLine: 2, contentHash: name, status: "fresh" });
    return nodeId;
  };
  const target = symbol("target", "src/shared.ts");
  const sibling = symbol("sibling", "src/shared.ts");
  const targetCaller = symbol("targetCaller", "src/target-caller.ts");
  const siblingCaller = symbol("siblingCaller", "src/sibling-caller.ts");
  const testNode = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::src/target.spec.ts`, repoId, title: "src/target.spec.ts" });
  store.replaceFileEdges({ branchId, filePath: "src/target-caller.ts", edges: [{ src: targetCaller, dst: target, edgeType: "calls", origin: "parser", method: "EXTRACTED", confidence: 1, provenance: { filePath: "src/target-caller.ts", startLine: 1 } }] });
  store.replaceFileEdges({ branchId, filePath: "src/sibling-caller.ts", edges: [{ src: siblingCaller, dst: sibling, edgeType: "calls", origin: "parser", method: "EXTRACTED", confidence: 1, provenance: { filePath: "src/sibling-caller.ts", startLine: 1 } }] });
  store.replaceFileEdges({ branchId, filePath: "src/target.spec.ts", edges: [{ src: testNode, dst: target, edgeType: "tests", origin: "parser", method: "EXTRACTED", confidence: 1, provenance: { filePath: "src/target.spec.ts", startLine: 1 } }] });
  return { store, repoId, branchId, target, sibling, targetCaller, siblingCaller, testNode };
}

test("[affected-symbol-granularity] node-targeted affected preserves symbol granularity within a shared file", () => {
  const fixture = affectedSymbolFixture();
  try {
    const result = affectedByNode(fixture.store, `node:${fixture.target}`, { repoId: fixture.repoId });
    assert.ok(result);
    assert.deepEqual(result.changed.map((item) => item.nodeId), [fixture.target]);
    assert.ok(result.impacted.some((item) => item.nodeId === fixture.targetCaller));
    assert.equal(result.impacted.some((item) => item.nodeId === fixture.sibling || item.nodeId === fixture.siblingCaller), false);
  } finally { fixture.store.close(); }
});

test("[affected-impact-edges] every impacted symbol has evidence-backed impact edges and related tests", () => {
  const fixture = affectedSymbolFixture();
  try {
    const result = affectedByNode(fixture.store, `node:${fixture.target}`, { repoId: fixture.repoId });
    assert.ok(result);
    assert.ok(result.impacted.some((item) => item.nodeId === fixture.targetCaller));
    assert.ok(result.impactEdges?.some((edge) => edge.src === fixture.targetCaller && edge.dst === fixture.target && edge.method === "EXTRACTED" && edge.confidence === 1));
    assert.ok(result.tests.some((item) => item.nodeId === fixture.testNode));
    assert.ok(result.suggestedVerification.length > 0);
  } finally { fixture.store.close(); }
});
