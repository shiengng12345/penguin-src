# Penguin Branch Revision and Copy-on-Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Penguin Knowledge answer resolve against one immutable repository revision while sharing unchanged parsed file facts and safely reusing only context-compatible resolved edges across many branches.

**Architecture:** Land revision selection and branch-isolated reads on the current schema first, then introduce immutable Git snapshots, path-sensitive file facts, merge-base overlays, and resolution-context keyed edge sets. Branches become mutable selectors that atomically point to ready snapshots; Markdown notes and ledger events remain durable, while effective manifests and hot revision views are rebuildable caches.

**Tech Stack:** TypeScript, Node 22, SQLite via `better-sqlite3`, Git CLI through `execFileSync`/`execFile`, existing Penguin parser/indexer, MCP SDK, React/Tauri bridge, Node test runner.

## Global Constraints

- Use one physical Knowledge database for all repositories, branches, commits, notes, and evidence.
- A clean Git commit SHA is the stable revision identity; a dirty view is `(HEAD SHA, worktree fingerprint)` and must never masquerade as the clean commit.
- Effective branch state is the immutable merge-base snapshot plus add/modify/delete overlay; never overlay against a moving current `main`/`master` head.
- Resolve the default branch deterministically: explicit repo configuration, then remote symbolic HEAD, then one unambiguous local `main` or `master`; otherwise require an explicit base.
- Use `(repoId, filePath, contentHash, language, parserVersion)` as the initial file-fact reuse key.
- Parsed facts and resolved edges remain separate. Edge reuse requires a resolution-context fingerprint and resolver version.
- Preserve the existing meaning of `branch_id IS NULL`; use an explicit `global` scope for new cross-service facts.
- Correct revision isolation must pass before enabling COW storage reads or retention.
- Catalogue all refs cheaply, but materialize only default, deployed, pinned, hot, or explicitly requested revisions.
- Materialization never runs `pnpm install` and does not require `node_modules`; parse checked-in source, manifests, and lockfiles directly, and retain absent dependency artifacts as explicit unresolved external facts.
- Default retention is 20 hot feature views per repository, 14 cold days, and 30 days of recovery for merged/deleted branch pointers. Default/deployed/pinned/base snapshots are exempt.
- Deployment commits are pinned and historical evidence references immutable commits.
- A failed index cannot publish a partial snapshot, move the branch pointer, or demote the previous live view.
- `no_static_edge` remains a static-graph gap, not proof that DI, reflection, HTTP dispatch, or runtime use is absent.
- Run SQLite tests with Node `v22.22.1`. Do not run `pnpm install --no-frozen-lockfile`; the current dependency/override mismatch must not rewrite the lockfile during this work.
- Preserve unrelated dirty-worktree changes. Each future commit stages only the files named in its task.

---

## File Map

- Create: `packages/knowledge-core/src/revision.ts` — selector resolution, trust, ambiguity, and the shared `RevisionContext` contract.
- Create: `packages/knowledge-core/src/revision-scope.ts` — one legacy/new-storage read-scope abstraction used by every query.
- Create: `packages/knowledge-core/src/git-topology-store.ts` — commits, snapshots, branch pointers, deployment pins, and atomic publication.
- Create: `packages/knowledge-core/src/file-fact-store.ts` — content-addressed path-sensitive parsed facts and snapshot overlays.
- Create: `packages/knowledge-core/src/resolution-store.ts` — context-keyed resolved edge sets and explicit global facts.
- Create: `packages/knowledge-core/src/revision-view.ts` — effective manifests, symbol presence, edge iteration, and rebuildable hot view access.
- Create: `packages/knowledge-core/src/revision-retention.ts` — hot/cold policy, references, and zero-reference collection planning.
- Create: `packages/knowledge-core/src/code-version-resolver.ts` — SLS/deployment/branch-to-commit resolution.
- Modify: `packages/knowledge-core/src/schema.ts` — schema-versioned immutable revision and COW tables.
- Modify: `packages/knowledge-core/src/store.ts` — focused store delegates, cleanup, and compatibility migration helpers.
- Modify: `packages/knowledge-core/src/query.ts` — require one resolved revision for every branch-sensitive reader.
- Modify: `packages/knowledge-core/src/index.ts` — export the new contracts.
- Create: `packages/knowledge-indexer/src/git-topology.ts` — deterministic default branch, ref catalogue, ancestry, merge-base, and tree diff.
- Create: `packages/knowledge-indexer/src/revision-indexer.ts` — build/validate/publish immutable snapshots.
- Create: `packages/knowledge-indexer/src/resolution-context.ts` — exported-symbol/dependency fingerprints and invalidation closure.
- Modify: `packages/knowledge-indexer/src/git.ts` — expose repository Git directory/worktree metadata needed by topology reads.
- Modify: `packages/knowledge-indexer/src/pipeline.ts` — delegate snapshot indexing while retaining parser behavior and progress events.
- Modify: `packages/knowledge-indexer/src/index.ts` — export revision-indexing APIs.
- Modify: `packages/knowledge-cli/src/index.ts` — revision flags, fail-closed defaults, catalogue/materialize/pin/GC commands.
- Modify: `packages/mcp/src/knowledge-tool-defs.ts` — revision selector schemas and returned trust documentation.
- Modify: `packages/mcp/src/knowledge-tools.ts` — resolve one `RevisionContext` before query dispatch.
- Modify: `src/lib/knowledge-client.ts` — revision-aware UI contracts.
- Modify: `src/components/wiki/WikiPage.tsx` — snapshot/cache/base/head/reuse status and explicit revision selection.
- Modify: `src-tauri/src/knowledge.rs` — pass revision flags through the existing CLI bridge.
- Create: `tests/knowledge-revision-context.test.mjs` — deterministic selector and ambiguity behavior.
- Create: `tests/knowledge-revision-isolation.test.mjs` — every query mode stays inside one revision.
- Create: `tests/knowledge-git-topology.test.mjs` — default branch, merge-base, shallow, detached, force-push, and stacked branches.
- Create: `tests/knowledge-file-facts.test.mjs` — path-sensitive sharing and overlay manifests.
- Create: `tests/knowledge-resolution-store.test.mjs` — resolution fingerprint reuse and invalidation.
- Create: `tests/knowledge-revision-indexer.test.mjs` — atomic publication and branch pointer behavior.
- Create: `tests/knowledge-revision-retention.test.mjs` — 20/14/30 defaults, pins, deployments, and GC.
- Create: `tests/knowledge-code-version-resolver.test.mjs` — exact runtime commit and degraded fallback.
- Create: `tests/knowledge-revision-migration.test.mjs` — old-schema rebuild and non-rebuildable data survival.
- Modify: `tests/knowledge-query.test.mjs`, `tests/knowledge-graph-query.test.mjs`, `tests/knowledge-branch-lifecycle.test.mjs`, `tests/pipeline-second-pass.test.mjs`, `tests/knowledge-core-schema.test.mjs`, `tests/knowledge-mcp-tools.test.mjs`, and `tests/wiki-page.test.mjs` — regression coverage at existing public boundaries.

## Delivery Order

Tasks 1–2 are the correctness gate and must merge before Tasks 3–12. Tasks 3–8 build the immutable/COW source of truth behind that gate. Task 9 enables retention only after revision-view parity passes. Tasks 10–12 expose runtime mapping, user surfaces, migration, and acceptance verification.

### Task 1: Resolve one revision and fail closed on ambiguity

**Files:**
- Create: `packages/knowledge-core/src/revision.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/knowledge-cli/src/index.ts:76-96`
- Create: `tests/knowledge-revision-context.test.mjs`

**Interfaces:**
- Consumes: existing `repos`, `branches`, `last_indexed_commit`, live/snapshot status, and worktree trust columns.
- Produces: `RevisionSelector`, `RevisionContext`, `RevisionResolution`, `resolveRevisionContext()`, and `requireRevisionContext()` for every later task.

- [ ] **Step 1: Write the failing selector tests**

Create fixtures for two repositories and these cases:

