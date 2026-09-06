# Penguin Index Truth, Developer Intelligence, and Heavy-Use Reliability Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the installed-artifact index/endpoint correctness failures found by the ccmsrust and Auth evaluations, then add the working-tree, configuration-lineage, impact-verification, diff, analysis-fallback, endpoint-filtering, canonical CLI response, and real Wiki read capabilities required for a genuine 95–100 Penguin MCP experience.

**Architecture:** Phase A first makes repository revision, endpoint publication, mutation coordination, and framework-call evidence deterministic and cache-coherent. Phase B then layers developer intelligence on those truthful primitives: overlays, configuration lineage, graph diff, verification suggestions, bounded analysis fallback, filtered endpoint queries, canonical CLI envelopes, and a provenance-aware Wiki read surface. Graph and lexical facts remain the truth lanes; inferred edges are explicit, scored, and never presented as proven.

**Tech Stack:** TypeScript/Node.js, better-sqlite3, Git CLI, existing Penguin graph/indexer/CLI/MCP contracts, Rust/Tauri, React, Node test runner.

**Spec:** `docs/superpowers/plans/2026-08-31-penguin-semantic-fire-and-forget.md`, the 2026-09-01 ccmsrust/Auth independent evaluation findings, and `/Users/shieng/Desktop/Projects/penguin-index-wiki-audit-2026-09-01.md`.

## Global Constraints

- This plan is a binding part of the current Penguin Knowledge 95–100 master goal; it is not a post-release optional idea list.
- Finish the active launcher/schema safety work before changing overlapping runtime or schema files.
- Penguin Wiki/Knowledge remains private owner-operated infrastructure on this Mac; other users are fresh MCP-only consumers.
- Installed-artifact and fresh-session evidence is mandatory. Source-only tests cannot close a gate.
- Every read result names repo, branch, snapshot/commit, worktree state, freshness, coverage, and evidence status.
- `fresh` means the indexed revision was compared with live Git HEAD for that request; a cached prior comparison cannot prove freshness.
- Parser counts, persisted counts, CLI counts, and MCP counts must reconcile under the same scope/filter contract.
- An unscoped search either fans out across every eligible registered repository with explicit bounds, or returns a typed scope requirement; it must never inspect one repository and claim a complete global result.
- Every CLI `--json` success uses the canonical versioned envelope; legacy shapes, if temporarily supported, are explicitly selected and never silently mixed with canonical output.
- Worktree dirtiness distinguishes indexable source changes, non-indexable untracked files, ignored files, and policy exclusions; a README or project instruction file cannot permanently falsify source freshness.
- Empty results are not truncated. `truncated=true` is allowed only when candidates were actually omitted, with a machine-readable gap and continuation/remediation.
- MCP mutations may remain disabled by default, but typed errors must contain an exact copyable remediation and a queryable job/status path.
- Destructive rebuild/delete/cross-repository operations retain strict confirmation. Convenience changes may only relax ordinary non-destructive incremental indexing.
- Before final acceptance, the real multi-repository corpus rooted at /Users/shieng/Desktop/Projects must pass a guarded full index reset, followed by a complete index and rebuild; an incremental-only run can never close the goal.
- A full reset is owner-only and recoverable: back up the knowledge database and sidecars, preserve source repositories and non-rebuildable notes/operation ledgers, prove the exact reset scope, and verify rollback before deleting rebuildable index data.
- Heavy-use acceptance is mandatory: run burst, sustained-concurrency, soak, resource, race, fault-injection, restart, adversarial-input, and repeatability tests against the real corpus, not only small fixtures or one happy-path query.
- No public launch, signing/notarization, or broad visual redesign is authorized by this plan.
- All shell commands use the repository `rtk` wrapper. Use TDD and independent review for every task.

## Updated 2026-09-01 evaluation delta

`/Users/shieng/penguin-evaluation-report-2026-09-01.md` is an installed
1.16.0 baseline, not proof of the current dirty source tree. Its revised
54/100 score is nevertheless binding regression input. Before the final score,
the same findings must be reproduced or explicitly closed through a fresh
installed MCP runtime:

- A4/G21 must remove the Rust `collect`/`is_empty` and associated `new` false
  edges after a resolver-version re-index; the focused source tests alone do
  not prove the installed database is repaired.
- A5/G22 must scope `get_node`, Explore ambiguity candidates, Domain/Wiki
  traversals, claims, and evidence to one repo plus revision; deduplicate
  relation rows while retaining occurrence counts and provenance.
- A2/B4/G23/G26 must preserve endpoint occurrence provenance, rank production
  handlers above test proto roots, push depth/limit before graph expansion,
  distinguish queue wait from execution timeout, and keep compact results
  bounded and paginated.
- B7/G24 must derive files, endpoints, handlers, technology, and recommended
  commands from canonical scoped APIs and the advertised capability registry;
  no invented `knowledge_*` command or Rust-to-pnpm recommendation is allowed.
- B8/B9/G25/G27 must split fast/deep Doctor and expose coverage failures,
  unresolved references, semantic backlog, dirty files, ignored files, and
  policy exclusions separately; `errors=0` cannot hide known debt.
- B10/G28 must make cwd-first resolution, duplicate-repository candidates,
  help/unknown-command behavior, snapshot/source list contracts, and negative
  search remediation deterministic and bounded.
- B11/G29 must label dead-code results as confidence-ranked candidates and
  suppress active public/framework/trait symbols when absence is not proof.

The installed acceptance score remains closed until these checks pass in two
new MCP-only sessions. No baseline number is promoted to a current claim just
because the source tests are green.

## Binding audit delta — `penguin-index-wiki-audit-2026-09-01.md`

The audit was run against 21 repositories, 21,817 files, and 86,360 symbols
using real symbols plus grep/scoped ground truth. It found 9 bugs, 5 design
limitations, and 6 verified areas. The audit is an acceptance specification,
not permission to dismiss the findings as an old score: each item below must
be reproduced or closed against the final installed artifact through MCP.

| Audit item | Required behavior | Binding work and gate |
| --- | --- | --- |
| B1 unscoped search/callers | Search all eligible repositories under a bounded fan-out, or truthfully expose scope/truncation; `resolveActiveSite` must reconcile 34 scoped hits rather than silently returning 16 from one repo. | A2, B10; G31 |
| B2 domain target ignored | Different targets produce different relevant claims; a nonexistent target returns `insufficient`/no-match evidence, not the same repository dump. | A5, B13; G22, G33 |
| B3 duplicate repo/branch resolution | cwd → live branch/HEAD → explicit repo ID precedence is shared by `files`, `coverage`, `onboarding`, `search`, and MCP; invalid official remediation cannot resolve to an empty wrong branch. | B10; G28, G32 |
| B4 non-code dirty false stale | Indexable changes remain visible; non-indexable untracked files are reported separately and do not make a successful source snapshot permanently stale. | B1, B9; G27, G34 |
| B5/B6 onboarding loss and duplication | Production gRPC/HTTP handlers are ranked as key entry points, entries carry repo/revision ownership, and duplicate endpoint rows collapse with occurrence provenance. | A2, B7; G23, G24 |
| B7 hub ranking pollution | Exclude tests, minified/vendor/bower/public assets from business-hub ranking unless explicitly requested; ranking must retain an explainable filter. | B7, B11; G29 |
| B8 inconsistent CLI JSON | `search`, `endpoints`, `note list`, `files`, `flow`, and `callers` expose one parseable envelope with common counts, cursor, revision, gaps, and exactness. | B12; G32 |
| B9 empty result marked truncated | Correct zero-hit searches return `truncated=false`; only omitted candidates set `truncated=true`. | B10, B12; G31, G32 |
| L1 no Wiki surface | Provide a real read-only target/scoped Wiki answer backed by canonical facts, or do not advertise a nonexistent command/tool. The final plan chooses the former. | B13; G33 |
| L2 guarded index/dry-run UX | Dry-run states targets, files, risk, and token scope; ordinary incremental indexing has a safe short path, while full reset/rebuild/delete/cross-repo confirmation remains one-time and bound to the plan. | A3, B6, C2; G15, G35, G37 |
| L3 coverage always partial | Separate external-package unresolved debt from parser/index failures and calculate denominators from eligible files. | B9; G27, G34 |
| L4 generation latency | Root onboarding, unscoped search, Domain/Wiki, Doctor, and Explore use bounded/pushed-down queries or durable deep jobs; no default path waits until transport timeout. | A5, B4, B8, B10; G22, G25, G26, G35 |
| L5 notes nearly empty | Show note coverage explicitly; when notes are absent, derive only marked symbol facts or report insufficient terminology, never fabricate domain terms. | A5, B7, B13; G22, G24, G33 |

The six verified audit areas—incremental indexing, scoped search, flow
evidence, MCP validation, secret exclusion, and CLI/MCP onboarding parity—are
regression baselines. They do not waive the unscoped, target, ambiguity,
envelope, Wiki, coverage, or latency gates above.

The audit also records an environment trap: the `rtk` hook can replace a
`penguin` invocation with a stub, and `penguin <subcommand> --help` is not a
reliable help path. Final CLI regressions must use the stable absolute owner
CLI path or the packaged launcher, while consumer acceptance must use the
installed MCP process; a shell-wrapper artifact must never be reported as a
product result.

### Implementation checkpoint — 2026-09-01

The working-tree overlay vertical slice is now green in core, CLI, and MCP:
`tests/knowledge-working-tree-overlay.test.mjs` and
`tests/knowledge-mcp-working-tree-overlay.test.mjs` prove modify/add/delete
visibility, immutable exact-worktree revision labels, fingerprint idempotency,
and that the durable branch pointer is unchanged. The installed-artifact gate
and automatic retirement/collection of old overlay snapshots remain open.

### Fresh-session retest checkpoint — 2026-09-01

The current installable checkpoint is documented in
`docs/quality/index-evaluation-checkpoint-b1-20260901.md`. The aarch64 DMG was
verified with `hdiutil verify` and is available at
`src-tauri/target/release/bundle/dmg/Penguin_1.16.0_aarch64.dmg` (SHA-256
`5201cf7128921fae4c52554e38b8707d81539f010dde51a22169caeca21c687d`). The
app-level release gate passed for Tauri startup, embedded CLI, embedded MCP,
stable CLI launcher, and stable MCP launcher: build ID
`1.16.0-e8a4de3a97fde19b`, schema 18, capability hash
`f99fca378bb72ee30313ccc9da98ce4eb353c9b41eff230726186fd16446b67f`, and
model hash `4193e4f88c3f16239a6853400ae2765b4b0903e97c80fcbfd814af24dd2a01e5`.
This checkpoint is intentionally limited to the already-green overlay, scope,
Explore/`get_node`, timeout, and runtime-identity paths; it is not the final
G13–G45 or 95–100 acceptance.

---

## Mandatory full-corpus reset/reindex/rebuild and heavy-use acceptance

This is a user-required internal acceptance gate, not an optional cleanup
exercise. Before a final score is allowed, the real corpus rooted at
/Users/shieng/Desktop/Projects must go through one complete, auditable cycle:

1. Freeze the pre-reset baseline.
2. Export and restore-test every non-rebuildable knowledge asset.
3. Dry-run the exact corpus reset and obtain a one-time confirmation bound to
   this plan, this absolute root, the resolved repo/branch list, and the current
   database instance.
4. Remove all rebuildable index data for every selected repository and branch,
   not only changed files or stale rows.
5. Run a cold full index over the complete corpus.
6. Run the parser-derived rebuild over the complete corpus.
7. Reconcile independent source truth, parser output, persisted rows, CLI
   output, MCP output, and Tauri status.
8. Run the heavy-use, fault, recovery, and repeatability matrix below.
9. Install the resulting artifact and retest from two fresh MCP sessions.

The existing per-repository remove command is not a substitute for this gate.
The implementation must add a guarded corpus operation with an explicit target
root. The canonical operator contract is:

~~~bash
/Users/shieng/.local/bin/penguin index reset --root /Users/shieng/Desktop/Projects --dry-run --json
/Users/shieng/.local/bin/penguin index reset --root /Users/shieng/Desktop/Projects --confirm=<token returned by that dry-run> --json
/Users/shieng/.local/bin/penguin index --root /Users/shieng/Desktop/Projects --full --detach --json
/Users/shieng/.local/bin/penguin rebuild --root /Users/shieng/Desktop/Projects --full --detach --json
/Users/shieng/.local/bin/penguin index-job status --job <job id from the receipt> --json
~~~

The exact token and job ID are runtime values; they must never be hard-coded
into the application or the test report. The installed-path acceptance must
also prove that the same operation cannot be accidentally routed through an
rtk stub or an old partial launcher.

