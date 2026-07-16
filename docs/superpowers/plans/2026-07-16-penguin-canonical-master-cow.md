# Penguin Canonical Master and Stable COW Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each indexed Git repository one canonical master and make every index path store immutable, branch-correct COW snapshots with global file-fact reuse.

**Architecture:** A central branch-base resolver chooses prior, merge-base, or canonical-master snapshots from Git topology. All indexing entry points calculate exact manifest differences against that immutable base; master election occurs atomically only after successful publication, and changing master never rewrites history.

**Tech Stack:** TypeScript, Node.js 18/22, SQLite via better-sqlite3, Git object reads, Tauri/React, MCP SDK, Node test runner.

---

## Global constraints

- Preserve the dirty shared worktree and unrelated user changes.
- Use CodeGraph before manual code searches when `.codegraph/` exists.
- Use `apply_patch` for source edits and prefix shell commands with `rtk`.
- Follow TDD for every behavior change: add a failing test, run RED, implement minimally, run GREEN.
- Never mutate or checkout user repositories in tests; use temporary Git repositories.
- Never rewrite ready snapshots or use branch names to infer ancestry.
- Run native Knowledge tests with the Node ABI currently used by Penguin desktop (`v18.20.8` until runtime packaging changes).

## File map

- Create `packages/knowledge-core/src/branch-base.ts` — canonical master and base-selection contracts independent of parsers.
- Modify `packages/knowledge-core/src/schema.ts` — one-master invariant and additive migration.
- Modify `packages/knowledge-core/src/store.ts` — atomic master election/read APIs.
- Modify `packages/knowledge-core/src/query.ts` — canonical and actual-base status fields.
- Modify `packages/knowledge-core/src/index.ts` — public branch-base exports.
- Modify `packages/knowledge-indexer/src/git-topology.ts` — merge-base resolution diagnostics.
- Create `packages/knowledge-indexer/src/base-snapshot.ts` — idempotently materialize an immutable merge-base commit snapshot.
- Modify `packages/knowledge-indexer/src/revision-indexer.ts` — consume central base selection.
- Modify `packages/knowledge-indexer/src/pipeline.ts` — normal index/rebuild/watch use the same COW rules and post-success election.
- Modify `packages/knowledge-cli/src/index.ts` — current-branch `penguin master` semantics and status output.
- Modify `packages/mcp/src/knowledge-tool-defs.ts` — explicit `set_master_branch` contract.
- Modify `packages/mcp/src/knowledge-tools.ts` — MCP handler and shared status.
- Modify `src/lib/knowledge-client.ts` — typed canonical/base fields and master mutation wrapper.
- Modify `src/components/wiki/WikiPage.tsx` — master badge, unresolved state, explicit set-master action.
- Create `tests/knowledge-branch-base.test.mjs` — base resolver and master replacement invariants.
- Modify `tests/knowledge-master-command.test.mjs` — no-argument current branch and replacement behavior.
- Modify `tests/knowledge-revision-indexer.test.mjs` — merge-base COW and multiple-branch isolation.
- Modify `tests/knowledge-index-recovery-scenarios.test.mjs` — empty DB, rebuild, and cache regeneration.
- Modify `tests/knowledge-mcp-tools.test.mjs` — explicit MCP master mutation and status.
- Modify `docs/knowledge/revision-storage.md` — operator model and recovery commands.
- Modify `docs/knowledge/three-plan-acceptance.md` — canonical-master acceptance evidence.

### Task 1: Lock the one-master storage invariant

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Create: `tests/knowledge-branch-base.test.mjs`

- [ ] **Step 1: Write failing schema and store tests**

Add tests that create two branches and assert:

```js
const first = store.setDefaultBranch(repoId, mainId);
const second = store.setDefaultBranch(repoId, featureId);
assert.equal(first.name, "main");
assert.equal(second.name, "feature/x");
assert.equal(store.getDefaultBranch(repoId).id, featureId);
assert.equal(store.db.prepare(
  "SELECT COUNT(*) AS n FROM branches WHERE repo_id=? AND default_branch=1",
).get(repoId).n, 1);
```

Insert a second default directly and assert SQLite rejects it with the partial unique index.

- [ ] **Step 2: Run RED verification**

Run:

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-branch-base.test.mjs
```

Expected: FAIL because `getDefaultBranch` and the uniqueness constraint do not exist.

- [ ] **Step 3: Add the additive one-master migration**

Add this invariant after repairing duplicate defaults:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_default_per_repo
ON branches(repo_id)
WHERE default_branch = 1;
```

