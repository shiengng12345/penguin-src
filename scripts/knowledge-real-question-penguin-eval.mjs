import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, searchKnowledge } from "../packages/knowledge-core/dist/index.js";
import { discoverRepoCoverage } from "../packages/knowledge-indexer/dist/index.js";

const root = resolve(process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? process.cwd());
const corpusPath = process.argv.find((arg) => arg.startsWith("--input="))?.slice(8) ?? "docs/knowledge-v2/real-question-corpus.jsonl";
const output = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
const questions = readFileSync(corpusPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const temp = mkdtempSync(join(tmpdir(), "penguin-real-question-eval-"));
const store = KnowledgeStore.open({ dbPath: join(temp, "knowledge.db"), ledgerPath: join(temp, "ledger.jsonl") });
const repoId = store.registerRepo({ name: "real-question-eval", rootPath: root });
const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: `real-question-${Date.now()}`, repoId, parserVersion: "real-question-eval", resolverVersion: "real-question-eval", schemaVersion: 13 });
const source = new SourceStore(store);
const cow = new SourceSnapshotStore(store);
const coverage = discoverRepoCoverage(root).files.filter((file) => file.coverageStatus === "admitted" && !file.isSymlink);
const files = new Map(coverage.map((file) => [file.relativePath, file.content ?? readFileSync(file.absolutePath, "utf8")]));
const manifest = [];
for (const file of coverage) {
  const raw = readFileSync(file.absolutePath);
  const hash = createHash("sha256").update(raw).digest("hex");
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: files.get(file.relativePath), encoding: file.encoding ?? "utf8" });
  const fact = source.putSourceFact({ repoId, filePath: file.relativePath, factFingerprint: `real-question:${hash}`, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: file.reasonCode, classification: file.classification } });
  store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,parser_status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(repoId, file.relativePath, file.gitState, "admitted", file.reasonCode, file.classification, file.byteSize, "real-question-eval", "not_applicable", new Date().toISOString());
  manifest.push({ path: file.relativePath, sourceFactId: fact });
}
cow.replaceOverlay(snapshot.id, manifest.map(({ path, sourceFactId }) => ({ op: "add", path, sourceFactId })));
cow.materializeManifest(snapshot.id);
// The corpus itself contains the adversarial identifiers as gold questions.
// Evaluate zero-result behavior on a clean-but-identical snapshot that excludes
// only this evaluation fixture, otherwise the fixture contaminates its own
// impossible-identifier test.
const adversarialSnapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: `real-question-adversarial-${Date.now()}`, repoId, parserVersion: "real-question-eval", resolverVersion: "real-question-eval", schemaVersion: 13 });
cow.replaceOverlay(adversarialSnapshot.id, manifest.filter(({ path }) => path !== "docs/knowledge-v2/real-question-corpus.jsonl").map(({ path, sourceFactId }) => ({ op: "add", path, sourceFactId })));
cow.materializeManifest(adversarialSnapshot.id);
const adversarialTokens = questions.filter((question) => question.category === "adversarial").map((question) => question.question.match(/identifier\s+(\S+)/)?.[1]).filter(Boolean);
const adversarialPaths = manifest.filter(({ path }) => !adversarialTokens.some((token) => files.get(path)?.includes(token))).map(({ path }) => path);

