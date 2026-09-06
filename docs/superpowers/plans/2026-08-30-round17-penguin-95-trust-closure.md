# Penguin Round 17 — 95+ High-Trust Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Penguin Wiki/Knowledge from the Round 17 black-box result of approximately 66–67/100 to a repeatable 95+ internal-use score for Claude Code and Codex, with no silent false negatives, cross-repository evidence corruption, or misleading completeness claims.

**Architecture:** Keep one canonical query/evidence implementation in `knowledge-core`; CLI and MCP remain thin input/output adapters. Repository scope is enforced against the resolved target and endpoint membership before traversal, endpoint identity is canonicalized once during indexing, and all read surfaces reuse one evidence envelope. A frozen Round 17 acceptance gate replaces open-ended rounds of newly invented questions.

**Tech Stack:** TypeScript, Node.js, SQLite, stdio MCP, `node:test`, pnpm, Rust/Tauri, tree-sitter/WASM indexers.

**Spec:** `docs/quality/index-evaluation-brief-round17.md`, `docs/quality/index-evaluation-codex-round17.md`, `docs/quality/index-evaluation-claude-opus-5-round17.md`

## Global Constraints

- This plan targets internal Claude Code/Codex use. Tauri signing, updater publication, and public release are not 95-point blockers.
- Preserve stable public `node:<id>` and cursor behavior for valid same-repository consumers.
- An empty, stale, partial, unresolved, inferred, candidate, or lower-bound result must never become proof of absence.
- A target that does not belong to the requested repository must return a typed scope error; never relabel its source revision to the requested repository.
- CLI and MCP must call the same core operation and return the same semantic fields for the same normalized request.
- Keep global endpoint nodes only if repository membership is explicit and queryable; `repo_id IS NULL` must never mean “belongs to every repository.”
- Do not redesign the global node primary key without a failing test proving it is necessary. Round 17 evidence currently proves ownership/filtering defects, not a primary-key collision.
- Reindex only after deterministic fixture tests pass. Preserve the existing user index until the replacement index passes the frozen black-box gate.
- Do not create Round 18/19 question packs to move the goalposts. The acceptance dimensions and hard gates in this plan are frozen.
- Preserve unrelated dirty worktree changes and do not commit them with this plan.

## Model Review Synthesis and Rulings

Claude Code and DeepSeek independently agreed that `affected`, cross-repository scope/revision, endpoint identity/handler truth, endpoint context/flow consistency, and silent invalid-input success block 95. Both agreed that release signing does not block internal 95.

They differed on timing: DeepSeek estimated 5–7 working days assuming four parallel engineers; Claude Code estimated 5.5–8.5 days for one engineer with Agent help. This plan uses **6–9 working days / 54–82 engineering hours** because the current workspace has one coordinating engineer/Agent system and endpoint identity requires index rebuild evidence.

Source inspection produced three binding rulings:

1. `affected` already shares `affectedByFiles`/`affectedByNode` in core. The likely split is input classification: CLI resolves one path as a target before selecting the file contract, while MCP receives a file field and selects the file contract. Fix normalization and dispatch first; do not duplicate another builder.
2. Endpoint rows are deliberately stored/queryable as global (`repo_id IS NULL`), and current inventory accepts `(n.repo_id=? OR n.repo_id IS NULL)`. Fix explicit endpoint membership and canonical identity; do not assume changing the node primary key is required.
3. Search currently derives freshness from the broad `incomplete` flag, which includes excluded files. Split revision freshness from coverage/completeness; excluded files may make proof partial without making an aligned repository stale.

## Frozen 95+ Acceptance Contract

| Gate | Required evidence | 95 blocker |
| --- | --- | --- |
| G1 CLI/MCP parity | Same normalized `affected`, endpoint, context, flow, and error requests have equal semantic results | Yes |
| G2 Repository isolation | Wrong-repo node/endpoint returns `SCOPE_MISMATCH`; no source repo/revision is rewritten | Yes |
| G3 Endpoint truth | One canonical endpoint identity; aliases resolve to it; declaration/proto-only targets are not `handled` | Yes |
| G4 Context/flow agreement | Same endpoint has the same depth-1 relation set and evidence state across context and flow | Yes |
| G5 No silent invalid success | Empty query, unknown repo/branch/file, invalid node and cursor return typed non-zero errors | Yes |
| G6 Freshness truth | Search/context/flow/affected agree on freshness for one revision; coverage gaps remain separate | Yes |
| G7 Public ID/cursor continuity | All emitted IDs round-trip; endpoints/filesymbols/deadcode cursor normal/exhausted/invalid/wrong-scope paths pass | Yes |
| G8 Knowledge honesty | Empty API docs are not exhaustive; list surfaces expose provenance and evidence envelopes | Required for 98; no actively misleading output allowed for 95 |
| G9 Fresh clients | Claude Code and Codex fully quit/reopen once and replay the same packet on the same build/hash | Yes for final internal GO; not an automated product-code requirement |