The reset target is every registered repository whose canonical real path is
under /Users/shieng/Desktop/Projects, including all registered branches and
revision snapshots. The dry-run must list repo ID, canonical root, branch,
current HEAD, snapshot, file/symbol/edge/endpoint/semantic-row counts, database
and WAL impact, backup location, excluded roots, and the exact confirmation
scope. Repositories outside this root are untouched and must be reported as
untouched.

The reset may delete only rebuildable source/index data: parser snapshots,
files, symbols, references, graph edges, endpoint projections, coverage
projections, semantic chunks/vectors, generated overlays, and derived caches
belonging to the selected corpus. It must not delete source repositories,
repository registration policy, notes, tags, ontology links, why-memory,
evidence status, saved queries, API-document stores, operation/audit ledgers,
or credentials. If any of these share a database or directory, the export and
restore boundary must be explicit before the reset is enabled.

The pre-reset evidence is immutable: keep a read-only database backup including
SQLite WAL state, a checksum, an independent JSON count snapshot, the resolved
repo/branch registry, and a source-ground-truth manifest. Verify restoration
into a disposable database before the destructive phase. Keep the old database
until the new database passes reconciliation; a failed reset or rebuild must
leave a usable rollback path rather than an empty application.

The reset runner must quiesce watchers, semantic workers, Tauri writers, CLI
writers, and MCP write paths behind one writer fence. It must checkpoint WAL,
record and drain active jobs, assign a reset manifest state to each repository,
and make every phase crash-recoverable. A process exit code of zero is never
enough: a successful full run requires parsed and persisted counts greater than
zero where the source is eligible, durable job completion, current HEAD
matching, and parser/persisted/CLI/MCP reconciliation.

For the real-corpus cycle, record the actual counts at execution time. The
audit's 21 repositories, 21,817 files, and 86,360 symbols are comparison
references, not values that may be copied into a passing report. A count
difference must be explained by a documented corpus or policy change.

The cycle is not complete until two consecutive full rebuilds on the same
revision prove deterministic stable IDs and canonical exports, twenty
no-change index runs prove idempotency, the restored non-rebuildable assets
match their pre-reset hashes, and the installed fresh-session evaluation
passes. The complete load and fault matrix is specified in Tasks C6 and C7 and
Gates G38–G45; it is part of this same reset acceptance, not a later release
task.

## Phase A — Truth and operability blockers

### Task A1: Publish no-op Git revisions and prove live freshness

**Files:**

- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-core/src/git-topology-store.ts`
- Modify: `packages/knowledge-core/src/revision.ts`
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/status-panel.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-index-mode.test.mjs`
- Test: `tests/knowledge-query-scope.test.mjs`
- Create: `tests/knowledge-noop-head-advance.test.mjs`
- Create: `tests/knowledge-installed-freshness.test.mjs`

**Interfaces:**

```ts
interface RevisionTruth {
  repoId: string;
  branchId: string;
  snapshotId: string;
  indexedCommit: string;
  currentHead: string | null;
  worktreeDirty: boolean | null;
  alignment: "aligned" | "head_advanced" | "dirty" | "unknown";
  checkedAt: string;
  revisionGeneration: number;
}
```

- [ ] **Step 1: Add a real Git regression fixture.** Commit A, index it, create commit B with an identical tracked tree, then run incremental index and assert `0 parsed` is allowed but the ready snapshot and branch pointers advance to B.
- [ ] **Step 2: Run the regression and capture the expected failure.**

  ```bash
  rtk test node --test tests/knowledge-noop-head-advance.test.mjs
  ```

- [ ] **Step 3: Publish revision metadata independently of parser work.** A successful no-op file pass creates/publishes the B snapshot, updates `head_commit`, `last_indexed_commit`, `current_snapshot_id`, `last_indexed_at`, and increments one durable `revisionGeneration` in the same transaction.
- [ ] **Step 4: Remove false-fresh cache semantics.** Every freshness/status query reads Git HEAD for the selected repo root at request time. A short cache may memoize Git subprocess output only within one request; it cannot survive across index completion or be used to claim `aligned`.
- [ ] **Step 5: Add installed-runtime regression.** Start a bundled MCP process at A, create/index B with zero parsed files, query `index_status` through the same and a new MCP process, and require B/aligned from both.
- [ ] **Step 6: Preserve historical revision selectors.** After A → identical-tree B publication, resolve ready snapshot A by both `snapshotId=A` and `commitSha=A` within the same repo, and prove A's files/symbols remain readable. Reject cross-repo snapshot IDs. Historical explicit selectors are not current-checkout `aligned`.
- [ ] **Step 7: Keep request-time freshness affordable.** Read branch, OID, and dirty state with one Git invocation per repo (for example porcelain v2 branch status), with request-local memoization only. Multi-repo status tests count invocations instead of relying on fragile wall-clock thresholds.
- [ ] **Step 8: Run focused gates.**

  ```bash
  rtk test node --test tests/knowledge-noop-head-advance.test.mjs tests/knowledge-installed-freshness.test.mjs tests/knowledge-query-scope.test.mjs tests/knowledge-status-panel.test.mjs tests/knowledge-index-mode.test.mjs
  ```

**Exit gate:** no command or MCP response may claim fresh/aligned while Auth HEAD is `801905b` and the selected snapshot still reports `055c37d`; ready historical revisions remain queryable by repo-scoped snapshot/commit selectors; each repo freshness probe uses one Git invocation per request.

### Task A2: Reconcile parser, persistence, endpoint inventory, CLI, and MCP

**Files:**

- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-indexer/src/routes.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/target-resolution.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-endpoint-identity.test.mjs`
- Test: `tests/knowledge-surface-parity-e2e.test.mjs`
- Test: `tests/knowledge-pagination-contract.test.mjs`
- Test: `tests/knowledge-target-resolution.test.mjs`
- Create: `tests/knowledge-endpoint-publication-parity.test.mjs`

**Interfaces:**

```ts
interface EndpointInventoryFilter {
  repo?: string;
  branch?: string;
  snapshotId?: string;
  protocol?: string;
  service?: string;
  method?: string;
  path?: string;
  handledOnly?: boolean;
  provenanceKind?: "definition" | "client" | "handler" | "test";
  limit: number;
  cursor?: string;
}

interface EndpointOccurrence {
  endpointId: string;
  provenanceKind: "definition" | "client" | "handler" | "test";
  repoId: string;
  snapshotId: string;
  commitSha: string;
  filePath: string;
  startLine: number | null;
  handlerNodeId: string | null;
}

interface EndpointPublicationReceipt {
  discovered: number;
  persisted: number;
  queryable: number;
  excluded: Array<{
    endpointId?: string;
    discoveryKey: string;
    reasonCode: string;
    candidateEndpointIds: string[];
    provenance: { filePath: string; startLine?: number };
  }>;
  totalIsExact: boolean;
}
```

- [ ] **Step 1: Add the Auth fixture.** Index `VersionController.version()`, injected `VersionService.version()`, and gRPC `VersionService.Version`; assert the parser, persisted endpoint rows, CLI `endpoints`, MCP `knowledge_endpoints`, and exact `Service.Method` resolver return the same endpoint ID.
- [ ] **Step 2: Compare like-for-like counts and fail on real drift.** Preserve the verified protocol identity `276 all = 267 gRPC + 9 HTTP`; never compare an unfiltered discovery total with a gRPC-only inventory. For one identical repo/revision/filter, every discovered endpoint must be queryable or appear in a named exclusion with provenance and candidate endpoint IDs. In particular, an unqualified `VersionService.Version` that is ambiguous between `CMS.VersionService.Version` and `player.VersionService.Version` must be reported as an explicit exclusion instead of silently counted as persisted.
- [ ] **Step 3: Centralize one endpoint filter and occurrence model.** CLI, MCP, affected, Architecture, Onboarding, publication receipts, compact/full views, and pagination all consume `EndpointInventoryFilter` plus canonical `EndpointOccurrence`; cursor fingerprints include every filter field. `handledOnly=true` means a proven handler occurrence, not merely a parser hit. Definitions, clients, handlers, and tests remain separately queryable and are never collapsed into one misleading occurrence count.
- [ ] **Step 4: Add direct filtering and provenance tests.** Verify `service=VersionService`, `method=Version`, `path=libs/tools/src/version`, `handledOnly=true`, and every `provenanceKind` return bounded payloads and preserve exact totals. Production flow root selection is deterministic: proven handler first, then production definition, then client, then test; the selected root and rejected candidates are reported.
- [ ] **Step 5: Add installed CLI/MCP parity replay.** Run both transports against the installed runtime and compare canonical endpoint IDs, revision envelope, counts, and filters.
- [ ] **Step 6: Run focused gates.**

  ```bash
  rtk test node --test tests/knowledge-endpoint-identity.test.mjs tests/knowledge-endpoint-publication-parity.test.mjs tests/knowledge-surface-parity-e2e.test.mjs tests/knowledge-pagination-contract.test.mjs
  ```

**Exit gate:** for identical repo/revision/protocol filters, every endpoint announced by rebuild is queryable or appears in a named exclusion with provenance; all-protocol totals equal the sum of protocol-specific totals; `VersionService.Version` resolves identically through CLI and MCP or returns the same typed ambiguity with candidates through both transports; endpoint totals and flow roots cannot mix definition/client/handler/test occurrences.

### Task A3: Serialize index mutations and expose durable job status

**Files:**

- Create: `packages/knowledge-core/src/index-job-store.ts`
- Create: `packages/knowledge-cli/src/index-supervisor.ts`
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/embedding-lifecycle.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-indexer/src/watcher.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src/components/wiki/IndexProgressBanner.tsx`
- Modify: `src/components/wiki/WikiOnboarding.tsx`
- Test: `tests/knowledge-index-progress.test.mjs`
- Create: `tests/knowledge-index-job-coordinator.test.mjs`
- Create: `tests/knowledge-index-recovery-scenarios.test.mjs`

**Interfaces:**

```ts
type IndexJobState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

interface IndexJobStatus {
  jobId: string;
  rootPath: string;
  repoId: string | null;
  branchId: string | null;
  operation: "index" | "rebuild";
  state: IndexJobState;
  desiredState: "running" | "paused" | "cancelled";
  phase: "admission" | "scan" | "index" | "publish" | "maintenance";
  ownerBuildId: string | null;
  ownerProcessIdentity: {
    pid: number;
    ppid: number;
    pgid: number;
    startIdentity: string;
  } | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  publishedAt: string | null;
  resumeStrategy: "checkpoint" | "restart_operation";
  filesTotal: number | null;
  filesProcessed: number;
  estimatedRemainingMs: number | null;
  stateVersion: number;
  error: { code: string; message: string; remediation: string } | null;
}
```

- [ ] **Step 1: Write two-process contention tests.** Start Auth rebuild and ccmsrust index concurrently. Require two durable job IDs, truthful queued/running states, no raw `database is locked`, and exactly one global `knowledge.db` writer owner even though the jobs target different repos/branches.
- [ ] **Step 2: Add an independent durable control store.** Persist jobs, append-only events, desired state, progress, complete process identity, heartbeat, lease expiry, publication receipt, and terminal error in a sidecar `index-jobs.db`, not in `knowledge.db`. Enqueue/status/control must remain available while rebuild holds `BEGIN IMMEDIATE` on the data DB. Unknown ownership fails closed; expired ownership is reclaimable only when PID/start identity proves the owner dead.
- [ ] **Step 3: Add one global mutation supervisor.** CLI, MCP, Tauri, and watcher all enqueue through the same current-version worker. It serializes every `knowledge.db` writer, quiesces semantic claims, executes the job, verifies COMMIT plus branch/snapshot readback, releases the writer fence, then wakes semantic work. Keep the old branch marker for one compatibility cycle, but it is not the scheduling authority.
- [ ] **Step 4: Add cooperative pause/resume semantics.** Never use `SIGSTOP` while a process may hold a SQLite write lock. Queued jobs pause immediately. Incremental jobs pause at a committed file checkpoint and resume from that checkpoint. Rebuild pause performs a controlled rollback and records `resumeStrategy=restart_operation`; resume restarts that rebuild until a future shadow-generation design can make it resumable. A `resumed` transition is an append-only event followed by queued/running, not a transient durable state.
- [ ] **Step 5: Expose status and control everywhere.** Preserve the existing repo-freshness `index_status` ABI. Add `penguin index-job status|pause|resume|cancel --job <id> --json` and a separate canonical MCP `knowledge_index_job_status`; `penguin index/rebuild` keeps wait-by-default compatibility while `--detach` returns immediately. Tauri returns a receipt, reconnects to active jobs after restart, and the Wiki progress UI renders queued/running/paused/failed/completed with pause/resume controls from durable status; events only accelerate refresh.
- [ ] **Step 6: Improve disabled-mutation remediation.** `MUTATION_DISABLED` includes the exact safe CLI command, repo path, required confirmation behavior, detach/status commands, and job lookup; it never exposes only an error code.
- [ ] **Step 7: Run crash, PID-reuse, watcher-storm, semantic coexistence, pause/resume, publication-failure, restart, and contention gates.**

  ```bash
  rtk test node --test tests/knowledge-index-job-coordinator.test.mjs tests/knowledge-index-progress.test.mjs tests/knowledge-index-recovery-scenarios.test.mjs tests/knowledge-launcher.test.mjs
  ```