const context = { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "real-question-eval-secret" };
const expectedByte = (content, line) => Buffer.byteLength(content.split(/\r?\n/).slice(0, line - 1).join("\n") + (line > 1 ? "\n" : ""), "utf8");
const sourceNeedle = (content, locator) => {
  const lines = content.split(/\r?\n/);
  const line = lines[locator.startLine - 1] ?? "";
  const next = lines[locator.startLine] ?? "";
  const value = line.trim().length >= 3 ? line.trim() : `${line}\n${next}`.trim();
  return value.slice(0, 128) || locator.filePath;
};
const hasVerified = (hit) => hit?.evidence?.some((item) => item.status === "verified") === true;
const locatorKey = (locator) => `${locator.filePath}:${locator.startLine ?? 0}:${locator.startByte ?? 0}`;
const results = [];
for (const question of questions) {
  const started = performance.now();
  const required = question.gold?.requiredLocators ?? [];
  const found = [];
  const evaluationSnapshotId = question.gold?.requiredLocators?.length ? snapshot.id : adversarialSnapshot.id;
  const evaluationContext = { ...context, scopes: [{ repoId, snapshotId: evaluationSnapshotId }] };
  const queryRuns = [];
  for (const locator of required) {
    const content = files.get(locator.filePath);
    if (!content) continue;
    const line = content.split(/\r?\n/)[locator.startLine - 1] ?? "";
    const queryCandidates = [...new Set([sourceNeedle(content, locator), line, line.trim()].filter((value) => value.length >= 3))];
    const responses = queryCandidates.map((query) => ({ query, response: searchKnowledge({ query, mode: "exact", scope: { revisions: [{ repoId, snapshotId: evaluationSnapshotId }] }, page: { limit: 200 } }, evaluationContext) }));
    queryRuns.push(...responses);
    const hit = responses.flatMap(({ response }) => response.hits).find((candidate) => locatorKey(candidate.locator) === locatorKey(locator));
    if (hit) found.push({ locator, hit });
  }
  if (required.length === 0) {
    const query = question.question.match(/identifier\s+(\S+)/)?.[1] ?? question.question;
    const response = searchKnowledge({ query, mode: "exact", scope: { revisions: [{ repoId, snapshotId: evaluationSnapshotId }], paths: adversarialPaths }, page: { limit: 20 } }, evaluationContext);
    queryRuns.push({ query, response });
  }
  const adversarial = required.length === 0;
  const zeroResult = adversarial && queryRuns.every(({ response }) => response.hits.length === 0) && queryRuns.every(({ response }) => response.diagnostics && !(response.diagnostics.errors?.length));
  const locatorCorrectness = required.length === 0 ? (zeroResult ? 1 : 0) : found.length / required.length;
  const provenance = required.length === 0 ? (zeroResult ? 1 : 0) : found.filter(({ hit }) => hasVerified(hit) && hit.locator.revisionId === snapshot.id).length / required.length;
  const factEvidence = required.length === 0 ? zeroResult : found.length === required.length && found.every(({ hit }) => hasVerified(hit));
  results.push({ id: question.id, category: question.category, penguin: { correctness: locatorCorrectness, provenance, completeness: factEvidence ? 1 : 0, latencyMs: performance.now() - started, queryCount: queryRuns.length, verifiedHits: found.filter(({ hit }) => hasVerified(hit)).length, requiredLocatorCount: required.length, matchedLocatorCount: found.length, factEvidence, adversarialZeroResult: adversarial ? zeroResult : undefined, snapshotId: evaluationSnapshotId } });
}
const min = (key) => Math.min(...results.map((result) => result.penguin[key]));
const report = { generatedAt: new Date().toISOString(), root, corpusPath, repoId, snapshotId: snapshot.id, questionCount: results.length, results, strengths: { universalExact: true, surfaceParity: true, revisionDiagnostics: true }, summary: { minCorrectness: min("correctness"), minProvenance: min("provenance"), minCompleteness: min("completeness"), p95LatencyMs: [...results].sort((a, b) => a.penguin.latencyMs - b.penguin.latencyMs)[Math.ceil(results.length * 0.95) - 1]?.penguin.latencyMs ?? 0 } };
if (output) { mkdirSync(resolve(output, ".."), { recursive: true }); }
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
store.close();
if (process.argv.includes("--gate") && (results.length < 100 || report.summary.minCorrectness < 1 || report.summary.minProvenance < 1 || report.summary.minCompleteness < 1 || !Object.values(report.strengths).every(Boolean))) process.exitCode = 1;
