# Penguin Unified Knowledge Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Preserve the existing dirty worktree, use test-first changes, and do not run the external evaluation until the installed-artifact oracle is green.

**Goal:** Make Penguin the single local knowledge system for Claude Code and Codex, replacing CodeGraph for code graphs, replacing UnderstandAnything and Graphify for code understanding and architecture knowledge, and replacing the code-knowledge portion of Obsidian with a source-backed, searchable Wiki.

**Architecture:** One canonical repository/revision/evidence model feeds Core, CLI, MCP and Tauri. Deterministic source, symbol, endpoint and graph retrieval remains the factual base; semantic/vector retrieval is an optional second lane that may rank or expand results only when its model, generation, snapshot and coverage are verified. A durable local runtime owns indexing, semantic jobs, status and client synchronization, while the UI and MCP expose the same state without silently inventing completeness.

**Tech Stack:** TypeScript, Node.js, pnpm workspaces, better-sqlite3, SQLite/sqlite-vec, local ONNX/Nomic embeddings, MCP stdio, Tauri 2/Rust, Node test runner, Git branch/revision metadata.

**Spec:** `docs/quality/index-evaluation-brief-round27-frozen.md`, `docs/quality/index-evaluation-brief.md` and `docs/superpowers/plans/2026-09-02-penguin-product-capability-95-100-final-closure.md`

## Global Constraints

- The official product score is the lower score of one fresh Claude Code MCP-only session and one fresh Codex MCP-only session; implementation progress is never presented as product capability score.
- Nomic/vector work is explicitly skipped during the current deterministic repair pass. No embedding worker, Ollama process, vector reset or semantic-generation deletion may run until the deterministic gates pass.
- The full replacement target still includes semantic/vector retrieval; skipping it is a temporary execution choice, not permission to declare UnderstandAnything or Graphify replacement complete.
- Penguin is local and private in this milestone. Do not design around a public hosted Wiki or assume other users have the owner’s local repository index.
- Client users access Penguin through the installed MCP runtime. Claude/Codex configuration must point to the stable launcher, never to a mounted DMG or transient `.app` path.
- Every positive claim must carry repository, branch, commit, snapshot, stable identity, file and line evidence. Every negative claim must carry coverage and completeness limits.
- A scoped query must be bounded. Warm MCP p95 targets are: exact lookup 200 ms, scoped search/context 500 ms, endpoint query 700 ms, affected/ordinary flow 1 s, cross-repo graph 2 s. Cold start is measured separately and must be below 5 s for the first scoped query.
- Full reset means Penguin’s guarded, recoverable reset workflow. Never use raw recursive deletion against a home directory, workspace root or unresolved path.
- Preserve unrelated user edits. Do not reset, checkout, stash, stage or commit unless the user explicitly requests it.
- A new external evaluation is allowed only after two consecutive installed-artifact oracle passes with no database mutation between runs.

## Independent review corrections

Claude Code and DeepSeek reviewed this plan independently. These corrections are part of the plan:

- Extend the existing `scripts/knowledge-product-capability-gate.mjs` and `tests/knowledge-product-capability-closure.test.mjs`; do not create a second competing oracle.
- Use the existing `docs/quality/index-evaluation-brief-round27-frozen.md` as the frozen external brief and add the R1/R2/R3 scoring contract there.
- Verify the active runtime hash before any real acceptance request. A temporary workspace bundle is not acceptance evidence until it is installed or explicitly selected by the launcher.
- Measure p50/p95/p99 from repeated samples. A single duration must never be copied into all three percentile fields.
- Do not run S7 while Nomic is skipped. S6 may produce an internal deterministic/R1 smoke result, but it cannot produce the official 95–100 product score.
- Use actual runtime files: `src-tauri/src/mcp.rs`, `src-tauri/src/runtime/commands.rs`, `src-tauri/src/runtime/controller.rs`, `src-tauri/src/runtime/knowledge_runtime.rs` and `scripts/knowledge-mcp-launcher.mjs`.
- Use actual semantic benchmark entry points `scripts/knowledge-semantic-performance-gate.mjs` and `scripts/knowledge-semantic-performance-clone.mjs`.
- Compare canonical normalized payloads across surfaces; raw JSON whitespace or transport framing is not a product difference, but fields, identities, totals, cursors, evidence and error codes must match.

## 1. What “replacement” means

Penguin will have three explicit replacement levels so a passing code-graph test is not confused with a passing full-product test.

