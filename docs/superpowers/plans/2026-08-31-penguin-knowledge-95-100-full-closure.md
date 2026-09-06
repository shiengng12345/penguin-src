# Penguin Knowledge 95–100 Full Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every retained Round 16/17 regression, every verified Round 18 product/environment gap, and the complete SQLite + sqlite-vec persistent hybrid-search program so fresh Claude Code and Codex sessions can independently score 95–100 without benchmark gaming.

**Architecture:** Preserve graph and lexical retrieval as deterministic truth lanes. Repair their contracts, search quality, graph completeness, evidence envelopes, repository scope, and runtime observability first; then add a versioned sqlite-vec recall lane with index-time document embeddings, one query embedding per uncached query, explicit lifecycle/rollback, and RRF fusion. CLI, MCP, Tauri, generated documentation, and the installed runtime must all consume the same contracts and report the same build, scope, revision, and capability state.

**Tech Stack:** TypeScript/Node.js, better-sqlite3, sqlite-vec, Rust/Tauri, MCP stdio, pnpm, Node test runner, generated JSON Schema and Markdown references.

**Spec:**

- `docs/quality/index-evaluation-brief-round18.md`
- `docs/quality/index-evaluation-codex-round18.md`
- `docs/quality/index-evaluation-claude-opus-5-round18.md`
- `docs/quality/index-evaluation-round17-closure-result.md`
- `docs/quality/penguin-knowledge-power-roadmap-claude-deepseek.md`

## Global Constraints

- This is one complete closure program. Round 16/17 regression protection, Round 18 fixes, and persistent vector search are all in scope.
- Do not describe the whole program as complete when only the 95 milestone is complete.
- Preserve the user's existing dirty worktree. Do not overwrite or revert unrelated edits.
- Versioned evaluation briefs and completed reports are immutable. A new evaluation gets a new filename and a recorded SHA-256.
- Graph and lexical results remain the truth lanes. Vector results are candidates and never prove a call edge, flow, safety, coverage, or absence.
- Exact node IDs, exact symbol names, exact routes, and proven graph edges must outrank semantic candidates.
- Document/chunk embeddings are produced during indexing/backfill only. Query execution may compute exactly one query embedding per uncached query; it must never embed source documents at query time.
- sqlite-vec failure is fail-closed for semantic retrieval. Production must not silently fall back to an unbounded JSON cosine scan.
- Repository, branch, snapshot, ACL, and active embedding-space filters are mandatory on every vector read.
- Schema/model migrations use staging generations, integrity checks, an atomic active pointer, retained rollback state, and delayed garbage collection.
- No release recommendation is implied. Signing/notarization and external release remain separate user decisions.
- Deployment boundary: Penguin Wiki/Knowledge is currently private internal infrastructure on the owner's Mac. The owner/operator may use Tauri, local CLI, local indexing, and storage diagnostics; every other person is a fresh consumer who may use only a Penguin MCP client calling the public client-module request surface. Consumer acceptance must not assume a local Wiki UI, CLI binary, source checkout, index database, or filesystem access.
- Score owner/admin readiness and consumer MCP capability separately. Local CLI/Tauri evidence can prove owner-side readiness only; it cannot substitute for a fresh consumer MCP session. The final consumer gate requires two independent fresh Claude/Codex sessions using MCP-only requests, while public release remains out of scope.
- All shell commands in implementation and verification use the repository's `rtk` prefix requirement.

---

## 1. Independent-review synthesis and binding decisions

Claude Code and DeepSeek agreed on the architecture and disagreed mainly on schedule. Both require contracts/runtime first, graph/lexical correctness second, coverage/evidence third, and the full vector lifecycle last. Claude estimated 95 in 3–4 weeks and full 100 in 8–10 weeks; DeepSeek estimated 95 in 6–7 weeks and full 100 in 11–14 weeks.

This plan uses three delivery gates:

| Milestone | Required scope | Target | Risk upper bound | Completion wording |
| --- | --- | ---: | ---: | --- |
| A — trusted graph/lexical closure | Tasks 1–8 | 4–6 weeks | 7 weeks | “95 milestone verified”; never “all complete” |
| B — macOS hybrid/vector closure | Tasks 9–13 on arm64+x64 | 8–10 weeks cumulative | 12 weeks | “internal macOS 100 candidate” |
| C — complete platform closure | Tasks 1–14 including Linux/Windows, signing evidence, and two-agent retest | 11–14 weeks cumulative | 16 weeks if model/package gates fail | “full program complete” only after Gate G12 |

Binding technical decisions:

1. Honest semantic unavailability can still earn a genuine 95 because Round 18 allocates 2–3/7 for that state, but the user-requested full program continues until semantic/vector is real.
2. The existing vector-roadmap criterion “query-time embedding provider calls = 0” is corrected to “query-time document embeddings = 0.” A vector query must embed the query once unless an exact cache key already exists.
3. DeepSeek's Python-wheel warning is translated to this repository's real boundary: Node ABI, npm `sqlite-vec` native artifacts, Tauri resource packaging, OS, and architecture.
4. Production JSON-vector fallback is removed. It remains available only behind an explicit test/debug flag and is never advertised as semantic-ready.
5. Round 18 score disagreements are not resolved by averaging. Shared defects become mandatory gates; evaluator-only findings become direct acceptance tests.

## 2. Current source map

