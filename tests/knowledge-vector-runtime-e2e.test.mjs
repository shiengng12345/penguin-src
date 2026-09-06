import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CAPABILITIES, capabilityHash } from "../packages/knowledge-contracts/dist/index.js";
import { localEmbeddingSpaceIdentity } from "../packages/knowledge-core/dist/index.js";
import { McpSession, extractCliJson, mcpStructured, runCli } from "../scripts/knowledge-process-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const cliRoot = join(root, "packages/knowledge-cli/bundle");
const cli = join(cliRoot, "penguin.mjs");
const node = join(cliRoot, "node");
const mcp = join(root, "packages/mcp/bundle/dist/index.js");
const model = join(cliRoot, "models/nomic-embed-text-v1.5");

test("self-contained CLI and MCP share real persisted Nomic vectors", { skip: ![cli, node, mcp, model].every(existsSync), timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "penguin-vector-runtime-home-"));
  const repo = mkdtempSync(join(tmpdir(), "penguin-vector-runtime-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "errors.ts"), [
    "export function mapTransportFailure(error: Error) {",
    "  return { status: 503, message: 'Please retry later', cause: error.message };",
    "}",
    "",
  ].join("\n"));
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Penguin Test", GIT_AUTHOR_EMAIL: "penguin@example.invalid", GIT_COMMITTER_NAME: "Penguin Test", GIT_COMMITTER_EMAIL: "penguin@example.invalid" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  execFileSync("git", ["-C", repo, "add", "."], { env: gitEnv });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"], { env: gitEnv });
  const runtimeRoot = join(home, ".penguin", "runtimes");
  mkdirSync(runtimeRoot, { recursive: true });
  symlinkSync(cliRoot, join(runtimeRoot, "current"));
  const modelHash = localEmbeddingSpaceIdentity(model).identityHash;
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    ready: true,
    // `current` points at the checked-in bundle in this compact fixture.  The
    // launcher treats the root manifest as the legacy layout in that case,
    // therefore its build id must match the resolved generation basename.
    buildId: "bundle",
    appVersion: "1.16.0-test",
    capabilityHash: capabilityHash(CAPABILITIES),
    contractSchemaVersion: 18,
    contractVersion: "2",
    modelHash,
    nodePath: "node",
    cliEntry: "penguin.mjs",
    wasmPath: "wasm",
  }));
  const stableLauncher = join(home, "penguin-cli-launcher");
  writeFileSync(stableLauncher, `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(join(root, "scripts", "knowledge-cli-launcher.mjs"))} "$@"\n`);
  chmodSync(stableLauncher, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PENGUIN_RUNTIME_ROOT: runtimeRoot,
    PENGUIN_CLI_LAUNCHER: stableLauncher,
    PENGUIN_EMBEDDING_MODEL_DIR: model,
    PENGUIN_KNOWLEDGE_ALLOWED_ROOTS: repo,
    PENGUIN_WASM_DIR: join(cliRoot, "wasm"),
  };

  const preview = runCli({ node, bundle: cli, args: ["index", repo, "--dry-run", "--json"], cwd: repo, env, timeoutMs: 20_000 });
  assert.equal(preview.exitCode, 0, preview.stderr);
  const operationToken = extractCliJson(preview).operationToken;
  assert.match(operationToken, /^[a-f0-9]{32}$/);
  const indexed = runCli({ node, bundle: cli, args: ["index", repo, `--confirm=${operationToken}`, "--json"], cwd: repo, env, timeoutMs: 60_000 });
  assert.equal(indexed.exitCode, 0, `${indexed.stdout}\n${indexed.stderr}`);
  const indexReport = extractCliJson(indexed);
  assert.equal(indexReport.semantic.status, "queued", JSON.stringify(indexReport.semantic));
  let generationStatus = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = runCli({ node, bundle: cli, args: ["semantic", "status", "--json"], cwd: repo, env, timeoutMs: 10_000 });
    assert.equal(status.exitCode, 0, `${status.stdout}\n${status.stderr}`);
    generationStatus = extractCliJson(status).statuses.find((candidate) => candidate.generationId === indexReport.semantic.generationId) ?? null;
    if (generationStatus?.state === "active") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.equal(generationStatus?.state, "active", JSON.stringify(generationStatus));

  const query = "turn a low level outage into a friendly retry response";
  const searched = runCli({ node, bundle: cli, args: ["search", query, "--semantic=blend", "--json"], cwd: repo, env, timeoutMs: 30_000 });
  assert.equal(searched.exitCode, 0, `${searched.stdout}\n${searched.stderr}`);
  const cliResult = extractCliJson(searched);
  assert.ok(cliResult.hits.some((hit) => hit.lane === "vector"), JSON.stringify(cliResult.diagnostics));

  const session = new McpSession({ node, server: mcp, cwd: repo, env, label: "vector-runtime-e2e", timeoutMs: 30_000 });
  try {
    await session.initialize();
    const response = await session.callTool("knowledge_search", { query, mode: "semantic", options: { semantic: "blend" }, repo, limit: 10 });
    const result = mcpStructured(response);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(Array.isArray(result.hits), JSON.stringify(result));
    assert.ok(result.hits.some((hit) => hit.lane === "vector"), JSON.stringify(result.diagnostics));
  } finally {
    session.close();
  }
});
