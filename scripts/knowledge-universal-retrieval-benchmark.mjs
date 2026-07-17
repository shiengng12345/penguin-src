import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, searchKnowledge } from "../packages/knowledge-core/dist/index.js";
import { discoverRepoCoverage } from "../packages/knowledge-indexer/dist/index.js";

const root = resolve(process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? "tests/fixtures/knowledge-universal-retrieval");
const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 10000);
const exactLimit = Math.max(1, Math.floor(limit * 0.9));
const temp = mkdtempSync(join(tmpdir(), "penguin-universal-benchmark-"));
const store = KnowledgeStore.open({ dbPath: join(temp, "knowledge.db"), ledgerPath: join(temp, "ledger.jsonl") });
const repoId = store.registerRepo({ name: "benchmark", rootPath: root });
const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: `benchmark-${Date.now()}`, repoId, parserVersion: "benchmark", resolverVersion: "benchmark", schemaVersion: 13 });
const source = new SourceStore(store);
const cow = new SourceSnapshotStore(store);
const indexStarted = performance.now();
const admitted = discoverRepoCoverage(root).files.filter((file) => file.coverageStatus === "admitted" && !file.isSymlink);
const manifest = [];
for (const file of admitted) {
  const raw = readFileSync(file.absolutePath);
  const hash = createHash("sha256").update(raw).digest("hex");
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: file.content ?? raw.toString("utf8"), encoding: file.encoding ?? "utf8" });
  const fact = source.putSourceFact({ repoId, filePath: file.relativePath, factFingerprint: `benchmark:${hash}`, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: file.reasonCode, classification: file.classification } });
  store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,parser_status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(repoId, file.relativePath, file.gitState, "admitted", file.reasonCode, file.classification, file.byteSize, "benchmark", "not_applicable", new Date().toISOString());
  manifest.push({ path: file.relativePath, fact });
}
cow.replaceOverlay(snapshot.id, manifest.map(({ path, fact }) => ({ op: "add", path, sourceFactId: fact })));
cow.materializeManifest(snapshot.id);
const indexMs = performance.now() - indexStarted;
const sourceBytes = admitted.reduce((sum, file) => sum + file.byteSize, 0);

