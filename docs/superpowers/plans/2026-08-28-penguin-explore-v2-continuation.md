# Penguin Explore v2 Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved Explore v2 continuation as one step toward Penguin fully replacing understandanything, CodeGraph, and Graphify: correct package resolution, deliver bounded multi-target source context, add TSX relations, keep Wiki graph-first, and prove CLI/MCP parity without weakening freshness or safety guarantees.

**Architecture:** Keep `knowledge-core` as the source of truth. The hook is a bounded adapter over `explore`, storing only hashed target metadata when a Claude session id is available; it never stores prompt text or indexes code. TSX relations are extracted as explicit, low-confidence typed edges and remain separate from ordinary static calls. The Wiki keeps graph and relation inspection as its human surface while MCP/CLI carry the richer AI payload.

**Tech Stack:** TypeScript/Node.js, SQLite/better-sqlite3, tree-sitter TSX extraction, Rust/Tauri-managed settings, MCP stdio JSON-RPC, Node test runner.

**Spec:** `docs/superpowers/plans/2026-07-13-penguin-agent-trust-distribution.md` plus the approved Explore v2/P1 handoff in the current task context.

## Global Constraints

- Work in `/Users/shieng/Desktop/Pengvi` and preserve all pre-existing user changes.
- Do not reset, stash, delete, commit, push, tag, or release.
- Every production behavior follows RED → verify failure → minimal GREEN → verify pass.
- Every shell command is prefixed with `rtk`.
- Hooks are local-only, bounded, opt-in, and never persist prompt text, credentials, or source copies.
- Existing CLI/MCP result fields remain backward compatible; additions are additive and diagnostics stay explicit.
- Never guess between ambiguous symbols, packages, repositories, or branches.
- Inferred TSX edges must carry their provenance/confidence and must not be treated as ordinary extracted calls.

## Current status (2026-08-28)

Tasks 1-5 are implemented and their focused tests/typecheck are green. Task 6's
structured MCP parser, search-shape normalization, bundle, unit tests, doctor,
status, and diff checks are complete. The real-repository benchmark is
intentionally still red: the current local index reports only 3/21 shadow repos
and misses several existing dynamic/cross-repository golden relations. This is
evidence for the replacement backlog, not a reason to weaken the oracle or claim
full replacement.

---

### Task 1: Fix reviewed package resolution ambiguity and test the two boundaries

**Files:**

- Modify: `packages/knowledge-cli/src/call-command.ts`
- Modify: `packages/knowledge-core/src/package-query.ts`
- Create: `tests/call-command.test.mjs`
- Modify: `tests/knowledge-package-query.test.mjs`

**Interfaces:**

- `runCallCommand` continues to accept an explicit `--package` override.
- Automatic grpc-web package resolution returns a package only for an exact conventional match or one unique normalized candidate.
- Package dependency queries return an explicit ambiguity result instead of silently selecting a same-title service from another repository.

- [ ] **Step 1: Write failing tests for ambiguous package and service resolution**

Add tests that exercise real functions, not mocked call counts:

```js
test("call package resolution rejects multiple fuzzy package matches", async () => {
  const result = await runCallCommand(
    ["player", "Service", "Method", "--url", "https://example.test", "--json"],
    callDepsWithInstalled(["@snsoft/player-grpc-web-a", "@snsoft/player-grpc-web-b"]),
  );
  assert.equal(result, 1);
  assert.match(errors.join("\\n"), /matches several installed packages/);
});

test("package dependency subject does not silently choose a duplicate service title", () => {
  const result = packageDependencies(storeWithServicesNamed("shared"), {
    subject: "shared", direction: "dependencies", transitive: false, maxDepth: 5, limit: 100,
  });
  assert.equal(result.status, "subject_ambiguous");
  assert.equal(result.nodes.length, 0);
});
```

The fixture must also prove exact `@snsoft/player-grpc-web` matching still wins and explicit `--package` bypasses discovery.

- [ ] **Step 2: Run the new tests and confirm RED**

Run:

```bash
rtk npm run knowledge:bundle
rtk test node --test tests/call-command.test.mjs tests/knowledge-package-query.test.mjs
```

Expected: the package query currently returns a same-title service and the call command currently accepts an unsafe fuzzy selection or cannot be exercised with an injected package list.

- [ ] **Step 3: Implement minimal deterministic resolution**

