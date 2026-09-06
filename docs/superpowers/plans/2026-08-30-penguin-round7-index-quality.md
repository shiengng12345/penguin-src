# Penguin Round 7 Index Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development. Execute each task with tests and do not treat partial graph data as complete.

**Goal:** Remove the remaining Round 7 usability and trust gaps so normal CLI queries accept human-readable repository/branch paths, graph results expose complete evidence status, and endpoint inventory is directly queryable.

**Architecture:** Centralize target and revision resolution before dispatching commands. Reuse one structured diagnostics envelope across CLI and MCP graph responses. Add a first-class endpoint inventory query built from indexed endpoint nodes and their `handles`/`invokes` edges; preserve explicit gaps when parser or external-package coverage is incomplete.

**Tech Stack:** TypeScript, Node.js, SQLite, Penguin CLI, existing Node test suite.

---

## Task 1: Add regression fixtures for Round 7 failures

**Files:**
- Test: `tests/knowledge-cli.test.mjs`
- Test: `tests/knowledge-query.test.mjs`
- Test: `tests/knowledge-repo-scope.test.mjs`

- [ ] Add fixtures with a named repo and branch, duplicate symbol names across repositories, one path-qualified symbol, one endpoint, and incomplete coverage metadata.
- [ ] Assert that `filesymbols <repo-name> <branch-name> <path>` resolves without requiring an opaque branch ID.
- [ ] Assert that `path#symbol` and `repo:path#symbol` resolve exactly one node and reject repo/path mismatch.
- [ ] Assert that callers/calls/impact return locations, `completeness`, `coverageGaps`, `candidateCount`, and `truncated`.
- [ ] Assert that an incomplete empty result is marked non-definitive rather than equivalent to verified empty.

## Task 2: Normalize CLI repository and branch resolution

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:150-270, 1940-2070`
- Modify: `packages/knowledge-core/src/query-scope.ts:136-250` if shared normalization belongs there
- Test: `tests/knowledge-cli.test.mjs`, `tests/knowledge-repo-scope.test.mjs`

- [ ] Make `files`, `filesymbols`, `architecture`, `communities`, `deadcode`, `context`, `flow`, `callers`, and `calls` accept repo names, repo IDs, branch names, and branch IDs consistently.
- [ ] Resolve the repository first, then resolve the branch within that repository; never interpret a branch name as a repository selector.
- [ ] Return a structured scope error containing accepted repo/branch names and the resolved scope.
- [ ] Remove command-specific branch parsing that forces callers to discover opaque IDs.
- [ ] Add CLI help examples using human-readable forms.

## Task 3: Finish the shared graph diagnostics contract

**Files:**
- Modify: `packages/knowledge-core/src/query.ts:768-905, 1550-1910, 2450-2710`
- Modify: `packages/knowledge-core/src/search-engine.ts:260-305`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:1770-1910`
- Test: `tests/knowledge-query.test.mjs`, `tests/knowledge-core-search.test.mjs`, `tests/knowledge-cli.test.mjs`

- [ ] Add `candidateCount`, `totalIsExact`, and `truncated` to callers, calls, context, impact, and explore results, not only deadcode/search.
- [ ] Make `completeness.status` explicit for every graph result: `complete`, `lower_bound`, `partial`, or `unknown`.
- [ ] Include `coverageGaps` for callback bodies, constructor/interface/static dispatch, unresolved external calls, excluded files, failed files, and stale versions.
- [ ] Use `null` for data not inspected; reserve empty arrays for verified empty relationships.
- [ ] Render a visible `PARTIAL`/`LOW_CONFIDENCE` warning in text mode and preserve the same fields in JSON/MCP.
- [ ] Add both caller definition location and call-site location where available; never label a definition line as the call site.

## Task 4: Make negative claims and deadcode safe