| Area | Current files | Current gap |
| --- | --- | --- |
| Capability registry | `packages/knowledge-contracts/src/capabilities.ts`, `surface.ts`, `input-schemas.ts` | generated canonical names exist, but installed MCP still exposed manifest/name/schema mismatches |
| MCP registration | `packages/mcp/src/knowledge-tool-defs.ts`, `knowledge-tools.ts`, `index.ts` | aliases and listed tools have multiple mapping layers; coverage/service scope handlers bypass canonical behavior |
| CLI transport | `packages/knowledge-cli/src/args.ts`, `command-dispatch.ts`, `query-worker.ts` | no proper version identity; several `--json` failures still emit text; coverage only emits aggregates |
| Search | `packages/knowledge-core/src/search-planner.ts`, `search-ranking.ts`, `search-engine.ts`, `path-search.ts`, `source-search.ts` | source lane weight 1.0 outranks symbol 0.85; exact mode excludes symbol lane; business queries are not robustly tokenized |
| Graph/affected | `packages/knowledge-core/src/graph-query.ts`, `dispatch-resolution.ts`, `query.ts` | `who_injects` exists, but `affectedByNode` traverses the generic impact graph and misses DI/interface dispatch |
| Indexer | `packages/knowledge-indexer/src/pipeline.ts` and parser/resolver modules | aggregate unresolved counts persist, but concrete unresolved reference items and framework dependency edges do not fully feed public graph queries |
| Service graph | `packages/knowledge-core/src/query.ts` (`serviceGraph`), MCP/CLI adapters | repo filter ignored by MCP; service IDs are not public continuation IDs; edges lack evidence envelope |
| Coverage | `coverage_records`, `unresolved_reference_coverage`, `coverage_layers` in `schema.ts` | aggregate per-file counts exist; individual unresolved targets are not retained and coverage read returns `items: []` |
| Semantic skeleton | `semantic-chunks.ts`, `embedding-provider.ts`, `semantic-search.ts`, `vector-store.ts`, schema v15 tables | content-only chunk ID collision, no active-space lifecycle, query-time document embedding, optional JSON fallback |
| Runtime packaging | `scripts/vendor-knowledge-runtime.mjs`, `src-tauri/src/runtime/knowledge_runtime.rs`, release gates | better-sqlite3 and re2-wasm are bundled; sqlite-vec and a local embedding runtime are not |
| Settings UX | `src/components/settings/SettingsDialog.tsx`, `mcp-status.ts`, `src/lib/knowledge-client.ts` | MCP state is shown; semantic backend/model/backfill/vector integrity is not |

## 3. Completion state machine

Every implementation task and final handoff must use one of these exact states:

```text
NOT_STARTED
IMPLEMENTED_SOURCE_ONLY
TESTED_SOURCE_ONLY
BUNDLED_NOT_INSTALLED
INSTALLED_NOT_RELOADED
VERIFIED_ONE_FRESH_AGENT
CLOSED_TWO_FRESH_AGENTS
```

Only `CLOSED_TWO_FRESH_AGENTS` may be described as complete for a black-box capability. A Tauri build, DMG copy, “MCP Ready” badge, configuration presence, or matching hash alone is not completion.

### Deployment personas

```text
Owner/operator (this Mac)
  Tauri / local Wiki / CLI / indexer / storage and runtime diagnostics
  -> proves local administration and server readiness

Fresh consumer (all other users)
  Claude or Codex MCP client only
  -> initialize -> tools/list -> client-module request -> evidence envelope
  -> no local source, CLI, database, or Wiki UI assumption
```

The acceptance reports must label every result as `owner_local` or `consumer_mcp_only`. A consumer score is invalid if it relies on a local CLI fallback. An MCP-unavailable consumer environment is reported as an environment blocker, not silently converted into a product pass.

---

### Task 1: Freeze a single, versioned closure benchmark

**Files:**

- Create: `docs/quality/index-evaluation-brief-round19.md`
- Create: `tests/fixtures/knowledge-round19/README.md`
- Create: `tests/fixtures/knowledge-round19/expected-contract.json`
- Create: `scripts/knowledge-round19-acceptance.mjs`
- Create: `tests/knowledge-round19-acceptance.test.mjs`
- Modify: `docs/quality/index-evaluation-brief.md`
- Modify: `package.json`

**Interfaces:**

- Produces `Round19RunHeader = { briefVersion, briefSha256, buildId, capabilityHash, schemaVersion, contractVersion, runtimePath, clientSessionId, startedAt }`.
- Produces one deterministic acceptance runner with sections G0–G12 and machine-readable JSON output.
- The unversioned `index-evaluation-brief.md` becomes a small pointer containing the active version and SHA-256, not a second editable question set.

- [ ] **Step 1: Write a failing test that rejects a stale/mismatched active brief.**

  Assert that the active pointer names Round 19, the file exists, its hash matches, and its required report filename is Round 19.

- [ ] **Step 2: Run the test and confirm it fails against the current Round 15 pointer.**

  Run: `rtk node --test tests/knowledge-round19-acceptance.test.mjs`

- [ ] **Step 3: Create the immutable Round 19 packet.**

  Include all Round 16/17 fixtures, all Q1–Q20/B1–B8 Round 18 classes, vector lifecycle/quality cases, and a deterministic target fallback: after the fixed concept query, select only symbol-lane hits sorted by `(score desc, identityKey, nodeId)`; if none exist, fail the discovery scenario rather than allowing evaluator-specific refinements.

- [ ] **Step 4: Implement the acceptance runner and active pointer.**

  The runner records every command/tool input, exit code, timing, scope, revision, counts, cursor, lanes, evidence, and workaround. It never reads an old report as an answer key.

- [ ] **Step 5: Add package scripts and run the fixture-only gate.**

  Run: `rtk pnpm knowledge:round19:acceptance -- --fixtures-only`

- [ ] **Step 6: Commit as an independent benchmark change.**

  Proposed commit: `test(knowledge): freeze round19 full closure benchmark`

**Exit gate:** G0 passes; Codex and Claude receive byte-identical briefs and cannot choose different targets after a zero-result concept query.

---

### Task 2: Make CLI/MCP contracts single-source and errors uniform

**Files:**

- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/knowledge-contracts/src/surface.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `scripts/knowledge-docs-generate.mjs`
- Test: `tests/knowledge-capability-manifest.test.mjs`
- Test: `tests/knowledge-tool-discoverability.test.mjs`
- Test: `tests/knowledge-surface-parity.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`

**Interfaces:**

```ts
interface SurfaceRegistration {
  capabilityId: string;
  wireName: string;
  aliases: string[];
  inputSchema: KnowledgeInputSchema;
  outputSchemaId: string;
  mutating: boolean;
}

type CursorErrorCode =
  | "CURSOR_INVALID"
  | "CURSOR_EXPIRED"
  | "CURSOR_OPERATION_MISMATCH"
  | "CURSOR_REQUEST_MISMATCH"
  | "CURSOR_REVISION_STALE";
```

- [ ] **Step 1: Add failing conformance tests.**

  Assert every implemented MCP registration has exactly one canonical wire name, every advertised name is callable, aliases resolve to the same capability, and no listed tool has an empty schema unless its capability explicitly accepts no arguments.

