# Penguin Round 13 Runtime and Knowledge Contract Complete Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every installed Penguin CLI/MCP session use the same verified build and make the existing knowledge capabilities reliable for Claude/Codex multi-step workflows.

**Architecture:** Tauri owns a versioned runtime store under `~/.penguin/runtimes`, switches a `current` pointer atomically after hash/schema validation, and exposes stable CLI/MCP launchers. CLI, MCP, and Wiki use one canonical target/revision resolver and one response/error envelope. Black-box tests launch the actual bundled processes, capture fresh IDs, and replay those IDs across fresh processes before a new evaluation round is accepted.

**Tech Stack:** Rust/Tauri, TypeScript/Node.js, SQLite, MCP stdio transport, bundled Node runtime, existing knowledge-core/knowledge-cli/knowledge-indexer packages, Node test runner, and existing shell/build scripts.

**Spec:** `docs/quality/index-evaluation-brief.md`; current evidence: `docs/quality/index-evaluation-codex-round13.md`.

## Global Constraints

- Do not claim a capability is implemented unless its actual CLI/MCP runtime route executes successfully.
- Do not silently fall back from an explicit branch, commit, snapshot, repository, or node scope.
- Do not convert incomplete coverage, lower-bound graph results, empty results, or deadcode candidates into proven absence.
- Keep `node:<id>` compatible across all documented follow-up operations.
- Keep the knowledge store backward-compatible; schema migrations must be additive and tested on a copy before production readback.
- Do not require external network access, source dumps, credentials, or release signing for local runtime synchronization.
- Do not modify release recommendation or enable public release; this plan is for internal Claude/Codex use.
- Existing running MCP processes may remain on the old build, but must report `OUTDATED_RUNTIME` and provide a restart action; new sessions must always use `current`.

---

### Task 1: Freeze the current contract and reproduce every Round 13 failure

**Files:**
- Create: `packages/knowledge-core/src/__tests__/round13-contracts.test.ts`
- Create: `packages/knowledge-cli/src/__tests__/round13-cli-contracts.test.ts`
- Create: `packages/mcp/src/__tests__/round13-mcp-contracts.test.ts`
- Create: `scripts/knowledge-round13-blackbox.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing CLI bundle, MCP bundle, `CAPABILITIES`, CLI dispatch, and MCP tool definitions.
- Produces: a failure matrix and reusable black-box harness. Later tasks must make this harness pass without hard-coded node IDs.

- [ ] **Step 1: Write a contract fixture that records the current runtime identity.** The fixture must capture `buildId`, `capabilityHash`, `schemaVersion`, runtime path, bundle path, and indexed revision.
- [ ] **Step 2: Add black-box cases for the known failures.** Cover missing `callees`, `affected node:<id>`, `node:<id>` continuation, wrong revision, invalid node, canonical gRPC identity, deadcode cursor exhaustion, and human `not proven` output.
- [ ] **Step 3: Add a fresh-ID rule to the harness.** Parse IDs only from the immediately preceding command response; reject fixtures containing a manually supplied node ID.
- [ ] **Step 4: Add package scripts.** Use `knowledge:round13:blackbox` for the harness and `knowledge:round13:contract` for the focused test suite.
- [ ] **Step 5: Run the new harness against the current build and save the failure matrix.** This is the baseline; do not mark any failure as expected success merely because the process exits.

Run:

```bash
rtk pnpm knowledge:round13:blackbox
rtk pnpm knowledge:round13:contract
```

Expected before later tasks: failures reproduce the report’s contract mismatches and identify the exact command/tool and response field responsible.

---

### Task 2: Create the versioned runtime manager

**Files:**
- Create: `src-tauri/src/runtime/knowledge_runtime.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Modify: `src-tauri/src/knowledge.rs`
- Create: `src-tauri/src/commands/knowledge_runtime.rs` when command registration is kept separate from worker code
- Create: `tests/knowledge-runtime-manager.test.mjs`

**Interfaces:**
- Produces Rust functions with these responsibilities:
  - `install_bundled_knowledge_runtime(app) -> Result<RuntimeManifest, String>`
  - `active_knowledge_runtime() -> Result<RuntimeManifest, String>`
  - `verify_knowledge_runtime(path) -> Result<RuntimeManifest, String>`
  - `switch_knowledge_runtime(build_id) -> Result<RuntimeManifest, String>`
  - `rollback_knowledge_runtime(build_id) -> Result<RuntimeManifest, String>`

