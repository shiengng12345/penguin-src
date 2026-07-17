import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const roots = (process.argv.find((arg) => arg.startsWith("--roots="))?.slice(8) ?? process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? "tests/fixtures/knowledge-universal-retrieval")
  .split(",").map((root) => resolve(root.trim())).filter(Boolean);
const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 1000);
const minNeedles = Number(process.argv.find((arg) => arg.startsWith("--min-needles="))?.slice(14) ?? limit);
const canaries = [];
for (const root of roots) {
  const result = spawnSync(process.execPath, ["scripts/knowledge-universal-retrieval-benchmark.mjs", `--root=${root}`, `--limit=${limit}`, "--performance-gate"], { encoding: "utf8" });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* preserve the raw failure below */ }
  const passed = result.status === 0 && existsSync(root) && report?.needleCount >= minNeedles && report?.exactRecall === 1 && report?.pathRecall === 1 && report?.locatorAccuracy === 1 && report?.unexpectedVerifiedHits === 0;
  canaries.push({ root, passed, exitCode: result.status ?? 1, ...(report ? { report } : {}), ...(passed ? {} : { outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n") }) });
  if (!passed) break;
}
const output = { generatedAt: new Date().toISOString(), limit, minNeedles, canaryCount: canaries.length, passed: canaries.length === roots.length && canaries.every((item) => item.passed), canaries };
const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
if (out) writeFileSync(resolve(out), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
if (!output.passed) process.exitCode = 1;