- [ ] **Step 2: Add failing typed-error tests.**

  Cover unknown repo on `coverage`, `endpoints`, `node`, `service_graph`; malformed cursor; wrong-operation cursor; changed-limit cursor; invalid semantic mode; and missing required arguments.

- [ ] **Step 3: Generate MCP tool definitions from `listMcpRegistrations()`.**

  Keep legacy names only as explicit aliases. Remove independent MCP-only schema overrides and make `canonicalInputSchema()` authoritative.

- [ ] **Step 4: Promote complete schemas.**

  Add typed schemas for `knowledge.coverage`, `knowledge.endpoints`, `knowledge.file_symbols`, `knowledge.service_graph`, `knowledge.index_status`, and every Round 19 exercised capability.

- [ ] **Step 5: Route all CLI/MCP failures through one `KnowledgeErrorEnvelope`.**

  Every JSON error must include `code`, `message`, `retryable`, `details`, and a copyable `remediation`. Keep human text rendering as a view of the same object.

- [ ] **Step 6: Regenerate docs and snapshots.**

  Run: `rtk pnpm knowledge:docs:generate`

- [ ] **Step 7: Run focused parity tests.**

  Run: `rtk node --test tests/knowledge-capability-manifest.test.mjs tests/knowledge-tool-discoverability.test.mjs tests/knowledge-surface-parity.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-pagination-contract.test.mjs`

- [ ] **Step 8: Commit.**

  Proposed commit: `fix(knowledge): unify cli mcp contracts and typed errors`

**Exit gate:** G1 passes at 100% advertised/callable/schema parity. No hard-cap-triggering contract divergence remains.

---

### Task 3: Expose runtime identity, native health, update state, and artifact provenance

**Files:**

- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/mcp/src/generation-watch.ts`
- Modify: `src-tauri/src/runtime/knowledge_runtime.rs`
- Modify: `src-tauri/src/mcp.rs`
- Modify: `scripts/vendor-knowledge-runtime.mjs`
- Modify: `scripts/knowledge-release-bundle-gate.mjs`
- Modify: `scripts/knowledge-release-gate.mjs`
- Test: `tests/knowledge-runtime-manager.test.mjs`
- Test: `tests/knowledge-bundle-runtime.test.mjs`
- Test: `tests/mcp-generation-watch.test.mjs`
- Test: `tests/mcp-release-bundle.test.mjs`
- Create: `tests/knowledge-install-upgrade-test.mjs`

**Interfaces:**

```ts
interface RuntimeIdentity {
  appVersion: string;
  buildId: string;
  capabilityHash: string;
  schemaVersion: number;
  contractVersion: string;
  runtimeRoot: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  nativeDependencies: Array<{ name: string; version: string; path: string; sha256: string; status: "ready" | "unavailable" | "mismatch" }>;
  signing: { status: "signed" | "unsigned" | "unknown"; identity?: string; notarized?: boolean };
  generation: { runningBuildId: string; availableBuildId: string; outdated: boolean; restartRequired: boolean };
}
```

- [ ] **Step 1: Add failing CLI `version --json` and doctor identity tests.**

  `penguin --version`, `penguin version --json`, `penguin doctor --json`, and `mcp_health` must expose the same build/hash/schema/contract and current runtime path.

- [ ] **Step 2: Extend the versioned runtime manifest.**

  Include native dependency hashes/status, target platform/arch, app artifact identity, and signing/notarization state. Activation rejects missing required native artifacts before switching `current`.

- [ ] **Step 3: Preserve stable launcher and generation semantics.**

  Existing clients continue using stable launchers. Long-lived MCP processes report `outdated` and `restart_mcp_session`; they never claim to hot-reload code in place.

- [ ] **Step 4: Add cold two-session replay to the release gate.**

  Spawn two separate MCP processes, record their PIDs/start times, initialize both, compare health/tools/capability hash, replay a fresh node ID and cursor, then terminate them cleanly.

- [ ] **Step 5: Run runtime tests.**

  Run: `rtk node --test tests/knowledge-runtime-manager.test.mjs tests/knowledge-bundle-runtime.test.mjs tests/mcp-generation-watch.test.mjs tests/mcp-release-bundle.test.mjs tests/knowledge-install-upgrade-test.mjs`

- [ ] **Step 6: Commit.**

  Proposed commit: `feat(knowledge): expose verifiable runtime identity and generation`

**Exit gate:** G2 proves installed, configured, loaded, self-contained, and useful as separate claims. Configuration presence is never accepted as reload proof.

---

### Task 4: Repair exact, path-qualified, and business-intent search

**Files:**

- Modify: `packages/knowledge-core/src/search-planner.ts`
- Modify: `packages/knowledge-core/src/search-ranking.ts`
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/path-search.ts`
- Modify: `packages/knowledge-core/src/source-search.ts`
- Modify: `packages/knowledge-contracts/src/search.ts`
- Test: `tests/knowledge-search-engine.test.mjs`
- Test: `tests/knowledge-core-search.test.mjs`
- Test: `tests/knowledge-path-search.test.mjs`
- Create: `tests/knowledge-round18-search-regressions.test.mjs`

**Interfaces:**

```ts
interface ParsedKnowledgeQuery {
  raw: string;
  identifier?: string;
  path?: string;
  terms: string[];
  intent: "exact_identifier" | "path_qualified" | "business_intent" | "free_text";
}

interface RankTuple {
  exactIdentity: 0 | 1;
  exactTitle: 0 | 1;
  termCoverage: number;
  lanePriority: number;
  laneScore: number;
}
```

- [ ] **Step 1: Add the exact Round 18 failures as tests.**

  `BalanceCheckHandler` must return its symbol node at rank 1. `apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts#BalanceCheckHandler` must resolve the same node. The business query must return at least one hit under `apps/payment/src/payment/withdrawal/` without semantic retrieval.

- [ ] **Step 2: Change the planner.**

  Exact identifier mode runs symbol and source lanes; path-qualified input is split into path scope plus identifier; business intent tokenizes normalized terms and searches source/symbol with term-coverage ranking.

- [ ] **Step 3: Change ranking to a lexicographic tuple.**

  Exact node/identity/title outranks every source occurrence. Semantic scores cannot move an exact symbol below rank 1. Source occurrences inside a known symbol carry `locator.nodeId` and `symbol`.