Before creating the index, rank duplicate defaults by successful index recency and keep exactly one named Git branch:

```sql
ROW_NUMBER() OVER (
  PARTITION BY repo_id
  ORDER BY last_indexed_at DESC, name ASC
)
```

Record the repair count in schema diagnostics; do not delete branches or snapshots.

- [ ] **Step 4: Implement the focused store API**

Expose:

```ts
export interface MasterBranchSelection {
  repoId: string;
  branchId: string;
  branch: string;
  previousBranchId: string | null;
  changed: boolean;
}

getDefaultBranch(repoId: string): BranchRow | null;
setDefaultBranch(repoId: string, branchId: string): MasterBranchSelection;
```

Use one SQLite transaction to validate ownership, clear the previous flag, set the new flag, and return both identities. Do not update historical snapshot bases.

- [ ] **Step 5: Run GREEN verification**

Run the Task 1 test command. Expected: PASS.

- [ ] **Step 6: Commit the invariant**

```bash
rtk git add packages/knowledge-core/src/schema.ts packages/knowledge-core/src/store.ts packages/knowledge-core/src/index.ts tests/knowledge-branch-base.test.mjs
rtk git commit -m "feat(knowledge): enforce one canonical master per repo"
```

### Task 2: Elect master only after the first successful named-branch index

**Files:**
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `tests/knowledge-branch-lifecycle.test.mjs`
- Modify: `tests/knowledge-master-command.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Cover four independent cases:

```js
assert.equal(store.getDefaultBranch(repoId), null);
await indexRepo({ store, rootPath: namedGitRepo, mode: "incremental" });
assert.equal(store.getDefaultBranch(repoId).name, "feature/first");
```

Then prove a held index lock/failing parser leaves `getDefaultBranch(repoId) === null`; detached HEAD and non-Git `(workdir)` also remain unresolved.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-branch-lifecycle.test.mjs tests/knowledge-master-command.test.mjs
```

Expected: the first-success election assertions FAIL.

- [ ] **Step 3: Add post-publication election**

After `markSnapshotReady`, `publishSnapshot`, `recordBranchIndexed`, and live-branch promotion all succeed, call:

```ts
if (git.isGit && git.branch !== "(detached)" && !store.getDefaultBranch(repoId)) {
  store.setDefaultBranch(repoId, branchId);
}
```

Keep this outside failed/rollback paths. Concurrent first indexes rely on the unique index; re-read the winner if another process elected first.

- [ ] **Step 4: Make unresolved state explicit**

Return `canonicalMaster: null` and `masterStatus: "unresolved"` for detached/non-Git repositories. Never silently label `(workdir)` as master.

- [ ] **Step 5: Run GREEN verification**

Run the Task 2 test command. Expected: PASS.

- [ ] **Step 6: Commit first-index election**

```bash
rtk git add packages/knowledge-indexer/src/pipeline.ts tests/knowledge-branch-lifecycle.test.mjs tests/knowledge-master-command.test.mjs
rtk git commit -m "feat(knowledge): elect master after first successful index"
```

### Task 3: Centralize branch-base resolution

**Files:**
- Create: `packages/knowledge-core/src/branch-base.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/knowledge-indexer/src/git-topology.ts`
- Modify: `tests/knowledge-branch-base.test.mjs`

- [ ] **Step 1: Write the resolver contract tests**

Exercise this public contract:

```ts
export type BranchBaseReason =
  | "prior_branch_snapshot"
  | "canonical_master"
  | "git_merge_base"
  | "no_base"
  | "degraded_history";

export interface BranchBaseResolution {
  repoId: string;
  targetBranch: string | null;
  canonicalMaster: string | null;
  baseSnapshotId: string | null;
  baseCommitSha: string | null;
  mergeBaseSha: string | null;
  reason: BranchBaseReason;
  degraded: boolean;
  degradationReason: string | null;
  materializationRequired: boolean;
}
```

Assert same-branch prior snapshot wins; a new feature resolves through Git merge-base; a shallow-history fallback is marked degraded; branch names containing `main` or `master` receive no special treatment.

- [ ] **Step 2: Run RED verification**

Run the Task 1 test command. Expected: FAIL because `resolveBranchBase` is missing.

- [ ] **Step 3: Implement `resolveBranchBase`**

Inputs must include store, repo, target branch/commit, prior snapshot, and a Git topology adapter. Keep parser/file scanning out of this module. Return evidence explaining each decision.