const corpus = new Map(admitted.map((file) => [file.relativePath, file.content ?? readFileSync(file.absolutePath, "utf8")]));
const needles = [];
const candidates = [];
for (const [filePath, content] of corpus) for (const [index, line] of content.split(/\r?\n/).entries()) {
  const trimmed = line.trim();
  if ([...trimmed].length < 3) continue;
  const codePoints = [...trimmed];
  const query = codePoints.length < 8 ? trimmed : codePoints.slice(0, Math.min(64, codePoints.length)).join("");
  candidates.push({ filePath, query, line: index + 1, seed: createHash("sha256").update(`${filePath}:${index + 1}:${query}`).digest("hex"), lengthBucket: codePoints.length < 8 ? "short" : "8-64" });
}
const prefixCounts = new Map();
for (const candidate of candidates) { const prefix = [...candidate.query].slice(0, 16).join(""); prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1); }
const orderedCandidates = candidates.sort((a, b) => a.seed.localeCompare(b.seed));
for (const candidate of orderedCandidates.filter((item) => (prefixCounts.get([...item.query].slice(0, 16).join("")) ?? 0) === 1)) {
  needles.push({ id: `needle_${candidate.seed.slice(0, 16)}`, repoId, snapshotId: snapshot.id, filePath: candidate.filePath, query: candidate.query, mode: "exact", seed: candidate.seed, stratum: { line: String(candidate.line), duplicate: "non_duplicate", length: candidate.lengthBucket } });
  if (needles.length >= exactLimit) break;
}
// If the corpus has fewer than the requested number of unique-prefix samples,
// fill the remainder deterministically; duplicate-heavy strata stay visible
// in the report rather than being silently discarded.
for (const candidate of orderedCandidates) {
  if (needles.length >= exactLimit) break;
  if (needles.some((needle) => needle.filePath === candidate.filePath && needle.query === candidate.query)) continue;
  needles.push({ id: `needle_${candidate.seed.slice(0, 16)}`, repoId, snapshotId: snapshot.id, filePath: candidate.filePath, query: candidate.query, mode: "exact", seed: candidate.seed, stratum: { line: String(candidate.line), duplicate: "duplicate_or_unknown", length: candidate.lengthBucket } });
}
for (const file of admitted) if (needles.length < limit) {
  const segments = file.relativePath.split("/");
  for (const query of [file.relativePath, segments.at(-1), segments.at(-2) ?? segments.at(-1)]) {
    if (query && !query.startsWith("/") && query !== "." && query !== ".." && !query.includes("/../") && query.length >= 3) { const seed = createHash("sha256").update(`path:${file.relativePath}:${query}`).digest("hex"); needles.push({ id: `needle_${seed.slice(0, 16)}`, repoId, snapshotId: snapshot.id, filePath: file.relativePath, query, mode: "path", seed, stratum: { path: query === file.relativePath ? "full" : query === segments.at(-1) ? "basename" : "segment" } }); }
    if (needles.length >= limit) break;
  }
}
let expected = 0; let found = 0; let locatorCorrect = 0; let pathExpected = 0; let pathFound = 0; let unexpected = 0;
const exactDurations = []; const pathDurations = [];
let peakRssBytes = process.memoryUsage().rss;
for (const needle of needles) {
  let response;
  const startedAt = performance.now();
  try {
    const context = { store, scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "benchmark-secret" };
    const pages = []; let cursor;
    for (let page = 0; page < 100; page += 1) {
      const current = searchKnowledge({ query: needle.query, mode: needle.mode, scope: { revisions: [{ repoId, snapshotId: snapshot.id }] }, page: { limit: 200, ...(cursor ? { cursor } : {}) } }, context);
      pages.push(...current.hits); cursor = current.page.nextCursor;
      if (!cursor) break;
    }
    response = { hits: pages };
  }
  catch (error) { throw new Error(`benchmark query failed (${needle.mode}) ${JSON.stringify(needle.query)} for ${needle.filePath}: ${String(error.message ?? error)}`); }
  (needle.mode === "path" ? pathDurations : exactDurations).push(performance.now() - startedAt);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const expectedOccurrences = [];
  if (needle.mode === "path") { pathExpected += 1; }
  for (const [filePath, content] of corpus) {
    let cursor = 0;
    while (needle.mode === "exact") { const at = content.indexOf(needle.query, cursor); if (at < 0) break; expectedOccurrences.push({ filePath, line: content.slice(0, at).split(/\n/).length, byte: Buffer.byteLength(content.slice(0, at), "utf8") }); cursor = at + Math.max(1, needle.query.length); }
  }
  needle.expectedOccurrences = expectedOccurrences;
  expected += expectedOccurrences.length;
  for (const occurrence of expectedOccurrences) {
    const hit = response.hits.find((candidate) => candidate.locator.filePath === occurrence.filePath && candidate.locator.startLine === occurrence.line && candidate.locator.startByte === occurrence.byte);
    if (hit) { found += 1; locatorCorrect += 1; }
  }
  if (needle.mode === "path" && response.hits.some((hit) => hit.lane === "path" && hit.locator.filePath === needle.filePath)) pathFound += 1;
  const expectedKeys = new Set(expectedOccurrences.map((occurrence) => `${occurrence.filePath}:${occurrence.line}:${occurrence.byte}`));
  unexpected += response.hits.filter((hit) => hit.evidence.some((evidence) => evidence.status === "verified") && !expectedKeys.has(`${hit.locator.filePath}:${hit.locator.startLine ?? 0}:${hit.locator.startByte ?? 0}`) && needle.mode === "exact").length;
}
const discoveryAgain = discoverRepoCoverage(root).files;
const percentile = (values, p) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; };
const timingReport = {
  exactMs: { p50: percentile(exactDurations, 0.5), p95: percentile(exactDurations, 0.95), p99: percentile(exactDurations, 0.99) },
  pathMs: { p50: percentile(pathDurations, 0.5), p95: percentile(pathDurations, 0.95), p99: percentile(pathDurations, 0.99) },
  // Path lookup is the current deterministic structural lane: it exercises
  // repository/path metadata resolution without conflating it with exact
  // source occurrence latency. Keep an explicit alias in the report so the
  // release gate cannot silently omit the structural budget.
  structuralMs: { p50: percentile(pathDurations, 0.5), p95: percentile(pathDurations, 0.95), p99: percentile(pathDurations, 0.99) },
};
const databaseBytes = statSync(join(temp, "knowledge.db")).size;
const queryStrata = Object.fromEntries([...new Set(needles.flatMap((needle) => Object.keys(needle.stratum)))].map((key) => [key, Object.fromEntries([...new Set(needles.map((needle) => needle.stratum[key]).filter(Boolean))].map((value) => [value, needles.filter((needle) => needle.stratum[key] === value).length]))]));
const report = {
  root, admittedFiles: admitted.length, needleCount: needles.length, expectedOccurrences: expected, foundOccurrences: found,
  exactRecall: expected ? found / expected : 1, pathExpected, pathFound, pathRecall: pathExpected ? pathFound / pathExpected : 1,
  locatorAccuracy: expected ? locatorCorrect / expected : 1, unexpectedVerifiedHits: unexpected, performance: timingReport,
  environment: { os: platform(), osRelease: release(), node: process.version, cpuCount: Number(process.env.PENGUIN_CPU_COUNT ?? 0) || undefined, ramBytes: totalmem() },
  resources: { indexMs, indexFilesPerSecond: indexMs ? admitted.length / (indexMs / 1000) : 0, sourceBytes, databaseBytes, databaseAmplificationRatio: sourceBytes ? databaseBytes / sourceBytes : 0, peakRssBytes },
  queryStrata,
  coverage: { discovered: discoveryAgain.length, admitted: admitted.length, excluded: discoveryAgain.filter((file) => file.coverageStatus === "excluded").length, failed: discoveryAgain.filter((file) => file.coverageStatus === "failed").length },
};
console.log(JSON.stringify(report, null, 2));
store.close();
if (process.argv.includes("--gate") && (report.needleCount < limit || report.exactRecall !== 1 || report.pathRecall !== 1 || report.locatorAccuracy !== 1 || report.unexpectedVerifiedHits !== 0 || report.coverage.discovered !== report.coverage.admitted + report.coverage.excluded + report.coverage.failed)) process.exitCode = 1;
if (process.argv.includes("--performance-gate") && (report.performance.exactMs.p95 >= 150 || report.performance.structuralMs.p95 >= 300)) process.exitCode = 1;