- [ ] **Step 4: Keep pagination deterministic.**

  Put query parser version, ranker version, normalized terms, and lane configuration into the cursor request fingerprint/capability hash.

- [ ] **Step 5: Run focused tests and the lexical benchmark.**

  Run: `rtk node --test tests/knowledge-search-engine.test.mjs tests/knowledge-core-search.test.mjs tests/knowledge-path-search.test.mjs tests/knowledge-round18-search-regressions.test.mjs`

  Run: `rtk node scripts/knowledge-universal-retrieval-benchmark.mjs --lane lexical`

- [ ] **Step 6: Commit.**

  Proposed commit: `fix(knowledge): prioritize exact symbols and tokenize intent queries`

**Exit gate:** G3: exact symbol rank 1, path form same node, concept query non-zero and in-scope, no cross-repo leak, no exact/node/route regression.

---

### Task 5: Persist framework dispatch and make affected/callers trustworthy

**Files:**

- Modify: `packages/knowledge-core/src/dispatch-resolution.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Create: `packages/knowledge-indexer/src/framework-edges.ts`
- Test: `tests/knowledge-dispatch-resolution.test.mjs`
- Test: `tests/knowledge-graph-query.test.mjs`
- Test: `tests/knowledge-affected.test.mjs`
- Create: `tests/knowledge-nestjs-affected.test.mjs`

**Interfaces:**

```ts
type FrameworkEdgeType = "injects" | "provides" | "implements" | "dispatches_to";

interface FrameworkEdgeEvidence {
  origin: "parser" | "framework_adapter" | "runtime";
  method: "EXTRACTED" | "DI_MODULE_PROVIDER" | "INTERFACE_IMPLEMENTATION" | "RUNTIME_OBSERVED";
  confidence: number;
  scope: "revision" | "environment";
  provenance: { filePath: string; startLine?: number; token?: string };
}
```

- [ ] **Step 1: Create a failing NestJS fixture matching the Round 18 case.**

  Model a handler interface, `BalanceCheckHandler`, constructor injection in `WithdrawalCheckService`, and provider registration in a module. Node-target and file-target affected results must both include the service/module dependency with explicit inferred evidence.

- [ ] **Step 2: Convert existing dispatch-resolution output into persisted edges.**

  The index transaction writes framework edges with branch/revision scope. Re-index replaces prior edges for the file atomically.

- [ ] **Step 3: Teach callers/callees/impact/affected to traverse framework edges.**

  Proven direct calls and extracted DI stay distinct. File targets expand all symbols in the file; node targets expand one symbol; both then use the same traversal engine and envelope.

- [ ] **Step 4: Correct negative-result semantics.**

  `totalIsExact` is false whenever completeness is `lower_bound` or unresolved references remain. Every result includes `proofStatus`, `candidateCount`, `returnedCount`, and concrete coverage gaps.

- [ ] **Step 5: Run focused tests.**

  Run: `rtk node --test tests/knowledge-dispatch-resolution.test.mjs tests/knowledge-graph-query.test.mjs tests/knowledge-affected.test.mjs tests/knowledge-nestjs-affected.test.mjs tests/knowledge-evidence-contract.test.mjs`

- [ ] **Step 6: Commit.**

  Proposed commit: `feat(knowledge): include framework dispatch in impact analysis`

**Exit gate:** G4: the Round 18 handler returns at least one real impacted service/module candidate; CLI and MCP produce the same node/file semantics; empty results are never presented as safe absence.

---

### Task 6: Carry edge evidence through every graph and flow hop

**Files:**

- Create: `packages/knowledge-core/src/graph-evidence.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Test: `tests/knowledge-evidence-contract.test.mjs`
- Test: `tests/knowledge-external-call-visibility.test.mjs`
- Create: `tests/knowledge-flow-edge-evidence.test.mjs`

**Interfaces:**

```ts
interface GraphEdgeEvidenceEnvelope {
  evidenceState: "proven" | "inferred" | "candidate" | "unresolved";
  origin: string | null;
  method: string | null;
  confidence: number | null;
  scope: "revision" | "environment" | "unknown";
  provenance: { filePath?: string; startLine?: number; evidenceId?: string } | null;
  gaps: string[];
}
```

- [ ] **Step 1: Write failing flow tests.**

  Every non-root step must contain the envelope. A missing source edge becomes `unresolved` with a named gap; it is never represented by omission.

- [ ] **Step 2: Centralize edge-to-evidence mapping.**

  Map `edges.origin`, `method`, `confidence`, `provenance`, `evidence_id`, and `boundary` once in `graph-evidence.ts`; endpoint, flow, context, affected, and service graph reuse it.

- [ ] **Step 3: Separate execution and reference projections.**

  `flow.executionSteps` contains `handles`, `calls`, framework dispatch, external/data boundaries. `flow.referenceSteps` contains type/reference relationships. The top-level completeness explains each frontier.

- [ ] **Step 4: Run tests.**

  Run: `rtk node --test tests/knowledge-evidence-contract.test.mjs tests/knowledge-external-call-visibility.test.mjs tests/knowledge-flow-edge-evidence.test.mjs`

- [ ] **Step 5: Commit.**

  Proposed commit: `feat(knowledge): preserve evidence on every graph hop`

**Exit gate:** G5: 100% of emitted flow/service edges contain explicit evidence state; “execution chain” is not majority unlabeled type references.

---

### Task 7: Make service graph scoped, evidenced, and round-trippable

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-repo-scope.test.mjs`
- Test: `tests/knowledge-mcp-scope.test.mjs`
- Create: `tests/knowledge-service-graph-contract.test.mjs`

**Interfaces:**

```ts
type ServiceIdentity = `service:${string}`; // suffix is repoId

