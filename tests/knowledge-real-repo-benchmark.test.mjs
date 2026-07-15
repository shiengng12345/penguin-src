import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasOrderedNodeIds,
  parseMcpGraphResult,
  scoreShadowParity,
  scoreRelationTitles,
  summarizeClaudeDebugCases,
  summarizeTestMappings,
  summarizeShadowCases,
} from "../scripts/knowledge-real-repo-benchmark.mjs";

test("golden flow scoring requires node ids in execution order", () => {
  const steps = [{ nodeId: "client" }, { nodeId: "noise" }, { nodeId: "endpoint" }, { nodeId: "handler" }];
  assert.equal(hasOrderedNodeIds(steps, ["client", "endpoint", "handler"]), true);
  assert.equal(hasOrderedNodeIds(steps, ["handler", "endpoint"]), false);
  assert.equal(hasOrderedNodeIds(steps, ["client", "missing"]), false);
});

test("Claude debug gate requires every GREEN case and CLI/MCP parity", () => {
  const summary = summarizeClaudeDebugCases([
    { id: "update-account-status-caller", passed: true, parity: true },
    { id: "auth-risk-close-account-flow", passed: true, parity: true },
    { id: "frontend-rg-handler", passed: true, parity: true },
    { id: "close-account-search-quality", passed: true, parity: true },
    { id: "log-literal-to-enclosing-method", passed: true, parity: true },
  ]);
  assert.deepEqual(summary, {
    expected: 5,
    passedCases: 5,
    parityFailures: 0,
    passed: true,
  });
  assert.equal(summary.futureAcceptance, undefined, "future RED cases are not scored");
});

test("real-repo benchmark scores duplicate relation titles as a multiset", () => {
  const score = scoreRelationTitles(["call", "call", "other"], ["call", "extra"]);
  assert.equal(score.tp, 1);
  assert.equal(score.fp, 1);
  assert.equal(score.fn, 2);
  assert.equal(score.precision, 0.5);
  assert.equal(score.recall, 1 / 3);
});

test("real-repo benchmark parses the structured graph inside MCP text content", () => {
  const parsed = parseMcpGraphResult({
    healthy: true,
    isError: false,
    content: [{
      type: "text",
      text: JSON.stringify({ mode: "calls_of", nodes: [{ title: "callee" }] }),
    }],
  });
  assert.deepEqual(parsed, { mode: "calls_of", nodes: [{ title: "callee" }] });
});

test("shadow parity compares stable relation identities, independent of output order", () => {
  const cli = { nodes: [
    { nodeId: "b", title: "second", nodeType: "symbol" },
    { nodeId: "a", title: "first", nodeType: "symbol" },
  ] };
  const mcp = { nodes: [...cli.nodes].reverse() };
  assert.deepEqual(scoreShadowParity(cli, mcp), {
    parity: true,
    cliCount: 2,
    mcpCount: 2,
    materialMiss: false,
  });
  assert.equal(scoreShadowParity({ nodes: [] }, { nodes: [] }).materialMiss, true);
});

test("100-query shadow gate requires the full corpus and zero material misses", () => {
  const passing = Array.from({ length: 100 }, (_, index) => ({ id: `q${index}`, parity: true, materialMiss: false }));
  assert.deepEqual(summarizeShadowCases(passing), {
    queries: 100,
    parityFailures: 0,
    materialMisses: 0,
    passed: true,
  });
  assert.equal(summarizeShadowCases(passing.slice(0, 99)).passed, false);
  assert.equal(summarizeShadowCases([...passing.slice(0, 99), { id: "bad", parity: false, materialMiss: true }]).passed, false);
});

test("test-mapping gate scores recall separately and requires CLI/MCP parity", () => {
  const nineOfTen = Array.from({ length: 10 }, (_, index) => ({
    found: index < 9,
    parity: true,
  }));
  assert.deepEqual(summarizeTestMappings(nineOfTen), {
    expected: 10,
    found: 9,
    recall: 0.9,
    parityFailures: 0,
    passed: true,
  });
  assert.equal(summarizeTestMappings(nineOfTen.map((item, index) => index === 0 ? { ...item, parity: false } : item)).passed, false);
  assert.equal(summarizeTestMappings(nineOfTen.map((item, index) => index === 8 ? { ...item, found: false } : item)).passed, false);
});
