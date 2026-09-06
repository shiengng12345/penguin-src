# Penguin Product Capability 95-100 Final Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use test-first changes, preserve the existing dirty worktree, and do not commit, reset, stage, or discard unrelated user changes.

**Goal:** Make Penguin itself—not its installation progress, implementation progress, test count, or reliability workload—score 95-100/100 in both an entirely fresh Claude Code MCP-only evaluation and an entirely fresh Codex MCP-only evaluation, with every frozen hard gate passing.

**Architecture:** Close the remaining gaps as six root-cause systems: runtime/index truth, bounded query execution, semantic lifecycle, scope/safety validation, graph/publication completeness, and one executable acceptance oracle. All public surfaces must consume the same canonical repository/revision, endpoint, evidence, pagination, and semantic state. External evaluators are used only after the installed-artifact oracle is fully green.

**Tech Stack:** TypeScript, Node.js, pnpm workspaces, better-sqlite3, SQLite/sqlite-vec, ONNX/Nomic embeddings, MCP stdio, Tauri 2/Rust, Node test runner.

---

## 1. Non-negotiable completion contract

### 1.1 The only product score

Until the final two evaluations complete, the official product capability score remains the lower fresh-session Round 26 result: **69/100**.

After the final evaluation:

```text
officialProductCapabilityScore = min(claudeFreshScore, codexFreshScore)
```

Penguin is complete only when:

- `claudeFreshScore >= 95`;
- `codexFreshScore >= 95`;
- both reports execute Q1-Q20 and B1-B8;
- both reports record zero hard-gate failures;
- both sessions are new OS processes, MCP-only after reading the instruction, and use the same installed artifact and frozen brief.

Do not publish a separate percentage for coding, installation, indexing, test completion, or reliability. During implementation, report only a task/gate table such as `18/31 gates passing`. Those numbers are not a product score.

### 1.2 Frozen score floor

Use the existing Round 26 category weights without changing them after implementation starts:

| Category | Weight | Required category score |
| --- | ---: | ---: |
| Runtime identity, schema, installation truth | 10% | >=95 |
| Discovery, capability contract, first-user usability | 14% | >=95 |
| Exact/lexical/graph/context/flow usefulness | 20% | >=94 |
| Semantic/vector readiness and hybrid honesty | 16% | >=95 |
| Stable identity, pagination, affected parity | 20% | >=98 |
| Reconciliation, coverage, freshness, negative proof | 15% | >=95 |
| Compactness and Agent handoff | 5% | >=90 |

This floor produces at least 95.15/100 before any bonus. No category may borrow points to hide a hard-gate failure.

### 1.3 Frozen hard gates

All of the following are release-blocking:

