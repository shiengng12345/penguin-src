import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openBundledEmbeddingProvider, resolveBundledEmbeddingModelDirectory } from "../packages/knowledge-core/dist/index.js";

function runtimeFixture() {
  const runtime = mkdtempSync(join(tmpdir(), "penguin-bundled-provider-"));
  const modelDirectory = join(runtime, "models", "fixture-model");
  const entryPath = join(runtime, "mcp", "dist", "index.js");
  mkdirSync(modelDirectory, { recursive: true });
  mkdirSync(join(runtime, "mcp", "dist"), { recursive: true });
  const model = Buffer.from("model", "utf8");
  const tokenizer = Buffer.from("tokenizer", "utf8");
  writeFileSync(join(modelDirectory, "model.bin"), model);
  writeFileSync(join(modelDirectory, "tokenizer.json"), tokenizer);
  writeFileSync(join(modelDirectory, "manifest.json"), JSON.stringify({
    providerId: "local", modelId: "fixture", modelFile: "model.bin",
    weightsDigest: createHash("sha256").update(model).digest("hex"), tokenizerFile: "tokenizer.json",
    tokenizerDigest: createHash("sha256").update(tokenizer).digest("hex"), dimensions: 3, maxTokens: 128,
    pooling: "mean", normalization: "l2", license: "fixture-only",
  }));
  return { runtime, modelDirectory, entryPath };
}

test("bundled model discovery works from the installed MCP entry path", async () => {
  const { modelDirectory, entryPath } = runtimeFixture();
  assert.equal(resolveBundledEmbeddingModelDirectory({ entryPath }), modelDirectory);
  const provider = await openBundledEmbeddingProvider({
    entryPath,
    backend: { load: async () => ({ embed: async (texts) => texts.map(() => new Float32Array([3, 0, 4])) }) },
  });
  assert.equal(provider.modelId, "fixture");
  assert.deepEqual([...(await provider.embed(["text"]))[0]].map((value) => Number(value.toFixed(6))), [0.6, 0, 0.8]);
});

test("bundled model discovery fails closed when no verified model is installed", () => {
  const runtime = mkdtempSync(join(tmpdir(), "penguin-bundled-provider-missing-"));
  assert.throws(
    () => resolveBundledEmbeddingModelDirectory({ entryPath: join(runtime, "mcp", "dist", "index.js") }),
    /LOCAL_EMBEDDING_MODEL_NOT_INSTALLED/,
  );
});