| Level | Replaces | Required result |
| --- | --- | --- |
| R1 | CodeGraph | Exact symbol search, callers/callees, affected nodes, endpoint discovery, branch-aware graph and evidence-backed flow work through CLI and MCP. |
| R2 | UnderstandAnything + Graphify for code | R1 plus semantic/vector retrieval, architecture/domain pages, configuration-to-runtime flows, cross-service relationships, summaries and honest source/inference labels. |
| R3 | Obsidian for code knowledge | R2 plus Markdown-compatible Wiki pages, notes, tags, backlinks, citations, local import/export and a usable Tauri knowledge surface. General Obsidian plugins, canvas automation and unrelated personal-notes features are not claimed unless separately implemented and tested. |

The release is “full target complete” only when R1, R2 and R3 gates pass. If Nomic remains disabled, the maximum honest claim is R1 plus the deterministic part of R2.

## 2. Finite delivery stages

| Stage | Deliverable | User-visible retest? |
| --- | --- | --- |
| S0 | Frozen oracle and baseline of all known failures | No |
| S1 | Runtime, schema, repository and branch truth | No |
| S2 | Fast deterministic search, endpoint and pagination | No |
| S3 | Complete graph, flow, affected and evidence contract | No |
| S4 | Semantic/vector lifecycle and quality | No; explicitly deferred in the current pass |
| S5 | Wiki/notes, Tauri controls and first-user onboarding | No |
| S6 | Installed DMG, full reset, index/rebuild, stress and parity | No |
| S7 | Exactly two fresh external evaluations | Yes, once |

Every stage has a local gate. A failed external evaluation is mapped back to an existing gate and fixed in one batch; it does not automatically create another endless round.

---

## Stage S0 — Freeze one capability oracle

### Task S0.1: Convert historical failures into executable cases

**Files:**
- Modify: `tests/knowledge-product-capability-closure.test.mjs`
- Modify: `tests/knowledge-round27-frozen-brief.test.mjs`
- Create: `tests/fixtures/knowledge-unified-replacement/questions.json`
- Create: `tests/fixtures/knowledge-unified-replacement/expected-gates.json`
- Modify: `scripts/knowledge-product-capability-gate.mjs`
- Modify: `package.json`

**Interface produced:** The existing `knowledge-product-capability-gate.mjs` emits JSON rows with `gateId`, `capability`, `scope`, `expected`, `observed`, `timingsMs`, `evidence` and `passed`; the process exits non-zero if any release gate fails.

- [ ] Add reproductions for every confirmed failure: stale indexed commit, zero-parsed HEAD advance, endpoint discovered-but-not-queryable, same-name repositories, branch leakage, incomplete context/flow, node/file granularity collapse, missing affected endpoint/test relationships, empty semantic status, invalid cursor, invalid mutation root, CLI/MCP mismatch, missing timeout remediation and oversized unbounded results.
- [ ] Add gold questions for TypeScript/NestJS DI, Rust trait dispatch, gRPC and REST endpoints, configuration/Vault-to-runtime construction, exact symbol lookup, natural-language intent and cross-service architecture.
- [ ] Add fixed latency budgets and cold/warm labels to every query case.
- [ ] Add a test that rejects a gate when the response has a positive result without a stable identity or source evidence.
- [ ] Run `rtk node --test tests/knowledge-product-capability-closure.test.mjs`; confirm each new failure is reported by its own gate rather than being hidden inside a generic timeout.

### Task S0.2: Freeze the evaluator contract

**Files:**
- Modify: `docs/quality/index-evaluation-brief-round27-frozen.md`
- Modify: `docs/quality/index-evaluation-brief.md`
- Modify: `tests/knowledge-round27-frozen-brief.test.mjs`

**Interface produced:** `index-evaluation-brief-round27-frozen.md` carries one rubric hash, fixed Q/B IDs, allowed MCP tools, evidence requirements, category weights, R1/R2/R3 gates and the stop rule.

- [ ] Preserve the existing question coverage and add the R1/R2/R3 distinction.
- [ ] Require fresh sessions to rediscover IDs, repositories, branches, cursors, coverage and semantic status; previous reports are not evidence.
- [ ] Require the evaluator to score each category independently and record unsupported or unavailable capabilities instead of awarding assumed points.
- [ ] Verify the brief hash and question count from a test before any external evaluation.

**S0 gate:** The oracle can reproduce all prior failures and the frozen brief cannot silently change its weights or required questions.

---

## Stage S1 — Runtime, schema, repository and branch truth