1. Runtime, CLI, MCP, index, capability and model identities are mutually consistent. `indexedSchemaVersion` must equal the running `schemaVersion` for every active branch. Any skew returns a typed `SCHEMA_OUTDATED` response with owner-local remediation; it cannot appear as an unexplained field difference.
2. Zero silent positive or negative scope errors across repo, branch, snapshot, path, kind, symbol, endpoint, protocol, service, method, provenance and handled-only filters.
3. Zero cross-repo or cross-branch leakage in the adversarial scope matrix.
4. Every advertised cursor is continuable to exhaustion. Across every page: zero duplicate identities, zero skipped identities, stable `candidateCount`, and `truncated=true` always has a non-null continuation or a typed explanation that the capability is non-pageable.
5. Every positive source or graph claim has repo, branch, commit, snapshot, stable identity, file and line; graph hops additionally have method, status and confidence. Fabricated hops allowed: zero.
6. Endpoint discovery, persistence and query totals reconcile exactly after explicit, pageable exclusions. A discovered endpoint cannot disappear between rebuild output and `knowledge_endpoints`.
7. File totals across architecture, graph, revision view and coverage reconcile exactly or expose a named, pageable exclusion equation with delta zero.
8. Semantic status is never an unexplained empty array. Every selected repo reports one of `not_queued`, `queued`, `running`, `paused`, `failed`, `ready` or `superseded`, including model identity, snapshot, expected/ready/failed counts and remediation.
9. With no active semantic generation, semantic `blend` and `fallback` short-circuit before provider/worker work. Added overhead versus `semantic=off` must be <=100 ms and <=10%; deterministic results must be identical.
10. With an active generation, semantic and hybrid retrieval must expose lane decomposition and model/generation identity. Gold-set semantic recall@10 must be >=90%, hybrid recall@10 >=95%, and no deterministic exact hit may be displaced outside top 10.
10a. On a clean install with no previous semantic generation, every eligible repository must expose a verified bootstrap vector lane within 10 minutes for the supported bootstrap corpus. The response must label `ready<expected` as `partial/lower_bound`; this is a user-readiness SLA, not permission to claim full-corpus completion. The durable worker must continue the same generation until `ready==expected` and only then become complete.
10b. The bootstrap SLA and full-corpus completion SLA are separate. The 10-minute target applies to a first usable lane for one selected repository or a bounded incremental delta; it is not a promise that the current 711,155-vector, 23-scope corpus will finish in 10 minutes. The full corpus remains fire-and-forget until measured on the target hardware. If the product requires all 23 scopes in 10 minutes, the gate must first prove at least 1,185 committed embeddings/second end-to-end; CPU Nomic cannot be assumed to meet that target.
10c. A semantic generation is not release-ready while retryable work is unexplained or permanently starving healthy scopes. Status must expose runnable pending, retry-wait, retryable-failed and terminal-failed counts separately; neither expected counts nor failure counts may be reduced to improve the percentage.
11. Mutation preflight rejects relative, empty, nonexistent, symlink-escaping, non-repository and non-owner-approved roots. It must never emit `confirmed:true` for an invalid root.
12. `affected` preserves requested symbol/node granularity, returns evidence-backed impact edges, related endpoints/routes/tests and suggested verification commands. Empty relationships remain honest lower bounds.
13. Public onboarding contains only callable MCP wire names from the live capability manifest. Every timeout/error includes typed remediation usable by an MCP-only first user.
14. Same fixed requests through core, query server, CLI and MCP produce equivalent normalized payloads, scope, totals, identities and error taxonomy.
15. No bounded call exceeds 30 seconds. On the final 21-repo installed corpus, latency is measured end-to-end through MCP as well as inside Core/SQLite. The release gates are:

    | Query class | Core/SQLite p95 | MCP end-to-end p95 | MCP end-to-end p99 |
    | --- | ---: | ---: | ---: |
    | Exact symbol/node lookup | <=50 ms | <=200 ms | <=500 ms |
    | Scoped search/context | <=150 ms | <=500 ms | <=1 s |
    | Scoped endpoint/filter query | <=200 ms | <=700 ms | <=2 s |
    | Endpoint cursor continuation | <=100 ms | <=400 ms | <=1 s |
    | Affected and ordinary bounded flow | <=300 ms | <=1 s | <=2 s |
    | Cross-repo graph/architecture | <=1 s | <=2 s | <=5 s |
    | Active semantic/hybrid retrieval | <=1 s | <=2 s | <=5 s |

    Cold start is reported separately and cannot be mixed into warm-query percentiles. Repeated-query caching may improve these values but the first scoped query after process initialization must still complete within 5 seconds. A 20-30 second query is always a release failure, even when it technically remains below the transport timeout.
16. The full installed-artifact capability oracle passes twice consecutively with no database mutation between runs.

### 1.4 Automatic MCP client synchronization (installation contract)

This is part of the product capability contract, not a manual release checklist:

| Lifecycle event | Penguin action | User action |
| --- | --- | --- |
| First install | On first app startup, sync the bundled versioned runtime, install/refresh the stable launcher, and configure only detected local Claude Desktop, Claude Code, and Codex clients | None; restart an already-open client once |
| App update | On every startup, detect the active runtime build, atomically activate the new generation, refresh the stable launcher, and rewrite only Penguin's entry in detected client configs | None; restart an already-open client once |
| Re-update / launch without version change | Re-run the same idempotent preflight; correct files are reported unchanged and are not rewritten | None |
| Reinstall | Treat it like a fresh startup against the preserved per-user runtime/config; repair missing or stale Penguin entries without duplicating servers or overwriting unrelated MCP entries | None; restart an already-open client once |

Safety rules:

- The stable launcher path remains `~/.penguin/bin/penguin-mcp`; client configs never point into the mounted `.app` or DMG.
- JSON/TOML merges preserve unrelated settings and use atomic replacement. Concurrent startup, release-welcome, Settings and onboarding requests are serialized.
- A client config is created only when that client is detected locally; unsupported or absent clients are explicitly skipped.
- Automatic sync does not kill or mutate an external Claude/Codex session. It reports that a restart is required because stdio MCP clients load configuration at process start.
- The Settings button remains a recovery/force-refresh path. It is not required for normal install, update, re-update or reinstall.
- Runtime health must pass before client entries are changed. A failed health gate leaves the prior config intact and reports an actionable retry path.

---

## 2. Why previous rounds kept finding new failures

Claude Code and DeepSeek independently agreed on the following root causes:

