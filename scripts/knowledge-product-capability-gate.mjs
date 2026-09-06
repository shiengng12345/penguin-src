import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = JSON.parse(readFileSync(join(root, "tests/fixtures/knowledge-product-capability/expected-gates.json"), "utf8"));
const testFiles = [
  join(root, "tests/knowledge-product-capability-closure.test.mjs"),
  join(root, "tests/knowledge-endpoint-performance.test.mjs"),
  join(root, "tests/knowledge-search-engine.test.mjs"),
  join(root, "tests/knowledge-explore-scope-regressions.test.mjs"),
  join(root, "tests/knowledge-why-memory-ontology.test.mjs"),
  join(root, "tests/knowledge-readonly-preflight.test.mjs"),
  join(root, "tests/knowledge-endpoint-publication-parity.test.mjs"),
  join(root, "tests/knowledge-pagination-contract.test.mjs"),
  join(root, "tests/knowledge-context-truncation.test.mjs"),
  join(root, "tests/knowledge-flow-edge-evidence.test.mjs"),
  join(root, "tests/knowledge-corpus-reconciliation.test.mjs"),
  join(root, "tests/knowledge-unresolved-classification.test.mjs"),
];
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...testFiles], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const observed = new Map();
const lines = output.split(/\r?\n/u);
for (let index = 0; index < lines.length; index += 1) {
  const match = lines[index].match(/^\s*(not )?ok\s+\d+\s+-\s+\[([^\]]+)\]/u);
  if (!match) continue;
  let durationMs = null;
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
    const duration = lines[cursor].match(/^\s*duration_ms:\s*([0-9.]+)/u);
    if (duration) {
      durationMs = Number(duration[1]);
      break;
    }
  }
  observed.set(match[2], {
    passed: !match[1],
    durationMs,
    evidence: match[1] ? lines.slice(index, Math.min(lines.length, index + 12)).join("\n") : null,
  });
}

const gates = expected.gates.map((id) => {
  const result = observed.get(id);
  return {
    id,
    passed: result?.passed === true,
    latencyMs: {
      p50: result?.durationMs ?? null,
      p95: result?.durationMs ?? null,
      p99: result?.durationMs ?? null,
    },
    evidence: result?.evidence ?? (result ? null : "MISSING_FROZEN_REPRODUCTION"),
  };
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: expected.source,
  passed: gates.every((gate) => gate.passed),
  passedGates: gates.filter((gate) => gate.passed).length,
  totalGates: gates.length,
  gates,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
