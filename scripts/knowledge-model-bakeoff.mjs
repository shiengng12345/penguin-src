#!/usr/bin/env node
// Offline model-bakeoff gate. It deliberately does not download weights or
// claim a model is selected: a candidate may be promoted only after an
// external benchmark supplies quality, size, startup, throughput, license,
// and both-architecture evidence.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const candidatePath = value("--candidate");
const outputPath = value("--output");
const json = value("--json");

function fail(code, detail) {
  const report = { ok: false, code, detail };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 2;
}

if (!candidatePath) {
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "gate", selected: null, policy: "pinned-local-only", requirements: ["manifest", "weights-and-tokenizer-digests", "license", "quality", "size", "cold-start", "throughput", "darwin-arm64", "darwin-x64"] })}\n`);
} else {
  try {
    const directory = resolve(candidatePath);
    const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
    const required = ["providerId", "modelId", "modelFile", "weightsDigest", "tokenizerFile", "tokenizerDigest", "dimensions", "maxTokens", "pooling", "normalization", "license"];
    if (manifest.providerId !== "local" || required.some((key) => manifest[key] === undefined)) throw new Error("MODEL_BAKEOFF_MANIFEST_INVALID");
    const model = readFileSync(resolve(directory, manifest.modelFile));
    const tokenizer = readFileSync(resolve(directory, manifest.tokenizerFile));
    const weightsDigest = createHash("sha256").update(model).digest("hex");
    const tokenizerDigest = createHash("sha256").update(tokenizer).digest("hex");
    if (weightsDigest !== String(manifest.weightsDigest).toLowerCase()) throw new Error("MODEL_BAKEOFF_MODEL_HASH_MISMATCH");
    if (tokenizerDigest !== String(manifest.tokenizerDigest).toLowerCase()) throw new Error("MODEL_BAKEOFF_TOKENIZER_HASH_MISMATCH");
    if (!String(manifest.license).trim()) throw new Error("MODEL_BAKEOFF_LICENSE_REQUIRED");
    const result = {
      ok: true,
      candidate: { ...manifest, weightsDigest, tokenizerDigest },
      measured: { modelBytes: statSync(resolve(directory, manifest.modelFile)).size, tokenizerBytes: statSync(resolve(directory, manifest.tokenizerFile)).size },
      evidenceRequired: ["quality", "cold-start", "throughput", "darwin-arm64", "darwin-x64"],
      promoted: false,
    };
    if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(json === "pretty" ? result : { ok: true, promoted: false, modelId: manifest.modelId, output: outputPath ?? null })}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "MODEL_BAKEOFF_FAILED", "candidate did not pass offline integrity checks");
  }
}
