# Round 12 Penguin Knowledge Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Penguin reliable for Claude/Codex multi-step knowledge workflows by guaranteeing identifier round-trips, complete endpoint flows, explicit coverage semantics, and verified MCP/CLI parity.

**Architecture:** Keep one canonical public node-identity resolver shared by CLI, MCP, endpoint inventory, context, flow, callers, callees, and affected queries. Add contract-level integration tests that execute a returned identifier in the next command. Treat MCP availability as an explicit environment gate and report unavailable as `N/A`, never as an unexplained product failure.

**Tech Stack:** TypeScript, Node.js, SQLite, existing knowledge-core/knowledge-cli packages, MCP server, Vitest/Jest conventions already used by the repository.

**Spec:** `docs/quality/index-evaluation-brief.md`; failure evidence: `docs/quality/index-evaluation-codex-round12.md`.

## Global Constraints

- Do not release or modify signing/Tauri release configuration.
- Do not make negative claims when coverage is incomplete; return `not proven` with machine-readable diagnostics.
- Preserve repository scope and indexed revision across every continuation query.
- Every emitted public node ID must be accepted by all documented follow-up commands.
- Re-index only the requested test repository and record freshness/coverage evidence.

---

### Task 1: Establish failing round-trip contract tests

**Files:**
- Create or modify: `packages/knowledge-cli/src/__tests__/round12-contracts.test.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`

**Interfaces:**
- Consumes: endpoint inventory, filesymbols, search, and deadcode JSON responses.
- Produces: tests proving `node:<id>` is accepted by `context`, `flow`, `callers`, `callees`, and `affected` under the same `--repo` scope.

- [ ] **Step 1: Write tests that capture IDs from `endpoints`, `filesymbols`, and `search`.** Assert every ID is non-empty and includes repository/revision metadata.
- [ ] **Step 2: Execute each captured ID through every follow-up query.** Assert the result is not `no_match` or `not_indexed` when the source record is fresh.
- [ ] **Step 3: Add an endpoint-specific test.** Assert `endpoints → endpoint identity → context → flow` resolves the same canonical endpoint.
- [ ] **Step 4: Run the focused tests and confirm the current implementation fails at the known endpoint/node boundary.**

Run: `rtk pnpm vitest run packages/knowledge-cli/src/__tests__/round12-contracts.test.ts`

Expected: FAIL reproducing the Round 12 node-ID failures before implementation changes.

---

### Task 2: Centralize public node-ID resolution

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `packages/knowledge-cli/src/__tests__/round12-contracts.test.ts`

**Interfaces:**
- Produces: one resolver accepting `node:<id>`, canonical endpoint identity, qualified symbol, and path-qualified symbol while preserving `repoId` and indexed revision.

- [ ] **Step 1: Define a shared resolver result** containing `nodeId`, `repoId`, `revisionId`, `kind`, and canonical locator.
- [ ] **Step 2: Route context, flow, callers, callees, and affected through that resolver.** Do not let each command parse node IDs independently.
- [ ] **Step 3: Reject cross-repository and stale-revision IDs with structured errors** containing `code`, `message`, expected scope, and received scope.
- [ ] **Step 4: Make endpoint nodes with null symbol repository fields resolve through the endpoint’s indexed repository scope.**
- [ ] **Step 5: Run the focused contract tests and then the package typecheck.**

Run: `rtk pnpm vitest run packages/knowledge-cli/src/__tests__/round12-contracts.test.ts && rtk pnpm run typecheck`

Expected: PASS; all returned IDs are consumable by documented follow-up commands.

---

### Task 3: Repair endpoint-to-flow evidence

**Files:**
- Modify: `packages/knowledge-core/src/data-flow.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `packages/knowledge-cli/src/__tests__/round12-contracts.test.ts`

- [ ] **Step 1: Add a test asserting endpoint flow contains endpoint, handler, service, repository/data boundary, and test candidates when indexed.**
- [ ] **Step 2: Implement endpoint-node normalization before flow graph traversal.**
- [ ] **Step 3: Return the first unresolved boundary explicitly with `edgeState: unresolved` and a locator, instead of returning only `not_indexed`.**
- [ ] **Step 4: Preserve `handled`/`missing`/`incomplete` endpoint status and include the handler node ID used by flow.**
- [ ] **Step 5: Re-run endpoint flow tests against a fresh FPMS-NT index.**

Run: `rtk pnpm vitest run packages/knowledge-cli/src/__tests__/round12-contracts.test.ts`

Expected: endpoint ID round-trip succeeds; genuinely missing edges remain clearly unresolved rather than being mistaken for absent behavior.

---

### Task 4: Make coverage and negative-result semantics consistent

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-core/src/evidence-state.ts`
- Test: `packages/knowledge-cli/src/__tests__/coverage-contracts.test.ts`

