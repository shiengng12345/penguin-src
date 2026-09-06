import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { EmbeddingLifecycle, KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, createEmbeddingSpace } from "../packages/knowledge-core/dist/index.js";
import { QueryWorkerPool } from "../packages/knowledge-cli/dist/query-server.js";

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-query-runtime-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const repoId = store.registerRepo({ name: "runtime-fixture", rootPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({
    snapshotKey: "runtime-main",
    repoId,
    parserVersion: "runtime-test",
    resolverVersion: "runtime-test",
    schemaVersion: 13,
  });
  const raw = Buffer.from("export const ResidentNeedle = true;\n", "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store);
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString("utf8"), encoding: "utf8" });
  const fact = source.putSourceFact({
    repoId,
    filePath: "src/runtime.ts",
    factFingerprint: hash,
    contentHash: hash,
    sourceBlobId: blob,
    coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" },
  });
  store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(repoId, "src/runtime.ts", "tracked", "admitted", "text_searchable", "source", raw.length, "ok", new Date().toISOString());
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/runtime.ts", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  const space = createEmbeddingSpace(store, {
    providerId: "fixture",
    modelId: "query-runtime",
    weightsDigest: "a".repeat(64),
    tokenizerDigest: "b".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "v1",
  });
  new EmbeddingLifecycle(store).createGeneration({
    spaceId: space.id,
    snapshotId: snapshot.id,
    scopeKey: `repo:${repoId}`,
    expectedChunks: 1,
  });
  store.close();
  return { dir, dbPath, ledgerPath, snapshotId: snapshot.id, repoId };
}

function createFrameReader(child) {
  let buffer = "";
  const frames = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      const waiter = waiters.find((candidate) => !candidate.predicate || candidate.predicate(frame));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      } else frames.push(frame);
    }
  });
  const next = (predicate, timeoutMs = 5000) => {
    const queued = frames.findIndex((frame) => !predicate || predicate(frame));
    if (queued >= 0) return Promise.resolve(frames.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((candidate) => candidate.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for query runtime frame"));
      }, timeoutMs);
      waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
    });
  };
  return { next };
}