```js
assert.equal(resolveRevisionContext(store, { repoId, branch: "feature" }).status, "resolved");
assert.equal(resolveRevisionContext(store, { repoId, commitSha: "abc123" }).context.commitSha, "abc123");
assert.equal(resolveRevisionContext(store, { repoId }).context.branch, "main");
assert.equal(resolveRevisionContext(storeWithTwoLiveBranches, { repoId }).status, "ambiguous");
assert.deepEqual(
  resolveRevisionContext(storeWithTwoLiveBranches, { repoId }).candidates.map((c) => c.branch).sort(),
  ["main", "worktree/main"],
);
assert.equal(resolveRevisionContext(store, { repoId, branch: "missing" }).status, "not_found");
```

Also invoke `runCli(["files", repoName, "--json"], deps)` with branches named `aaa-old` and `main`, where only `main` is live. Assert the CLI chooses `main`, proving it no longer uses alphabetical-first fallback.

- [ ] **Step 2: Run RED verification**

Run:

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-context.test.mjs
```

Expected: FAIL because `revision.ts` exports do not exist and the CLI still selects `ORDER BY name LIMIT 1`.

- [ ] **Step 3: Add the exact revision contract**

Implement:

```ts
export interface RevisionSelector {
  repoId: string;
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  worktreeFingerprint?: string;
}

export interface RevisionContext {
  repoId: string;
  branch?: string;
  branchId?: string;
  commitSha: string;
  snapshotId: string;
  mergeBaseSha?: string;
  worktreeFingerprint?: string;
  trust: "exact_commit" | "exact_worktree" | "fallback_live" | "trust_unavailable";
  degradationReason?: string;
}

export type RevisionResolution =
  | { status: "resolved"; context: RevisionContext }
  | { status: "ambiguous"; candidates: RevisionContext[]; reason: string }
  | { status: "not_found"; candidates: RevisionContext[]; reason: string };

export class RevisionResolutionError extends Error {
  constructor(
    readonly status: "ambiguous" | "not_found",
    message: string,
    readonly candidates: RevisionContext[],
  );
}

export function resolveRevisionContext(
  store: KnowledgeStore,
  selector: RevisionSelector,
): RevisionResolution;

export function requireRevisionContext(
  store: KnowledgeStore,
  selector: RevisionSelector,
): RevisionContext {
  const result = resolveRevisionContext(store, selector);
  if (result.status === "resolved") return result.context;
  throw new RevisionResolutionError(result.status, result.reason, result.candidates);
}
```

For the pre-snapshot compatibility path, use `legacy:<branchId>` as `snapshotId`, `last_indexed_commit ?? head_commit ?? "(worktree)"` as `commitSha`, and `fallback_live`/`trust_unavailable` truthfully. Resolution priority is exact snapshot, exact commit, explicit branch, then the sole live branch. Never select by sort order.

- [ ] **Step 4: Replace the CLI's implicit branch resolver**

Change `resolveBranchId()` so omission calls `requireRevisionContext(store, { repoId })` and returns `context.branchId`. Catch `RevisionResolutionError` at the CLI boundary and print bounded candidates plus `--branch`/`--commit` guidance with exit code `2`.

- [ ] **Step 5: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS; omitted branch selects the sole live branch and two live worktrees produce an explicit ambiguity instead of a guess.

- [ ] **Step 6: Commit the correctness primitive**

```bash
rtk git add packages/knowledge-core/src/revision.ts packages/knowledge-core/src/index.ts packages/knowledge-cli/src/index.ts tests/knowledge-revision-context.test.mjs
rtk git commit -m "feat(knowledge): resolve revision context explicitly"
```

### Task 2: Route every branch-sensitive query through one revision scope

**Files:**
- Create: `packages/knowledge-core/src/revision-scope.ts`
- Modify: `packages/knowledge-core/src/query.ts:152-1230`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Create: `tests/knowledge-revision-isolation.test.mjs`
- Modify: `tests/knowledge-query.test.mjs`
- Modify: `tests/knowledge-graph-query.test.mjs`
- Modify: `tests/knowledge-mcp-tools.test.mjs`

**Interfaces:**
- Consumes: `RevisionContext` from Task 1.
- Produces: `RevisionReadScope`, `legacyRevisionScope()`, and revision-aware signatures for search, node detail, graph, flow, context, impact, files, symbols, timeline, recent changes, and compare.

- [ ] **Step 1: Seed contradictory revisions and write failing isolation tests**

Seed `main` with `callerMain -> shared` and `feature` with `callerFeature -> shared`; put different source/signatures for `shared` in each branch. For one resolved context at a time assert:

```js
assert.deepEqual(exploreGraph(store, "who_calls", shared, { revision: mainCtx }).nodes.map((n) => n.title), ["callerMain"]);
assert.deepEqual(exploreGraph(store, "who_calls", shared, { revision: featureCtx }).nodes.map((n) => n.title), ["callerFeature"]);
assert.equal(getNodeDetail(store, shared, { revision: mainCtx }).versions.length, 1);
assert.equal(buildContextPack(store, shared, { revision: featureCtx }).trust.commitSha, "feature-sha");
assert.ok(search(store, "featureOnly", { revision: mainCtx }).every((hit) => hit.title !== "featureOnly"));
```

Cover every `GraphMode`, `buildFlow`, `buildExplorePack`, `graphNeighborhood`, `repoGraph`, `listIndexedFiles`, `listFileSymbols`, `affectedByFiles`, `recent_changes`, and `timeline`. Assert a missing revision on a repo with multiple candidates returns `revision_ambiguous`; it must not run an unscoped edge query.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-isolation.test.mjs tests/knowledge-query.test.mjs tests/knowledge-graph-query.test.mjs
```

Expected: FAIL because query functions have mixed `branch_id` handling and do not accept one shared revision.

- [ ] **Step 3: Add the central legacy read scope**

Implement:

```ts
export interface RevisionReadScope {
  revision: RevisionContext;
  edgeSql(alias?: string): { sql: string; params: unknown[] };
  symbolSql(alias?: string): { sql: string; params: unknown[] };
  fileSql(alias?: string): { sql: string; params: unknown[] };
}

export function legacyRevisionScope(revision: RevisionContext): RevisionReadScope {
  if (!revision.branchId) throw new Error("legacy revision scope requires branchId");
  return {
    revision,
    edgeSql(alias = "edges") {
      return { sql: `(${alias}.branch_id = ? OR ${alias}.branch_id IS NULL)`, params: [revision.branchId] };
    },
    symbolSql(alias = "symbol_versions") {
      return { sql: `${alias}.branch_id = ?`, params: [revision.branchId] };
    },
    fileSql(alias = "files_index") {
      return { sql: `${alias}.branch_id = ?`, params: [revision.branchId] };
    },
  };
}
```

No query function may hand-build its own branch predicate after this task. `branch_id IS NULL` is admitted only by `edgeSql()` for legacy global gRPC facts.

- [ ] **Step 4: Thread `revision` through all public query entry points**

Use one option shape consistently:

```ts
export interface RevisionQueryOptions {
  revision: RevisionContext;
  limit?: number;
}
```

Update search structural-node filtering, FTS symbol presence, all graph traversals, final edge collection, context subqueries, flow expansion, files/symbols, and recent/timeline filters. Return the same `RevisionContext` as `revision`/`trust` metadata in every branch-aware result. Preserve repo-less notes and explicitly global endpoint identities without allowing another branch's version rows.

- [ ] **Step 5: Make CLI and MCP resolve before dispatch**

Add `repo`, `branch`, `commit_sha`, and `snapshot_id` selectors to branch-sensitive MCP schemas. In `handleKnowledgeTool()`, resolve once and pass the returned context to the query; on ambiguity return:

```ts
{
  error: "revision_ambiguous",
  reason: resolution.reason,
  candidates: resolution.candidates.map(({ repoId, branch, commitSha, snapshotId, trust }) => ({
    repoId, branch, commitSha, snapshotId, trust,
  })),
}
```

Do not independently re-resolve inside graph/context/flow helpers.

