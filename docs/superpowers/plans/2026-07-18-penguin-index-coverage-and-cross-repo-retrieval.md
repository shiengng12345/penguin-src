# Penguin Index Coverage and Cross-Repository Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Penguin reliably discover every registered repository, distinguish verified empty results from incomplete coverage, and retrieve exact symbols, APIs, paths, and cross-repository execution flows through the CLI, MCP, and Wiki surfaces.

**Architecture:** Add a workspace/repository registry and an index-health preflight layer above the existing knowledge store. Every retrieval request runs through the same scope resolver, coverage validator, exact index, structural graph, and semantic ranking pipeline. CLI, MCP, and Wiki consume the same response contract, including coverage, trust, and failure reason.

**Tech Stack:** Rust/Tauri knowledge backend, TypeScript/JavaScript CLI and MCP adapters, SQLite knowledge store, existing revision/index pipeline, Node test suite, real repository fixtures under `/Users/shieng/Desktop/Projects`.

## Global Constraints

- Never interpret an empty result as proof of absence when any requested scope is unindexed, stale, excluded, or failed.
- Exact path, symbol, API, gRPC method, route, enum, constant, schema, queue, and workflow lookup must be lossless for admitted files.
- CLI, MCP, and Wiki must call the same canonical query/read contracts; no surface-specific search logic.
- Cross-repository links must be evidence-backed and must identify source repository, target repository, branch, revision, and confidence.
- Read-only queries must not mutate the index; automatic indexing may be explicitly requested or enabled by policy.
- Preserve current branch/revision isolation and copy-on-write semantics.
- Do not remove legacy fallback until the new preflight contract and parity tests pass.
- Every task ends with a focused test run and a small commit.

## File Map

- Modify `src-tauri/src/knowledge.rs`: repository registration, index status, coverage, scope resolution, and canonical retrieval response.
- Modify `src-tauri/src/mcp.rs`: expose preflight and structured incomplete-result errors through MCP.
- Modify `src-tauri/src/rest/*` and `src/lib/knowledge-client.ts`: share the response envelope across desktop, REST, and frontend clients.
- Modify `src/lib/store.ts`, `src/lib/store-types.ts`, and `src/lib/registry-search*.ts`: preserve exact/structural/semantic result layers and coverage metadata.
- Modify `scripts/penguin-mcp-client.mjs`: MCP smoke tests and failure-state assertions.
- Modify `scripts/knowledge-surface-parity.mjs`: CLI/MCP/Wiki parity checks.
- Modify `scripts/knowledge-real-repo-benchmark.mjs` and `scripts/knowledge-universal-retrieval-benchmark.mjs`: real-repository recall corpus and scoring.
- Create `fixtures/knowledge-workspaces/fpms-workspace.yaml`: FPMS cross-repository fixture registry.
- Create `fixtures/knowledge-workspaces/fpms-expected-links.json`: expected UI→gRPC→service→delivery→budget links.
- Create `tests/knowledge-index-health.test.mjs`: repository/index/coverage state contract.
- Create `tests/knowledge-incomplete-result.test.mjs`: empty-result safety contract.
- Create `tests/knowledge-cross-repo-resolution.test.mjs`: workspace mapping and cross-repository edges.
- Create `tests/knowledge-exact-recall.test.mjs`: exact symbol/path/API recall.
- Create `docs/knowledge-v2/index-health-contract.md`: operator-facing health and troubleshooting contract.
- Create `docs/knowledge-v2/cross-repository-workspaces.md`: workspace registry format and FPMS example.

---

