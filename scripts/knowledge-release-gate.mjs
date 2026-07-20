import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const commands = [
  ["typecheck", "pnpm", ["run", "typecheck"]],
  ["surface-parity", process.execPath, ["scripts/knowledge-surface-parity.mjs", "--gate"]],
  ["package-smoke", process.execPath, ["scripts/knowledge-package-install-smoke.mjs"]],
];
const evidence = [];
if (process.env.PENGUIN_BENCHMARK_ROOT) commands.push(["universal-benchmark", process.execPath, ["scripts/knowledge-universal-retrieval-benchmark.mjs", `--root=${process.env.PENGUIN_BENCHMARK_ROOT}`, "--limit=10000", "--gate", "--performance-gate"]]);
else evidence.push({ code: "UNIVERSAL_CORPUS_REQUIRED", message: "set PENGUIN_BENCHMARK_ROOT to a frozen admitted corpus before release" });
if (process.env.PENGUIN_REAL_QUESTION_REPORT) {
  commands.push(["real-question-audit", process.execPath, ["scripts/knowledge-real-question-audit.mjs", `--input=${process.env.PENGUIN_REAL_QUESTION_REPORT}`, "--gate"]]);
  const penguinReport = process.env.PENGUIN_PENGUIN_REPORT;
  commands.push(["competitor-differential", process.execPath, ["scripts/knowledge-competitor-differential.mjs", "--gate", ...(penguinReport ? [`--penguin-report=${penguinReport}`] : [])]]);
}
else evidence.push({ code: "REAL_QUESTION_REPORT_REQUIRED", message: "provide an independently reviewed 100+ question differential report before release" });
if (!process.env.PENGUIN_RC_ID) evidence.push({ code: "RC_ID_REQUIRED", message: "set an independent RC identifier before release" });
const results = [];
for (const [name, command, args] of commands) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  results.push({ name, command: [command, ...args].join(" "), exitCode: result.status ?? 1, outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n") });
  if (result.status !== 0) break;
}
const report = { passed: evidence.length === 0 && results.length === commands.length && results.every((result) => result.exitCode === 0), evidence, results };
const outputPath = process.env.PENGUIN_RELEASE_GATE_OUT;
if (outputPath) writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