- [ ] **Step 6: Run GREEN isolation and MCP regressions**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/mcp build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-isolation.test.mjs tests/knowledge-query.test.mjs tests/knowledge-graph-query.test.mjs tests/knowledge-mcp-tools.test.mjs
```

Expected: PASS; no result contains a symbol version or revision-scoped edge from the sibling branch.

- [ ] **Step 7: Commit the revision-isolation gate**

```bash
rtk git add packages/knowledge-core/src/revision-scope.ts packages/knowledge-core/src/query.ts packages/knowledge-core/src/index.ts packages/mcp/src/knowledge-tool-defs.ts packages/mcp/src/knowledge-tools.ts tests/knowledge-revision-isolation.test.mjs tests/knowledge-query.test.mjs tests/knowledge-graph-query.test.mjs tests/knowledge-mcp-tools.test.mjs
rtk git commit -m "fix(knowledge): isolate every query by revision"
```

### Task 3: Add immutable Git topology and snapshot storage

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts:18-338`
- Create: `packages/knowledge-core/src/git-topology-store.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/revision.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `tests/knowledge-core-schema.test.mjs`
- Create: `tests/knowledge-git-topology.test.mjs`

**Interfaces:**
- Consumes: Task 1 revision contracts.
- Produces: immutable commits/snapshots, branch pointers, deployment references, and atomic `publishSnapshot()`.

- [ ] **Step 1: Write failing schema and store tests**

Assert a fresh DB contains `git_commits`, `revision_snapshots`, `deployment_revisions`, and new branch pointer columns. Assert two branch names can point to the same snapshot, publishing a building snapshot is rejected, and a transaction failure leaves the previous pointer untouched.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-core-schema.test.mjs tests/knowledge-git-topology.test.mjs
```

Expected: FAIL with missing tables/columns and missing `GitTopologyStore` exports.

- [ ] **Step 3: Add the complete topology DDL and migrate additively**

Bump `SCHEMA_VERSION` from `6` to `7` and add:

```sql
CREATE TABLE IF NOT EXISTS git_commits (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree_hash TEXT,
  parent_shas TEXT NOT NULL DEFAULT '[]',
  committed_at TEXT,
  history_state TEXT NOT NULL DEFAULT 'complete',
  PRIMARY KEY (repo_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS revision_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_key TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  commit_sha TEXT,
  worktree_fingerprint TEXT,
  parser_version TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  base_snapshot_id TEXT,
  merge_base_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('building','ready','failed','cold')),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  last_accessed_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_revision_snapshots_repo_commit
  ON revision_snapshots(repo_id, commit_sha);

CREATE TABLE IF NOT EXISTS deployment_revisions (
  target_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  deployed_from TEXT NOT NULL,
  deployed_to TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (target_id, repo_id, deployed_from)
);

CREATE TABLE IF NOT EXISTS revision_references (
  ref_type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  snapshot_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ref_type, ref_key, repo_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_revision_references_snapshot
  ON revision_references(snapshot_id);
```

Add guarded columns to `branches`: `default_branch INTEGER NOT NULL DEFAULT 0`, `base_branch_name TEXT`, `merge_base_commit TEXT`, `current_snapshot_id TEXT`, `last_accessed_at TEXT`, `deleted_at TEXT`, and `recover_until TEXT`. Mirror every migration guard in `isSchemaCurrent()` because the steady-state open path must remain write-free.

- [ ] **Step 4: Implement topology store methods**

Export:

```ts
export interface GitCommitRecord {
  repoId: string;
  commitSha: string;
  treeHash?: string;
  parentShas: string[];
  committedAt?: string;
  historyState: "complete" | "shallow" | "missing_history";
}

export interface CreateSnapshotInput {
  snapshotKey: string;
  repoId: string;
  commitSha?: string;
  worktreeFingerprint?: string;
  parserVersion: string;
  resolverVersion: string;
  schemaVersion: number;
  baseSnapshotId?: string;
  mergeBaseSha?: string;
}

export interface RevisionSnapshot extends CreateSnapshotInput {
  id: string;
  state: "building" | "ready" | "failed" | "cold";
  failureReason?: string;
  createdAt: string;
  publishedAt?: string;
  lastAccessedAt: string;
  pinned: boolean;
}

export interface DeploymentRevision {
  targetId: string;
  repoId: string;
  commitSha: string;
  deployedFrom: string;
  deployedTo?: string;
  source: string;
}

export interface RevisionReference {
  refType: "evidence_note" | "api_doc_draft" | "api_doc_conflict" | "manual";
  refKey: string;
  repoId: string;
  commitSha: string;
  snapshotId?: string;
}

export class GitTopologyStore {
  constructor(private readonly store: KnowledgeStore) {}
  upsertCommit(input: GitCommitRecord): void;
  createBuildingSnapshot(input: CreateSnapshotInput): RevisionSnapshot;
  markSnapshotReady(snapshotId: string): void;
  publishSnapshot(input: { branchId: string; snapshotId: string; headCommit: string | null }): void;
  pointBranchAtSnapshot(branchId: string, snapshotId: string): void;
  pinDeployment(input: DeploymentRevision): void;
  retainRevisionReference(input: RevisionReference): void;
  releaseRevisionReference(input: RevisionReference): void;
  referencesForRevision(repoId: string, commitSha: string): RevisionReference[];
  snapshotsForCommit(repoId: string, commitSha: string): RevisionSnapshot[];
}
```

Compute `snapshotKey` from canonical JSON of `(repoId, commitSha|null, worktreeFingerprint|null, parserVersion, resolverVersion, schemaVersion)`. Require exactly one clean commit identity or matching commit+worktree fingerprint; two branch names at the same clean commit/version tuple reuse the same row, while parser/resolver/schema changes or a different dirty fingerprint create a new immutable snapshot. `publishSnapshot()` must run one SQLite transaction that verifies `state='ready'`, updates the branch pointer/head/index metadata, and preserves the previous ready snapshot until the update succeeds. Generic references are idempotent by `(refType, refKey, repoId, commitSha)` and may exist before materialization; when a matching snapshot becomes ready, attach its `snapshot_id` transactionally. Release requires the exact same reference identity and never removes a different note/draft/conflict's protection.

- [ ] **Step 5: Upgrade exact revision resolution**

Resolve exact `snapshotId` and commit selectors from `revision_snapshots`; return `exact_commit` for clean ready snapshots and `exact_worktree` only when the requested fingerprint matches. Keep the `legacy:<branchId>` path only for branches not yet rebuilt under schema 7 and label it `fallback_live`.

- [ ] **Step 6: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS, including two branches sharing one ready snapshot and rollback-safe pointer publication.

- [ ] **Step 7: Commit immutable topology storage**

```bash
rtk git add packages/knowledge-core/src/schema.ts packages/knowledge-core/src/git-topology-store.ts packages/knowledge-core/src/store.ts packages/knowledge-core/src/revision.ts packages/knowledge-core/src/index.ts tests/knowledge-core-schema.test.mjs tests/knowledge-git-topology.test.mjs
rtk git commit -m "feat(knowledge): store immutable revision snapshots"
```

### Task 4: Catalogue refs and compute deterministic bases and overlays

**Files:**
- Create: `packages/knowledge-indexer/src/git-topology.ts`
- Modify: `packages/knowledge-indexer/src/git.ts`
- Modify: `packages/knowledge-indexer/src/index.ts`
- Modify: `tests/knowledge-git-topology.test.mjs`

**Interfaces:**
- Consumes: `GitTopologyStore` from Task 3.
- Produces: `GitRefCatalogue`, `ResolvedRevisionTopology`, `catalogGitRefs()`, `resolveDefaultBranch()`, and `resolveRevisionTopology()`.

- [ ] **Step 1: Add real-Git topology fixtures**

Create temporary repositories covering explicit configured default, `refs/remotes/origin/HEAD`, unambiguous local `main`, ambiguous `main` plus `master`, stacked feature branches, detached HEAD, force-pushed head, and a shallow clone with missing merge-base. Read a non-checked-out feature commit through Git objects and assert the active worktree branch/files remain byte-identical. Assert:

```js
assert.equal(resolveDefaultBranch(repo, { configured: "trunk" }).name, "trunk");
assert.equal(resolveRevisionTopology(repo, { branch: "feature/a" }).mergeBaseSha, baseCommit);
assert.equal(resolveRevisionTopology(repo, { branch: "feature/b" }, { indexedAncestors: ["feature/a"] }).baseBranch, "feature/a");
assert.equal(resolveDefaultBranch(ambiguousRepo, {}).status, "explicit_base_required");
assert.equal(resolveRevisionTopology(shallowRepo, { branch: "feature" }).historyState, "missing_history");
```

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-indexer build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-git-topology.test.mjs
```

Expected: FAIL because topology exports do not exist.

- [ ] **Step 3: Implement Git commands with argument arrays**

Use `execFileSync("git", ["-C", root, ...args])`; never compose a shell command. Export:

```ts
export interface GitRefEntry {
  fullName: string;
  shortName: string;
  kind: "local" | "remote" | "tag";
  commitSha: string;
}

