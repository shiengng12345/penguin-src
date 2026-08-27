import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  hashHookTarget,
  loadHookSessionState,
  readBoundedHookInput,
  renderSessionStart,
  runClaudeHook,
  saveHookSessionState,
  selectPromptTarget,
  selectPromptTargets,
} from "../packages/knowledge-cli/dist/claude-hook.js";

test("Claude prompt hook selects only explicit code targets", () => {
  assert.equal(selectPromptTarget("hello, summarize this idea"), null);
  assert.equal(
    selectPromptTarget("who calls BpAccountClosureService.closeAccount?"),
    "BpAccountClosureService.closeAccount",
  );
  assert.equal(
    selectPromptTarget("trace grpc::ResponsibleGamingInternalService.CloseAccount"),
    "grpc::ResponsibleGamingInternalService.CloseAccount",
  );
  assert.equal(
    selectPromptTarget("check /api/player/register please"),
    "/api/player/register",
  );
  assert.equal(
    selectPromptTarget("review src/auth/login.service.ts"),
    "src/auth/login.service.ts",
  );
});

test("SessionStart hook is compact and bounded", () => {
  const text = renderSessionStart(
    {
      summary: {
        totalRepos: 2,
        fresh: 1,
        dirty: 1,
        stale: 0,
        unknown: 0,
        errors: 0,
      },
      repos: [
        {
          repo: "auth",
          liveBranch: "main",
          freshness: "fresh",
          dirtyFileCount: 0,
          indexedCommit: "abc",
          headCommit: "abc",
          parserVersion: "v4",
          indexErrorCount: 0,
        },
        {
          repo: "risk",
          liveBranch: "feature",
          freshness: "dirty",
          dirtyFileCount: 2,
          indexedCommit: "def",
          headCommit: "def",
          parserVersion: "v4",
          indexErrorCount: 0,
        },
      ],
    },
    120,
  );
  assert.match(text, /^\[Penguin index context\]/);
  assert.ok(text.length <= 120);
});

test("UserPromptSubmit runs at most one bounded context query", async () => {
  const calls = [];
  const text = await runClaudeHook(
    {
      event: "user-prompt-submit",
      prompt: "check /api/player/register",
      maxChars: 90,
      timeoutMs: 100,
    },
    {
      runPenguin: async (args) => {
        calls.push(args);
        return exploreFixture("/api/player/register");
      },
    },
  );
  assert.deepEqual(calls, [["explore", "/api/player/register", "--json"]]);
  assert.ok(text.length <= 90);
});

test("Hook timeout degrades without blocking the agent session", async () => {
  const text = await runClaudeHook(
    {
      event: "session-start",
      timeoutMs: 5,
      maxChars: 100,
    },
    {
      runPenguin: () => new Promise(() => {}),
    },
  );
  assert.match(text, /unavailable/);
  assert.ok(text.length <= 100);
});

test("Hook stdin is rejected once its UTF-8 payload exceeds the byte limit", async () => {
  async function* withinLimit() {
    yield '{"prompt":"';
    yield "Service.run";
    yield '"}';
  }
  assert.equal(
    await readBoundedHookInput(withinLimit(), 64),
    '{"prompt":"Service.run"}',
  );

  async function* oversized() {
    yield "企鹅企鹅";
  }
  assert.equal(await readBoundedHookInput(oversized(), 8), null);
});

function exploreFixture(target = "Foo.run") {
  return {
    target,
    focus: { nodeId: "foo", title: target, nodeType: "symbol" },
    implementation: { nodeId: "foo", title: target, nodeType: "symbol" },
    callers: [{ nodeId: "caller", title: "Screen", nodeType: "symbol" }],
    calls: [{ nodeId: "callee", title: "save", nodeType: "symbol" }],
    callPath: [],
    blastRadius: [],
    tests: [],
    routes: [],
    provenance: [],
    confidence: { level: "high", minimum: 1, inferredEdges: 0, totalEdges: 1 },
    diagnostics: [],
    freshness: { stale: false, reason: null, indexedAt: "now", coverageGaps: [] },
    sources: [{
      nodeId: "foo",
      title: target,
      role: "focus",
      filePath: "src/foo.ts",
      startLine: 10,
      endLine: 12,
      lang: "ts",
      code: "export function run() {\n  return save();\n}",
      truncated: false,
    }],
    sourcesOmitted: ["caller Other (beyond top 3)"],
  };
}

test("UserPromptSubmit extracts all bounded explicit targets", () => {
  assert.deepEqual(
    selectPromptTargets("trace BpAccountClosureService.closeAccount and /api/player/register plus src/auth/login.service.ts"),
    ["BpAccountClosureService.closeAccount", "/api/player/register", "src/auth/login.service.ts"],
  );
});

test("UserPromptSubmit queries Explore and renders verbatim source as Markdown", async () => {
  const calls = [];
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "inspect Foo.run", maxChars: 6_000 },
    { runPenguin: async (args) => { calls.push(args); return exploreFixture(); } },
  );
  assert.deepEqual(calls, [["explore", "Foo.run", "--json"]]);
  assert.match(text, /```ts/);
  assert.match(text, /src\/foo\.ts:10-12/);
  assert.match(text, /export function run/);
  assert.doesNotMatch(text, /"sources"\s*:/);
});

test("repeated session target emits relations without repeating full source", async () => {
  const text = await runClaudeHook(
    {
      event: "user-prompt-submit",
      sessionId: "s1",
      seenTargets: new Set(["Foo.run"]),
      prompt: "inspect Foo.run",
    },
    { runPenguin: async () => exploreFixture() },
  );
  assert.match(text, /already provided|relations/i);
  assert.doesNotMatch(text, /export function run/);
  assert.match(text, /Screen/);
});

test("hook session state persists only bounded target hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-hook-state-"));
  const sessionId = "session-secret-value";
  const target = "Foo.run";
  const state = loadHookSessionState(dir, sessionId, 1_000);
  state.targetHashes.add(hashHookTarget(target));
  saveHookSessionState(dir, sessionId, state, 1_000);

  const restored = loadHookSessionState(dir, sessionId, 1_001);
  assert.ok(restored.targetHashes.has(hashHookTarget(target)));
  const raw = readFileSync(restored.path, "utf8");
  assert.doesNotMatch(raw, /session-secret-value|Foo\.run/);
  assert.match(raw, /targetHashes/);
});