Keep the call command's exact conventional package check. Normalize only package scope/name separators for comparison, collect candidates by a bounded explicit rule, and throw on more than one candidate. In `package-query.ts`, resolve exact id/identity first, then collect title matches; return `subject_ambiguous` with candidate identities rather than `LIMIT 1` selection. Preserve `subject_not_found` and existing successful result shapes for unique subjects.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run the same command from Step 2 and verify exit code 0 with both ambiguity regressions and all existing package-query tests passing.

- [ ] **Step 5: Run the focused diff check**

```bash
rtk git diff --check -- packages/knowledge-cli/src/call-command.ts packages/knowledge-core/src/package-query.ts tests/call-command.test.mjs tests/knowledge-package-query.test.mjs
```

Expected: no whitespace errors.

---

### Task 2: Upgrade UserPromptSubmit to bounded multi-target Explore output

**Files:**

- Modify: `packages/knowledge-cli/src/claude-hook.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-cli/src/bin.ts`
- Modify: `tests/knowledge-claude-hook.test.mjs`
- Modify: `tests/knowledge-cli.test.mjs`

**Interfaces:**

- Add `selectPromptTargets(prompt: string): string[]`; retain `selectPromptTarget` as a compatibility wrapper returning the first target or `null`.
- Extend `ClaudeHookOptions` with `sessionId?: string` and `seenTargets?: ReadonlySet<string>`.
- Add `renderExploreHook(target, pack, options)` that renders Markdown source blocks, relation summaries, ambiguity candidates, freshness, and explicit omissions.
- `runClaudeHook` calls `explore <target> --json` for at most four distinct targets concurrently under one 800ms UserPromptSubmit budget.

- [ ] **Step 1: Write failing hook tests**

Cover these independent behaviors:

```js
test("UserPromptSubmit extracts all bounded explicit targets", () => {
  assert.deepEqual(
    selectPromptTargets("trace BpAccountClosureService.closeAccount and /api/player/register plus src/auth/login.service.ts"),
    ["BpAccountClosureService.closeAccount", "/api/player/register", "src/auth/login.service.ts"],
  );
});

test("UserPromptSubmit uses Explore and renders verbatim source as markdown", async () => {
  const calls = [];
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "inspect Foo.run", maxChars: 6_000 },
    { runPenguin: async (args) => { calls.push(args); return exploreFixture("Foo.run"); } },
  );
  assert.deepEqual(calls, [["explore", "Foo.run", "--json"]]);
  assert.match(text, /```ts/);
  assert.match(text, /Foo\.run/);
  assert.doesNotMatch(text, /"sources"\s*:/);
});