- [ ] **Step 1: Define the manifest schema.** Store `buildId`, `appVersion`, `capabilityHash`, `schemaVersion`, `cliEntry`, `mcpEntry`, `nodePath`, `wasmPath`, creation time, and file hashes in `~/.penguin/runtimes/<buildId>/manifest.json`.
- [ ] **Step 2: Implement a temporary staging directory.** Copy the Tauri resource bundle into `~/.penguin/runtimes/.staging-<uuid>` and reject missing `penguin.mjs`, MCP entry, bundled Node, native modules, or WASM.
- [ ] **Step 3: Verify before activation.** Run the bundled CLI capability command and MCP health handshake from staging; require matching capability hash and schema version before activation.
- [ ] **Step 4: Atomically activate the runtime.** Rename the verified staging directory to its build ID and replace `~/.penguin/runtimes/current` with an atomic symlink or pointer file; never mutate a runtime directory in place.
- [ ] **Step 5: Keep the previous runtime.** Retain the previous active version for rollback and delete only old versions that are not active and are not referenced by a running process.
- [ ] **Step 6: Add tests for interrupted copy, missing file, hash mismatch, contract mismatch, concurrent activation, rollback, and already-current build.**
- [ ] **Step 7: Run Rust and runtime-manager tests.**

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml runtime
rtk node --test tests/knowledge-runtime-manager.test.mjs
```

Expected: a failed verification leaves `current` unchanged; a successful verification changes it exactly once and can be rolled back.

---

### Task 3: Make CLI and MCP use stable launchers

**Files:**
- Create: `scripts/knowledge-cli-launcher.mjs`
- Create: `scripts/knowledge-mcp-launcher.mjs`
- Modify: `packages/knowledge-cli/src/bin.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `.penguin.config.json` handling code, if configuration is generated by a dedicated module
- Create: `tests/knowledge-launcher.test.mjs`

**Interfaces:**
- Produces stable user-facing paths:
  - `~/.local/bin/penguin` → stable CLI launcher
  - `~/.penguin/bin/penguin-mcp` → stable MCP launcher
- Both launchers resolve `~/.penguin/runtimes/current/manifest.json` and never embed an old absolute App resource path.

- [ ] **Step 1: Write launcher tests.** Test current pointer selection, missing current pointer, malformed manifest, unsupported schema, and correct exit/error output.
- [ ] **Step 2: Implement the CLI launcher.** Resolve the active manifest, execute its bundled Node with its CLI entry, pass through stdin/stdout/stderr, and preserve exit code and signal behavior.
- [ ] **Step 3: Implement the MCP launcher.** Resolve the active manifest, execute its MCP entry with bundled Node, and preserve stdio transport exactly.
- [ ] **Step 4: Change `installSelf`.** Make `penguin install` create/update the stable launcher rather than symlinking directly to one build’s `penguin.mjs`.
- [ ] **Step 5: Add a stable MCP configuration migration.** Update the Penguin-managed MCP configuration to point at `~/.penguin/bin/penguin-mcp`; preserve unrelated user configuration and write a backup before migration.
- [ ] **Step 6: Ensure launcher health output includes active build identity.** A missing or invalid runtime must fail closed with `RUNTIME_NOT_INSTALLED` or `RUNTIME_MANIFEST_INVALID`.
- [ ] **Step 7: Test from a temporary HOME.** Verify that installing build A, then build B, causes new CLI/MCP processes to use B without changing the configured launcher path.

Run:

```bash
rtk node --test tests/knowledge-launcher.test.mjs
rtk pnpm -F @penguin/knowledge-cli build
rtk pnpm -F @penguin/mcp build
```

Expected: a new Claude/Codex session started after App activation always resolves the newest verified runtime.

---

### Task 4: Add Tauri post-install/startup runtime migration and health gate

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/lib.rs` or the current Tauri setup module
- Modify: `src-tauri/src/runtime/manager.rs`
- Modify: `src-tauri/tauri.conf.json` only if a new resource or command must be declared
- Create: `tests/knowledge-tauri-runtime.test.mjs`

**Interfaces:**
- Produces Tauri startup commands:
  - `knowledge_runtime_sync() -> RuntimeSyncResult`
  - `knowledge_runtime_health() -> RuntimeHealth`
  - `knowledge_runtime_restart_required() -> RestartRequirement`

- [ ] **Step 1: Write startup migration tests.** Cover first install, same build restart, upgrade, downgrade/rollback, malformed old runtime, and missing private signing key; signing must not affect local runtime activation.
- [ ] **Step 2: Call runtime sync after the App resource directory is available.** Do not activate until resource verification succeeds.
- [ ] **Step 3: Store a migration result.** Include old build, new build, hash comparison, schema comparison, switched path, rollback path, and whether a new MCP session is required.
- [ ] **Step 4: Add a visible health gate.** The app must show runtime mismatch or MCP restart requirement rather than silently operating with an old bundle.
- [ ] **Step 5: Wire the existing `bundled_runtime_dir` and generation watcher to the runtime manager.** The watcher should observe the active manifest, not only the packaged App resource directory.
- [ ] **Step 6: Make old MCP processes return structured outdated metadata.** Preserve the existing `_meta` signal and add a stable error/action field for clients that do not render `_meta`.
- [ ] **Step 7: Verify an installed App upgrade in a temporary user directory.** Start MCP before and after activation; the old process must report outdated, and the new process must report the new build/hash.

Run:

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml
rtk node --test tests/knowledge-tauri-runtime.test.mjs
```