### Task 1: Establish the repository and workspace registry

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/rest/*` using the existing knowledge REST module
- Modify: `src/lib/knowledge-client.ts`
- Create: `fixtures/knowledge-workspaces/fpms-workspace.yaml`
- Create: `tests/knowledge-cross-repo-resolution.test.mjs`

**Interfaces:**
- Produces `RepositoryRegistration`, `WorkspaceRegistration`, `RepositoryScope`, and `ResolvedScope` types.
- `ResolvedScope` must include `workspace`, `repo_id`, `repo_name`, `absolute_path`, `branch`, `revision_id`, and `resolution_status`.

- [ ] **Step 1: Write failing registry tests**

Test that registering `/Users/shieng/Desktop/Projects/userengagement` resolves to a stable repo name, repeated registration is idempotent, and an unknown repo path returns `REPO_NOT_REGISTERED` rather than an empty search result.

- [ ] **Step 2: Add the FPMS workspace fixture**

```yaml
workspace: Projects
repos:
  - name: fpms
    path: /Users/shieng/Desktop/Projects/fpms
    role: legacy-admin-ui
  - name: fpmsnt
    path: /Users/shieng/Desktop/Projects/fpmsnt
    role: grpc-gateway
  - name: userengagement
    path: /Users/shieng/Desktop/Projects/userengagement
    role: campaign-domain-service
  - name: fly
    path: /Users/shieng/Desktop/Projects/fly
    role: proto-contract
links:
  - from: fpms
    to: fpmsnt
    kind: grpc-client
  - from: fpmsnt
    to: userengagement
    kind: grpc-service
  - from: userengagement
    to: fly
    kind: proto-contract
```

- [ ] **Step 3: Implement idempotent registration and scope resolution**

Normalize paths, resolve symlinks, derive stable repo IDs, persist workspace membership, and reject ambiguous duplicate names with an explicit error.

- [ ] **Step 4: Run the focused test**

Run: `rtk test node --test tests/knowledge-cross-repo-resolution.test.mjs`

Expected: PASS; unknown paths report `REPO_NOT_REGISTERED`.

- [ ] **Step 5: Commit**

```bash
rtk git add src-tauri/src/knowledge.rs src-tauri/src/rest src/lib/knowledge-client.ts fixtures/knowledge-workspaces/fpms-workspace.yaml tests/knowledge-cross-repo-resolution.test.mjs
rtk git commit -m "feat(knowledge): add workspace repository registry"
```

### Task 2: Add index health and coverage as a first-class contract

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/mcp.rs`
- Modify: `src/lib/knowledge-client.ts`
- Create: `tests/knowledge-index-health.test.mjs`
- Create: `docs/knowledge-v2/index-health-contract.md`

**Interfaces:**
- Produces `IndexHealth`, `CoverageSummary`, and `SearchPreflight`.
- Required statuses: `READY`, `STALE`, `NOT_REGISTERED`, `BRANCH_NOT_FOUND`, `PARTIAL`, `FAILED`.

- [ ] **Step 1: Write failing health tests**

Cover registered/ready, stale, failed-file, excluded-file, missing-branch, and unregistered-repo cases. Assert that every case includes admitted, excluded, failed, last-indexed, branch, and revision fields.

- [ ] **Step 2: Implement health calculation**

Read the existing index metadata and calculate freshness using one shared threshold. Do not hide parser failures behind a successful overall status.

- [ ] **Step 3: Implement preflight**

Before search/context/flow/affected, resolve scope and return a structured preflight result. A read-only query must return health metadata without triggering mutation.

- [ ] **Step 4: Add documentation**

Document the difference between `NO_MATCH_VERIFIED` and `NO_MATCH_INCOMPLETE`, with exact CLI examples for `penguin status`, `penguin coverage`, `penguin index`, and `penguin rebuild`.

- [ ] **Step 5: Run tests and commit**

Run: `rtk test node --test tests/knowledge-index-health.test.mjs`

Expected: PASS with all six health states covered.

```bash
rtk git add src-tauri/src/knowledge.rs src-tauri/src/mcp.rs src/lib/knowledge-client.ts tests/knowledge-index-health.test.mjs docs/knowledge-v2/index-health-contract.md
rtk git commit -m "feat(knowledge): expose index health and coverage"
```

### Task 3: Make empty results safe and explainable

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/mcp.rs`
- Modify: `src/lib/store-types.ts`
- Modify: `src/lib/knowledge-client.ts`
- Create: `tests/knowledge-incomplete-result.test.mjs`

**Interfaces:**
- Produces `KnowledgeQueryResult<T>` with `items`, `query_status`, `coverage`, `scope`, `trust`, `warnings`, and `next_actions`.
- Required query statuses: `MATCH`, `NO_MATCH_VERIFIED`, `NO_MATCH_INCOMPLETE`, `SCOPE_ERROR`, `INDEX_ERROR`.

- [ ] **Step 1: Write failing tests**

Assert that an empty result from an unindexed repo is `NO_MATCH_INCOMPLETE`, an empty result from a complete admitted scope is `NO_MATCH_VERIFIED`, and a parser failure includes the failed file paths.

- [ ] **Step 2: Implement canonical result envelope**

Make CLI, MCP, REST, and Wiki use the same serialized envelope. Preserve backward-compatible `items` access for existing callers.

- [ ] **Step 3: Add actionable next actions**

For `NOT_REGISTERED`, recommend `penguin init <path>`. For stale indexes, recommend `penguin index <path>`. For parser failures, recommend `penguin rebuild <path>` and show failed paths.

- [ ] **Step 4: Run tests and commit**

Run: `rtk test node --test tests/knowledge-incomplete-result.test.mjs`

Expected: PASS; no incomplete empty result is represented as a normal zero-length success.

```bash
rtk git add src-tauri/src/knowledge.rs src-tauri/src/mcp.rs src/lib/store-types.ts src/lib/knowledge-client.ts tests/knowledge-incomplete-result.test.mjs
rtk git commit -m "fix(knowledge): distinguish verified and incomplete empty results"
```

### Task 4: Guarantee exact retrieval coverage

**Files:**
- Modify: `src/lib/registry-search.ts`
- Modify: `src/lib/registry-search-core.ts`
- Modify: `src/lib/store.ts`
- Modify the exact-index extraction module identified by `rtk proxy rg -n 'symbol|route|grpc|workflow|constant' src-tauri/src src/lib`
- Create: `tests/knowledge-exact-recall.test.mjs`

**Interfaces:**
- Produces exact lookup APIs for `path`, `symbol`, `route`, `grpc_method`, `enum`, `constant`, `schema`, `queue`, and `workflow`.
- Exact hits must include file path, line, repo, branch, revision, and parser trust.

- [ ] **Step 1: Build the exact recall corpus**

Add the following FPMS identifiers to the fixture corpus: `CampaignFinalizeOrchestrator`, `BudgetDispatchOrchestrator`, `CampaignTargetingService`, `DELIVERY_STATUS.SENDING`, `DELIVERY_STATUS.BUDGET_SKIP`, `KEY_MISSING`, and `GetCampaignTargetUsersByGroup`.

- [ ] **Step 2: Write failing exact-recall tests**

For every identifier, assert one or more exact hits and assert the expected repository: `userengagement` for the orchestrators/statuses and `fpmsnt`/`fly` for the gRPC contract as applicable.

- [ ] **Step 3: Implement exact lookup before ranking**

Normalize case only for a secondary comparison. Prefer exact identifier/path matches over semantic matches and never discard exact hits because their semantic score is low.

- [ ] **Step 4: Add excluded/failed-file protection**

If an exact lookup touches a failed or excluded file, return the hit with a warning and `trust: INCOMPLETE`, not a silent miss.

- [ ] **Step 5: Run tests and commit**

Run: `rtk test node --test tests/knowledge-exact-recall.test.mjs`

Expected: PASS with 100% exact recall for the fixture corpus.

```bash
rtk git add src/lib/registry-search.ts src/lib/registry-search-core.ts src/lib/store.ts tests/knowledge-exact-recall.test.mjs
rtk git commit -m "feat(knowledge): guarantee exact identifier retrieval"
```

### Task 5: Build cross-repository structural edges

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify the graph edge builder identified by `rtk proxy rg -n 'edge|caller|callee|dependency|grpc' src-tauri/src src/lib`
- Modify: `src/lib/store-types.ts`
- Create: `fixtures/knowledge-workspaces/fpms-expected-links.json`
- Create: `tests/knowledge-cross-repo-flow.test.mjs`

**Interfaces:**
- Produces edges with `source_repo`, `target_repo`, `source_revision`, `target_revision`, `edge_kind`, `evidence`, and `confidence`.
- Supported edge kinds: `grpc_client`, `grpc_service`, `proto_contract`, `import`, `queue_publish`, `queue_consume`, `workflow_activity`, `schema_repository`.

- [ ] **Step 1: Add expected FPMS edges**

Record the known route from legacy FPMS UI through `fpmsnt` into `userengagement`, plus the campaign delivery and budget components.

- [ ] **Step 2: Write failing flow tests**

Assert that a flow request starting at `GetCampaignTargetUsersByGroup` reaches the implementation and that a flow starting at `CampaignFinalizeOrchestrator` includes delivery statuses and finalization logic.

- [ ] **Step 3: Implement evidence-backed edge creation**

Create edges only from proto method names, imported client method names, registered service names, queue constants, workflow registrations, or explicit workspace links. Store the evidence location for each edge.

- [ ] **Step 4: Add cross-repo query scope**

Allow a query to specify one repo, a workspace, or all registered repos. Default incident queries to the workspace containing the initial match.

- [ ] **Step 5: Run tests and commit**

Run: `rtk test node --test tests/knowledge-cross-repo-flow.test.mjs`

Expected: PASS; every expected edge is present with evidence and no guessed edge is accepted.

```bash
rtk git add src-tauri/src/knowledge.rs src/lib/store-types.ts fixtures/knowledge-workspaces/fpms-expected-links.json tests/knowledge-cross-repo-flow.test.mjs
rtk git commit -m "feat(knowledge): add evidence-backed cross-repo graph edges"
```

### Task 6: Make CLI, MCP, and Wiki surface-parity consumers

**Files:**
- Modify: `src-tauri/src/mcp.rs`
- Modify: `scripts/penguin-mcp-client.mjs`
- Modify: `scripts/knowledge-surface-parity.mjs`
- Modify the CLI command implementation identified by `rtk proxy rg -n 'coverage|context|flow|search' src-tauri scripts src`
- Modify Wiki search/context components identified by `rtk proxy rg -n 'knowledge|search|context|coverage' src components`
- Create: `tests/knowledge-surface-parity-regression.test.mjs`

**Interfaces:**
- Every surface accepts the same `QueryScope` and returns the same `KnowledgeQueryResult` fields.
- MCP tools must expose `coverage`, `query_status`, `warnings`, and `next_actions`.

- [ ] **Step 1: Write parity tests**

Run the same exact symbol, missing symbol, stale scope, and cross-repo flow query through CLI, MCP, and Wiki adapters. Compare status, hit paths, repo IDs, revision IDs, and warnings.

- [ ] **Step 2: Remove surface-specific result rewriting**

Keep only presentation formatting at the edge. Do not drop coverage or trust fields when converting MCP/REST responses to UI models.

- [ ] **Step 3: Add UI states**

Display distinct messages for verified no-match, incomplete coverage, stale index, failed files, and unregistered repo. Include the exact next command where applicable.

- [ ] **Step 4: Run parity tests and commit**

Run: `rtk test node --test tests/knowledge-surface-parity-regression.test.mjs`

Expected: PASS; all surfaces return equivalent machine-readable results.

```bash
rtk git add src-tauri/src/mcp.rs scripts/penguin-mcp-client.mjs scripts/knowledge-surface-parity.mjs src components tests/knowledge-surface-parity-regression.test.mjs
rtk git commit -m "feat(knowledge): enforce CLI MCP Wiki result parity"
```

### Task 7: Add automatic index maintenance and operational checks

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify: existing index/watch implementation identified by `rtk proxy rg -n 'watch|stale|incremental|rebuild' src-tauri/src src scripts`
- Modify: `scripts/check-knowledge-runtime.mjs`
- Modify: `scripts/knowledge-release-gate.mjs`
- Modify: `scripts/knowledge-canary-audit.mjs`
- Modify: `docs/knowledge-v2/operations.md`

- [ ] **Step 1: Add safe incremental indexing policy**

On file change, update only affected files and dependent structural edges. Never delete the previous valid revision until the new parse succeeds.

- [ ] **Step 2: Add failed-file quarantine**

Persist failed file path, parser error, first-seen time, last-attempt time, and last-known-good revision. Surface this data through `coverage` and `doctor`.

- [ ] **Step 3: Add watch and startup checks**

Ensure `penguin watch <path>` refreshes the correct registered repo and branch. Startup checks must report stale or failed repos without silently serving them as complete.

- [ ] **Step 4: Add release gates**

Require: no unknown repo in the workspace fixture, exact recall 100%, no silent incomplete result, CLI/MCP/Wiki parity, and successful re-index after a representative edit.

- [ ] **Step 5: Run operational checks and commit**

Run: `rtk test node --test tests/knowledge-index-progress.test.mjs tests/knowledge-core-store.test.mjs`

Expected: PASS; index failures remain visible and previous valid data remains readable.

```bash
rtk git add src-tauri/src/knowledge.rs src-tauri/src scripts/check-knowledge-runtime.mjs scripts/knowledge-release-gate.mjs scripts/knowledge-canary-audit.mjs docs/knowledge-v2/operations.md
rtk git commit -m "feat(knowledge): harden index maintenance and release gates"
```

### Task 8: Validate against the real FPMS incident

**Files:**
- Modify: `docs/knowledge-v2/real-question-corpus.jsonl`
- Modify: `scripts/knowledge-real-repo-benchmark.mjs`
- Modify: `scripts/knowledge-universal-retrieval-benchmark.mjs`
- Create: `docs/knowledge-v2/fpms-incident-retrieval-report.md`

- [ ] **Step 1: Register and index the real workspace**

Run:

```bash
rtk proxy penguin init /Users/shieng/Desktop/Projects/fpms
rtk proxy penguin init /Users/shieng/Desktop/Projects/fpmsnt
rtk proxy penguin init /Users/shieng/Desktop/Projects/userengagement
rtk proxy penguin init /Users/shieng/Desktop/Projects/fly
rtk proxy penguin status
rtk proxy penguin coverage --repo userengagement
```

Expected: all four repos are registered; coverage reports are explicit; no repo is silently omitted.

- [ ] **Step 2: Run exact retrieval checks**

Run the seven exact queries from Task 4 and record path, line, repo, branch, revision, and trust.

- [ ] **Step 3: Run the incident question**

Query: `为什么发布任务显示结束，但是玩家发送状态还是 sending，玩家没有收到消息？`

Expected flow:

```text
publish task
→ target import
→ invalid player-id row handling
→ budget key resolution
→ KEY_MISSING
→ budgetSkip
→ pause/resume path
→ sending state
→ finalizer ongoing-state predicate
→ completed state
```

- [ ] **Step 4: Compare CLI, MCP, and Wiki answers**

The three surfaces must identify the same root-cause files and must not claim that the issue is absent when any repo is incomplete.

- [ ] **Step 5: Run benchmark and write the report**

Run: `rtk test node --test tests/knowledge-real-question-audit.test.mjs tests/knowledge-universal-retrieval-baseline.test.mjs`

Expected: incident answer includes the `SENDING`/`BUDGET_SKIP` finalizer gap, `KEY_MISSING` budget path, and invalid player-id import path with source evidence.

```bash
rtk git add docs/knowledge-v2/real-question-corpus.jsonl scripts/knowledge-real-repo-benchmark.mjs scripts/knowledge-universal-retrieval-benchmark.mjs docs/knowledge-v2/fpms-incident-retrieval-report.md
rtk git commit -m "test(knowledge): validate FPMS incident retrieval end to end"
```

## Definition of Done

- [ ] `userengagement`, `fpmsnt`, `fpms`, and `fly` are registered as one workspace.
- [ ] `penguin status` and `penguin coverage` clearly expose stale, failed, excluded, and missing repositories.
- [ ] Empty results are classified as verified or incomplete.
- [ ] Exact symbol/path/API recall reaches 100% for the FPMS corpus.
- [ ] Cross-repository flows include evidence-backed edges and revision metadata.
- [ ] CLI, MCP, and Wiki return equivalent machine-readable result contracts.
- [ ] The real FPMS incident is retrievable without manual `rg` fallback.
- [ ] No release gate passes if a requested repository is unknown or coverage is incomplete.

## Self-Review Checklist

- [ ] Every task has exact files, interfaces, tests, commands, expected results, and a commit boundary.
- [ ] No task treats a missing index as a successful empty result.
- [ ] Exact recall, cross-repo resolution, MCP parity, Wiki parity, and operational recovery are all covered.
- [ ] The plan does not require changing external production systems.
- [ ] The plan preserves the existing revision and copy-on-write architecture.