The score is calculated once from the frozen Round 17 rubric. A new observation may become a blocker only when it violates G1–G9; it does not add a new scoring dimension.

## Planned File Map

| Area | Files | Responsibility |
| --- | --- | --- |
| Acceptance harness | `tests/knowledge-round17-closure.test.mjs`, `scripts/knowledge-round17-acceptance.mjs`, `tests/fixtures/knowledge-round17/*` | Freeze every Round 17 P0/P1 as a deterministic test plus real-index black-box gate |
| Target/input normalization | `packages/knowledge-cli/src/command-dispatch.ts`, `packages/mcp/src/knowledge-tools.ts`, `packages/knowledge-contracts/src/input-schemas.ts` | Select file vs node contract identically and reject invalid requests |
| Affected semantics | `packages/knowledge-core/src/query.ts` | One file/node blast-radius implementation and evidence envelope |
| Endpoint identity/index | `packages/knowledge-contracts/src/endpoint-identity.ts`, `packages/knowledge-indexer/src/grpc-client.ts`, `packages/knowledge-indexer/src/routes.ts`, `packages/knowledge-indexer/src/pipeline.ts`, `packages/knowledge-core/src/store.ts` | Canonical gRPC identity, aliases, declaration/implementation and repository membership |
| Endpoint query/scope | `packages/knowledge-core/src/query.ts`, `packages/knowledge-cli/src/command-dispatch.ts`, `packages/mcp/src/knowledge-tools.ts` | Scoped inventory, handler truth, context/flow agreement and cursor revision |
| Search/evidence/errors | `packages/knowledge-core/src/search-engine.ts`, `packages/knowledge-contracts/src/errors.ts`, `packages/knowledge-contracts/src/response.ts` | Separate freshness/completeness and normalize typed failures/envelopes |
| Wiki/API honesty | `packages/knowledge-core/src/api-doc-knowledge-adapter.ts`, note/tag/snapshot/evidence stores, MCP bundling files | Provenance, packaging and truthful coverage |
| Release/runtime validation | existing `scripts/knowledge-release-bundle-gate.mjs`, `scripts/knowledge-install-upgrade-test.mjs` | Confirm installed runtime identity after semantic gates pass; do not redo runtime architecture |

---

### Task 1: Freeze Round 17 P0/P1 Reproductions Before Fixing

**Files:**