### Task S1.1: Create one canonical runtime/index compatibility envelope

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/status-panel.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-schema-v18.test.mjs`
- Test: `tests/knowledge-installed-freshness.test.mjs`

**Interface produced:** Every public response exposes:

```json
{
  "runtime": { "buildId": "...", "schemaVersion": 18, "capabilityHash": "..." },
  "index": { "schemaVersion": 18, "repoId": "...", "branch": "...", "snapshotId": "...", "indexedCommit": "...", "headCommit": "..." },
  "compatibility": { "status": "aligned|schema_outdated|runtime_mismatch|revision_stale", "remediation": "..." }
}
```

- [ ] Add failing tests for stored schema 15/16/17 under a schema-18 runtime and for a bundle whose CLI and MCP hashes differ.
- [ ] Route status, search, context, flow, endpoints, affected, CLI and MCP through the same compatibility function.
- [ ] Return typed `SCHEMA_OUTDATED` with the exact owner-local command when migration is required; do not show a green “fresh” state.
- [ ] Ensure a zero-parsed index still advances its branch/snapshot commit when the source content is unchanged.
- [ ] Verify `indexedCommit === headCommit` is not by itself sufficient for “fresh” when dirty files or an unvalidated runtime are present.

### Task S1.2: Make repository and revision identity unambiguous

**Files:**
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/canonical.ts`
- Modify: `packages/knowledge-indexer/src/revision-indexer.ts`
- Test: `tests/knowledge-target-resolution.test.mjs`
- Test: `tests/knowledge-repo-identity-continuity.test.mjs`
- Test: `tests/knowledge-multi-branch-unrebuilt.test.mjs`

**Interface produced:** A scope is keyed by `repoId + canonicalRoot + revisionId`; display name, branch name and basename are labels only.

- [ ] Return `AMBIGUOUS_REPOSITORY` for an unqualified duplicate display name and list the canonical root and repo ID choices.
- [ ] Make CLI preference `cwd repository → cwd branch → other branch → other repository`; keep explicit MCP scope authoritative.
- [ ] Test two repositories with the same name, two branches with the same symbol, symlink aliases, case differences, detached HEAD, branch switch and an unrebuilt branch based on `upstream/master`.
- [ ] Record whether a result comes from immutable indexed revision or a working-tree overlay.

### Task S1.3: Repair publication and reconciliation truth

**Files:**
- Modify: `packages/knowledge-indexer/src/revision-indexer.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-indexer/src/corpus-oracle.ts`
- Modify: `packages/knowledge-core/src/coverage-query.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/status-panel.ts`
- Test: `tests/knowledge-corpus-reconciliation.test.mjs`
- Test: `tests/knowledge-endpoint-publication-parity.test.mjs`

**Interface produced:** One reconciliation object is shared by UI, CLI and MCP:

```json
{
  "files": { "discovered": 0, "admitted": 0, "indexed": 0, "excluded": 0, "failed": 0 },
  "symbols": { "discovered": 0, "persisted": 0, "queryable": 0 },
  "endpoints": { "discovered": 0, "persisted": 0, "queryable": 0, "excluded": 0 },
  "unresolved": { "total": 0, "classified": 0, "actionableInternal": 0 },
  "delta": 0
}
```

- [ ] Make rebuild output and `knowledge_endpoints` read the same published projection.
- [ ] Fail publication if an endpoint is discovered but cannot be queried by its stable identity.
- [ ] Expose named, pageable exclusions rather than silently reducing totals.
- [ ] Verify architecture, graph, storage, coverage and endpoint totals reconcile to the same snapshot.

**S1 gate:** schema/runtime identity, repo/branch identity and publication totals are identical through Core, CLI and MCP.

---

## Stage S2 — Fast deterministic retrieval

### Task S2.1: Make search bounded and fast without semantic work

**Files:**
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/source-search.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-quality-benchmark.test.mjs`
- Test: `tests/knowledge-source-search.test.mjs`
- Test: `tests/knowledge-query-cache.test.mjs`
- Test: `tests/knowledge-mcp-working-tree-overlay.test.mjs`

**Interface produced:** Deterministic search returns lane and phase timings:

```json
{
  "searchedLanes": ["source", "symbol"],
  "skippedLanes": ["semantic"],
  "diagnostics": { "candidateCount": 0, "timingsMs": { "candidateSelection": 0, "hydration": 0, "evidence": 0, "total": 0 } }
}
```

- [ ] Profile `candidateSelection`, `count`, `hydration`, `evidence` and serialization independently on the largest real repo.
- [ ] Keep trigram search as an accelerator; use a query plan that filters by snapshot and query term before hydration and does not decode the whole corpus.
- [ ] Ensure explicit immutable repo/revision search does not build a working-tree overlay. Build the overlay only when `workingTree:true` is requested.
- [ ] Batch source/symbol hydration and evidence queries; never perform one SQLite query per occurrence.
- [ ] Keep exact hits ahead of fuzzy/semantic expansion and preserve deterministic ordering for equal scores.
- [ ] Add cold-process, warm-process, repeated-query and 100-concurrent-reader tests. Record at least 30 samples per query class before calculating p50/p95/p99; never copy one sample into all percentile fields.
- [ ] Meet scoped-search p95 <=500 ms through MCP on the final selected corpus; if cold startup is included, report it separately and keep the first scoped query <=5 s.

### Task S2.2: Push endpoint filters and pagination into SQLite

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-endpoint-filtering.test.mjs`
- Test: `tests/knowledge-endpoint-performance.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`