Use this priority exactly:

```text
ready prior snapshot
-> exact ready merge-base snapshot
-> exact merge-base commit with materializationRequired=true
-> canonical master's current ready snapshot (degraded if not exact merge-base)
-> no base
```

- [ ] **Step 4: Add merge-base diagnostics**

Extend topology output with `historyState`, candidate refs, and exact failure reasons such as `shallow_history`, `missing_ref`, and `not_git`. Do not convert missing evidence into high-confidence ancestry.

- [ ] **Step 5: Run GREEN verification**

Run the Task 3 test command. Expected: PASS.

- [ ] **Step 6: Commit the resolver**

```bash
rtk git add packages/knowledge-core/src/branch-base.ts packages/knowledge-core/src/index.ts packages/knowledge-indexer/src/git-topology.ts tests/knowledge-branch-base.test.mjs
rtk git commit -m "feat(knowledge): centralize canonical branch base resolution"
```

### Task 4: Materialize merge bases and make normal index/rebuild/watch produce exact COW overlays

**Files:**
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Create: `packages/knowledge-indexer/src/base-snapshot.ts`
- Modify: `packages/knowledge-core/src/file-fact-store.ts`
- Modify: `tests/knowledge-revision-indexer.test.mjs`
- Modify: `tests/knowledge-branch-lifecycle.test.mjs`

- [ ] **Step 1: Write failing multi-branch manifest tests**

Create `main`, `feature/a`, and `feature/b` commits with unchanged, modified, added, deleted, and renamed files. Index them through `indexRepo`, not only `indexRevision`, and assert:

```js
assert.deepEqual(effectiveManifest(featureA), gitTree(featureACommit));
assert.deepEqual(effectiveManifest(featureB), gitTree(featureBCommit));
assert.deepEqual(overlays(featureA), [
  { operation: "modify", file_path: "src/changed.ts" },
  { operation: "add", file_path: "src/new.ts" },
  { operation: "delete", file_path: "src/removed.ts" },
]);
assert.equal(overlays(featureA).some((row) => row.file_path === "src/shared.ts"), false);
```

Assert indexing branch B does not change branch A's effective manifest or snapshot ID.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-revision-indexer.test.mjs tests/knowledge-branch-lifecycle.test.mjs
```

Expected: FAIL because normal `indexRepo` does not yet share the central base semantics for first snapshots on new branches.

- [ ] **Step 3: Materialize a missing exact merge-base snapshot once**

Implement:

```ts
export async function ensureBaseSnapshot(input: {
  store: KnowledgeStore;
  repoId: string;
  rootPath: string;
  resolution: BranchBaseResolution;
  parserVersion: string;
  resolverVersion: string;
  coordinator: RevisionIndexCoordinator;
}): Promise<BranchBaseResolution>;
```

When `materializationRequired` is true, index the exact `baseCommitSha` as an immutable commit snapshot without publishing a branch pointer. Coalesce concurrent requests by the existing revision coordinator and return the ready snapshot ID. On failure, fall back to canonical master only with explicit degradation evidence.

- [ ] **Step 4: Resolve the base before creating the building snapshot**

Replace direct `prior?.current_snapshot_id` selection in `indexRepo` with `resolveBranchBase`. Pass the returned immutable base to `createBuildingSnapshot` and persist its reason/degradation metadata.

- [ ] **Step 5: Compute overlays from complete manifests**

Build a target path-to-file-fact map for all source files, reusing existing file facts without reparsing where possible. Compare it to `FileFactStore.effectiveManifest(baseSnapshotId)` and emit only exact add/modify/delete operations. Do not label every parsed file `modify` merely because a prior snapshot exists.

- [ ] **Step 6: Rebuild the effective manifest and validate before publish**

Call `replaceOverlay`, then `materializeManifest`. Before publishing, assert target path count and each path's file-fact ID match the target map. On mismatch, mark the building snapshot failed and leave the previous pointer live.

- [ ] **Step 7: Keep checkpoint behavior branch-local**

Continue using `files_index` for fast mtime/size filtering, but never treat a skipped checkpoint as absence from the target manifest. Resolve its existing file-fact ID into the target map.

- [ ] **Step 8: Run GREEN verification**

Run the Task 4 test command. Expected: PASS for all three branches and isolation assertions.

- [ ] **Step 9: Commit normal-path COW**

```bash
rtk git add packages/knowledge-indexer/src/pipeline.ts packages/knowledge-indexer/src/base-snapshot.ts packages/knowledge-core/src/file-fact-store.ts tests/knowledge-revision-indexer.test.mjs tests/knowledge-branch-lifecycle.test.mjs
rtk git commit -m "feat(knowledge): use stable COW overlays for normal indexing"
```

### Task 5: Align materialize with normal indexing and master replacement

**Files:**
- Modify: `packages/knowledge-indexer/src/revision-indexer.ts`
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `tests/knowledge-revision-indexer.test.mjs`
- Modify: `tests/knowledge-master-command.test.mjs`

- [ ] **Step 1: Write failing parity and replacement tests**

Index the same commit once through `indexRepo` and once through `materialize`; assert identical effective path/file-fact mappings and compatible trust metadata. Then switch master and assert all old snapshot rows and branch pointers are byte-for-byte unchanged except default flags.

- [ ] **Step 2: Run RED verification**

Run:

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-revision-indexer.test.mjs tests/knowledge-master-command.test.mjs
```

