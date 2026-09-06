# Penguin Semantic Fire-and-Forget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Penguin `index`/`rebuild` publish Graph + Lexical promptly, enqueue semantic work durably, and return without waiting while a version-aligned background worker completes vectors with truthful Pause/Resume/Retry/Cancel controls in Tauri, CLI, and MCP.

**Architecture:** Reuse the existing SQLite `embedding_generations`, `embedding_jobs`, vector store, and atomic active-generation pointer. Split semantic enqueue from semantic draining, add transactional leases and a short-lived supervised worker, and wake that worker idempotently from CLI, Tauri, and MCP. Remove the currently unused Wiki `Focus` tab, default the Wiki to `Graph`, and make background semantic state a first-class Tauri surface rather than a settings-only badge.

**Tech Stack:** TypeScript/Node.js, better-sqlite3, sqlite-vec, local ONNX/Nomic embeddings, Rust/Tauri, React, MCP stdio, pnpm, Node test runner.

**Binding scope amendment:** `docs/superpowers/plans/2026-09-01-penguin-index-truth-developer-intelligence.md` is part of this master goal. Its Phase A gates A1–A4 must close before packaged/fresh-session acceptance, and its Phase B tasks B1–B6 plus gates G13–G20 must close before this plan may claim 95–100 complete.

**Spec:**

- `docs/superpowers/plans/2026-08-31-penguin-knowledge-95-100-full-closure.md`
- `docs/quality/index-evaluation-brief-round20.md`
- this document, sections “Binding product behavior” and “Acceptance gates”

## Global Constraints

- Preserve the user’s dirty worktree. Never reset, overwrite, stage, or commit unrelated files.
- Penguin Wiki/Knowledge is private owner-operated infrastructure on this Mac. Other users are fresh MCP-only consumers and must not depend on the local Tauri UI, source checkout, terminal, or database access.
- Graph and Lexical are truth lanes and must remain usable while vectors are queued, paused, retrying, stalled, or unavailable.
- Semantic search must fail closed: never report semantic `active` unless the active generation is atomically verified complete.
- A process may execute a job more than once after a crash; database effects must be idempotent and observable exactly once. Do not claim impossible process-level “exactly once” execution.
- Worker startup must use the same stable launcher/versioned runtime as CLI and MCP. Build ID, capability hash, schema version, model hash, and chunker version must match before claiming work.
- A machine shutdown pauses execution naturally. Work resumes on the next Penguin entry point: Tauri launch, CLI index/rebuild, MCP server start, or explicit worker command. This plan does not install a permanent launchd/system daemon.
- Closing the Tauri window does not mean Pause. Explicit Pause is persisted and must remain paused across restarts until Resume.
- Mac sleep suspends CPU work; it is not an error. The worker resumes after wake while its lease is valid or safely reclaims expired jobs.
- Schema migration must be additive, backed up, testable, and must not force an unrelated full parser/graph rebuild.
- Installation/update must align the stable launcher, versioned runtime, CLI bundle, MCP bundle, native modules, model assets, and client configuration. Existing already-running Claude/Codex processes still require a restart and must be reported as `restartRequired`, not silently treated as updated.
- All shell commands use the repository-required `rtk` prefix.
- Completion requires installed-artifact and fresh-session evidence. Source tests or a successful DMG build alone are not completion.

---

## Independent-review synthesis

| Reviewer | Recommendation | Useful warning | Codex decision |
| --- | --- | --- | --- |
| Claude Code local | SQLite queue + short-lived supervised CLI worker | Existing job claim is non-atomic; current whole-generation recovery is unsafe with multiple workers; MCP-only startup is mandatory | Adopted |
| DeepSeek | SQLite queue + supervised worker | Require leases, heartbeat, retry, crash recovery, truthful progress, and release fault-injection gates | Adopted, but without its greenfield tables and 12–14 week estimate |
| Codex | Reuse existing generations/jobs and atomic activation; split enqueue/drain; add one canonical status/control contract | Do not use detached `screen` as product architecture; do not confuse queued semantic work with ready semantic search | Binding design |

Rejected options:

1. **Detached child only:** cheap, but not supervised, not restart-safe by itself, difficult to diagnose, and vulnerable to duplicate workers.
2. **Always-on launchd/system daemon:** stronger autonomous startup, but introduces install/update/uninstall complexity and can keep an old runtime alive after an upgrade. It is unnecessary for the current private local-first scope.
3. **Selected — durable SQLite queue + short-lived drainer:** queued work survives every process. Any current Penguin entry point can wake the same versioned worker; duplicate wake attempts converge through leases.