interface ServiceGraphRequest {
  repo?: string;
  includeDirectNeighbours?: boolean;
  revision?: RevisionContext;
}
```

- [ ] **Step 1: Add failing unknown-repo, scope, and continuation tests.**

  An unknown repo returns `REPOSITORY_NOT_FOUND`. `repo=FPMS-NT` returns FPMS-NT plus direct neighbours only. Every emitted `service:<repoId>` resolves through `context`, `graph`, and `path` without title reconstruction.

- [ ] **Step 2: Refactor `serviceGraph(store, request)`.**

  Resolve repo once, filter nodes/edges before building output, preserve direct-neighbour identity, and add the shared graph/evidence envelope with current revisions.

- [ ] **Step 3: Add service identity support to target resolution.**

  Do not pretend a raw `repo_*` is a symbol node. Use the typed `service:` form and return a service context object with repo/root/branch/snapshot information.

- [ ] **Step 4: Apply the same resolver to `index_status`.**

  A repo argument filters to that repo; unknown scope fails rather than returning all repositories.

- [ ] **Step 5: Run tests.**

  Run: `rtk node --test tests/knowledge-repo-scope.test.mjs tests/knowledge-mcp-scope.test.mjs tests/knowledge-service-graph-contract.test.mjs`

- [ ] **Step 6: Commit.**

  Proposed commit: `fix(knowledge): enforce service scope and stable identities`

**Exit gate:** G6: no silent global fallback, no unresolvable service ID, and every service edge has revision/evidence.

---

### Task 8: Turn coverage debt into a paginated work queue

**Files:**

- Create: `packages/knowledge-core/src/coverage-query.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-evidence-contract.test.mjs`
- Create: `tests/knowledge-coverage-items.test.mjs`

**Interfaces:**

```ts
type CoverageDebtKind = "excluded" | "failed" | "stale" | "unresolved";

interface CoverageDebtItem {
  kind: CoverageDebtKind;
  repoId: string;
  branchId?: string;
  snapshotId?: string;
  filePath: string;
  startLine?: number;
  sourceNodeId?: string;
  rawTarget?: string;
  reasonCode: string;
  reason: string;
}
```

- [ ] **Step 1: Add a schema migration for concrete unresolved items.**

  Create a revision-scoped `unresolved_reference_items` table keyed by repo, branch, revision, file, source locator, raw target, and resolution reason. Keep aggregate tables for fast status queries.

- [ ] **Step 2: Persist unresolved items in the same file transaction as edges.**

  Delete/replace a file's prior revision items atomically. Preserve ambiguous, external, dynamic, and unresolved categories separately.

- [ ] **Step 3: Implement one paginated core query.**

  `listCoverageDebt({ repo, kind, path, limit, cursor })` returns aggregate coverage plus named items, exact/unknown totals, revision, and HMAC cursor.

- [ ] **Step 4: Wire CLI and MCP.**

  CLI grammar: `penguin coverage --repo FPMS-NT --kind unresolved --limit 20 --cursor <token> --json`. MCP uses the same request schema and output validator.

- [ ] **Step 5: Reconcile counts.**

  For each revision, `SUM(file unresolved counts) == unresolved_reference_coverage total-resolved == count/categorized item total`, with explicit overflow metadata if storage is intentionally capped.

- [ ] **Step 6: Run tests.**

  Run: `rtk node --test tests/knowledge-evidence-contract.test.mjs tests/knowledge-coverage-items.test.mjs`

- [ ] **Step 7: Commit.**

  Proposed commit: `feat(knowledge): enumerate excluded and unresolved coverage debt`

**Exit gate:** G7: FPMS-NT's seven exclusions return paths/reasons, and unresolved references return concrete paginated items. Aggregate-only `items: []` is no longer possible when debt is non-zero.

---

### Task 9: Replace the semantic skeleton with versioned identities and lifecycle tables

**Files:**

- Create: `packages/knowledge-core/src/semantic-identity.ts`
- Create: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/semantic-chunks.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Test: `tests/knowledge-vector-store.test.mjs`
- Create: `tests/knowledge-semantic-identity.test.mjs`
- Create: `tests/knowledge-embedding-lifecycle.test.mjs`

**Interfaces:**

```ts
interface ChunkIdentityInput {
  repoId: string;
  snapshotId: string;
  canonicalFilePath: string;
  nodeId?: string;
  startByte: number;
  endByte: number;
  contentHash: string;
  chunkerVersion: string;
}

interface EmbeddingSpaceIdentity {
  providerId: string;
  modelId: string;
  weightsDigest: string;
  tokenizerDigest: string;
  dimensions: number;
  pooling: string;
  normalization: string;
  chunkerVersion: string;
}