- Create: `tests/knowledge-round17-closure.test.mjs`
- Create: `scripts/knowledge-round17-acceptance.mjs`
- Create: `tests/fixtures/knowledge-round17/README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: existing CLI launcher, `runKnowledgeTool`, temporary `KnowledgeStore`, and current capability hash.
- Produces: `pnpm run knowledge:round17:gate`, returning one JSON report with G1–G8 and a non-zero exit when any hard gate fails.

- [x] **Step 1: Add failing parity tests for `affected`.**

  Build a fixture containing one changed file, two defined symbols, one caller, one `tests` edge, and one `handles` edge. Call CLI with the file path and MCP with `{repo, files:[path]}`. Assert equal `changed`, `impacted`, `tests`, `routes`, `proofStatus`, `scope`, and `revision` sets.

- [x] **Step 2: Add failing cross-repository tests.**

  Create repo A and repo B with one node each plus a global endpoint linked only to repo A. Assert `flow/context node:<A-id> --repo B` and repo-B endpoint inventory reject or exclude the target with `SCOPE_MISMATCH`.

- [x] **Step 3: Add failing endpoint canonicalization tests.**

  Index client and provider forms of one package-qualified gRPC method. Assert unqualified title, qualified title, route, and emitted node ID resolve to one canonical endpoint. Assert proto/declaration-only linkage is `incomplete`, not `handled`.

- [x] **Step 4: Add failing context/flow first-hop tests.**

  For the endpoint fixture, compare normalized depth-1 relation tuples `(edgeType,nodeId,repoId,revisionId,evidenceState)` from context and flow.

- [x] **Step 5: Add failing freshness and error tests.**

  Assert an aligned clean repo with excluded files is `fresh` plus partial coverage. Assert empty query, unknown repo/branch/file, invalid node, malformed cursor, and wrong-scope cursor return typed JSON and non-zero exit codes.

- [x] **Step 6: Add the real-index acceptance script.**

  The script must run the exact frozen FPMS-NT probes from both Round 17 reports, compare CLI/MCP normalized JSON, redact source bodies, and emit `{passed,gates,failures,buildId,capabilityHash,revision}`. It must not modify source, index, configuration, notes, or reports.

  Add this exact package script:

  ```json
  "knowledge:round17:gate": "node scripts/knowledge-round17-acceptance.mjs --gate"
  ```

- [x] **Step 7: Run tests and prove the current defects fail.**

  Run:

  ```bash
  rtk node --test tests/knowledge-round17-closure.test.mjs
  rtk node scripts/knowledge-round17-acceptance.mjs --repo FPMS-NT --gate
  ```

  Expected before implementation: failures for affected parity, endpoint membership/canonicalization, cross-repo traversal, freshness, and silent invalid inputs.

### Task 2: Make File and Node `affected` One Explicit Contract

**Files:**

- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Test: `tests/knowledge-round17-closure.test.mjs`
- Test: `tests/knowledge-affected.test.mjs`

**Interfaces:**

- Consumes: `affectedByFiles`, `affectedByNode`, resolved revision and explicit `file/files/target/node` inputs.
- Produces: one normalized request `{kind:"file"|"node", values:string[], repoId, revision}` before core dispatch.

- [x] **Step 1: Reject ambiguous affected input.**

  If both file fields and node/target fields are supplied, return `INVALID_ARGUMENT`. A repo-relative path matching an indexed file must take the file contract before fuzzy target resolution.

- [x] **Step 2: Normalize CLI and MCP into the same request.**

  Remove adapter-specific fallback ordering. Both adapters must call the same core dispatch function after normalization.

- [x] **Step 3: Preserve file-level tests/routes and honesty fields.**

  For zero changed symbols, return `proofStatus:"not_proven"` and `totalIsExact:false` unless complete indexed-file lookup proves the file exists and has no symbols. Never return an exact zero for an unresolved path.

- [x] **Step 4: Run focused parity tests.**

  ```bash
  rtk node --test tests/knowledge-round17-closure.test.mjs tests/knowledge-affected.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-cli.test.mjs
  ```

  Expected: G1 affected parity passes and the Round 17 file returns the same semantic result on CLI and MCP.

### Task 3: Canonicalize Endpoint Identity and Record Repository Membership

**Files:**

- Create: `packages/knowledge-contracts/src/endpoint-identity.ts`
- Modify: `packages/knowledge-contracts/src/index.ts`
- Modify: `packages/knowledge-indexer/src/grpc-client.ts`
- Modify: `packages/knowledge-indexer/src/routes.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Test: `tests/knowledge-round17-closure.test.mjs`
- Test: endpoint/indexer contract tests adjacent to the modified packages

**Interfaces:**

- Produces: `canonicalGrpcIdentity({packageName,service,method})`, `grpcIdentityAliases(...)`, and explicit endpoint membership `{endpointId,repoId,role:"provider"|"consumer"|"declaration"}`.
- Consumes: extracted proto package/service/method and provider implementation locator.

- [x] **Step 1: Centralize gRPC normalization.**

  Use package-qualified identity when package metadata is available. Keep unqualified `grpc::Service.method` as an alias, never as a second independently traversable endpoint.

- [x] **Step 2: Persist explicit repository membership.**

  Global endpoint nodes may remain global, but every inventory inclusion must come from a provider/consumer/declaration membership edge or table. `repo_id IS NULL` alone grants no membership.

- [x] **Step 3: Separate handler kinds.**

  Only a node with implementation locator and provider membership may produce `handlerStatus:"handled"`. Proto/module/declaration links produce `proto_only` or `incomplete`.

- [x] **Step 4: Add rebuild compatibility.**

  Bump the index semantic/schema version when stored endpoint identity or membership changes. Old indexes must report `REINDEX_REQUIRED`; they must not silently mix old and new endpoint families.

- [x] **Step 5: Run indexer and identity tests.**

  Expected: one canonical endpoint, aliases round-trip, no duplicate twins, and repository membership is explicit.

### Task 4: Enforce Target Ownership and Preserve Source Revision

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Test: `tests/knowledge-round17-closure.test.mjs`
- Test: `tests/knowledge-target-resolution.test.mjs`

