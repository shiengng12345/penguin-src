# Penguin Round 16 High-Trust Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Penguin from a useful internal Beta to a high-trust Claude/Codex knowledge layer by eliminating silent MCP/CLI false results, making evidence boundaries consistent, and proving fresh-session/runtime continuity.

**Architecture:** Keep the canonical capability manifest and knowledge-core query results as the single semantic source of truth. Make CLI and MCP thin adapters that normalize inputs, preserve scope/revision/cursor metadata, and map the same typed errors. Keep Tauri responsible for installing and selecting one runtime, while release-gate scripts verify that CLI, MCP, and bundled runtime expose the same build and capability hash.

**Tech Stack:** TypeScript, Node.js stdio MCP, SQLite knowledge store, `node:test`, pnpm, Rust/Tauri, shell launchers, JSON capability contracts.

**Spec:** `docs/quality/index-evaluation-opus-5-round16.md`, `docs/quality/index-evaluation-codex-round16.md`, `docs/quality/index-evaluation-brief-round16.md`

## Current execution status — 2026-08-30

Tasks 1–5 are implemented and covered by the current contract, query, CLI,
MCP, evidence, search, onboarding, and parity tests. Task 6 now includes a
real clean-install gate that launches the built Tauri executable in a temporary
HOME, reads the runtime manifest created by the app, starts the embedded MCP,
and compares it with the stable CLI/MCP launcher. The latest local evidence is:

- full `pnpm test`: exit `0`;
- `pnpm run typecheck`: exit `0`;
- unsigned `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`: exit `0`;
- surface parity: 99 canonical capabilities, 99 CLI registrations, 120 MCP
  tools, zero missing/unimplemented/mismatch entries;
- clean-install Tauri identity gate: exit `0`, with the app-generated runtime
  manifest, embedded CLI/MCP, and stable launcher sharing the same build ID,
  schema `14`, and capability hash;
- 10,000-needle universal benchmark, 110-question audit, and competitor
  differential: all exit `0` in the latest release-gate run.
- signed-build gate without a release secret: correctly exits with
  `TAURI_SIGNING_KEY_REQUIRED`; it will run signed Tauri packaging and require
  `.sig` plus updater archive artifacts only when the release environment
  injects the secret.

The plan remains `NO-GO` for a signed release and final fresh-client claim
until an independent RC ID, the release environment's
`TAURI_SIGNING_PRIVATE_KEY`, and separate quit/reopen evidence from Claude
Desktop, Claude Code, and Codex are supplied. These are intentionally not
fabricated by local tests or a Settings status badge.

## Global Constraints

- Preserve the existing local-first design; do not upload source code or secrets.
- Preserve `node:<stable-id>` continuation and existing valid cursor consumers.
- Never convert an empty, partial, lower-bound, stale, unresolved, or candidate result into proof of absence.
- Every mutating operation remains confirmation-gated.
- CLI and MCP must expose the same capability ID, input schema, output envelope, error code, retryability, and remediation semantics.
- Tauri signing keys must remain environment/CI secrets; never write `TAURI_SIGNING_PRIVATE_KEY` into source, docs containing secrets, or generated artifacts.
- Preserve unrelated dirty worktree changes and update only files listed by each task.

## Planned File Map

