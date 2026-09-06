#!/usr/bin/env node
// Frozen 200-scenario coverage plus a real offline inference gate. The full
// matrix protects product/API coverage; the 20 semantic paraphrases execute
// against persisted sqlite-vec rows built from a curated copy of real source.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  KnowledgeStore,
  openBundledEmbeddingProvider,
  searchPersistedVectors,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { runSemanticWorker } from "../packages/knowledge-cli/dist/index.js";
import { runKnowledgeQualityBenchmark } from "./knowledge-quality-benchmark.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = process.argv.find((arg) => arg.startsWith("--input="))?.slice("--input=".length)
  ?? resolve(ROOT, "tests/fixtures/knowledge-hybrid-benchmark/questions.json");
const outputPath = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const gate = process.argv.includes("--gate");
const measure = gate || process.argv.includes("--measure");
const tuning = {
  inferenceBatchSize: Number(process.argv.find((arg) => arg.startsWith("--inference-batch="))?.slice("--inference-batch=".length) ?? 64),
  inferenceConcurrency: Number(process.argv.find((arg) => arg.startsWith("--inference-concurrency="))?.slice("--inference-concurrency=".length) ?? 2),
  intraOpNumThreads: Number(process.argv.find((arg) => arg.startsWith("--intra-op-threads="))?.slice("--intra-op-threads=".length) ?? 0),
};
if (![tuning.inferenceBatchSize, tuning.inferenceConcurrency].every((value) => Number.isInteger(value) && value > 0)
  || !(tuning.intraOpNumThreads === 0 || (Number.isInteger(tuning.intraOpNumThreads) && tuning.intraOpNumThreads > 0))) {
  throw new Error("HYBRID_BENCHMARK_TUNING_INVALID");
}
if (process.argv.includes("--debug-semantic")) {
  process.env.PENGUIN_SEMANTIC_DEBUG = "1";
  process.env.PENGUIN_SEMANTIC_DEBUG_QUERIES = "authoritative|dimension|model and tokenizer";
}
const requiredCategories = [
  "exact_symbol", "lexical_source", "path", "endpoint", "graph_flow",
  "cross_repo", "semantic_paraphrase", "negative", "freshness", "provenance_parity",
];

const semanticGold = [
  ["src/math.ts", "src/users.controller.ts", "src/users-grpc.controller.ts"],
  ["src/users.controller.ts"],
  ["src/users.controller.ts"],
  ["src/math.ts", "packages/knowledge-core/src/vector-store.ts"],
  ["src/math.ts"],
  ["src/users.controller.ts"],
  ["src/users-grpc.controller.ts"],
  ["packages/knowledge-core/src/graph-evidence.ts", "packages/knowledge-core/src/schema.ts"],
  ["packages/knowledge-core/src/vector-store.ts"],
  ["packages/knowledge-indexer/src/embedding-indexer.ts"],
  ["packages/knowledge-core/src/embedding-lifecycle.ts", "packages/knowledge-indexer/src/embedding-indexer.ts"],
  ["packages/knowledge-core/src/embedding-lifecycle.ts"],
  ["packages/knowledge-core/src/embedding-provider.ts", "packages/knowledge-core/src/local-embedding-provider.ts"],
  ["packages/knowledge-core/src/search-engine.ts"],
  ["packages/knowledge-core/src/hybrid-search.ts"],
  ["packages/knowledge-core/src/hybrid-search.ts"],
  ["packages/knowledge-core/src/hybrid-search.ts"],
  ["packages/knowledge-core/src/embedding-lifecycle.ts", "packages/knowledge-core/src/vector-store.ts"],
  ["packages/knowledge-indexer/src/embedding-indexer.ts"],
  ["packages/knowledge-core/src/semantic-identity.ts", "packages/knowledge-core/src/local-embedding-provider.ts"],
];

const corpusSlices = [
  { path: "tests/fixtures/knowledge-quality/src/math.ts" },
  { path: "tests/fixtures/knowledge-quality/src/users.controller.ts" },
  { path: "tests/fixtures/knowledge-quality/src/users-grpc.controller.ts" },
  { path: "packages/knowledge-core/src/graph-evidence.ts", ranges: [[1, 220]] },
  { path: "packages/knowledge-core/src/schema.ts", ranges: [[900, 990]] },
  { path: "packages/knowledge-core/src/vector-store.ts", ranges: [[1, 260]] },
  // Keep the real validation/backfill implementation in the semantic corpus.
  // The dimension and provider identity guards live below the setup helpers.
  { path: "packages/knowledge-indexer/src/embedding-indexer.ts", ranges: [[1, 380]] },
  { path: "packages/knowledge-core/src/embedding-lifecycle.ts", ranges: [[1, 210]] },
  { path: "packages/knowledge-core/src/embedding-provider.ts", ranges: [[55, 135]] },
  { path: "packages/knowledge-core/src/local-embedding-provider.ts", ranges: [[1, 120]] },
  { path: "packages/knowledge-core/src/search-engine.ts", ranges: [[630, 710]] },
  { path: "packages/knowledge-core/src/hybrid-search.ts", ranges: [[1, 180]] },
  { path: "packages/knowledge-core/src/semantic-identity.ts", ranges: [[1, 100]] },
];

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