- Component tests proved contracts in fixtures, but no installed-artifact test drove build -> index -> semantic activation -> MCP queries as one system.
- Indexer, revision view, query server and MCP each reconstructed scope/count/status differently, so individually correct fields disagreed at the product boundary.
- Endpoint filtering hydrated a broad inventory before applying some filters, turning a pagination feature into a corpus-sized scan.
- Packaging proved sqlite-vec/model files existed, but did not prove a generation was created, completed, activated and queried.
- Tests emphasized positive happy paths; filter combinations, invalid paths, stale cursors, same-name roots and empty semantic states were not used as release blockers.
- External AI evaluation was started before local reproduction of all prior failures was green, making the user the regression runner.

This plan fixes those defect classes and introduces one finite acceptance boundary. It is not another symptom-only Round plan.

---

## 3. Phase A — Build one executable product-capability oracle

### Task A1: Freeze the Round 26 reproductions before changing implementation

**Files:**
- Create: `tests/knowledge-product-capability-closure.test.mjs`
- Create: `tests/fixtures/knowledge-product-capability/questions.json`
- Create: `tests/fixtures/knowledge-product-capability/expected-gates.json`
- Create: `scripts/knowledge-product-capability-gate.mjs`
- Modify: `package.json`

**Steps:**

1. Add failing tests for every Round 26 defect: schema skew, endpoint filter timeout shape, endpoint cursor continuation, semantic empty state, no-active semantic overhead, `scope.kinds` false negative, ignored explain repo scope, invalid mutation root, affected symbol collapse, empty impact edges, missing endpoint locator, flow truncation without cursor, page-dependent count, repeated context payload, invalid onboarding names, missing timeout remediation, file/endpoint reconciliation, same-name roots and unresolved-reference classification.
2. Add deterministic gold questions covering TypeScript/NestJS, Rust trait/dispatch, gRPC, REST, config/Vault/runtime construction, exact occurrences, natural-language intent and cross-service flows.
3. Make the gate emit machine-readable JSON with one row per frozen gate, latency percentiles and exact failure evidence. It must exit non-zero on one failed gate.
4. Add scripts:

```json
{
  "knowledge:capability:gate": "node scripts/knowledge-product-capability-gate.mjs",
  "knowledge:capability:closure": "pnpm test && pnpm knowledge:capability:gate"
}
```

5. Run `rtk pnpm test -- knowledge-product-capability-closure` and confirm the new cases fail for the expected reasons before implementation.

### Task A2: Prevent rubric drift

**Files:**
- Modify: `docs/quality/index-evaluation-brief.md`
- Create: `docs/quality/index-evaluation-brief-round27-frozen.md`
- Test: `tests/knowledge-round26-brief.test.mjs`
- Create: `tests/knowledge-round27-frozen-brief.test.mjs`

**Steps:**

1. Preserve Q1-Q20 and B1-B8, add the newly reproduced edge cases without changing category weights.
2. Add an embedded rubric hash and require both evaluators to record it.
3. State that the report must use MCP only, must not read previous reports, and must score every required scenario.
4. Add a test that fails when the frozen hard-gate text, weights, question IDs or expected report fields change.

---

## 4. Phase B — Unify runtime, index and repository truth

### Task B1: Make schema skew a first-class product state

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/status-panel.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Test: `tests/knowledge-schema-v18.test.mjs`
- Test: `tests/knowledge-installed-freshness.test.mjs`
- Test: `tests/knowledge-surface-parity-e2e.test.mjs`

**Steps:**

1. Add failing tests showing schema 17 data under runtime schema 18 cannot be reported as aligned/fresh.
2. Centralize a `runtimeIndexCompatibility` result consumed by status, search, context, flow, endpoints, CLI, MCP and Tauri.
3. Return typed state and exact owner remediation while keeping read-only queries honest.
4. Do not bump to schema 19 merely to hide the skew. Bump only if this plan introduces a persistent table/index contract that schema 18 cannot migrate safely; if bumped, every gate and final reset uses that one new version.
5. Verify `0 parsed` HEAD advance still updates snapshot/commit truth without falsely changing parsed content.

### Task B2: Canonical repository identity and same-name ambiguity

**Files:**
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/canonical.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-repo-identity-continuity.test.mjs`
- Test: `tests/knowledge-target-resolution.test.mjs`
- Test: `tests/knowledge-mcp-scope-regressions.test.mjs`

**Steps:**

1. Treat repo ID plus canonical root as identity; display name is never a unique key.
2. If two roots share `FPMS-NT-Auth-Player`, an unqualified selector returns `AMBIGUOUS_REPOSITORY` with both repo IDs and roots.
3. Ensure cwd-aware CLI preference does not alter MCP explicit-scope semantics.
4. Test symlink aliases, case differences, moved roots, deleted roots, duplicate registrations and multiple branches from one checkout.

---

## 5. Phase C — Bound query execution and make pagination truthful

### Task C1: Push endpoint filters and keyset pagination into SQLite

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify if a persistent projection/index is needed: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-endpoint-filtering.test.mjs`
- Test: `tests/knowledge-endpoint-publication-parity.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`
- Create: `tests/knowledge-endpoint-performance.test.mjs`