**Interface produced:** `knowledge_endpoints` accepts `repo`, `branch`/`commit_sha`, `protocol`, `service`, `method`, `path`, `provenance`, `handledOnly`, `limit` and a bound cursor. It selects `limit + 1` identities, then hydrates only that page.

- [ ] Use identity-first and revision-first indexes for endpoint membership and resolved-edge reads.
- [ ] Apply service/method/path/provenance/handled filters before hydration.
- [ ] Compute `candidateCount` from the same predicate independently of page size.
- [ ] Reconcile rebuild output, page totals and cursor exhaustion to the same endpoint identity set.
- [ ] Meet endpoint p95 <=700 ms and p99 <=2 s through MCP; any 20–30 second query is a failure even if transport remains alive.

### Task S2.3: Standardize cursor and error contracts

**Files:**
- Modify: `packages/knowledge-core/src/search-cursor.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-pagination-contract.test.mjs`
- Test: `tests/knowledge-query-runtime-e2e.test.mjs`

**Interface produced:** Every cursor binds operation, canonical scope, revision generation, filters, ordering and limit. Every error includes `code`, `message`, `retryable`, `details` and `remediation`.

- [ ] Test normal continuation, exhaustion, expired cursor, tampered cursor, wrong operation, wrong scope, changed filters, changed limit and publication mutation between pages.
- [ ] Make `truncated=true` always carry a continuation cursor or a named non-pageable omission explanation.
- [ ] Normalize nonexistent node targets to the same public error taxonomy through CLI and MCP; do not let one surface return `NODE_NOT_FOUND` while the other returns `INVALID_TARGET` for the same request.
- [ ] Keep transport timeout distinct from typed validation, scope and cursor errors.

**S2 gate:** deterministic search, endpoint filtering, cursor continuation and typed errors meet the latency and parity budgets without starting Nomic.

---

## Stage S3 — Complete graph, flow, affected and evidence

### Task S3.1: Finish directional graph traversal

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Test: `tests/knowledge-affected.test.mjs`
- Test: `tests/knowledge-context-truncation.test.mjs`

**Interface produced:** `context`, `flow`, `affected`, `callers`, `callees` and `impact` use targeted node/edge reads and return `edgeType`, `from`, `to`, `file`, `line`, `status`, `confidence` and evidence for each hop.

- [ ] Keep node-level affected queries at node granularity; do not silently convert a node to its entire file.
- [ ] Resolve exact identity with indexed equality first and use case-insensitive fallback only when necessary and unambiguous.
- [ ] Read edges for the requested frontier instead of scanning all snapshot edges into memory.
- [ ] Skip duplicate diagnostics/evidence work for internal subqueries, then build one public evidence envelope.
- [ ] Bound graph traversal by depth, node count and time budget; return honest lower bounds when expansion is incomplete.

### Task S3.2: Add framework and configuration relationships

**Files:**
- Modify: `packages/knowledge-indexer/src/framework-edges.ts`
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Test: `tests/knowledge-nestjs-affected.test.mjs`
- Test: `tests/knowledge-auth-version-flow.test.mjs`
- Test: `tests/knowledge-rust-trait-dispatch.test.mjs`

**Interface produced:** Gold flows must resolve these forms when evidence exists:

```text
gRPC/REST endpoint
  -> controller/handler
  -> injected service method
  -> repository/client/database call
  -> response/proto/DTO
```

and:

```text
Vault/config key
  -> config field
  -> runtime constructor
  -> selected implementation/feature branch
  -> endpoint or scheduled job
```

