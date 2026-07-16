# Penguin revision storage and recovery

Penguin keeps one physical SQLite database for all repositories and branches.
A clean commit is an immutable revision; a dirty worktree is identified by its
worktree fingerprint. Branches are selectors pointing at ready snapshots, not
separate databases or independent indexes.

Each repository has at most one canonical master flag. The first successful
named Git-branch index elects that branch; `penguin master` selects the current
checkout, while `penguin master <repo> <branch>` performs an explicit metadata
replacement without checking out Git or rewriting any snapshot. Detached and
non-Git worktrees never become master. There is no synthetic `root` branch.

Queries must select a branch, commit, or snapshot when the default is
ambiguous. The CLI accepts `--repo`, `--branch`, `--commit`, and `--snapshot`;
MCP exposes the same selectors. A result is trusted only for the selected
revision. `no_static_edge` means the static graph has no edge; it does not prove
that DI, reflection, HTTP dispatch, or runtime use is absent.

Unchanged parsed files are content-addressed and shared. A feature snapshot
inherits its immutable base manifest and stores only add/modify/delete overlay
entries. Resolved edges are reused only when their resolution-context and
resolver versions match. Two branch names at the same clean commit may point
to the same snapshot.

Indexing is build-then-publish: a failed build leaves the previous ready branch
pointer usable. `penguin rebuild` rebuilds an existing index. Removing the
SQLite database does not remove Markdown notes or the append-only ledger;
opening/reindexing recreates derived code facts and notes. Evidence notes are
Markdown-backed and can be repaired with `penguin evidence repair`.

Retention defaults are 20 hot feature views, 14 cold days, 30 days of deleted
branch recovery, and a 7-day file-fact/resolution-set grace period. Default,
deployed, pinned, referenced, and overlay-base snapshots are protected. Review
the plan with `penguin revisions gc <repo> --dry-run`; use `--apply` only after
checking the returned keep/cool/collect sets. Collection rechecks references in
the transaction and skips races rather than deleting a newly referenced view.

SLS investigation notes retain target, environment, project, logstore, query,
timestamps, facts, inferences, gaps, and sensitivity metadata. They can be
searched through Knowledge after note reindexing. API documentation generation
uses these revision and evidence identities, writes an immutable local preview,
and requires an explicit Lark binding before any sync operation.