**Interfaces:**

- Produces: `assertTargetInScope(target, requestedScope)` and typed `SCOPE_MISMATCH` details containing requested and actual repo/revision IDs.

- [x] **Step 1: Validate ownership after target resolution and before traversal.**

  Ordinary nodes use their owning repo. Global endpoints use explicit endpoint membership from Task 3. Reject a target with no membership in the requested repo.

- [x] **Step 2: Derive each returned source revision from its source repository.**

  Never stamp all flow steps with the requested branch/revision. If a valid cross-service edge is intentionally returned, preserve each step's own repo/revision and label the boundary.

- [x] **Step 3: Apply the same check to context, flow, affected, callers, callees, explore and endpoint inventory.**

  Add adapter parity assertions for each public continuation surface.

- [x] **Step 4: Run scope tests.**

  Expected: G2 passes; the exact Round 17 FPMS endpoint queried under `claude_code` is rejected rather than relabelled.

### Task 5: Make Endpoint Context, Flow and Inventory Share One First-Hop View

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-round17-closure.test.mjs`
- Test: `tests/knowledge-query.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`

**Interfaces:**

- Produces: one endpoint relation reader returning canonical endpoint, memberships, handlers, edge evidence, and first-hop relations.

- [x] **Step 1: Use the shared reader in inventory, context and flow.**

  Depth-1 relation tuples must be identical. Context may add grouped summaries; it may not suppress a first hop that flow exposes.

- [x] **Step 2: Scope inventory through membership and pin cursor revision.**

  Remove `(n.repo_id=? OR n.repo_id IS NULL)` as the membership rule. Encode repo membership, selected revision and canonical ordering into endpoint cursors.

- [x] **Step 3: Stabilize pagination counts.**

  `candidateCount` remains the total candidate count for every page; use `remainingCount` separately if needed. Exhausted pages return `nextCursor:null`, `truncated:false`, and exact total.

- [x] **Step 4: Run endpoint and cursor suites.**

  Expected: G3, G4 and endpoint portions of G7 pass on fixture and real FPMS-NT index.

### Task 6: Separate Freshness, Coverage and Completeness; Normalize Errors

**Files:**

- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-round17-closure.test.mjs`
- Test: `tests/knowledge-core-search.test.mjs`
- Test: `tests/knowledge-cli.test.mjs`

**Interfaces:**

- Freshness answers only revision alignment/worktree drift.
- Coverage answers admitted/excluded/failed/stale files.
- Completeness/proof status answers whether the result supports the requested claim.

- [x] **Step 1: Remove coverage exclusions from freshness calculation.**

  An aligned clean repo with excluded files is `fresh`, while its negative proof remains `partial/not_proven` with `COVERAGE_INCOMPLETE`.

- [x] **Step 2: Reject invalid searches and unresolved file scopes.**

  Empty/whitespace query returns `INVALID_QUERY`; unknown repo/branch/file returns `REPOSITORY_NOT_FOUND`, `BRANCH_NOT_FOUND`, or `FILE_NOT_FOUND`. JSON mode always emits the shared envelope and a non-zero exit.

- [x] **Step 3: Remove unaddressable search hits.**

  A symbol/field hit must have a public node ID. If only source text exists, return it as `source_occurrence`, not a symbol hit with `nodeId:null`. `node:null` is always `INVALID_TARGET`.

- [x] **Step 4: Run focused tests.**

  Expected: G5 and G6 pass; the clean FPMS-NT search is fresh while still warning that seven excluded files prevent proof of absence.

### Task 7: Finish Evidence Envelopes and Wiki/API Honesty

**Files:**

- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/api-doc-knowledge-adapter.ts`
- Modify: `packages/knowledge-cli/src/api-doc-command.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/api-doc-generator/src/coverage.ts`
- Modify: `packages/api-doc-generator/src/preview-store.ts`
- Modify: `packages/knowledge-indexer/src/notes.ts`
- Modify: `packages/knowledge-indexer/src/notes-public.ts`
- Modify: `packages/knowledge-indexer/src/evidence.ts`
- Modify: MCP bundle/package configuration that currently omits `@penguin/knowledge-indexer`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-round17-closure.test.mjs`
- Test: API-doc, note, snapshot and MCP bundle tests adjacent to modified packages

**Interfaces:**

- Produces one list envelope containing `items`, `scope`, `revision`, `freshness`, `coverage`, `completeness`, `proofStatus`, counts and cursor metadata.