**Exit gate:** concurrent index/rebuild requests from any repos are durably queued behind one global writer; users never receive an unexplained SQLite lock error; app/CLI restarts preserve control/status; pause never leaves a write lock or partial live snapshot; a job becomes completed only after COMMIT and branch/snapshot readback succeed.

### Task A4: Close Auth method-call and affected endpoint/test evidence

**Files:**

- Modify: `packages/knowledge-indexer/src/framework-edges.ts`
- Modify: `packages/knowledge-indexer/src/resolve.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-core/src/dispatch-resolution.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Test: `tests/knowledge-nestjs-affected.test.mjs`
- Test: `tests/knowledge-affected.test.mjs`
- Create: `tests/knowledge-auth-version-flow.test.mjs`
- Create: `tests/knowledge-rust-trait-dispatch.test.mjs`
- Create: `tests/knowledge-rust-receiver-negative-cases.test.mjs`

**Interfaces:**

```ts
interface DispatchHop {
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: "calls" | "injects" | "implements" | "dispatches_to";
  evidenceState: "proven" | "inferred" | "candidate" | "unresolved";
  provenance: { filePath: string; startLine?: number };
  gaps: string[];
}
```

- [ ] **Step 1: Add the exact Auth flow and counterexample tests.** Require `gRPC VersionService.Version → VersionController.version() → VersionService.version() → VersionPb.VersionRes`, while keeping constructor injection distinct from the method call. Prove that `this.otherService.version()` cannot bind to `VersionService.version()`, and that two imported `version()` methods are disambiguated only by a proven constructor property-name-to-type binding.
- [ ] **Step 2: Add Rust trait/interface dispatch and exact false-edge fixtures.** Preserve the proven AST call site separately from implementation candidates. A concrete statically proven receiver may produce a proven target; trait/interface dynamic dispatch remains candidate even when the current index sees only one implementation; multiple implementations remain separate candidates; runtime observation may upgrade evidence only for the matching revision and environment. Golden negatives must prove that `games.into_iter().collect()` never resolves to an unrelated local `fn collect`, and `String::is_empty`/`Vec::is_empty` never resolve to an unrelated `TemplateChannels::is_empty` merely because names match.
- [ ] **Step 3: Persist receiver-aware method calls and invalidate old wrong edges.** Retain constructor property name → type identity, parse NestJS `controllers` as well as `providers`, resolve `this.versionService.version()` through that binding, retain receiver plus source line, and write revision-scoped `dispatches_to` evidence. Imported-file or global same-name uniqueness alone cannot make a receiver target proven. Bump the resolver identity/version so re-indexing removes historical false edges instead of leaving old `collect`/`is_empty` relations queryable.
- [ ] **Step 4: Expand affected evidence without inventing tests.** Controller changes return the declared endpoint, outgoing service/module/provider dependencies, incoming impacted callers, related test files when proven, suggested verification commands, and exact/unknown totals. Keep `dependencies` distinct from `impacted`. For the current Auth fixture, no direct test file is indexed, so the truthful result is `relatedTests=[]`, `totalIsExact=false`, plus suggested commands—not a fabricated test association. `routes: 0` is invalid once A2 has published a scoped endpoint/typed ambiguity with evidence.
- [ ] **Step 5: Run focused gates.**

  ```bash
  rtk test node --test tests/knowledge-auth-version-flow.test.mjs tests/knowledge-rust-trait-dispatch.test.mjs tests/knowledge-rust-receiver-negative-cases.test.mjs tests/knowledge-nestjs-affected.test.mjs tests/knowledge-affected.test.mjs tests/knowledge-flow-edge-evidence.test.mjs
  ```

**Exit gate:** an MCP-only evaluator obtains the complete Auth Version flow, with receiver-aware dispatch confidence and affected endpoint/dependency evidence, without source/grep fallback; absent tests are explicitly reported as absent/incomplete with suggested verification rather than invented; the two reproduced Rust false edges are absent after a resolver-version re-index and dynamic dispatch stays explicitly candidate/unresolved when the receiver cannot prove a target.

### Task A5: Make Domain and Wiki graph answers revision-scoped and contamination-free

**Files:**

- Modify: `packages/knowledge-core/src/domain-model.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Create: `tests/knowledge-domain-scope.test.mjs`
- Create: `tests/knowledge-domain-dedup.test.mjs`

**Interfaces:**

```ts
interface DomainQueryEnvelope {
  repoId: string;
  snapshotId: string;
  commitSha: string;
  targetNodeId: string;
  maxDepth: number;
  limit: number;
}

interface DomainClaim {
  claimId: string;
  text: string;
  evidenceState: "proven" | "inferred" | "candidate" | "insufficient";
  evidence: Array<{ repoId: string; snapshotId: string; nodeId: string; filePath: string; startLine?: number }>;
  duplicateCount: number;
  gaps: string[];
}
```

- [ ] **Step 1: Reproduce the report's pollution and target blindness.** Create two repos with same-named symbols plus duplicate graph edges; run two different Domain/Wiki targets, including a guaranteed nonexistent target, and prove the current answer leaks an out-of-envelope repo, repeats a claim, or returns the same repository dump for every target.
- [ ] **Step 2: Bind every traversal to one revision envelope.** Resolve target first, then require every traversed node, edge, claim, and evidence item to match `repoId + snapshotId/commitSha`. Reject target IDs outside the envelope with a typed scope error; never silently fall back to another repo or revision.
- [ ] **Step 3: Add stable semantic deduplication.** Deduplicate canonical edge/claim identities before rendering while retaining `duplicateCount` and source provenance. Repeated index rows cannot multiply the same domain statement.
- [ ] **Step 4: Make uncertainty explicit.** Empty or incomplete evidence returns `insufficient` plus coverage/gaps. Domain prose cannot upgrade an inferred relationship to a source fact.
- [ ] **Step 5: Bound the traversal.** Push repo/revision/depth/limit into the query layer before graph expansion; test warm p95 under 10 seconds and a compact response under 100 KB for the report fixture.
- [ ] **Step 6: Run focused gates.**

  ```bash
  rtk test node --test tests/knowledge-domain-model.test.mjs tests/knowledge-domain-scope.test.mjs tests/knowledge-domain-dedup.test.mjs tests/knowledge-query-scope.test.mjs
  ```

**Exit gate:** Domain and Wiki answers contain only the selected repo/revision, have stable non-duplicated claims with provenance, expose insufficiency instead of fabrication, and complete within the bounded latency/payload contract.

---

## Phase B — Developer intelligence

### Task B1: Add revision-scoped working-tree overlays

**Files:**

- Create: `packages/knowledge-core/src/working-tree-overlay.ts`
- Modify: `packages/knowledge-core/src/revision-view.ts`
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Create: `packages/knowledge-indexer/src/working-tree-overlay.ts`
- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Create: `tests/knowledge-working-tree-overlay.test.mjs`
- Create: `tests/knowledge-mcp-working-tree-overlay.test.mjs`

**Interfaces:**

```ts
interface WorkingTreeOverlayStatus {
  repoId: string;
  branchId: string;
  baseSnapshotId: string;
  snapshotId: string;
  commitSha: string | null;
  worktreeFingerprint: string;
  state: "clean" | "dirty" | "unknown" | "not_applicable";
  applied: boolean;
  modifiedPaths: string[];
  addedPaths: string[];
  deletedPaths: string[];
  untrackedPaths: string[];
  generatedPaths: string[];
  gaps: string[];
}
```

- [x] **Step 1: Write dirty-worktree tests.** Modify, add, and delete files without committing or full indexing; context/flow/affected/search must reflect the overlay and label every overlay fact. Core, CLI, and MCP coverage are green.
- [x] **Step 2: Store overlays separately from ready snapshots.** Overlay rows key by repo, branch, base commit, worktree fingerprint, file path, and parser version. They never mutate immutable ready revision facts.
- [x] **Step 3: Merge at revision-view time.** Overlay deletes suppress base facts, modified files replace base file facts, and untracked/generated facts remain visibly tagged.
- [ ] **Step 4: Invalidate deterministically.** Commit, checkout, re-index, or fingerprint change retires the old overlay; stale overlay facts can never leak into another branch.
- [x] **Step 5: Run overlay and revision gates.** Core, CLI, MCP, revision-view, query-scope, and affected focused suites pass.

  ```bash
  rtk test node --test tests/knowledge-working-tree-overlay.test.mjs tests/knowledge-revision-view.test.mjs tests/knowledge-query-scope.test.mjs tests/knowledge-affected.test.mjs
  ```

**Exit gate:** Claude/Codex can inspect a current uncommitted change without an immediate full index and can distinguish HEAD from working-tree evidence.

### Task B2: Model environment, Vault, configuration, constructor, and runtime flow

**Files:**

- Create: `packages/knowledge-indexer/src/config-lineage.ts`
- Create: `packages/knowledge-core/src/config-flow.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Create: `tests/knowledge-config-lineage.test.mjs`

**Interfaces:**

```ts
type ConfigurationHopKind = "environment" | "vault" | "config_field" | "mapping" | "constructor_argument" | "runtime_branch" | "consumer";

interface ConfigurationLineageHop {
  kind: ConfigurationHopKind;
  key: string;
  nodeId: string | null;
  evidenceState: "proven" | "inferred" | "candidate" | "unresolved";
  provenance: { filePath: string; startLine?: number } | null;
  gaps: string[];
}
```

- [ ] **Step 1: Add the ccmsrust Redis fixture.** Query `REDIS_ISCLUSTER3` and require the complete Vault/env → config mapping → `AppConfig` → `PlayerKv::new` → `RedisConn::Cluster` → consumer chain.
- [ ] **Step 2: Extract configuration identities.** Parse environment reads, Vault mapping declarations, struct/object fields, deserialization aliases, constructor arguments, and guarded runtime branches.
- [ ] **Step 3: Persist explicit config edges.** Store revision-scoped hops with provenance and evidence state; secret values are never stored.
- [ ] **Step 4: Add `config-flow` transport parity.** CLI and MCP use one input/output contract and support exact key, repo, branch, path, and cursor filters.
- [ ] **Step 5: Run privacy and flow gates.**

  ```bash
  rtk test node --test tests/knowledge-config-lineage.test.mjs tests/knowledge-flow-edge-evidence.test.mjs tests/knowledge-surface-parity-e2e.test.mjs
  ```

**Exit gate:** configuration-to-runtime answers are evidence-backed and contain no secret values.

### Task B3: Add diff graph and verification recommendations

**Files:**

- Create: `packages/knowledge-core/src/graph-diff.ts`
- Create: `packages/knowledge-core/src/verification-recommendations.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Create: `tests/knowledge-diff-graph.test.mjs`
- Create: `tests/knowledge-verification-recommendations.test.mjs`

**Interfaces:**

```ts
interface GraphDiffResponse {
  base: RevisionTruth;
  head: RevisionTruth;
  nodes: { added: string[]; removed: string[]; changed: string[] };
  edges: { added: DispatchHop[]; removed: DispatchHop[] };
  endpoints: { added: string[]; removed: string[]; changed: string[] };
  configuration: { added: string[]; removed: string[]; changed: string[] };
  tests: { added: string[]; removed: string[]; affected: string[] };
  completeness: "exact" | "lower_bound";
  gaps: string[];
}

interface VerificationRecommendation {
  command: string;
  reason: string;
  evidence: Array<{ filePath: string; startLine?: number; nodeId?: string }>;
  confidence: number;
}
```

- [ ] **Step 1: Add `HEAD`, `main...HEAD`, and working-tree diff fixtures.** Verify node, edge, endpoint, config, and test additions/removals are revision-correct.
- [ ] **Step 2: Implement immutable-revision diff.** Compare canonical node/edge identities between two revision views; never diff display text.
- [ ] **Step 3: Generate bounded verification commands.** Use workspace manifests, ownership boundaries, changed symbols, affected crates/packages, and indexed test relations. Every command includes evidence and can be omitted when unproven.
- [ ] **Step 4: Add CLI/MCP parity.** Support `penguin diff HEAD`, `penguin diff main...HEAD`, `penguin affected --git-diff`, and canonical MCP inputs.
- [ ] **Step 5: Run diff and recommendation gates.**

  ```bash
  rtk test node --test tests/knowledge-diff-graph.test.mjs tests/knowledge-verification-recommendations.test.mjs tests/knowledge-affected.test.mjs tests/knowledge-surface-parity-e2e.test.mjs
  ```

