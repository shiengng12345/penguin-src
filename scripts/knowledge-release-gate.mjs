import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const internalRound17 = argv.includes("--internal-round17");
const describeOnly = argv.includes("--describe");
const mode = internalRound17 ? "internal-round17" : "public-release";
const parsedTimeout = Number(process.env.PENGUIN_RELEASE_GATE_COMMAND_TIMEOUT_MS);
const commandTimeoutMs = Number.isFinite(parsedTimeout)
  ? Math.max(250, Math.min(parsedTimeout, 600_000))
  : 180_000;

const commands = [
  ["typecheck", "pnpm", ["run", "typecheck"]],
  ["surface-parity", process.execPath, ["scripts/knowledge-surface-parity.mjs", "--gate"]],
  ["package-smoke", process.execPath, ["scripts/knowledge-package-install-smoke.mjs"]],
  ["runtime-upgrade", process.execPath, ["scripts/knowledge-install-upgrade-test.mjs"]],
  ["runtime-bundle", process.execPath, ["--test", "tests/mcp-generation-watch.test.mjs", "tests/mcp-release-bundle.test.mjs", "tests/knowledge-runtime-doctor.test.mjs"]],
  ...(!internalRound17 && process.env.TAURI_SIGNING_PRIVATE_KEY
    ? [["signed-tauri-build", process.execPath, ["scripts/knowledge-signed-release-build.mjs"]]]
    : []),
  ["tauri-clean-install", process.execPath, ["scripts/knowledge-release-bundle-gate.mjs"]],
];

const publicRequirements = [
  { code: "UNIVERSAL_CORPUS_REQUIRED", message: "set PENGUIN_BENCHMARK_ROOT to a frozen admitted corpus before release" },
  { code: "REAL_QUESTION_REPORT_REQUIRED", message: "provide an independently reviewed 100+ question differential report before release" },
  { code: "RC_ID_REQUIRED", message: "set an independent RC identifier before release" },
  { code: "TAURI_SIGNING_KEY_REQUIRED", message: "inject TAURI_SIGNING_PRIVATE_KEY only in the release environment before signed pnpm tauri build" },
];
const blockingRequirements = [];
const deferredRequirements = internalRound17 ? publicRequirements : [];

if (!internalRound17) {
  if (process.env.PENGUIN_BENCHMARK_ROOT) {
    commands.push(["universal-benchmark", process.execPath, ["scripts/knowledge-universal-retrieval-benchmark.mjs", `--root=${process.env.PENGUIN_BENCHMARK_ROOT}`, "--limit=10000", "--gate", "--performance-gate"]]);
  } else blockingRequirements.push(publicRequirements[0]);

  if (process.env.PENGUIN_REAL_QUESTION_REPORT) {
    commands.push(["real-question-audit", process.execPath, ["scripts/knowledge-real-question-audit.mjs", `--input=${process.env.PENGUIN_REAL_QUESTION_REPORT}`, "--gate"]]);
    const penguinReport = process.env.PENGUIN_PENGUIN_REPORT;
    commands.push(["competitor-differential", process.execPath, ["scripts/knowledge-competitor-differential.mjs", "--gate", ...(penguinReport ? [`--penguin-report=${penguinReport}`] : [])]]);
  } else blockingRequirements.push(publicRequirements[1]);

  if (!process.env.PENGUIN_RC_ID) blockingRequirements.push(publicRequirements[2]);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) blockingRequirements.push(publicRequirements[3]);
}

if (describeOnly) {
  console.log(JSON.stringify({
    mode,
    commands: commands.map(([name, command, args]) => ({ name, command: [command, ...args].join(" ") })),
    blockingRequirements,
    deferredRequirements,
  }));
} else {
  const results = [];
  for (const [name, command, args] of commands) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: "pipe",
      timeout: commandTimeoutMs,
      killSignal: "SIGKILL",
    });
    const timedOut = result.error?.code === "ETIMEDOUT";
    const launchFailed = Boolean(result.error) && !timedOut;
    results.push({
      name,
      command: [command, ...args].join(" "),
      exitCode: timedOut ? 124 : result.status ?? 1,
      timedOut,
      error: timedOut
        ? { code: "PROCESS_TIMEOUT", message: `${name} exceeded ${commandTimeoutMs}ms`, retryable: true }
        : launchFailed
          ? { code: "PROCESS_LAUNCH_FAILED", message: String(result.error?.message ?? result.error), retryable: true }
          : null,
      outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n"),
    });
    if (timedOut || launchFailed || result.status !== 0) break;
  }
  const report = {
    mode,
    passed: blockingRequirements.length === 0 && results.length === commands.length && results.every((result) => result.exitCode === 0),
    evidence: blockingRequirements,
    deferredRequirements,
    results,
  };
  const outputPath = process.env.PENGUIN_RELEASE_GATE_OUT;
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
