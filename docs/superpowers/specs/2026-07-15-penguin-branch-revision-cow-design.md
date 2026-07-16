# Penguin Branch Revision and Copy-on-Write Design

## Goal

Make Penguin correct and economical when a repository has many branches. Every
answer must resolve against an explicit code revision, while unchanged files and
parsed facts are shared instead of being copied into a full index per branch.

The core rule is:

```text
effective branch view = immutable merge-base snapshot + branch overlay
```

The overlay is never applied to the current moving `main`/`master` head. A
feature branch created from commit `B` continues to inherit `B`, even after the
default branch advances to later commits.

## Product Decisions

- One physical Knowledge database serves all repositories and branches.
- A branch is a mutable pointer to an immutable commit/worktree snapshot, not an
  independent database.
- Git commit SHA is the stable revision identity; branch name is a selector.
- All Git refs may be catalogued cheaply, but only default, deployed, pinned,
  recently used, or explicitly requested revisions are materialized.
- Unchanged file facts are content-addressed and reused.
- Parsed facts and resolved graph edges are separate because identical source
  can resolve differently against different branch symbol tables.
- Feature branches produce on-demand views; they do not require permanent full
  snapshots or permanent Lark documentation.
- Deployment commits are pinned so historical SLS evidence can resolve against
  the code that actually ran.

## Current Boundary

The current schema is snapshot-oriented:

- `nodes` shares symbol identity at repository scope;
- `symbol_versions` is unique by `(node_id, branch_id)`;
- `files_index` is unique by `(repo_id, branch_id, file_path)`;
- parser edges are replaced per branch/file, while selected global gRPC edges
  use `branch_id IS NULL`;
- several query paths have historically had inconsistent branch filtering.

This means storage and indexing grow with every retained branch, and a branch
filter omission can mix answers across revisions. Correct branch isolation must
land before storage deduplication.

## Non-Goals

- Index every remote branch eagerly.
- Model every Git hosting feature or replace Git itself.
- Reuse an edge set solely because two files have the same content hash.
- Treat `branch_id IS NULL` as a generic copy-on-write membership mechanism;
  existing readers interpret it as globally visible.
- Preserve arbitrary parser-row IDs across a rebuild. Evidence links use stable
  selectors and content fingerprints instead.

## Revision Model

### Git topology

For each repository Penguin records:

- configured or detected default branch;
- commit SHA, tree hash, and parent SHAs;
- branch head SHA;
- merge-base SHA against the selected base branch;
- ahead/behind counts when available;
- checkout path and clean/dirty worktree fingerprint;
- shallow/missing-history state.

The selected base is normally the repository default branch, but stacked
branches may use the nearest indexed ancestor branch. Correctness is anchored
to the actual merge-base commit, not to a hard-coded branch name.

Default-branch resolution is deterministic: explicit repository configuration,
then remote symbolic HEAD, then an unambiguous local `main` or `master`. If none
of those resolves, Penguin requires an explicit base instead of guessing.

### Immutable snapshot

A snapshot identifies one of:

```text
(repo, commit SHA, parser version, schema version)
(repo, HEAD SHA, worktree fingerprint, parser version, schema version)
```

Two branch names pointing to the same clean commit reuse the same snapshot.
A dirty checkout creates a temporary worktree snapshot layered on its HEAD
commit and is never confused with the clean commit.

### Branch overlay

The overlay contains file operations relative to the immutable base snapshot:

- `add(path, fileFactHash)`;
- `modify(path, fileFactHash)`;
- `delete(path)`.

A rename is represented as delete plus add, with a stable alias/rename event
recorded separately. Tombstones are required so a deleted base file cannot
reappear when the effective view is assembled.

## Storage Boundaries

Names below describe responsibilities; exact SQL names may follow existing
repository conventions during implementation.

### `GitTopologyStore`

Owns commits, parents, branch heads, merge bases, deployment pins, and
worktree fingerprints. It does not contain parsed code facts.

### `FileFactStore`

Stores deterministic syntax facts. The safe initial reuse key is
`(repoId, filePath, contentHash, language, parserVersion)` because the current
extractor includes path-sensitive qualified names and relative imports. A later
path-independent parser representation may deduplicate identical content across
renames, but content hash alone is not a valid initial cache key.

Stored facts include:

- language and source hash;
- symbol declarations and signatures;
- imports and unresolved references;
- endpoints, log sites, identifiers, and other syntax-derived facts.

These facts are safe to share across branch snapshots at the same repository
path because they do not claim that a reference resolved to a particular branch
symbol.

### `SnapshotOverlayStore`

Stores base snapshot identity and file add/modify/delete operations. It can
assemble the effective file manifest for any retained snapshot.

### `ResolutionStore`

Stores resolved edge sets using a key that includes:

- parsed file-fact identity;
- resolution-context fingerprint;
- parser/resolver version.

The context fingerprint reflects the effective imported symbol surface. When a
changed file adds, removes, or renames exported symbols, dependent files are
invalidated and re-resolved even if their own source hashes did not change.

Global cross-service facts, such as canonical gRPC endpoint identity, have an
explicit global scope. Global scope is not inferred from a nullable branch ID.

### `MaterializedBranchView`

Hot revisions may materialize effective symbols and edges for low-latency MCP
queries. A materialized view is a rebuildable cache, not the source of truth.

## Indexing Flow

