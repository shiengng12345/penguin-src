import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializePinnedEmbeddingModel } from "../scripts/lib/knowledge-model-assets.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "penguin-model-assets-"));
  const cacheDirectory = join(root, "cache");
  const outputDirectory = join(root, "output");
  mkdirSync(join(cacheDirectory, "onnx"), { recursive: true });
  const model = Buffer.from("model", "utf8");
  const tokenizer = Buffer.from("tokenizer", "utf8");
  writeFileSync(join(cacheDirectory, "onnx", "model.onnx"), model);
  writeFileSync(join(cacheDirectory, "tokenizer.json"), tokenizer);
  const selection = {
    providerId: "local",
    modelId: "fixture/model",
    revision: "1".repeat(40),
    bundleDirectory: "fixture-model",
    modelFile: "onnx/model.onnx",
    tokenizerFile: "tokenizer.json",
    dimensions: 3,
    maxTokens: 128,
    pooling: "mean",
    normalization: "l2",
    dtype: "q8",
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    license: "fixture-only",
    runtimeDownloadAllowed: false,
    assets: [
      { path: "onnx/model.onnx", sha256: createHash("sha256").update(model).digest("hex"), bytes: model.length },
      { path: "tokenizer.json", sha256: createHash("sha256").update(tokenizer).digest("hex"), bytes: tokenizer.length },
    ],
  };
  return { cacheDirectory, outputDirectory, selection };
}

test("pinned embedding assets are hash-verified and produce a runtime manifest", () => {
  const { cacheDirectory, outputDirectory, selection } = fixture();
  const result = materializePinnedEmbeddingModel({ selection, cacheDirectory, outputDirectory });
  assert.equal(result.assetCount, 2);
  assert.equal(readFileSync(join(outputDirectory, "onnx", "model.onnx"), "utf8"), "model");
  const manifest = JSON.parse(readFileSync(join(outputDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.modelId, selection.modelId);
  assert.equal(manifest.modelFile, selection.modelFile);
  assert.equal(manifest.weightsDigest, selection.assets[0].sha256);
  assert.equal(manifest.tokenizerDigest, selection.assets[1].sha256);
  assert.equal(manifest.sourceRevision, selection.revision);
  assert.equal(manifest.runtimeDownloadAllowed, false);
  assert.ok((statSync(join(outputDirectory, "manifest.json")).mode & 0o200) !== 0, "repeated Tauri builds must be able to overwrite staged resources");
});

test("pinned embedding asset materialization fails closed on cache tampering", () => {
  const { cacheDirectory, outputDirectory, selection } = fixture();
  writeFileSync(join(cacheDirectory, "tokenizer.json"), "tampered!");
  assert.throws(
    () => materializePinnedEmbeddingModel({ selection, cacheDirectory, outputDirectory }),
    /PINNED_MODEL_ASSET_HASH_MISMATCH/,
  );
});
