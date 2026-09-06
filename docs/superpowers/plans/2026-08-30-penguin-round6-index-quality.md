# Penguin Round 6 Index Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Penguin's graph and onboarding queries path-addressable, location-bearing, explicit about incomplete coverage, and safe for negative conclusions.

**Architecture:** Resolve a query target into a scoped revision and exact symbol before dispatching graph operations. Return one shared diagnostics envelope for freshness, coverage, completeness, pagination, and truncation, then let CLI/MCP renderers preserve the same contract. Keep parser/index improvements separate from query-surface fixes so each phase is independently testable.

**Tech Stack:** TypeScript, Node.js, SQLite-backed `knowledge-core`, Penguin CLI, existing `.mjs` Node test suite.

---

## Scope and priority

P0 fixes: path-qualified resolution, `file:line` call-site output, explicit partial/negative-result safety, and `node` scope/truncation behavior.

P1 fixes: stale-symbol reporting/repair, onboarding output, and dead-code explanations.

P2 follow-up: callback-body indexing and richer endpoint/flow modeling. Do not mix parser redesign into the P0 release.

## File map

- Modify `packages/knowledge-core/src/query.ts`: target resolution, graph result diagnostics, callers/calls locations, stale handling, dead-code safety, onboarding data.
- Modify `packages/knowledge-core/src/search-engine.ts`: coverage and negative-result contract shared with graph queries.
- Modify `packages/knowledge-cli/src/command-dispatch.ts`: parse `--path` / `repo:path#symbol`, scope `node`, render diagnostics and locations, render onboarding.
- Modify `packages/knowledge-core/src/query-scope.ts` or `packages/knowledge-core/src/revision.ts` only if target resolution cannot reuse the existing scope resolver.
- Add or extend `tests/knowledge-query.test.mjs`, `tests/knowledge-core-search.test.mjs`, `tests/knowledge-repo-scope.test.mjs`, `tests/knowledge-cli.test.mjs`, `tests/knowledge-path-search.test.mjs`, and `tests/knowledge-quality-benchmark.test.mjs`.
- Update `docs/knowledge-v2/cli-reference.md` and `docs/knowledge-v2/search-contract.md` with the final target and diagnostics contract.

### Task 1: Establish failing regression fixtures

**Files:**
- Test: `tests/knowledge-query.test.mjs`
- Test: `tests/knowledge-repo-scope.test.mjs`
- Test: `tests/knowledge-cli.test.mjs`

- [ ] Add fixtures containing two same-named symbols in different files/repos, one excluded file, one failed file, one stale symbol, and a caller inside a callback body.
- [ ] Add failing assertions that `repo:path#symbol` resolves only the requested definition, ambiguity reports candidate count, graph output contains `filePath` and `line`, and incomplete coverage cannot produce a definitive empty/no-callers result.
- [ ] Add a CLI regression asserting `node --repo FPMS-NT <name>` does not return candidates from other repositories and reports `truncated` plus the exact candidate count when capped.
- [ ] Run `rtk test node --test tests/knowledge-query.test.mjs tests/knowledge-repo-scope.test.mjs tests/knowledge-cli.test.mjs`; confirm failures are contract failures, not fixture setup failures.

### Task 2: Implement stable path-qualified target resolution

**Files:**
- Modify: `packages/knowledge-core/src/query.ts:97-210`
- Modify: `packages/knowledge-core/src/query-scope.ts:136-250` if needed
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:150-270, 1712-1880`
- Test: `tests/knowledge-query.test.mjs`, `tests/knowledge-repo-scope.test.mjs`, `tests/knowledge-cli.test.mjs`

- [ ] Parse the accepted forms `symbol`, `path#symbol`, and `repo:path#symbol`; normalize separators and reject paths outside the selected workspace/repo.
- [ ] Resolve the path first, then the symbol name within that file and revision; do not fall back to global same-name candidates when a path was supplied.
- [ ] Preserve the resolved `nodeId`, repo, branch, indexed commit, and resolution status in every graph response.
- [ ] For unresolved, ambiguous, and stale-only targets return distinct machine-readable statuses and actionable candidate metadata; never silently choose a node.
- [ ] Re-run the focused tests and confirm Q2/Q5/Q12-style targets resolve without a search → node-id detour.

### Task 3: Create one diagnostics/completeness envelope for graph results

**Files:**
- Modify: `packages/knowledge-core/src/query.ts:560-905, 905-1130, 3179-3260`
- Modify: `packages/knowledge-core/src/search-engine.ts:260-305`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:1779-1905, 1950-2060`
- Test: `tests/knowledge-query.test.mjs`, `tests/knowledge-core-search.test.mjs`, `tests/knowledge-cli.test.mjs`

- [ ] Define shared fields for `resolutionStatus`, `freshness`, `coverage`, `completeness`, `coverageGaps`, `candidateCount`, `totalIsExact`, and `truncated`.
- [ ] Mark callers/calls/impact/deadcode/context results as lower-bound or partial whenever unresolved references, excluded/failed/stale files, unmodelled callback/static/interface calls, or pagination affect the result.
- [ ] Render a visible `PARTIAL`/`LOW_CONFIDENCE` warning in text output while retaining structured fields for MCP/JSON consumers.
- [ ] Use `null` plus a coverage gap for data that was not inspected; reserve `[]` for a verified empty result.
- [ ] Ensure a negative result is non-definitive when coverage is incomplete, and add a suggestion to refresh/index before relying on absence.
- [ ] Run all focused tests and verify existing complete fixture results remain exact.

### Task 4: Fix node disambiguation, scoping, pagination, and locations

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:1712-1778, 1880-1905, 2030-2060`
- Modify: `packages/knowledge-core/src/query.ts:1232-1285` and graph caller/callee result builders
- Test: `tests/knowledge-cli.test.mjs`, `tests/knowledge-path-search.test.mjs`, `tests/knowledge-query.test.mjs`

