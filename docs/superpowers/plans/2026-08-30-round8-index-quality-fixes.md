# Round 8 Index Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Raise Round 8 index quality from 88/100 by making completeness, endpoint diagnostics, negative claims, and retesting evidence explicit and machine-verifiable.

**Architecture:** Keep one shared contract in `knowledge-core`, expose it consistently through CLI/MCP/UI payloads, and validate behavior with fixture tests plus a fresh FPMS-NT bundle retest. Do not infer completeness from an output list alone; derive it from bounded queries, persisted coverage metadata, and explicit pagination.

**Tech Stack:** TypeScript, SQLite, Node test runner, Penguin CLI/MCP, pnpm, Tauri.

---

### Task 1: Make result completeness authoritative

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/store.ts` if coverage aggregation belongs at storage level
- Test: `tests/knowledge-query.test.mjs`

- [ ] Add a bounded-count helper that queries `limit + 1` rows and returns `{ rows, candidateCount, totalIsExact }`; never report an exact total when the query was capped.
- [ ] Use that helper in graph, callers, callees, dead-code and endpoint inventory paths.
- [ ] Set `completeness` to `complete` only when the count is exact, `partial` when capped, and `unknown` when index coverage is incomplete.
- [ ] Merge `result_limit_reached`, parser gaps, stale state and unresolved-reference gaps without dropping any reason.
- [ ] Add tests for zero rows, fewer-than-limit rows, exactly-limit rows, and limit-plus-one rows.
- [ ] Run: `rtk test tests/knowledge-query.test.mjs`.

### Task 2: Add structured endpoint missing-handler diagnostics

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-cli.test.mjs`
- Modify: `docs/knowledge-v2/cli-reference.md`

- [ ] Extend endpoint output with `handlerStatus: "handled" | "missing" | "incomplete"` and `missingHandlerReason`.
- [ ] Return `missing` only when endpoint indexing is complete for the selected repo/protocol and no active `handles` edge exists.
- [ ] Return `incomplete` when parser, scope or coverage gaps prevent a definitive missing-handler conclusion.
- [ ] Add fixture tests for handled, missing-with-complete-coverage and incomplete cases.
- [ ] Update generated/reference docs and run `rtk pnpm knowledge:docs:check`.

### Task 3: Prove endpoint identity equivalence in one command

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-cli.test.mjs`

- [ ] Add an endpoint identity comparison operation accepting rendered title, canonical gRPC identity and node ID.
- [ ] Resolve all forms to one endpoint node or return an explicit mismatch/ambiguous result.
- [ ] Include `rootNodeId`, `parentNodeId`, form-by-form resolution status and equality boolean.
- [ ] Test title, canonical identity, node ID, unknown identity and protocol mismatch.
- [ ] Run the endpoint comparison against the current FPMS-NT bundle.

### Task 4: Persist and expose unresolved-reference coverage

**Files:**
- Modify: `packages/knowledge-indexer/src/extract.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Test: `tests/knowledge-quality-benchmark.test.mjs`

- [ ] Count unresolved calls/references per file, branch and repository during extraction.
- [ ] Store the counts in the existing coverage metadata path without changing confirmed edge semantics.
- [ ] Surface counts in `status`, `coverage`, `onboarding`, `explore` and negative-result diagnostics.
- [ ] Preserve callback attribution and existing `EXTRACTED`/`ASSERTED`/`INFERRED` trust rules.
- [ ] Add regression tests proving callback and external-call behavior does not regress.
- [ ] Run the quality benchmark and verify no synthetic callback owner is invented.

### Task 5: Add cursor pagination for large inventories

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-cli.test.mjs`
- Modify: `docs/knowledge-v2/cli-reference.md`

- [ ] Add stable cursor fields based on `(filePath, startLine, nodeId)` for dead-code, filesymbols and endpoints.
- [ ] Accept `--cursor` and return `nextCursor`, `returnedCount`, `candidateCount` and `totalIsExact`.
- [ ] Reject cursors from a different repo/branch/query scope instead of silently restarting.
- [ ] Test page continuity, duplicate avoidance, exhausted cursor and invalid cursor.
- [ ] Document pagination examples.

### Task 6: Add a repeatable Round 8 evidence command

**Files:**
- Create: `scripts/knowledge-retest-round8.mjs`
- Modify: `package.json`
- Test: `tests/knowledge-cli.test.mjs`
- Create: `docs/quality/index-evaluation-gpt-5-round9.md` after execution

- [ ] Implement a read-only runner that executes Q1–Q14 and B1–B4 using only the current CLI bundle.
- [ ] Save exact commands, exit codes, JSON evidence, bundle path, scope, freshness, coverage, counts and timing.
- [ ] Fail the runner when a scenario is skipped, source/answer-key input is used, or required metadata is absent.
- [ ] Add `pnpm knowledge:retest:round8` and a test for command selection/metadata validation.
- [ ] Run it in a new process and write a new report without overwriting Round 8.

### Task 7: Full verification and release build

**Files:**
- Modify only files required by Tasks 1–6.

- [ ] Run `rtk test`.
- [ ] Run `rtk pnpm typecheck`.
- [ ] Run `rtk pnpm knowledge:bundle`.
- [ ] Run `rtk pnpm knowledge:docs:check`.
- [ ] Run `rtk pnpm knowledge:parity` and require `mismatchCount: 0`.
- [ ] Run `rtk penguin doctor` and require ledger/materialized equality.
- [ ] Run `rtk pnpm tauri build`.
- [ ] Record signing failure separately if `TAURI_SIGNING_PRIVATE_KEY` is unavailable; do not call the release fully signed.
- [ ] Run `rtk git diff --check` and review the final status.

## Self-review

- Accuracy: Tasks 1–4 address false exactness, endpoint handler ambiguity and unresolved references.
- Completeness: Tasks 1, 4 and 5 address totals, coverage and pagination.
- Honesty: Tasks 1, 2 and 4 prevent unsupported negative claims.
- Usability: Tasks 3, 5 and 6 reduce manual comparison and retest setup.
- Release confidence: Task 7 covers code, bundle, parity, index health and packaging.