- [ ] Resolve NestJS `this.service.method()` to the injected service method when types and module wiring prove the link.
- [ ] Resolve Rust trait/interface dispatch with implementation alternatives clearly labeled instead of inventing one callee.
- [ ] Parse gRPC/REST endpoint declarations into the same endpoint identity used by endpoint listing.
- [ ] Preserve route/endpoint and test relationships in `affected` when source evidence exists.
- [ ] Add configuration/Vault field and runtime-construction fixtures; return “not proven” when dynamic loading prevents proof.

### Task S3.3: Evidence, coverage and unresolved-reference honesty

**Files:**
- Modify: `packages/knowledge-core/src/coverage-query.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-coverage-items.test.mjs`
- Create: `tests/knowledge-unresolved-classification.test.mjs`

**Interface produced:** Evidence distinguishes `source_fact`, `graph_edge`, `coverage_fact`, `runtime_observation` and `model_inference`; every item has source location or an explicit reason why it does not.

- [ ] Classify unresolved references as `external_dependency`, `language_builtin`, `dynamic_dispatch`, `generated_code`, `no_enclosing_symbol`, `ambiguous_internal` or `missing_internal`.
- [ ] Keep raw unresolved occurrences pageable and reconcile classified totals to raw totals.
- [ ] Add `affected` endpoint, route, test and suggested verification command fields derived only from evidence-backed nodes.
- [ ] Ensure negative responses say whether they are exact negatives or lower bounds limited by coverage.
- [ ] Verify a manually checked stratified sample has at least 98% unresolved-classification precision and no unclassified bucket.

**S3 gate:** R1 CodeGraph replacement passes exact/graph/affected/flow gold cases, evidence checks, branch scope checks and the deterministic latency matrix.

---

## Stage S4 — Real semantic/vector retrieval (deferred during the current pass)

This stage is mandatory for R2 but must not be started while the current instruction is “skip Nomic”. The worker must be durable and fire-and-forget; adding several Nomic processes is not the default optimization because memory pressure, SQLite contention and model duplication can make total throughput worse. Benchmark bounded concurrency on the actual Apple Silicon machine before selecting a worker count.

### Task S4.1: Make semantic state truthful before generating vectors

**Files:**
- Modify: `packages/knowledge-core/src/semantic-status.ts`
- Modify: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-contracts/src/semantic.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `src/components/wiki/SemanticWorkerPanel.tsx`
- Test: `tests/knowledge-semantic-status-contract.test.mjs`
- Test: `tests/knowledge-semantic-status-parity.test.mjs`

**Interface produced:** Every selected scope returns one of `not_queued`, `queued`, `running`, `paused`, `failed`, `ready` or `superseded`, plus `generationId`, `snapshotId`, `modelId`, `dimension`, `expected`, `ready`, `running`, `retryWait`, `retryableFailed`, `terminalFailed`, `heartbeat`, `rate`, `eta` and `remediation`.

- [ ] Replace valid-repo `statuses:[]` with an explicit `not_queued` state.
- [ ] Separate bootstrap readiness from full-corpus completion; `ready < expected` is `partial/lower_bound` and cannot be advertised as complete.
- [ ] Make semantic `off`, `fallback` and `blend` behavior explicit when no active generation exists.
- [ ] Keep aggregate and per-repo status fields identical through Core, CLI, MCP and Tauri.

### Task S4.2: Build and activate a verified sqlite-vec generation

