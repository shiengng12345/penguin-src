import { existsSync, readFileSync } from "node:fs";

const input = process.argv.find((arg) => arg.startsWith("--input="))?.slice("--input=".length) ?? "docs/knowledge-v2/real-question-corpus.jsonl";
const required = { exact_path: 20, caller_callee_impact: 15, cross_service_protocol: 15, field_data_flow: 10, branch_revision_history: 10, why_domain_onboarding: 10, notes_backlinks_properties: 10, incident_evidence: 10, dead_code_architecture: 5, adversarial: 5 };
const evidence = [];
const questions = [];
if (!existsSync(input)) evidence.push({ code: "REAL_QUESTION_CORPUS_MISSING", message: input });
else {
  for (const [lineNumber, line] of readFileSync(input, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { questions.push({ ...JSON.parse(line), lineNumber: lineNumber + 1 }); }
    catch { evidence.push({ code: "REAL_QUESTION_JSON_INVALID", line: lineNumber + 1 }); }
  }
}
const ids = new Set(); const categoryCounts = {};
for (const question of questions) {
  if (!question.id || ids.has(question.id)) evidence.push({ code: "REAL_QUESTION_ID_INVALID", id: question.id, line: question.lineNumber });
  ids.add(question.id);
  categoryCounts[question.category] = (categoryCounts[question.category] ?? 0) + 1;
  if (!question.question || !question.scope || !question.gold || !Array.isArray(question.gold.requiredLocators) || !Array.isArray(question.gold.requiredFacts)) evidence.push({ code: "REAL_QUESTION_CONTRACT_INVALID", id: question.id });
}
for (const [category, minimum] of Object.entries(required)) if ((categoryCounts[category] ?? 0) < minimum) evidence.push({ code: "REAL_QUESTION_CATEGORY_SHORT", category, minimum, actual: categoryCounts[category] ?? 0 });
const reviewed = questions.filter((question) => question.review?.status === "independently_reviewed" && question.review?.reviewer && question.review?.sourceChecks === true).length;
const baselined = questions.filter((question) => question.baselines && question.baselines.codegraph && question.baselines.graphify).length;
if (reviewed !== questions.length) evidence.push({ code: "REAL_QUESTION_INDEPENDENT_REVIEW_REQUIRED", reviewed, total: questions.length });
if (baselined !== questions.length) evidence.push({ code: "REAL_QUESTION_BASELINES_REQUIRED", baselined, total: questions.length });
const report = { input, questionCount: questions.length, categoryCounts, reviewedCount: reviewed, baselinedCount: baselined, requiredCategories: required, evidence, passed: evidence.length === 0 && questions.length >= 100 };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--gate") && !report.passed) process.exitCode = 1;
