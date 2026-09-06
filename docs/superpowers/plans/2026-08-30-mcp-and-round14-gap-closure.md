# MCP and Round 14 Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a freshly installed Penguin reliably expose the same, current Knowledge capabilities to Claude Desktop, Claude Code, and Codex, then close the CLI contract and index-integrity gaps identified by Round 14.

**Architecture:** Keep `~/.penguin/bin/penguin-mcp` as the only client-facing executable and make it resolve the current verified generation. Add an observable MCP handshake/health contract so “configured”, “server starts”, and “new client session loaded the server” are separate states. Normalize target identity, evidence envelopes, scope, revision, and cursor behavior in shared knowledge-core/contract code so CLI and MCP use the same implementation.

**Tech Stack:** Rust/Tauri (`src-tauri`), TypeScript/Node.js, MCP SDK, SQLite knowledge graph, TOML/JSON client configuration, Node test runner, pnpm, Tauri bundle.

**Spec:** `/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-codex-gpt-5-round14-fresh.md`

## Global Constraints

- Preserve the canonical client command `/Users/shieng/.penguin/bin/penguin-mcp`; never write a versioned runtime path into Claude/Codex configuration.
- Do not claim MCP parity or runtime reload until a real MCP stdio process has completed `initialize`, `tools/list`, `mcp_health`, and at least one Knowledge query.
- Every negative, partial, lower-bound, stale, unresolved, or externally dispatched result remains `not_proven` unless the graph explicitly provides a closed set.
- Every test must retain repository, branch, revision, freshness, coverage, completeness, and proof metadata where the operation can produce them.
- Do not modify user credentials, unrelated client servers, existing reports, or indexed repository contents during diagnostics.
- Run the required tests before `pnpm tauri build`; run a fresh-client validation after installing the generated app.

---

### Task 1: Reproduce and classify the MCP session boundary

**Files:**
- Create: `scripts/knowledge-mcp-session-diagnostic.mjs`
- Modify: `scripts/knowledge-process-utils.mjs`
- Test: `packages/mcp/src/__tests__/round13-mcp-contracts.test.ts`

**Interfaces:**
- Consumes: `~/.penguin/bin/penguin-mcp`, `McpSession`, `mcp_health`, `knowledge_capabilities`.
- Produces: a redacted diagnostic record with `configuredCommand`, `launcherTarget`, `initialize`, `tools/list`, `mcp_health`, `capabilityHash`, `runningBuildId`, `availableBuildId`, and a typed failure class.

- [ ] **Step 1: Write the failing diagnostic assertions**

  Add assertions that a real spawned launcher process must return a JSON-RPC initialize result with `serverInfo.name === "penguin-mcp"`, a non-empty `tools/list`, and an `mcp_health` result. Treat missing stdout, non-JSON stdout, timeout, and missing `serverInfo` as separate failures.

- [ ] **Step 2: Run the diagnostic against the currently installed launcher**

  Run:

  ```bash
  rtk node scripts/knowledge-mcp-session-diagnostic.mjs
  ```

  Expected: the report identifies whether the failure is in config discovery, launcher execution, MCP initialize, tool registration, or the host session. Do not change configuration during this step.

- [ ] **Step 3: Implement redacted boundary evidence**

  Spawn the stable launcher through `McpSession`, capture stdout/stderr separately, redact home-relative secrets and unrelated environment values, and emit a Markdown/JSON report under `.superpowers/sdd/`.

- [ ] **Step 4: Run the focused test and diagnostic again**

  Run:

  ```bash
  rtk pnpm run typecheck
  rtk node scripts/knowledge-mcp-session-diagnostic.mjs
  ```

  Expected: the diagnostic produces one explicit root-cause classification instead of only “MCP unavailable”.

- [ ] **Step 5: Commit the diagnostic boundary**

  ```bash
  rtk git add scripts/knowledge-mcp-session-diagnostic.mjs scripts/knowledge-process-utils.mjs packages/mcp/src/__tests__/round13-mcp-contracts.test.ts
  rtk git commit -m "test: diagnose real MCP session boundary"
  ```

### Task 2: Make client configuration and runtime status verifiable