test("resident query runtime speaks JSONL and returns real source search results", async () => {
  const fixture = createFixture();
  const child = spawn(process.execPath, ["packages/knowledge-cli/dist/bin.js", "__query-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: fixture.dbPath, PENGUIN_KNOWLEDGE_LEDGER: fixture.ledgerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createFrameReader(child);
  try {
    const hello = await reader.next((frame) => frame.type === "hello");
    assert.equal(hello.protocolVersion, 1);
    assert.equal(typeof hello.capabilityHash, "string");
    assert.equal(hello.schemaVersion, 18);

    child.stdin.write(JSON.stringify({ type: "request", id: "caps", capabilityId: "knowledge.capabilities", input: {} }) + "\n");
    const capabilities = await reader.next((frame) => frame.id === "caps");
    assert.equal(capabilities.ok, true);
    assert.equal(capabilities.result.capabilityHash, hello.capabilityHash);
    assert.ok(capabilities.result.capabilities.some((item) => item.id === "knowledge.search"));

    const operationToken = "query-runtime-operation";
    child.stdin.write(JSON.stringify({ type: "request", id: "semantic-control", capabilityId: "knowledge.semantic_control", input: {
      action: "pause",
      scopeKey: `repo:${fixture.repoId}`,
      operationToken,
    } }) + "\n");
    const controlled = await reader.next((frame) => frame.id === "semantic-control");
    assert.equal(controlled.ok, true);
    assert.equal(controlled.result.operationToken, operationToken);
    assert.equal(controlled.result.status.scopeKey, `repo:${fixture.repoId}`);

    child.stdin.write(JSON.stringify({ type: "request", id: "semantic-replay", capabilityId: "knowledge.semantic_control", input: {
      action: "pause",
      scopeKey: `repo:${fixture.repoId}`,
      operationToken,
    } }) + "\n");
    const replayed = await reader.next((frame) => frame.id === "semantic-replay");
    assert.equal(replayed.ok, true);
    assert.equal(replayed.result.operationToken, operationToken);

    child.stdin.write(JSON.stringify({ type: "request", id: "semantic-conflict", capabilityId: "knowledge.semantic_control", input: {
      action: "resume",
      scopeKey: `repo:${fixture.repoId}`,
      operationToken,
    } }) + "\n");
    const conflict = await reader.next((frame) => frame.id === "semantic-conflict");
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "OPERATION_TOKEN_CONFLICT");

    child.stdin.write(JSON.stringify({ type: "request", id: "compat", capabilityId: "knowledge.cli", input: { args: ["status", "--json"] } }) + "\n");
    const compat = await reader.next((frame) => frame.id === "compat");
    assert.equal(compat.ok, true);
    assert.ok(Array.isArray(compat.result.repos));

    child.stdin.write(JSON.stringify({ type: "request", id: "search", capabilityId: "knowledge.search", input: {
      query: "ResidentNeedle",
      mode: "exact",
      scope: { revisions: [{ repoId: fixture.repoId, snapshotId: fixture.snapshotId }] },
      page: { limit: 10 },
    } }) + "\n");
    const search = await reader.next((frame) => frame.id === "search");
    assert.equal(search.ok, true);
    assert.equal(search.result.hits.length, 1);
    assert.equal(search.result.hits[0].locator.filePath, "src/runtime.ts");
    assert.equal(search.result.hits[0].evidence[0].status, "verified");
    for (const phase of ["scopeResolution", "count", "candidateSelection", "hydration", "evidence", "serialization", "total"]) {
      assert.equal(typeof search.result.diagnostics.timingsMs[phase], "number", `missing timing phase ${phase}`);
      assert.ok(search.result.diagnostics.timingsMs[phase] >= 0, `negative timing phase ${phase}`);
    }

    child.stdin.write(JSON.stringify({ type: "request", id: "bad-cursor", capabilityId: "knowledge.search", input: {
      query: "ResidentNeedle",
      mode: "exact",
      scope: { revisions: [{ repoId: fixture.repoId, snapshotId: fixture.snapshotId }] },
      page: { limit: 10, cursor: "not-a-real-cursor" },
    } }) + "\n");
    const badCursor = await reader.next((frame) => frame.id === "bad-cursor");
    assert.equal(badCursor.ok, false);
    assert.equal(badCursor.error.code, "CURSOR_INVALID");

    child.stdin.write(JSON.stringify({ type: "request", id: "bad-schema", capabilityId: "knowledge.search", input: {
      query: "ResidentNeedle",
      mode: "not-a-supported-mode",
      page: { limit: 10 },
    } }) + "\n");
    const badSchema = await reader.next((frame) => frame.id === "bad-schema");
    assert.equal(badSchema.ok, false);
    assert.equal(badSchema.error.code, "INVALID_SEARCH_REQUEST");

    child.stdin.write(JSON.stringify({ type: "request", id: "bad-scope", capabilityId: "knowledge.semantic_status", input: {
      scopeKey: "repo-that-does-not-exist",
    } }) + "\n");
    const badScope = await reader.next((frame) => frame.id === "bad-scope");
    assert.equal(badScope.ok, false);
    assert.equal(badScope.error.code, "SCOPE_NOT_FOUND");

    child.stdin.write(JSON.stringify({ type: "request", id: "hit", capabilityId: "knowledge.get_hit", input: {
      snapshotId: fixture.snapshotId,
      filePath: "src/runtime.ts",
      startLine: 1,
    } }) + "\n");
    const hit = await reader.next((frame) => frame.id === "hit");
    assert.equal(hit.ok, true);
    assert.match(hit.result.snippet, /ResidentNeedle/);

    child.stdin.write("not-json\n");
    const malformed = await reader.next((frame) => frame.id === "unknown");
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, "MALFORMED_FRAME");

    child.stdin.write(JSON.stringify({ type: "request", id: "unsupported", capabilityId: "knowledge.not_real", input: {} }) + "\n");
    const unsupported = await reader.next((frame) => frame.id === "unsupported");
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, "CAPABILITY_NOT_IMPLEMENTED");

    child.stdin.write(JSON.stringify({ type: "cancel", id: "cancelled" }) + "\n");
    child.stdin.write(JSON.stringify({ type: "request", id: "cancelled", capabilityId: "knowledge.search", input: { query: "ResidentNeedle", mode: "exact" } }) + "\n");
    const cancelled = await reader.next((frame) => frame.id === "cancelled");
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.code, "CANCELLED");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("query timeout is a typed actionable error with budget and requested scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-query-timeout-"));
  const workerPath = join(dir, "slow-worker.cjs");
  writeFileSync(workerPath, [
    "const { parentPort } = require('node:worker_threads');",
    "parentPort.on('message', (request) => { const deadline = Date.now() + 100; while (Date.now() < deadline) {} });",
  ].join("\n"));
  const pool = new QueryWorkerPool({
    dbPath: join(dir, "unused.db"),
    ledgerPath: join(dir, "unused.jsonl"),
    workerUrl: pathToFileURL(workerPath),
    size: 1,
    timeoutMs: 10,
  });
  const input = {
    query: "ResidentNeedle",
    scope: { revisions: [{ repoId: "repo-timeout", snapshotId: "snapshot-timeout" }] },
    page: { limit: 3 },
  };
  try {
    await assert.rejects(pool.run("knowledge.search", input), (error) => {
      assert.equal(error.code, "QUERY_TIMEOUT");
      assert.equal(error.details.capability, "knowledge.search");
      assert.equal(typeof error.details.elapsedMs, "number");
      assert.ok(error.details.elapsedMs >= error.details.budgetMs);
      assert.equal(error.details.budgetMs, 10);
      assert.deepEqual(error.details.scope, input.scope);
      assert.match(error.details.nextAction, /retry/i);
      assert.match(error.remediation, /scope|limit/i);
      return true;
    });
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resident query runtime exits after repeated framing corruption", async () => {
  const fixture = createFixture();
  const child = spawn(process.execPath, ["packages/knowledge-cli/dist/bin.js", "__query-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: fixture.dbPath, PENGUIN_KNOWLEDGE_LEDGER: fixture.ledgerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createFrameReader(child);
  try {
    await reader.next((frame) => frame.type === "hello");
    child.stdin.write("bad-1\nbad-2\nbad-3\n");
    const status = await new Promise((resolve) => child.once("close", (_code, signal) => resolve({ code: child.exitCode, signal })));
    assert.equal(status.code, 1);
  } finally {
    if (!child.killed) child.kill();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("resident runtime serves 100 warm queries from one child process", async () => {
  const fixture = createFixture();
  const started = performance.now();
  const child = spawn(process.execPath, ["packages/knowledge-cli/dist/bin.js", "__query-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: fixture.dbPath, PENGUIN_KNOWLEDGE_LEDGER: fixture.ledgerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createFrameReader(child);
  try {
    await reader.next((frame) => frame.type === "hello");
    const coldMs = performance.now() - started;
    const pid = child.pid;
    const warmStarted = performance.now();
    for (let index = 0; index < 100; index += 1) {
      child.stdin.write(JSON.stringify({ type: "request", id: `warm-${index}`, capabilityId: "knowledge.search", input: {
        query: "ResidentNeedle", mode: "exact", scope: { revisions: [{ repoId: fixture.repoId, snapshotId: fixture.snapshotId }] }, page: { limit: 1 },
      } }) + "\n");
      const response = await reader.next((frame) => frame.id === `warm-${index}`);
      assert.equal(response.ok, true);
      assert.equal(response.result.hits[0].locator.filePath, "src/runtime.ts");
    }
    const warmMs = performance.now() - warmStarted;
    assert.equal(child.pid, pid);
    assert.ok(coldMs >= 0 && warmMs >= 0);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("resident runtime can be replaced after a child crash without reusing the dead pid", async () => {
  const fixture = createFixture();
  const spawnRuntime = () => spawn(process.execPath, ["packages/knowledge-cli/dist/bin.js", "__query-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: fixture.dbPath, PENGUIN_KNOWLEDGE_LEDGER: fixture.ledgerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const first = spawnRuntime();
  const firstReader = createFrameReader(first);
  try {
    await firstReader.next((frame) => frame.type === "hello");
    const deadPid = first.pid;
    first.kill("SIGKILL");
    await new Promise((resolve) => first.once("close", resolve));
    const replacement = spawnRuntime();
    const replacementReader = createFrameReader(replacement);
    try {
      await replacementReader.next((frame) => frame.type === "hello");
      assert.notEqual(replacement.pid, deadPid);
      replacement.stdin.write(JSON.stringify({ type: "request", id: "after-restart", capabilityId: "knowledge.search", input: {
        query: "ResidentNeedle", mode: "exact", scope: { revisions: [{ repoId: fixture.repoId, snapshotId: fixture.snapshotId }] }, page: { limit: 1 },
      } }) + "\n");
      const response = await replacementReader.next((frame) => frame.id === "after-restart");
      assert.equal(response.ok, true);
      assert.equal(response.result.hits[0].locator.filePath, "src/runtime.ts");
    } finally {
      replacement.stdin.end();
      await new Promise((resolve) => replacement.once("close", resolve));
    }
  } finally {
    if (!first.killed) first.kill();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("cold startup is measured and SIGTERM leaves no resident runtime process", async () => {
  const fixture = createFixture();
  const started = performance.now();
  const child = spawn(process.execPath, ["packages/knowledge-cli/dist/bin.js", "__query-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: fixture.dbPath, PENGUIN_KNOWLEDGE_LEDGER: fixture.ledgerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createFrameReader(child);
  try {
    await reader.next((frame) => frame.type === "hello");
    const coldStartupMs = performance.now() - started;
    assert.ok(coldStartupMs >= 0);
    const pid = child.pid;
    child.kill("SIGTERM");
    const status = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.ok(status.signal === "SIGTERM" || status.code === 0);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