function loadQuestions() {
  const matrix = JSON.parse(readFileSync(fixturePath, "utf8"));
  if (matrix.version !== 1 || !Array.isArray(matrix.questions)) throw new Error("HYBRID_BENCHMARK_MATRIX_INVALID");
  let sequence = 0;
  return matrix.questions.flatMap((group) => {
    if (typeof group.category !== "string" || !requiredCategories.includes(group.category) || !Array.isArray(group.items)) throw new Error("HYBRID_BENCHMARK_GROUP_INVALID");
    return group.items.map((question) => {
      sequence += 1;
      if (typeof question !== "string" || question.trim().length < 8) throw new Error("HYBRID_BENCHMARK_QUESTION_INVALID");
      return { id: "HB-" + String(sequence).padStart(3, "0"), category: group.category, question, mode: group.mode, gold: group.gold };
    });
  });
}

function materializeSemanticCorpus(directory) {
  for (const source of corpusSlices) {
    const targetPath = join(directory, source.path.replace("tests/fixtures/knowledge-quality/", ""));
    mkdirSync(dirname(targetPath), { recursive: true });
    const lines = readFileSync(join(ROOT, source.path), "utf8").split("\n");
    const content = source.ranges
      ? source.ranges.map(([start, end]) => lines.slice(start - 1, end).join("\n")).join("\n")
      : lines.join("\n");
    writeFileSync(targetPath, `${content}\n`);
  }
}

async function runRealInferenceQuality(questions, selected) {
  const semanticQuestions = questions.filter((question) => question.category === "semantic_paraphrase");
  if (semanticQuestions.length !== semanticGold.length) throw new Error("SEMANTIC_GOLD_MATRIX_INVALID");
  const corpusRoot = mkdtempSync(join(tmpdir(), "penguin-hybrid-corpus-"));
  const dbRoot = mkdtempSync(join(tmpdir(), "penguin-hybrid-db-"));
  const modelDirectory = resolve(
    process.env.PENGUIN_EMBEDDING_MODEL_DIR
      ?? join(ROOT, "packages/knowledge-cli/bundle/models", selected.bundleDirectory),
  );
  materializeSemanticCorpus(corpusRoot);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Benchmark",
    GIT_AUTHOR_EMAIL: "penguin@example.invalid",
    GIT_COMMITTER_NAME: "Penguin Benchmark",
    GIT_COMMITTER_EMAIL: "penguin@example.invalid",
  };
  execFileSync("git", ["init", "-q", "-b", "main", corpusRoot], { env: gitEnv });
  execFileSync("git", ["-C", corpusRoot, "add", "."], { env: gitEnv });
  execFileSync("git", ["-C", corpusRoot, "commit", "-q", "-m", "semantic benchmark corpus"], { env: gitEnv });
  const store = KnowledgeStore.open({ dbPath: join(dbRoot, "knowledge.db"), ledgerPath: join(dbRoot, "ledger.jsonl") });
  try {
    const providerStarted = performance.now();
    const provider = await openBundledEmbeddingProvider({
      modelDirectory,
      inferenceBatchSize: tuning.inferenceBatchSize,
      inferenceConcurrency: tuning.inferenceConcurrency,
      ...(tuning.intraOpNumThreads > 0 ? { intraOpNumThreads: tuning.intraOpNumThreads } : {}),
    });
    const coldStartMs = performance.now() - providerStarted;
    const indexStarted = performance.now();
    const indexed = await indexRepo({
      store,
      rootPath: corpusRoot,
      mode: "rebuild",
      // Exercise the production scheduler defaults: the provider internally
      // uses bounded concurrent inference waves, while the indexer retains
      // its adaptive padding/lease policy.
      semantic: { enabled: true, provider, space: provider.spaceIdentity },
    });
    const worker = await runSemanticWorker({
      store,
      ownerId: "hybrid-benchmark-worker",
      buildId: "hybrid-benchmark",
      providerFactory: async () => provider,
    });
    const indexMs = performance.now() - indexStarted;
    const generation = store.db.prepare("SELECT status,failure_reason AS reason FROM embedding_generations WHERE id=?").get(indexed.semantic.generationId);
    if (worker.status !== "drained" || generation?.status !== "active") {
      throw new Error(`SEMANTIC_BENCHMARK_INDEX_FAILED: ${generation?.reason ?? generation?.status ?? worker.status}`);
    }
    const branch = store.db.prepare("SELECT current_snapshot_id AS snapshotId FROM branches WHERE id=?").get(indexed.branchId);
    if (!branch?.snapshotId) throw new Error("SEMANTIC_BENCHMARK_SNAPSHOT_MISSING");
    const scopes = [{ repoId: indexed.repoId, snapshotId: branch.snapshotId }];
    const cases = [];
    const durations = [];
    for (let index = 0; index < semanticQuestions.length; index += 1) {
      const started = performance.now();
      const result = await searchPersistedVectors({ store, provider, query: semanticQuestions[index].question, scopes, limit: 5 });
      const elapsedMs = performance.now() - started;
      durations.push(elapsedMs);
      const paths = result.hits.map((hit) => hit.locator.filePath);
      const rankIndex = paths.findIndex((path) => semanticGold[index].includes(path));
      cases.push({
        id: semanticQuestions[index].id,
        expectedPaths: semanticGold[index],
        returnedPaths: paths,
        rank: rankIndex < 0 ? null : rankIndex + 1,
        elapsedMs: Math.round(elapsedMs * 100) / 100,
      });
    }
    const matched = cases.filter((item) => item.rank !== null);
    const semantic = {
      questions: cases.length,
      matchedAt5: matched.length,
      recallAt5: matched.length / cases.length,
      top1Accuracy: cases.filter((item) => item.rank === 1).length / cases.length,
      mrr: cases.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / cases.length,
      cases,
    };
    return {
      semantic,
      latency: {
        coldStartMs: Math.round(coldStartMs * 100) / 100,
        indexMs: Math.round(indexMs * 100) / 100,
        queryP50Ms: Math.round(percentile(durations, 0.5) * 100) / 100,
        queryP95Ms: Math.round(percentile(durations, 0.95) * 100) / 100,
      },
      indexing: { files: indexed.semantic.files, chunks: indexed.semantic.chunks },
      provider: {
        modelHash: provider.modelHash,
        spaceId: provider.spaceId,
        tuning,
      },
    };
  } finally {
    store.close();
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(dbRoot, { recursive: true, force: true });
  }
}