**Steps:**

1. Add a realistic large-corpus fixture that reproduces handled/provenance/cursor timeouts.
2. Replace hydrate-all-then-filter paths with SQL predicates over canonical endpoint memberships/occurrences.
3. Select only `limit + 1` endpoint IDs first, then hydrate those IDs in bounded batches.
4. Compute exact totals with the same filter predicate; `candidateCount` must not depend on page limit.
5. Add query-plan assertions for repo/revision/protocol/service/method/path/provenance/handled filters and required indexes.
6. Exhaust every filter combination page-by-page and compare the identity set with one canonical unpaged oracle.
7. Meet the endpoint p95/p99 budgets in Section 1.3 on the real largest repo before external testing.

### Task C2: One cursor contract for every pageable capability

**Files:**
- Modify: `packages/knowledge-core/src/search-cursor.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-pagination-contract.test.mjs`
- Test: `tests/knowledge-context-truncation.test.mjs`
- Test: `packages/knowledge-core/src/__tests__/round13-contracts.test.ts`

**Steps:**

1. Bind operation, canonical scope, revision generation, filters, ordering and limit in every cursor.
2. Make `flow` either genuinely pageable or explicitly non-pageable with `truncated=false` plus named omitted relations; never return `truncated=true,cursor=null`.
3. Return focus source only on page one of context; continuation pages carry a stable focus reference/hash.
4. Add mutation-between-pages, branch-change, rebuild-publication, expired, tampered, wrong-family, changed-filter and changed-limit tests.

### Task C3: Make all timeouts actionable and measurable

**Files:**
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Test: `tests/knowledge-query-runtime-e2e.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`

**Steps:**

1. A `QUERY_TIMEOUT` must name capability, elapsed budget, applied scope and safe next action.
2. Preserve typed cursor/scope errors instead of converting them to generic `CURSOR_INVALID` or timeout.
3. Add phase timings for scope resolution, count, candidate selection, hydration, evidence and serialization.

---

## 6. Phase D — Make semantic/vector retrieval real and non-blocking

### Task D1: Closed semantic lifecycle, including zero state

**Files:**
- Modify: `packages/knowledge-core/src/semantic-status.ts`
- Modify: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-contracts/src/semantic.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Test: `tests/knowledge-semantic-status-contract.test.mjs`
- Test: `tests/knowledge-semantic-status-parity.test.mjs`
- Test: `tests/mcp-semantic-cold-start.test.mjs`

**Steps:**

1. Replace `statuses:[]` for a valid repo with a canonical `not_queued` projection.
2. Expose scope, snapshot, generation, provider/model/tokenizer/dimension/pooling/normalization/chunker identity, expected/ready/running/failed counts, lease/heartbeat/rate/ETA and remediation.
3. Keep aggregate and repo-scoped status schema identical across CLI, MCP and Tauri.
4. Test never-started, queued, running, paused, resumed, failed, retryable, ready, superseded, stale-model and stale-snapshot states.

### Task D2: No-active semantic lane must be constant-time

**Files:**
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/hybrid-search.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Test: `tests/knowledge-semantic-performance-gate.test.mjs`
- Test: `tests/knowledge-hybrid-search.test.mjs`
- Test: `tests/knowledge-search-engine.test.mjs`

**Steps:**

1. Resolve active generation metadata before provider initialization or vector work.
2. If no active generation exists, execute the exact deterministic plan used by `semantic=off` and append only the typed semantic diagnostic.
3. Assert byte-equivalent deterministic hits, ordering, counts and cursors across off/blend/fallback when semantic is unavailable.
4. Enforce <=100 ms and <=10% overhead using a real query-server process, not only an in-memory mock.

### Task D3: Complete, activate and query real embeddings

**Files:**
- Modify: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Modify: `packages/knowledge-indexer/src/embedding-worker.ts`
- Modify: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Modify: `src/components/wiki/SemanticWorkerPanel.tsx`
- Test: `tests/knowledge-vector-runtime-e2e.test.mjs`
- Test: `tests/knowledge-semantic-fire-and-forget-acceptance.test.mjs`
- Test: `tests/knowledge-vector-cli-mcp-parity.test.mjs`
- Test: `tests/knowledge-semantic-worker-performance.test.mjs`

**Steps:**

