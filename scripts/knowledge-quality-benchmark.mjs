#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore, exploreGraph } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

const EXPECTED_CALLS = [
  "src/Widget.tsx:Widget->src/math.ts:calculate",
  "src/math.test.ts:testCalculate->src/math.ts:calculate",
  "src/math.ts:calculate->src/math.ts:double",
  "src/users.controller.ts:getOne->src/math.ts:calculate",
  "src/users-grpc.controller.ts:getUser->src/math.ts:calculate",
];
const EXPECTED_TESTS = ["src/math.test.ts->src/math.ts:calculate"];

// Compare exact golden sets and preserve the mismatches in the report so a
// threshold failure is actionable instead of being a single opaque score.
function score(expectedValues, actualValues) {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  const truePositives = [...actual].filter((value) => expected.has(value)).sort();
  const falsePositives = [...actual].filter((value) => !expected.has(value)).sort();
  const falseNegatives = [...expected].filter((value) => !actual.has(value)).sort();
  const precisionDenominator = truePositives.length + falsePositives.length;
  const recallDenominator = truePositives.length + falseNegatives.length;
  return {
    tp: truePositives.length,
    fp: falsePositives.length,
    fn: falseNegatives.length,
    precision: precisionDenominator === 0 ? 1 : truePositives.length / precisionDenominator,
    recall: recallDenominator === 0 ? 1 : truePositives.length / recallDenominator,
    falsePositives,
    falseNegatives,
    expected: [...expected].sort(),
    actual: [...actual].sort(),
  };
}

function callLabels(store, repoId) {
  return (store.db.prepare(
    `SELECT DISTINCT svs.file_path AS srcFile, s.title AS srcTitle,
                     svd.file_path AS dstFile, d.title AS dstTitle
       FROM edges e
       JOIN nodes s ON s.id=e.src
       JOIN nodes d ON d.id=e.dst
       JOIN symbol_versions svs ON svs.node_id=s.id AND svs.branch_id=e.branch_id
       JOIN symbol_versions svd ON svd.node_id=d.id AND svd.branch_id=e.branch_id
      WHERE e.edge_type='calls' AND e.status='active'
        AND s.repo_id=? AND d.repo_id=?`,
  ).all(repoId, repoId)).map(
    (row) => `${row.srcFile}:${row.srcTitle}->${row.dstFile}:${row.dstTitle}`,
  ).sort();
}

function testLabels(store, repoId) {
  return (store.db.prepare(
    `SELECT DISTINCT f.title AS testFile, sv.file_path AS dstFile, d.title AS dstTitle
       FROM edges e
       JOIN nodes f ON f.id=e.src
       JOIN nodes d ON d.id=e.dst
       JOIN symbol_versions sv ON sv.node_id=d.id AND sv.branch_id=e.branch_id
      WHERE e.edge_type='tests' AND e.status='active' AND f.repo_id=?`,
  ).all(repoId)).map(
    (row) => `${row.testFile}->${row.dstFile}:${row.dstTitle}`,
  ).sort();
}

function handleLabels(store, repoId) {
  return (store.db.prepare(
    `SELECT DISTINCT ep.identity_key AS endpoint, sv.file_path AS handlerFile, h.title AS handlerTitle
       FROM edges e
       JOIN nodes ep ON ep.id=e.src
       JOIN nodes h ON h.id=e.dst
       JOIN symbol_versions sv ON sv.node_id=h.id AND sv.status='fresh'
      WHERE e.edge_type='handles' AND e.status='active' AND h.repo_id=?`,
  ).all(repoId)).map(
    (row) => {
      const endpoint = row.endpoint.startsWith(`${repoId}::`)
        ? `<repo>${row.endpoint.slice(repoId.length)}`
        : row.endpoint;
      return `${endpoint}->${row.handlerFile}:${row.handlerTitle}`;
    },
  ).sort();
}