| Area | Files | Responsibility |
| --- | --- | --- |
| Capability contract | `packages/knowledge-contracts/src/capabilities.ts`, `surface.ts`, `input-schemas.ts`, `errors.ts` | Canonical IDs, public MCP mapping, schemas, typed errors |
| Query semantics | `packages/knowledge-core/src/search-engine.ts`, `query.ts`, `search-cursor.ts`, `index.ts` | Scope resolution, evidence envelopes, relation completeness, cursor revision |
| MCP adapter | `packages/mcp/src/knowledge-tools.ts`, `knowledge-tool-defs.ts`, `index.ts` | Nested input normalization, tool listing, MCP error/result mapping |
| CLI adapter | `packages/knowledge-cli/src/command-dispatch.ts`, `args.ts` | Flag parsing, usage/help, JSON errors, command identity |
| Regression tests | `tests/knowledge-mcp-tools.test.mjs`, `knowledge-mcp-scope.test.mjs`, `knowledge-surface-parity.test.mjs`, `knowledge-cli.test.mjs`, `knowledge-pagination-contract.test.mjs`, `knowledge-runtime-doctor.test.mjs`, `knowledge-release-bundle-gate.test.mjs` | Reproduce every Round 16 defect and prevent regression |
| Runtime/release | `scripts/knowledge-mcp-session-diagnostic.mjs`, `scripts/knowledge-install-upgrade-test.mjs`, `scripts/knowledge-release-bundle-gate.mjs`, `scripts/knowledge-signed-release-build.mjs`, `scripts/knowledge-release-gate.mjs`, `src-tauri/src/mcp.rs`, `src-tauri/src/runtime/knowledge_runtime.rs` | Runtime identity, update/restart behavior, bundle and release proof |
| Documentation | `docs/knowledge-v2/capability-matrix.md`, `cli-reference.md`, `mcp-reference.md`, `docs/quality/index-evaluation-brief-round16.md` | Regenerate contract docs and add repeatable acceptance instructions |

---

### Task 1: Make the capability manifest and MCP tool surface unambiguous

**Files:**

- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/knowledge-contracts/src/surface.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/index.ts`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/knowledge-surface-parity.test.mjs`
- Test: `tests/knowledge-contracts.test.mjs`

**Interfaces:**

- Consumes: the existing `CAPABILITIES`, `listMcpRegistrations()`, `knowledge_capabilities`, and `tools/list` generation paths.
- Produces: one explicit registration record for every capability, with `capabilityId`, `advertisedTool` or `invocationMode`, `inputSchemaId`, `outputSchemaId`, and `status`.

- [ ] **Step 1: Write failing manifest/listing tests.**

  Assert all of the following:

  ```text
  capabilities --json has unique capability IDs.
  Every registration has a non-empty advertisedTool or an explicit router mode.
  Every MCP-required capability is reachable through tools/list or knowledge_invoke.
  Every direct tool maps to exactly one capability ID.
  Aliases do not create a second capability registration.
  knowledge_explore remains the first discovery tool.
  knowledge_capabilities --compact returns only IDs/status/schema references and is under 8,000 characters.
  ```

- [ ] **Step 2: Run the focused tests and confirm the current defect is reproduced.**

  Run:

  ```bash
  rtk node --test tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs tests/knowledge-contracts.test.mjs
  ```

  Expected before implementation: the new bijection/compact assertions fail against the 99-capability/82-tool mismatch or the oversized manifest.

- [ ] **Step 3: Add explicit registration metadata.**

  Define the public mapping in the canonical contract rather than inferring it from handler names. For capabilities that intentionally share an adapter, record `invocationMode: "router"` and the router tool name; do not claim that a missing tool is directly advertised. Keep compatibility aliases in a separate alias map.

- [ ] **Step 4: Return a compact manifest and correct unknown-tool errors.**

  Implement `knowledge_capabilities({compact:true})` as a small registration summary. When a dotted capability ID is passed to `tools/call` instead of an advertised tool name, return:

  ```json
  {
    "error": {
      "code": "UNKNOWN_TOOL",
      "message": "unknown MCP tool: knowledge.search",
      "retryable": false,
      "details": {"didYouMean": "knowledge_search"}
    },
    "isError": true
  }
  ```

- [ ] **Step 5: Make every MCP-required registration reachable.**

  Add the declared router path or direct tool definition for each currently unaddressable registration. Ensure `knowledge_dead_code`, `find_dead_code`, `knowledge_architecture`, and `explore_graph` are documented as canonical tool plus compatibility alias, not as unrelated capabilities.

- [ ] **Step 6: Run focused tests and regenerate generated references.**

  Run:

  ```bash
  rtk node --test tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs tests/knowledge-contracts.test.mjs
  rtk pnpm run knowledge:docs:generate
  ```

  Expected: zero duplicate capability IDs, every MCP-required capability is reachable, compact manifest is consumable, and generated capability/CLI/MCP references carry the same mapping.

