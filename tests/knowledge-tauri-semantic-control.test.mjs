import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const rust = readFileSync(new URL("../src-tauri/src/knowledge.rs", import.meta.url), "utf8");
const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");

const validStatus = {
  state: "paused",
  scopeKey: "repo:repo",
  repoId: "repo",
  generationId: "generation",
  activeGenerationId: null,
  snapshotId: "snapshot",
  modelId: "model",
  modelHash: "hash",
  providerId: "provider",
  weightsDigest: "weights",
  tokenizerDigest: "tokenizer",
  preprocessingDigest: null,
  pooling: "mean",
  normalization: "none",
  dimensions: 2,
  chunkerVersion: "v1",
  expected: 1,
  ready: 0,
  running: 0,
  pending: 1,
  retryableFailed: 0,
  terminalFailed: 0,
  progressPercent: 0,
  ratePerSecond: null,
  etaSeconds: null,
  paused: true,
  pauseRequested: true,
  lastHeartbeatAt: null,
  workerBuildId: null,
  lease: { active: false, ownerId: null, ownerPid: null, expiresAt: null },
  reason: null,
  restartRequired: false,
};

async function loadKnowledgeClient(invoke) {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const semanticUrl = new URL("../packages/knowledge-contracts/dist/semantic.js", import.meta.url).href;
  const patched = outputText
    .replace('import { invoke } from "@tauri-apps/api/core";', "const { invoke } = globalThis.__knowledgeClientTest;")
    .replaceAll('"../../packages/knowledge-contracts/src/semantic.js"', JSON.stringify(semanticUrl));
  const path = join(tmpdir(), `penguin-knowledge-client-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, patched);
  globalThis.__knowledgeClientTest = { invoke };
  try {
    return await import(`${pathToFileURL(path).href}?v=${Date.now()}`);
  } finally {
    delete globalThis.__knowledgeClientTest;
    await unlink(path).catch(() => {});
  }
}

test("Tauri registers canonical semantic status and control commands", () => {
  assert.match(lib, /knowledge::knowledge_semantic_status/);
  assert.match(lib, /knowledge::knowledge_semantic_control/);
  assert.match(rust, /fn knowledge_semantic_status/);
  assert.match(rust, /fn knowledge_semantic_control/);
  assert.match(rust, /"knowledge\.semantic_status"/);
  assert.match(rust, /"knowledge\.semantic_control"/);
});

test("Tauri startup wakes the durable semantic worker off the UI thread", () => {
  assert.match(lib, /wake_semantic_worker_on_startup/);
  assert.match(rust, /pub\(crate\) fn wake_semantic_worker_on_startup/);
  assert.match(rust, /std::thread::spawn/);
  assert.match(rust, /"semantic"\.to_string\(\).*"wake"\.to_string\(\)/s);
});

test("webview client keeps canonical status and controls typed", () => {
  assert.match(client, /packages\/knowledge-contracts\/src\/semantic\.js/);
  assert.match(client, /validateSemanticStatusResponse\(JSON\.parse\(raw\)\)/);
  assert.match(client, /validateSemanticControlResult\(JSON\.parse\(raw\)\)/);
  assert.match(client, /invoke<.*>\("knowledge_semantic_status"/s);
  assert.match(client, /invoke<.*>\("knowledge_semantic_control"/s);
  assert.match(client, /export type \{[\s\S]*SemanticControlAction[\s\S]*SemanticStatus/);
});

test("webview client lets an ambiguous transport retry reuse its operation token", async () => {
  const calls = [];
  const module = await loadKnowledgeClient(async (command, input) => {
    calls.push({ command, input });
    return JSON.stringify({
      accepted: true,
      action: input.action,
      scopeKey: input.scopeKey,
      generationId: input.generationId,
      operationToken: input.operationToken,
      status: validStatus,
    });
  });
  const operationToken = "ambiguous-retry-operation";

  await module.knowledgeSemanticControl("pause", "repo:repo", undefined, { operationToken });
  await module.knowledgeSemanticControl("pause", "repo:repo", undefined, { operationToken });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.input.operationToken), [operationToken, operationToken]);
});

test("reindex emits both foreground and semantic status refresh events", () => {
  assert.match(rust, /knowledge-index-progress/);
  assert.match(rust, /knowledge-semantic-status-changed/);
});

test("concurrent semantic replays use unique transport correlation IDs", () => {
  assert.match(rust, /"operationToken": operation_token/);
  assert.match(rust, /"knowledge\.semantic_control",\s*input,\s*\/\/[^]*?None,/s);
  assert.doesNotMatch(rust, /"knowledge\.semantic_control",\s*input,\s*Some\(operation_token\)/s);
});
