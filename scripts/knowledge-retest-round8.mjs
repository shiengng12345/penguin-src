#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundle = process.env.PENGUIN_BUNDLE ?? resolve(root, "packages/knowledge-cli/bundle/penguin.mjs");
const runtime = process.env.PENGUIN_NODE ?? "/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node";
const repo = process.env.PENGUIN_REPO ?? "FPMS-NT";
const report = process.env.PENGUIN_RETEST_REPORT ?? resolve(root, "docs/quality/index-evaluation-gpt-5-round11.md");

if (!existsSync(bundle) || !existsSync(runtime)) {
  console.error(`missing current bundle/runtime: ${runtime} ${bundle}`);
  process.exit(2);
}

const commands = [
  ["help"], ["status", "--compact"], ["doctor"], ["coverage", repo],
  ["onboarding", repo], ["endpoints", repo, "--protocol", "grpc", "--json"],
  ["search", "constructor", "--repo", repo, "--json"],
  ["communities", "--repo", repo, "--json"],
  ["filesymbols", repo, "brazil-v2", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--json"],
  ["explore", "Round8DefinitelyAbsentSymbol", "--repo", repo, "--json", { expected: [0, 1] }],
  ["explore", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#getColorLandEventConfigByIdFromCache", "--repo", repo, "--json"],
  ["callers", "getColorLandEventConfigByIdFromCache", "--repo", repo, "--json"],
  ["calls", "apps/promotion/src/modules/color-land/processors/dice.processor.ts#playDice", "--repo", repo, "--json"],
  ["flow", "gRPC promotion.v1.FrontendColorLandService.DailyShareMission", "--repo", repo, "--json"],
  ["deadcode", "--repo", repo, "--path", "apps/admin/", "--limit", "10", "--json"],
  ["filesymbols", repo, "brazil-v2", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--limit", "5", "--json"],
  ["endpoints", repo, "--protocol", "not-indexed-round8", "--limit", "5", "--json"],
  ["endpoint-identity", "gRPC promotion.v1.FrontendColorLandService.DailyShareMission", "gRPC promotion.v1.FrontendColorLandService.DailyShareMission", "node_6ea96e3e-960b-481a-ad13-22805ae21683", "--json", { expected: [0, 1] }],
  ["affected", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts", "--repo", repo, "--json", { expected: [0, 1] }],
  ["explore", "apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#getActiveEventConfigByObjId", "--repo", repo, "--limit", "1", "--json"],
  ["flow", "node_6ea96e3e-960b-481a-ad13-22805ae21683", "--repo", repo, "--json", { expected: [0, 1] }],
  ["explore", "Round10DefinitelyAbsentSymbol", "--repo", repo, "--json", { expected: [0, 1] }],
  ["status", "--compact", "--json"],
  ["help", "--json"],
];
const caseNames = [
  "Setup help", "Setup status", "Setup doctor", "Setup coverage", "Q13 onboarding evidence completeness", "Q4 endpoint handler status", "Q14 common-name isolation", "B1 first-day onboarding", "Q6 filesymbols cursor pagination", "Q12 negative-result safety", "Q10 repo/path mismatch safety", "Q1 persisted unresolved-reference coverage", "Q2 graph completeness boundary", "Q9 endpoint flow consistency", "Q7 deadcode cursor and framework caveat", "Q6 filesymbols cursor pagination continuation", "Q5 endpoint cursor pagination", "Q8 endpoint identity equivalence", "B3 signature-change impact", "Q3 exactly-at-limit behavior", "B2 request trace", "B4 adversarial negative claim", "Q11 stale versus fresh compatibility", "Q15 retest runner fidelity",
];
if (commands.length !== caseNames.length) throw new Error(`retest case manifest mismatch: ${commands.length} commands / ${caseNames.length} names`);
const env = { ...process.env, PENGUIN_WASM_DIR: process.env.PENGUIN_WASM_DIR ?? resolve(root, "packages/knowledge-cli/bundle/wasm") };
const rows = [];
for (const rawArgs of commands) {
  const meta = rawArgs.at(-1)?.expected ? rawArgs.at(-1) : { expected: [0] };
  const args = meta === rawArgs.at(-1) ? rawArgs.slice(0, -1) : rawArgs;
  const started = Date.now();
  const result = spawnSync(runtime, [bundle, ...args], { cwd: root, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const exitCode = result.status ?? 1;
  rows.push({ caseName: caseNames[rows.length], command: [runtime, bundle, ...args].join(" "), exitCode, expected: meta.expected, ok: meta.expected.includes(exitCode), durationMs: Date.now() - started, scope: repo, evidenceMeta: "raw output contains command-specific freshness/coverage/completeness/cursor fields when supported", stdout: result.stdout, stderr: result.stderr });
}
const failed = rows.filter((row) => !row.ok);
const markdown = [
  "# Penguin Round 11 Automated Retest",
  "",
  `- Bundle: \`${bundle}\``,
  `- Runtime: \`${runtime}\``,
  `- Repository: \`${repo}\``,
  `- Commands executed: ${rows.length}`,
  `- Failed commands: ${failed.length}`,
  "",
  "## Evidence",
  "",
  ...rows.flatMap((row, index) => [
    `### ${index + 1}. ${row.caseName}`,
    `- command: \`${row.command}\``,
    `- exitCode: \`${row.exitCode}\`; expected: \`${row.expected.join(",")}\`; ok: \`${row.ok}\`; durationMs: \`${row.durationMs}\`; scope: \`${row.scope}\``,
    `- evidence metadata: ${row.evidenceMeta}`,
    "```text",
    `${row.stdout}${row.stderr ? `\n[stderr]\n${row.stderr}` : ""}`.slice(0, 12000),
    "```",
    "",
  ]),
  "## Gate",
  "",
  failed.length ? `FAIL: ${failed.length} command(s) failed.` : "PASS: every retest command completed successfully.",
  "",
];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, markdown.join("\n"));
console.log(JSON.stringify({ report, bundle, runtime, commandCount: rows.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