- [ ] **Step 7: Commit the independently reviewable contract change.**

  Commit only the contract, MCP mapping, generated references, and focused tests with:

  ```bash
  rtk git add packages/knowledge-contracts packages/mcp tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs tests/knowledge-contracts.test.mjs docs/knowledge-v2
  rtk git commit -m "fix: make MCP capability registrations addressable"
  ```

### Task 2: Fix the two silent MCP false-result paths

**Files:**

- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-contracts/src/search.ts`
- Test: `tests/knowledge-mcp-scope.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/knowledge-surface-parity.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`

**Interfaces:**

- Consumes: `normalizeMcpSearchInput`, `resolveMcpRevision`, `searchKnowledge`, `knowledge_endpoints`, and `OPERATION_CURSOR_CODEC`.
- Produces: one normalized nested-page/scope request for every paged MCP query and one typed MCP error envelope for invalid input.

- [ ] **Step 1: Add failing regression tests for nested endpoint pagination.**

  Call the MCP handler with:

  ```json
  {"repo":"FPMS-NT","protocol":"grpc","page":{"limit":3}}
  ```

  Assert `returnedCount == 3`. Reuse the returned cursor inside `page.cursor` and assert that page two has no IDs from page one. Pass `page.cursor:"BOGUS"` and assert `isError:true` with `code:"CURSOR_INVALID"`.

- [ ] **Step 2: Add failing regression tests for scoped MCP search.**

  Search `getActiveEventConfigByObjId` with a canonical revision scope containing `repoName:"FPMS-NT"` and `branch:"brazil-v2"`. Assert results are non-empty, all hits belong to FPMS-NT, and the resolved snapshot ID equals the CLI snapshot for the same branch. Assert an unknown scoped repository returns a typed scope error rather than an empty successful result.

- [ ] **Step 3: Normalize endpoint `scope`, `page`, and compatibility top-level fields.**

  Apply the same nested-page normalization already used by `normalizeMcpSearchInput` to `knowledge_endpoints`, `filesymbols`, and `deadcode`. Reject conflicting nested and top-level values with `INVALID_ARGUMENT`; do not silently choose one.

- [ ] **Step 4: Route canonical revision scopes through real indexed snapshots.**

  Resolve `repoName`, `repoId`, `branch`, `commitSha`, and `snapshotId` once with `resolveMcpRevision`. Pass the resulting `RevisionContext` into `searchKnowledge` instead of reconstructing a `legacy:branch_*` snapshot. Return the resolved repository, branch, commit, and snapshot in the response envelope.

- [ ] **Step 5: Unify MCP handler errors.**

  Ensure validation, cursor, scope, and query errors pass through one normalizer that preserves `error.code`, `message`, `retryable`, `details`, and `remediation`, and sets the MCP `isError` flag for every failed call. Empty search must be rejected consistently as `INVALID_ARGUMENT`; malformed and wrong-scope cursors must remain `CURSOR_INVALID` and `CURSOR_SCOPE_MISMATCH`.

- [ ] **Step 6: Run the targeted regressions.**

  Run:

  ```bash
  rtk node --test tests/knowledge-mcp-scope.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs tests/knowledge-pagination-contract.test.mjs
  ```

  Expected: nested endpoint page two is different from page one, scoped MCP search returns the same FPMS-NT hits as CLI, and all tested errors are typed with `isError:true`.

- [ ] **Step 7: Commit the false-result fixes.**

  ```bash
  rtk git add packages/mcp packages/knowledge-core/src/search-engine.ts packages/knowledge-contracts/src/search.ts tests/knowledge-mcp-scope.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs tests/knowledge-pagination-contract.test.mjs
  rtk git commit -m "fix: preserve MCP scope and pagination semantics"
  ```

### Task 3: Make evidence envelopes and completeness semantics consistent

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/search-cursor.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Test: `tests/knowledge-query.test.mjs`
- Test: `tests/knowledge-affected.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/knowledge-surface-parity.test.mjs`

**Interfaces:**

- Consumes: the existing `context`, `explore`, `affected`, `flow`, `endpoints`, `filesymbols`, and `deadcode` result builders.
- Produces: a shared evidence envelope containing `scope`, `revision`, `freshness`, `coverage`, `completeness`, `proofStatus`, `warnings`, `nextActions`, and cursor metadata.

- [ ] **Step 1: Add failing cross-surface consistency tests.**

  For `getActiveEventConfigByObjId`, compare `context`, `explore`, and `affected` at the same commit. Assert `tests` includes the same six files and `routes` includes the same two routes wherever those fields are advertised. Assert unresolved-reference count is identical across the surfaces. Assert all relation results are `partial` or `lower_bound` when unresolved references or dynamic-dispatch gaps remain.

- [ ] **Step 2: Add failing endpoint-handler truth tests.**

  For `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs`, assert a proto/package-only node is not reported as an implementation handler. A handler may be `handled` only when it has an implementation locator (`filePath` and `startLine`) or an explicit `handlerKind:"implementation"`. Declarations must use `handlerKind:"declaration"` and remain a bounded frontier.

- [ ] **Step 3: Centralize evidence envelope construction.**

  Add one core helper used by graph, inventory, and search responses. It must read coverage/freshness/unresolved diagnostics from the same snapshot and must never default an unknown value to zero. If a source cannot provide a field, return `null` or an explicit gap rather than a misleading zero.

- [ ] **Step 4: Correct proof status and flow depth.**

  A flow ending at a proto/service node must return `completeness:"lower_bound"` and `proofStatus:"not_proven"` unless the data boundary is actually evidenced. Add `maxDepthReached` and preserve `truncated` on bounded flows. A `deadcode` result remains a candidate list with the DI/reflection/dynamic-import warning even when `totalIsExact` describes only the candidate query.

- [ ] **Step 5: Pin revision into every operation cursor.**

  Encode the selected snapshot/commit in search, endpoint, filesymbol, and deadcode cursors. Decode and reject a cursor from another revision with `CURSOR_STALE`, including `details.remediation` that tells the caller to reissue the first-page command. Keep the existing expiry check.

- [ ] **Step 6: Run the focused evidence tests.**

  ```bash
  rtk node --test tests/knowledge-query.test.mjs tests/knowledge-affected.test.mjs tests/knowledge-pagination-contract.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs
  ```

  Expected: no contradictory tests/routes/unresolved/proof fields for the same node and snapshot; gRPC declaration is not called an implementation; stale cursors fail safely.

- [ ] **Step 7: Commit the evidence change.**

  ```bash
  rtk git add packages/knowledge-core packages/knowledge-contracts/src/response.ts packages/mcp/src/knowledge-tools.ts tests/knowledge-query.test.mjs tests/knowledge-affected.test.mjs tests/knowledge-pagination-contract.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-surface-parity.test.mjs
  rtk git commit -m "fix: unify knowledge evidence boundaries"
  ```

### Task 4: Make CLI arguments, help, and errors safe for Agent automation

**Files:**

- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Test: `tests/knowledge-cli.test.mjs`
- Test: `tests/knowledge-target-resolution.test.mjs`
- Test: `packages/knowledge-cli/__tests__/round13-cli-contracts.test.ts`

**Interfaces:**

- Consumes: current CLI command switch, usage table, `emitCliError`, target resolution, and operation cursor decoding.
- Produces: stable JSON command errors and explicit per-command argument grammar.

- [ ] **Step 1: Add failing CLI contract tests.**

  Cover these exact inputs:

  ```bash
  rtk penguin filesymbols --help
  rtk penguin filesymbols --repo FPMS-NT --path apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --json
  rtk penguin filesymbols --repo FPMS-NT --file apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --json
  rtk penguin deadcode FPMS-NT --json
  rtk penguin context execute --repo FPMS-NT --json
  rtk penguin endpoint-identity NoSuchService.Nope NoSuchService.nope --json
  rtk penguin context node: --repo FPMS-NT --json
  ```

  Assert `--help` is successful, `--file` returns `UNKNOWN_OPTION`, positional deadcode scope returns `SCOPE_AMBIGUOUS`, ambiguity is valid JSON with `TARGET_AMBIGUOUS`, endpoint identity miss returns non-zero typed error, and empty node target returns `INVALID_TARGET`.

- [ ] **Step 2: Implement explicit option validation.**

  Parse known flags before dispatch. Reject unknown flags instead of placing their values into branch/path positional slots. Require `deadcode` scope to use `--repo` or `--path`. Keep `filesymbols <repo> <branch> <path>` as a compatibility form and document the equivalent `--repo`/`--branch`/`--path` form.

- [ ] **Step 3: Add real per-command help.**

  Make `help --json` emit the actual usage string for every command. Make `<command> --help` exit 0 and print the same usage, including the required positional/flag grammar for `filesymbols`, `endpoints`, `deadcode`, `endpoint-identity`, `context`, and `flow`.

- [ ] **Step 4: Normalize CLI errors to the shared contract.**

  For `--json`, every failure must be one JSON object containing `error.code`, `error.message`, `error.retryable`, and when actionable `error.details.remediation`. Preserve exit code semantics: validation/target errors exit 1, scope/cursor errors exit 2 or the documented typed code, and never exit 0 for an invalid or empty request.

- [ ] **Step 5: Make `filesymbols` and endpoint identity always enveloped.**

  Return `items`, `returnedCount`, `candidateCount`, `totalIsExact`, `truncated`, `nextCursor`, and evidence metadata even when no `--limit` is supplied. Return a typed error when endpoint identity has no match instead of `equal:false` with exit 0.

- [ ] **Step 6: Run CLI tests and the full CLI contract suite.**

  ```bash
  rtk node --test tests/knowledge-cli.test.mjs tests/knowledge-target-resolution.test.mjs
  rtk pnpm run typecheck
  ```

  Expected: all malformed and ambiguous inputs are machine-readable, no option is silently misrouted, and help is copyable by a new Agent.

- [ ] **Step 7: Commit the CLI change.**

  ```bash
  rtk git add packages/knowledge-cli packages/knowledge-contracts/src/errors.ts tests/knowledge-cli.test.mjs tests/knowledge-target-resolution.test.mjs packages/knowledge-cli/__tests__/round13-cli-contracts.test.ts
  rtk git commit -m "fix: make Penguin CLI contracts agent-safe"
  ```

### Task 5: Improve global-search performance, compact output, and onboarding quality

**Files:**

- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Test: `tests/knowledge-core-search.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/knowledge-why-memory-ontology.test.mjs`
- Test: `tests/knowledge-cli.test.mjs`

**Interfaces:**

- Consumes: search lanes, result budget enforcement, `options.compact`, onboarding document generation, and global scope resolution.
- Produces: bounded global search with explicit searched scopes, compact MCP output, and onboarding that points to architecture rather than test-file hubs.

- [ ] **Step 1: Add failing performance/disclosure tests.**

  Assert a global collision query either returns a bounded result with `scope.searchedRepos[]` and a latency warning or requires explicit scope. Assert scoped search remains the fast path. Assert compact search reduces serialized output by at least 40% while preserving IDs, scope, proof status, and next cursor.

- [ ] **Step 2: Bound unscoped search deliberately.**

  Add a query budget/abort signal to the global search lane. When the budget is reached, return `TIMEOUT_PARTIAL` or `SCOPE_REQUIRED` with the searched repository list and a command such as `penguin search "update" --repo <repo> --json`; never return a clean-looking exact empty result.

- [ ] **Step 3: Implement compact output.**

  For `knowledge_capabilities({compact:true})`, omit descriptions and full JSON schemas while retaining ID/status/tool/schema references. For `knowledge_search({options:{compact:true}})`, omit snippets/source blocks only, retaining node IDs, locators, revision, freshness, completeness, proof status, cursor, and warnings.

- [ ] **Step 4: Improve symbol ranking and onboarding.**

  Rank a real symbol definition above test mock fields when an exact symbol name matches. Exclude `*.spec.ts` from onboarding high-degree architecture nodes unless the user explicitly requests test topology. Add the first commands in copyable form: status, coverage, scoped search, explore, affected, and source-review boundary.

- [ ] **Step 5: Run focused tests.**

  ```bash
  rtk node --test tests/knowledge-core-search.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-why-memory-ontology.test.mjs tests/knowledge-cli.test.mjs
  ```

  Expected: global collisions disclose scope and stop safely, compact responses remain useful to Agents, and onboarding starts with architecture/repository entry points.

- [ ] **Step 6: Commit the usability change.**

  ```bash
  rtk git add packages/knowledge-core/src/search-engine.ts packages/mcp/src/knowledge-tools.ts packages/knowledge-core/src/onboarding.ts packages/mcp/src/knowledge-tool-defs.ts tests/knowledge-core-search.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-why-memory-ontology.test.mjs tests/knowledge-cli.test.mjs
  rtk git commit -m "fix: bound search and improve agent onboarding"
  ```

### Task 6: Prove runtime identity, update behavior, and release readiness

**Files:**

- Modify: `scripts/knowledge-mcp-session-diagnostic.mjs`
- Modify: `scripts/knowledge-install-upgrade-test.mjs`
- Modify: `scripts/knowledge-release-gate.mjs`
- Modify: `src-tauri/src/mcp.rs`
- Modify: `src-tauri/src/runtime/knowledge_runtime.rs`
- Modify: `tests/knowledge-runtime-doctor.test.mjs`
- Modify: `tests/mcp-generation-watch.test.mjs`
- Modify: `tests/mcp-release-bundle.test.mjs`
- Test: `docs/quality/index-evaluation-brief-round16.md`

**Interfaces:**

- Consumes: stable launcher, runtime manifest, `mcp_health`, Tauri MCP installation/reconfigure code, and updater bundle configuration.
- Produces: a reproducible release gate proving app, CLI, MCP, runtime, and capability hash identity, plus a manual fresh-client acceptance packet.

- [ ] **Step 1: Add failing release identity assertions.**

  The release gate must fail if any of these differ: CLI build ID, MCP `serverInfo.version`, MCP health running/available build IDs, capability hash, embedded bundle build ID, or launcher-selected runtime path.

- [ ] **Step 2: Make doctor timeout truthful.**

  If MCP doctor exceeds the 15-second hard timeout, return a typed `QUERY_TIMEOUT` result with `retryable:true`, elapsed time, operation name, and a retry command. CLI doctor and MCP doctor must not disagree on whether a timeout is a successful health result.

- [ ] **Step 3: Verify stable launcher upgrade replay.**

  Extend `knowledge-install-upgrade-test.mjs` to assert:

  ```text
  runtime A reports OUTDATED_RUNTIME after runtime B becomes available;
  the response includes availableBuildId and restart_mcp_session remediation;
  a newly started process selects runtime B;
  CLI and MCP capability hashes match runtime B;
  no old runtime path remains selected after reconfigure.
  ```

- [ ] **Step 4: Add a clean-install bundle gate.**

  `knowledge-release-gate.mjs` must inspect the built `.app` resources, launch the embedded MCP runtime, run initialize/tools/capability health, and compare the result with the installed launcher. Run this gate with a temporary `HOME`/Penguin directory so the result cannot accidentally use an old user runtime.

- [ ] **Step 5: Document the signed and unsigned build gates.**

  Unsigned local validation:

  ```bash
  rtk pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
  ```

  Signed release validation, executed only in the release environment with the secret injected:

  ```bash
  rtk pnpm tauri build
  ```

  The signed command must produce updater artifacts; if `TAURI_SIGNING_PRIVATE_KEY` is absent, the gate must report a release-secret failure rather than implying the build is complete.

- [ ] **Step 6: Execute the manual external-client acceptance.**

  In a clean user session, fully quit and reopen each client separately:

  1. Claude Desktop: verify MCP server, `tools/list`, `knowledge_capabilities({compact:true})`, scoped search, explore, affected, and cursor continuation.
  2. Claude Code: quit the process, reopen it, verify the same build/hash and execute the Round 16 packet.
  3. Codex: quit the process, reopen it, verify the same build/hash and execute the Round 16 packet.
  4. Copy the exact Agent-A node IDs and cursor into Agent-B; do not reconstruct IDs, titles, or cursors manually.

  Record the client process restart evidence separately from a fresh stdio server process. A green Settings badge alone is not acceptance evidence.

- [ ] **Step 7: Run the release test suite and regenerate the final evaluation brief.**

  ```bash
  rtk node --test tests/knowledge-runtime-doctor.test.mjs tests/mcp-generation-watch.test.mjs tests/mcp-release-bundle.test.mjs
  rtk node scripts/knowledge-release-gate.mjs
  rtk pnpm run typecheck
  rtk pnpm test
  ```

  Expected: runtime identity is consistent, update/restart behavior is observable, signed build status is explicit, and the final fresh-client report has no untested P0 gate.

- [ ] **Step 8: Commit runtime/release proof.**

  ```bash
  rtk git add scripts/knowledge-mcp-session-diagnostic.mjs scripts/knowledge-install-upgrade-test.mjs scripts/knowledge-release-gate.mjs src-tauri/src/mcp.rs src-tauri/src/runtime/knowledge_runtime.rs tests/knowledge-runtime-doctor.test.mjs tests/mcp-generation-watch.test.mjs tests/mcp-release-bundle.test.mjs docs/quality/index-evaluation-brief-round16.md
  rtk git commit -m "test: gate Penguin runtime and fresh-session continuity"
  ```

## Verification Order After All Tasks

Run the smallest checks first, then the complete suite:

```bash
rtk node --test tests/knowledge-mcp-tools.test.mjs tests/knowledge-mcp-scope.test.mjs tests/knowledge-surface-parity.test.mjs
rtk node --test tests/knowledge-query.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-pagination-contract.test.mjs
rtk node scripts/knowledge-install-upgrade-test.mjs
rtk pnpm run typecheck
rtk pnpm test
rtk pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