Expected: installing a new App updates the active CLI/MCP runtime for all new sessions without requiring manual symlink repair.

---

### Task 5: Unify target, repository, branch, and revision resolution

**Files:**
- Create: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/data-flow.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Create: `tests/knowledge-target-resolution.test.mjs`

**Interfaces:**
- Produces:

```ts
type ResolvedTarget = {
  nodeId: string;
  nodeType: "symbol" | "endpoint" | "service" | "file" | "note";
  repoId: string | null;
  branchId: string | null;
  revisionId: string | null;
  identityKey: string;
  locator: { filePath: string | null; startLine: number | null; endLine?: number | null };
};

type TargetResolutionErrorCode =
  | "TARGET_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_STALE"
  | "REPO_SCOPE_MISMATCH"
  | "BRANCH_NOT_FOUND"
  | "REVISION_MISMATCH"
  | "UNSUPPORTED_TARGET_KIND";
```

- [ ] **Step 1: Write tests for every accepted spelling.** Cover `node:<id>`, `symbol:<id>`, raw ID, path hash symbol, repo/path hash symbol, rendered endpoint title, `grpc::Service.method`, slash route, and bare name.
- [ ] **Step 2: Require explicit scope preservation.** A target resolved in repo A must not be returned as repo B merely because the caller supplied `--repo B`.
- [ ] **Step 3: Reject explicit revision mismatches.** An invalid branch/commit/snapshot must return a typed error containing expected and received values; no live-branch fallback is allowed.
- [ ] **Step 4: Replace all local parsers.** Route context, flow, callers, callees, affected, explore, endpoint identity, CLI, and MCP through `resolveTarget`.
- [ ] **Step 5: Make `affected` target-kind behavior explicit.** Support node impact for supported node kinds; otherwise return `UNSUPPORTED_TARGET_KIND` with a copyable file-form retry.
- [ ] **Step 6: Return structured resolution diagnostics for invalid nodes.** Never return a success-shaped empty focus for a malformed or absent node.
- [ ] **Step 7: Run focused target tests and typecheck.**

Run:

```bash
rtk node --test tests/knowledge-target-resolution.test.mjs
rtk pnpm run typecheck
```

Expected: every follow-up operation either consumes the same resolved target or returns a typed, actionable error.

---

### Task 6: Align CLI capability/help/dispatch with actual runtime

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-cli/src/bin.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/knowledge-contracts/src/surface.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Create: `tests/knowledge-cli-runtime-surface.test.mjs`

- [ ] **Step 1: Generate `help --json` from the same dispatch registry used by the CLI.** Include every runnable read-only command, including `search`, `context`, `flow`, `callers`, `callees`, and `affected`.
- [ ] **Step 2: Implement the missing `callees` CLI command.** It must use the shared resolver and return the same relation envelope as MCP.
- [ ] **Step 3: Add the MCP endpoint and onboarding tools to the listed surface.** The handler, tool definition, capability registration, and tool listing must all agree.
- [ ] **Step 4: Remove placeholder registrations.** A capability is `implemented` only when the command/tool invokes real runtime code; otherwise return `not_implemented` or remove it from required surface.
- [ ] **Step 5: Align input/output schemas.** The CLI JSON shape, MCP structured content, and canonical schema must contain the same fields and error codes.
- [ ] **Step 6: Add a surface audit that runs each capability at least once.** Registration-only checks are insufficient.
- [ ] **Step 7: Regenerate docs, snapshots, and capability hash.** Update `src-tauri/src/knowledge.rs` only from the generated hash.

Run:

```bash
rtk pnpm knowledge:mcp:parity
rtk node scripts/knowledge-docs-generate.mjs --check
rtk node --test tests/knowledge-cli-runtime-surface.test.mjs tests/knowledge-surface-parity.test.mjs
```

Expected: help, capability manifest, CLI dispatch, MCP tools/list, schemas, and runtime behavior describe the same operation set.

---

