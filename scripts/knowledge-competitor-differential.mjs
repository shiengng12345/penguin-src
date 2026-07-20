import { existsSync, readFileSync, writeFileSync } from "node:fs";
const corpus = "docs/knowledge-v2/real-question-corpus.jsonl";
const penguinReportPath = process.argv.find((arg) => arg.startsWith("--penguin-report="))?.slice("--penguin-report=".length);
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
let penguin;
const superiorityEvidence = [];
if (penguinReportPath && existsSync(penguinReportPath)) {
  const raw = JSON.parse(readFileSync(penguinReportPath, "utf8"));
  const byId = new Map((raw.results ?? []).map((item) => [item.id, item]));
  const missing = questions.filter((question) => {
    const item = byId.get(question.id)?.penguin;
    return !item || typeof item.correctness !== "number" || typeof item.provenance !== "number";
  }).map((question) => question.id);
  const correctness = questions.map((question) => byId.get(question.id)?.penguin?.correctness ?? -1);
  const provenance = questions.map((question) => byId.get(question.id)?.penguin?.provenance ?? -1);
  penguin = { report: penguinReportPath, missingQualityScores: missing, minCorrectness: Math.min(...correctness), minProvenance: Math.min(...provenance), universalExact: raw.strengths?.universalExact === true, surfaceParity: raw.strengths?.surfaceParity === true, revisionDiagnostics: raw.strengths?.revisionDiagnostics === true };
  if (missing.length === 0 && penguin.minCorrectness >= 1 && penguin.minProvenance >= 1 && penguin.universalExact && penguin.surfaceParity && penguin.revisionDiagnostics) superiorityEvidence.push("penguin quality/provenance and independent strengths meet the explicit gate");
} else {
  penguin = { report: penguinReportPath ?? null, missingQualityScores: questions.map((question) => question.id), minCorrectness: -1, minProvenance: -1, universalExact: false, surfaceParity: false, revisionDiagnostics: false };
}
const report = { generatedAt: new Date().toISOString(), baselineVersions: { codegraph: questions[0]?.baselines?.codegraph?.version ?? "missing", graphify: questions[0]?.baselines?.graphify?.version ?? "missing" }, questionCount: questions.length, captured: { codegraph: count("codegraph"), graphify: count("graphify") }, honestGaps: { codegraph: results.filter((result) => result.codegraph.status !== "captured").map((result) => result.id), graphify: results.filter((result) => result.graphify.status !== "captured").map((result) => result.id) }, penguin, superiorityEvidence, results };
const output = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--gate") && (questions.length < 100 || report.honestGaps.codegraph.length > 0 || report.honestGaps.graphify.length > 0 || report.superiorityEvidence.length === 0)) process.exitCode = 1;
