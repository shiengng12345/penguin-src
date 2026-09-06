import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("release configuration selects one pinned redistributable local embedding model", () => {
  const config = JSON.parse(readFileSync("config/knowledge-embedding-models.json", "utf8"));
  assert.equal(config.policy.mode, "pinned-local-only");
  assert.equal(config.selected.modelId, "nomic-ai/nomic-embed-text-v1.5");
  assert.equal(config.selected.revision, "e9b6763023c676ca8431644204f50c2b100d9aab");
  assert.equal(config.selected.license, "Apache-2.0");
  assert.equal(config.selected.dimensions, 768);
  assert.equal(config.selected.maxTokens, 2048);
  assert.equal(config.selected.documentPrefix, "search_document: ");
  assert.equal(config.selected.queryPrefix, "search_query: ");
  assert.equal(config.selected.runtimeDownloadAllowed, false);
  assert.ok(Array.isArray(config.selected.assets));
  assert.ok(config.selected.assets.length >= 5);
  assert.ok(config.selected.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(config.selected.assets.some((asset) => asset.path === "onnx/model_quantized.onnx" && asset.bytes === 137296292));
});
