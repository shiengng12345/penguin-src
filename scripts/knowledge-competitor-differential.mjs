import { existsSync, readFileSync, writeFileSync } from "node:fs";
const corpus = "docs/knowledge-v2/real-question-corpus.jsonl";
const questions = existsSync(corpus) ? readFileSync(corpus, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const results = questions.map((question) => ({
  id: question.id,
  category: question.category,
  codegraph: question.baselines?.codegraph ?? { status: "honest_gap", note: "missing baseline" },
  graphify: question.baselines?.graphify ?? { status: "honest_gap", note: "missing baseline" },
  goldLocatorCount: question.gold?.requiredLocators?.length ?? 0,
  goldFactCount: question.gold?.requiredFacts?.length ?? 0,
}));
const count = (tool) => results.filter((result) => result[tool]?.status === "captured").length;
const report = { generatedAt: new Date().toISOString(), baselineVersions: { codegraph: questions[0]?.baselines?.codegraph?.version ?? "missing", graphify: questions[0]?.baselines?.graphify?.version ?? "missing" }, questionCount: questions.length, captured: { codegraph: count("codegraph"), graphify: count("graphify") }, honestGaps: { codegraph: results.filter((result) => result.codegraph.status !== "captured").map((result) => result.id), graphify: results.filter((result) => result.graphify.status !== "captured").map((result) => result.id) }, results };
const output = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--gate") && (questions.length < 100 || report.honestGaps.codegraph.length > 0 || report.honestGaps.graphify.length > 0)) process.exitCode = 1;
