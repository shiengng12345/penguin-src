import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createLocalEmbeddingProvider, embeddingSpaceIdentity, inspectLocalEmbeddingDirectory } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-local-embedding-"));
  const model = Buffer.from("verified-model", "utf8");
  const tokenizer = Buffer.from('{"type":"fixture"}', "utf8");
  writeFileSync(join(directory, "model.bin"), model);
  writeFileSync(join(directory, "tokenizer.json"), tokenizer);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    providerId: "local", modelId: "fixture-v1", modelFile: "model.bin",
    weightsDigest: createHash("sha256").update(model).digest("hex"), tokenizerFile: "tokenizer.json",
    tokenizerDigest: createHash("sha256").update(tokenizer).digest("hex"), dimensions: 3, maxTokens: 128,
    pooling: "mean", normalization: "l2", license: "fixture-only",
  }));
  return directory;
}

test("local embedding manifest verifies weights and tokenizer independently", () => {
  const directory = fixture();
  const descriptor = inspectLocalEmbeddingDirectory(directory);
  assert.equal(descriptor.providerId, "local");
  assert.equal(descriptor.weightsDigest.length, 64);
  assert.equal(descriptor.tokenizerDigest.length, 64);
  writeFileSync(join(directory, "tokenizer.json"), "changed");
  assert.throws(() => inspectLocalEmbeddingDirectory(directory), /LOCAL_EMBEDDING_TOKENIZER_HASH_MISMATCH/);
});

test("local embedding manifest permits safe nested model assets but rejects traversal", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-local-embedding-nested-"));
  const model = Buffer.from("verified-model", "utf8");
  const tokenizer = Buffer.from('{"type":"fixture"}', "utf8");
  mkdirSync(join(directory, "onnx"));
  writeFileSync(join(directory, "onnx", "model_quantized.onnx"), model);
  writeFileSync(join(directory, "tokenizer.json"), tokenizer);
  const manifest = {
    providerId: "local", modelId: "fixture-v1", modelFile: "onnx/model_quantized.onnx",
    weightsDigest: createHash("sha256").update(model).digest("hex"), tokenizerFile: "tokenizer.json",
    tokenizerDigest: createHash("sha256").update(tokenizer).digest("hex"), dimensions: 3, maxTokens: 128,
    pooling: "mean", normalization: "l2", license: "fixture-only",
  };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.equal(inspectLocalEmbeddingDirectory(directory).modelPath, join(directory, "onnx", "model_quantized.onnx"));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...manifest, modelFile: "../outside.onnx" }));
  assert.throws(() => inspectLocalEmbeddingDirectory(directory), /LOCAL_EMBEDDING_MANIFEST_INVALID/);
});

test("local provider refuses an unverified backend and exposes a versioned space identity", async () => {
  const directory = fixture();
  const provider = await createLocalEmbeddingProvider({
    directory,
    backend: { load: async () => ({ embed: async (texts) => texts.map(() => new Float32Array([3, 0, 4])) }) },
    chunkerVersion: "semantic-chunker-v1",
  });
  assert.equal(provider.modelHash.length, 64);
  assert.equal(provider.spaceId, `space_${provider.modelHash}`);
  assert.equal(provider.spaceIdentity.identityHash, provider.modelHash);
  const vector = (await provider.embed(["hello"]))[0];
  assert.deepEqual([...vector].map((value) => Number(value.toFixed(6))), [0.6, 0, 0.8]);
  assert.equal((await provider.health()).ok, true);
  writeFileSync(join(directory, "model.bin"), "tampered");
  await assert.rejects(() => provider.embed(["hello"]), /LOCAL_EMBEDDING_MODEL_HASH_MISMATCH/);
});

test("local provider preserves document and query embedding roles exposed by the backend", async () => {
  const directory = fixture();
  const calls = [];
  const provider = await createLocalEmbeddingProvider({
    directory,
    backend: {
      load: async () => ({
        embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
        embedDocuments: async (texts) => {
          calls.push(["documents", ...texts]);
          return texts.map(() => new Float32Array([0, 3, 4]));
        },
        embedQuery: async (text) => {
          calls.push(["query", text]);
          return new Float32Array([0, 4, 3]);
        },
      }),
    },
  });

  assert.equal(typeof provider.embedDocuments, "function");
  assert.equal(typeof provider.embedQuery, "function");
  assert.deepEqual([...(await provider.embedDocuments(["doc"]))[0]].map((value) => Number(value.toFixed(6))), [0, 0.6, 0.8]);
  assert.deepEqual([...(await provider.embedQuery("query"))].map((value) => Number(value.toFixed(6))), [0, 0.8, 0.6]);
  assert.deepEqual(calls, [["documents", "doc"], ["query", "query"]]);
});

test("embedding space identity includes model, tokenizer, dimensions, and preprocessing", () => {
  const base = { providerId: "local", modelId: "m", weightsDigest: "a".repeat(64), tokenizerDigest: "b".repeat(64), dimensions: 3, pooling: "mean", normalization: "l2", chunkerVersion: "v1", preprocessingDigest: "c".repeat(64) };
  assert.notEqual(embeddingSpaceIdentity(base).id, embeddingSpaceIdentity({ ...base, dimensions: 4 }).id);
  assert.notEqual(embeddingSpaceIdentity(base).id, embeddingSpaceIdentity({ ...base, tokenizerDigest: "c".repeat(64) }).id);
  assert.notEqual(embeddingSpaceIdentity(base).id, embeddingSpaceIdentity({ ...base, preprocessingDigest: "d".repeat(64) }).id);
});

test("local provider binds document/query prefixes into the persisted vector-space identity", async () => {
  const directory = fixture();
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, documentPrefix: "search_document: ", queryPrefix: "search_query: ", dtype: "q8" }));
  const backend = { load: async () => ({ embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0])) }) };
  const first = await createLocalEmbeddingProvider({ directory, backend });
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, documentPrefix: "document: ", queryPrefix: "query: ", dtype: "q8" }));
  const second = await createLocalEmbeddingProvider({ directory, backend });
  assert.notEqual(first.spaceId, second.spaceId);
  assert.notEqual(first.spaceIdentity.preprocessingDigest, second.spaceIdentity.preprocessingDigest);
});