**Files:**
- Modify: `src-tauri/src/mcp.rs:343-355,639-790,888-970`
- Modify: `packages/mcp/src/index.ts:557-590,850-882`
- Modify: `src-tauri/src/lib.rs` only if a new status command must be registered
- Test: Rust unit tests in `src-tauri/src/mcp.rs`; `packages/mcp/src/__tests__/round13-mcp-contracts.test.ts`

**Interfaces:**
- Consumes: `install_stable_mcp_launcher`, `write_claude_desktop_mcp_config_at`, `write_codex_mcp_config_at`, `mcp_health`.
- Produces: idempotent client configuration and a status model distinguishing `configured`, `launcherHealthy`, `initializeHealthy`, `clientRestartRequired`, and `runtimeOutdated`.

- [ ] **Step 1: Add failing configuration invariants**

  Test that Claude JSON and Codex TOML both write `command = "/Users/<user>/.penguin/bin/penguin-mcp"` through the home-directory-derived path, use no fixed `runtimes/<version>` path, preserve unrelated servers, remove only owned `pengvi` aliases, and are byte-stable on a second run.

- [ ] **Step 2: Add failing MCP health invariants**

  Test that `mcp_health` reports the running generation and available generation, returns `status: "outdated"` when the manifest changes, and includes an actionable restart notice without pretending that a client has already reloaded.

- [ ] **Step 3: Implement status separation**

  Keep the stable launcher and generation resolver as the only runtime path. Extend the Tauri MCP status response and Settings message to state exactly which checks passed: config written, local server initialize passed, and client restart still required. Do not label client registration as live-session readiness.

- [ ] **Step 4: Run focused Rust and MCP tests**

  Run:

  ```bash
  rtk cargo test --manifest-path src-tauri/Cargo.toml mcp
  rtk pnpm run typecheck
  rtk node --test packages/mcp/dist/__tests__/round13-mcp-contracts.test.js
  ```

  Expected: configuration is idempotent and the health contract distinguishes installed, running, outdated, and restarted states.

- [ ] **Step 5: Commit the runtime/status fix**

  ```bash
  rtk git add src-tauri/src/mcp.rs src-tauri/src/lib.rs packages/mcp/src/index.ts packages/mcp/src/__tests__/round13-mcp-contracts.test.ts
  rtk git commit -m "fix: make MCP installation and runtime status verifiable"
  ```

### Task 3: Enforce real CLI/MCP parity in a fresh process

**Files:**
- Modify: `scripts/knowledge-mcp-parity-test.mjs`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/query-protocol.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Test: `packages/mcp/src/__tests__/round13-mcp-contracts.test.ts`; `packages/knowledge-cli/src/__tests__/round13-cli-contracts.test.ts`

**Interfaces:**
- Consumes: `CAPABILITIES`, `capabilityHash`, `McpSession`, CLI JSON output, `knowledge_endpoints`, `knowledge_flow`, `mcp_health`.
- Produces: a parity report proving equal capability hash, equal schemas, equal dynamic-ID flow results, equal typed errors, and equal runtime generation identity.

- [ ] **Step 1: Extend parity tests with runtime identity**

  Require the CLI capability hash, MCP `knowledge_capabilities` hash, MCP initialize instructions, and `mcp_health.serverGeneration` to be present. A skipped MCP process is a failure, not a pass or `N/A`.

- [ ] **Step 2: Run the parity test to capture the current failure**

  Run:

  ```bash
  rtk pnpm run knowledge:mcp:parity
  ```

  Expected before the fix: the report fails at the exact missing MCP boundary or reports a hash/tool/schema mismatch.

- [ ] **Step 3: Align the MCP and CLI dispatch paths**

  Route both surfaces through the same normalized request/response and error-envelope helpers. Preserve `node:<id>` as the public form for graph operations and accept it consistently in endpoint identity instead of requiring a special bare-ID exception.

- [ ] **Step 4: Verify parity in independent processes**

  Run:

  ```bash
  rtk pnpm run typecheck
  rtk pnpm run knowledge:mcp:parity
  ```

  Expected: all real-process checks pass, including initialize, tools, dynamic CLI-ID → MCP flow, MCP-ID → CLI flow, and normalized error envelopes.