type EmbeddingGenerationStatus = "staging" | "active" | "retired" | "failed";
type EmbeddingJobStatus = "pending" | "running" | "ready" | "failed" | "deleting";
```

- [ ] **Step 1: Write collision, migration, and state-transition tests.**

  Identical text in two files/repos must produce different chunk IDs; a model/tokenizer/pooling change must produce a different space ID; invalid lifecycle transitions fail.

- [ ] **Step 2: Add the next schema migration.**

  Add `embedding_spaces`, `embedding_generations`, `embedding_jobs`, and `semantic_active_spaces`; extend chunks with repo/snapshot/path/chunker identity. Existing v15 rows migrate to a non-active legacy generation and are never silently served.

- [ ] **Step 3: Implement canonical identity hashes.**

  Persist both the hash and every provenance field. Do not use model ID or content hash alone as an identity.

- [ ] **Step 4: Make activation atomic.**

  A generation can become active only when expected chunks, ready refs, vector rows, dimensions, and integrity checks agree. Keep the previous active generation until delayed GC.

- [ ] **Step 5: Run tests.**

  Run: `rtk node --test tests/knowledge-vector-store.test.mjs tests/knowledge-semantic-identity.test.mjs tests/knowledge-embedding-lifecycle.test.mjs`

- [ ] **Step 6: Commit.**

  Proposed commit: `feat(knowledge): version chunks models and embedding generations`

**Exit gate:** G8a: no cross-file chunk collision, no mixed embedding space, valid atomic activation/rollback, and legacy data cannot masquerade as ready.

---

### Task 10: Package sqlite-vec and a verified local embedding provider

**Files:**

- Modify: `packages/knowledge-core/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/vendor-knowledge-runtime.mjs`
- Modify: `src-tauri/src/runtime/knowledge_runtime.rs`
- Create: `packages/knowledge-core/src/local-embedding-provider.ts`
- Modify: `packages/knowledge-core/src/embedding-provider.ts`
- Create: `config/knowledge-embedding-models.json`
- Create: `scripts/knowledge-model-bakeoff.mjs`
- Test: `tests/knowledge-bundle-runtime.test.mjs`
- Create: `tests/knowledge-sqlite-vec-runtime.test.mjs`
- Create: `tests/knowledge-local-embedding.test.mjs`

**Interfaces:**

```ts
interface LocalEmbeddingManifest {
  providerId: "local";
  modelId: string;
  modelFile: string;
  weightsDigest: string;
  tokenizerFile: string;
  tokenizerDigest: string;
  dimensions: number;
  maxTokens: number;
  pooling: string;
  normalization: string;
  license: string;
}
```

- [ ] **Step 1: Add a release-bundle test that currently fails to load sqlite-vec.**

  Run the vendored Node binary from an isolated directory, load better-sqlite3 and sqlite-vec, create a `vec0` table, insert/query a vector, and assert no workspace `node_modules` path appears.

- [ ] **Step 2: Move sqlite-vec into the real runtime dependency closure.**

  Add it to `@penguin/knowledge-core` dependencies and make the vendor script copy its complete npm/native closure for the target OS/arch/Node ABI. Extend runtime manifest hashes and activation validation.

- [ ] **Step 3: Implement a local inference backend behind `EmbeddingProvider`.**

  The model bake-off writes a pinned manifest only after candidates pass internal retrieval quality, license, package size, cold start, batch throughput, and arm64/x64 tests. The selected weights/tokenizer digests become the embedding-space identity.

- [ ] **Step 4: Make native/model failures explicit.**

  `doctor`, `capabilities`, and `mcp_health` expose `SQLITE_VEC_MISSING`, `MODEL_MISSING`, `MODEL_HASH_MISMATCH`, `DIMENSION_MISMATCH`, or `NO_ACTIVE_SPACE`. Semantic remains unavailable; graph/lexical remains healthy.

- [ ] **Step 5: Disable production JSON fallback.**

  Permit it only with `PENGUIN_VECTOR_DEBUG_FALLBACK=1` in tests. It must never set semantic readiness true.

- [ ] **Step 6: Run native/provider tests for both macOS architectures.**

  Run: `rtk node --test tests/knowledge-sqlite-vec-runtime.test.mjs tests/knowledge-local-embedding.test.mjs tests/knowledge-bundle-runtime.test.mjs`

- [ ] **Step 7: Commit.**

  Proposed commit: `feat(knowledge): vendor sqlite vec and local embedding runtime`

**Exit gate:** G8b: installed runtime loads sqlite-vec and the pinned local model without workspace dependencies; failure is explicit and fail-closed.

---

### Task 11: Build resumable index-time embedding, deletion, and GC

**Files:**

- Create: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Create: `packages/knowledge-indexer/src/embedding-worker.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-indexer/src/watcher.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Modify: `packages/knowledge-core/src/storage-report.ts`
- Create: `tests/knowledge-embedding-indexer.test.mjs`
- Create: `tests/knowledge-vector-gc.test.mjs`
- Create: `tests/knowledge-vector-crash-recovery.test.mjs`

**Interfaces:**

```ts
interface EmbeddingBackfillCheckpoint {
  generationId: string;
  lastChunkId: string | null;
  expectedChunks: number;
  readyChunks: number;
  failedChunks: number;
  cancelled: boolean;
}
```

- [ ] **Step 1: Add failing add/change/delete/reindex tests.**

  Include 100 randomized cycles, duplicate content in different files, deletion during backfill, provider failure, disk-full simulation, process interruption, and resume.

- [ ] **Step 2: Generate chunks after source facts are committed.**

  Queue jobs by generation/chunk. Batch embeddings, checkpoint progress, and never publish a partial generation.

- [ ] **Step 3: Implement incremental invalidation.**

  Unchanged chunk identities reuse ready vectors in the same space. Changed/deleted chunks transition through `deleting`, remove vec rows and refs transactionally, and become GC candidates.

- [ ] **Step 4: Serialize maintenance.**

  Reuse the resident runtime's atomic maintenance lock. Concurrent index/backfill/GC/VACUUM operations must not interleave destructively.

- [ ] **Step 5: Add integrity and storage reporting.**

  Report expected/current chunks, pending/ready/failed refs, vector rows, orphan counts, active/staging generations, model disk usage, and last backfill checkpoint.

- [ ] **Step 6: Run lifecycle tests.**

  Run: `rtk node --test tests/knowledge-embedding-indexer.test.mjs tests/knowledge-vector-gc.test.mjs tests/knowledge-vector-crash-recovery.test.mjs`

- [ ] **Step 7: Commit.**

  Proposed commit: `feat(knowledge): add resumable embedding backfill and vector gc`

**Exit gate:** G9a: `ready_refs == current_chunks == vector_rows`, orphans are zero, partial backfill never becomes active, and old active space survives every injected failure.

---

### Task 12: Replace query-time document embedding with scoped persisted hybrid retrieval

**Files:**

- Create: `packages/knowledge-core/src/hybrid-search.ts`
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/semantic-search.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Modify: `packages/knowledge-contracts/src/search.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-search-engine.test.mjs`
- Create: `tests/knowledge-hybrid-search.test.mjs`
- Create: `tests/knowledge-vector-scope-acl.test.mjs`
- Create: `tests/knowledge-vector-cli-mcp-parity.test.mjs`

**Interfaces:**

```ts
interface HybridSearchConfig {
  rrfK: number;
  lexicalLimit: number;
  vectorLimit: number;
  exactPin: boolean;
  activeSpaceId: string;
  rankerVersion: string;
}

interface RetrievalProvenance {
  lanes: Array<{ lane: "exact" | "source" | "symbol" | "graph" | "vector"; rank: number; score?: number }>;
  embeddingSpaceId?: string;
  chunkId?: string;
  retrievalFingerprint: string;
}
```

- [ ] **Step 1: Add failing persisted-retrieval tests.**

  Instrument the provider: each uncached query may embed one query; document embedding calls during search must be zero. Remove the current `LIMIT 1000` source scan from the semantic path.

- [ ] **Step 2: Prototype filtered ANN against the pinned sqlite-vec version.**

  Verify whether repo/snapshot partition keys or a metadata join can enforce filters before result emission without unacceptable recall loss. Freeze the proven physical plan in a test; do not assume API behavior.

- [ ] **Step 3: Implement persisted vector retrieval.**

  Resolve authorized repo/branch/snapshot/chunk scope first, query only the active embedding space, and return locators/provenance. Unauthorized rows must never appear in results or debug evidence.

