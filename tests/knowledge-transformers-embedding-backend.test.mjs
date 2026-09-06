import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransformersEmbeddingBackend } from "../packages/knowledge-core/dist/index.js";

const descriptor = {
  providerId: "local",
  modelId: "nomic-embed-text-v1.5",
  modelFile: "model_quantized.onnx",
  weightsDigest: "a".repeat(64),
  tokenizerFile: "tokenizer.json",
  tokenizerDigest: "b".repeat(64),
  dimensions: 3,
  maxTokens: 2048,
  pooling: "mean",
  normalization: "l2",
  license: "Apache-2.0",
  directory: "/opt/penguin/models/nomic-embed-text-v1.5",
  modelPath: "/opt/penguin/models/nomic-embed-text-v1.5/model_quantized.onnx",
  tokenizerPath: "/opt/penguin/models/nomic-embed-text-v1.5/tokenizer.json",
};

test("Transformers backend is local-only and applies asymmetric retrieval prefixes", async () => {
  const env = {};
  const pipelineCalls = [];
  const inferenceCalls = [];
  const backend = createTransformersEmbeddingBackend({
    moduleLoader: async () => ({
      env,
      async pipeline(task, model, options) {
        pipelineCalls.push({ task, model, options });
        return async (texts, inferenceOptions) => {
          inferenceCalls.push({ texts, inferenceOptions });
          const values = Array.isArray(texts) ? texts : [texts];
          return { tolist: () => values.map((_, index) => [index + 1, 0, 0]) };
        };
      },
    }),
  });
  const loaded = await backend.load(descriptor);

  assert.equal(env.allowRemoteModels, false);
  assert.equal(env.allowLocalModels, true);
  assert.equal(env.useFSCache, false);
  assert.equal(env.localModelPath, "/opt/penguin/models");
  assert.deepEqual(pipelineCalls, [{
    task: "feature-extraction",
    model: descriptor.directory,
    options: {
      dtype: "q8",
      local_files_only: true,
      device: "cpu",
      session_options: {
        intraOpNumThreads: 4,
        interOpNumThreads: 1,
        executionMode: "parallel",
      },
    },
  }]);

  assert.deepEqual([...(await loaded.embedDocuments(["alpha", "beta"]))[0]], [1, 0, 0]);
  assert.deepEqual([...(await loaded.embedQuery("meaning"))], [1, 0, 0]);
  assert.deepEqual(inferenceCalls, [
    {
      texts: ["search_document: alpha", "search_document: beta"],
      inferenceOptions: { pooling: "mean", normalize: false },
    },
    {
      texts: ["search_query: meaning"],
      inferenceOptions: { pooling: "mean", normalize: false },
    },
  ]);
});

test("Transformers backend splits large document batches into bounded concurrent inference calls", async () => {
  const calls = [];
  const backend = createTransformersEmbeddingBackend({
    inferenceBatchSize: 2,
    inferenceConcurrency: 2,
    intraOpNumThreads: 1,
    moduleLoader: async () => ({
      env: {},
      async pipeline() {
        return async (texts) => {
          const values = Array.isArray(texts) ? texts : [texts];
          calls.push(values);
          return { tolist: () => values.map((text) => [text.includes("alpha") ? 1 : 0, text.includes("beta") ? 1 : 0, 0]) };
        };
      },
    }),
  });
  const loaded = await backend.load(descriptor);

  const vectors = await loaded.embedDocuments(["alpha", "beta", "gamma", "delta"]);

  assert.deepEqual(calls, [
    ["search_document: alpha", "search_document: beta"],
    ["search_document: gamma", "search_document: delta"],
  ]);
  assert.deepEqual([...vectors[0]], [1, 0, 0]);
  assert.deepEqual([...vectors[1]], [0, 1, 0]);
  assert.deepEqual([...vectors[2]], [0, 0, 0]);
  assert.deepEqual([...vectors[3]], [0, 0, 0]);
});

test("Transformers backend rejects malformed tensor output", async () => {
  const backend = createTransformersEmbeddingBackend({
    moduleLoader: async () => ({
      env: {},
      async pipeline() {
        return async () => ({ tolist: () => ["invalid"] });
      },
    }),
  });
  const loaded = await backend.load(descriptor);
  await assert.rejects(() => loaded.embedQuery("meaning"), /TRANSFORMERS_EMBEDDING_OUTPUT_INVALID/);
});