export interface GitRefCatalogue {
  refs: GitRefEntry[];
  remoteHead?: string;
  shallow: boolean;
}

export type DefaultBranchResolution =
  | { status: "resolved"; name: string; source: "config" | "remote_head" | "local_main" | "local_master" }
  | { status: "explicit_base_required"; candidates: string[]; reason: string };

export interface ResolvedRevisionTopology {
  repoRoot: string;
  branch?: string;
  headSha: string;
  treeHash: string;
  parentShas: string[];
  defaultBranch?: string;
  baseBranch?: string;
  mergeBaseSha?: string;
  ahead: number | null;
  behind: number | null;
  historyState: "complete" | "shallow" | "missing_history";
  sourceKind: "git_tree" | "worktree";
  worktreeFingerprint?: string;
  dirtyFiles: string[];
}

export interface ResolveRevisionTopologyOptions {
  configuredDefault?: string;
  explicitBase?: string;
  indexedAncestors?: string[];
  includeDirtyWorktree?: boolean;
}

export interface GitTreeFile {
  path: string;
  blobSha: string;
  mode: string;
}

export class GitObjectReader {
  constructor(repoRoot: string);
  listTree(commitSha: string): GitTreeFile[];
  readBlob(blobSha: string): Buffer;
  readTextAtCommit(commitSha: string, filePath: string): string | null;
}

export function catalogGitRefs(repoRoot: string): GitRefCatalogue;
export function resolveDefaultBranch(
  repoRoot: string,
  options: { configured?: string },
): DefaultBranchResolution;
export function resolveRevisionTopology(
  repoRoot: string,
  revision: { branch?: string; commitSha?: string; useWorktree?: boolean },
  options?: ResolveRevisionTopologyOptions,
): ResolvedRevisionTopology;
```

Catalogue local/remote refs without materializing them. Use `git symbolic-ref refs/remotes/origin/HEAD`, `git merge-base`, `git rev-list --left-right --count`, `git ls-tree -r`, `git cat-file blob`, and `git diff --name-status -M` only after the target revision/base has been selected. Clean branch/commit materialization reads blobs from the Git object database and never checks out, switches, resets, or mutates the user's worktree. Filesystem reads are allowed only for an explicitly selected dirty active worktree and are bound to its computed fingerprint.

- [ ] **Step 4: Normalize overlay operations**

Return exact operations:

```ts
export type TreeOverlayOperation =
  | { op: "add" | "modify"; path: string; blobSha: string }
  | { op: "delete"; path: string }
  | { op: "rename"; from: string; path: string; blobSha: string };
```

The storage layer will persist rename as delete plus add and a separate alias event. A missing merge-base returns `missing_history`; it never silently substitutes current default HEAD.

- [ ] **Step 5: Run GREEN topology tests**

Run the Step 2 command again.

Expected: PASS for all default/base/stacked/shallow/detached/force-push fixtures.

- [ ] **Step 6: Commit Git topology discovery**

```bash
rtk git add packages/knowledge-indexer/src/git-topology.ts packages/knowledge-indexer/src/git.ts packages/knowledge-indexer/src/index.ts tests/knowledge-git-topology.test.mjs
rtk git commit -m "feat(knowledge): catalogue git revisions and merge bases"
```

### Task 5: Store path-sensitive file facts and merge-base overlays

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts`
- Create: `packages/knowledge-core/src/file-fact-store.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Create: `tests/knowledge-file-facts.test.mjs`

**Interfaces:**
- Consumes: ready immutable snapshots from Task 3 and tree operations from Task 4.
- Produces: `FileFactStore`, deterministic file-fact identities, overlay writes, tombstones, and effective manifests.

- [ ] **Step 1: Write failing fact-sharing and overlay tests**

Test all of these independently:

```js
assert.equal(upsertSameFactTwice(), oneFileFactRow);
assert.notEqual(factId({ path: "a.ts", hash: "same" }), factId({ path: "b.ts", hash: "same" }));
assert.deepEqual([...view(basePlusFeature)].map(([path]) => path).sort(), ["added.ts", "kept.ts", "modified.ts"]);
assert.equal(view(basePlusFeature).has("deleted.ts"), false);
assert.equal(view(featureAfterMainAdvanced).get("kept.ts"), factFromOriginalMergeBase);
assert.deepEqual(renameOps, [
  { op: "delete", path: "old.ts", fileFactId: null },
  { op: "add", path: "new.ts", fileFactId: renamedFactId },
]);
assert.deepEqual(renameEventsFor(featureSnapshot), [{ fromPath: "old.ts", toPath: "new.ts", contentHash: renamedContentHash }]);
```

The `featureAfterMainAdvanced` assertion is the non-negotiable regression: advancing `main` after the feature's merge-base must not change the feature's effective inherited files.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-file-facts.test.mjs
```

Expected: FAIL because file facts and overlays do not exist.

- [ ] **Step 3: Add the file-fact schema boundary**

Bump `SCHEMA_VERSION` from `7` to `8` and add:

```sql
CREATE TABLE IF NOT EXISTS file_facts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  exports_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, file_path, content_hash, language, parser_version)
);

CREATE TABLE IF NOT EXISTS file_fact_symbols (
  file_fact_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (file_fact_id, identity_key)
);

CREATE TABLE IF NOT EXISTS snapshot_overlays (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add','modify','delete')),
  file_fact_id TEXT,
  renamed_from TEXT,
  PRIMARY KEY (snapshot_id, file_path),
  CHECK (
    (operation = 'delete' AND file_fact_id IS NULL) OR
    (operation IN ('add','modify') AND file_fact_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS effective_snapshot_files (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_fact_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file_path)
);

CREATE TABLE IF NOT EXISTS snapshot_rename_events (
  snapshot_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  file_fact_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, from_path, to_path)
);
```

`effective_snapshot_files` is a disposable pointer cache. `file_facts` and `snapshot_overlays` are the reproducible COW model.

- [ ] **Step 4: Implement deterministic fact and overlay APIs**

Export:

```ts
export interface FileFactSymbol {
  identityKey: string;
  title: string;
  kind: string;
  signature?: string;
  startLine?: number;
  endLine?: number;
  contentHash: string;
}

export interface ParsedImportFact {
  specifier: string;
  importedNames: string[];
  kind: "static" | "dynamic" | "type_only";
}

export interface ParsedReferenceFact {
  rawTarget: string;
  edgeType: string;
  sourceIdentityKey?: string;
  line?: number;
}

export interface ParsedEndpointFact {
  endpointKey: string;
  protocol: string;
  service?: string;
  method?: string;
  route?: string;
  sourceIdentityKey?: string;
}

export interface ParsedLogSiteFact {
  level?: string;
  template: string;
  sourceIdentityKey?: string;
  line?: number;
}

export interface ParsedFileFact {
  repoId: string;
  filePath: string;
  contentHash: string;
  language: string;
  parserVersion: string;
  exportsHash: string;
  symbols: FileFactSymbol[];
  imports: ParsedImportFact[];
  unresolvedReferences: ParsedReferenceFact[];
  endpoints: ParsedEndpointFact[];
  logSites: ParsedLogSiteFact[];
}

export type SnapshotOverlayEntry =
  | { op: "add" | "modify"; path: string; fileFactId: string; renamedFrom?: string }
  | { op: "delete"; path: string; fileFactId: null };

export interface SnapshotRenameEvent {
  snapshotId: string;
  fromPath: string;
  toPath: string;
  fileFactId: string;
  contentHash: string;
}

export class FileFactStore {
  upsertFileFact(fact: ParsedFileFact): string;
  replaceOverlay(snapshotId: string, entries: SnapshotOverlayEntry[]): void;
  replaceRenameEvents(snapshotId: string, events: SnapshotRenameEvent[]): void;
  effectiveManifest(snapshotId: string): Map<string, string>;
  materializeManifest(snapshotId: string): number;
}
```

Derive the fact ID from canonical JSON of exactly `[repoId, filePath, contentHash, language, parserVersion]`. Assemble a view recursively from immutable `base_snapshot_id`, then apply tombstones/additions. Detect base cycles and fail before publishing. Persist every detected rename as delete+add plus one `snapshot_rename_events` row; alias/history consumers read the stable event rather than inferring a rename later from mutable branch state.

