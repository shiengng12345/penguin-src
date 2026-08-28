import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  hashHookTarget,
  loadHookSessionState,
  readBoundedHookInput,
  renderExploreHookCompact,
  renderSessionStart,
  runClaudeHook,
  saveHookSessionState,
  selectPromptTarget,
  selectPromptTargets,
} from "../packages/knowledge-cli/dist/claude-hook.js";

test("bare camelCase and snake_case identifiers are prompt targets; prose words are not", () => {
  assert.deepEqual(selectPromptTargets("who calls buildStatusPanel?"), ["buildStatusPanel"]);
  assert.deepEqual(selectPromptTargets("trace RepoStatusPanel and resolve_branch_base"), ["RepoStatusPanel", "resolve_branch_base"]);
  assert.equal(selectPromptTarget("please summarize the meeting notes for today"), null);
});

test("compact mode drops targets that resolved to nothing (prose false positives)", async () => {
  const empty = {
    ...exploreFixture("GitHub"),
    focus: null,
    implementation: null,
    callers: [],
    calls: [],
    sources: [],
    blastRadius: [],
    diagnostics: ["\"GitHub\" not indexed"],
  };
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "push it to GitHub please" },
    { runPenguin: async () => empty },
  );
  assert.equal(text, "");
});

test("ambiguous-only pack renders one line without node ids", async () => {
  const ambiguous = {
    ...exploreFixture("GitHub"),
    focus: null,
    implementation: null,
    callers: [],
    calls: [],
    sources: [],
    blastRadius: [],
    diagnostics: ["ambiguous target: 18 matches"],
    ambiguousCandidates: Array.from({ length: 18 }, (_, i) => ({ nodeId: `node_${i}`, title: "github", filePath: "x", branch: "main" })),
  };
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "push it to GitHub" },
    { runPenguin: async () => ambiguous },
  );
  assert.match(text, /"GitHub" is ambiguous \(18 matches\)/);
  assert.doesNotMatch(text, /node_/);
  assert.ok(text.length < 200);
});

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

test("UserPromptSubmit --full renders verbatim source as Markdown", async () => {
  const calls = [];
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "inspect Foo.run", maxChars: 6_000, mode: "full" },
    { runPenguin: async (args) => { calls.push(args); return exploreFixture(); } },
  );
  assert.deepEqual(calls, [["explore", "Foo.run", "--json"]]);
  assert.match(text, /```ts/);
  assert.match(text, /src\/foo\.ts:10-12/);
  assert.match(text, /export function run/);
  assert.doesNotMatch(text, /"sources"\s*:/);
});

test("repeated session target (--full) emits relations without repeating full source", async () => {
  const text = await runClaudeHook(
    {
      event: "user-prompt-submit",
      sessionId: "s1",
      seenTargets: new Set(["Foo.run"]),
      prompt: "inspect Foo.run",
      mode: "full",
    },
    { runPenguin: async () => exploreFixture() },
  );
  assert.match(text, /already provided|relations/i);
  assert.doesNotMatch(text, /export function run/);
  assert.match(text, /Screen/);
});

test("UserPromptSubmit defaults to compact: pointers + signature, never source bodies", async () => {
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "inspect Foo.run" },
    { runPenguin: async () => exploreFixture() },
  );
  // Signature line and location survive; the body and code fences do not.
  assert.match(text, /compact/);
  assert.match(text, /src\/foo\.ts:10-12/);
  assert.match(text, /export function run\(\)/);
  assert.doesNotMatch(text, /```/);
  assert.doesNotMatch(text, /return save\(\)/);
  assert.match(text, /callers\(1\): Screen/);
  assert.match(text, /calls\(1\): save/);
  // Tells the agent where the full source lives.
  assert.match(text, /knowledge_explore|penguin explore/);
  assert.ok(text.length <= 2_000, `compact stayed within budget (${text.length})`);
});

test("compact rendering surfaces call path, blast radius, tests, and ui relations", () => {
  const pack = {
    ...exploreFixture("Pay.charge"),
    callPath: [
      { depth: 0, nodeId: "a", title: "Route", nodeType: "endpoint", via: "root" },
      { depth: 1, nodeId: "b", title: "Pay.charge", nodeType: "symbol", via: "calls" },
      { depth: 2, nodeId: "c", title: "Ledger.write", nodeType: "symbol", via: "calls" },
    ],
    blastRadius: Array.from({ length: 7 }, (_, i) => ({ nodeId: `n${i}`, title: `Dep${i}`, nodeType: "symbol" })),
    tests: [{ nodeId: "t", title: "pay.test.ts", nodeType: "test" }],
    renderedBy: [{ nodeId: "u", title: "CheckoutPage", nodeType: "component" }],
  };
  const text = renderExploreHookCompact("Pay.charge", pack);
  assert.match(text, /call path: Route → Pay\.charge → Ledger\.write/);
  assert.match(text, /blast radius\(7\): Dep0, Dep1, Dep2, Dep3, Dep4 \(\+2 more\)/);
  assert.match(text, /tests\(1\): pay\.test\.ts/);
  assert.match(text, /rendered-by:CheckoutPage/);
});

test("compact rendering respects the character budget on oversized packs", () => {
  const pack = {
    ...exploreFixture("Big.run"),
    callers: Array.from({ length: 50 }, (_, i) => ({ nodeId: `c${i}`, title: `VeryLongCallerName${i}`, nodeType: "symbol" })),
    diagnostics: ["x".repeat(2_000)],
  };
  const text = renderExploreHookCompact("Big.run", pack, 2_000);
  assert.ok(text.length <= 2_000);
  assert.match(text, /callers\(50\):.*\(\+45 more\)/);
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