1. Use the Nomic embedding model, tokenizer and ONNX runtime bundled with Penguin. A normal user must not install Ollama, download another model, configure a provider or know how embeddings work.
2. Index/rebuild enqueues all eligible snapshot chunks and returns immediately; graph and lexical search become available without waiting. On a clean install, the durable worker publishes a bounded bootstrap vector lane after a verified minimum ready set (default 512 chunks per repository), then continues the same generation after the Penguin window closes.
3. Pause, resume, retry and cancel remain durable and visible in Tauri. The UI exposes processed/expected chunks, percentage, rate, ETA, active model/generation and failure remediation.
4. A complete replacement generation is activated atomically only when all required chunks are ready and model/snapshot identity matches. A clean install may publish one active bootstrap generation with pending jobs only after vector/reference integrity checks pass; it is explicitly partial, never replaces an older active generation, and continues claiming pending jobs until full activation state is reached.
5. Query sqlite-vec with repository/revision ACL before ranking; stale/superseded generations are impossible to search.
6. Make `semantic=blend` and `semantic=fallback` use the active generation automatically. MCP-only users do not run a separate model command; when generation is not ready, deterministic search remains immediately available with an honest status.
7. Run the frozen semantic gold set and meet recall and latency gates. Semantic ranking quality is required for 95; personalization and tuning beyond the frozen gold set are optional.

### Task D4: Remove the throughput limiter and isolate retry work

**Added after the live 2026-09-03 performance review by Codex, Claude Code and DeepSeek.** This task is mandatory before any claim that vector indexing is production-ready.

**Files:**
- Modify: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Modify: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-core/src/semantic-status.ts`
- Modify: `packages/knowledge-core/src/transformers-embedding-backend.ts`
- Modify: `packages/knowledge-core/src/vector-store.ts`
- Modify: `src/components/wiki/SemanticWorkerPanel.tsx`
- Test: `tests/knowledge-semantic-worker-performance.test.mjs`
- Test: `tests/knowledge-semantic-supervisor.test.mjs`
- Test: `tests/knowledge-semantic-status-contract.test.mjs`
- Test: `tests/knowledge-semantic-fire-and-forget-acceptance.test.mjs`
- Test: `tests/knowledge-vector-crash-recovery.test.mjs`
- Test: `tests/knowledge-soak-resource-budgets.test.mjs`
- Create or extend: `scripts/knowledge-semantic-benchmark.mjs`

**Steps:**

1. Freeze a read-only baseline before changing the live data: record generation IDs, scope keys, expected/ready/pending/running/retryable/terminal counts, model identity, database digest, WAL size, RSS, CPU and per-batch timings. Keep the current generation resumable; do not delete it or restart it merely to make a metric look better.
2. Diagnose the `190,459` retryable jobs with a grouped error/attempt/next-attempt report and at least three samples spanning the backoff window. Distinguish transient provider/SQLite errors from deterministic source, model, schema or identity errors. Only deterministic failures may be terminal; transient failures remain retryable with bounded exponential backoff and a clear remediation.
3. Replace the fixed `maxBatches: 1` drain throttle with a bounded time/batch budget per scheduling round. Preserve fairness with per-scope weighted round-robin or deficit scheduling, but allow a healthy scope to process multiple batches while another scope is in retry-wait. No single failed scope may consume the global worker's turns.
4. Add a bounded worker pool, not unbounded process spawning. Benchmark one loaded model with inference concurrency 1, 2, 4 and 6, and batch sizes 64, 128 and 256 on the target Apple Silicon machine. Select the fastest configuration that stays under the memory, thermal, lease and WAL budgets. Do not add Ollama or a network dependency; the bundled Nomic model remains the source of truth.
5. Instrument the complete pipeline separately: claim wait, source loading, tokenization, ONNX inference, vector validation, sqlite-vec write, commit, WAL checkpoint and scheduler idle time. A throughput improvement is valid only when committed ready rows increase; provider calls alone do not count.
6. Keep vector writes in prepared bounded transactions and checkpoint WAL periodically, not on every batch. Add a disk budget and recovery test for interruption during inference, commit and checkpoint. A failed checkpoint must not invalidate already committed vectors or block the semantic queue indefinitely.
7. Preserve and verify incremental reuse by content hash, canonical path, snapshot, model identity and chunker version. A branch or repo with no changed chunks must not regenerate vectors. A branch with changed chunks must enqueue only its changed set and must not borrow vectors across repo, branch or model identity.
8. Make progress truthful: `ready/expected` is coverage only; ETA uses a measured moving rate and the runnable backlog; retry-wait is not silently treated as progress. MCP, CLI and Tauri must return the same per-scope and aggregate fields, including the latest error class, heartbeat, worker build and remediation.
9. Publish the bootstrap lane only after its vectors pass dimension/model/snapshot/reference integrity checks. Keep `partial/lower_bound` explicit until the generation is complete. Activation of a complete generation remains atomic; a partial lane must never replace a valid older active generation.
10. Establish two separate performance gates: (a) first usable bootstrap and bounded incremental delta, with the 10-minute target; (b) full-corpus drain, reported as measured hardware/corpus throughput with no artificial cap on `expected`. If the full corpus cannot meet 10 minutes, document that as a product SLA boundary rather than hiding the work.
11. Re-run the semantic gold set, exact-hit preservation, vector recall@10, hybrid recall@10, no-active-lane overhead, MCP/CLI/Tauri parity, pause/resume, crash recovery, retry isolation, WAL/disk and 8-hour soak tests before the final destructive reset.

**Current-generation decision:** keep the current generation paused or closed at the user's choice while diagnosing; if it is allowed to run, it must remain resumable and its counters must be preserved. Do not bulk-convert the 190,459 retryable rows, lower `expected`, delete staging data, or run a full reset until the error cohort and the replacement worker have passed fixture tests. After D4 passes, use the guarded full reset in Section 9, then cold index/rebuild and enqueue one clean semantic generation.

---

## 7. Phase E — Close scope, safety, graph and evidence gaps

### Task E1: Canonical kind and repo scope enforcement

**Files:**
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-query-scope.test.mjs`
- Test: `tests/knowledge-explore-scope-regressions.test.mjs`
- Test: `tests/knowledge-mcp-scope-regressions.test.mjs`