Expected: parity or metadata assertions FAIL until both paths use the central resolver.

- [ ] **Step 3: Replace local base logic in `indexRevision`**

Remove its direct `default_branch` SQL and consume `resolveBranchBase`. Keep explicit `base.branch`/`base.commitSha` as a higher-priority caller override and include that override in diagnostics.

- [ ] **Step 4: Finalize current-branch CLI semantics**

Support exactly:

```text
penguin master
penguin master <repo>
penguin master <repo> <branch>
```

The no-argument form uses `readGitContext(deps.cwd)` and rejects detached/non-Git contexts. The one-repo form reads that indexed repo's checkout. Return previous and selected master identities in JSON.

- [ ] **Step 5: Run GREEN verification**

Run the Task 5 test command. Expected: PASS.

- [ ] **Step 6: Commit parity and command behavior**

```bash
rtk git add packages/knowledge-indexer/src/revision-indexer.ts packages/knowledge-cli/src/index.ts tests/knowledge-revision-indexer.test.mjs tests/knowledge-master-command.test.mjs
rtk git commit -m "feat(knowledge): align materialize and current-branch master"
```

### Task 6: Expose one truth through CLI, MCP, and Wiki

**Files:**
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src/components/wiki/WikiPage.tsx`
- Modify: `tests/knowledge-mcp-tools.test.mjs`

- [ ] **Step 1: Write failing status/MCP tests**

Assert detailed status contains:

```json
{
  "canonicalMaster": "main",
  "masterStatus": "resolved",
  "branches": [{
    "name": "feature/x",
    "defaultBranch": false,
    "baseSnapshotId": "snapshot_feature_x_001",
    "baseBranch": "main",
    "baseReason": "git_merge_base",
    "degraded": false
  }]
}
```

Assert MCP `set_master_branch` requires explicit repo and branch, replaces the master atomically, and never infers MCP server cwd.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-mcp-tools.test.mjs
```

Expected: FAIL because the explicit MCP mutation and full base metadata are missing.

- [ ] **Step 3: Extend shared status types**

Add `canonicalMaster`, `masterStatus`, `baseSnapshotId`, `baseBranch`, `baseReason`, `mergeBaseCommit`, and degradation fields from actual snapshot rows. Do not derive historical base from the current master flag.

- [ ] **Step 4: Add explicit MCP mutation**

Define `set_master_branch` with required `{ repo, branch }`, resolve names case-sensitively for branches, call the same store transaction as CLI, and return previous/new identities. This tool changes local index metadata only; document that it never checks out Git or triggers indexing.

- [ ] **Step 5: Add Wiki presentation and action**

Show one repository-level master badge or unresolved warning. On branch rows, show actual COW base/reuse separately. Add a confirmed `Set as master` action that calls a Tauri bridge/CLI command with explicit repo and branch and then refreshes status.

- [ ] **Step 6: Run GREEN verification and UI typecheck**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-mcp-tools.test.mjs
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit shared surfaces**

```bash
rtk git add packages/knowledge-core/src/query.ts packages/mcp/src/knowledge-tool-defs.ts packages/mcp/src/knowledge-tools.ts src/lib/knowledge-client.ts src/components/wiki/WikiPage.tsx tests/knowledge-mcp-tools.test.mjs
rtk git commit -m "feat(knowledge): expose canonical master across cli mcp and wiki"
```

### Task 7: Prove recovery, migration, and retention

**Files:**
- Modify: `tests/knowledge-index-recovery-scenarios.test.mjs`
- Modify: `tests/knowledge-revision-retention.test.mjs`
- Modify: `tests/knowledge-file-facts.test.mjs`
- Modify: `packages/knowledge-cli/src/index.ts`