**Files:**
- Modify: `packages/knowledge-core/src/query.ts:3179-3305`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:1880-1910`
- Test: `tests/knowledge-query.test.mjs`, `tests/knowledge-quality-benchmark.test.mjs`

- [ ] Set `totalIsExact=false` whenever relevant coverage is excluded, failed, stale, unresolved, or pagination-limited.
- [ ] Make `deadcode` always say “candidate” and include callback-body, DI, reflection, dynamic import, framework entry-point, and public entry-point caveats.
- [ ] Make no-callers/no-tests/no-match results refuse definitive wording when coverage is incomplete.
- [ ] Add complete machine-readable pagination and exact totals; make text mode show the selected page and continuation information.
- [ ] Add regression tests for the `apps/admin` callback/test-helper false-positive pattern.

## Task 5: Add first-class endpoint inventory

**Files:**
- Modify: `packages/knowledge-core/src/query.ts` near architecture/endpoint helpers
- Modify: `packages/knowledge-cli/src/command-dispatch.ts` command list and dispatch table
- Modify: `packages/knowledge-core/src/index.ts` exports
- Test: `tests/knowledge-cli.test.mjs`, `tests/knowledge-query.test.mjs`, `tests/knowledge-indexer-routes.test.mjs`
- Docs: `docs/knowledge-v2/cli-reference.md`

- [ ] Add `endpoints [repo] [--protocol rest|grpc|kafka]` returning endpoint node ID, protocol, route/service/method, repo, branch, handler, handler location, and related tests.
- [ ] Scope endpoint queries by repo/revision while retaining global gRPC identity and clearly showing cross-repo consumers.
- [ ] Report unresolved handlers, missing tests, and external downstream calls as gaps rather than silently omitting them.
- [ ] Make `flow` accept the endpoint node ID, canonical endpoint key, and returned route/service-method string interchangeably.
- [ ] Add tests for one HTTP endpoint, one gRPC endpoint, duplicate endpoint names, and an endpoint with an unresolved handler.

## Task 6: Improve onboarding and flow truthfulness

**Files:**
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `packages/knowledge-core/src/query.ts:2271-2400, 2774-2815`
- Test: `tests/knowledge-cli.test.mjs`, `tests/knowledge-quality-benchmark.test.mjs`
- Docs: `docs/knowledge-v2/cli-reference.md`

- [ ] Link onboarding endpoint entries to the new endpoint inventory and include qualified file locations, related tests, and configuration gaps where indexed.
- [ ] Replace unqualified hub titles with `filePath:line` or node IDs.
- [ ] Ensure onboarding reports its exact repository/branch/revision scope and whether counts are exact.
- [ ] Ensure flow renders only parent-linked steps; if parent information is unavailable, render depth layers with an explicit partial warning.
- [ ] Add a regression test proving endpoint-title and node-ID flow outputs represent the same tree.

## Task 7: Model callback ownership without polluting normal symbol results

**Files:**
- Modify: `packages/knowledge-indexer/src/extract.ts`
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Test: `tests/knowledge-indexer-pipeline.test.mjs`, `tests/knowledge-query.test.mjs`

- [ ] Represent anonymous callback ownership as provenance/nested scope metadata rather than a normal user-facing function candidate where possible.
- [ ] Preserve callback file/line, parent symbol, call references, test references, and stable identity.
- [ ] Ensure synthetic callback nodes are excluded from misleading architecture hub/deadcode rankings unless explicitly requested.
- [ ] Re-index a fixture containing Jest/Vitest callbacks, NestJS factories, promise handlers, and array callbacks.
- [ ] Assert no duplicate callback edges and no false “dead” result for callback-contained helpers.

## Task 8: Verify against a fresh Round 8 evaluation

**Files:**
- Test: `tests/knowledge-quality-benchmark.test.mjs`, `tests/knowledge-real-question-audit.test.mjs`
- Docs: `docs/quality/index-evaluation-brief.md`

- [ ] Run focused tests, complete knowledge tests, typecheck, and `penguin doctor`.
- [ ] Re-index the selected test repositories before evaluation and record revision/freshness.
- [ ] Execute every question and scenario in the current evaluation brief from a new session.
- [ ] Compare Round 7 and Round 8 separately for accuracy, completeness, honesty, usability, speed, and overall score.
- [ ] Do not claim completion if any endpoint inventory, scope, or negative-result gate remains unverified.

## Definition of done

- Human-readable repo/branch/path targets work across all graph and file commands.
- Every graph result exposes locations, completeness, coverage gaps, exactness, and truncation.
- Negative results cannot be presented as proof under incomplete coverage.
- `endpoints --repo` directly inventories REST/gRPC/other endpoints and integrates with flow.
- Onboarding and flow are scoped and structurally truthful.
- Callback references retain ownership and no longer create misleading deadcode/graph results.
- Focused tests, full tests, typecheck, doctor, and a fresh independent evaluation pass.