- [ ] **Step 5: Verify rebuildable materialization**

Delete all rows from `effective_snapshot_files`, call `materializeManifest(snapshotId)`, and assert the rebuilt manifest is byte-for-byte identical to the pre-delete manifest.

- [ ] **Step 6: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS for sharing, path sensitivity, add/modify/delete/rename, moving-main isolation, and cache rebuild.

- [ ] **Step 7: Commit file-fact COW storage**

```bash
rtk git add packages/knowledge-core/src/schema.ts packages/knowledge-core/src/file-fact-store.ts packages/knowledge-core/src/store.ts packages/knowledge-core/src/index.ts tests/knowledge-file-facts.test.mjs
rtk git commit -m "feat(knowledge): add file-fact copy-on-write overlays"
```

### Task 6: Separate parsed facts from context-keyed resolution sets

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts`
- Create: `packages/knowledge-core/src/resolution-store.ts`
- Create: `packages/knowledge-indexer/src/resolution-context.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/knowledge-indexer/src/index.ts`
- Create: `tests/knowledge-resolution-store.test.mjs`
- Modify: `tests/pipeline-second-pass.test.mjs`

**Interfaces:**
- Consumes: `ParsedFileFact` and effective manifests from Task 5.
- Produces: deterministic context fingerprints, reusable resolved edge sets, explicit global facts, and dependent invalidation.

- [ ] **Step 1: Write failing resolver-context tests**

Use identical `consumer.ts` bytes in two snapshots, but expose `run()` from different imported modules. Assert the file fact ID is shared while resolution set IDs differ and each branch points to the correct callee. Also assert unchanged dependent files are invalidated when an imported file's `exportsHash` changes.

```js
assert.equal(mainConsumer.fileFactId, featureConsumer.fileFactId);
assert.notEqual(mainConsumer.resolutionSetId, featureConsumer.resolutionSetId);
assert.equal(edgeTarget(mainConsumer), mainRunNode);
assert.equal(edgeTarget(featureConsumer), featureRunNode);
assert.deepEqual(invalidationClosure(changedExporter), ["consumer.ts", "transitive.ts"]);
assert.notEqual(contextForSameImportsWithDifferentAmbientSymbols.main, contextForSameImportsWithDifferentAmbientSymbols.feature);
```

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-indexer build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-resolution-store.test.mjs tests/pipeline-second-pass.test.mjs
```

Expected: FAIL because resolution sets and context fingerprints do not exist.

- [ ] **Step 3: Add normalized resolution storage**

Bump `SCHEMA_VERSION` from `8` to `9` and add:

```sql
CREATE TABLE IF NOT EXISTS resolution_sets (
  id TEXT PRIMARY KEY,
  file_fact_id TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (file_fact_id, context_fingerprint, resolver_version)
);

CREATE TABLE IF NOT EXISTS resolved_edges (
  id TEXT PRIMARY KEY,
  resolution_set_id TEXT NOT NULL,
  src_identity_key TEXT NOT NULL,
  dst_identity_key TEXT,
  raw_target TEXT,
  edge_type TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_resolved_edges_set ON resolved_edges(resolution_set_id);

CREATE TABLE IF NOT EXISTS snapshot_resolution_refs (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  resolution_set_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file_path)
);

CREATE TABLE IF NOT EXISTS global_resolved_edges (
  id TEXT PRIMARY KEY,
  producer_key TEXT NOT NULL,
  src_identity_key TEXT NOT NULL,
  dst_identity_key TEXT,
  raw_target TEXT,
  edge_type TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}',
  UNIQUE (producer_key, src_identity_key, dst_identity_key, edge_type)
);
```

`global_resolved_edges` is explicit global scope. New COW code must never infer global visibility from a null branch or snapshot ID.

- [ ] **Step 4: Implement context fingerprints and invalidation**

Export:

```ts
export interface ResolutionContextInput {
  fileFactId: string;
  imports: Array<{ specifier: string; resolvedPath: string | null; exportsHash: string | null }>;
  ambientSymbolSurfaceHash: string;
  resolverConfigHash: string;
  resolverVersion: string;
}

export function resolutionContextFingerprint(input: ResolutionContextInput): string {
  return sha256Hex(canonicalJson({
    fileFactId: input.fileFactId,
    imports: [...input.imports].sort((a, b) => a.specifier.localeCompare(b.specifier)),
    ambientSymbolSurfaceHash: input.ambientSymbolSurfaceHash,
    resolverConfigHash: input.resolverConfigHash,
    resolverVersion: input.resolverVersion,
  }));
}

export function dependentInvalidationClosure(
  changedPaths: Set<string>,
  reverseImports: Map<string, Set<string>>,
): Set<string>;

export interface ResolvedEdgeFact {
  srcIdentityKey: string;
  dstIdentityKey?: string;
  rawTarget?: string;
  edgeType: string;
  method: string;
  confidence: number;
  provenance: Record<string, unknown>;
}

export interface ResolutionSetRecord {
  id: string;
  fileFactId: string;
  contextFingerprint: string;
  resolverVersion: string;
}

export class ResolutionStore {
  findReusableSet(input: { fileFactId: string; contextFingerprint: string; resolverVersion: string }): ResolutionSetRecord | null;
  replaceResolutionSet(input: { fileFactId: string; contextFingerprint: string; resolverVersion: string; edges: ResolvedEdgeFact[] }): ResolutionSetRecord;
  attachSnapshotResolution(input: { snapshotId: string; filePath: string; resolutionSetId: string }): void;
  replaceGlobalProducerEdges(producerKey: string, edges: ResolvedEdgeFact[]): void;
  deleteUnreferencedResolutionSets(olderThan: Date): string[];
}
```

The closure includes changed files and all transitive importers. `ambientSymbolSurfaceHash` covers non-import/global candidates that the current resolver may consult; `resolverConfigHash` covers path aliases/module-resolution settings. The second resolution pass remains mandatory for unresolved names whose candidates appear after the first pass. Reuse is forbidden if either broader context hash differs, even when source/import bytes are identical.

- [ ] **Step 5: Implement `ResolutionStore`**

Implement the exact `ResolutionStore` contract from Step 4. Every edge set replacement is one transaction. A cache hit is allowed only when file-fact ID, complete context fingerprint, and resolver version all match.

- [ ] **Step 6: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS; same source shares parse facts, divergent context does not share wrong edges, changed exports relink unchanged consumers, and second-pass fixtures remain green.

- [ ] **Step 7: Commit context-safe edge reuse**

```bash
rtk git add packages/knowledge-core/src/schema.ts packages/knowledge-core/src/resolution-store.ts packages/knowledge-indexer/src/resolution-context.ts packages/knowledge-core/src/index.ts packages/knowledge-indexer/src/index.ts tests/knowledge-resolution-store.test.mjs tests/pipeline-second-pass.test.mjs
rtk git commit -m "feat(knowledge): key resolved edges by symbol context"
```

### Task 7: Build, validate, and atomically publish immutable revisions

**Files:**
- Create: `packages/knowledge-indexer/src/file-facts.ts`
- Create: `packages/knowledge-indexer/src/revision-indexer.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts:568-830`
- Modify: `packages/knowledge-indexer/src/index.ts`
- Modify: `tests/knowledge-branch-lifecycle.test.mjs`
- Create: `tests/knowledge-revision-indexer.test.mjs`

**Interfaces:**
- Consumes: topology, file facts, overlays, and resolution sets from Tasks 3–6.
- Produces: `indexRevision()` and a compatibility `indexRepo()` that publishes only validated ready snapshots.

- [ ] **Step 1: Write failing end-to-end revision-index tests**

Cover clean commit, dirty worktree, 5% feature diff, two branches at one commit, missing merge-base full fallback, export invalidation, concurrent same-revision requests, and injected failure before publication. Assert:

