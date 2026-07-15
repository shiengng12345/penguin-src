# Penguin Rebuild, Watch, and Memory Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large Penguin rebuilds memory-bounded and atomic, and guarantee at most one live watcher per canonical repository across app processes.

**Architecture:** Every `web-tree-sitter` owner disposes `Query`, `Tree`, and `Parser` in reverse creation order. A rebuild runs all rebuildable SQLite mutations inside one outer `BEGIN IMMEDIATE` transaction and rolls back on any failure, while non-rebuildable rename ledger writes are suppressed during rebuild. Watch ownership is persisted as an atomic lease under `~/.penguin/watch-locks`, keyed by canonical repository path, so a restarted app can detect and stop a prior watcher instead of spawning another.

**Tech Stack:** TypeScript, Node test runner, `web-tree-sitter`, `better-sqlite3`, Rust, Tauri, filesystem leases, Unix process signalling.

## Global Constraints

- Preserve every pre-existing dirty-worktree change.
- Use RED-GREEN TDD for all three fixes.
- Add no dependency unless the standard library cannot provide the required primitive.
- Do not commit, push, tag, publish, or release.
- Run every shell command through `rtk`; use raw commands only for low-level debugging.
- Re-index Graphify and Penguin after source changes.

---

### Task 1: Dispose tree-sitter WASM resources

**Files:**
- Modify: `tests/knowledge-indexer-extract.test.mjs`
- Modify: `packages/knowledge-indexer/src/extract.ts`
- Modify: `packages/knowledge-indexer/src/identifiers.ts`
- Modify: `packages/knowledge-indexer/src/frontend-grpc-client.ts`
- Modify: `packages/knowledge-indexer/src/connect-rpc-client.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`

**Interfaces:**
- Consumes: current `extractSymbols`, `extractIdentifiersFromSource`, and AST helper APIs.
- Produces: identical extraction results with deterministic `Parser`/`Tree`/`Query` disposal on success, null parse, and exception paths.

- [ ] **Step 1: Add a child-process RSS regression test** that warms the parser, repeatedly extracts symbols and identifiers with `--expose-gc`, and asserts post-warmup RSS growth stays below a fixed bound.
- [ ] **Step 2: Run the focused test before production edits.** Run `rtk proxy node --test --test-name-pattern='releases tree-sitter' tests/knowledge-indexer-extract.test.mjs`; expected: FAIL because RSS continues growing.
- [ ] **Step 3: Add `try/finally` disposal** around every parser lifecycle, deleting query, tree, and parser in reverse order without replacing the original parse error.
- [ ] **Step 4: Build the indexer and rerun the focused test.** Run `rtk pnpm --filter @penguin/knowledge-indexer build && rtk proxy node --test --test-name-pattern='releases tree-sitter' tests/knowledge-indexer-extract.test.mjs`; expected: PASS.
- [ ] **Step 5: Run all indexer extraction/client tests** to catch behavioral drift.

### Task 2: Enforce one watcher per canonical repository across app processes

**Files:**
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/lib.rs` only if startup cleanup needs an explicit call.

**Interfaces:**
- Consumes: `knowledge_watch_toggle`, `knowledge_watch_status`, and the current child registry.
- Produces: a `WatchLease` stored under `~/.penguin/watch-locks`, atomic lease acquisition keyed by canonical root, liveness checks, PID-based stop/adoption, stale lease cleanup, and legacy duplicate discovery.

- [ ] **Step 1: Add Rust unit tests** for canonical-path lease keys, atomic collision, stale lease replacement, live lease rejection, lease deletion on stop, and parsing legacy `penguin watch <root> --progress-events` command lines.
- [ ] **Step 2: Run focused Rust tests before production edits.** Run `rtk cargo test --manifest-path src-tauri/Cargo.toml knowledge::tests::watch_ -- --nocapture`; expected: FAIL because lease helpers do not exist.
- [ ] **Step 3: Implement the lease helpers** with `create_new(true)`, JSON lease data (`repo_id`, canonical root, child PID, owner PID), `/proc` or `kill -0` liveness checks, and stale-file removal/retry.
- [ ] **Step 4: Integrate leases into toggle/status/stop/stop_all.** A live foreign lease is treated as the active watcher; disabling sends SIGTERM to its PID and removes the lease; child exit removes its matching lease.
- [ ] **Step 5: Add bounded legacy cleanup** that identifies only Penguin watch command lines, groups them by canonical root, and terminates duplicate orphan processes while retaining at most one live process per root.
- [ ] **Step 6: Run focused and full Rust tests.** Expected: all pass without affecting unrelated processes.

### Task 3: Make rebuild publication atomic

**Files:**
- Modify: `tests/knowledge-indexer-pipeline.test.mjs`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`

**Interfaces:**
- Consumes: `KnowledgeStore.db`, all existing store write methods, and the `onProgress` callback as natural failure injection.
- Produces: rebuild commits all rebuildable graph/checkpoint/trust mutations together, or restores the exact prior snapshot after any thrown error or process crash.

- [ ] **Step 1: Add an interruption regression test.** Build an initial index, snapshot branch/files/symbols/edges/trust rows, change fixtures, throw from `onProgress` after the first indexed file of a rebuild, and assert every snapshot is unchanged.
- [ ] **Step 2: Run the focused test before production edits.** Run `rtk proxy node --test --test-name-pattern='rebuild rollback' tests/knowledge-indexer-pipeline.test.mjs`; expected: FAIL because per-file mutations survive.
- [ ] **Step 3: Wrap rebuild mutations in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.** Begin after repo/branch registration and marker acquisition, commit only after branch trust/status succeeds, and rollback before marker/lock release on any error.
- [ ] **Step 4: Keep incremental behavior unchanged and prevent rebuild-only ledger leakage.** Rename suggestions/aliases are not appended during rebuild, because an append-only ledger cannot participate in SQLite rollback.
- [ ] **Step 5: Rerun the focused test and pipeline suite.** Expected: interruption rejects, the old snapshot remains byte-for-byte equivalent for asserted tables, and successful rebuild still publishes normally.

### Task 4: Verification and real FPMS recovery

**Files:**
- Regenerate: `.codegraph/` or `graphify-out/` managed graph data only through their update commands.
- Regenerate: local Penguin knowledge database through `penguin index` and the FPMS rebuild.

**Interfaces:**
- Consumes: the three fixes above.
- Produces: fresh automated evidence plus a completed FPMS rebuild whose checkpoints match the scan total.

- [ ] **Step 1: Run targeted Node and Rust tests**, then typecheck, complete tests, builds, doctor, synthetic benchmark, real benchmark, boundary audit, and `rtk git diff --check`.
- [ ] **Step 2: Update managed graphs.** Run `rtk graphify update .` and `rtk penguin index`.
- [ ] **Step 3: Inventory existing watchers**, terminate only duplicate legacy `penguin watch` processes discovered by the approved cleanup, and record each PID/root stopped.
- [ ] **Step 4: Run a full FPMS rebuild** and record elapsed time, peak RSS, scanned/checkpoint totals, symbols, edges, endpoints, and exit status.
- [ ] **Step 5: Verify trust and quality gates:** no false-fresh interrupted rebuild, all FPMS files checkpointed, Projects 1,044/1,044 with FP=0/FN=0, Flyover 1,185/1,185 with FP=0/FN=0, CLI/MCP parity, and 4/4 debug golden cases.