// Index a disposable copy of the fixture, evaluate graph accuracy, then run
// branch/rename/delete lifecycle checks against the same isolated database.
export async function runKnowledgeQualityBenchmark() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixture = resolve(scriptDir, "../tests/fixtures/knowledge-quality");
  const root = mkdtempSync(join(tmpdir(), "penguin-quality-fixture-"));
  const dbDir = mkdtempSync(join(tmpdir(), "penguin-quality-db-"));
  cpSync(fixture, root, { recursive: true });
  const store = KnowledgeStore.open({
    dbPath: join(dbDir, "knowledge.db"),
    ledgerPath: join(dbDir, "ledger.jsonl"),
  });

  try {
    await indexRepo({ store, rootPath: root, mode: "incremental" });
    const report = await indexRepo({ store, rootPath: root, mode: "rebuild" });
    const expectedHandles = [
      "<repo>::endpoint::GET /users/:id->src/users.controller.ts:getOne",
      "grpc::UsersService.getuser->src/users-grpc.controller.ts:getUser",
    ];
    const metrics = {
      calls: score(EXPECTED_CALLS, callLabels(store, report.repoId)),
      tests: score(EXPECTED_TESTS, testLabels(store, report.repoId)),
      routesAndGrpc: score(expectedHandles, handleLabels(store, report.repoId)),
    };

    const calculate = store.db.prepare(
      "SELECT id FROM nodes WHERE repo_id=? AND node_type='symbol' AND title='calculate' LIMIT 1",
    ).get(report.repoId);
    const snapshotBranch = store.registerBranch({
      repoId: report.repoId,
      name: "snapshot-only",
      status: "snapshot",
    });
    const snapshotCaller = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${report.repoId}::snapshotOnlyCaller`,
      title: "snapshotOnlyCaller",
      repoId: report.repoId,
    });
    store.upsertSymbolVersion({
      nodeId: snapshotCaller,
      branchId: snapshotBranch,
      commitSha: "snapshot",
      filePath: "snapshot.ts",
      lang: "ts",
      kind: "function",
      contentHash: "snapshot",
      status: "fresh",
    });
    store.replaceFileEdges({
      branchId: snapshotBranch,
      filePath: "snapshot.ts",
      edges: [{
        src: snapshotCaller,
        dst: calculate.id,
        edgeType: "calls",
        origin: "parser",
        method: "EXTRACTED",
      }],
    });
    const defaultCallers = exploreGraph(store, "who_calls", calculate.id, {}).nodes;
    const branchIsolation = !defaultCallers.some((node) => node.nodeId === snapshotCaller);

    const renamePath = join(root, "src/rename.ts");
    const renamedSource = readFileSync(renamePath, "utf8")
      .replace("oldName", "newName");
    writeFileSync(renamePath, renamedSource);
    await indexRepo({ store, rootPath: root, mode: "incremental" });
    const renameAlias = (store.db.prepare(
      "SELECT COUNT(*) AS count FROM node_aliases WHERE reason='rename'",
    ).get()).count > 0;

    unlinkSync(join(root, "src/Widget.tsx"));
    await indexRepo({ store, rootPath: root, mode: "incremental" });
    const widget = store.db.prepare(
      `SELECT sv.status AS status FROM nodes n
       JOIN symbol_versions sv ON sv.node_id=n.id
       WHERE n.repo_id=? AND n.title='Widget' LIMIT 1`,
    ).get(report.repoId);
    const deleteStale = widget?.status === "stale";
    const checks = { branchIsolation, renameAlias, deleteStale };
    const metricPass = Object.values(metrics).every(
      (metric) => metric.precision >= 0.95 && metric.recall >= 0.90,
    );
    const passed = metricPass && Object.values(checks).every(Boolean);
    return {
      benchmarkVersion: 1,
      fixture: "knowledge-quality",
      metrics,
      checks,
      coverageGaps: ["runtime_dynamic_dispatch_not_in_static_fixture"],
      passed,
    };
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runKnowledgeQualityBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedDirectly) {
  await main();
}