**Exit gate:** affected answers connect the change to a small, evidence-backed verification plan without claiming commands that the graph cannot justify.

### Task B4: Make analysis deterministic, bounded, and query-efficient

**Files:**

- Modify: `packages/mcp/src/repository-analysis.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-core/src/search-engine.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Create: `tests/knowledge-analysis-fallback.test.mjs`
- Create: `tests/knowledge-endpoint-filtering.test.mjs`

**Interfaces:**

```ts
interface AnalysisFallbackTrace {
  attempted: Array<"exact" | "search" | "explore" | "file_symbols" | "config_flow">;
  selected: string | null;
  elapsedMs: number;
  resultCount: number;
  timeoutStage: string | null;
  gaps: string[];
}
```

- [ ] **Step 1: Add Redis and Auth natural-language regressions.** Queries that deterministic search/explore can answer must not return `No indexed symbol or note matched`.
- [ ] **Step 2: Implement bounded fallback.** Run exact target resolution, then scoped deterministic search, explore top exact candidates, file symbols, and config flow when relevant. Stop on a sufficient exact result; record the trace. Apply per-stage deadlines and report `timeoutStage` rather than allowing one slow stage to consume the whole request.
- [ ] **Step 3: Push bounds into retrieval.** Apply repo/revision/path/depth/limit in SQL and BFS before aggregation, not after assembling a full graph. Add a revision-keyed one-hop adjacency cache with explicit invalidation after publication; it may optimize a truthful scope but never broaden it.
- [ ] **Step 4: Enforce payload budgets.** Endpoint, Explore, and analysis operations default to paginated compact envelopes with per-section budgets. A request cannot return hundreds of kilobytes unless the caller explicitly paginates through it.
- [ ] **Step 5: Run latency and payload gates.** Auth Explore at depth 1/limit 20 must have warm p95 below 5 seconds; the full bounded operation must not hit the report's 25–30 second hard timeout; default compact payload is below 100 KB.

  ```bash
  rtk test node --test tests/knowledge-analysis-fallback.test.mjs tests/knowledge-endpoint-filtering.test.mjs tests/knowledge-context-truncation.test.mjs tests/knowledge-pagination-contract.test.mjs
  ```

**Exit gate:** the two evaluation queries return useful scoped results with a bounded payload and an explicit fallback trace; Auth Explore cannot reproduce the 25–30 second timeout and reports the exact timed-out stage if a budget is exceeded.

### Task B5: Expose provenance and freshness in Wiki without redesigning the graph

**Files:**

- Modify: `src/components/wiki/WikiPage.tsx`
- Modify: `src/components/wiki/WikiStatusFooter.tsx`
- Modify: `src/components/wiki/WikiStoragePage.tsx`
- Modify: `src/lib/knowledge-client.ts`
- Create: `tests/knowledge-wiki-provenance-ui.test.mjs`

**Interfaces:**

```ts
interface WikiProvenanceStatus {
  repo: string;
  branch: string;
  indexedCommit: string;
  currentHead: string | null;
  worktree: "clean" | "dirty" | "unknown";
  overlayApplied: boolean;
  lastIndexedAt: string;
  lastCheckedAt: string;
  freshness: "aligned" | "stale" | "dirty" | "unknown";
}
```

- [ ] **Step 1: Add UI contract tests.** Show branch, indexed commit, current HEAD, worktree/overlay state, last index/check time, coverage, and stale reason.
- [ ] **Step 2: Label evidence.** File:line, source fact, inferred/candidate, and unresolved gaps use the canonical evidence envelope.
- [ ] **Step 3: Keep the UI truthful during jobs.** The active job/status card links to the affected repo and never marks results fresh before publication completes.
- [ ] **Step 4: Run UI and type gates.**

  ```bash
  rtk test node --test tests/knowledge-wiki-provenance-ui.test.mjs tests/knowledge-wiki-semantic-status-ui.test.mjs tests/knowledge-index-progress.test.mjs
  rtk test pnpm typecheck
  ```

**Exit gate:** the local owner can see exactly which revision and worktree produced every Wiki result.

### Task B6: Preserve safety while simplifying ordinary incremental index UX

**Files:**

- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Test: `tests/knowledge-index-mode.test.mjs`
- Create: `tests/knowledge-index-confirmation-policy.test.mjs`

**Interfaces:**

```ts
type IndexRiskClass = "incremental_non_destructive" | "delete" | "rebuild" | "cross_repo";
```

- [ ] **Step 1: Add confirmation-policy tests.** Ordinary current-repo incremental index can use `penguin index --changed --confirm`; the dry-run prints repo/root/branch, current and target revisions, indexable/ignored/non-indexable paths, risk class, and a single-use token bound to that exact plan. Delete, rebuild, and cross-repo plans still require that token and reject reuse, expiry, path changes, branch changes, or token derivation from command text alone.
- [ ] **Step 2: Centralize risk classification.** CLI, MCP remediation, Tauri, and docs consume the same `IndexRiskClass` decision.
- [ ] **Step 3: Reject ambiguous shortcuts.** `--changed` outside a registered cwd repo or with a branch mismatch fails with typed remediation.
- [ ] **Step 4: Run mutation-safety gates.**

  ```bash
  rtk test node --test tests/knowledge-index-confirmation-policy.test.mjs tests/knowledge-index-mode.test.mjs tests/knowledge-mutation-auth.test.mjs
  ```

**Exit gate:** daily incremental indexing is one safe command; destructive operations are not weakened.

### Task B7: Generate Onboarding from canonical facts and executable commands

**Files:**

- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/status-panel.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Create: `tests/knowledge-onboarding-canonical.test.mjs`

- [ ] **Step 1: Reproduce all report failures.** Assert files are not doubled, canonical endpoint/handler totals are non-zero when handlers exist, gRPC production handlers outrank HTTP health checks and test/proto roots, every endpoint includes repo/revision ownership, high-connection rankings exclude `*.spec.*`, `*.min.*`, `bower_components`, generated, and public vendor assets by default, a Rust repository never receives a `pnpm` primary command, and every recommended MCP/CLI command is present in the advertised capability/help registry.
- [ ] **Step 2: Use canonical inventory providers.** Onboarding consumes the same scoped file, endpoint occurrence, coverage, repo/revision, and semantic status APIs as MCP; it cannot recompute or concatenate competing totals.
- [ ] **Step 3: Validate technology and commands.** Detect Cargo/npm/pnpm/workspace evidence from revision-scoped manifests, rank commands by proven toolchain, and omit recommendations that cannot be parsed and resolved by the current installed CLI/MCP capability registry.
- [ ] **Step 4: Run transport and installed-output gates.**

  ```bash
  rtk test node --test tests/knowledge-onboarding-canonical.test.mjs tests/knowledge-why-memory-ontology.test.mjs tests/knowledge-surface-parity-e2e.test.mjs
  ```

**Exit gate:** Onboarding reports one canonical file/handler count, correct repository technology, and only copyable installed commands; it passes the report fixture without duplicate files, false zero endpoints, Rust/pnpm confusion, or invented MCP names.

### Task B8: Split Doctor into bounded fast health and explicit deep diagnostics

**Files:**

- Modify: `packages/knowledge-core/src/status-panel.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Create: `tests/knowledge-doctor-latency.test.mjs`

**Interfaces:**

```ts
interface DoctorStageResult {
  stage: string;
  status: "pass" | "warn" | "fail" | "skipped";
  elapsedMs: number;
  remediation: string | null;
}
```

- [ ] **Step 1: Add an installed-size fixture.** Reproduce MCP Doctor timing out while CLI Doctor eventually returns.
- [ ] **Step 2: Define one fast default.** CLI and MCP default to metadata/schema/runtime/revision/job/semantic summary checks with identical stage definitions and no full-table scan. Return stage timings and an explicit `deepAvailable=true` hint.
- [ ] **Step 3: Keep deep work opt-in.** `deep=true` performs integrity/coverage scans asynchronously or under an explicit larger budget and exposes job/progress when it cannot finish inline.
- [ ] **Step 4: Run parity and latency gates.** Fast Doctor p95 must be below 15 seconds on the installed evaluation DB and cannot hit transport timeout; CLI/MCP statuses and stage names must match. The final fixture also requires scoped search/callers p95 below 2 seconds, bounded unscoped search p95 below 5 seconds, Domain/Wiki p95 below 8 seconds, and onboarding p95 below 10 seconds; deep work must become a durable job before those budgets are exceeded.

  ```bash
  rtk test node --test tests/knowledge-doctor-latency.test.mjs tests/knowledge-mcp-tools.test.mjs tests/knowledge-status-panel.test.mjs tests/knowledge-surface-parity-e2e.test.mjs
  ```

**Exit gate:** a fresh MCP-only session receives a useful fast Doctor result before timeout, while expensive diagnostics remain explicit, observable, and non-blocking.

### Task B9: Expose coverage, semantic backlog, dirty state, and index errors as first-class truth

**Files:**

- Modify: `packages/knowledge-core/src/status-panel.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `src/components/wiki/WikiStatusFooter.tsx`
- Create: `tests/knowledge-status-truth.test.mjs`

**Interfaces:**

```ts
interface KnowledgeTruthDebt {
  indexErrors: number;
  coverageFailures: number;
  unresolvedReferences: number;
  semanticPending: number;
  dirtyFiles: number | null;
  ignoredByGit: number;
  excludedByPolicy: number;
  effectiveCoverage: { indexed: number; eligible: number; totalIsExact: boolean };
}
```

- [ ] **Step 1: Add truthful denominator fixtures.** Git-ignored files and non-indexable untracked files are shown separately and removed from the effective eligible denominator; `CLAUDE.md`, README, lockfile-only, generated, and policy-excluded paths cannot permanently make a source snapshot stale; policy exclusions, external-package unresolved references, parser failures, and index failures remain separately visible.
- [ ] **Step 2: Stop hiding failure under `errors=0`.** Status and index receipts expose parse/index errors, coverage failures, unresolved references split by owned-parser versus external-package debt, semantic queued/running/superseded counts, indexable dirty files, ignored files, non-indexable dirty files, and policy exclusions in one revision envelope. A successful source index may be `aligned` with non-blocking external dependency debt, but never with an owned parse/index failure hidden behind `errors=0`.
- [ ] **Step 3: Make UI/CLI/MCP consume one contract.** Every surface uses the same labels, counts, exactness, and remediation; green health is impossible when a blocking debt is non-zero.
- [ ] **Step 4: Run focused gates.**

  ```bash
  rtk test node --test tests/knowledge-status-truth.test.mjs tests/knowledge-status-panel.test.mjs tests/knowledge-coverage.test.mjs tests/knowledge-semantic-status.test.mjs
  ```

**Exit gate:** evaluators can distinguish parser success from coverage completeness and semantic readiness; ignored files no longer inflate a misleading failure percentage, and `errors=0` cannot conceal known debt.

### Task B10: Make CLI discovery and duplicate-repository resolution deterministic

**Files:**

- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/repo-registry.ts`
- Create: `tests/knowledge-cli-help-contract.test.mjs`
- Create: `tests/knowledge-repo-ambiguity-latency.test.mjs`

- [ ] **Step 1: Generate help from the command registry.** Top-level help, subcommand help, unknown-command errors, JSON errors, exit codes, and advertised capabilities derive from one registry and are snapshot-tested.
- [ ] **Step 2: Rank cwd scope before global ambiguity and define unscoped fan-out.** Resolve exact registered root → live branch/HEAD → repo ID before considering same-named repositories elsewhere. When ambiguity remains, return bounded candidates containing repoId/root/branch/indexed commit/current HEAD. For an unscoped `search` or `callers`, fan out across every eligible registered repository in parallel with a per-repo limit and global budget; if the budget or registry is incomplete, return `truncated=true`, `totalIsExact=false`, and explicit gaps instead of one site's `truncated=false` result.
- [ ] **Step 3: Keep ambiguity fast and honest.** Duplicate-name resolution uses indexed registry keys rather than scanning every repository; warm response under the report fixture is below 100 ms and never silently selects another checkout. `files`, `coverage`, and `onboarding` reuse the same resolver, and the official repoId remediation must resolve the intended 1,583-file snapshot rather than an empty branch.
- [ ] **Step 4: Run CLI gates.**

  ```bash
  rtk test node --test tests/knowledge-cli-help-contract.test.mjs tests/knowledge-repo-ambiguity-latency.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-query-scope.test.mjs
  ```