- [ ] **Step 4: Implement RRF fusion.**

  Exact identity/title is pinned first. Graph/lexical ranks and vector ranks fuse through deterministic RRF; vector-only hits remain `candidate/inference`.

- [ ] **Step 5: Define semantic modes.**

  `off`: deterministic lanes only. `fallback`: vector runs only after weak/no deterministic recall. `blend`: deterministic and vector run together. `semantic` with unavailable backend returns typed `MODE_UNAVAILABLE`, not successful no-match.

- [ ] **Step 6: Make CLI/MCP call the same async engine.**

  Remove transport-specific default modes and legacy source-hit merging for the canonical v2 path.

- [ ] **Step 7: Run search/scope/parity tests.**

  Run: `rtk node --test tests/knowledge-hybrid-search.test.mjs tests/knowledge-vector-scope-acl.test.mjs tests/knowledge-vector-cli-mcp-parity.test.mjs tests/knowledge-search-engine.test.mjs`

- [ ] **Step 8: Commit.**

  Proposed commit: `feat(knowledge): add scoped persisted hybrid retrieval`

**Exit gate:** G9b: no query-time document embeddings, no scope leak, exact results never regress, CLI/MCP top-10 plus metadata are identical.

---

### Task 13: Benchmark, migrate, roll back, and expose semantic readiness in UI

**Files:**

- Create: `tests/fixtures/knowledge-hybrid-benchmark/queries.jsonl`
- Create: `scripts/knowledge-hybrid-benchmark.mjs`
- Create: `scripts/knowledge-embedding-migration-test.mjs`
- Modify: `src/components/settings/SettingsDialog.tsx`
- Modify: `src/components/settings/mcp-status.ts`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `docs/knowledge-v2/capability-matrix.md`
- Modify: `docs/knowledge-v2/cli-reference.md`
- Modify: `docs/knowledge-v2/mcp-reference.md`
- Modify: `docs/knowledge-v2/schema-reference.md`
- Create: `tests/knowledge-hybrid-benchmark-gate.test.mjs`

**Interfaces:**

- Benchmark has at least 200 labeled questions: exact identifiers/routes/nodes, concepts/synonyms, cross-service intent, dynamic dispatch, negative claims, and incomplete coverage.
- Settings shows provider, model/weights digest, embedding space, backend, active/staging state, progress, ready/failed/orphan counts, disk usage, last error, and whether data leaves the machine.

- [ ] **Step 1: Freeze the graph/lexical baseline before enabling hybrid.**

  Store results and metrics by benchmark version, build ID, repo revision, model space, chunker version, and ranker fingerprint.

- [ ] **Step 2: Run model bake-off and select the pinned local model.**

  Required: concept Recall@10 improves at least 15%, overall MRR@10 does not fall, exact top-1 regressions are zero, license is acceptable, and package/performance limits pass.

- [ ] **Step 3: Test model migration and rollback.**

  Backfill a staging space while the old active space serves; atomically activate; force a quality/integrity failure; roll back data/model/index pointer together; verify no mixed rows.

- [ ] **Step 4: Add performance gates.**

  Initial macOS 100k-chunk targets: warm query p95 under 300ms, cold under 2s, incremental file update p95 under 2s. Record measured hardware and do not extrapolate 1M-chunk claims.

- [ ] **Step 5: Add UI readiness and failure states.**

  “Semantic Ready” requires sqlite-vec load, active model, active generation, non-zero ready vectors, zero integrity blockers, and current revision coverage. Otherwise show the exact unavailable/degraded reason.

- [ ] **Step 6: Run benchmark and UI/build tests.**

  Run: `rtk node scripts/knowledge-hybrid-benchmark.mjs --gate`

  Run: `rtk node scripts/knowledge-embedding-migration-test.mjs`

  Run: `rtk pnpm typecheck`

- [ ] **Step 7: Commit.**

  Proposed commit: `feat(knowledge): gate hybrid readiness with benchmark and rollback`

**Exit gate:** G10: benchmark, latency, migration, rollback, UI honesty, and provenance all pass. A table's existence or vector count alone cannot satisfy readiness.

---

### Task 14: Build, install, cross-platform verify, and run two independent agents

**Files:**

- Modify: `.github/workflows/build.yml` (extend the existing macOS matrix with explicit Linux x64/arm64 and Windows x64 build, native-runtime, artifact, signing, and verification jobs)
- Modify: `scripts/knowledge-release-bundle-gate.mjs`
- Modify: `scripts/knowledge-signed-release-build.mjs`
- Modify: `scripts/knowledge-round19-acceptance.mjs`
- Create: `docs/quality/index-evaluation-codex-round19.md` only during the actual Codex run
- Create: `docs/quality/index-evaluation-claude-opus-round19.md` only during the actual Claude run
- Create: `docs/quality/index-evaluation-round19-closure-result.md` only after both reports pass

**Interfaces:**

- Platform matrix: macOS arm64/x64 first; Linux x64/arm64 and Windows x64 before full-program completion. The private owner build may be used as the server; consumer validation uses only the MCP client boundary.
- Fresh-consumer matrix: one new Claude MCP session and one new Codex MCP session, each with no local Wiki/CLI/source/database access. Both must perform initialize, tools/list, capability discovery, one client-module request, one continuation, one negative/error request, and one evidence-aware workflow.
- Every artifact records app hash, runtime manifest hash, native module hashes, signing/notarization state, and accepted model artifact hashes.

- [ ] **Step 1: Run the full source gate.**

  Run: `rtk pnpm typecheck`

  Run: `rtk pnpm test`

  Run: `rtk pnpm knowledge:round17:acceptance`

  Run: `rtk pnpm knowledge:round19:acceptance -- --source-runtime`

- [ ] **Step 2: Build the self-contained Tauri artifacts.**

  Run: `rtk pnpm tauri build`

  A signing environment may be supplied only by the user/release environment. Never print or persist `TAURI_SIGNING_PRIVATE_KEY`.

- [ ] **Step 3: Run the release-bundle gate before installation.**

  Verify both CLI and MCP with the vendored Node, better-sqlite3, sqlite-vec, local model, WASM parsers, identical build/hash/schema, and no workspace dependency.