**Steps:**

1. Define canonical public kind mapping for source hits, symbols, endpoints, notes and graph nodes.
2. Apply `scope.kinds` consistently before ranking and expose eliminated counts by filter.
3. Make `knowledge_explain` consume the same canonical repo/revision resolver as search/explore.
4. Add property tests across every supported kind and two same-name repos; a narrower valid filter may reduce results but cannot hide a correctly typed hit.

### Task E2: Strict mutation preflight

**Files:**
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Test: `tests/knowledge-readonly-preflight.test.mjs`
- Test: `tests/knowledge-adversarial-inputs.test.mjs`

**Steps:**

1. Reject non-absolute paths before resolution.
2. Require existing directory, realpath containment in owner-approved roots and a valid repository for register/index/rebuild.
3. Re-check realpath and scope after confirmation to prevent symlink swap/TOCTOU.
4. Return a confirmation-ready action only for the exact validated canonical root.

### Task E3: Merge endpoint, symbol and affected evidence

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-indexer/src/framework-edges.ts`
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-affected.test.mjs`
- Test: `tests/knowledge-nestjs-affected.test.mjs`
- Test: `tests/knowledge-auth-version-flow.test.mjs`
- Test: `tests/knowledge-rust-trait-dispatch.test.mjs`

**Steps:**

1. Hydrate every endpoint node with canonical repo/revision/source occurrence identity.
2. Preserve node/symbol input as node/symbol scope; do not convert it into its entire file.
3. Return impact edges that explain every impacted item, including endpoint/route and test relationships when evidence exists.
4. Generate suggested verification commands from affected package/crate manifests and evidence-backed test nodes.
5. Strengthen NestJS DI method calls, Rust traits/interfaces, config/Vault fields and endpoint-to-service/database flow fixtures.

### Task E4: Classify unresolved references without gaming the metric

**Files:**
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/knowledge-core/src/coverage-query.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Test: `tests/knowledge-coverage-items.test.mjs`
- Create: `tests/knowledge-unresolved-classification.test.mjs`

**Steps:**

1. Classify every unresolved occurrence as `external_dependency`, `language_builtin`, `dynamic_dispatch`, `generated_code`, `no_enclosing_symbol`, `ambiguous_internal` or `missing_internal`.
2. Preserve the raw occurrence queue and exact aggregate reconciliation; never relabel unknown items as external merely to lower the count.
3. On a stratified manually checked sample of at least 500 FPMS-NT items, require >=98% classification precision.
4. Require 100% of items classified and pageable, aggregate delta zero, and actionable internal unresolved rate <=1% of internal reference occurrences. Remaining dynamic/external debt continues to bound graph recall honestly.

### Task E5: Canonical onboarding and count reconciliation