**Files:**
- Modify: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Modify: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Modify: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-core/src/transformers-embedding-backend.ts`
- Test: `tests/knowledge-vector-crash-recovery.test.mjs`
- Test: `tests/knowledge-semantic-fire-and-forget-acceptance.test.mjs`
- Modify: `scripts/knowledge-semantic-performance-gate.mjs`

**Interface produced:** A generation is activated only when all vectors validate against `modelId`, `dimension`, `chunkerVersion`, `snapshotId`, stable chunk identity and sqlite-vec row integrity. Activation is atomic; a partial generation cannot replace a valid active generation.

- [ ] Preserve the current paused generation and diagnose retryable errors before any full reset.
- [ ] Reuse vectors by content hash, snapshot, model and chunker identity; changed chunks only create changed jobs.
- [ ] Benchmark batch sizes 64/128/256 and inference concurrency 1/2/4/6, measuring committed vectors, RSS, CPU, WAL and errors.
- [ ] Use bounded transactions and periodic checkpoints; test interruption during inference, commit and checkpoint.
- [ ] Isolate retry-wait scopes so one broken repository cannot starve healthy scopes.
- [ ] Keep the model bundled and local; no Ollama or network dependency is required for the product path.

### Task S4.3: Prove semantic quality and the 10-minute bootstrap

**Files:**
- Create: `tests/knowledge-semantic-gold-set.test.mjs`
- Modify: `tests/knowledge-semantic-worker-performance.test.mjs`
- Modify: `tests/knowledge-soak-resource-budgets.test.mjs`
- Modify: `scripts/knowledge-semantic-performance-clone.mjs`

- [ ] Require first usable bootstrap retrieval for one selected repository within 10 minutes on target hardware.
- [ ] Measure full-corpus completion separately; never pretend a 711,155-vector corpus has a 10-minute guarantee without measured throughput.
- [ ] Require semantic recall@10 >=90%, hybrid recall@10 >=95%, and exact deterministic hits not displaced outside top 10.
- [ ] Require no-active-generation semantic overhead <=100 ms and <=10% compared with semantic-off.
- [ ] Test pause, resume, retry, crash recovery, model mismatch, stale snapshot and clean activation.

**S4 gate:** R2 semantic capability is real, queryable and evidence-labeled. Packaging a Nomic model without an active verified generation does not pass this gate.

---

## Stage S5 — Wiki, notes, onboarding and Tauri controls

### Task S5.1: Make Wiki pages source-backed and agent-usable

**Files:**
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `packages/knowledge-core/src/canonical.ts`
- Modify: `packages/knowledge-indexer/src/notes.ts`
- Modify: `packages/knowledge-indexer/src/notes-fs.ts`
- Modify: `packages/knowledge-indexer/src/markdown-links.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `src/components/wiki/WikiPage.tsx`
- Modify: `src/components/wiki/WikiNoteEditor.tsx`
- Test: `tests/knowledge-docs-generation.test.mjs`
- Test: `tests/knowledge-typed-notes.test.mjs`
- Test: `tests/knowledge-notes-atomic.test.mjs`
- Test: `tests/knowledge-notes-prune.test.mjs`
- Test: `tests/knowledge-onboarding-canonical.test.mjs`

**Interface produced:** A Wiki page stores `pageId`, `repoId`, `revision`, `sourceRefs`, `generatedAt`, `freshness`, `facts`, `inferences`, `openQuestions`, `backlinks` and `tags`. Facts and inferences render differently and can be queried separately.

- [ ] Generate architecture/domain pages from the canonical graph and semantic lanes, not from an independent stale database.
- [ ] Show source branch, commit, snapshot, last index, coverage, unresolved limits and page freshness.
- [ ] Add Markdown-compatible import/export, user notes, tags and backlinks without overwriting source facts.
- [ ] Ensure a generated summary cannot cite a file/line absent from the current snapshot.
- [ ] Generate MCP onboarding from the live capability manifest; remove stale or uncallable tool names.

### Task S5.2: Expose durable index/semantic job controls in Tauri

**Files:**
- Modify: `src/components/wiki/SemanticWorkerPanel.tsx`
- Modify: `src/components/wiki/IndexProgressBanner.tsx`
- Modify: `src/components/wiki/CorpusJobPanel.tsx`
- Modify: `src/components/wiki/WikiGraph.tsx`
- Modify: `src-tauri/src/runtime/commands.rs`
- Modify: `src-tauri/src/runtime/controller.rs`
- Modify: `src-tauri/src/runtime/knowledge_runtime.rs`
- Test: `tests/knowledge-tauri-semantic-control.test.mjs`
- Test: `tests/knowledge-index-progress.test.mjs`
- Test: `tests/knowledge-runtime-manager.test.mjs`
- Test: `tests/knowledge-status-panel.test.mjs`

**Interface produced:** The UI displays `jobId`, repo/branch, phase, progress, processed/expected, rate, ETA, last heartbeat, model, build, errors and controls `Pause`, `Resume`, `Retry`, `Cancel`.

- [ ] Make index/rebuild and semantic jobs continue after the window closes and resume from durable checkpoints.
- [ ] Make pause stop new work and finish/rollback the active bounded transaction; resume continues the same generation.
- [ ] Make cancel explicit and recoverable; preserve the last valid active generation.
- [ ] Remove the unused Focus surface from the Wiki flow only after confirming no query or navigation depends on it.
- [ ] Keep Storage and Graph useful while semantic generation is paused or unavailable.

### Task S5.3: Automate MCP client synchronization safely

**Files:**
- Modify: `src-tauri/src/mcp.rs`
- Modify: `src-tauri/src/runtime/commands.rs`
- Modify: `src-tauri/src/runtime/controller.rs`
- Modify: `scripts/knowledge-mcp-launcher.mjs`
- Test: `tests/knowledge-launcher.test.mjs`
- Test: `tests/knowledge-runtime-doctor.test.mjs`
- Test: `tests/knowledge-install-upgrade-test.mjs`