- [ ] **Step 5: Commit parity changes**

  ```bash
  rtk git add scripts/knowledge-mcp-parity-test.mjs packages/mcp/src packages/knowledge-cli/src packages/mcp/src/__tests__ packages/knowledge-cli/src/__tests__
  rtk git commit -m "test: enforce fresh-process MCP and CLI parity"
  ```

### Task 4: Repair shared target identity, scope, evidence, and errors

**Files:**
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/revision.ts`
- Modify: `packages/knowledge-core/src/search-cursor.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `packages/knowledge-core/src/__tests__/round13-contracts.test.ts`; `packages/knowledge-cli/src/__tests__/round13-cli-contracts.test.ts`; `packages/mcp/src/__tests__/round13-mcp-contracts.test.ts`

**Interfaces:**
- Consumes: target resolver, revision scope, cursor codec, shared capability schemas.
- Produces: one typed identity contract and one evidence envelope for search, filesymbols, endpoints, context, flow, callers, callees, affected, and deadcode.

- [ ] **Step 1: Add failing identity-equivalence tests**

  Test rendered endpoint title, canonical `grpc::...` identity, slash route, bare node ID, and `node:<id>` all resolve to the same node or return a typed remediation error. Test invalid, absent, cross-repository, stale, and wrong-revision IDs separately.

- [ ] **Step 2: Add failing scope tests**

  Test that unscoped search either returns an explicit multi-repository result or exits with a copyable `--repo` remediation. It must never silently select the current working repository.

- [ ] **Step 3: Add failing envelope tests**

  Require inventory operations to include repository, branch, revision, freshness, coverage, completeness, `totalIsExact`, proof status, locator, cursor, and diagnostics fields whenever available. Preserve explicit “not proven” semantics for lower-bound and unresolved results.

- [ ] **Step 4: Implement shared normalization and typed errors**

  Move normalization before operation-specific dispatch, make scope explicit, classify `NODE_ABSENT`, `NODE_SCOPE_MISMATCH`, `NODE_REVISION_MISMATCH`, `CURSOR_SCOPE_MISMATCH`, and `CURSOR_INVALID` distinctly, and attach retryability plus the next safe command.

- [ ] **Step 5: Run contract tests**

  ```bash
  rtk pnpm run typecheck
  rtk pnpm run knowledge:round13:contract
  ```

  Expected: all identity forms, scope gates, evidence envelopes, and error classifications are stable across CLI and MCP.

- [ ] **Step 6: Commit the shared contract fix**

  ```bash
  rtk git add packages/knowledge-core/src packages/knowledge-cli/src packages/mcp/src
  rtk git commit -m "fix: unify Knowledge identity scope and evidence contracts"
  ```

### Task 5: Resolve freshness, coverage, unresolved-reference, and pagination gaps

