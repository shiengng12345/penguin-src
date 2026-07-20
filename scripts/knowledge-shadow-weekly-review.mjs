import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2] ?? "docs/knowledge-v2/real-question-differential-report.json";
const output = process.argv[3];
const report = JSON.parse(readFileSync(input, "utf8"));
const byCategory = {};
const byOutcome = {};
for (const result of report.results ?? []) {
  const category = result.category ?? "uncategorized";
  byCategory[category] = byCategory[category] ?? { total: 0, reviewed: 0, externalOnlyCorrect: 0, penguinOnlyCorrect: 0, bothWrong: 0, unverifiable: 0 };
  const row = byCategory[category];
  row.total += 1;
  const outcome = result.outcome ?? result.diff ?? (result.goldLocatorCount > 0 ? "both_correct" : "unverifiable");
  row[outcome === "external_only_correct" ? "externalOnlyCorrect" : outcome === "penguin_only_correct" ? "penguinOnlyCorrect" : outcome === "both_wrong" ? "bothWrong" : outcome === "unverifiable" ? "unverifiable" : "reviewed"] += 1;
  byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
}
const outputReport = {
  generatedAt: new Date().toISOString(),
  input,
  questionCount: report.questionCount ?? report.results?.length ?? 0,
  categoryReview: byCategory,
  outcomeCounts: byOutcome,
  honestGaps: report.honestGaps ?? { codegraph: [], graphify: [] },
  blockingExternalOnlyCorrect: Object.values(byCategory).reduce((sum, row) => sum + row.externalOnlyCorrect, 0),
};
if (output) writeFileSync(output, JSON.stringify(outputReport, null, 2) + "\n");
console.log(JSON.stringify(outputReport));