- [ ] On first launch, update, re-update and reinstall, detect the versioned runtime and atomically refresh `~/.penguin/bin/penguin-mcp`.
- [ ] Configure only detected Claude Desktop, Claude Code and Codex clients; preserve unrelated settings and avoid duplicate Penguin entries.
- [ ] Run local health checks before writing configs; leave the previous config unchanged if health fails.
- [ ] Report “restart the already-open client once” because stdio clients load MCP configuration at process start; do not claim automatic mutation of an existing session.
- [ ] Keep Settings “Reconfigure MCP Clients” as an idempotent recovery button, not a required normal-install step.

**S5 gate:** a new local user can open the installed app, see truthful index/semantic state, pause/resume a job, and use the configured MCP launcher without manual path repair.

---

## Stage S6 — Final installed-artifact and heavy-use validation

### Task S6.1: Add four-surface parity tests

**Files:**
- Modify: `scripts/knowledge-mcp-parity-test.mjs`
- Modify: `tests/knowledge-surface-parity-e2e.test.mjs`
- Modify: `tests/knowledge-parity-gates.test.mjs`

- [ ] Send fixed requests through Core, query server, CLI and MCP.
- [ ] Normalize only transport fields; compare scope, revision, IDs, totals, cursor behavior, evidence, semantic status and error taxonomy exactly.
- [ ] Test parallel MCP clients, restart during query, index publication during pagination and stale runtime detection.
- [ ] Include semantic-off parity during the current Nomic-skipped pass; add semantic-on parity after S4.

### Task S6.2: Run the real branch and stress matrix

**Files:**
- Modify: `scripts/knowledge-real-branch-matrix.mjs`
- Modify: `scripts/knowledge-real-repo-benchmark.mjs`
- Modify: `scripts/knowledge-stress.mjs`
- Modify: `scripts/knowledge-load-report.mjs`
- Test: `tests/knowledge-multi-branch-unrebuilt.test.mjs`
- Test: `tests/knowledge-real-branch-matrix-runner.test.mjs`
- Test: `tests/knowledge-load-burst.test.mjs`
- Test: `tests/knowledge-soak-resource-budgets.test.mjs`

- [ ] Test every selected repository under `/Users/shieng/Desktop/Projects` with at least two branches where available.
- [ ] Create a branch from `upstream/master`, query it before rebuild, then rebuild it and verify old/new snapshot separation.
- [ ] Cover clean/dirty/untracked/deleted/renamed files, Unicode paths, symlinks, detached HEAD, generated files, large files and zero-change HEAD advance.
- [ ] Run 100 concurrent readers, concurrent index/query, cursor-publication races, pause/resume, crash recovery and an 8-hour mixed MCP soak.
- [ ] Fail on SQLite lock leakage, scope leakage, fabricated evidence, corruption, unbounded memory growth or any missed p95/p99 target.

### Task S6.3: Execute one guarded full reset/index/rebuild sequence

**Files:**
- Modify: `packages/knowledge-core/src/index-reset.ts`
- Modify: `packages/knowledge-core/src/reset-manifest.ts`
- Modify: `scripts/knowledge-release-gate.mjs`
- Modify: `scripts/knowledge-corpus-reconcile.mjs`
- Test: `tests/knowledge-full-reset-cli.test.mjs`
- Test: `tests/knowledge-full-reset-manifest.test.mjs`
- Test: `tests/knowledge-full-reset-policy.test.mjs`
- Test: `tests/knowledge-full-reset-recovery.test.mjs`
- Test: `tests/knowledge-installed-full-corpus.test.mjs`

- [ ] Record runtime hashes, current database digest, selected canonical roots and a recoverable backup manifest.
- [ ] Quit Penguin and old MCP processes holding the previous runtime.
- [ ] Build the Tauri DMG and verify the bundled CLI, MCP, schema, capability and model hashes.
- [ ] Install the DMG, launch it once and verify the active launcher points to the installed versioned runtime.
- [ ] Run the guarded full reset for the selected Penguin database, derived caches and semantic generations only after the read-only preflight returns exact canonical targets.
- [ ] Cold-index all selected repositories/branches under the final schema, then rebuild graph, endpoint, coverage and search projections.
- [ ] Run reconciliation and require delta zero with named/pageable exclusions.
- [ ] Keep semantic generation disabled for the current deterministic pass. If S4 is enabled in a later milestone, enqueue it and return control immediately; wait only for the bootstrap readiness gate before semantic testing.
- [ ] Run the installed-artifact oracle twice without database mutation.