- [x] **Step 1: Wrap endpoints/filesymbols/deadcode/coverage and Wiki lists in the shared envelope.**

  Unknown fields remain `null` plus a coverage gap; do not synthesize zero.

- [x] **Step 2: Make API-doc coverage evidence-derived.**

  A preview with no revisions/endpoints/evidence is `not_proven` or `empty`, never `exhaustive`. Compare preview revision IDs with the current index and mark stale previews.

- [x] **Step 3: Repair read-only Wiki parity and provenance.**

  Ensure note/link/tag/snapshot/evidence list tools are packaged and exposed consistently. Return source, timestamp, scope/revision and sensitivity/permission state where available.

- [x] **Step 4: Run Wiki/API and MCP bundle tests.**

  Expected: G8 has no misleading outputs. Full provenance completion is the 98-point target; 95 requires at minimum removal of false `exhaustive` and runtime module failures.

### Task 8: Rebuild Once and Run the Frozen Final Gate

**Files:**

- Modify: `scripts/knowledge-round17-acceptance.mjs`
- Modify: `scripts/knowledge-release-gate.mjs`
- Update: `docs/quality/index-evaluation-brief-round17.md` only if a command name changed; do not add scenarios or scoring dimensions
- Create: `docs/quality/index-evaluation-round17-closure-result.md`

**Interfaces:**

- Produces one immutable acceptance report for the candidate build/index generation.

- [x] **Step 1: Run all deterministic checks before touching the real index.**

  ```bash
  rtk pnpm run typecheck
  rtk pnpm test
  rtk node scripts/knowledge-round17-acceptance.mjs --fixture --gate
  ```

- [x] **Step 2: Build a replacement index generation and validate it before activation.**

  Reindex FPMS-NT and the minimum collision repositories into a new generation. Run G1–G8 against that generation. Activate it only if every hard gate passes.

- [x] **Step 3: Build and run runtime identity gates.**

  ```bash
  rtk pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
  rtk node scripts/knowledge-release-bundle-gate.mjs
  rtk node scripts/knowledge-install-upgrade-test.mjs
  ```

  Signing/updater artifacts are intentionally excluded from this internal-use gate.

- [x] **Step 4: Execute one fixed fresh-client replay.**

  Fully quit/reopen Claude Code and Codex. In each, run the same `knowledge-round17-acceptance` packet, record build ID/capability hash/revision, and replay emitted IDs/cursors without reconstruction.

- [x] **Step 5: Calculate the frozen score and stop.**

  Declare internal GO only when both clients score at least 95, G1–G7 pass, G8 has no actively misleading result, and there are no P0/P1 defects. Do not create a new question round after GO.

## Timeline and Delivery Targets

| Target | Required scope | Estimate |
| --- | --- | ---: |
| 95–97 | Tasks 1–6, G1–G7, no misleading API-doc output, one fixed fresh-client replay | 54–82 hours / 6–9 working days |
| 98 | 95–97 plus complete Task 7 provenance/envelope parity and independent two-client evidence | +16–24 hours / 2–3 days |
| 100 | Complete dynamic-dispatch/DI evidence modeling, full edge provenance, exhaustive performance and boundary corpus | Multi-week roadmap; not a credible fixed-date promise |

## Final Stop and NO-GO Conditions

### Announce 95+ and stop when all are true

- G1–G7 pass on deterministic fixtures and the replacement real index.
- G8 contains no false `exhaustive`, runtime module failure, or bare result that could be interpreted as proof.
- Claude Code and Codex each replay the same fixed packet after a real quit/reopen and score at least 95.
- Build ID, capability hash, schema and index revision are recorded and aligned.
- Remaining gaps are explicitly `lower_bound/not_proven`, not silent failures.

### Remain NO-GO when any is true

- CLI and MCP disagree semantically for the same normalized request.
- A wrong-repo target is accepted without a cross-repository boundary or has its revision rewritten.
- A declaration/proto module is reported as a concrete handler.
- Context and flow disagree on the first hop.
- Invalid input returns exit 0, a bare empty list, or an untyped error.
- Freshness contradicts revision alignment, or coverage gaps are hidden.
- An empty/stale API document is marked exhaustive.

### Deferred without blocking internal 95

- Tauri signing, updater publication and public release operations.
- Automatic proof for every possible client lifecycle; one audited quit/reopen per target client is sufficient.
- Complete modeling of DI, reflection and dynamic dispatch, provided the system returns `not_proven` honestly.
- Sub-second global-search performance and complete Wiki permission administration.
