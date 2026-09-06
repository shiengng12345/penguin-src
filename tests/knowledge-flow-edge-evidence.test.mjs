import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  KnowledgeStore,
  buildFlow,
  graphEdgeEvidence,
  unresolvedGraphEdgeEvidence,
} from "../packages/knowledge-core/dist/index.js";
import { validateGraphEdgeEvidenceEnvelope } from "../packages/knowledge-contracts/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-flow-evidence-"));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "flow-evidence", rootPath: join(dir, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live", headCommit: "c1" });
  const makeNode = (name, file) => {
    const nodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${repoId}::${name}`,
      repoId,
      title: name,
    });
    store.upsertSymbolVersion({
      nodeId,
      branchId,
      commitSha: "c1",
      filePath: file,
      lang: "ts",
      kind: "function",
      contentHash: name,
      status: "fresh",
    });
    store.indexSymbolText({ nodeId, name, signature: "()" });
    return nodeId;
  };
  const entry = makeNode("entry", "src/entry.ts");
  const callee = makeNode("callee", "src/callee.ts");
  const typeOnly = makeNode("TypeOnly", "src/types.ts");
  store.replaceFileEdges({
    branchId,
    filePath: "src/entry.ts",
    edges: [
      {
        src: entry,
        dst: callee,
        edgeType: "calls",
        origin: "parser",
        method: "EXTRACTED",
        confidence: 0.98,
        provenance: { filePath: "src/entry.ts", startLine: 4, evidenceId: "call-1" },
      },
      {
        src: entry,
        dst: typeOnly,
        edgeType: "references",
        origin: "parser",
        method: "INFERRED",
        confidence: 0.42,
        provenance: { filePath: "src/entry.ts", startLine: 2, evidenceId: "ref-1" },
      },
    ],
  });
  return { store, entry, callee, typeOnly };
}

function assertEvidence(value, label) {
  assert.ok(value && typeof value === "object", `${label} must be an object`);
  for (const key of ["evidenceState", "origin", "method", "confidence", "scope", "provenance", "gaps"]) {
    assert.ok(Object.hasOwn(value, key), `${label}.${key} must be present`);
  }
  assert.ok(["proven", "inferred", "candidate", "unresolved"].includes(value.evidenceState));
  assert.ok(["revision", "environment", "unknown"].includes(value.scope));
  assert.ok(Array.isArray(value.gaps));
  return value;
}

test("flow exposes evidence for every hop and separates execution from references", () => {
  const { store, entry } = fixture();
  const flow = buildFlow(store, `node:${entry}`, { limit: 10 });

  assert.ok(Array.isArray(flow.executionSteps));
  assert.ok(Array.isArray(flow.referenceSteps));
  assert.equal(flow.executionSteps[0].via, "root");
  assert.ok(flow.executionSteps.some((step) => step.via === "calls"));
  assert.ok(flow.referenceSteps.some((step) => step.via === "references"));
  assert.ok(!flow.executionSteps.some((step) => step.via === "references"));
  for (const step of flow.steps.slice(1)) assertEvidence(step.graphEvidence, `flow step ${step.nodeId}`);
  assert.equal(flow.steps.find((step) => step.via === "calls").graphEvidence.evidenceState, "proven");
  assert.equal(flow.steps.find((step) => step.via === "references").graphEvidence.evidenceState, "candidate");
  store.close();
});

test("graph evidence contract fails closed when the edge record is absent", () => {
  const evidence = unresolvedGraphEdgeEvidence("edge_record_missing");
  assertEvidence(evidence, "unresolved evidence");
  assert.equal(evidence.evidenceState, "unresolved");
  assert.deepEqual(evidence.gaps, ["edge_record_missing"]);
  assert.equal(graphEdgeEvidence(undefined).evidenceState, "unresolved");
  assert.equal(validateGraphEdgeEvidenceEnvelope(evidence).evidenceState, "unresolved");
  assert.throws(() => validateGraphEdgeEvidenceEnvelope({ ...evidence, scope: "global" }));
});

test("[flow-truncation-continuation] MCP flow pages exhaust without duplicate step identities", () => {
  const { store, entry } = fixture();
  const first = handleKnowledgeTool("knowledge_flow", {
    target: `node:${entry}`,
    repo: "flow-evidence",
    limit: 2,
  }, store);
  assert.equal(first.truncated, true);
  assert.equal(typeof first.cursor, "string", "truncated flow must advertise a usable cursor");

  const second = handleKnowledgeTool("knowledge_flow", {
    target: `node:${entry}`,
    repo: "flow-evidence",
    limit: 2,
    cursor: first.cursor,
  }, store);
  assert.equal(second.truncated, false);
  assert.equal(second.cursor, null);
  const ids = [...first.steps, ...second.steps].map((step) => step.nodeId);
  assert.equal(new Set(ids).size, ids.length, "continued flow pages must not repeat a step");
  assert.equal(ids.length, 3);
  store.close();
});
