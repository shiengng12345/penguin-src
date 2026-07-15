import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readBoundedHookInput,
  renderSessionStart,
  runClaudeHook,
  selectPromptTarget,
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
        return { focus: { title: "register" }, callers: [{ title: "controller" }] };
      },
    },
  );
  assert.deepEqual(calls, [["context", "/api/player/register", "--json"]]);
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