```text
catalog refs
  -> resolve requested branch/head/merge-base
  -> locate or build immutable base snapshot
  -> diff merge-base tree against requested head/worktree
  -> reuse or parse changed file facts
  -> compute exported-symbol changes
  -> invalidate changed files plus affected dependency closure
  -> resolve branch-specific edges
  -> validate effective view
  -> atomically move branch pointer to the new snapshot
  -> record freshness/trust metadata
```

The old branch pointer remains usable until the new snapshot validates. A failed
index must not demote the previous live revision or publish a partial view.

## Many-Branch Policy

Penguin separates a cheap branch catalogue from expensive materialization.

### Always retained

- current default-branch snapshot;
- commits currently deployed to a configured environment;
- user-pinned revisions;
- merge-base snapshots still referenced by an overlay.

### On-demand

- any explicitly queried branch or commit;
- a feature branch selected for comparison, API preview, or incident analysis;
- a historical commit named by SLS build/deployment evidence.

### Initial cache defaults

- at most 20 hot materialized feature-branch views per repository;
- a feature view becomes cold after 14 days without access;
- merged or deleted branch pointers remain recoverable for 30 days;
- default/deployed/pinned snapshots are exempt from those limits;
- zero-reference parsed facts are eligible for delayed garbage collection;
- concurrent requests for the same `(repo, revision)` share one indexing job.

These values are configuration defaults, not hard capability limits. An evicted
view remains reproducible while its ref/commit is still available from Git or is
retained by a deployment/pin.

## Query Contract

Every branch-aware query resolves a `RevisionContext`:

```ts
interface RevisionContext {
  repoId: string;
  branch?: string;
  commitSha: string;
  snapshotId: string;
  mergeBaseSha?: string;
  worktreeFingerprint?: string;
  trust: "exact_commit" | "exact_worktree" | "fallback_live" | "trust_unavailable";
}
```

Rules:

1. exact snapshot/commit wins;
2. otherwise resolve an explicit branch head;
3. otherwise use the sole live checkout for that repository;
4. ambiguity fails closed and returns candidates;
5. graph, flow, context, impact, calls, and compare operations all consume the
   same effective revision view;
6. every result returns branch, commit, merge base, indexed revision, freshness,
   and degradation reason.

`no_static_edge` continues to mean that the selected static graph has no edge;
it does not prove that runtime, DI, reflection, or HTTP dispatch is absent.

## Deployment and SLS Integration

`CodeVersionResolver` maps runtime evidence to a revision in this order:

```text
log build/commit field
  -> deployment record for target + timestamp
  -> exact indexed commit
  -> environment branch mapping
  -> live-branch fallback with degraded trust
```

Evidence notes are target/topic scoped, not owned by a branch. Each code
reference records repository, branch, commit, merge base, and trust so a future
reindex cannot silently reinterpret historical evidence against newer code.

## UI

Replace the ambiguous impression of one index per branch with revision status:

```text
2 indexed snapshots · 1 live
brazil-v2 · base main@abc123 · head def456 · 126 changed files · 94% reused
```

The stale badge explains that it counts stale symbol-version rows. The branch
detail view exposes pin state, deployment references, access time, cache state,
and why a snapshot cannot yet be collected.

## Failure Handling

- Missing merge-base in a shallow clone: build a bounded full snapshot for the
  requested revision and report `trust_unavailable`/`missing_history`.
- Force-pushed branch: create a new immutable snapshot and move only the branch
  pointer; do not mutate the old snapshot in place.
- Dirty checkout: use a worktree fingerprint and report dirty files.
- Parser/resolver version change: invalidate incompatible shared facts/views.
- Resolution-context mismatch: re-resolve; never reuse only by file hash.
- Concurrent remove/index: serialize by repository/revision and make pointer
  publication atomic.
- GC: refuse collection while any branch, deployment, note reference, or overlay
  retains the snapshot/fact.

## Migration Strategy

1. First make every branch-sensitive reader use one explicit revision scope and
   fail closed when it is absent.
2. Add topology and trust metadata while retaining current storage.
3. Introduce content-addressed parsed facts and file overlays behind a schema
   version boundary.
4. Rebuild parser-derived rows into the new model; preserve file-backed notes
   and non-rebuildable ledger events.
5. Add resolved-edge sharing only after dependency invalidation and branch
   query tests pass.
6. Enable materialized-view cache and retention after correctness metrics match
   the old single-branch answers.

## Testing

- Feature branch inherits its merge-base, not later default-branch commits.
- Add/modify/delete/rename overlays produce the correct effective file manifest.
- Two branches at one commit share one snapshot.
- Identical source with different symbol context does not reuse the wrong edge
  set.
- Changed exports re-resolve unchanged import dependents.
- Every graph/query mode remains branch-isolated.
- Dirty, detached, shallow, force-pushed, stacked, merged, and deleted branches
  have deterministic behavior.
- Failed indexing leaves the old live pointer intact.
- Deployment pins survive normal retention.
- Hundreds of catalogued branches do not create hundreds of materialized views.
- GC preserves every referenced base/fact and deletes only zero-reference data.

## Acceptance Criteria

- A repository with 500 catalogued branches can keep only configured hot views
  while any branch whose ref/commit still exists remains queryable on demand.
- A branch changing 5% of files reuses unchanged parsed facts and does not create
  a second full logical copy of the repository.
- Runtime evidence with an exact deployed commit resolves to that immutable
  snapshot even when the local checkout is on another branch.
- Query results never combine edges or symbol versions from two revisions.
- Every answer explains its revision and trust state.
