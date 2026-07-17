import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const checks = ["packages/knowledge-cli/dist/bin.js", "packages/mcp/dist/index.js", "packages/knowledge-core/dist/index.js"];
const results = checks.map((path) => ({ path, exists: existsSync(path) }));
const parity = spawnSync(process.execPath, ["scripts/knowledge-surface-parity.mjs", "--gate"], { encoding: "utf8" });
const report = { results, parityExitCode: parity.status ?? 1, parity: `${parity.stdout ?? ""}${parity.stderr ?? ""}`.trim() };
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => !result.exists) || parity.status !== 0) process.exitCode = 1;