- [ ] Make `node` honor `--repo` and branch/revision scope before ranking candidates; rank in-scope symbol definitions above out-of-scope fields and legacy repos.
- [ ] Report exact candidate totals and `truncated: true` whenever the display limit hides candidates; make the next-step message point to the correct scoped command.
- [ ] Add defining locations and call-site locations to callers/calls, preserving both the caller definition and the actual reference line.
- [ ] Add location-bearing text output to all graph commands by default, with JSON retaining the same fields.
- [ ] Add tests for `deleteMany`, `getCredit`, and `executeSuccess`-style ambiguity cases using path-qualified targets.

### Task 5: Correct stale-symbol and coverage semantics

**Files:**
- Modify: `packages/knowledge-core/src/query.ts:814-905, 1232-1285, 1455-1530`
- Modify: relevant index lifecycle code discovered from `markFileSymbolsStale` in `packages/knowledge-core/src/store.ts:521`
- Test: `tests/knowledge-query.test.mjs`, `tests/knowledge-indexer-pipeline.test.mjs`, `tests/knowledge-core-search.test.mjs`

- [ ] Distinguish parser artifacts/unresolvable local bindings from genuinely stale source versions; do not label a symbol stale solely because its callback binding lacks a symbol node.
- [ ] Make `filesymbols`, `explore`, and status use the same freshness vocabulary and explain the source of each stale count.
- [ ] Add a supported refresh/re-index path or explicit “no per-symbol repair” diagnostic for stale-only targets.
- [ ] Ensure coverage totals and stale counts are revision-scoped and do not mix duplicate repository registrations.
- [ ] Verify stale-only, advanced-branch, excluded-file, and failed-file tests independently.

### Task 6: Make deadcode safe and explain callback false positives

**Files:**
- Modify: `packages/knowledge-core/src/query.ts:3179-3260`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:1880-1905`
- Test: `tests/knowledge-query.test.mjs`, `tests/knowledge-quality-benchmark.test.mjs`

- [ ] Include callback-body usage, test blocks, DI/factory wiring, reflection, dynamic imports, and public entry points in `coverageGaps`/explanation text.
- [ ] Return dead-code candidates as candidates only; set `totalIsExact=false` when relevant files are excluded, failed, stale, or truncated.
- [ ] Add a machine-readable complete report mode with pagination and no silent 40-item display cap.
- [ ] Reproduce the `apps/admin` fixture where callback-contained test helpers are alive and assert they are not reported as proven dead.

### Task 7: Replace onboarding stub with scoped subsystem orientation

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:1559-1605`
- Modify: `packages/knowledge-core/src/query.ts` near repo architecture/graph helpers
- Test: `tests/knowledge-cli.test.mjs`, `tests/knowledge-quality-benchmark.test.mjs`
- Docs: `docs/knowledge-v2/cli-reference.md`

- [ ] Add scoped onboarding data for subsystems/apps, ranked HTTP/gRPC entry points, high-degree hubs with qualified file paths, configuration links, and related tests.
- [ ] Add an explicit `subsystems <repo>` command or fold equivalent output into onboarding; ensure `communities --repo` honors scope.
- [ ] Add endpoint enumeration for REST and gRPC nodes, with canonical route/node IDs accepted by `flow`.
- [ ] Make flow output either a real parent-linked tree or an explicitly layered graph; never render unrelated steps as parent-child.
- [ ] Add regression fixtures for `dailyShareMission`/`getLiveDrawEvents`-style endpoint traces and verify the first unmodelled edge is labeled.

### Task 8: Parser callback modeling and final benchmark gate

**Files:**
- Modify: parser/indexer files identified by the existing callback-body fixture; keep the change isolated from CLI formatting.
- Test: `tests/knowledge-indexer-pipeline.test.mjs`, `tests/knowledge-quality-benchmark.test.mjs`, `tests/knowledge-real-question-audit.test.mjs`

- [ ] Model callback-contained references as source occurrences or nested symbol scopes, preserving file/line and parent ownership.
- [ ] Re-index a controlled fixture and verify callback calls, test uses, factory references, and stale transitions are represented without duplicate edges.
- [ ] Run the universal/fixture benchmark and record separate verdicts for retrieval correctness, CLI/MCP parity, coverage, freshness, and real-corpus quality.
- [ ] Run `rtk test` for the complete knowledge suite, then `rtk tsc`/the repository typecheck command.
- [ ] Update the Round 6 report with before/after scores and an explicit list of remaining lower-bound limitations.

## Definition of done

- Every graph command accepts a stable path-qualified target and emits scope, freshness, completeness, and location data.
- Empty/no-caller/dead-code results are never presented as definitive when coverage is incomplete.
- `node` cannot silently cross repository scope or hide the requested candidate behind an unmarked cap.
- Onboarding and flow outputs are scoped and structurally truthful.
- Focused regressions, the full knowledge test suite, typecheck, and the quality benchmark pass; any remaining parser limitations are explicitly reported.

