import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);

function candidate() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-model-bakeoff-"));
  const model = Buffer.from("fixture-model", "utf8");
  const tokenizer = Buffer.from("fixture-tokenizer", "utf8");
  writeFileSync(join(directory, "model.bin"), model);
  writeFileSync(join(directory, "tokenizer.json"), tokenizer);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    providerId: "local",
    modelId: "fixture-v1",
    modelFile: "model.bin",
    weightsDigest: createHash("sha256").update(model).digest("hex"),
    tokenizerFile: "tokenizer.json",
    tokenizerDigest: createHash("sha256").update(tokenizer).digest("hex"),
    dimensions: 3,
    maxTokens: 128,
    pooling: "mean",
    normalization: "l2",
    license: "fixture-only",
  }));
  return directory;
}

test("model bakeoff is explicit when no model is selected", () => {
  const output = execFileSync(process.execPath, ["scripts/knowledge-model-bakeoff.mjs"], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.equal(report.selected, null);
  assert.equal(report.policy, "pinned-local-only");
  assert.ok(report.requirements.includes("darwin-arm64"));
  assert.ok(report.requirements.includes("darwin-x64"));
});

test("model bakeoff accepts integrity evidence but never promotes by itself", async () => {
  const directory = candidate();
  const output = join(directory, "report.json");
  const result = await run(process.execPath, ["scripts/knowledge-model-bakeoff.mjs", "--candidate", directory, "--output", output, "--json", "pretty"]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.promoted, false);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).candidate.modelId, "fixture-v1");
  writeFileSync(join(directory, "model.bin"), "tampered");
  await assert.rejects(
    () => run(process.execPath, ["scripts/knowledge-model-bakeoff.mjs", "--candidate", directory]),
    (error) => String(error.stdout ?? "").includes("MODEL_BAKEOFF_MODEL_HASH_MISMATCH"),
  );
});