async function makeReport() {
  const questions = loadQuestions();
  const categoryCounts = Object.fromEntries(requiredCategories.map((category) => [category, questions.filter((question) => question.category === category).length]));
  const invalidGroups = requiredCategories.filter((category) => categoryCounts[category] < 20);
  const invalidGold = questions.filter((question) => !question.gold?.requiredLane || !question.gold?.requiredEvidence);
  const semanticCount = questions.filter((question) => question.mode === "semantic").length;
  let modelConfig = null;
  try { modelConfig = JSON.parse(readFileSync(resolve(ROOT, "config/knowledge-embedding-models.json"), "utf8")); } catch { /* report below */ }
  const selected = modelConfig?.selected ?? null;
  const corpusPass = questions.length >= 200 && invalidGroups.length === 0 && invalidGold.length === 0 && new Set(questions.map((question) => question.id)).size === questions.length;
  const modelPass = Boolean(selected && modelConfig?.policy?.requireVerifiedWeightsAndTokenizer === true);
  const report = {
    benchmarkVersion: 2,
    fixture: fixturePath,
    questionCount: questions.length,
    categoryCounts,
    semanticQuestionCount: semanticCount,
    consumerBoundary: "consumer_mcp_only",
    corpus: { passed: corpusPass, invalidGroups, invalidGoldIds: invalidGold.map((question) => question.id) },
    model: {
      selected: selected ? { providerId: selected.providerId ?? null, modelId: selected.modelId ?? null, revision: selected.revision ?? null } : null,
      verified: modelPass,
      status: modelPass ? "selected" : "not_selected",
    },
    network: { runtimeDownloadsAllowed: selected?.runtimeDownloadAllowed !== false },
    quality: null,
    latency: null,
    status: corpusPass && modelPass ? "BLOCKED_REAL_INFERENCE_EVIDENCE" : corpusPass ? "BLOCKED_MODEL_NOT_SELECTED" : "FAIL_CORPUS",
    gateExitCode: corpusPass && modelPass ? 2 : 1,
  };
  if (measure && corpusPass && modelPass) {
    const deterministic = await runKnowledgeQualityBenchmark();
    const measured = await runRealInferenceQuality(questions, selected);
    const semanticPass = measured.semantic.recallAt5 >= 0.9 && measured.semantic.mrr >= 0.65;
    const latencyPass = measured.latency.coldStartMs <= 20_000 && measured.latency.queryP95Ms <= 2_000;
    report.quality = { realInference: true, deterministic, semantic: measured.semantic, indexing: measured.indexing, provider: measured.provider };
    report.latency = measured.latency;
    report.status = deterministic.passed && semanticPass && latencyPass ? "PASS" : "FAIL_QUALITY_GATE";
    report.gateExitCode = report.status === "PASS" ? 0 : 1;
  }
  if (outputPath) writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2) + "\n");
  return report;
}

try {
  const report = await makeReport();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (gate) process.exitCode = report.gateExitCode;
} catch (error) {
  const report = { benchmarkVersion: 2, status: "FAIL_BENCHMARK", error: String(error?.stack ?? error), gateExitCode: 1 };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (gate) process.exitCode = 1;
}
