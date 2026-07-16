# Penguin Canonical Master and Stable COW Design

**Date:** 2026-07-16

## Goal

Give every indexed Git repository one explicit canonical master branch while storing shared code once and representing every branch as an immutable snapshot plus a small add/modify/delete overlay. Do not create or continuously rewrite a synthetic `root` branch.

## Decisions

1. The first successfully indexed named Git branch becomes the repository's canonical master when no master exists.
2. Detached HEAD and non-Git `(workdir)` indexes never auto-elect a master. They remain queryable and report `master_unresolved` until a named branch is selected.
3. `penguin master` run inside a repository elects the current checkout branch. `penguin master <repo> <branch>` remains the explicit form.
4. Replacing a master is a metadata operation. The previous master becomes a normal branch; its snapshots, notes, edges, evidence, and history remain intact.
5. Branch names identify branches but never determine ancestry or COW correctness. Git commit topology and merge-base determine ancestry.
6. Identical parsed files are shared through content-addressed `file_facts`. A branch snapshot stores only overlay operations relative to an immutable base snapshot.
7. Existing snapshots are never rewritten when a new branch is indexed or the master changes. Future snapshots use the new canonical master; retention may later collect unreachable snapshots.
8. `index`, `rebuild`, `watch`, and `materialize` must use one base-selection contract and produce equivalent effective manifests.

## Storage Model

```text
repo
├── content-addressed file_facts
│   ├── (path, content hash, parser version) -> fact A
│   ├── (path, content hash, parser version) -> fact B
│   └── (path, content hash, parser version) -> fact C
├── canonical master branch pointer
│   └── immutable snapshot M2
├── feature/a pointer
│   └── snapshot A1 -> base M1 + overlay(add/modify/delete)
└── feature/b pointer
    └── snapshot B3 -> prior B2 or merge-base snapshot + overlay
```

`effective_snapshot_files` is a rebuildable materialization cache. The authoritative revision data is the immutable snapshot chain, overlay rows, content-addressed file facts, resolution references, and Git topology.

## Canonical Master Election

Master election occurs only after successful snapshot publication:

- If a named Git branch finishes indexing and the repository has no master, atomically set `default_branch=1` on that branch.
- A failed, cancelled, or locked index cannot elect or replace master.
- A partial unique index enforces at most one `default_branch=1` row per repository.
- Existing databases with no master remain valid. The next successful named-branch index elects one, or the user can run `penguin master` first.
- Existing databases with multiple defaults are repaired deterministically during migration: retain the most recently successfully indexed named branch, clear the others, and report the repair.

## Base Selection

One `BranchBaseResolver` serves every indexing entry point:

1. Same branch with a ready current snapshot: use that snapshot as the incremental base.
2. First snapshot of the canonical master: no base is required.
3. First snapshot of another named branch: compute Git merge-base against canonical master.
4. If a ready immutable snapshot exists at that merge-base, reuse it.
5. Otherwise materialize one commit snapshot at the merge-base once, then share it.
6. If Git history is shallow or unavailable, use the canonical master's current ready snapshot and mark the result `degraded_base` with a reason. Correctness is preserved because the overlay is computed from full manifests; only reuse efficiency is reduced.
7. Detached/non-Git revisions use their own prior snapshot where available and never become canonical master automatically.

## Overlay Rules

For target manifest `T` and base manifest `B`:

- `add`: path exists in `T`, not in `B`.
- `modify`: path exists in both and file-fact IDs differ.
- `delete`: path exists in `B`, not in `T`.
- unchanged: path exists in both with the same file-fact ID; write no overlay row.

The effective manifest must equal the exact Git tree or dirty worktree selected by the revision context. File-fact reuse is based on content identity, never branch name.

## Master Replacement

When `penguin master` elects branch B while branch A is currently master:

- clear A's `default_branch` flag;
- set B's flag in the same transaction;
- preserve A and B branch pointers and all immutable snapshots;
- use B for future first-snapshot base selection;
- do not reparent or rewrite existing snapshots;
- expose both `canonicalMaster` and each snapshot's actual `baseSnapshotId` so UI/MCP do not imply historical data changed.

## Interfaces

### CLI

```text
penguin master                         # current repo + current named branch
penguin master <repo>                  # indexed repo + its current checkout branch
penguin master <repo> <branch>         # explicit branch
penguin status --revisions --json      # canonical master and actual snapshot bases
```

### MCP

- `index_status` reports `canonicalMaster`, `defaultBranch`, actual base snapshot, merge-base, and degradation state.
- `set_master_branch` accepts explicit `repo` and `branch`; MCP never infers a branch from server process cwd.

### Wiki UI

- Repository row shows `master: <branch>` or `master unresolved`.
- Branch row shows a master badge only for the canonical branch.
- Snapshot details show the actual immutable base separately from the current canonical master.
- Setting a master from UI requires explicit confirmation and never triggers reindex automatically.

## Recovery and Retention

- Deleting SQLite and reindexing reconstructs master election from the first successful named branch in the new database.
- Markdown notes, SLS evidence, API-document previews, and the append-only ledger are not branch overlays and are not modified by master election.
- Rebuild on an existing index creates a new immutable snapshot and publishes only after success.
- Retention always protects the canonical master's current snapshot, live branch pointers, pinned snapshots, deployments, references, and recovery windows.
- `effective_snapshot_files` can be deleted and regenerated from base chains and overlays.

## Invariants

1. At most one canonical master per repository.
2. A failed index never changes master or a live branch pointer.
3. Every ready snapshot's effective manifest equals its selected source revision.
4. Adding a branch never changes another branch's effective view.
5. Replacing master never rewrites historical snapshots.
6. Identical file facts are stored once per repository/path/content/parser identity.
7. CLI, MCP, Wiki, watch, index, rebuild, and materialize report the same revision trust and base semantics.

## Non-Goals

- No synthetic `root` branch.
- No branch-name-based ancestry guesses.
- No eager rewriting of all branch overlays after master replacement.
- No requirement to index every remote branch.
- No automatic checkout or mutation of user worktrees.

## Acceptance Scenarios

- First successful named branch auto-elects master.
- Failed first index leaves master unresolved.
- Detached HEAD and non-Git first index leave master unresolved.
- `penguin master` elects the current checkout branch.
- Replacing an existing master preserves both branch indexes.
- A second branch reuses unchanged file facts and stores only add/modify/delete overlay rows.
- Third and later branches remain isolated and do not rewrite earlier snapshots.
- Weird branch names, slashes, renamed default branches, shallow clones, dirty worktrees, deletes, and renames behave deterministically.
- Empty DB reindex, existing DB rebuild, overlay-cache rebuild, migration, GC, CLI, MCP, and Wiki all pass.