### Task 7: Fix coverage, completeness, negative-result, and provenance contracts

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/evidence-state.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Create: `tests/knowledge-evidence-contract.test.mjs`

- [ ] **Step 1: Persist unresolved-reference counts per repository, branch, file, and indexing revision.** Include migration and readback tests; a schema column existing with no populated values is not enough.
- [ ] **Step 2: Define one response envelope.** Every query must return scope, revision, freshness, coverage, completeness, proof status, candidate count, returned count, truncation, and cursor where applicable.
- [ ] **Step 3: Define proof status.** Return `proven` only for positive facts with locator and aligned revision; return `not_proven` for incomplete negative claims.
- [ ] **Step 4: Put `not proven` in human output.** Do not hide the limitation only in JSON diagnostics.
- [ ] **Step 5: Make deadcode warnings explicit.** DI, reflection, dynamic imports, public APIs, and framework magic must remain candidate caveats.
- [ ] **Step 6: Normalize provenance fields.** `context`, `explore`, `flow`, `callers`, `callees`, `affected`, and MCP must preserve edge type, origin, method, confidence, locator, revision, and unresolved reason.
- [ ] **Step 7: Fix inferred-edge accounting.** The summary count and individual edge list must derive from the same data and never contradict each other.
- [ ] **Step 8: Add tests for missing target, empty search, no callers, no handler, data-boundary unknown, excluded files, unresolved references, and partial flow.**

Run:

```bash
rtk node --test tests/knowledge-evidence-contract.test.mjs
rtk pnpm test
```

Expected: agents can distinguish a verified positive fact, a lower bound, a candidate, an unresolved edge, and an unsupported negative claim on both human and JSON surfaces.

---

### Task 8: Repair pagination with one shared cursor implementation