test("repeated session target emits relations without repeating full source", async () => {
  const text = await runClaudeHook(
    { event: "user-prompt-submit", sessionId: "s1", seenTargets: new Set(["Foo.run"]), prompt: "inspect Foo.run" },
    { runPenguin: async () => exploreFixture("Foo.run") },
  );
  assert.match(text, /already provided|relations/i);
  assert.doesNotMatch(text, /function Foo/);
});
```

Also test four-target capping, explicit `sourcesOmitted`, empty/no-target no-op, and timeout degradation.

- [ ] **Step 2: Run the hook tests and confirm RED**

```bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-claude-hook.test.mjs tests/knowledge-cli.test.mjs
```

Expected: the multi-target export/rendering behavior is absent and the existing test expecting `context` instead of `explore` fails.

- [ ] **Step 3: Implement target extraction and Markdown rendering**

Extract matches in priority order `grpc::qualified`, source filename, dotted identifier, and route. Deduplicate exact target strings and cap at four. Render one bounded section per target, with focus/implementation source first, fenced code using the source language, line ranges, caller/callee titles, diagnostics, and `sourcesOmitted`. If a target is ambiguous, render candidate node ids and do not include guessed source. Keep JSON out of the hook output.

- [ ] **Step 4: Implement one shared timeout and compatibility wrapper**

Run target queries concurrently with one deadline. The first four results are rendered in deterministic input order. Retain `selectPromptTarget` and all SessionStart behavior. A timeout or query error returns the existing bounded unavailable marker without throwing.

- [ ] **Step 5: Run hook tests and confirm GREEN**

Run the command from Step 2. Verify the new tests and the existing SessionStart, stdin-bound, and timeout tests all pass.

---

### Task 3: Persist only hashed session metadata and wire Claude stdin safely

**Files:**

- Modify: `packages/knowledge-cli/src/claude-hook.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-cli/src/bin.ts`
- Modify: `tests/knowledge-cli.test.mjs`
- Modify: `tests/knowledge-claude-hook.test.mjs`

**Interfaces:**

- Add a bounded `HookSessionStateStore` that stores `{sessionHash, targetHashes, updatedAt}` only.
- State is keyed by a SHA-256 session hash under `~/.penguin/knowledge/hook-sessions/`; raw session ids and prompt text never reach disk.
- Malformed, oversized, expired, or unwritable state degrades to no dedupe and never blocks the hook.

- [ ] **Step 1: Write failing state/privacy tests**

Prove a first invocation records only a target hash, a second invocation suppresses its source, a different session gets full source, and the serialized files contain neither the raw prompt nor raw session id.

- [ ] **Step 2: Run the tests and confirm RED**

```bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-claude-hook.test.mjs tests/knowledge-cli.test.mjs
```

- [ ] **Step 3: Implement atomic bounded metadata storage**

Use `mkdirSync(..., { recursive: true })`, a temporary file in the same directory, and `renameSync` for the state write. Keep at most 128 target hashes and discard state older than 24 hours. Do not store source, prompt, URL, headers, or credentials.

- [ ] **Step 4: Parse bounded Claude event input**

For UserPromptSubmit, accept only JSON string `prompt` and optional string `session_id`; reject malformed or oversized input with exit code 0. Pass only the parsed values to the hook. Existing hooks without a session id remain functional and emit full bounded source.

- [ ] **Step 5: Run tests and inspect state contents**

```bash
rtk test node --test tests/knowledge-claude-hook.test.mjs tests/knowledge-cli.test.mjs
rtk git diff --check -- packages/knowledge-cli/src/claude-hook.ts packages/knowledge-cli/src/command-dispatch.ts packages/knowledge-cli/src/bin.ts tests/knowledge-claude-hook.test.mjs tests/knowledge-cli.test.mjs
```

Expected: tests pass, diff check is clean, and the privacy assertion finds no prompt text or raw session id.

---

### Task 4: Add explicit TSX render/callback relation edges

**Files:**

- Modify: `packages/knowledge-indexer/src/extractor.ts`
- Modify: `packages/knowledge-indexer/src/resolver.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `tests/knowledge-indexer-extract.test.mjs`
- Modify: `tests/knowledge-indexer-pipeline.test.mjs`
- Modify: `tests/knowledge-query.test.mjs`

**Interfaces:**

- TSX extraction emits structured refs for JSX component usage and callback props.
- Resolver persists `renders` and `invokes_dynamic` edges with `origin="parser"`, method `INFERRED`, and explicit confidence below 1.0.
- Existing `calls` edges and TypeScript behavior remain unchanged.

- [ ] **Step 1: Write failing TSX extraction tests**

Use a real TSX source fixture:

```js
const source = [
  "function Screen() {",
  "  return <ProfileCard onSave={saveProfile} />;",
  "}",
  "function saveProfile() {}",
  "function ProfileCard() {}",
].join("\\n");
const out = await extractSymbols({ lang: "tsx", relPath: "screen.tsx", source });
assert.ok(out.refs.some((ref) => ref.kind === "jsx-component" && ref.rawName === "ProfileCard"));
assert.ok(out.refs.some((ref) => ref.kind === "jsx-callback" && ref.rawName === "saveProfile"));
```

Add a pipeline assertion that the two edges are distinct from `calls` and carry `INFERRED` provenance.

- [ ] **Step 2: Run extractor/pipeline tests and confirm RED**

```bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-indexer-extract.test.mjs tests/knowledge-indexer-pipeline.test.mjs
```

- [ ] **Step 3: Implement conservative TSX refs**

Capture capitalized JSX identifiers and `{identifier}` callback props only when the identifier is statically available. Ignore member expressions, spread props, strings, and lowercase intrinsic DOM tags. Attach the enclosing symbol so the resolver can create edges without guessing a target file.

- [ ] **Step 4: Resolve and persist typed inferred edges**

Resolve component/callback names with the existing unique-symbol rules. If resolution is ambiguous, retain an unresolved diagnostic/ref and create no edge. Persist `renders` and `invokes_dynamic` with confidence `0.5` and ensure graph provenance reports them as inferred.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the command from Step 2 plus:

```bash
rtk test node --test tests/knowledge-query.test.mjs
```

Expected: existing calls/route/gRPC tests remain green and the new TSX edge assertions pass.