- [ ] **Step 1: Add tests for `discovered`, `admitted`, `excluded`, `failed`, `stale`, and `unresolvedReferences` in every query response.**
- [ ] **Step 2: Ensure human output contains `not proven` whenever `coverage.complete` is false, `totalIsExact` is false, or unresolved references are non-zero.**
- [ ] **Step 3: Ensure positive results retain locator, revision, freshness, and evidence state even when coverage is incomplete.**
- [ ] **Step 4: Ensure deadcode, empty search, and missing-handler results cannot emit “unused”, “absent”, or “no handler” as proven facts under incomplete coverage.**
- [ ] **Step 5: Run schema migration/readback tests and focused CLI tests.**

Run: `rtk pnpm vitest run packages/knowledge-cli/src/__tests__/coverage-contracts.test.ts`

Expected: all incomplete results carry consistent coverage fields and human-readable proof limits.

---

### Task 5: Verify and expose MCP/CLI parity

**Files:**
- Inspect/modify: `packages/knowledge-cli/src/query-server.ts`
- Inspect/modify: `packages/knowledge-cli/src/query-protocol.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Create or modify: `scripts/knowledge-mcp-parity-test.mjs`
- Modify: `docs/quality/index-evaluation-brief.md`

- [ ] **Step 1: Add a capability health command that reports MCP server path, version/build ID, exposed tools, and readiness.**
- [ ] **Step 2: Make MCP and CLI use the same request/response contract and node resolver.**
- [ ] **Step 3: Add parity tests for search, context, flow, endpoints, pagination, invalid cursor, and negative-result responses.**
- [ ] **Step 4: Change the evaluation rule so unavailable MCP is `N/A: environment unavailable`, while an available MCP with mismatched behavior is a real parity failure.**
- [ ] **Step 5: Run the parity script in a fresh process and save raw evidence without credentials or private source dumps.**

Run: `rtk node scripts/knowledge-mcp-parity-test.mjs`

Expected: either all tested operations match, or the report identifies the exact operation/schema/error mismatch.

---

### Task 6: Add a tested onboarding handoff workflow

**Files:**
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `docs/quality/index-evaluation-brief.md`
- Modify or create: `scripts/knowledge-retest-round12.mjs`

- [ ] **Step 1: Add one copyable example:** `status → coverage → search --repo → filesymbols → context node:<id> → flow node:<id> → affected node:<id>`.
- [ ] **Step 2: Include required scope, revision, freshness, and fallback fields in each handoff response.**
- [ ] **Step 3: Make the retest runner execute real independent Q1–Q16 and B1–B5 scenarios, not aliases to one smoke command.**
- [ ] **Step 4: Fail the runner when a named scenario is skipped, when output is not JSON where required, or when evidence is missing.**
- [ ] **Step 5: Run the runner in a new process/session and verify the generated report lists every scenario.**

Run: `rtk pnpm run knowledge:retest:round12`

Expected: a complete report with no silently skipped scenarios and a reproducible agent handoff path.

---

### Task 7: Fresh-index regression and Round 13 gate

**Files:**
- Modify only if needed: `docs/quality/index-evaluation-brief.md`
- Create: `docs/quality/index-evaluation-codex-round13.md`
- Create: `docs/quality/index-evaluation-claude-round13.md` when Claude is available

- [ ] **Step 1: Build the current CLI/MCP artifacts and record the build identifier.**
- [ ] **Step 2: Re-index only FPMS-NT `brazil-v2`; record indexed commit, discovered/admitted/excluded/failed/stale/unresolved counts.**
- [ ] **Step 3: Start a new CLI process and a new MCP session.**
- [ ] **Step 4: Execute every Q1–Q16 and B1–B5 scenario using fresh identifiers from that same session.**
- [ ] **Step 5: Score CLI-only and MCP-enabled results separately; do not mix MCP outage with product capability score.**
- [ ] **Step 6: Do not claim completion unless endpoint/node-ID round-trip, coverage semantics, MCP parity, pagination, and negative-result safety all have direct evidence.**

Run: `rtk pnpm tauri build` only if the tested artifact is the Tauri bundle; otherwise use the documented local CLI/MCP build command.

Expected gate: no `no_match`/`not_indexed` for fresh emitted IDs, MCP parity is pass or explicitly environment-blocked, and all incomplete claims say `not proven`.

---

## Self-review checklist

- [ ] Every Round 12 deduction has a corresponding task.
- [ ] The plan separates product failures from MCP environment unavailability.
- [ ] Each task has a focused test or evidence gate.
- [ ] No release/signing work is included.
- [ ] A fresh session, fresh index, and complete Q1–Q16/B1–B5 retest are required before rescoring.