- [ ] **Step 1: Add failing recovery scenarios**

Test all of these independently:

1. Delete SQLite and ledger, index a named branch, and verify it becomes master.
2. Rebuild an existing master and verify the previous pointer remains usable until publish.
3. Delete `effective_snapshot_files`, rebuild it, and compare byte-for-byte path/file-fact mappings.
4. Migrate a database with no default and one with duplicate defaults.
5. Replace master, run GC dry-run/apply, and verify current master plus all referenced branch snapshots survive.
6. Verify Markdown notes and SLS evidence remain searchable after parser rebuild.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-index-recovery-scenarios.test.mjs tests/knowledge-revision-retention.test.mjs tests/knowledge-file-facts.test.mjs
```

Expected: new migration and replacement-retention assertions FAIL.

- [ ] **Step 3: Extend migration dry-run/apply output**

`penguin revisions migrate --dry-run` must report `masterMissing`, `duplicateMasters`, selected repair candidate, and untouched note/ledger counts. `--apply` performs only additive schema repair and required rebuilds, with pointer rollback on failure.

- [ ] **Step 4: Protect canonical and referenced snapshots**

Update retention planning so reasons include `canonical_master`, `live_branch`, `pin`, `deployment`, `reference`, and `recovery_window`. Never protect a historical snapshot merely because its old branch name contains `main`.

- [ ] **Step 5: Run GREEN verification**

Run the Task 7 test command. Expected: PASS.

- [ ] **Step 6: Commit recovery support**

```bash
rtk git add packages/knowledge-cli/src/index.ts tests/knowledge-index-recovery-scenarios.test.mjs tests/knowledge-revision-retention.test.mjs tests/knowledge-file-facts.test.mjs
rtk git commit -m "test(knowledge): cover master cow recovery and retention"
```

### Task 8: Document, benchmark, and run final acceptance

**Files:**
- Modify: `docs/knowledge/revision-storage.md`
- Modify: `docs/knowledge/three-plan-acceptance.md`
- Create: `tests/knowledge-canonical-master-acceptance.test.mjs`

- [ ] **Step 1: Add the fleet-style acceptance fixture**

Create one temporary repo with one master and at least five branches. Include slashes, a branch name containing `master` that is not canonical, renames, deletes, shared files, and independent modifications. Index in two different orders and assert:

- every branch effective manifest equals its Git tree;
- no branch view changes when another is indexed;
- identical file facts are reused;
- overlay rows contain only differences;
- canonical election/replacement follows metadata, not names;
- storage reuse is reported and bounded.

- [ ] **Step 2: Run the acceptance test RED then GREEN**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk node --test tests/knowledge-canonical-master-acceptance.test.mjs
```

Expected final result: PASS.

- [ ] **Step 3: Update operator documentation**

Document:

```bash
penguin index .
penguin master
penguin status --revisions --json
penguin materialize <repo> --branch <branch>
penguin revisions gc <repo> --dry-run
```

Explain that there is no synthetic root branch, changing master is non-destructive, and detached/non-Git indexes require explicit resolution.

- [ ] **Step 4: Update the acceptance matrix**

Map every design acceptance scenario to a real test file and command. Mark live external services as external smoke tests rather than local passes.

- [ ] **Step 5: Run final verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk pnpm typecheck
PATH="/Users/shieng/.nvm/versions/node/v18.20.8/bin:$PATH" rtk pnpm test
rtk git diff --check
rtk git status --short
```

Expected: all builds/tests pass, diff check is clean, and status shows only intentional files plus preserved user changes.

- [ ] **Step 6: Commit documentation and acceptance**

```bash
rtk git add docs/knowledge/revision-storage.md docs/knowledge/three-plan-acceptance.md tests/knowledge-canonical-master-acceptance.test.mjs
rtk git commit -m "docs(knowledge): finalize canonical master cow workflow"
```

## Completion criteria

- First successful named Git branch becomes master exactly once.
- Detached/non-Git indexes do not auto-elect master.
- `penguin master` selects the current branch and safely replaces an existing master.
- Every index path uses the same base resolver and exact overlay algorithm.
- New branches share content without rewriting old snapshots.
- No synthetic root branch or branch-name ancestry inference exists.
- CLI, MCP, Wiki, recovery, migration, and retention expose one consistent truth.
- Full typecheck, full tests, acceptance fixture, and diff check pass.