```js
assert.equal(twoBranches.snapshotIds.size, 1);
assert.ok(feature.report.reusedFileFacts >= Math.floor(feature.report.totalFiles * 0.95));
assert.equal(afterInjectedFailure.branch.current_snapshot_id, beforeSnapshotId);
assert.equal(afterInjectedFailure.partialReadyRows, 0);
assert.equal(dirty.context.trust, "exact_worktree");
assert.notEqual(dirty.context.snapshotId, clean.context.snapshotId);
assert.equal(await Promise.all([materialize(key), materialize(key)]).then(uniqueJobCount), 1);
```

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-indexer build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-indexer.test.mjs tests/knowledge-branch-lifecycle.test.mjs
```

Expected: FAIL because immutable revision indexing is not wired.

- [ ] **Step 3: Extract deterministic file facts before DB resolution**

Implement:

```ts
export interface IndexRevisionInput {
  store: KnowledgeStore;
  rootPath: string;
  repoId: string;
  revision: { branch?: string; commitSha?: string; useWorktree?: boolean };
  base?: { branch?: string; commitSha?: string };
  publishBranchId?: string;
  parserVersion: string;
  resolverVersion: string;
  coordinator: RevisionIndexCoordinator;
}

export interface IndexRevisionReport {
  context: RevisionContext;
  totalFiles: number;
  changedFiles: number;
  reusedFileFacts: number;
  resolvedFiles: number;
  reusePercent: number;
  publishedBranchId?: string;
  degradationReason?: string;
}