- [ ] **Step 4: Install and launch as a user would.**

  Confirm stable launchers, automatic client configuration, current generation activation, explicit restart guidance, and a healthy new MCP session. Keep old generation rollback available.

- [ ] **Step 5: Re-index the designated test repositories and backfill embeddings.**

  Record exact repo/snapshot/model/chunk/vector counts. Do not reuse old node IDs, cursors, or old report conclusions.

- [ ] **Step 6: Run Round 19 in two completely new clients.**

  One fresh Codex process and one fresh Claude Code process receive only the immutable brief. Neither may load prior Penguin evaluation memory. Each creates its own report.

- [ ] **Step 7: Apply the final closure rules.**

  Product and Environment must each be 95–100 in both reports, no hard cap may trigger, all required vector scenarios must pass, and all numeric disagreements must be reproduced before resolution.

- [ ] **Step 8: Verify Linux and Windows packaging before full-program closure.**

  Run the same native load, lifecycle, search, rollback, and fresh-session gates. Platform-specific unsupported status is not full completion.

- [ ] **Step 9: Commit closure evidence only after both independent runs pass.**

  Proposed commit: `test(knowledge): close round19 full knowledge program`

**Exit gate:** G11 is the two-agent 95–100 closure; G12 is cross-platform/native/signing closure. Only G12 permits “all fixes complete.”

---

## 4. Global acceptance gates

| Gate | Pass condition | Blocks |
| --- | --- | --- |
| G0 Benchmark identity | same immutable brief hash, deterministic target rule, fresh IDs only | every score |
| G1 Contract parity | 100% manifest/tool/schema/alias parity; typed errors everywhere | all MCP claims |
| G2 Runtime truth | version/runtime/native/generation/artifact evidence aligned | Environment 95+ |
| G3 Search | exact rank 1; path same node; business query useful; no scope leak | Product 95+ |
| G4 Impact | DI/interface edges present; file/node/CLI/MCP semantics explicit and aligned | safe-change claims |
| G5 Evidence | every graph/flow edge explicit proven/inferred/candidate/unresolved evidence | flow trust |
| G6 Service identity | repo scope enforced; unknown repo typed; service ID round-trips | cross-repo score |
| G7 Coverage actionability | named/paginated excluded and unresolved items reconcile with totals | negative claims |
| G8 Vector foundation | sqlite-vec/runtime/model ready; identities/lifecycle atomic | semantic enablement |
| G9 Vector lifecycle/search | zero query-time document embedding; zero orphans; scoped RRF; parity | hybrid readiness |
| G10 Quality/rollback | Recall/MRR/exact/latency/migration/rollback gates pass | default enablement |
| G11 Fresh agents | independent fresh consumer Codex and Claude MCP-only sessions each score Product and Environment 95–100; owner-local checks are reported separately | “95 verified” |
| G12 Full closure | owner macOS/Linux/Windows package gates plus artifact/signing evidence and consumer MCP-only replay | “all complete” |

## 5. Minimum 95 versus full 100

### Honest 95 milestone

Tasks 1–8 must be complete and G0–G7/G11 must pass. Semantic may remain explicitly unavailable, but every graph/lexical dimension must be near-perfect. This is mathematically possible under Round 18 because honest unavailability earns 2–3/7, but it leaves almost no room for another weak dimension.

### Internal macOS 100 candidate

Tasks 1–13 must be complete. sqlite-vec, local model, active vector generation, hybrid retrieval, benchmark, migration, rollback, and arm64/x64 packaging must all pass. Both independent agents must actually execute semantic queries and observe the same result/provenance.

### Full program complete

Task 14 and G12 must pass. Linux/Windows native packaging, fresh-install behavior, artifact provenance, and requested signing/notarization evidence are included. This is the only point at which the phrase “全部完成” is allowed.

## 6. Rollback strategy

1. Every runtime build installs into an immutable generation directory; failed validation never replaces `current`.
2. Graph/lexical search remains callable when semantic is disabled or degraded.
3. Every embedding migration creates a staging space. Old active vectors remain untouched until activation.
4. Activation updates one active-space pointer transactionally. Rollback restores the previous pointer; no document re-embedding is needed.
5. Old spaces are retained through a defined recovery window and protected from GC while referenced by active/rollback pointers.
6. Schema migration takes a verified backup and dry-run integrity report. User notes, ledger, evidence, saved queries, API previews, and other writable state are preserved.
7. A failed native extension/model/hash/ACL/quality gate disables semantic only; it cannot degrade exact/graph/lexical behavior.

## 7. Final reporting contract

Every progress answer during implementation must include:

```text
Overall program: X%
Current milestone: A | B | C
Current state: one of the seven completion states
Completed gates: G...
In-progress task: Task N
Remaining blockers: exact named blockers
Source tests: pass/fail/not run
Bundled runtime: pass/fail/not built
Installed runtime: pass/fail/not installed
Fresh Codex: pass/fail/not run
Fresh Claude: pass/fail/not run
```

No percentage may be based only on elapsed time or lines changed. Weight progress by acceptance gates: Milestone A 45%, Milestone B 40%, Milestone C 15%.

## 8. Execution order

```text
Task 1 benchmark lock
  -> Task 2 contract/error parity
  -> Task 3 runtime identity and old-regression gates
  -> Task 4 search correctness
  -> Task 5 framework impact
  -> Task 6 graph evidence
  -> Task 7 service identity/scope
  -> Task 8 coverage work queue
  -> fresh two-agent 95 gate
  -> Task 9 vector identities/lifecycle
  -> Task 10 sqlite-vec/local model packaging
  -> Task 11 embedding backfill/GC
  -> Task 12 persisted hybrid retrieval
  -> Task 13 benchmark/migration/UI
  -> fresh two-agent macOS 100 gate
  -> Task 14 cross-platform and final closure
```

Tasks 4 and 7 may be implemented in parallel after Tasks 1–3. Tasks 5 and 8 may be implemented in parallel once shared evidence/error contracts are stable. Tasks 9–12 remain sequential because identity, native packaging, lifecycle, and retrieval depend on one another.

## 9. Final decision

**GO** for Task 1 immediately. Do not start by building Tauri or enabling semantic mode. The first release-quality checkpoint is the graph/lexical 95 gate; the program then continues without being called complete until persistent vector search and the complete platform closure pass.