---

### Task 5: Keep the human Wiki surface graph-first

**Files:**

- Modify: `src/components/wiki/WikiPage.tsx`
- Modify: `src/components/wiki/WikiContextPane.tsx`
- Modify: `src/components/wiki/WikiFlowPane.tsx`
- Modify: `tests/wiki-page.test.mjs`

**Interfaces:**

- Human Wiki view exposes one focus search, graph, relation pane, and freshness/trust badge.
- Rich source packs, diagnostics, MCP search, and SLS/evidence operations remain available through AI/CLI surfaces.
- Existing deep links to graph focus and relation nodes continue to resolve.

- [ ] **Step 1: Write failing UI assertions**

Assert the default Wiki render includes graph/relation controls and does not render the removed human-facing Search/Context/SLS tab labels, while the underlying graph focus and relation callbacks remain present.

- [ ] **Step 2: Run the UI test and confirm RED**

```bash
rtk npm run typecheck
rtk test node --test tests/wiki-page.test.mjs
```

- [ ] **Step 3: Implement the smallest graph-first projection**

Keep the existing graph data and state stores. Change only the default navigation/visible panes; do not delete MCP capabilities or query-core fields. Surface stale/dirty trust on the graph header so a human can see whether the relation view is current.

- [ ] **Step 4: Run UI tests and confirm GREEN**

Run the same commands from Step 2 and verify unrelated Wiki page tests remain green.

---

### Task 6: Repair MCP/benchmark structured-output parity and run all gates

**Files:**

- Modify: `scripts/penguin-mcp-client.mjs`
- Modify: `scripts/knowledge-real-repo-benchmark.mjs`
- Modify: `tests/knowledge-real-repo-benchmark.test.mjs`
- Modify: `tests/knowledge-mcp-tools.test.mjs`
- Modify: `.codex/penguin-replacement-validation-and-fix.md`

**Interfaces:**

- The local MCP client prefers `structuredContent` when present and falls back to parsing a JSON text content block; a human summary such as `182 hits · lanes source` is a typed protocol failure, not a graph result.
- Real benchmark output separates index correctness, CLI/MCP parity, and unavailable MCP transport/runtime failures.

- [ ] **Step 1: Add failing parser/parity tests**

Test a response containing both summary text and structured JSON, a response containing JSON text only, and a response containing summary text only. The first two must parse; the last must fail with a diagnostic naming the missing structured result.

- [ ] **Step 2: Run tests and confirm RED**

```bash
rtk test node --test tests/knowledge-real-repo-benchmark.test.mjs tests/knowledge-mcp-tools.test.mjs
```

- [ ] **Step 3: Implement structured-content preference and explicit failure**

Normalize the MCP envelope in one helper. Never parse the short human content summary as graph JSON. Keep error text bounded and exclude credentials/prompt content.

- [ ] **Step 4: Run the focused quality gates**

```bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-query.test.mjs tests/knowledge-claude-hook.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-indexer-extract.test.mjs tests/knowledge-indexer-pipeline.test.mjs tests/wiki-page.test.mjs
rtk npm run typecheck
rtk npm run knowledge:benchmark
rtk npm run knowledge:benchmark:universal
```

- [ ] **Step 5: Run real benchmark and classify remaining evidence**

```bash
rtk npm run knowledge:benchmark:real
```

Report separately: index/search/flow correctness, CLI/MCP parity, coverage exclusions, freshness warnings, and any installed MCP transport error. Do not label a harness failure as an index failure.

- [ ] **Step 6: Final read-only checks**

```bash
rtk penguin doctor
rtk penguin status
rtk git diff --check
rtk git status --short
```

Confirm no source reset occurred, no unrelated user change was removed, and no completion claim is made for a gate that did not produce fresh evidence.

---

## Completion Checklist

- [ ] Package and service resolution never silently guesses across multiple candidates.
- [ ] P2 hook emits multi-target Markdown Explore context within a shared timeout and bounded character budget.
- [ ] Session dedupe stores only hashed metadata and never prompt/source text.
- [ ] TSX render/callback edges are conservative, typed, inferred, and provenance-visible.
- [ ] Wiki human surface is graph/relation-first; AI capabilities remain intact.
- [ ] MCP structured output is parsed from `structuredContent` or JSON text only.
- [ ] Fixture, universal, focused regression, typecheck, and real benchmark results are reported separately with fresh evidence.