export class RevisionIndexCoordinator {
  runExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export async function extractFileFact(input: {
  repoId: string;
  rootPath: string;
  relPath: string;
  source: string;
  contentHash: string;
}): Promise<ParsedFileFact>;
```

Reuse the existing tree-sitter/proto/log/endpoint extractors, but return declarations/imports/unresolved references instead of immediately writing branch edges. Sort arrays before hashing so the same inputs produce identical `facts_json`. For clean branches/commits, source bytes come only from Task 4's `GitObjectReader`; never checkout the target branch. For `useWorktree`, verify the active checkout still matches the captured HEAD/fingerprint before and after reading or fail without publication.

- [ ] **Step 4: Implement the snapshot build pipeline**

Use this exact phase order:

```ts
export async function indexRevision(input: IndexRevisionInput): Promise<IndexRevisionReport> {
  const topology = resolveRevisionTopology(input.rootPath, input.revision, {
    explicitBase: input.base?.branch ?? input.base?.commitSha,
    includeDirtyWorktree: input.revision.useWorktree === true,
  });
  return input.coordinator.runExclusive(revisionKey(topology), async () => {
    const snapshot = topologyStore.createBuildingSnapshot(snapshotInput(topology));
    try {
    const overlay = await buildOverlayAndFacts(snapshot, topology, input);
    const changedExports = compareExportSurfaces(snapshot.baseSnapshotId, overlay);
    const invalidated = dependentInvalidationClosure(changedExports, overlay.reverseImports);
    await resolveSnapshotFiles(snapshot, invalidated, input);
    validateRevisionSnapshot(snapshot.id);
    topologyStore.markSnapshotReady(snapshot.id);
    if (input.publishBranchId) {
      topologyStore.publishSnapshot({ branchId: input.publishBranchId, snapshotId: snapshot.id, headCommit: topology.headSha });
    }
    return reportRevisionIndex(snapshot.id);
  } catch (error) {
    markSnapshotFailedIfCreated(error);
    throw error;
    }
  });
}
```

Implement the named helpers as private functions in `revision-indexer.ts`; none may move the branch pointer. `publishBranchId` is optional so an exact historical commit can be materialized without fabricating a branch. For `missing_history`, create a base-less bounded full snapshot, set degradation reason `missing_history`, and preserve the explicit trust gap. Tests must assert materializing 100 non-checked-out refs never changes `git symbolic-ref --short HEAD`, index contents, or worktree bytes.

- [ ] **Step 5: Keep `indexRepo()` as the public compatibility entry**

Retain existing progress phases and report counters. Have `indexRepo()` resolve the active checkout selector and delegate to `indexRevision()`. Do not delete legacy tables in this task; Task 12 performs migration/rebuild cleanup.

- [ ] **Step 6: Run GREEN failed-run and reuse verification**

Run the Step 2 command again.

Expected: PASS; the old pointer remains queryable throughout a build, identical revision requests share one job, and only ready snapshots publish.

- [ ] **Step 7: Commit atomic revision indexing**

```bash
rtk git add packages/knowledge-indexer/src/file-facts.ts packages/knowledge-indexer/src/revision-indexer.ts packages/knowledge-indexer/src/pipeline.ts packages/knowledge-indexer/src/index.ts tests/knowledge-branch-lifecycle.test.mjs tests/knowledge-revision-indexer.test.mjs
rtk git commit -m "feat(knowledge): publish immutable revision indexes atomically"
```

### Task 8: Read effective COW views without legacy branch rows

**Files:**
- Create: `packages/knowledge-core/src/revision-view.ts`
- Modify: `packages/knowledge-core/src/revision-scope.ts`
- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `tests/knowledge-revision-isolation.test.mjs`
- Modify: `tests/knowledge-query.test.mjs`
- Modify: `tests/knowledge-graph-query.test.mjs`
- Modify: `tests/knowledge-revision-indexer.test.mjs`

**Interfaces:**
- Consumes: ready snapshot manifests, file-fact symbols, snapshot resolution refs, and global edges.
- Produces: `RevisionView` and storage-neutral query behavior.

- [ ] **Step 1: Add parity and no-legacy-row tests**

Build the same fixture once through legacy rows and once through revision storage. Compare normalized outputs for search, node, graph modes, context, flow, files, symbols, routes, tests, and impact. Then delete the fixture's legacy `symbol_versions/files_index/edges` rows and assert the revision outputs remain identical.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-isolation.test.mjs tests/knowledge-query.test.mjs tests/knowledge-graph-query.test.mjs tests/knowledge-revision-indexer.test.mjs
```

Expected: FAIL after legacy rows are removed because queries still read the old tables.

- [ ] **Step 3: Implement the storage-neutral view**

Export:

```ts
export interface RevisionFileRow {
  filePath: string;
  fileFactId: string;
  contentHash: string;
  language: string;
}

export interface RevisionSymbolRow {
  nodeId: string;
  identityKey: string;
  title: string;
  kind: string;
  signature?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  contentHash: string;
}

export interface RevisionEdgeFilter {
  nodeIds?: string[];
  edgeTypes?: string[];
  direction?: "in" | "out" | "both";
  limit?: number;
}

export interface RevisionEdgeRow {
  id: string;
  srcIdentityKey: string;
  dstIdentityKey?: string;
  rawTarget?: string;
  edgeType: string;
  method: string;
  confidence: number;
  provenance: Record<string, unknown>;
  scope: "revision" | "global" | "legacy_global";
}

export interface RevisionView {
  readonly context: RevisionContext;
  listFiles(): RevisionFileRow[];
  symbolVersions(nodeIds?: string[]): RevisionSymbolRow[];
  hasNode(nodeId: string): boolean;
  edges(filter: RevisionEdgeFilter): RevisionEdgeRow[];
  touch(): void;
}

export function openRevisionView(store: KnowledgeStore, context: RevisionContext): RevisionView;
```

For schema-9 snapshots, derive symbols from `effective_snapshot_files -> file_fact_symbols` and edges from `snapshot_resolution_refs -> resolved_edges`, then union explicit `global_resolved_edges`. For `legacy:*`, delegate to `legacyRevisionScope()`.

- [ ] **Step 4: Refactor query functions to use `RevisionView`**

Replace direct branch-table reads in all branch-sensitive query functions. Keep SQL batching inside `RevisionView` so graph calls do not issue one query per node. Apply deterministic ordering before limits: edge type priority, then source identity, destination identity, and edge ID.

- [ ] **Step 5: Verify branchless compatibility and explicit global scope**

Assert legacy `branch_id IS NULL` gRPC edges remain visible only through the compatibility reader, while new snapshots see equivalent entries only from `global_resolved_edges`. Assert a revision-scoped edge cannot enter another snapshot without a `snapshot_resolution_refs` row.

- [ ] **Step 6: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS after deleting legacy derived rows; all outputs retain the selected branch, commit, merge base, snapshot, freshness, trust, and degradation reason.

- [ ] **Step 7: Commit COW revision reads**

```bash
rtk git add packages/knowledge-core/src/revision-view.ts packages/knowledge-core/src/revision-scope.ts packages/knowledge-core/src/query.ts packages/knowledge-core/src/index.ts tests/knowledge-revision-isolation.test.mjs tests/knowledge-query.test.mjs tests/knowledge-graph-query.test.mjs tests/knowledge-revision-indexer.test.mjs
rtk git commit -m "feat(knowledge): query effective copy-on-write revisions"
```

### Task 9: Add on-demand materialization, retention, recovery, and GC

**Files:**
- Create: `packages/knowledge-core/src/revision-retention.ts`
- Modify: `packages/knowledge-core/src/git-topology-store.ts`
- Modify: `packages/knowledge-core/src/file-fact-store.ts`
- Modify: `packages/knowledge-core/src/resolution-store.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Create: `tests/knowledge-revision-retention.test.mjs`
- Modify: `tests/knowledge-branch-lifecycle.test.mjs`

**Interfaces:**
- Consumes: immutable snapshots and reference tables from Tasks 3–8.
- Produces: `RevisionRetentionPolicy`, a dry-run collection plan, recoverable branch pointers, and reference-safe collection.

- [ ] **Step 1: Write failing policy tests with 500 catalogued refs**

Seed 500 branch rows, 30 ready feature snapshots, one default snapshot, two deployment snapshots, two pinned snapshots, three overlay bases, and merged/deleted pointers of varying age. Assert:

```js
assert.equal(plan.policy.maxHotFeatureViews, 20);
assert.equal(plan.policy.coldAfterDays, 14);
assert.equal(plan.policy.deletedBranchRecoveryDays, 30);
assert.ok(plan.keep.every((x) => x.reason !== "alphabetical_branch_order"));
assert.ok(plan.collect.every((x) => !x.default && !x.deployed && !x.pinned && !x.overlayBase));
assert.equal(countHotReadyFeatureViews(afterApply), 20);
assert.equal(countCataloguedBranches(afterApply), 500);
```

Also assert a fact/resolution set referenced by any kept snapshot survives and a truly zero-reference fact becomes collectible only after the configured grace period.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-retention.test.mjs tests/knowledge-branch-lifecycle.test.mjs
```

Expected: FAIL because no revision retention planner exists.

- [ ] **Step 3: Implement the explicit policy and plan result**

```ts
export interface RevisionRetentionPolicy {
  maxHotFeatureViews: number;
  coldAfterDays: number;
  deletedBranchRecoveryDays: number;
  factGcGraceDays: number;
}

export const DEFAULT_REVISION_RETENTION: RevisionRetentionPolicy = {
  maxHotFeatureViews: 20,
  coldAfterDays: 14,
  deletedBranchRecoveryDays: 30,
  factGcGraceDays: 7,
};

export interface RevisionCollectionPlan {
  keep: Array<{ snapshotId: string; reasons: string[] }>;
  cool: Array<{ snapshotId: string; reason: string }>;
  collect: Array<{ snapshotId: string; reason: string }>;
  factsToCollect: string[];
  resolutionSetsToCollect: string[];
}

export interface RevisionCollectionApplyResult {
  cooledSnapshotIds: string[];
  collectedSnapshotIds: string[];
  collectedFactIds: string[];
  collectedResolutionSetIds: string[];
  skipped: Array<{ id: string; reason: "reference_changed" | "lock_unavailable" | "not_collectible" }>;
}

export function planRevisionCollection(
  store: KnowledgeStore,
  repoId: string,
  policy?: RevisionRetentionPolicy,
): RevisionCollectionPlan;

export function applyRevisionCollection(
  store: KnowledgeStore,
  plan: RevisionCollectionPlan,
): RevisionCollectionApplyResult;
```

Sort feature views by `last_accessed_at DESC, published_at DESC, id ASC`. Exempt default, deployed, pinned, current branch pointers, merge-base/overlay bases, and every row in `revision_references` (evidence notes, API-document drafts/conflicts, or manual references). A reference to an unmaterialized commit protects its commit/topology record and attaches to a later snapshot.

- [ ] **Step 4: Separate catalogue deletion from snapshot collection**

When Git no longer exposes a branch, set `deleted_at` and `recover_until`; keep its last snapshot reference for 30 days. After recovery expiry, remove the branch pointer only if no pin/deployment/note reference retains it. Cooling deletes only rebuildable effective-manifest/materialized caches, not commits, overlays, notes, or ledger events.

- [ ] **Step 5: Apply collection under a repository lock**

Implement the exact `planRevisionCollection()` and `applyRevisionCollection()` signatures from Step 3. Recheck branch/deployment/overlay/generic references inside the write transaction before each delete because foreign keys are disabled. If any new reference appears, skip that item and report `reference_changed`.

- [ ] **Step 6: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS; 500 refs remain queryable on demand while only 20 feature views remain hot and protected references survive.

- [ ] **Step 7: Commit retention and GC**

```bash
rtk git add packages/knowledge-core/src/revision-retention.ts packages/knowledge-core/src/git-topology-store.ts packages/knowledge-core/src/file-fact-store.ts packages/knowledge-core/src/resolution-store.ts packages/knowledge-core/src/index.ts tests/knowledge-revision-retention.test.mjs tests/knowledge-branch-lifecycle.test.mjs
rtk git commit -m "feat(knowledge): retain hot revisions and collect unreferenced caches"
```

### Task 10: Resolve runtime evidence to the code that was deployed

**Files:**
- Create: `packages/knowledge-core/src/code-version-resolver.ts`
- Modify: `packages/knowledge-core/src/git-topology-store.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Create: `tests/knowledge-code-version-resolver.test.mjs`

**Interfaces:**
- Consumes: deployment pins, snapshots, branch pointers, and `RevisionContext`.
- Produces: `CodeVersionResolver.resolve()` for SLS evidence and API documentation.

- [ ] **Step 1: Write failing resolution-order tests**

Assert exact log commit wins over deployment history, deployment interval wins over environment branch mapping, and live branch is the final degraded fallback:

```js
assert.equal((await resolve({ logCommitSha: "c3", observedAt })).context.commitSha, "c3");
assert.equal((await resolve({ targetId: "fpms-prod", observedAt: duringC2 })).context.commitSha, "c2");
assert.equal((await resolve({ targetId: "fpms-uat", observedAt, environmentBranch: "uat" })).source, "environment_branch");
assert.equal((await resolve({ targetId: "unknown", observedAt })).context.trust, "fallback_live");
assert.equal((await resolve({ targetId: "unknown", observedAt })).degradationReason, "deployment_mapping_unavailable");
```

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-code-version-resolver.test.mjs
```

Expected: FAIL because `CodeVersionResolver` does not exist.

- [ ] **Step 3: Implement the resolver contract**

```ts
export interface CodeVersionRequest {
  repoId: string;
  targetId?: string;
  observedAt: string;
  logCommitSha?: string;
  environmentBranch?: string;
}

export interface CodeVersionResolution {
  context: RevisionContext;
  source: "log_commit" | "deployment_record" | "indexed_commit" | "environment_branch" | "live_fallback";
  degradationReason?: string;
}

export interface CodeVersionResolverDeps {
  store: KnowledgeStore;
  materializeCommit(input: { repoId: string; commitSha: string }): Promise<RevisionContext>;
}

export class CodeVersionResolver {
  constructor(deps: CodeVersionResolverDeps);
  resolve(request: CodeVersionRequest): Promise<CodeVersionResolution>;
}
```

Use this order exactly: log build/commit field, deployment record for target plus timestamp, exact indexed commit, configured environment branch, live fallback. Resolution is asynchronous because an exact but cold snapshot is materialized on demand through the injected callback. Materialization failure returns an explicit resolution error/gap and never silently selects a newer commit; only absence of exact/deployment evidence may proceed to the configured degraded fallback order.

- [ ] **Step 4: Pin deployment revisions**

`GitTopologyStore.pinDeployment()` must mark the referenced snapshot protected when present and retain the commit record when materialization has not happened yet. Closing a deployment interval never unpins a commit still referenced by another interval.

- [ ] **Step 5: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS for exact, historical interval, environment, cold materialization, and degraded fallback paths.

- [ ] **Step 6: Commit runtime revision mapping**

```bash
rtk git add packages/knowledge-core/src/code-version-resolver.ts packages/knowledge-core/src/git-topology-store.ts packages/knowledge-core/src/index.ts tests/knowledge-code-version-resolver.test.mjs
rtk git commit -m "feat(knowledge): resolve runtime evidence to deployed commits"
```

### Task 11: Expose revision selection and cache status in CLI, MCP, and Wiki

**Files:**
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src/components/wiki/WikiPage.tsx`
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `tests/knowledge-mcp-tools.test.mjs`
- Modify: `tests/wiki-page.test.mjs`
- Modify: `tests/knowledge-revision-context.test.mjs`

**Interfaces:**
- Consumes: revision resolver, materializer, retention planner, and status APIs.
- Produces: user-selectable revision commands and truthful revision/cache UI.

- [ ] **Step 1: Write failing CLI/MCP/UI contract tests**

Require these CLI forms:

```text
penguin status --revisions
penguin explore <target> --repo <repo> --branch <branch>
penguin explore <target> --repo <repo> --commit <sha>
penguin materialize <repo> (--branch <name> | --commit <sha>)
penguin revisions gc <repo> --dry-run
```

Require MCP selectors `repo`, `branch`, `commit_sha`, and `snapshot_id`, and status fields `baseCommit`, `headCommit`, `changedFiles`, `reusePercent`, `cacheState`, `pinned`, `deploymentTargets`, `lastAccessedAt`, and `collectionBlockers`. Require the Wiki source to render `indexed snapshots`, `base`, `head`, and `% reused` labels.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/mcp build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-context.test.mjs tests/knowledge-mcp-tools.test.mjs tests/wiki-page.test.mjs
```

Expected: FAIL because the public revision/cache surfaces are incomplete.

- [ ] **Step 3: Add CLI parsing and commands**

Treat `--repo`, `--branch`, `--commit`, and `--snapshot` as value flags. Reject combinations that identify different revisions. `materialize` accepts exactly one branch or commit selector. `revisions gc --dry-run` prints the plan and never writes; `--apply` executes the already recalculated plan.

- [ ] **Step 4: Add MCP revision selectors and trust envelopes**

All branch-sensitive tools use the Task 1 resolver. Return a top-level `revision` object on success and bounded candidates on ambiguity. Update descriptions to state that empty graph edges mean `no_static_edge` only for the selected revision.

- [ ] **Step 5: Render revision status instead of one-index-per-branch language**

Extend the client types and Wiki branch row to show, for example:

```text
2 indexed snapshots · 1 live
brazil-v2 · base main@abc123 · head def456 · 126 changed files · 94% reused
```

Show pin/deployment/cache/recovery state and why collection is blocked. Label stale counts as stale symbol-version rows rather than whole-repository staleness.

- [ ] **Step 6: Run GREEN verification**

Run the Step 2 command again.

Expected: PASS; CLI, MCP, and Wiki expose the same selector/trust semantics and no surface implies one database/index per branch.

- [ ] **Step 7: Commit revision user surfaces**

```bash
rtk git add packages/knowledge-cli/src/index.ts packages/mcp/src/knowledge-tool-defs.ts packages/mcp/src/knowledge-tools.ts src/lib/knowledge-client.ts src/components/wiki/WikiPage.tsx src-tauri/src/knowledge.rs tests/knowledge-revision-context.test.mjs tests/knowledge-mcp-tools.test.mjs tests/wiki-page.test.mjs
rtk git commit -m "feat(knowledge): expose revision-aware query and cache status"
```

### Task 12: Rebuild legacy snapshots and prove acceptance criteria

**Files:**
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `packages/knowledge-core/src/store.ts`
- Create: `tests/knowledge-revision-migration.test.mjs`
- Modify: `tests/knowledge-core-schema.test.mjs`
- Modify: `tests/knowledge-revision-indexer.test.mjs`
- Modify: `tests/knowledge-revision-retention.test.mjs`
- Create: `docs/knowledge/revision-storage.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: `penguin revisions migrate --dry-run|--apply`, rebuild verification, integrity diagnostics, and operator documentation.

- [ ] **Step 1: Write failing migration and recovery tests**

Create a schema-6 fixture containing two legacy branches, a Markdown note, sensitive note flags, response samples, accepted manual edges, ledger events, and parser rows. Run migration and assert:

```js
assert.equal(after.notesMarkdown, before.notesMarkdown);
assert.equal(after.ledgerChecksum, before.ledgerChecksum);
assert.deepEqual(after.nonRebuildableEvents, before.nonRebuildableEvents);
assert.equal(after.readySnapshots, 2);
assert.equal(after.legacyParserRows, 0);
assert.deepEqual(integrity.orphanSnapshotRefs, []);
assert.deepEqual(integrity.orphanResolutionRefs, []);
```

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build && PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-migration.test.mjs tests/knowledge-core-schema.test.mjs
```

Expected: FAIL because the migration command and integrity report do not exist.

- [ ] **Step 3: Implement dry-run and apply migration**

`--dry-run` lists repositories/branches requiring rebuild, notes/ledger rows preserved, estimated parser rows removed, and missing Git commits. `--apply` performs one repository at a time:

```text
validate notes + ledger checksum
  -> index each retained branch/commit into schema-9 snapshots
  -> compare legacy and revision query fixtures
  -> atomically move branch pointers
  -> delete only rebuildable legacy parser rows for that repository
  -> run manual integrity SQL
```

On any mismatch, keep legacy rows and the old pointer for that repository and return exit code `1` with the exact failed check.

- [ ] **Step 4: Add explicit integrity checks because foreign keys are off**

Check and report counts for orphan branch pointers, snapshot bases, overlay fact IDs, snapshot resolution refs, resolved-edge sets, file-fact symbols, deployment commits, FTS rows, response-sample endpoint keys, pending frontend edges, and note nodes. A nonzero orphan count fails migration.

- [ ] **Step 5: Add the 500-branch and 5%-diff acceptance fixture**

Generate 500 refs over one repository, materialize default plus 20 hot features, and query a cold branch on demand. Generate a 1,000-file base with a 50-file feature diff. Assert:

```js
assert.equal(cataloguedRefs, 500);
assert.ok(hotFeatureViews <= 20);
assert.equal(coldBranchResult.revision.commitSha, coldBranchSha);
assert.ok(featureReport.reusePercent >= 95);
assert.equal(crossRevisionLeakCount, 0);
```

- [ ] **Step 6: Document operation and failure semantics**

In `docs/knowledge/revision-storage.md`, document revision selection order, immutable base+overlay behavior, dirty/shallow/force-push handling, 20/14/30 defaults, deployment pins, on-demand materialization, migration rollback, GC blockers, and the distinction between `no_static_edge` and runtime absence.

- [ ] **Step 7: Run focused and full verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/knowledge-revision-*.test.mjs tests/knowledge-code-version-resolver.test.mjs tests/knowledge-query.test.mjs tests/knowledge-graph-query.test.mjs tests/knowledge-branch-lifecycle.test.mjs tests/pipeline-second-pass.test.mjs tests/knowledge-mcp-tools.test.mjs tests/wiki-page.test.mjs
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-indexer build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/mcp build
rtk git diff --check
```

Expected: all focused tests and builds PASS; `git diff --check` prints no errors. If the existing dependency/override state blocks a package command, record the exact command/error and do not rewrite dependencies with `--no-frozen-lockfile`.

- [ ] **Step 8: Commit migration and operator documentation**

```bash
rtk git add packages/knowledge-cli/src/index.ts packages/knowledge-core/src/store.ts tests/knowledge-revision-migration.test.mjs tests/knowledge-core-schema.test.mjs tests/knowledge-revision-indexer.test.mjs tests/knowledge-revision-retention.test.mjs docs/knowledge/revision-storage.md
rtk git commit -m "feat(knowledge): migrate legacy branches to revision storage"
```

## Final Acceptance Gate

- [ ] Every branch-aware query returns one explicit revision/trust envelope and fails closed on ambiguity.
- [ ] Advancing the default branch cannot mutate an existing feature branch's inherited base.
- [ ] Two branch names at one clean commit share one snapshot.
- [ ] A 5% file diff reuses at least 95% of compatible file facts.
- [ ] Identical source under different symbol contexts never reuses the wrong edge set.
- [ ] Failed indexing leaves the previous ready branch pointer usable.
- [ ] 500 catalogued refs do not create 500 hot materialized views, and a cold extant ref remains queryable on demand.
- [ ] Default, deployed, pinned, referenced base, note-referenced, and evidence-referenced revisions survive retention.
- [ ] Legacy Markdown notes, sensitive flags, response samples, manual edges, and ledger events survive migration/rebuild.
- [ ] Every returned result exposes branch, commit, merge base, snapshot, freshness, trust, and degradation reason.