## Binding product behavior

### What the user experiences

1. `penguin index <repo>` and `penguin rebuild <repo>` finish Graph + Lexical, persist semantic chunks/jobs, start or wake the worker, print `semantic: queued`, and return.
2. Tauri indexing behaves the same way. The UI does not wait for all embeddings before Graph becomes available.
3. The Wiki opens on `Graph`. The unused `Focus` tab and its top-level search input are removed from the current navigation. `WikiSearchPage` and the underlying search APIs remain in source for later frontend redesign and MCP/CLI use.
4. A persistent semantic-status panel shows state, repository, generation, model, progress, rate, ETA, failed jobs, last heartbeat, worker version, and actions.
5. **Pause** finishes the current committed batch and stops claiming new jobs. The database records the pause request and the worker exits cleanly.
6. **Resume** clears the pause request and wakes a current-version worker.
7. **Retry** resets only retryable/terminal failed jobs within the selected generation; ready jobs are retained.
8. **Cancel** fails the staging generation with `USER_CANCELLED`, prevents activation, and leaves the current active generation untouched.
9. If semantic is unavailable, search responses state `applied: false` and an exact reason such as `embedding_in_progress`, `paused`, `model_unavailable`, `version_mismatch`, or `stalled`.

### Canonical state model

```ts
export type SemanticGenerationState =
  | "disabled"
  | "chunks_ready"
  | "queued"
  | "embedding"
  | "pausing"
  | "paused"
  | "retry_wait"
  | "stalled"
  | "active"
  | "superseded"
  | "cancelled";

export interface SemanticStatus {
  state: SemanticGenerationState;
  scopeKey: string;
  repoId: string | null;
  generationId: string | null;
  activeGenerationId: string | null;
  snapshotId: string | null;
  modelId: string | null;
  modelHash: string | null;
  chunkerVersion: string | null;
  expected: number;
  ready: number;
  running: number;
  pending: number;
  retryableFailed: number;
  terminalFailed: number;
  progressPercent: number;
  ratePerSecond: number | null;
  etaSeconds: number | null;
  paused: boolean;
  pauseRequested: boolean;
  lastHeartbeatAt: string | null;
  workerBuildId: string | null;
  reason: string | null;
  restartRequired: boolean;
}

export type SemanticControlAction = "pause" | "resume" | "retry" | "cancel";
```

All CLI, MCP, Rust/Tauri, and React code consume this one contract. No surface invents its own interpretation.

### Job and worker guarantees

- One global worker lease per knowledge database; duplicate wake attempts exit successfully after confirming another healthy worker owns the lease.
- Each job has its own lease owner and expiry. Claiming is a conditional transactional update, never SELECT followed by unguarded UPDATE.
- Lease TTL: 60 seconds. Heartbeat interval: 20 seconds. A worker that cannot renew before expiry stops processing after its current database transaction.
- Expired `running` jobs return to `pending`; live jobs are never reset by another worker.
- Retry delay: `min(30 seconds * 2^(attempts-1), 30 minutes)`, maximum five attempts. Five failed attempts produce `stalled`, never `active`.
- Job writes remain idempotent through the existing generation/chunk identity and unique semantic-reference identity.
- Newer snapshots supersede older staging generations for the same `(scope, embedding space)`. Ready vectors remain eligible for content-hash reuse; obsolete pending/running jobs are not activated.
- Existing `assertReady` and atomic `semantic_active_spaces` swap remain the only activation path.

---

## File map

| Responsibility | Files |
| --- | --- |
| Canonical status/control contracts | `packages/knowledge-contracts/src/capabilities.ts`, `input-schemas.ts`, `surface.ts`, `index.ts` |
| Schema, generation lifecycle, job leases | `packages/knowledge-core/src/schema.ts`, `embedding-lifecycle.ts`, `store.ts`, `semantic-identity.ts` |
| Enqueue/drain/supersession | `packages/knowledge-indexer/src/pipeline.ts`, `embedding-indexer.ts`, `embedding-worker.ts`, `index.ts` |
| CLI worker and supervisor | `packages/knowledge-cli/src/command-dispatch.ts`, `args.ts`, new `semantic-worker.ts`, `query-server.ts` |
| MCP startup/status/control | `packages/mcp/src/index.ts`, `knowledge-tool-defs.ts`, `knowledge-tools.ts` |
| Tauri lifecycle and commands | `src-tauri/src/knowledge.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/runtime/knowledge_runtime.rs` |
| React status and controls | `src/lib/knowledge-client.ts`, `src/components/wiki/WikiPage.tsx`, new `SemanticWorkerPanel.tsx`, `IndexProgressBanner.tsx`, `WikiStatusFooter.tsx`, `SettingsDialog.tsx` |
| Runtime/install parity | `scripts/bundle-knowledge-cli.mjs`, `knowledge-cli-launcher.mjs`, `knowledge-mcp-launcher.mjs`, `vendor-knowledge-runtime.mjs`, `knowledge-release-bundle-gate.mjs` |
| Tests | existing semantic/runtime/parity tests plus the new tests named below |

