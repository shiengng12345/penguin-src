# Penguin Knowledge Plan 2f/5 — Watcher + Sidecar Wiring Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution. Last indexer plan; makes indexing live inside the Tauri app.

**Goal:** Live incremental indexing: a chokidar-based file watcher (2s debounce) + `.git/HEAD` watcher that drives 2d's `indexRepo`/`indexFile` in the background, plus the sidecar process lifecycle inside the Tauri app (spawn/health/restart, mirroring the existing MCP/sidecar mechanism). Foreground queries always win; indexing lag surfaces as staleness, never blocks.

**Architecture:** Add `src/watch.ts` to `@penguin/knowledge-indexer` (chokidar watch → debounce → enqueue file index tasks via 2d, honoring the index task lock; watch `.git/HEAD` for branch switches). The sidecar shell (`src/sidecar.ts`) runs the indexer as a long-lived process exposing a small IPC surface; `src-tauri` spawns/monitors it like the current MCP sidecar. A bounded concurrency pool runs parse/index off the query path (§6.3 last bullets).

**Tech Stack:** TypeScript · chokidar · knowledge-indexer 2b–2e · Tauri (Rust `src-tauri` sidecar spawn) · node:test (+ a real-FS debounce test)

**Depends on:** 2d (`indexRepo`/`indexFile`/`IndexTaskLock`/`readGitContext`), 2e (`indexNote` for wiki dir), and the app's existing sidecar-spawn pattern in `src-tauri`.

## Global Constraints (additions)

- **No standalone daemon in the CLI** (§8.3.4): the watcher lives ONLY in the Penguin app sidecar. CLI `index` is one-shot (Plan 4).
- Debounce 2s (§6.3); coalesce rapid saves; `.git/HEAD` change → branch-switch path (2d Task 7).
- Watcher shares 2d's index task lock — never a second concurrent task per repo+branch+checkout.
- Indexing runs in a bounded pool, background priority; queries never block (§6.3, §9 "index-in-progress").
- Reuse the existing Tauri sidecar mechanism (same as MCP server) — do NOT invent a new process model. Runtime uses system Node (same as MCP/CLI, §8.3 分发).

## File Structure

- `src/watch.ts` — `startWatcher(...)`, debounce queue, `.git/HEAD` watch
- `src/sidecar.ts` — long-lived process entry + IPC (index-now / status / stop)
- `src-tauri/src/knowledge_sidecar.rs` (or extend existing sidecar module) — spawn/health/restart + Tauri commands (`knowledge_index_status`, `knowledge_reindex`)
- `tests/knowledge-indexer-watch-*.test.mjs`

## Interfaces this plan PRODUCES (consumed by Plan 4/5)

```ts
function startWatcher(input: {
  store: KnowledgeStore; rootPath: string; wikiPath?: string;
  debounceMs?: number;              // default 2000
}): { stop(): Promise<void>; status(): WatcherStatus };

interface WatcherStatus {
  watching: boolean; queued: number; lastIndexedAt: string | null;
  branch: string; staleFiles: number;
}
```
Tauri side (consumed by UI Plan 5): commands `knowledge_index_status() -> WatcherStatus`, `knowledge_reindex(path)`, plus an event stream `knowledge:index-progress` for live staleness.

## Tasks (ordered)

1. **Debounced watch queue (FS test).** chokidar on a temp dir → rapid writes coalesced into one index task after debounce. Test focus: write a file 5× within debounce → `indexFile` called once (spy); distinct files → separate tasks. Spec §6.3 (2s debounce).
2. **`.git/HEAD` watch → branch switch.** Watching `.git/HEAD`; on change, run 2d branch-switch. Test focus: mutate fixture `.git/HEAD` → branch-switch path invoked once. Spec §6.3.3.
3. **Wiki dir watch → note reindex.** Watching the wiki path routes `.md` events through 2e `indexNote`. Test focus: add/modify a note → note node + FTS updated. Spec §6.4.
4. **Bounded background pool + lock coordination.** Index tasks run in a bounded pool, sharing 2d's `IndexTaskLock`; queries (a concurrent read) are not blocked. Test focus: enqueue N tasks, cap concurrency; a read during indexing returns promptly. Spec §6.3 last bullets, §8.3 concurrency.
5. **Tauri sidecar lifecycle.** Rust spawns the indexer sidecar (reuse MCP sidecar pattern), health-check + restart on crash; expose `knowledge_index_status`/`knowledge_reindex` commands + `knowledge:index-progress` events. Test focus (Rust `cargo test` + TS): command returns status shape; restart on simulated exit. Spec §8.3 分发, §9 index-in-progress.
6. **Restart reconciliation wire-up.** On sidecar start, run 2d `reconcileOnStartup` for registered repos to catch app-off changes. Test focus: change files while "sidecar off", start → reconcile indexes them. Spec §6.3 restart.

## Spec coverage: §6.3 (live watch, debounce, branch-switch, restart reconcile, background pool), §8.3 (no CLI daemon; app owns watcher; sidecar distribution), §9 (index-in-progress non-blocking). Out of scope: CLI one-shot verbs (Plan 4), MCP tools (Plan 4), UI (Plan 5).