**Files:**
- Modify: `packages/knowledge-core/src/search-cursor.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Create: `tests/knowledge-pagination-contract.test.mjs`

- [ ] **Step 1: Define a cursor payload containing operation, scope, ordering key, last key, revision, and contract version.**
- [ ] **Step 2: Validate operation, repository, branch/file scope, revision, and signature before querying the next page.**
- [ ] **Step 3: Use the same terminal semantics everywhere.** The final page must have `nextCursor:null`, `totalIsExact:true`, and `truncated:false` when the complete result set is known.
- [ ] **Step 4: Fix deadcode continuation.** Page two must return every remaining candidate; no page may report more candidates while returning an empty terminal page.
- [ ] **Step 5: Test endpoints, filesymbols, and deadcode.** Verify stable order, no duplicates, candidate/returned counts, normal continuation, exhausted cursor, malformed cursor, and wrong-scope cursor.
- [ ] **Step 6: Add MCP parity cases for the same cursor payload and errors.**

Run:

```bash
rtk node --test tests/knowledge-pagination-contract.test.mjs
rtk pnpm knowledge:mcp:parity
```

Expected: an agent can save page one, start a new process, and continue without reconstructing hidden state.

---

### Task 9: Improve bounded search and error remediation

**Files:**
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Create: `tests/knowledge-error-remediation.test.mjs`

- [ ] **Step 1: Add bounded degradation for global common searches.** On timeout, return partial results or a typed retry response with repository narrowing, branch, path, and limit suggestions.
- [ ] **Step 2: Ensure no error-shaped result contains a current trust/revision envelope unless the target actually resolved.**
- [ ] **Step 3: Normalize errors across CLI and MCP.** Use `code`, `message`, `retryable`, `scope`, `revision`, `candidates`, and `nextCommand` where applicable.
- [ ] **Step 4: Add recovery commands for ambiguous symbol, invalid node, invalid endpoint identity, wrong-scope cursor, unknown repo, wrong revision, and missing target.**
- [ ] **Step 5: Make onboarding list only commands that the current surface can execute.** Include the exact CLI fallback and MCP-unavailable behavior.
- [ ] **Step 6: Test all error inputs from Round 13 Q16 in separate fresh processes.**

Run:

```bash
rtk node --test tests/knowledge-error-remediation.test.mjs
rtk pnpm knowledge:retest:round12
```

Expected: an agent can distinguish invalid, absent, ambiguous, stale, partial, and unavailable states and can copy the suggested retry.

---

### Task 10: Real MCP/CLI parity and installation verification

**Files:**
- Modify: `scripts/knowledge-mcp-parity-test.mjs`
- Modify: `scripts/knowledge-retest-round12.mjs`
- Create: `scripts/knowledge-install-upgrade-test.mjs`
- Modify: `docs/quality/index-evaluation-brief.md`
- Create: `docs/quality/index-evaluation-codex-round14.md`

- [ ] **Step 1: Extend parity beyond registration.** Start CLI and MCP processes, execute the same target request, and compare normalized structured results and error envelopes.
- [ ] **Step 2: Run dynamic ID parity.** Capture a CLI endpoint/symbol ID and verify it through MCP; capture an MCP ID and verify it through CLI where the surface supports that operation.
- [ ] **Step 3: Run runtime upgrade simulation.** Install runtime A, launch MCP A, activate runtime B through the manager, verify MCP A reports outdated, then launch MCP B and verify the new hash.
- [ ] **Step 4: Verify stable launcher paths.** Ensure the configured CLI/MCP paths do not change across upgrade.
- [ ] **Step 5: Fail the script on skipped or registration-only cases.** Expected negative cases must still validate their error contract.
- [ ] **Step 6: Save raw evidence with paths, build IDs, hashes, schemas, and session boundaries.** Do not include private source or credentials.

Run:

```bash
rtk node scripts/knowledge-mcp-parity-test.mjs
rtk node scripts/knowledge-install-upgrade-test.mjs
rtk pnpm knowledge:retest:round12
```

Expected: parity is `pass`, or the report clearly identifies a runtime/environment blocker separate from product capability failure.

---

### Task 11: Build, install, re-index, and run a fresh evaluation gate

**Files:**
- Modify only when required by verification: `docs/quality/index-evaluation-brief.md`
- Create: `docs/quality/index-evaluation-codex-round14.md`
- Create: `docs/quality/index-evaluation-claude-round14.md` when Claude is available

- [ ] **Step 1: Run the full test suite and typecheck.** Do not proceed to packaging with a failed contract test.
- [ ] **Step 2: Run `pnpm build` to regenerate all package and knowledge bundles.** Record the generated build ID and capability hash.
- [ ] **Step 3: Run `pnpm tauri build`.** Treat public signing-key/private-key failure as a packaging/signing gate, not as proof that the local app/runtime is invalid; record it explicitly.
- [ ] **Step 4: Install the newly built App into a temporary test location and launch it once.** Verify runtime migration, stable launchers, health, and active hash.
- [ ] **Step 5: Re-index only `/Users/shieng/Desktop/Projects/fpmsnt` after dry-run confirmation.** Record discovered, admitted, excluded, failed, stale, unresolved, indexed commit, branch, and parser/schema versions.
- [ ] **Step 6: Start a genuinely new CLI process and a genuinely new MCP session.** Confirm both use the same active build identity.
- [ ] **Step 7: Execute all Q1–Q16 and B1–B5 from the updated brief.** Every dynamic ID, cursor, endpoint, and revision must originate from this run.
- [ ] **Step 8: Score product capability and environment readiness separately.** MCP unavailability is `N/A: environment unavailable`, not product score zero.
- [ ] **Step 9: Require direct evidence for all completion gates.** Do not mark the work complete based on manifest parity or a green smoke test alone.

Run:

```bash
rtk pnpm test
rtk pnpm run typecheck
rtk pnpm build
rtk pnpm tauri build
rtk node scripts/knowledge-install-upgrade-test.mjs
rtk pnpm knowledge:retest:round12
```

Expected gate:

- active CLI and MCP hashes match;
- new sessions use the active runtime automatically;
- `node:<id>` round-trips across every applicable operation;
- explicit wrong revision never silently falls back;
- `callees` and `affected` have truthful contracts;
- endpoint canonical identity is consistent;
- all cursor surfaces reach a truthful terminal state;
- provenance and `not proven` semantics are consistent;
- Q1–Q16 and B1–B5 have direct evidence;
- no release recommendation is made.

## Completion audit

- [ ] A new Tauri installation updates CLI and MCP through the versioned runtime manager.
- [ ] Existing MCP processes detect outdated builds and provide a restart action.
- [ ] Stable launcher paths survive upgrades and rollbacks.
- [ ] CLI help, capability manifest, MCP tools/list, schemas, and real runtime routes agree.
- [ ] `callees` is either genuinely implemented or truthfully unavailable everywhere.
- [ ] `affected node:<id>` is supported or rejected with a typed target-kind error.
- [ ] Wrong branch/commit/snapshot/node scope is rejected rather than silently corrected.
- [ ] Coverage and unresolved references are persisted and returned consistently.
- [ ] Human and JSON outputs distinguish proven facts from lower bounds and `not proven` claims.
- [ ] Endpoint, filesymbols, and deadcode cursors have complete continuation/error tests.
- [ ] CLI/MCP parity is tested through actual processes, not only registration metadata.
- [ ] The final fresh-session report is generated from the new installed runtime.