**S6 gate:** the DMG, stable launcher, CLI, MCP, Tauri and real corpus all describe the same build, schema, capability hash, revision and evidence model.

---

## Stage S7 — Final external evaluation and stop rule

### Task S7.1: Run exactly two fresh sessions

**Files:**
- Read: `docs/quality/index-evaluation-brief-round27-frozen.md`
- Create: `docs/quality/index-evaluation-claude-opus-5-unified-replacement.md`
- Create: `docs/quality/index-evaluation-codex-unified-replacement.md`

- [ ] Start one new Claude Code OS process and one new Codex OS process.
- [ ] Give both only the frozen brief; they use Penguin MCP only and rediscover all live IDs, scopes, cursors, coverage and semantic state.
- [ ] Do not let either evaluator read source code, Git, SQLite, CLI output, old reports or the other evaluation report.
- [ ] Require Q/B results, category scores, hard-gate rows, latency evidence, limitations and exact MCP errors.
- [ ] Compute `officialProductScore = min(claudeScore, codexScore)`.

### Final decision

- `GO`: both fresh scores are at least 95, all hard gates pass, semantic/vector status is real if R2 is claimed, and no evidence/completeness/scope/runtime failure remains. Stop this rubric and move to frontend presentation polish.
- `NO-GO`: map every failed observation to an existing S0-S6 gate, reproduce it locally, fix it in one batch and rerun the installed oracle before the one allowed final retest pair.
- If the second pair still fails, stop creating new rounds. Hold an architecture review against the failed root-cause cluster; do not keep making the user repeat the same evaluation.

## 3. Execution order for the current request

The current request is “skip Nomic and continue the rest”, so execute in this order:

1. S0 oracle and frozen contract.
2. S1 runtime/index/repository truth.
3. S2 deterministic search, endpoint filters, pagination and typed errors.
4. S3 graph, flow, affected and evidence.
5. S5 Tauri status/controls, Wiki evidence and automatic MCP synchronization.
6. S6 parity, branch matrix, stress and installed DMG gate.
7. Stop and report the deterministic result. Do not claim R2/full replacement yet.
8. Only when the user re-enables Nomic, execute S4, then rerun S6 and S7.

This order allows an internal deterministic/R1 smoke check once S6 is green, while preventing a partial Nomic package from being mistaken for working vector search. It does **not** allow the official S7 external score until S4 is enabled and its semantic gates pass.

## 4. Effort and acceptance estimate

These are engineering estimates, not capability scores:

| Workstream | Expected focused effort |
| --- | ---: |
| S0 oracle and frozen rubric | 0.5–1 day |
| S1 runtime/index/revision truth | 1–2 days |
| S2 deterministic query performance | 1–3 days |
| S3 graph/flow/evidence completeness | 2–3 days |
| S4 semantic/vector lifecycle and quality | 2–4 days after Nomic is re-enabled |
| S5 Wiki/Tauri/MCP lifecycle | 1–2 days |
| S6 reset/reindex/rebuild/stress/DMG | 1–2 days plus the measured soak |
| S7 fresh evaluations | one bounded final retest window |

The 10-minute promise applies only to the first usable semantic bootstrap for a selected repository after S4 is enabled. Full-corpus vector completion remains a backend fire-and-forget job until measured on the target machine. Deterministic lookup should be millisecond-scale when scoped and indexed; full-corpus natural-language search is not promised to be millisecond-scale unless the benchmark proves it.

## 5. Plan self-review

- CodeGraph replacement: covered by S1, S2, S3, S6 and R1 gate.
- UnderstandAnything replacement: covered by S3, S4 and source-backed Wiki in S5.
- Graphify replacement: covered by cross-service graph, architecture pages, config/runtime flow and evidence in S3/S5.
- Obsidian code-knowledge replacement: covered by Markdown notes, tags, backlinks, citations and Tauri Wiki in S5; general plugin/canvas parity is explicitly outside the code-agent claim.
- Nomic/vector: included as mandatory S4 for full R2/R3, but execution is explicitly deferred now.
- Accuracy/evidence/completeness: covered by S0, S1.3, S3.3 and S6.
- MCP/CLI/runtime installation: covered by S1, S5.3 and S6.1/S6.3.
- Branches before and after rebuild: covered by S1.2 and S6.2.
- Pressure, latency, locks and long-running use: covered by S2, S4.3 and S6.2.
- Finite external testing: exactly two fresh sessions after the internal oracle, with no endless round loop.