**Exit gate:** CLI help is internally consistent, cwd queries prefer the actual checkout, and duplicate repo names return fast typed ambiguity rather than slow or wrong answers.

### Task B11: Make dead-code output confidence-ranked rather than declarative

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/graph-query.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Create: `tests/knowledge-deadcode-confidence.test.mjs`

**Interfaces:**

```ts
interface DeadCodeCandidate {
  nodeId: string;
  confidence: "high" | "medium" | "low" | "insufficient";
  supportingSignals: string[];
  suppressingSignals: string[];
  limitations: string[];
}
```

- [ ] **Step 1: Add active-public counterexamples.** Public APIs, trait implementations, dependency-injected/framework entry points, endpoint handlers, and test-referenced symbols must be down-ranked or excluded when reachability is incomplete. Include `PlayerKv` and `MaintenanceOps` report examples.
- [ ] **Step 2: Return candidates, not verdicts.** Explain missing incoming edges, exported/public status, framework registrations, dynamic dispatch gaps, coverage, and revision scope; never label a symbol definitely dead from absence alone.
- [ ] **Step 3: Run confidence and pagination gates.**

  ```bash
  rtk test node --test tests/knowledge-deadcode-confidence.test.mjs tests/knowledge-evidence-contract.test.mjs tests/knowledge-pagination-contract.test.mjs
  ```

**Exit gate:** dead-code results are review candidates with evidence and limitations; active public/framework symbols from the evaluation are not presented as high-confidence dead code.

### Task B12: Standardize the CLI JSON envelope and negative-result semantics

**Files:**

- Modify: `packages/knowledge-contracts/src/response.ts`
- Modify: `packages/knowledge-contracts/src/search.ts`
- Modify: `packages/knowledge-contracts/src/surface.ts`
- Modify: `packages/knowledge-contracts/src/errors.ts`
- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `packages/knowledge-cli/src/render-progress.ts`
- Modify: `packages/mcp/src/result-text.ts`
- Create: `tests/knowledge-cli-envelope.test.mjs`
- Create: `tests/knowledge-negative-search.test.mjs`

**Interfaces:**

- Consumes `RevisionTruth` from Task A1 and the typed `KnowledgeErrorEnvelope` contract from `packages/knowledge-contracts/src/errors.ts`.
- Produces the canonical envelope consumed by CLI renderers, MCP projections, B13 Wiki queries, and the final installed evaluator.

```ts
interface KnowledgeQueryMeta {
  returnedCount: number;
  candidateCount: number | null;
  totalIsExact: boolean;
  truncated: boolean;
  cursor: { next: string | null; exhausted: boolean };
  revision: RevisionTruth | null;
  gaps: string[];
}

interface KnowledgeCliEnvelope<T> {
  schemaVersion: 1;
  command: string;
  data: T | null;
  meta: KnowledgeQueryMeta;
  error: KnowledgeErrorEnvelope | null;
}
```

- [ ] **Step 1: Capture the current incompatible shapes as failing contract tests.** Invoke `search`, `endpoints`, `note list`, `files`, `flow`, and `callers` with `--json`; assert that each currently returns the report's different top-level shape, then make the test require `KnowledgeCliEnvelope<T>` and common metadata for every command.
- [ ] **Step 2: Define one serializer and one error serializer.** Every successful `--json` response uses `schemaVersion=1`, `command`, `data`, `meta`, and `error=null`; every failure uses the same envelope with `data=null` and a typed error. Preserve a temporary `--legacy-json` flag only for explicitly named compatibility consumers; it is never the default and is not advertised as canonical.
- [ ] **Step 3: Adapt all six commands without losing command-specific data.** Put hits under `data.hits`, endpoint/note rows under `data.items`, files under `data.files`, flow under `data.steps`, and callers under `data.nodes`; expose the same `returnedCount`, `candidateCount`, `totalIsExact`, cursor, revision, and gaps fields at `meta`.
- [ ] **Step 4: Make absence and truncation truthful.** A zero-hit query returns `returnedCount=0`, `candidateCount=0`, `totalIsExact=true` when the scoped search is complete, and `truncated=false`. Unscoped fan-out that hits a per-repo/global cap returns `truncated=true`, `totalIsExact=false`, the omitted repository/cap gap, and a continuation or exact scope remediation; it may not report a complete one-repository result.
- [ ] **Step 5: Prove CLI/MCP projection parity.** The MCP structured result and canonical CLI envelope must carry the same result data, revision, counts, cursor, exactness, and gaps for the same request; text rendering is a projection and cannot invent counts or hide debt.
- [ ] **Step 6: Run the contract gates.**

  ```bash
  rtk test node --test tests/knowledge-cli-envelope.test.mjs tests/knowledge-negative-search.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-pagination-contract.test.mjs tests/knowledge-surface-parity-e2e.test.mjs
  ```

**Exit gate:** an Agent can parse every canonical CLI knowledge result with one envelope, empty results never trigger a false pagination retry, and incomplete global searches are visibly incomplete.

### Task B13: Provide a real scoped Wiki read surface with honest knowledge fallback

**Files:**

- Create: `packages/knowledge-core/src/wiki.ts`
- Modify: `packages/knowledge-core/src/domain-model.ts`
- Modify: `packages/knowledge-core/src/onboarding.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-contracts/src/capabilities.ts`
- Modify: `packages/knowledge-contracts/src/input-schemas.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/knowledge-cli/src/args.ts`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src/components/wiki/WikiPage.tsx`
- Create: `tests/knowledge-wiki-query.test.mjs`
- Create: `tests/knowledge-wiki-cli-mcp.test.mjs`
- Create: `tests/knowledge-wiki-notes-fallback.test.mjs`

**Interfaces:**

- Consumes `RevisionTruth` from Task A1, `VerificationRecommendation` from Task B3, and the canonical evidence contract from `packages/knowledge-contracts/src/response.ts`.
- Uses `SearchEvidence`/`SearchLocator` from `packages/knowledge-contracts/src/search.ts` for file/line provenance instead of inventing a second evidence shape.
- Produces the `WikiResponse` consumed by the Tauri Wiki page, the private CLI, and MCP `knowledge_wiki`.

```ts
interface WikiFact {
  factId: string;
  title: string;
  value: string;
  evidenceState: "proven" | "derived" | "candidate" | "insufficient";
  provenance: SearchEvidence[];
  duplicateCount: number;
}

interface WikiQuery {
  target: string;
  repo: string;
  branch?: string;
  revision?: { snapshotId?: string; commitSha?: string };
  depth?: number;
  limit?: number;
}