**Files:**
- Modify: `packages/knowledge-core/src/revision.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `scripts/knowledge-retest-round14.mjs`
- Create: `scripts/knowledge-coverage-audit.mjs`
- Test: `packages/knowledge-core/src/__tests__/round13-contracts.test.ts`; `packages/knowledge-cli/src/__tests__/round13-cli-contracts.test.ts`

**Interfaces:**
- Consumes: revision scope, coverage tables, unresolved-reference records, operation cursor codec.
- Produces: consistent freshness fields, pageable unresolved diagnostics, excluded-file reasons, and provable final-page/exhaustion behavior.

- [ ] **Step 1: Add failing freshness consistency tests**

  Use an aligned clean snapshot and assert that `status`, `search`, `context`, and `explore` report the same freshness state. Add a controlled stale snapshot fixture and assert a distinct stale/revision error.

- [ ] **Step 2: Add failing coverage closure tests**

  Require every excluded file to expose path, exclusion reason, parser/encoding failure, and retryability. Require unresolved references to be pageable by locator, source symbol, target text, resolution reason, and confidence. Negative claims remain unproven while relevant unresolved records exist.

- [ ] **Step 3: Add failing pagination tests**

  For endpoints, filesymbols, and deadcode, test first page, continuation in a new process, final page, exhausted continuation, malformed cursor, wrong-scope cursor, no duplicates, and stable ordering. Replace the opaque hard-cap failure with a documented partition or continuation strategy.

- [ ] **Step 4: Implement consistent materialized evidence**

  Make all surfaces consume one revision/coverage snapshot, normalize `staleSymbols` versus per-node freshness, expose coverage diagnostics, and return a typed exhausted-cursor result after the final page.

- [ ] **Step 5: Re-index only after code contracts pass**

  Run the coverage audit against `FPMS-NT`, then re-index the affected repository and verify admitted/excluded/failed counts and revision alignment. Do not call the graph complete if unresolved or excluded records remain.

- [ ] **Step 6: Run quality regression and commit**

  ```bash
  rtk pnpm run knowledge:coverage-audit
  rtk pnpm run knowledge:retest:round14
  rtk pnpm run knowledge:round13:contract
  rtk git add packages/knowledge-core/src packages/knowledge-cli/src scripts/knowledge-retest-round14.mjs scripts/knowledge-coverage-audit.mjs
  rtk git commit -m "fix: make freshness coverage and pagination evidence complete"
  ```

### Task 6: Build, install, and perform the only authoritative fresh-session retest

**Files:**
- Modify: `docs/quality/index-evaluation-brief.md`
- Create: `docs/quality/index-evaluation-codex-round15.md`
- Use: `scripts/knowledge-mcp-parity-test.mjs`, `scripts/knowledge-retest-round14.mjs`

**Interfaces:**
- Consumes: built `Penguin.app`, stable launcher, installed client configs, real Claude/Codex fresh sessions, `index-evaluation-brief.md`.
- Produces: Round 15 evidence report with separate product score, MCP readiness score, and environment failure classification.

- [ ] **Step 1: Run all automated gates before packaging**

  ```bash
  rtk pnpm run typecheck
  rtk pnpm test
  rtk pnpm run knowledge:round13:contract
  rtk pnpm run knowledge:mcp:parity
  rtk pnpm run knowledge:retest:round14
  ```

  Expected: no skipped MCP checks and no unexplained parity or contract failures.

- [ ] **Step 2: Build the Tauri app**

  ```bash
  rtk pnpm tauri build
  ```

  If updater signing is unavailable, record the exact signing-only failure separately; the unsigned `.app`/DMG build result must not be confused with MCP runtime failure.

- [ ] **Step 3: Install and reconfigure clients**

  Replace the installed app with the new `Penguin.app`, wait for the copy to finish, open Penguin, click `Reconfigure MCP Clients`, and verify the three client configs still point to `~/.penguin/bin/penguin-mcp`.

- [ ] **Step 4: Start a genuinely new client process**

  Fully quit Claude Desktop, Claude Code, and Codex CLI. Reopen them after Penguin has completed startup sync. Create a new session only after the clients have restarted.

- [ ] **Step 5: Execute Round 15 without CLI fallback first**

  In the new session, verify that Penguin MCP is actually listed, call `mcp_health`, call `knowledge_capabilities`, run one scoped endpoint query, continue with a dynamic node ID, and run one typed negative case. Only if MCP is truly unavailable may the brief invoke the CLI fallback, and the report must score that as environment readiness failure.

- [ ] **Step 6: Verify acceptance targets**

  Accept the release candidate only when:

  - MCP is available in the new session and real-process parity passes.
  - `mcp_health.runningBuildId === availableBuildId` and `outdated === false`.
  - All tested identity forms and error classifications are consistent.
  - No result promotes partial/lower-bound/unresolved evidence to a complete negative claim.
  - The product score is at least `95/100`; any lower score gets a specific remaining blocker rather than another blind retest.

- [ ] **Step 7: Commit the evaluation brief and report**

  ```bash
  rtk git add docs/quality/index-evaluation-brief.md docs/quality/index-evaluation-codex-round15.md
  rtk git commit -m "docs: add authoritative fresh-session Round 15 evaluation"
  ```

## Estimated Effort and Stop Conditions

- Task 1: 0.5–1 day; Task 2: 1 day; Task 3: 1 day; Task 4: 1–2 days; Task 5: 2–3 days; Task 6: 0.5–1 day.
- Expected total: approximately 6–9 engineering days for one engineer, assuming no new parser/indexer architectural issue appears.
- Stop and reassess architecture if three independent fixes still produce MCP session failures, or if unresolved references cannot be made pageable and attributable from the current graph schema.
- Do not repeat Round 14 after only rebuilding the app. The authoritative retest is Round 15 after a fresh client process, with MCP tools visibly exposed and automated parity evidence attached.