**Files:**
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-onboarding-canonical.test.mjs`
- Test: `tests/knowledge-tool-discoverability.test.mjs`
- Test: `tests/knowledge-corpus-reconciliation.test.mjs`

**Steps:**

1. Generate onboarding wire names from `listMcpRegistrations()`; never hand-maintain `knowledge_get_node` or `knowledge_architecture` aliases.
2. Publish one reconciliation object for files, symbols, endpoints and embeddings with discovered/persisted/queryable/excluded equations.
3. Ensure architecture, onboarding, endpoints, coverage and storage use that object rather than independent SQL counts.

---

## 8. Phase F — Installed-artifact parity and adversarial product testing

### Task F1: Core/query-server/CLI/MCP parity

**Files:**
- Modify: `scripts/knowledge-mcp-parity-test.mjs`
- Modify: `tests/knowledge-parity-gates.test.mjs`
- Modify: `tests/knowledge-vector-cli-mcp-parity.test.mjs`
- Modify: `tests/knowledge-surface-parity-e2e.test.mjs`

**Steps:**

1. Run identical fixed requests through all four surfaces and normalize transport-only fields.
2. Compare scope, revision, stable IDs, totals, cursor behavior, semantic state, evidence and errors exactly.
3. Include parallel MCP clients, restart during query, index publication during pagination and stale runtime detection.

### Task F2: Real-corpus accuracy and stress matrix

**Files:**
- Modify: `scripts/knowledge-stress.mjs`
- Modify: `scripts/knowledge-real-repo-benchmark.mjs`
- Modify: `scripts/knowledge-real-branch-matrix.mjs`
- Modify: `scripts/knowledge-load-report.mjs`
- Test: `tests/knowledge-multi-branch-unrebuilt.test.mjs`
- Test: `tests/knowledge-load-burst.test.mjs`
- Test: `tests/knowledge-soak-resource-budgets.test.mjs`

**Steps:**

1. Test all canonical repos under `/Users/shieng/Desktop/Projects`, including multiple branches and a branch created from `upstream/master` before that branch is rebuilt.
2. Cover clean, dirty, untracked, deleted, renamed, Unicode path, symlink, empty repo, >10 MB file, generated source, branch switch, detached HEAD and HEAD-advanced-with-zero-parsed states.
3. Run 100 concurrent readers, concurrent index/query, cursor publication races, worker pause/resume, crash recovery and an 8-hour mixed MCP soak.
4. Measure cold and warm latency independently for every query class in Section 1.3. Fail on any missed p95/p99 threshold; never average a 26-second outlier into an apparently acceptable mean.
5. Assert no raw SQLite lock, no corruption, no scope leakage and all latency/resource gates.

---

## 9. One final destructive data/install sequence

Run this only after Phases A-F pass against fixtures and a disposable copy. The full index deletion is mandatory, but it must use Penguin's guarded reset workflow, not `rm -rf`.

1. Record dirty worktree and artifact identity; do not modify Git state.
2. Build packages, run typecheck, full tests, capability gate and release-bundle gate.
3. Create and verify a recoverable knowledge backup plus reset manifest.
4. Quit Penguin, Claude Code and Codex processes that hold the old runtime.
5. Build the final Tauri DMG and compare bundled CLI/MCP/model/sqlite-vec hashes with the tested artifact.
6. Install the DMG into `/Applications/Penguin.app`; launch it once so the versioned runtime is installed.
7. Run installed-artifact health and identity checks. Do not proceed on any dev/release mixture.
8. Use guarded full reset to remove the entire current Penguin index, derived caches and semantic generations.
9. Discover canonical repositories under `/Users/shieng/Desktop/Projects`; reject duplicate canonical roots and explicitly disambiguate same display names.
10. Cold index every selected repo/branch under the final schema, then rebuild all derived graph/endpoint/coverage projections.
11. Run exact corpus reconciliation; all equations must have delta zero and all exclusions must be named/pageable.
12. Enqueue semantic generation for every eligible active snapshot and return control immediately. Let the durable worker publish the bootstrap lane and continue in the backend.
13. Before asking the user to start a first test session, wait only for the bootstrap readiness gate: every evaluation scope has a non-null active generation, matching model/snapshot identity, at least the bootstrap minimum ready vectors, and an explicit `partial/lower_bound` status when pending work remains. Full `ready==expected` completion remains a release-closure gate and must finish in the backend; it must not block the user's first usable test session.
14. Run the installed-artifact capability oracle twice consecutively, including the real-corpus latency matrix. Both runs must pass every gate.
15. Reconfigure MCP clients from Penguin, then fully quit and restart Claude Code and Codex.
16. Record build ID, schema, capability hash, model hash, database digest, corpus revision hash and rubric hash in the final handoff.

---

## 10. External evaluation protocol and finite stop rule

### Internal release-to-test decision

Do not ask the user to open a new session until all are true:

- full unit/integration suite passes;
- installed release-bundle gate passes;
- final corpus reconciliation passes;
- semantic generations are active and complete for selected scopes;
- capability oracle passes twice;
- 8-hour soak passes;
- no known hard-gate defect remains open.

### Exactly two independent evaluations

1. Create a new Claude Code OS process with no previous evaluation context. Give it only `docs/quality/index-evaluation-brief-round27-frozen.md`. It writes `docs/quality/index-evaluation-claude-opus-5-round27.md`.
2. Create a new Codex OS process with no previous evaluation context. Give it the same frozen brief. It writes `docs/quality/index-evaluation-codex-round27.md`.
3. Both use Penguin MCP only after reading the instruction; neither reads source, Git, SQLite, CLI, old reports or the other evaluator's report.
4. Compare rubric hash, runtime identity and hard-gate table. The official score is the lower score.

### Stop/retest rule

- If both scores are 95-100 and all hard gates pass: **GO, close the capability program and stop retesting this rubric.** Move to frontend presentation work.
- If either fails: **NO-GO.** Map every failure to an existing frozen gate. Reproduce it locally and add it to the capability oracle before changing code.
- Fix all failures from both reports as one batch, rerun the final destructive sequence only if persistent schema/index/semantic data changed, and perform one final pair of fresh evaluations.
- Maximum external evaluation pairs: two. If the second pair still fails, stop incremental patching and hold an architecture review against the failed root-cause cluster. Do not create Round 29, Round 30, and so on as unbounded symptom loops.
- New requirements discovered after the rubric is frozen are recorded for the next product milestone unless they reveal data loss, security/scope leakage, fabricated evidence or an advertised capability that cannot execute; those four classes remain immediate blockers.

---

## 11. Effort and risk

### Realistic estimate

Because most foundations already exist, the expected work is **8-12 focused engineering days**, plus a **bounded <=10-minute bootstrap window** for first usable semantic retrieval. Full-corpus semantic completion continues fire-and-forget in the backend and is not a user-facing wait; its actual duration remains hardware/corpus dependent and is not represented as a product score. The final soak remains **8 hours**. This is an estimate, not a score or promise.

| Workstream | Estimate |
| --- | ---: |
| Oracle and frozen rubric | 1 day |
| Schema/repo truth and safety | 1-2 days |
| Endpoint/query pagination and performance | 2-3 days |
| Semantic lifecycle, activation and quality | 2-3 days |
| Scope/affected/graph/reconciliation | 2-3 days |
| Installed-artifact reset, corpus run, soak and two evaluations | 1-2 days plus background runtime |

Add 3-5 engineering days only if endpoint performance requires a new persistent projection/schema migration rather than query/index changes.

### Main risks

- The current worktree contains extensive user changes; overlapping edits must be isolated carefully and never reset.
- Endpoint timeout may require schema-backed materialization, which expands migration risk.
- Semantic generation may expose model memory/throughput limits on the largest repos; batching and checkpointing must preserve fire-and-forget behavior.
- Resolver debt is large; quality is measured by independently sampled classification precision and graph gold questions, not by making the number cosmetically small.
- MCP clients cache process configuration; final proof requires process restart, not only a healthy local launcher.

---

## 12. Required-for-95 versus after-95

### Required for 95

Everything in Sections 1-10, including real semantic activation/ranking, endpoint performance, strict scope/safety, affected evidence, unresolved classification, final full reset/reindex/rebuild, installed-artifact parity and both fresh-session scores.

### Optional only after 95

- Personalized semantic ranking beyond the frozen gold set.
- Predictive pre-indexing.
- Streaming very large graph responses.
- Additional UI polish outside honest status/progress/control.
- Further compression beyond the compactness gate.
- Broad resolver enhancements after the actionable internal debt and gold accuracy gates pass.

---

## 13. Final verification commands

Execute from `/Users/shieng/Desktop/Pengvi`; every shell segment remains RTK-prefixed.

```bash
rtk pnpm run typecheck
rtk pnpm test
rtk pnpm run knowledge:capability:closure
rtk pnpm run knowledge:release-bundle:gate
rtk pnpm run knowledge:mcp:parity
rtk pnpm run knowledge:semantic:acceptance
rtk pnpm run knowledge:semantic:performance-gate
rtk pnpm tauri build
```

Installed-artifact, reset and corpus commands must be resolved from the final capability-gate help output and executed only after its read-only preflight returns the exact canonical targets and confirmation token. Do not hard-code or infer a destructive target in this plan.

---

## 14. Plan self-review checklist

- Covers every Codex and Claude Round 26 finding: yes.
- Covers the defect classes rather than only the observed examples: yes.
- Includes accuracy, evidence, completeness, latency, vector quality, safety, branch, concurrency and installed-artifact testing: yes.
- Requires complete deletion and cold reindex/rebuild of `/Users/shieng/Desktop/Projects`: yes, through guarded recoverable reset.
- Prevents the user from becoming the internal regression runner: yes, external test is blocked until two local installed-artifact passes.
- Defines one official product score and forbids misleading progress percentages: yes.
- Defines a finite stop condition and caps external retest pairs: yes.
- Leaves no implementation placeholder or undecided acceptance threshold: yes.