interface WikiResponse {
  title: string;
  scope: RevisionTruth;
  sections: {
    terms: { status: "proven" | "derived" | "insufficient"; items: WikiFact[]; sourceKindsUsed: string[] };
    entryPoints: WikiFact[];
    flows: WikiFact[];
    state: WikiFact[];
    dependencies: WikiFact[];
    validation: VerificationRecommendation[];
  };
  evidence: SearchEvidence[];
  gaps: string[];
  totalIsExact: boolean;
}
```

- [ ] **Step 1: Add the failing read-surface tests.** `penguin wiki <target> --repo <repo> --json` and MCP `knowledge_wiki` must currently fail in the fixture; make tests require a scoped response, target-sensitive sections, file/line evidence, and a typed `REPOSITORY_NOT_FOUND`/`TARGET_NOT_FOUND` result instead of an unknown-command fallback.
- [ ] **Step 2: Build Wiki from canonical scoped facts.** Resolve the target and revision before traversing; reuse the A5 Domain graph, A2 endpoint occurrence inventory, B2 configuration flow, B3 verification recommendations, and B9 truth debt. Every section carries the same repo/branch/snapshot/commit envelope and cannot import facts from another registered checkout.
- [ ] **Step 3: Register identical CLI and MCP contracts.** Add `wiki` to the CLI command registry and `knowledge_wiki` to the MCP capability registry with the same required `target`, required `repo` policy, revision/depth/limit validation, pagination/budget behavior, and capability hash. The UI calls the canonical client rather than recomputing graph facts.
- [ ] **Step 4: Make sparse notes explicit.** If notes are absent, return `terms.status="insufficient"`, `sourceKindsUsed=[]`, and a gap naming missing notes. Symbol-derived terms may be returned only with `status="derived"` and evidence; no repository-wide alphabetic dump or model-generated terminology is allowed to masquerade as indexed knowledge.
- [ ] **Step 5: Add provenance-aware rendering.** The Wiki page shows target, repo, branch, indexed commit, current HEAD, worktree/overlay state, freshness, coverage debt, evidence labels, and whether each statement is a source fact, derived fact, candidate, or insufficient. Large sections are paginated or delegated to a durable deep job.
- [ ] **Step 6: Run the Wiki transport and UI gates.**

  ```bash
  rtk test node --test tests/knowledge-wiki-query.test.mjs tests/knowledge-wiki-cli-mcp.test.mjs tests/knowledge-wiki-notes-fallback.test.mjs tests/knowledge-domain-scope.test.mjs tests/knowledge-domain-dedup.test.mjs tests/knowledge-wiki-provenance-ui.test.mjs
  rtk test pnpm typecheck
  ```

**Exit gate:** `penguin wiki` and `knowledge_wiki` are real, scoped, target-sensitive read surfaces; empty notes are honestly reported; every rendered claim has provenance or an explicit insufficiency label.

---

## Phase C — Full-corpus reset, rebuild, and heavy-use reliability

Phase C starts only after the A3 single-writer/job supervisor and B6
confirmation policy are green. No real repository under
/Users/shieng/Desktop/Projects may be touched before C1 has frozen the baseline,
C2 has passed the dry-run and restore gates, and the operator has explicitly
started the internal rehearsal. This phase is the answer to the requirement
that the entire index is deleted and rebuilt; an incremental run or a loop over
the existing per-repository remove command is not equivalent.

### Task C1: Freeze and restore-test the corpus baseline and non-rebuildable assets

**Files:**

- Create: packages/knowledge-core/src/asset-export.ts
- Modify: packages/knowledge-core/src/store.ts
- Modify: packages/knowledge-core/src/source-store.ts
- Modify: packages/knowledge-core/src/revision-retention.ts
- Modify: packages/knowledge-core/src/semantic-chunks.ts
- Modify: packages/knowledge-core/src/vector-store.ts
- Modify: packages/knowledge-core/src/semantic-control.ts
- Modify: packages/knowledge-indexer/src/registry.ts
- Create: scripts/knowledge-corpus-baseline.mjs
- Create: tests/knowledge-asset-export-restore.test.mjs
- Create: tests/knowledge-corpus-baseline.test.mjs

**Interfaces:**

~~~ts
interface CorpusBaseline {
  rootPath: string;
  databaseInstanceId: string;
  repositories: Array<{
    repoId: string;
    canonicalRoot: string;
    branches: Array<{ branchId: string; head: string | null; snapshotId: string | null }>;
  }>;
  counts: Record<string, number>;
  databaseBytes: number;
  walBytes: number;
  immutableAssetHashes: Record<string, string>;
  sourceGroundTruthHash: string;
}

interface AssetRestoreReceipt {
  backupPath: string;
  restoredDatabaseInstanceId: string;
  restoredAssetHashes: Record<string, string>;
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  exact: boolean;
  gaps: string[];
}
~~~

- [ ] **Step 1: Classify every stored asset before writing reset code.** Put parser snapshots, files, symbols, references, graph edges, endpoint projections, coverage projections, semantic chunks/vectors, overlays, and derived caches in the rebuildable set. Put repository registration/policy, notes, tags, ontology links, why-memory, evidence status, saved queries, API-document stores, operation/audit ledgers, and credentials in the protected set. If a table or directory mixes both classes, split it or export the protected rows before C2.
- [ ] **Step 2: Freeze an immutable pre-reset baseline.** Use a consistent SQLite backup that accounts for database, WAL, and shared-memory state; record checksums, database instance ID, repo/branch/HEAD registry, all counts, file size, WAL size, and an independent source manifest. Keep the old database read-only until the new one passes all reconciliation gates.
- [ ] **Step 3: Export and restore-test protected assets before any deletion.** Restore into a disposable database, compare row/content hashes and counts, and fail closed if notes, tags, ontology, evidence status, saved queries, API documents, credentials, or registry policy cannot be restored exactly.
- [ ] **Step 4: Capture independent truth for the real corpus.** Enumerate canonical repository roots with Git realpath and current HEAD. Use direct Git/file inspection for eligible files and a separately implemented sample verifier for symbols/endpoints; do not use the same query path that is being tested as its own oracle.
- [ ] **Step 5: Run the baseline gates.**

  ~~~bash
  rtk node scripts/knowledge-corpus-baseline.mjs --root /Users/shieng/Desktop/Projects --json
  rtk test node --test tests/knowledge-asset-export-restore.test.mjs tests/knowledge-corpus-baseline.test.mjs
  ~~~

**Exit gate:** the pre-reset database and independent baseline are immutable,
protected assets have a verified restore path, every target repository and
branch is listed, and no destructive action is possible without this receipt.

### Task C2: Implement the owner-only guarded full index reset

**Files:**

- Create: packages/knowledge-core/src/index-reset.ts
- Create: packages/knowledge-core/src/reset-manifest.ts
- Modify: packages/knowledge-core/src/store.ts
- Modify: packages/knowledge-core/src/status-panel.ts
- Modify: packages/knowledge-core/src/revision.ts
- Modify: packages/knowledge-core/src/semantic-control.ts
- Modify: packages/knowledge-contracts/src/errors.ts
- Modify: packages/knowledge-contracts/src/capabilities.ts
- Modify: packages/knowledge-cli/src/args.ts
- Modify: packages/knowledge-cli/src/command-dispatch.ts
- Modify: packages/knowledge-cli/src/index.ts
- Modify: packages/mcp/src/knowledge-tool-defs.ts
- Modify: packages/mcp/src/knowledge-tools.ts
- Create: tests/knowledge-full-reset-policy.test.mjs
- Create: tests/knowledge-full-reset-manifest.test.mjs
- Create: tests/knowledge-full-reset-recovery.test.mjs

**Interfaces:**

~~~ts
interface FullResetPlan {
  operationId: string;
  rootPath: string;
  databaseInstanceId: string;
  repositories: Array<{
    repoId: string;
    canonicalRoot: string;
    branchIds: string[];
    currentHeads: Record<string, string | null>;
    rowCounts: Record<string, number>;
  }>;
  protectedAssetCounts: Record<string, number>;
  backupPath: string;
  risk: "full_corpus_reset";
  expiresAt: string;
}

interface FullResetReceipt {
  operationId: string;
  phase: "planned" | "backed_up" | "fenced" | "reset" | "rolled_back" | "failed";
  deletedRebuildableRows: Record<string, number>;
  remainingTargetIndexRows: Record<string, number>;
  protectedAssetHashes: Record<string, string>;
  sourceRepositoriesUntouched: boolean;
  rollbackAvailable: boolean;
  gaps: string[];
}
~~~

- [ ] **Step 1: Add failing policy tests before the delete path.** The dry-run must enumerate only registered repositories whose canonical real path is under /Users/shieng/Desktop/Projects; it must show repo/branch/root/HEAD/snapshot/row counts, protected assets, WAL/disk impact, backup path, and the exact confirmation scope. A path outside the root, an unresolved duplicate, an active writer, a missing backup, a stale plan, or a changed database instance must fail closed.
- [ ] **Step 2: Replace deterministic reusable confirmation with a single-use plan-bound token.** Bind the token to operation ID, absolute root, sorted repo/branch set, database instance ID, baseline digest, requested mode, and expiry. Consume it atomically; do not derive it from command arguments, accept an old token, or expose reset as a default MCP mutation.
- [ ] **Step 3: Add the global writer fence and WAL safety sequence.** Stop or quiesce watcher, semantic, Tauri, CLI, and MCP writers; drain or mark active jobs; checkpoint WAL with the configured policy; verify no process still owns the database; then write a reset manifest before mutating rows. Return a durable phase and job ID for every transition.
- [ ] **Step 4: Delete only the rebuildable target set.** Remove all snapshots, files, symbols, references, graph edges, endpoints, coverage rows, semantic chunks/vectors, overlays, and derived caches for every selected repository and branch. Never recursively delete a source checkout or a mixed protected directory. Immediately verify target index counts are zero, protected assets and outside-root repositories are unchanged, and the manifest records every completed repository.
- [ ] **Step 5: Implement recovery and rollback.** A crash during planning, fencing, reset, or post-reset verification must leave a queryable manifest and a usable old backup. Rollback must restore the database and protected assets into a fresh instance, re-check integrity, and invalidate old sessions through a new database instance ID.
- [ ] **Step 6: Keep MCP read-only but useful.** Add reset status, remediation, and job-status projection to MCP; the destructive reset remains owner CLI-only. Tauri may show target, backup, phase, progress, pause/resume, retry, cancel, and rollback availability, but must not bypass the owner confirmation policy.
- [ ] **Step 7: Run the policy and recovery gates.**

  ~~~bash
  rtk test node --test tests/knowledge-full-reset-policy.test.mjs tests/knowledge-full-reset-manifest.test.mjs tests/knowledge-full-reset-recovery.test.mjs
  rtk test pnpm typecheck
  ~~~

**Exit gate:** a dry-run is decision-useful, the actual reset is one-time,
owner-only, manifest-backed, source-safe, WAL-safe, reversible, and proves
zero remaining target index rows without losing protected knowledge.

### Task C3: Build a sharded cold full-index and rebuild runner

**Files:**

- Create: packages/knowledge-indexer/src/full-corpus-runner.ts
- Modify: packages/knowledge-indexer/src/pipeline.ts
- Modify: packages/knowledge-indexer/src/revision-indexer.ts
- Modify: packages/knowledge-indexer/src/registry.ts
- Modify: packages/knowledge-indexer/src/embedding-indexer.ts
- Modify: packages/knowledge-indexer/src/embedding-worker.ts
- Modify: packages/knowledge-indexer/src/watcher.ts
- Modify: packages/knowledge-core/src/revision.ts
- Modify: packages/knowledge-core/src/status-panel.ts
- Modify: packages/knowledge-cli/src/args.ts
- Modify: packages/knowledge-cli/src/command-dispatch.ts
- Modify: packages/knowledge-cli/src/semantic-worker.ts
- Create: tests/knowledge-full-corpus-rebuild.test.mjs
- Create: tests/knowledge-full-corpus-job-status.test.mjs

**Interfaces:**

~~~ts
interface FullCorpusJob {
  jobId: string;
  rootPath: string;
  repoIds: string[];
  phase: "index" | "rebuild" | "semantic" | "verify";
  currentRepoId: string | null;
  completedRepos: number;
  totalRepos: number;
  parsed: number;
  skipped: number;
  errors: number;
  startedAt: string;
  updatedAt: string;
}

interface FullCorpusRepoReceipt {
  repoId: string;
  branchId: string;
  head: string;
  parsed: number;
  skipped: number;
  errors: number;
  snapshots: number;
  symbols: number;
  edges: number;
  endpoints: number;
  semanticState: "queued" | "running" | "complete" | "unavailable";
}
~~~

- [ ] **Step 1: Add a cold-run test that rejects incremental shortcuts.** After C2 every selected repository starts with no rebuildable rows. The runner must process every eligible repository and emit parsed/persisted counts; a zero-parsed exit-zero job is a failure unless the repository has a documented zero-eligible-file policy.
- [ ] **Step 2: Shard by repository and serialize database publication.** Parse repositories independently, but publish through the A3 writer supervisor. A failure affects one shard and is recoverable; it cannot leave a ready partial snapshot or force an unrelated repository to report fresh.
- [ ] **Step 3: Execute both public modes explicitly.** Run the full index mode and the parser-derived rebuild mode over the complete target root. If they share an implementation, the receipt must still prove both requested modes, their non-skipped work, and the final persisted publication; two no-op aliases do not count as two validations.
- [ ] **Step 4: Preserve durable pause/resume/cancel/retry behavior.** Tauri and CLI status must show phase, repo, counts, queue wait versus execution time, heartbeat, pause/resume, retry, cancel, and failure remediation. Restarting the app or MCP server must not fabricate completion or freshness.
- [ ] **Step 5: Verify current revision and identity.** Each ready shard records live HEAD, branch, snapshot, resolver identity, schema/contract/capability/model hashes, and database instance ID. A changed HEAD after indexing is stale, not fresh.
- [ ] **Step 6: Run the cold full-corpus gate.**

  ~~~bash
  rtk node scripts/knowledge-corpus-baseline.mjs --root /Users/shieng/Desktop/Projects --json
  rtk test node --test tests/knowledge-full-corpus-rebuild.test.mjs tests/knowledge-full-corpus-job-status.test.mjs
  ~~~

**Exit gate:** the real target root is fully indexed and rebuilt in repository
shards, every eligible shard has nonzero/defensible parsed evidence, all
progress is durable, and no partial or stale ready state is reported.

### Task C4: Reconcile four transport layers against independent source truth

**Files:**

- Create: packages/knowledge-core/src/corpus-reconciliation.ts
- Create: scripts/knowledge-corpus-reconcile.mjs
- Modify: packages/knowledge-core/src/query.ts
- Modify: packages/knowledge-core/src/coverage-query.ts
- Modify: packages/knowledge-cli/src/command-dispatch.ts
- Modify: packages/mcp/src/knowledge-tools.ts
- Modify: src/lib/knowledge-client.ts
- Create: tests/knowledge-corpus-reconciliation.test.mjs
- Create: tests/knowledge-independent-ground-truth.test.mjs

- [ ] **Step 1: Compare parser output, persisted rows, canonical CLI, MCP, and Tauri status under one repo/branch/revision scope.** For files, symbols, edges, endpoints, coverage, and semantic state, report source/parser/persisted/CLI/MCP/Tauri counts separately and require an explanation for every difference.
- [ ] **Step 2: Re-run the audit's real checks after the reset.** Preserve the expected references of 34 scoped hits across 5 repositories, 276 endpoints when the corpus has not changed, Auth's 1,583 files, and the audit's Rust false-edge cases; treat changed source or policy as a documented delta, not as a silently adjusted expected value.
- [ ] **Step 3: Prove endpoint publication.** Every endpoint discovered during rebuild is either queryable in the endpoint inventory or appears in an explicit named exclusion with repository, revision, file/line, and reason. Verify gRPC/HTTP production handlers, controller/service calls, tests, and occurrence counts.
- [ ] **Step 4: Sample bidirectionally.** Independently select at least 30 symbols/endpoints across repositories and compare both precision and recall with source evidence. Include duplicate names, duplicate registrations, Rust trait receivers, TypeScript DI calls, generated/minified files, and negative targets.
- [ ] **Step 5: Scan secrets and source boundaries.** Confirm secret values, private-key material, credentials, and excluded file contents are absent from rebuildable rows while exclusions remain visible in coverage/policy status. Confirm no source checkout changed or was deleted.

**Exit gate:** parser, persistence, CLI, MCP, and Tauri agree within the
declared scope; independent source checks prove the result; endpoint loss,
cross-repository contamination, false Rust edges, and secret persistence are
zero or explicitly typed as unresolved gaps.

### Task C5: Prove deterministic rebuild and no-change idempotency

**Files:**

- Create: scripts/knowledge-rebuild-determinism.mjs
- Modify: packages/knowledge-indexer/src/identity.ts
- Modify: packages/knowledge-indexer/src/fusion.ts
- Modify: packages/knowledge-core/src/revision-retention.ts
- Create: tests/knowledge-rebuild-determinism.test.mjs
- Create: tests/knowledge-index-idempotency.test.mjs
- Create: tests/knowledge-multi-branch-unrebuilt.test.mjs

- [x] **Step 1: Export a canonical corpus representation.** Sort by stable repository, revision, identity, kind, and source locator. Exclude only documented volatile fields such as timestamps, job IDs, and database instance IDs.
- [x] **Step 2: Run two cold full rebuilds at the same revision.** Stable IDs, symbols, edges, endpoint occurrences, exclusions, coverage categories, and canonical exports must match exactly; duplicate rows cannot accumulate. The owner reduced this gate from three runs to two on 2026-09-02.
- [x] **Step 3: Run ten no-change index attempts.** Each attempt must report no source work, no new snapshot, no unexplained database growth, and no semantic duplicate generation while preserving query truth. The owner reduced the real-corpus gate from twenty attempts to ten on 2026-09-02; the automated fixture retains twenty attempts.
- [ ] **Step 4: Test multi-branch continuity before the cold rebuild.** The regression `tests/knowledge-multi-branch-unrebuilt.test.mjs` must create at least two repositories, each with `master`, a branch created from `upstream/master`, and a divergent branch. It must index only the base branch, checkout each other branch before its index/rebuild, and prove that current-branch queries return typed `BRANCH_NOT_INDEXED` evidence rather than borrowing the last live branch. Explicit fallback must be labelled, and after the branch is indexed/rebuilt its results must be isolated from every other branch.
- [ ] **Step 5: Run the same branch matrix against the real corpus in disposable checkouts.** Before the `/Users/shieng/Desktop/Projects` cold index/rebuild, enumerate every selected repository's local/remote branch, upstream base, HEAD, and dirty state. For every repository with more than one usable branch, use a disposable clone or worktree to run `checkout -b <branch> upstream/master` (or a documented divergent branch), query before rebuild, then index/rebuild and query again. Never checkout or commit in the user's original dirty source checkout. Record the branch matrix, pre-rebuild typed error, post-rebuild snapshot/commit, and cross-branch leak result; an unindexed branch must never be called fresh/aligned.
- [ ] **Step 6: Test duplicate registration continuity.** Repo IDs must remain stable under the chosen realpath/remote rule, and the deliberate duplicate auth registration must either remain an explicit candidate set or be removed by a documented policy decision; it may not silently change which repository answers a query.

**Exit gate:** the fixture and real-corpus branch matrices prove that every
unindexed checkout fails closed, explicit fallback is labelled, and every
post-index/rebuild branch is isolated; two rebuild exports are byte-identical
apart from the volatile allowlist, ten real no-change runs are idempotent, and
repo/branch identity is stable enough for MCP remediation and fresh-session
retesting.

### Task C6: Execute a broad burst, concurrency, soak, and resource matrix

**Files:**

- Create: scripts/knowledge-stress.mjs
- Create: scripts/knowledge-load-report.mjs
- Modify: packages/knowledge-core/src/status-panel.ts
- Modify: packages/knowledge-core/src/semantic-control.ts
- Modify: packages/knowledge-core/src/store.ts
- Modify: packages/knowledge-cli/src/command-dispatch.ts
- Modify: packages/mcp/src/result-text.ts
- Modify: src/lib/knowledge-client.ts
- Create: tests/knowledge-load-burst.test.mjs
- Create: tests/knowledge-concurrency-races.test.mjs
- Create: tests/knowledge-soak-resource-budgets.test.mjs
- Create: tests/knowledge-semantic-fairness.test.mjs
- Create: tests/knowledge-adversarial-inputs.test.mjs

**Interfaces:**

~~~ts
interface LoadProfile {
  name: "burst" | "mixed" | "soak" | "writer_race" | "fault";
  durationSeconds: number;
  concurrentReaders: number;
  concurrentWriters: number;
  mcpSessions: number;
  queryMix: Record<string, number>;
  rootPath: string;
}

interface LoadReport {
  profile: LoadProfile;
  requestCount: number;
  successCount: number;
  typedErrorCount: number;
  rawLockErrorCount: number;
  timeoutCount: number;
  latencyMs: { p50: number; p95: number; p99: number };
  peakRssBytes: number;
  peakDiskBytes: number;
  peakWalBytes: number;
  fdStart: number;
  fdEnd: number;
  threadStart: number;
  threadEnd: number;
  dbIntegrity: "ok" | "failed";
  gaps: string[];
}
~~~

The real-corpus runner must execute this matrix and write an immutable JSON
report. The audit counts are the starting reference only; the runner records
actual counts and fails on unexplained changes.

| Dimension | Required workload | Required pass condition |
| --- | --- | --- |
| Cold full index | All eligible repositories under /Users/shieng/Desktop/Projects; target reference 21 repositories and about 21.8k files | Parsed evidence is nonzero/defensible, errors are zero or typed, all shards complete; target of under 60 minutes and single-repo p95 under 5 minutes, with any baseline exception documented |
| Read burst | 5 MCP sessions, 100 concurrent bounded requests for 60 seconds | No valid-request crash; no cross-repo result; p95 under 2x the single-query baseline; no raw lock error |
| Mixed concurrency | 8 readers plus 2 writer jobs for 30 minutes while Auth and ccmsrust workloads run | Exactly one writer owner; zero user-visible SQLITE_BUSY/database-locked failures; durable job state; read p95 under 2x idle |
| Sustained soak | Watcher enabled, mixed queries for 8 hours and at least 50,000 requests | No crash/OOM; RSS drift after warm-up under 10%; fd drift within 5%; no monotonic job/semantic backlog |
| Index/rebuild race | Same repo requested twice, different repos requested together, queries during publish, pause/resume/cancel/retry | One deduplicated publication per revision; no deadlock, half-ready snapshot, or false fresh status |
| Determinism | Two consecutive full rebuilds at one unchanged revision | Stable ID sets and canonical exports byte-identical except declared volatile fields; owner reduced this gate from three runs on 2026-09-02 |
| Idempotency | Ten real no-change index requests; twenty attempts remain in the automated fixture | Zero source work, no new snapshot, no unexplained row/database growth, no duplicate semantic generation |
| Fault injection | SIGKILL at scan, parse, publish, and maintenance checkpoints, 5 runs per checkpoint | 20/20 recover with integrity check OK, no ready partial snapshot, durable remediation or restart path |
| Restart and lifecycle | Kill Tauri/MCP/CLI during rebuild and semantic generation, 10 runs; pause for 60 seconds and resume | Reconnect shows truthful phase/progress; no orphan writer; pause/resume or explicit retry works |
| Resource ceiling | Sample RSS, CPU, disk, WAL, fd, threads, temp files during cold and soak runs | Peak RSS under 4 GB for the current corpus or within an approved baseline budget; peak working disk under 2.2x final DB; fd under 1,024; threads under 100 |
| WAL durability | Continuous writes, checkpoint, clean close, and kill-9 recovery | Active WAL under 256 MB and post-checkpoint WAL under 64 MB, or the stricter 10% of main DB cap; integrity check remains OK and no unexplained WAL accumulation |
| Query latency/payload | Scoped search/context/flow/affected, bounded unscoped search, Domain/Wiki, onboarding, fast Doctor, Explore depth 1 limit 20 | Scoped p95 under 2s; bounded unscoped under 5s; Domain/Wiki under 8s; onboarding under 10s; fast Doctor under 15s; Explore under 5s; compact payload under 100 KB; no 25–30s transport timeout |
| Semantic fairness | Fill all eligible spaces, supersede generations, pause/resume, restart worker, disable model | Every eligible space progresses or is explicitly unavailable; no starvation; superseded work is reclaimed; graph/lexical queries remain available |
| Adversarial inputs | Empty/nonexistent/outside-root paths, symlinks, duplicate repos, duplicate branches, invalid cursors, huge/minified/binary files, deleted files | Typed bounded errors, no source mutation, no path escape, no crash, no fabricated facts |
| Cross-repo correctness | Repeat duplicate names, Auth Version, ccmsrust Redis, Rust receiver, and negative-target scenarios | Results stay inside repo/revision envelope; endpoint counts reconcile; false collect/is_empty edges remain zero; empty results are not truncated |
| Secret and policy safety | Scan rebuilt rows and coverage/policy output for known secret classes and excluded paths | Secret values/private-key material are absent; exclusions are visible and counted; protected assets hash-match the baseline |

- [ ] **Step 1: Measure a warm-up baseline before enforcing percentage budgets.** Record one idle run and one single-client run on this Mac. Relative budgets are applied to those measurements, while absolute safety caps and zero-corruption requirements remain mandatory.
- [ ] **Step 2: Run the matrix against the real corpus, not only fixtures.** Fixtures remain for deterministic race/fault tests, but the final load report must identify the real repo list, branch/HEAD set, database instance, build identity, machine resources, and exact command path.
- [ ] **Step 3: Make every failure diagnosable.** Persist operation ID, job ID, repo, phase, queue wait, execution time, retry count, error code, current revision, and resource sample. A timeout or lock retry cannot disappear from the report.
- [ ] **Step 4: Repeat failed profiles after remediation.** A rerun may not overwrite the first failure; store both immutable reports and the exact source/artifact identity.
- [ ] **Step 5: Run the stress harness.**

  ~~~bash
  rtk node scripts/knowledge-stress.mjs --root /Users/shieng/Desktop/Projects --profile all --json
  rtk test node --test tests/knowledge-load-burst.test.mjs tests/knowledge-concurrency-races.test.mjs tests/knowledge-soak-resource-budgets.test.mjs tests/knowledge-semantic-fairness.test.mjs tests/knowledge-adversarial-inputs.test.mjs
  ~~~

**Exit gate:** all valid heavy-use profiles pass without corruption, silent
truncation, cross-repository leakage, raw lock failures, unbounded resource
growth, semantic starvation, or unrecoverable lifecycle errors. Any threshold
exception has a recorded machine baseline and explicit engineering sign-off;
it cannot be hidden by lowering the workload.

### Task C7: Prove crash durability, rollback, and installed-session behavior

**Files:**

- Create: scripts/knowledge-fault-injection.mjs
- Create: tests/knowledge-crash-durability.test.mjs
- Create: tests/knowledge-wal-recovery.test.mjs
- Create: tests/knowledge-installed-full-corpus.test.mjs
- Modify: packages/knowledge-core/src/reset-manifest.ts
- Modify: packages/knowledge-core/src/status-panel.ts
- Modify: packages/mcp/src/knowledge-tools.ts
- Modify: src/components/wiki/WikiPage.tsx

- [ ] **Step 1: Inject failures at every durable phase.** Cover baseline backup, writer fence, reset, scan, parse, publish, semantic generation, WAL checkpoint, and verification. Use SIGKILL/connection drop rather than only clean exceptions.
- [ ] **Step 2: Verify SQLite and manifest recovery.** After every crash run integrity_check and quick_check, inspect WAL/SHM/journal cleanup, confirm no ready partial snapshot, confirm the database instance/generation invalidates stale sessions, and resume or rollback from the manifest.
- [ ] **Step 3: Verify protected asset and source safety.** Compare source checkout hashes/status, protected asset hashes, registry identity, and backup checksums before and after every recovery scenario.
- [ ] **Step 4: Verify installed behavior.** Build/install the unsigned internal DMG, use the packaged CLI/MCP paths rather than the rtk wrapper, restart Tauri, launch two genuinely fresh Claude/Codex MCP sessions, and repeat the reset status, full-corpus read, stress summary, Auth, ccmsrust, Wiki, and negative-result probes.
- [ ] **Step 5: Preserve immutable evidence.** Store command argv, artifact build/capability/model/schema identities, database instance ID, corpus manifest, metrics, failures, recovery receipts, and both fresh-session transcripts in a new evaluation report. Old reports cannot be used as a passing substitute.

**Exit gate:** the system either resumes or rolls back after every injected
failure, never claims fresh from a stale/partial instance, and the installed
artifact exposes the same truthful status and MCP contracts used by the source
tests.

## Independent review synthesis — 2026-09-01

Claude Code and DeepSeek independently reviewed the current plan and the
2026-09-01 audit. They agreed that the earlier A1-A5/B1-B13 plan was not enough
for the user's new requirement: it had no explicit full-corpus reset phase and
no independent heavy-use reliability gate.

| Shared conclusion | Binding decision in this plan |
| --- | --- |
| Reset must not mix rebuildable index rows with protected knowledge | C1 classifies, exports, restore-tests, and hashes protected assets before C2 |
| The old database and regression truth must survive the reset | C1 freezes a read-only backup and independent source/count baseline |
| Reusable argument-derived confirmation is unsafe for a cross-repo delete | C2 requires a single-use token bound to root, repo/branch set, database instance, baseline, mode, and expiry |
| Reset must be coordinated with every writer and WAL state | C2 places the writer fence, job drain, WAL checkpoint, and manifest before deletion |
| A per-repository remove loop and exit code zero do not prove a full rebuild | C3 adds a sharded cold full-index/rebuild runner and requires parsed/persisted receipts |
| Query output must be reconciled independently after rebuild | C4 compares source, parser, persistence, CLI, MCP, and Tauri and rechecks endpoint publication |
| Reliability needs more than functional p95 checks | C5-C7 add determinism, idempotency, burst, concurrency, 8-hour soak, resource/WAL, fault, restart, semantic, and adversarial tests |
| Installed behavior and fresh MCP sessions remain the final truth | G44-G45 require packaged-path execution, generation invalidation, capability discovery, and two genuinely fresh sessions |

The reviews differed mainly in threshold style. Claude proposed concrete
current-corpus targets and a 20-case fault matrix; DeepSeek emphasized
baseline-relative latency/resource budgets and a manifest-driven recovery
sequence. The final plan uses both: absolute safety caps and zero-corruption
requirements are hard gates, while percentage latency/resource budgets are
measured against a warm-up baseline and cannot be relaxed without an explicit
recorded exception.

## Final installed-artifact acceptance

Before Final Step 1, Phase C must be executed against the real
/Users/shieng/Desktop/Projects corpus. The required preflight is:

1. Freeze the immutable baseline and restore-test protected assets.
2. Run the guarded dry-run, verify the exact repo/branch/root scope, checkpoint
   WAL, obtain the single-use owner token, and reset every rebuildable target
   index row.
3. Run full index and full rebuild for the complete corpus in repository
   shards; prove parsed evidence, durable progress, and current HEAD.
4. Reconcile independent source truth with parser, persistence, CLI, MCP, and
   Tauri counts and endpoint inventories.
5. Complete two deterministic rebuilds, ten real idempotency runs, and the
   entire burst/concurrency/soak/resource/fault/restart/semantic/adversarial
   matrix. No incremental-only run, dry-run-only result, or exit code zero can
   satisfy this preflight.
6. Preserve immutable failure and recovery reports, then build/install the
   artifact and continue with the fresh-session steps below.

The operator sequence used by the final rehearsal is:

~~~bash
/Users/shieng/.local/bin/penguin index reset --root /Users/shieng/Desktop/Projects --dry-run --json
/Users/shieng/.local/bin/penguin index reset --root /Users/shieng/Desktop/Projects --confirm=<token returned by that dry-run> --json
/Users/shieng/.local/bin/penguin index --root /Users/shieng/Desktop/Projects --full --detach --json
/Users/shieng/.local/bin/penguin rebuild --root /Users/shieng/Desktop/Projects --full --detach --json
/Users/shieng/.local/bin/penguin index-job status --job <job id from the receipt> --json
rtk node scripts/knowledge-stress.mjs --root /Users/shieng/Desktop/Projects --profile all --json
~~~

These commands are the planned owner-only contract; implementation must add
the guarded root reset and full-corpus runner before this rehearsal. The
existing per-repository remove command and an incremental index are
insufficient.

- [ ] **Step 1: Build and install the unsigned internal DMG after every source gate passes.** Verify the installed `/Applications/Penguin.app` contains `Contents/Resources/icon.icns`, the bundled CLI entry/runtime, the MCP `dist/index.js` and package manifest, sqlite/native/model assets, and matching build/capability/model identities before opening the app; a copied old or partial App is not a valid test artifact.
- [ ] **Step 2: Reconfigure stable MCP clients and restart fresh Claude/Codex processes.**
- [ ] **Step 3: Run the Auth `VersionService.Version` scenario through MCP only.** Require current HEAD, endpoint parity, complete controller-to-service call flow, affected endpoint/test evidence, and bounded endpoint filtering.
- [ ] **Step 4: Run the ccmsrust Redis Cluster scenario through MCP only.** Require current HEAD, complete config-to-runtime flow, working-tree overlay, affected verification commands, and graph diff.
- [ ] **Step 5: Run concurrent Auth/ccmsrust index jobs.** Require job IDs/progress and no raw database-lock failure.
- [ ] **Step 6: Run natural-language fallback and payload-budget tests.** Require useful deterministic results and paginated compact responses.
- [ ] **Step 7: Run the independent report regressions through installed MCP only.** Re-run B1–B9 and L1–L5 from `penguin-index-wiki-audit-2026-09-01.md`: cross-repository `resolveActiveSite`/callers fan-out, target-sensitive Domain/Wiki, duplicate-repository remediation, non-code dirty classification, gRPC/production endpoint onboarding, filtered hub ranking, canonical CLI/MCP envelopes, correct empty-result truncation, real Wiki read surface, durable index dry-run UX, coverage debt taxonomy, latency budgets, and sparse-note honesty. Also require zero reproduced Rust `collect`/`is_empty` false edges, revision-scoped non-duplicated Domain output, canonical Onboarding facts/commands, bounded Explore and Doctor, truthful coverage/semantic debt, deterministic production flow roots, fast duplicate-repo ambiguity, and confidence-ranked dead-code output.
- [ ] **Step 8: Prove background semantic fairness and recovery.** Queued spaces make progress without starvation, superseded generations are reclaimed, pause/resume survives app restart, and lexical/graph answers remain immediately available throughout.
- [ ] **Step 9: Verify the owner Wiki and all canonical consumer surfaces.** The local Tauri Wiki shows the same scoped `knowledge_wiki` facts as MCP, while the private owner-only CLI exposes the same data through `penguin wiki`; no surface advertises a command/tool that is absent from the installed capability registry. The old `index-evaluation-checkpoint-b1-20260901.md` may be used only for the intermediate checkpoint, never as final evidence.
- [ ] **Step 10: Create a new immutable evaluation brief and two new reports.** Old reports and old questions cannot be reused. Questions must independently cover Rust, Auth, Domain, Onboarding, Doctor, Explore, coverage truth, endpoint provenance, concurrency, semantic lifecycle, overlay/config/diff, Wiki provenance, cross-repository completeness, canonical JSON, non-code dirtiness, and sparse-note fallback.
- [ ] **Step 11: Require both consumer sessions to score 95–100 without source, CLI, database, grep, or old-report fallback.** Rust graph correctness, Domain/Wiki scope, Onboarding, and the audit regressions each must independently score at least 90; no category may be rescued by averaging unrelated strengths.

## Added acceptance gates

| Gate | Required evidence | Failure means |
| --- | --- | --- |
| G13 Revision truth | Zero-parse commit advances snapshot; each query checks live HEAD | False freshness remains |
| G14 Endpoint parity | Discovered = persisted + named exclusions = queryable inventory | Endpoint loss remains |
| G15 Mutation coordination | Concurrent jobs expose IDs/progress and never raw lock errors | Index operations remain unsafe/unusable |
| G16 Auth flow | MCP returns endpoint → controller → service method → response evidence | Framework call chain incomplete |
| G17 Developer intelligence | Overlay, config flow, diff, and verification suggestions pass | Phase B incomplete |
| G18 Bounded retrieval | Analyze fallback works and endpoint payload is filtered/paginated | Agent usability below target |
| G19 Wiki provenance | Branch/commit/worktree/freshness/evidence labels are truthful | Owner UI remains misleading |
| G20 Independent expanded score | Fresh Claude and Codex each score 95–100 on new Auth/ccmsrust questions | Master goal remains open |
| G21 Rust receiver correctness | Exact `collect`/`is_empty` false edges are absent; unresolved/dynamic receivers remain candidate; resolver re-index clears historical wrong edges | Core graph facts remain unsafe |
| G22 Domain scope and dedup | Repo/revision envelope, stable dedup, provenance, insufficiency, p95/payload gates pass | Wiki/Domain can contaminate answers |
| G23 Endpoint occurrence and flow root | Definition/client/handler/test are classified; production handler wins deterministic root ranking | Endpoint totals/flows remain misleading |
| G24 Canonical Onboarding | File/handler counts, technology, and all recommended commands reconcile with installed canonical APIs | New users receive wrong guidance |
| G25 Bounded Doctor | MCP/CLI fast Doctor parity, stage timings, and installed p95 under 15s | Fresh MCP health check remains unusable |
| G26 Bounded Explore | Auth depth-1 p95 under 5s, no 25–30s timeout, compact payload under 100KB | Deep retrieval remains impractical |
| G27 Status and coverage truth | Index, coverage, unresolved, semantic, dirty, ignored, and policy debt are explicit and denominator-correct | Green status can hide known failure |
| G28 CLI and repository ambiguity | Registry-derived help/exit behavior; cwd-first resolution; duplicate candidates under 100ms | CLI remains inconsistent or selects wrong checkout |
| G29 Dead-code honesty and semantic fairness | Active public/framework symbols are not high-confidence dead; queued semantic spaces progress and superseded work is reclaimed | Analysis and vector lifecycle remain misleading |
| G30 Independent total score | Fresh installed Claude and Codex each score 95–100; Rust, Domain, and Onboarding each score at least 90 using MCP only | Master goal remains open |
| G31 Cross-repository completeness | Unscoped search/callers fan out across the registered corpus or return typed scope/truncation gaps; zero-hit results are not truncated; counts reconcile with scoped ground truth | Agents can silently miss four of five repositories and claim absence |
| G32 Canonical transport envelope | All six CLI knowledge commands and MCP projections expose one versioned envelope, common counts/cursor/revision/gaps, deterministic ambiguity errors, and working repoId remediation | Consumers need command-specific parsers and may trust empty wrong-branch output |
| G33 Real Wiki and target relevance | `penguin wiki` and `knowledge_wiki` return target-sensitive, repo/revision-scoped, provenance-labelled facts; absent notes are `insufficient` or explicitly derived | Wiki remains an alphabetic scaffold or advertises nonexistent capability |
| G34 Dirty and coverage debt truth | Indexable, non-indexable, ignored, policy-excluded, external-package unresolved, parser-failed, and index-failed states have separate denominators and statuses | A harmless README/lockfile or external dependency keeps every healthy repo stale/partial |
| G35 UX and latency budgets | Dry-run is decision-useful and confirmation is one-time plan-bound; scoped/unscoped search, Domain/Wiki, onboarding, Doctor, and Explore stay within their budgets or become observable durable jobs | New sessions hit opaque guards, 30-second timeouts, or unbounded payloads |
| G36 Installed artifact integrity | The DMG/App contains the custom icon, CLI, MCP, native/runtime/model assets, and matching identity hashes; a fresh Tauri launch and packaged MCP/CLI probe pass from the installed path | A stale/partial install can masquerade as a product regression and invalidate every fresh-session score |
| G37 Full reset reversibility and asset preservation | The real Desktop/Projects corpus has a frozen baseline, export/restore proof, one-time owner token, exact deletion receipt, zero remaining target index rows, protected-asset hash equality, and a usable rollback path | A failed reset can destroy knowledge or leave an unrecoverable empty index |
| G38 Full-corpus rebuild reconciliation | Every eligible target repository completes cold full index and rebuild; parser, persisted rows, CLI, MCP, and Tauri reconcile with independent source truth; parsed work is nonzero or defensibly zero | An exit-zero or cached run can masquerade as a successful rebuild while endpoints or symbols are missing |
| G39 Determinism and idempotency | Two same-revision full rebuilds have identical stable exports and ten real no-change index attempts create no new snapshots, duplicate rows, or unexplained growth; the fixture retains twenty attempts | Repeated use gradually changes or inflates the knowledge graph |
| G40 Crash and WAL durability | Reset, scan, parse, publish, semantic, checkpoint, and verification failures recover or roll back; SQLite integrity, WAL cleanup, manifest state, and stale-session invalidation are correct | A kill, lock, or power-loss-like event leaves a corrupt or falsely fresh database |
| G41 Heavy-use concurrency and soak | Five MCP sessions, 100-request burst, 8-reader/2-writer race, 8-hour 50k-query soak, lifecycle controls, and semantic fairness meet latency/resource/error budgets with no raw lock failures | The product works only for one light interactive user |
| G42 Secret and policy non-persistence | Rebuilt rows contain no secret values/private-key material; excluded files remain visible in policy/coverage status; protected assets and source checkouts are unchanged | Full reindex leaks credentials or silently hides coverage debt |
| G43 Registry and identity continuity | Repo IDs, real roots, duplicate-registration policy, branch/revision selectors, database instance, and generation/manifest behavior remain deterministic across reset and restore | Fresh MCP sessions resolve the wrong repository or stale database |
| G44 Installed index execution truth | The installed packaged CLI/MCP actually performs full work with parsed/persisted evidence and matching hashes; success is not inferred from exit code or a stub | Source tests pass but the installed worker silently does zero work |
| G45 Fresh-session fail-closed behavior | Old sessions cannot read a reset instance as fresh; two new Claude/Codex MCP sessions discover the current capability set, see durable status, and pass all required scenarios | A previous MCP process masks missing updates and invalidates the score |

## Effort and completion language

The existing source already contains partial cwd scoping, live Git-state checks, endpoint identity/filtering, framework edges, typed remediation, and installed-runtime gates. Each task begins by reproducing the installed failure so already-correct source is tested rather than rewritten.

| Work | Estimate |
| --- | ---: |
| Phase A revision/endpoint/job/dispatch/domain truth closure | 34–52 hours |
| Phase B overlay/config/diff/analysis/Wiki/index UX, CLI envelope, and report regressions | 72–112 hours |
| Phase C baseline export/restore, guarded full reset, cold full index/rebuild, reconciliation, determinism, stress, fault, and recovery | 72–120 hours |
| Installed artifact and dual fresh-session acceptance | 16–26 hours |
| **Total estimate** | **198–314 hours, approximately 26–40 focused working days** |

The work may be called **Phase A source closed** only after A1–A5 focused tests and independent reviews pass. It may be called **developer intelligence source closed** only after B1–B13 pass. It may be called **Phase C reliability closed** only after C1–C7 pass on the real Desktop/Projects corpus. It may be called **95–100 complete** only after installed-artifact gates G13–G45 and two independent MCP-only reports pass; both fresh sessions must score at least 95, no core category may be below 90, and no P0 evidence gap may be waived by averaging.