---

### Task 1: Freeze the canonical semantic status and control contract

**Files:**

- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-contracts/src/surface.ts`
- Modify: `packages/knowledge-contracts/src/index.ts`
- Test: `tests/knowledge-semantic-status-contract.test.mjs`
- Test: `tests/knowledge-capability-manifest.test.mjs`

**Interfaces:**

- Produces `SemanticStatus`, `SemanticControlAction`, and `SemanticControlResult`.
- Registers `knowledge.semantic_status` as read-only.
- Registers `knowledge.semantic_control` as mutating, with required operation token for `pause`, `resume`, `retry`, and `cancel`.

- [ ] **Step 1: Add failing schema tests.** Assert every state is accepted, negative counts and percentages over 100 are rejected, control actions require `scopeKey`, and retry/cancel may include `generationId`.
- [ ] **Step 2: Run the focused failing tests.**

  ```bash
  rtk test node --test tests/knowledge-semantic-status-contract.test.mjs tests/knowledge-capability-manifest.test.mjs
  ```

- [ ] **Step 3: Implement the contracts and canonical MCP wire names.** Use `knowledge_semantic_status` and `knowledge_semantic_control`; keep the canonical capability IDs dot-separated.
- [ ] **Step 4: Regenerate capability snapshots and rerun the focused tests.**
- [ ] **Step 5: Review checkpoint.** Do not commit unless the user explicitly authorizes commits; if authorized, stage only Task 1 files.

**Exit gate:** one status/control shape exists before any worker or UI code is added.

### Task 2: Add additive schema v18 leases without forcing a graph rebuild

**Files:**

- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Test: `tests/knowledge-schema-v18.test.mjs`
- Test: `tests/knowledge-index-mode.test.mjs`
- Test: `tests/knowledge-install-upgrade-test.mjs`

**Interfaces:**

```sql
ALTER TABLE embedding_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE embedding_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE embedding_jobs ADD COLUMN next_attempt_at TEXT;

CREATE TABLE semantic_worker_leases (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  build_id TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);

