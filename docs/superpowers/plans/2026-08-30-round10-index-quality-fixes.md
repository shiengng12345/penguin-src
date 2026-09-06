# Round 10 Index Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Raise the Round 10 score by making CLI contracts discoverable, endpoint node IDs reusable, coverage counts authoritative, and pagination/error behavior fully testable.

**Architecture:** Define one machine-readable command contract in the knowledge contracts package, reuse one endpoint resolver across `endpoints`, `flow`, `node`, and `endpoint-identity`, and expose coverage/pagination metadata through shared result types. Keep negative answers conservative whenever excluded/failed coverage or unresolved references remain.

**Tech Stack:** TypeScript, SQLite, Node test runner, Penguin CLI/MCP, pnpm, Tauri.

---

### Task 1: Publish CLI contracts and examples

**Files:** `packages/knowledge-contracts/src/`, `packages/knowledge-cli/src/command-dispatch.ts`, `docs/knowledge-v2/cli-reference.md`, `tests/knowledge-cli.test.mjs`

- [ ] Add schemas/examples for `endpoints`, `endpoint-identity`, `filesymbols`, `deadcode`, and cursor continuation, including positional arguments, flags, JSON shape, and exit codes.
- [ ] Make `help --json` return these contracts so a fresh session does not need prior knowledge.
- [ ] Add tests asserting every documented form is accepted and malformed forms return the documented code.
- [ ] Regenerate docs and require `rtk pnpm knowledge:docs:check`.

### Task 2: Unify endpoint identity resolution

**Files:** `packages/knowledge-core/src/query.ts`, `packages/knowledge-cli/src/command-dispatch.ts`, `packages/knowledge-mcp/src/` if exposed, `tests/knowledge-cli.test.mjs`

- [ ] Create one resolver accepting endpoint node ID, rendered title, canonical gRPC identity, and repo scope.
- [ ] Ensure an endpoint ID returned by `endpoints --json` resolves in `node`, `flow`, and `endpoint-identity`.
- [ ] Return structured `resolved`, `no_match`, `ambiguous`, and `protocol_mismatch` statuses instead of generic errors.
- [ ] Add fixture tests for all four forms and compare the same `rootNodeId`/`parentNodeId`.
- [ ] Run a live FPMS-NT endpoint round trip: inventory → node → flow → identity.

### Task 3: Complete endpoint handler semantics

**Files:** `packages/knowledge-core/src/query.ts`, `packages/knowledge-cli/src/command-dispatch.ts`, `tests/knowledge-cli.test.mjs`

- [ ] Derive handler status from coverage: `handled`, `missing`, `incomplete`, or `unknown`.
- [ ] Use `missing` only when endpoint/protocol coverage is complete and no active handler exists.
- [ ] Include `missingHandlerReason`, dynamic-wiring caveats, and coverage evidence in JSON and text.
- [ ] Test handled, generated-but-unresolved, excluded-file, and genuinely missing fixtures.

### Task 4: Finish coverage persistence and migration

**Files:** `packages/knowledge-core/src/schema.ts`, `packages/knowledge-indexer/src/pipeline.ts`, `packages/knowledge-core/src/status-panel.ts`, `packages/knowledge-core/src/query.ts`, `tests/knowledge-quality-benchmark.test.mjs`

- [ ] Ensure old schema-version-14 databases get the `unresolved_references` column on the writable open path without breaking read-only queries.
- [ ] Persist per-file counts and aggregate them by repo and branch; do not overwrite branch totals while indexing one file.
- [ ] Surface discovered/admitted/excluded/failed/stale and unresolved counts consistently in `coverage`, `status`, `onboarding`, and query diagnostics.
- [ ] Mark completeness unknown when excluded/failed files or unresolved references prevent absence proof.
- [ ] Add migration, incremental-index, rebuild, and callback/external-call regression tests.

### Task 5: Make cursor behavior proof-grade

**Files:** `packages/knowledge-core/src/query.ts`, `packages/knowledge-cli/src/command-dispatch.ts`, `tests/knowledge-cli.test.mjs`, `docs/knowledge-v2/cli-reference.md`

- [ ] Use stable `(filePath, startLine, nodeId)` ordering for all three inventories.
- [ ] Return `returnedCount`, `candidateCount`, `totalIsExact`, `nextCursor`, and an explicit exhausted state.
- [ ] Encode query scope, repo, branch, path and protocol in the cursor and reject mismatches with structured JSON errors.
- [ ] Distinguish invalid, exhausted, expired, and scope-mismatched cursors with stable exit codes.
- [ ] Test page continuity, no duplicates, exact exhaustion, invalid cursor, and protocol/path mismatch.

### Task 6: Upgrade the retest runner to cover every scenario

**Files:** `scripts/knowledge-retest-round8.mjs`, `package.json`, `tests/knowledge-cli.test.mjs`

- [ ] Replace the current smoke list with named Q1–Q15 and B1–B4 cases.
- [ ] For each case record command, expected/actual exit code, timing, scope, freshness, coverage, completeness, cursor and raw JSON evidence.
- [ ] Add assertions for endpoint round trip, all three pagination paths, invalid cursor, mismatch identity, and negative-result safety.
- [ ] Fail if a named case is skipped, uses an unexpected bundle, loses evidence, or overwrites an existing report.
- [ ] Generate `docs/quality/index-evaluation-gpt-5-round11.md` in a fresh process.

### Task 7: Full verification and release gate

- [ ] Run `rtk test`.
- [ ] Run `rtk pnpm typecheck`.
- [ ] Run `rtk pnpm knowledge:bundle`.
- [ ] Run `rtk pnpm knowledge:docs:check`.
- [ ] Run `rtk pnpm knowledge:parity` and require `mismatchCount: 0`.
- [ ] Run `rtk penguin doctor` and require ledger/materialized equality.
- [ ] Run the full Round 11 retest and inspect every named case.
- [ ] Run `rtk pnpm tauri build`; report compile, packaging, signing, and DMG failures separately.
- [ ] Run `rtk git diff --check`.

## Acceptance criteria

- A fresh session can discover every tested command from `help --json`.
- Every endpoint ID emitted by inventory works with `node`, `flow`, and identity comparison.
- Coverage counts agree at file/repo/branch scopes and no stale schema-gap warning remains after writable migration.
- All three inventories paginate without duplicates and reject wrong-scope cursors with JSON errors.
- Q1–Q15 and B1–B4 execute independently with no skipped case and produce a new Round 11 report.