The result is not 95–100 until all of the following are true:

| Gate | Required evidence |
| --- | --- |
| Silent false results | Nested MCP pagination and scoped MCP search regression tests pass |
| Contract parity | Capability mapping, schemas, errors, and aliases are machine-checked |
| Evidence honesty | Context/explore/affected/flow agree on coverage, tests, routes, proof, and completeness |
| Runtime identity | CLI, MCP, launcher, app bundle, and capability hash match |
| Fresh clients | Claude Desktop, Claude Code, and Codex are fully quit/reopened and run the same packet |
| Update | Old runtime reports outdated and fresh runtime starts on the new build |
| Signed release | `pnpm tauri build` completes with updater artifacts using an injected signing key |

## Stop Conditions

Stop and report `NO-GO` instead of claiming success if any of these occurs:

- a scoped MCP query returns a clean empty result while CLI returns hits;
- a cursor input is silently ignored or returns page one again;
- a declaration/proto node is reported as a concrete implementation handler;
- `proofStatus` is `proven` while completeness is lower-bound or unresolved evidence is present;
- an MCP error is returned with `isError:false`;
- a fresh client cannot expose the same build ID and capability hash;
- the signed build is skipped but the release is described as updater-ready.

## Completion Target

After Tasks 1–5, Penguin should be safe for high-quality human-reviewed Claude/Codex investigations and should remove the current false-negative traps. After Task 6 and the external fresh-client run, it can be evaluated for the requested 95–100 internal-use standard. Autonomous code modification remains disabled unless the final packet is aligned, complete enough for the requested claim, and explicitly marked `GO` by the evidence rules.
