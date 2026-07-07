# Penguin Knowledge Plan 2d/5 — Incremental Pipeline + Branch Model Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution; this is the orchestration layer 2f (watcher) and Plan 4 (`penguin index/rebuild`) both drive.

**Goal:** The headless indexing engine: given a repo path + branch, walk files, use the `files_index` checkpoint to skip unchanged files (mtime/size → content_hash), run 2b extraction + 2c resolution on changed files inside a per-file SQLite transaction, detect deletions, and manage the branch model via pure `.git/HEAD` file parsing (with non-git degradation). This is what `penguin index`/`rebuild` and the watcher call.

**Architecture:** Add to `@penguin/knowledge-indexer`: `git.ts` (parse `.git/HEAD`/`.git/config`/gitlink/worktree — **no git CLI**, per §4.8), `walk.ts` (dir walk honoring `.gitignore` + ignored dirs + >1MB skip), `pipeline.ts` (the per-file check→extract→resolve→txn loop + delete detection + reconcile). All writes go through KnowledgeStore (2a). The per-file transaction (§6.3.2) is the correctness core: delete old parser edges → mark old versions stale/update → upsert nodes/versions → insert new edges → update FTS → update files_index, all in one `db.transaction`. **Rename→alias (2c) fires via `recordKnowledge` OUTSIDE the per-file txn, first** (§2.2.4 boundary — ledger before the rebuildable txn).

**Tech Stack:** TypeScript · node:fs · knowledge-core · 2b/2c · node:test

**Depends on:** 2a (all store APIs), 2b (`extractSymbols`,`langForExtension`), 2c (`resolveRefs`,`detectRenames`).

## Global Constraints (additions)

- **No git CLI** — parse `.git` files directly (§4.8); gitlink files + worktrees followed. Non-git dir → implicit branch `name='(workdir)', head_commit=NULL, status=live` so the "code edges carry branch_id" rule needs no special-case (one code path).
- Per-file update is ONE transaction; mid-process kill → rollback, next run retries via `files_index` status/hash (§6.3.2). Never leaves half-new/half-old graph.
- The per-file txn touches ONLY rebuildable data (nodes/symbol_versions/parser edges/FTS/files_index) — never events/aliases/manual edges (§6.3.2 last bullet).
- Incremental checkpoint is per-file fingerprint, not a cursor (§6.3.1): mtime+size quick-filter → content_hash final judge; `status=error` files retried unconditionally.
- Branch switch (§6.3.3): new/updated `branches` row (new=live, old→snapshot); `files_index` is branch-scoped; new branch can warm from another branch's identical-hash checkpoints.
- Concurrency (§8.3): one active index task per repo+branch+checkout (the **index task lock**); this plan exposes the lock primitive, the wait/skip policy is Plan 4's CLI concern.

## File Structure

- `src/git.ts` — `readGitContext(rootPath): { branch: string; commit: string | null; isGit: boolean; checkoutPath: string }`
- `src/walk.ts` — `walkRepoFiles(rootPath, opts): AsyncIterable<{ absPath; relPath; mtimeMs; sizeBytes }>` (gitignore + ignore-dirs + size filter)
- `src/pipeline.ts` — `indexRepo(...)`, `indexFile(...)`, `detectDeletions(...)`, `reconcileOnStartup(...)`, `IndexTaskLock`
- `tests/knowledge-indexer-pipeline-*.test.mjs` (use a temp git-less dir + a fabricated `.git/HEAD` fixture)

## Interfaces this plan PRODUCES (consumed by 2f + Plan 4)

```ts
function indexRepo(input: {
  store: KnowledgeStore;
  rootPath: string;
  mode: "incremental" | "rebuild";
}): Promise<IndexReport>;

interface IndexReport {
  repoId: string; branchId: string; branchName: string; commit: string | null;
  scanned: number; parsed: number; skipped: number; deleted: number; errors: number;
  renamed: number;                 // alias events appended to ledger
}
function readGitContext(rootPath: string): {
  isGit: boolean; branch: string; commit: string | null; checkoutPath: string;
};
class IndexTaskLock {                        // per repo+branch+checkout
  static tryAcquire(key: string): IndexTaskLock | null;
  release(): void;
}
```

## Tasks (ordered)

1. **`.git/HEAD` parsing (+ non-git degrade).** Parse ref/detached HEAD, resolve commit from `.git/refs`/`packed-refs`; gitlink/worktree followed; non-git → `(workdir)` implicit branch. Test focus: fixture `.git/HEAD` (branch + detached) → correct name/commit; no `.git` → `(workdir)`, commit null. Spec §4.8, §6.3.3.
2. **Repo file walk (gitignore + ignores + size).** Yield candidate files, skipping `node_modules`/`target`/`dist`, `.gitignore` matches, >1MB. Test focus: temp tree with ignored dir + large file + `.gitignore` entry → excluded; normal files → included. Spec §6.1.
3. **files_index quick-filter.** mtime+size unchanged → skip (no hash); changed → hash; hash unchanged → update mtime/size only, skip parse; hash changed → parse. Test focus: unchanged file skipped (parse not called via spy); touched-but-same-hash → no parse, checkpoint mtime updated; changed → parsed. Spec §6.3.1.
4. **Per-file transaction (§6.3.2).** One txn: delete old parser edges for file → mark old versions stale → upsert nodes+versions → insert resolved edges → update FTS symbol rows → upsert files_index. Kill-safety via transaction atomicity. Test focus: index a file → nodes/versions/edges/checkpoint all present; re-index changed file → old edges gone, new present, first_seen_at preserved; simulate throw mid-txn → nothing partially applied. Spec §6.3.2.
5. **Rename-before-txn ordering.** When 2c detects a rename, `recordKnowledge(node_alias_added)` fires (ledger) BEFORE the per-file rebuildable txn; old-name resolution still works after. Test focus: rename fixture → alias in ledger + resolvable via `resolveIdentity`, and the per-file txn didn't touch the alias. Spec §2.2.4, §6.3.
6. **Delete detection.** files_index has it, disk doesn't → mark file deleted + versions stale + drop parser edges + FTS rows. Test focus: index, delete file on disk, re-run → checkpoint deleted, versions stale, edges/FTS gone; ledger data untouched. Spec §6.3.1 delete block, §9 manual-delete row.
7. **Branch switch.** HEAD changes → old branch→snapshot, new→live; branch-scoped `files_index`; warm new branch from identical-hash checkpoints. Test focus: index on `main`, flip fixture HEAD to `feature/x`, re-run → branches rows correct, node identity stable, only differing files re-parsed. Spec §6.3.3, §4.
8. **Restart reconciliation + index task lock.** On start, scan mtime/size to catch missed changes; `IndexTaskLock` prevents a second concurrent task for the same scope. Test focus: two `tryAcquire` same key → second null; reconcile finds an out-of-band change. Spec §6.3 restart, §8.3 concurrency.

## Spec coverage: §4 (branch model + non-git degrade), §6.3 (whole incremental pipeline incl. 6.3.1/6.3.2/6.3.3), §9 (kill-safety, delete, mtime-trap noted for doctor). Out of scope: chokidar/live watch (2f), note files (2e), MCP/CLI verbs (Plan 4), `doctor --verify` full-hash (Plan 4).