CREATE TABLE semantic_controls (
  scope_key TEXT PRIMARY KEY,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  cancelled_generation_id TEXT,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 1: Write migration tests from schema 17 to 18.** Preserve all generation/job/vector counts and verify the new columns/tables/indexes.
- [ ] **Step 2: Add a failing test proving a semantic-only schema migration does not force parser/graph rebuild.** Separate database schema compatibility from parser-derived index format compatibility.
- [ ] **Step 3: Run the failing tests.**

  ```bash
  rtk test node --test tests/knowledge-schema-v18.test.mjs tests/knowledge-index-mode.test.mjs tests/knowledge-install-upgrade-test.mjs
  ```

- [ ] **Step 4: Bump `SCHEMA_VERSION` to 18 and add idempotent migrations.** Introduce a parser/index-format version independent from storage schema version; `resolveIndexMode` compares parser-derived format, not every additive storage migration.
- [ ] **Step 5: Add pre-migration backup and downgrade-safe read tests.** An old runtime must fail with a clear upgrade/version mismatch instead of writing with unsafe job semantics.
- [ ] **Step 6: Run schema, rollback, runtime-manager, and install-upgrade tests.**

**Exit gate:** a real v17 database opens as v18 without losing vectors and without a surprise full graph reparse.

### Task 3: Make job claims, leases, heartbeat, pause, and retry transactional

**Files:**

- Modify: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Modify: `packages/knowledge-indexer/src/embedding-worker.ts`
- Test: `tests/knowledge-semantic-worker-leases.test.mjs`
- Test: `tests/knowledge-vector-crash-recovery.test.mjs`
- Test: `tests/knowledge-embedding-indexer.test.mjs`

**Interfaces:**

```ts
claimEmbeddingJobs(input: {
  ownerId: string;
  generationId: string;
  limit: number;
  now: string;
  leaseExpiresAt: string;
}): EmbeddingJob[];

heartbeatEmbeddingJobs(ownerId: string, jobIds: string[], leaseExpiresAt: string): number;
reclaimExpiredEmbeddingJobs(now: string): number;
requestSemanticPause(scopeKey: string): SemanticControlResult;
resumeSemanticScope(scopeKey: string): SemanticControlResult;
retrySemanticFailures(generationId: string): SemanticControlResult;
cancelSemanticGeneration(generationId: string): SemanticControlResult;
```

- [ ] **Step 1: Write two-connection race tests.** Two SQLite connections claiming the same generation must receive disjoint job IDs; total claimed must equal the requested bounded amount.
- [ ] **Step 2: Write lease recovery tests.** Live leases remain running; expired leases return to pending; a restarted worker resumes only expired jobs.
- [ ] **Step 3: Write pause tests.** A pause request allows the current batch transaction to complete but causes the next claim to return no work and produces `paused`.
- [ ] **Step 4: Write retry/cancel tests.** Retry retains ready rows and resets eligible failed rows; cancel cannot retire or alter the currently active generation.
- [ ] **Step 5: Run tests and confirm current SELECT-then-UPDATE behavior fails the race cases.**
- [ ] **Step 6: Implement conditional claim/update and replace whole-generation `recoverInterruptedJobs`.** Every transition includes expected prior status/lease owner in its `WHERE` clause and verifies `changes()`.
- [ ] **Step 7: Implement bounded retry scheduling and terminal `stalled` derivation.** Persist sanitized errors; never persist model input/source text in error fields.
- [ ] **Step 8: Rerun crash, lifecycle, and vector GC tests.**

**Exit gate:** killing a worker can waste at most one uncommitted batch; it cannot duplicate references, reset live work, or activate an incomplete generation.

### Task 4: Split Graph/ Lexical publication from semantic enqueue and draining

**Files:**

- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Modify: `packages/knowledge-indexer/src/index.ts`
- Test: `tests/knowledge-semantic-fire-and-forget.test.mjs`
- Test: `tests/knowledge-pipeline-semantic-indexing.test.mjs`
- Test: `tests/knowledge-index-recovery-scenarios.test.mjs`

**Interfaces:**

```ts
enqueueSemanticGeneration(input: {
  store: KnowledgeStore;
  repoId: string;
  snapshotId: string;
  scopeKey: string;
  space: EmbeddingSpaceInput;
}): SemanticEnqueueResult;

drainSemanticQueue(input: {
  store: KnowledgeStore;
  provider: EmbeddingProvider;
  ownerId: string;
  signal?: AbortSignal;
  onProgress?: (status: SemanticStatus) => void;
}): Promise<SemanticDrainResult>;
```

- [ ] **Step 1: Write a timing-independent failing test.** Use a provider promise that never resolves; assert `indexRepo` still returns after chunks/jobs are durably queued and Graph queries already work.
- [ ] **Step 2: Write marker-boundary tests.** The branch index marker remains held through graph commit and is released before background draining; a concurrent graph index never overlaps the graph transaction.
- [ ] **Step 3: Write supersession tests.** A newer snapshot marks the older staging generation `SUPERSEDED_BY_NEWER_SNAPSHOT`; identical source chunks reuse ready vectors by content/model/chunker identity.
- [ ] **Step 4: Run focused tests and confirm current inline `await runSemanticIndex()` fails.**
- [ ] **Step 5: Extract enqueue and drain paths.** `indexRepo` performs chunk generation + durable enqueue only. It returns `semantic.status = "queued" | "active" | "disabled"` and never owns an embedding provider during ordinary index/rebuild.
- [ ] **Step 6: Preserve atomic activation.** Keep `assertReady` and the active-pointer swap unchanged; the drainer calls them only after zero pending/running/retryable jobs and `ready === expected`.
- [ ] **Step 7: Run pipeline, crash recovery, hybrid search, and graph availability tests.**

**Exit gate:** Graph/ Lexical response time no longer includes embedding time, while semantic work is guaranteed durable before index/rebuild returns.

### Task 5: Add the short-lived version-aligned semantic worker and supervisor

**Files:**

- Create: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Modify: `scripts/knowledge-cli-launcher.mjs`
- Modify: `scripts/knowledge-process-utils.mjs`
- Test: `tests/knowledge-semantic-supervisor.test.mjs`
- Test: `tests/knowledge-launcher.test.mjs`
- Test: `tests/knowledge-bundle-runtime.test.mjs`

**CLI:**

```text
penguin semantic worker --drain
penguin semantic status [--scope <scopeKey>] --json
penguin semantic pause --scope <scopeKey> --operation-token <token>
penguin semantic resume --scope <scopeKey> --operation-token <token>
penguin semantic retry --generation <id> --operation-token <token>
penguin semantic cancel --generation <id> --operation-token <token>
```

- [ ] **Step 1: Write worker-lock tests.** Two worker processes started together yield one lease owner and one clean no-op loser.
- [ ] **Step 2: Write process-lifecycle tests.** Parent CLI exits while the worker continues; worker exits when the queue drains; stale lease takeover works after expiry.
- [ ] **Step 3: Write version fail-closed tests.** A worker with mismatched build/capability/schema/model manifest claims zero jobs and records `VERSION_MISMATCH` status/remediation.
- [ ] **Step 4: Implement `semantic worker --drain`.** Open the bundled provider inside the worker process, acquire the database worker lease, heartbeat, drain fair bounded batches across eligible generations, checkpoint WAL, and exit on empty/paused/stalled queue.
- [ ] **Step 5: Implement `ensureSemanticWorker()`.** Spawn via the stable launcher using ignored stdio and a dedicated rotating log; return a structured `started | already_running | start_failed | version_mismatch` result.
- [ ] **Step 6: Wake after successful CLI enqueue.** Worker-start failure does not roll back Graph/ Lexical, but CLI JSON and human output must show `queued` plus actionable `worker.start_failed`.
- [ ] **Step 7: Run source and bundled-launcher tests.** Verify with the vendored Node/native modules, not system Node.

**Exit gate:** ordinary CLI index/rebuild is true fire-and-forget without `screen`, `nohup`, an open terminal, or an always-on daemon.

### Task 6: Make MCP-only startup and semantic truthfulness complete

**Files:**

- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts`
- Modify: `packages/knowledge-core/src/hybrid-search.ts`
- Modify: `packages/knowledge-contracts/src/search.ts`
- Test: `tests/knowledge-semantic-status-parity.test.mjs`
- Test: `tests/knowledge-vector-cli-mcp-parity.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/mcp-release-bundle.test.mjs`

- [ ] **Step 1: Write an MCP-only cold-start test.** Start the bundled MCP server with a queued generation and no Tauri process; assert it wakes the worker without blocking MCP initialize/tools/list.
- [ ] **Step 2: Write status/control parity tests.** CLI JSON and MCP results must be byte-equivalent after removing transport metadata.
- [ ] **Step 3: Write truthful fallback tests.** A semantic/blend query before activation includes `semantic.applied=false`, exact reason, ready/expected, and Graph/Lexical lanes used.
- [ ] **Step 4: Implement MCP boot wake.** It is best-effort and asynchronous; MCP remains responsive if the model is missing or the worker cannot start.
- [ ] **Step 5: Register semantic status/control tools from canonical contracts.** Control tools retain operation-token and owner-local ACL protections; fresh consumers receive read status but cannot mutate owner indexing unless explicitly authorized.
- [ ] **Step 6: Run MCP release-bundle and fresh initialize/tool-call tests.**

**Exit gate:** a completely fresh Claude/Codex MCP-only session cannot end up with permanently queued vectors merely because Tauri was never opened.

### Task 7: Add Tauri supervision and Pause/Resume/Retry/Cancel commands

**Files:**

- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/runtime/knowledge_runtime.rs`
- Modify: `src/lib/knowledge-client.ts`
- Test: `tests/knowledge-tauri-semantic-control.test.mjs`
- Test: Rust unit tests in `src-tauri/src/knowledge.rs`
- Test: `tests/knowledge-runtime-manager.test.mjs`

**Interfaces:**

```rust
#[tauri::command]
async fn knowledge_semantic_status(scope_key: Option<String>) -> Result<String, String>;

#[tauri::command]
async fn knowledge_semantic_control(
    action: String,
    scope_key: Option<String>,
    generation_id: Option<String>,
    operation_token: String,
) -> Result<String, String>;
```

- [ ] **Step 1: Write a Tauri command registration test and Rust serialization tests.** Ensure Rust transports the canonical payload without renaming or recomputing state.
- [ ] **Step 2: Add an app-start wake test.** After runtime provisioning and schema migration, Tauri invokes the stable worker asynchronously and never blocks window creation.
- [ ] **Step 3: Change `knowledge_reindex`.** It returns the Graph/ Lexical report plus enqueue/worker-start result; it no longer streams embedding work as part of the same invocation.
- [ ] **Step 4: Add status/control bridge commands.** Route them through the bundled CLI/canonical query layer so UI semantics equal CLI/MCP semantics.
- [ ] **Step 5: Emit durable status-change events.** Use polling as recovery and events as latency optimization; reopening the page must reconstruct state from SQLite rather than relying on missed events.
- [ ] **Step 6: Run Rust, Tauri bridge, and runtime-manager tests.**

**Exit gate:** Tauri can be closed, reopened, upgraded, or restarted without losing control or lying about worker state.

### Task 8: Replace the current Focus tab with a useful background-status experience

**Files:**

- Modify: `src/components/wiki/WikiPage.tsx`
- Create: `src/components/wiki/SemanticWorkerPanel.tsx`
- Modify: `src/components/wiki/IndexProgressBanner.tsx`
- Modify: `src/components/wiki/WikiStatusFooter.tsx`
- Modify: `src/components/settings/SettingsDialog.tsx`
- Modify: `src/lib/knowledge-client.ts`
- Preserve but remove from current navigation: `src/components/wiki/WikiSearchPage.tsx`
- Test: `tests/knowledge-wiki-semantic-status-ui.test.mjs`
- Test: `tests/knowledge-index-progress.test.mjs`

**UI contract:**

```text
Wiki tabs: Graph | Storage
Default tab: Graph

Background card:
  Semantic indexing       [Embedding | Paused | Active | Stalled]
  FPMS-NT                 29,120 / 45,007  (64.7%)
  ████████████░░░░░░      ~14 chunks/s · about 19 min
  Nomic model · sqlite-vec · last heartbeat 8s ago
  [Pause] [Retry failed] [Cancel generation]
```

- [ ] **Step 1: Write failing navigation tests.** `CenterTab` is `"graph" | "storage"`; `Focus` and the Search icon are absent; the initial tab is Graph; existing graph node focus/context behavior remains intact.
- [ ] **Step 2: Write state rendering tests.** Cover queued, embedding, pausing, paused, retry_wait, stalled, active, version mismatch, model unavailable, and restart required.
- [ ] **Step 3: Write action tests.** Pause disables itself and shows `pausing`; Resume wakes the worker; Retry shows failed count; Cancel requires confirmation and never removes the active generation.
- [ ] **Step 4: Remove the Focus tab from `WikiPage`.** Delete its import/render branch and top navigation button, but do not delete `WikiSearchPage` or core search APIs.
- [ ] **Step 5: Implement `SemanticWorkerPanel`.** Poll every two seconds while nonterminal, every 30 seconds while active/disabled, and immediately refresh after a control result or status event.
- [ ] **Step 6: Integrate compact status.** Show a small progress/status control in the Wiki banner/footer; keep the detailed panel accessible without opening Settings.
- [ ] **Step 7: Simplify Settings semantic copy.** Settings shows runtime/config diagnostics and links to the Wiki status panel; it no longer duplicates an independent semantic state calculation.
- [ ] **Step 8: Run UI tests and TypeScript typecheck.**

  ```bash
  rtk test node --test tests/knowledge-wiki-semantic-status-ui.test.mjs tests/knowledge-index-progress.test.mjs
  rtk test pnpm typecheck
  ```

**Exit gate:** the blank/unused Focus experience is gone, and the user can understand and control real backend work from Tauri without opening Terminal.

### Task 9: Bound performance, memory, logs, WAL, and storage

**Files:**

- Modify: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/knowledge-indexer/src/embedding-indexer.ts`
- Modify: `packages/knowledge-core/src/storage-report.ts`
- Modify: `src/components/wiki/WikiStoragePage.tsx`
- Test: `tests/knowledge-semantic-worker-performance.test.mjs`
- Test: `tests/knowledge-storage-report.test.mjs`
- Test: `tests/knowledge-vector-gc.test.mjs`

- [ ] **Step 1: Add deterministic scheduler tests.** Short chunks use bounded adaptive batches; long chunks reduce batch size; worker fairness prevents one large repository from starving others.
- [ ] **Step 2: Add storage/WAL gates.** Commit each batch, passive-checkpoint periodically, truncate only when no conflicting writer exists, and rotate worker logs by size/count.
- [ ] **Step 3: Add metrics to canonical status.** Persist rolling ready delta/time samples so rate and ETA survive UI reload and are not derived from one React session.
- [ ] **Step 4: Add real FPMS-NT measurement.** Record total chunks, ready/failed, peak RSS, chunks/sec, main DB size, peak/final WAL, and query latency while the worker writes.
- [ ] **Step 5: Enforce gates.** No failed jobs; no unbounded WAL growth; no duplicate refs; Graph/ Lexical p95 latency remains within 20% of idle baseline; semantic storage is reported separately from graph/source storage.

**Exit gate:** fire-and-forget does not merely hide a worker that makes the rest of Penguin unusably slow or silently fills disk.

### Task 10: Make install/update/runtime/MCP alignment automatic and fail-closed

**Files:**

- Modify: `scripts/vendor-knowledge-runtime.mjs`
- Modify: `scripts/bundle-knowledge-cli.mjs`
- Modify: `scripts/knowledge-cli-launcher.mjs`
- Modify: `scripts/knowledge-mcp-launcher.mjs`
- Modify: `scripts/knowledge-release-bundle-gate.mjs`
- Modify: `src-tauri/src/runtime/knowledge_runtime.rs`
- Modify: `src-tauri/src/mcp.rs`
- Test: `tests/knowledge-install-upgrade-test.mjs`
- Test: `tests/knowledge-parity-gates.test.mjs`
- Test: `tests/knowledge-release-bundle-gate.test.mjs`
- Test: `tests/mcp-generation-watch.test.mjs`

- [ ] **Step 1: Add an upgrade fixture.** Install old runtime/config, install the new app, verify atomic `current` switch and stable launcher paths without manual CLI commands.
- [ ] **Step 2: Assert one manifest.** App, CLI, MCP, worker, native modules, sqlite-vec, ONNX model, schema, contract, chunker, and capability hash must match.
- [ ] **Step 3: Reconfigure clients to stable launchers.** Never write a version-directory path into Claude/Codex config. Preserve unrelated client config fields.
- [ ] **Step 4: Handle live old sessions honestly.** Mark `restartRequired=true` until a new MCP initialize handshake reports the current build; do not claim hot replacement of an already-running external client.
- [ ] **Step 5: Verify rollback.** Previous runtime remains available until the new runtime passes initialize, native load, semantic status, and worker smoke tests.
- [ ] **Step 6: Run install, parity, and release bundle gates.**

**Exit gate:** installing the DMG is sufficient to provision the current CLI/MCP/worker; the only manual user action left is restarting an already-open Claude/Codex client.

### Task 11: Full closure, DMG build, install verification, and Round 21 fresh retest

**Files:**

- Create: `scripts/knowledge-semantic-fire-and-forget-acceptance.mjs`
- Create: `tests/knowledge-semantic-fire-and-forget-acceptance.test.mjs`
- Create after implementation passes: `docs/quality/index-evaluation-brief-round21.md`
- Modify after implementation passes: `docs/quality/index-evaluation-brief.md`
- Create after independent tests: new Round 21 evaluator reports; never edit older reports
- Modify: `package.json`

- [ ] **Step 1: Run targeted semantic worker suites.**

  ```bash
  rtk test node --test tests/knowledge-semantic-status-contract.test.mjs tests/knowledge-schema-v18.test.mjs tests/knowledge-semantic-worker-leases.test.mjs tests/knowledge-semantic-fire-and-forget.test.mjs tests/knowledge-semantic-supervisor.test.mjs tests/knowledge-semantic-status-parity.test.mjs tests/knowledge-tauri-semantic-control.test.mjs tests/knowledge-wiki-semantic-status-ui.test.mjs
  ```

- [ ] **Step 2: Run the complete repository gates.**

  ```bash
  rtk test pnpm test
  rtk test pnpm typecheck
  rtk test pnpm knowledge:bundle
  rtk test pnpm knowledge:release-bundle:gate
  rtk test pnpm knowledge:release-gate
  ```

- [ ] **Step 3: Run packaged fault injection.** Use a disposable database and release bundle: terminate parent CLI, kill worker mid-batch, pause, close Tauri, resume, sleep/wake, simulate model unavailable, run concurrent index/rebuild, supersede a snapshot, and verify active-generation integrity after every case.
- [ ] **Step 4: Run a real FPMS-NT background build.** Confirm CLI returns after Graph/ Lexical + enqueue; progress continues with Terminal closed; Pause/Resume works from Tauri; all 45,007 expected chunks reach ready with zero terminal failures; semantic generation activates once.
- [ ] **Step 5: Build the unsigned internal DMG.** Do not compete with a heavy live embedding worker; pause it or wait until drain completion before building.

  ```bash
  rtk proxy env CI=true pnpm tauri build --no-sign --bundles app,dmg
  ```

- [ ] **Step 6: Install and verify the artifact.** Confirm installed app version/build ID, runtime symlink, CLI/MCP/worker manifest, schema v18, native module load, model health, automatic MCP stable-launcher config, and `restartRequired` behavior.
- [ ] **Step 7: Create a genuinely new immutable brief after all binding scope-amendment gates pass.** Include fresh questions for Graph, flow, affected, endpoint, coverage, vector recall, semantic unavailable honesty, background progress, Pause/Resume, restart recovery, MCP-only worker wake, identity parity, zero-parse HEAD advancement, live freshness, endpoint publication parity/filtering, concurrent index job status, Auth `VersionService.Version`, ccmsrust Redis configuration lineage, working-tree overlay, graph diff, verification recommendations, and deterministic analysis fallback. Record immutable SHA-256.
- [ ] **Step 8: Run two independent fresh sessions.** One Claude Code and one Codex session use only MCP as the consumer path; neither may inspect old reports or use local CLI/source/DB fallbacks.
- [ ] **Step 9: Score honestly.** The goal is both fresh evaluators at 95–100. Any MCP unavailable, semantic inactive, runtime mismatch, duplicate job, stalled generation, false-ready claim, false-fresh revision, parser/query endpoint count drift, raw database-lock failure, missing Auth method-call hop, unbounded endpoint payload, or manual source/CLI/grep workaround keeps the program open.

**Exit gate:** installed artifact verified, worker control proven, semantic generation active, CLI/MCP/Tauri parity proven, and both new-session Round 21 reports score at least 95/100.

---

## Acceptance gates

| Gate | Required evidence | Failure means |
| --- | --- | --- |
| G1 Graph-first return | Provider is intentionally blocked but index/rebuild returns with durable jobs and queryable graph | Fire-and-forget not implemented |
| G2 Atomic claims | Two processes claim disjoint jobs; no duplicate refs | Worker unsafe |
| G3 Crash/restart | Kill mid-batch, reopen App/MCP, expired jobs resume | Restart recovery incomplete |
| G4 Pause/Resume | Tauri pause persists across restart; resume wakes current worker | User control incomplete |
| G5 Truthfulness | Non-active vector query reports exact non-applied reason | Fresh score likely below 95 |
| G6 Supersession | New snapshot cannot activate old staging generation; ready reuse retained | Stale semantic answers possible |
| G7 MCP-only | Fresh MCP boot wakes queued work without Tauri | Consumer path incomplete |
| G8 Runtime parity | App/CLI/MCP/worker build + capability + schema + model hashes match | Installed result invalid |
| G9 Performance | Graph p95 within 20% while embedding; memory/WAL bounded | Product unusable under load |
| G10 UI | Graph default, Focus absent, status/actions accurate | Tauri requirement incomplete |
| G11 Installed artifact | DMG install passes native/model/worker/restart smoke | Source-only result |
| G12 Independent score | Fresh Claude and Codex each score 95–100 | Goal not achieved |
| G13–G30 Binding expansion | Every gate in `2026-09-01-penguin-index-truth-developer-intelligence.md` passes on the installed artifact | Expanded master goal not achieved |

## Realistic effort and completion language

This is not a greenfield vector system. SQLite generations/jobs, sqlite-vec, bundled Nomic provider, chunk reuse, resume checkpoints, hybrid search, atomic activation, runtime provisioning, and release gates already exist.

| Work | Estimate |
| --- | ---: |
| Contract + schema + migration separation | 5–7 hours |
| Atomic leases, retry, pause/resume/cancel | 6–9 hours |
| Pipeline enqueue/drain split | 4–6 hours |
| CLI worker + supervisor + MCP wake | 6–9 hours |
| Tauri bridge + Wiki status/control UI + Focus removal | 6–9 hours |
| Fault injection, package gates, DMG, installed verification, Round 21 | 8–12 hours |
| Index truth and developer intelligence binding expansion | 110–170 hours |
| **Total engineering effort** | **145–222 hours, approximately 20–30 focused working days** |

The semantic/fire-and-forget work may be called **source implemented** after Tasks 1–10 compile and focused tests pass. The expanded source may be called **source closed** only after the binding A1–A5 and B1–B11 tasks pass independent review. It may be called **installed candidate** only after the new DMG is installed and manifest/runtime checks pass. It may be called **95–100 complete** only after Task 11 G12 and binding gates G13–G30 pass in two independent fresh MCP-only sessions.

## Explicit non-goals

- No public Penguin Wiki launch in this plan.
- No permanent launchd/systemd service.
- No cloud embedding service or API key requirement.
- No deletion of `WikiSearchPage` or CLI/MCP search capabilities; only the current unused Focus navigation is removed.
- No claim that closing the laptop lid allows CPU work to continue.
- No signing/notarization/public distribution unless separately authorized.
- No broad frontend redesign beyond removing Focus and delivering the semantic worker status/control experience; the larger Graph/Storage visual redesign starts after the 95–100 backend gate.
