# Remove Nomic Vector/Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Nomic/ONNX vector-embedding semantic-search subsystem from the Penguin knowledge stack entirely (source, tests, bundled model assets, docs), while the original non-vector indexing/search path — graph/symbol indexing, keyword/lexical search, CLI, MCP tools, Tauri UI — keeps working end-to-end with no behavior change.

**Architecture:** The semantic layer is architecturally an optional, additively-bolted-on lane: `indexRepo()` in `packages/knowledge-indexer/src/pipeline.ts` only runs the embedding stage when a caller explicitly passes `semantic: { enabled: true, ... }` (default: absent → no-op); `searchKnowledge()` (sync) is the deterministic/keyword/graph search entry point and has zero dependency on vector code, while `searchKnowledgeAsync()` is a separate wrapper that optionally blends in vector hits via `hybrid-search.ts`. The CLI's `penguin semantic ...` verb, the MCP `knowledge_semantic_status`/`knowledge_semantic_control` tools, the Tauri `knowledge_semantic_*` commands, and the `SemanticWorkerPanel` UI are all independent consumers layered on top. This means the subsystem can be removed consumer-first (UI → Tauri → MCP → CLI → indexer wiring → core library → contracts types → schema tables), keeping the build green after each task, without ever touching the deterministic search/index path itself.

**Tech Stack:** TypeScript (pnpm workspace: `packages/knowledge-core`, `packages/knowledge-indexer`, `packages/knowledge-cli`, `packages/knowledge-contracts`, `packages/mcp`), Rust (`src-tauri`, Tauri commands), React (`src/components/wiki`), SQLite (better-sqlite3, no `sqlite-vec` extension actually shipped in the runtime bundle per `docs/quality/penguin-knowledge-power-roadmap-claude-deepseek.md:38` — the vector store's real-path usage is effectively unused in production already), Node test runner (`node:test`, files under `tests/*.test.mjs`).

**Spec:** This document (no separate spec doc — requirements were gathered directly with the user: thorough code deletion, not just the existing runtime kill-switch at `~/.penguin/semantic-worker.disabled`).

## Global Constraints

- Do not change the behavior, output shape, or performance of `searchKnowledge()` (sync), `indexRepo()` with no `semantic` option, `penguin index`/`penguin rebuild`, or any non-semantic MCP/CLI/Rust surface. Every task's acceptance criteria implicitly include "the existing non-semantic test files listed in Task 14 still pass unmodified."
- Never `DROP TABLE` the legacy semantic SQLite tables (`semantic_chunks`, `embedding_models`, `semantic_embedding_refs`, `semantic_vector_values`, `embedding_spaces`, `embedding_generations`, `embedding_jobs`, `semantic_worker_leases`, `semantic_controls`, `semantic_active_spaces`) in existing user databases as part of this plan — just stop creating/migrating them for fresh installs. Leaving them orphaned in already-installed DBs is harmless (SQLite doesn't error on unused tables) and is far lower-risk than a destructive migration. If the user later wants a cleanup migration, that's a separate follow-up plan.
- `knowledge_audit_events` appears inside `schema.ts`'s `semanticTables` list (used for a status-panel summary) — **verify in Task 12** whether it is actually semantic-specific or a general audit log before deciding whether it's in scope. Do not remove it from the schema without confirming.
- Do not bump `SCHEMA_VERSION` (currently `18`) unless a task discovers the trimmed schema changes what `tests/knowledge-schema-v18.test.mjs` asserts in a way that requires it — check first, only bump if forced.
- Every deletion task ends with: the affected package builds (`pnpm -C <package> build` or repo-root `pnpm build` if no per-package script), `pnpm tsc --noEmit` (or the package's typecheck script) is clean, and the specific test files named in that task pass.
- Because this is a subtractive refactor (removing an existing, working feature) rather than new-feature development, steps are **"locate exact anchors → remove → verify build & the named tests still pass"** instead of classic red/green TDD — there is no new behavior to drive out with a failing test. Where a task narrows a still-needed shared file (e.g. `hybrid-search.ts`'s callers, the schema table list), the step says exactly what stays.
- Line numbers below were captured against commit `9d07cce0a710385cb094a9b9a1a6854a1eb95ceb` (current `main` HEAD) via `mcp__penguin__knowledge_search`/`grep`. Files may have shifted slightly by execution time — re-`grep` the anchor string given in each step before editing; don't trust the line number blindly.

---

## Task 1: Remove the Wiki UI semantic panel

**Files:**
- Modify: `src/components/wiki/WikiPage.tsx:19,246`
- Delete: `src/components/wiki/SemanticWorkerPanel.tsx`
- Test: manual — `pnpm dev` (or the `run` skill), open the Wiki page, confirm it renders with no console error and no semantic panel.

**Interfaces:**
- Consumes: nothing new.
- Produces: `WikiPage` no longer renders a semantic status widget. Nothing downstream depends on `SemanticWorkerPanel`.

- [ ] **Step 1: Remove the import and usage**

In `src/components/wiki/WikiPage.tsx`, delete line 19:
```tsx
import { SemanticWorkerPanel } from "@/components/wiki/SemanticWorkerPanel";
```
and delete line 246:
```tsx
      <SemanticWorkerPanel />
```
Re-check the surrounding JSX for now-dangling wrapper elements (e.g. an empty `<div className="...">` that only existed to host the panel) and remove those too if they'd otherwise render empty.

- [ ] **Step 2: Delete the component file**

```bash
git rm src/components/wiki/SemanticWorkerPanel.tsx
```

- [ ] **Step 3: Typecheck and build the frontend**

Run: `pnpm typecheck` (or `pnpm tsc --noEmit` at repo root, whichever this repo's `package.json` defines — check `package.json` scripts first)
Expected: no errors referencing `SemanticWorkerPanel` or `WikiPage.tsx`.

- [ ] **Step 4: Visual check**

Use the `run` skill (or `pnpm dev` / `pnpm tauri dev`) to launch the app, navigate to the Wiki page, confirm it renders correctly with no semantic panel and no runtime error in devtools console.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete SemanticWorkerPanel UI"
```

---

## Task 2: Remove the Tauri (Rust) semantic commands

**Files:**
- Modify: `src-tauri/src/knowledge.rs` (remove `knowledge_semantic_status`, `knowledge_semantic_control`, `wake_semantic_worker_on_startup`, `semantic_control_input`, and their test module at line ~1412)
- Modify: `src-tauri/src/lib.rs:229,256,257` (remove the startup wake call and the two `invoke_handler` registrations)
- Test: `cargo test` in `src-tauri`, plus `cargo build`

**Interfaces:**
- Consumes: nothing (Task 1 already removed the only frontend caller).
- Produces: `src-tauri` no longer exposes `knowledge_semantic_status`/`knowledge_semantic_control` as Tauri commands; app startup no longer spawns/wakes the semantic worker.

- [ ] **Step 1: Re-locate the exact functions**

```bash
grep -n '#\[tauri::command\]' -A1 src-tauri/src/knowledge.rs | grep -B1 semantic
grep -n "fn semantic_control_input\|fn wake_semantic_worker_on_startup\|mod tests" src-tauri/src/knowledge.rs
```
This should confirm `knowledge_semantic_status` (~line 2026), `knowledge_semantic_control` (~line 2065), `semantic_control_input` (~line 2045), and `wake_semantic_worker_on_startup` (~line 1874) as of this snapshot.

- [ ] **Step 2: Delete the functions and their dedicated test**

Remove the full body of each of the four functions above (including their `#[tauri::command]` attribute where present), and remove the `semantic_control_transport_forwards_unvalidated_canonical_payload` test (~line 1412) and any other test in the same `#[cfg(test)]` block that exclusively exercises these functions. Leave every other test and command in `knowledge.rs` untouched — this file also holds the non-semantic indexing/status commands that must keep working.

Also remove now-unused imports at the top of `knowledge.rs` that were only used by the deleted functions (e.g. semantic-only marker-file kill-switch constants like the `~/.penguin/semantic-worker.disabled` path helper, if not referenced elsewhere in the file — `grep -n` for the constant name first to confirm it's dead).

- [ ] **Step 3: Update `lib.rs` registration**

In `src-tauri/src/lib.rs`, delete line 229:
```rust
knowledge::wake_semantic_worker_on_startup(app.handle().clone());
```
and delete lines 256-257 from the `invoke_handler` list:
```rust
knowledge::knowledge_semantic_status,
knowledge::knowledge_semantic_control,
```

- [ ] **Step 4: Build and test**

Run: `cd src-tauri && cargo build && cargo test`
Expected: clean build, all remaining tests pass (no test references the deleted functions).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete Tauri semantic worker commands"
```

---

## Task 3: Remove the frontend `knowledge-client.ts` semantic API surface

**Files:**
- Modify: `src/lib/knowledge-client.ts:7-13,16-22,399,423-449,451-454,483`

**Interfaces:**
- Consumes: nothing (Task 1 removed the only caller, `SemanticWorkerPanel`).
- Produces: `knowledge-client.ts` exports no semantic-* functions/types; `KnowledgeCorpusPhase` no longer includes `"semantic"`.

- [ ] **Step 1: Remove semantic imports**

Delete the import block (lines 7-13) pulling `validateSemanticControlRequest`, `validateSemanticControlResult`, `validateSemanticStatusResponse`, `SemanticControlAction`, `SemanticControlResult`, `SemanticStatusResponse` from `"../../packages/knowledge-contracts/src/semantic.js"`, and the corresponding re-exported type block (lines 16-22: `SemanticControlAction`, `SemanticControlResult`, `SemanticGenerationState`, `SemanticStatus`, `SemanticStatusResponse`, `SemanticWorkerWakeResult`).

- [ ] **Step 2: Remove the semantic functions**

Delete `knowledgeSemanticStatus` (~line 423), `knowledgeSemanticControl` (~line 428), `onSemanticStatusChanged` (~line 451), and the `semantic: { ... }` block at line 399 (check its surrounding object — likely a status-panel-shaped return type; remove only the `semantic` key, keep sibling keys).

- [ ] **Step 3: Narrow `KnowledgeCorpusPhase`**

Line 483:
```ts
export type KnowledgeCorpusPhase = "index" | "rebuild" | "semantic" | "verify";
```
becomes:
```ts
export type KnowledgeCorpusPhase = "index" | "rebuild" | "verify";
```
Grep for every usage of `KnowledgeCorpusPhase` and `"semantic"` phase literals elsewhere in `src/` to confirm nothing still switches on the `"semantic"` phase; update any such call site to drop that branch.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: no errors in `src/lib/knowledge-client.ts` or its consumers.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete frontend semantic API client"
```

---

## Task 4: Remove semantic MCP tools

**Files:**
- Modify: `packages/mcp/src/knowledge-tools.ts:419,421,598-618,619-...` (the `knowledge_semantic_status` and `knowledge_semantic_control` routed-tool handlers, and the `capabilityId === "knowledge.semantic_status"` special-case branch)
- Modify: `packages/mcp/src/index.ts:98,1265-1273` (remove `"knowledge_semantic_status"` from the tool list, and the `spawn(launcher, ["semantic", "wake", "--json"], ...)` fire-and-forget call plus its surrounding comment)
- Test: `tests/knowledge-mcp-tools.test.mjs` (edit, don't blindly delete — it likely covers non-semantic MCP tools too; remove only the semantic-status/control assertions)

**Interfaces:**
- Consumes: nothing after Task 2/3 (no remaining internal caller of these tool names).
- Produces: `packages/mcp` no longer registers or routes `knowledge_semantic_status`/`knowledge_semantic_control`; MCP startup no longer spawns `penguin semantic wake`.

- [ ] **Step 1: Re-locate exact branches**

```bash
grep -n 'knowledge_semantic_status\|knowledge_semantic_control\|semantic_status' packages/mcp/src/knowledge-tools.ts
grep -n 'knowledge_semantic_status\|spawn(launcher' packages/mcp/src/index.ts
```

- [ ] **Step 2: Remove the tool handlers in `knowledge-tools.ts`**

Delete the `if (routedName === "knowledge_semantic_status") { ... }` block (~598-618) and the `if (routedName === "knowledge_semantic_control") { ... }` block (~619 onward, find its matching close). Delete the `capabilityId === "knowledge.semantic_status"` early-return special case (~line 419-421) together with its explanatory comment.

- [ ] **Step 3: Remove tool registration and startup wake in `index.ts`**

Delete `"knowledge_semantic_status"` from the tool-name list at line 98. Delete the `const child = spawn(launcher, ["semantic", "wake", "--json"], ...)` block at ~1265 and its associated comment block (~1272-1273) about not breaking the MCP handshake — that whole guard exists only because of this spawn call.

- [ ] **Step 4: Update the MCP tools test**

Open `tests/knowledge-mcp-tools.test.mjs`, remove only the test cases asserting `knowledge_semantic_status`/`knowledge_semantic_control` tool behavior. Leave every other tool's test case in place.

- [ ] **Step 5: Build and run the test**

Run: `pnpm -C packages/mcp build && node --test tests/knowledge-mcp-tools.test.mjs`
Expected: build clean, all remaining (non-semantic) test cases pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete semantic MCP tools"
```

---

## Task 5: Remove the CLI `semantic` verb and its wake-on-index/rebuild hook

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts:84,94,116,645-770ish,693,748-752,1591-1605,2388-2390`
- Delete: `packages/knowledge-cli/src/semantic-worker.ts`
- Modify: `packages/knowledge-cli/src/query-server.ts:7,520` (remove `ensureSemanticWorker` import and the `wake: () => ensureSemanticWorker(...)` callback passed into the control-request handler)
- Modify: `packages/knowledge-cli/src/index.ts:16-19ish` (remove `runSemanticWorker`, `ensureSemanticWorker`, `readSemanticWorkerRuntimeState`, `SemanticWorkerResult` exports)
- Test: `tests/knowledge-cli-render.test.mjs` (edit), delete `tests/knowledge-semantic-supervisor.test.mjs`, `tests/knowledge-semantic-fire-and-forget.test.mjs`, `tests/knowledge-semantic-worker-leases.test.mjs`, `tests/knowledge-semantic-worker-performance.test.mjs`, `tests/knowledge-semantic-status-contract.test.mjs`, `tests/knowledge-selected-embedding-model.test.mjs`, `tests/knowledge-tauri-semantic-control.test.mjs` (these are handled in Task 13's cleanup pass — do not delete them yet in this task, just note they will break; Task 13 removes them once every producer is gone, to avoid a half-red test tree mid-plan. If you prefer a fully-green tree after every task, you may delete them now instead — either order is fine as long as Task 13 double-checks nothing was missed.)

**Interfaces:**
- Consumes: nothing after Task 4 (MCP no longer spawns `semantic wake`).
- Produces: `penguin semantic ...` subcommand is gone. `penguin index`/`penguin rebuild` no longer call `ensureSemanticWorker` or report a `semanticWorker`/`semantic` field in their human/JSON output — the report line becomes `` `${verb}: ${report.branchName} — ${report.parsed} parsed, ${report.skipped} skipped, ${report.deleted} deleted, ${report.renamed} renamed, ${report.errors} errors` `` (drop everything from `; semantic ${report.semantic.status}` onward). `penguin search --semantic ...` flag is removed (handled together with Task 8's `search-engine.ts` changes — this task removes the CLI-side flag parsing and validation only).

- [ ] **Step 1: Re-locate exact anchors**

```bash
grep -n '"semantic"\|semanticWorker\|ensureSemanticWorker\|listSemanticStatuses\|executeSemanticControl\|semanticMode\|optionValue("semantic")' packages/knowledge-cli/src/command-dispatch.ts
```

- [ ] **Step 2: Delete the `semantic` verb block**

Delete the entire `if (verb === "semantic") { ... }` block (starts ~line 645; find its matching close via bracket-matching or by locating the next `if (verb === ...)` sibling). This removes the `wake`/`status`/`pause`/`resume`/whatever sub-actions it dispatches internally, including the `ensureSemanticWorker` call at ~693 and the `executeSemanticControl` call at ~748-752.

- [ ] **Step 3: Remove the wake-on-index/rebuild hook**

At ~line 1591-1605, delete:
```ts
const semanticWorker = targetIndex === targets.length - 1
  ? ensureSemanticWorker({ store, cwd: deps.cwd })
  : undefined;
const outputReport = semanticWorker ? { ...report, semanticWorker } : report;
```
replacing all downstream uses of `outputReport` in this block with `report` directly (check the emit call and the human-readable message construction that follows — both currently reference `outputReport` and `report.semantic.status`/`semanticWorker?.status`). Rewrite the human message template to drop the `; semantic ${report.semantic.status}...` and `${semanticWorker?.status === ... }` suffixes entirely, per this task's Produces section above.

- [ ] **Step 4: Remove the `--semantic` search flag parsing**

At ~2388-2390, delete:
```ts
const semanticMode = optionValue("semantic");
if (semanticMode && !["off", "fallback", "blend"].includes(semanticMode)) {
  return emitCliError(deps, json, "INVALID_ARGUMENT", `invalid semantic mode: ${semanticMode}`, 2, { semantic: semanticMode, remediation: "use one of: off, fallback, blend" });
}
```
and in the `searchKnowledgeAsync(...)` call a few lines below, remove `semantic: (semanticMode as ...) ?? "off"` from the `options` object and remove the trailing `...(semanticMode && semanticMode !== "off" ? { semanticProviderFactory: optionalBundledSemanticProvider } : {})` spread from the second argument. Remove the now-unused `optionalBundledSemanticProvider` import if nothing else in this file uses it (`grep -n optionalBundledSemanticProvider packages/knowledge-cli/src/command-dispatch.ts`).

- [ ] **Step 5: Remove now-dead imports**

Delete the import lines at 84 (`listSemanticStatuses`), 94 (`executeSemanticControl`), and 116 (`import { ensureSemanticWorker, runSemanticWorkerWithProcessSignals } from "./semantic-worker.js";`).

- [ ] **Step 6: Delete `semantic-worker.ts` and update `query-server.ts`/`index.ts`**

```bash
git rm packages/knowledge-cli/src/semantic-worker.ts
```
In `query-server.ts`, remove the `import { ensureSemanticWorker } from "./semantic-worker.js";` (line 7) and the `wake: () => ensureSemanticWorker({ store, cwd: deps.cwd }),` callback (line 520) — check what object this callback is passed into (likely the same `executeSemanticControl`-shaped request handler as command-dispatch.ts) and remove that whole call if `executeSemanticControl` itself is gone by this point (it will be, per Step 2 — if `query-server.ts` has its own independent semantic control code path, remove it in full here too).
In `packages/knowledge-cli/src/index.ts`, remove the `runSemanticWorker`, `ensureSemanticWorker`, `readSemanticWorkerRuntimeState`, `SemanticWorkerResult` re-exports (~lines 16-19).

- [ ] **Step 7: Build and smoke-test the CLI**

Run: `pnpm -C packages/knowledge-cli build`
Then from repo root: `penguin index` (or the built CLI binary directly) against this repo, and `penguin search "VectorStore"` — confirm both still work and produce sensible output with no mention of `semantic`/`worker` in the report line.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete CLI semantic verb and wake-on-index hook"
```

---

## Task 6: Remove `knowledge-indexer` embedding wiring from the main pipeline

**Files:**
- Modify: `packages/knowledge-indexer/src/pipeline.ts:30,72,1291,1301,1335,1342,1446,1502-1560,2525-2536`
- Modify: `packages/knowledge-indexer/src/watcher.ts:30,59`
- Delete: `packages/knowledge-indexer/src/embedding-indexer.ts`, `packages/knowledge-indexer/src/embedding-worker.ts`, `packages/knowledge-indexer/src/full-corpus-runner.ts`
- Modify: `packages/knowledge-indexer/src/index.ts:93,94` (drop the two export lines for these files)

**Interfaces:**
- Consumes: nothing after Task 5 (CLI no longer passes a `semantic` option into `indexRepo`/`watchRepo`; verify with `grep -rn "semantic:" packages/knowledge-cli/src` that no call site still constructs a `semantic` option object — if one remains, e.g. a `penguin index --semantic` flag not yet covered by Task 5, remove that flag's parsing there first).
- Produces: `IndexReport` no longer has a `semantic` field. `indexRepo()`/`watchRepo()` no longer accept a `semantic` option. The `"semantic"` stage is removed from `IndexStageId` and from the stage-timing/report loop.

- [ ] **Step 1: Re-locate exact anchors**

```bash
grep -n "semantic\|embedding\|enqueueSemanticGeneration" packages/knowledge-indexer/src/pipeline.ts
```

- [ ] **Step 2: Remove the type surface**

Delete `semantic: SemanticIndexReport;` from the `IndexReport` type (~line 72) and delete the `SemanticIndexReport`/`SemanticIndexOptions` type declarations themselves (find their `interface`/`type` definitions via `grep -n "SemanticIndexReport\|SemanticIndexOptions" packages/knowledge-indexer/src/pipeline.ts`). Remove `"semantic"` from the `IndexStageId` union (~line 1291) and remove `semantic?: SemanticIndexOptions;` from the indexer input options type (~line 1335).

- [ ] **Step 3: Remove the embedding stage execution block**

Delete the whole guarded block at ~1502-1560 (starts with the comment about "A large local embedding backfill can take minutes" and the `const semanticOptions = input.semantic; if (!semanticOptions || semanticOptions.enabled === false) return;` guard, through the end of that function). Delete the default-report initializer at ~1446: `semantic: { requested: ..., status: "disabled", ... }`.

- [ ] **Step 4: Remove the final-report stage tracking**

Delete the `if (input.semantic && input.semantic.enabled !== false) { ...stageStart("semantic")... }` block at ~2525-2536 that appends the semantic stage timing/summary line into the final human-readable report.

- [ ] **Step 5: Remove the `enqueueSemanticGeneration` import**

Delete `import { enqueueSemanticGeneration } from "./embedding-indexer.js";` (line 30).

- [ ] **Step 6: Update `watcher.ts`**

Delete `semantic?: SemanticIndexOptions;` (line 30) from the watcher's input type, and change line 59 from:
```ts
const report = await indexRepo({ store: input.store, rootPath: input.rootPath, mode: "incremental", semantic: input.semantic });
```
to:
```ts
const report = await indexRepo({ store: input.store, rootPath: input.rootPath, mode: "incremental" });
```

- [ ] **Step 7: Delete the embedding implementation files and update the barrel export**

```bash
git rm packages/knowledge-indexer/src/embedding-indexer.ts packages/knowledge-indexer/src/embedding-worker.ts packages/knowledge-indexer/src/full-corpus-runner.ts
```
In `packages/knowledge-indexer/src/index.ts`, delete lines 93-94:
```ts
export { backfillEmbeddings, activateEmbeddingGeneration, enqueueSemanticGeneration, drainSemanticQueue, garbageCollectEmbeddingVectors, type EmbeddingBackfillCheckpoint, type EmbeddingBackfillInput, type EmbeddingBackfillResult, type SemanticEnqueueResult, type SemanticDrainInput, type SemanticDrainResult } from "./embedding-indexer.js";
export { recoverEmbeddingWorker } from "./embedding-worker.js";
```

- [ ] **Step 8: Build and run the indexer's core tests**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/knowledge-embedding-indexer.test.mjs` — expected to now fail/not-found since the file is gone; this confirms it's next in line for Task 13's deletion. Then run a non-semantic indexer test, e.g. `node --test tests/knowledge-full-reset-policy.test.mjs` (edit first if it references `semantic` options — strip those references, keep the rest) to confirm the core pipeline still passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete embedding stage from indexer pipeline"
```

---

## Task 7: Remove `packages/knowledge-core` vector/embedding implementation files

**Files:**
- Delete: `packages/knowledge-core/src/vector-store.ts`, `transformers-embedding-backend.ts`, `bundled-embedding-provider.ts`, `local-embedding-provider.ts`, `embedding-lifecycle.ts`, `embedding-provider.ts` (only if nothing non-semantic imports the `EmbeddingProvider` interface from it — check first), `semantic-chunks.ts`, `semantic-status.ts`, `semantic-control.ts`, `semantic-identity.ts`, `semantic-search.ts`
- Modify: `packages/knowledge-core/src/index.ts` (remove every export line pulling from the deleted files — lines 114, 222, and others found via `grep -n "semantic\|embedding\|VectorStore" packages/knowledge-core/src/index.ts`)
- Modify or delete: `packages/knowledge-core/src/hybrid-search.ts` — see Step 3
- Modify: `packages/knowledge-core/src/asset-export.ts`, `index-reset.ts` — check first whether their semantic references are incidental (e.g. resetting/exporting semantic tables alongside everything else) or core to the file; strip only the semantic-specific branches, keep the rest

**Interfaces:**
- Consumes: nothing after Task 6 (indexer no longer imports any of these).
- Produces: `@penguin/knowledge-core`'s public barrel (`index.ts`) exports zero semantic/embedding/vector symbols. `search-engine.ts`'s sync `searchKnowledge()` path is untouched (verified separately in Task 8).

- [ ] **Step 1: Confirm no other consumer remains**

```bash
grep -rln "from \"./vector-store\|from \"./transformers-embedding-backend\|from \"./bundled-embedding-provider\|from \"./local-embedding-provider\|from \"./embedding-lifecycle\|from \"./semantic-chunks\|from \"./semantic-status\|from \"./semantic-control\|from \"./semantic-identity\|from \"./semantic-search" packages/knowledge-core/src/
```
Every hit other than `index.ts` (the barrel) and files already scheduled for deletion in this task must be investigated before proceeding — it means a non-semantic file still depends on one of these and needs its own targeted edit first.

- [ ] **Step 2: Check `embedding-provider.ts` for non-semantic use**

```bash
grep -rln "embedding-provider" packages/knowledge-core/src/ packages/knowledge-indexer/src/ packages/knowledge-cli/src/
```
If only semantic files reference `EmbeddingProvider`, delete `embedding-provider.ts` too. If `search-engine.ts` still needs the `EmbeddingProvider` type for its `semanticProvider`/`semanticProviderFactory` context fields (it does, per Task 8's findings — `search-engine.ts:24-25`), do **not** delete this file yet; Task 8 removes those fields first, then this file becomes deletable — reorder if needed, or leave `embedding-provider.ts` deletion as the last step of Task 8 instead.

- [ ] **Step 3: Reduce `hybrid-search.ts`**

`hybrid-search.ts` exports `HybridSearchConfig`, `fuseHybridHits`, `searchPersistedVectors`, `PersistedVectorSearchInput`, `PersistedVectorSearchResult`, `RetrievalProvenance` — all vector-specific. Confirm via `grep -rn "fuseHybridHits\|searchPersistedVectors\|HybridSearchConfig\|RetrievalProvenance" packages/knowledge-core/src/search-engine.ts` that `search-engine.ts` is the only consumer (it is, per the earlier investigation: `search-engine.ts:13`). Once Task 8 removes that import, delete `hybrid-search.ts` entirely:
```bash
git rm packages/knowledge-core/src/hybrid-search.ts
```
(Do this step after Task 8's Step 2, or reorder Tasks 7 and 8 if your working style prefers; both orders are safe since nothing outside `search-engine.ts` imports from `hybrid-search.ts`.)

- [ ] **Step 4: Delete the remaining implementation files**

```bash
git rm packages/knowledge-core/src/vector-store.ts \
       packages/knowledge-core/src/transformers-embedding-backend.ts \
       packages/knowledge-core/src/bundled-embedding-provider.ts \
       packages/knowledge-core/src/local-embedding-provider.ts \
       packages/knowledge-core/src/embedding-lifecycle.ts \
       packages/knowledge-core/src/semantic-chunks.ts \
       packages/knowledge-core/src/semantic-status.ts \
       packages/knowledge-core/src/semantic-control.ts \
       packages/knowledge-core/src/semantic-identity.ts \
       packages/knowledge-core/src/semantic-search.ts
```

- [ ] **Step 5: Clean `asset-export.ts` and `index-reset.ts`**

```bash
grep -n "semantic\|embedding\|vector" packages/knowledge-core/src/asset-export.ts packages/knowledge-core/src/index-reset.ts
```
For each hit, remove the semantic-specific branch/field while keeping the surrounding non-semantic export/reset logic intact (these files export/reset the whole knowledge DB — only their semantic slice goes).

- [ ] **Step 6: Update the barrel `index.ts`**

Remove every export line whose source file was deleted above — at minimum lines 114 and 222 (per the earlier `grep`), plus any others found by re-running:
```bash
grep -n "semantic\|embedding\|Vector\|Hybrid" packages/knowledge-core/src/index.ts
```

- [ ] **Step 7: Build**

Run: `pnpm -C packages/knowledge-core build`
Expected: fails only on `search-engine.ts` (handled in Task 8) if that task hasn't run yet — otherwise clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete vector store, embedding providers, and semantic chunk/status/control modules"
```

---

## Task 8: Strip the semantic/hybrid lane out of `search-engine.ts`

**Files:**
- Modify: `packages/knowledge-core/src/search-engine.ts:13,24-25,319-370ish,529,693,726,780-853ish`

**Interfaces:**
- Consumes: nothing from `hybrid-search.ts` after this task (paired with Task 7 Step 3).
- Produces: `searchKnowledge()` (sync) — **unchanged, verify by diff that this function's body is untouched**. `searchKnowledgeAsync()` becomes a thin wrapper that just calls `searchKnowledge()` (or is removed entirely if nothing calls it once the CLI's `--semantic` flag is gone from Task 5 — check `grep -rn "searchKnowledgeAsync" packages/` first).

- [ ] **Step 1: Determine whether `searchKnowledgeAsync` still has callers**

```bash
grep -rn "searchKnowledgeAsync" packages/ src/ src-tauri/
```
After Task 5 removed the CLI's only call site (`command-dispatch.ts`'s `useV2Search` branch), check whether the same function is still needed for a non-semantic reason (e.g. cursor/compact-mode search that doesn't involve semantic at all — re-read the `useV2Search || optionValue("mode") || flags.includes("--compact") || optionValue("cursor")` condition from Task 5 Step 4: this async path handles compact/cursor/mode search generally, not just semantic). **If it has non-semantic callers, keep the function and only strip its semantic branch** (Step 3 below) rather than deleting it.

- [ ] **Step 2: Remove the `hybrid-search.ts` import and semantic provider fields**

Delete `import { fuseHybridHits, searchPersistedVectors } from "./hybrid-search.js";` (line 13) and the `semanticProvider?: EmbeddingProvider; semanticProviderFactory?: () => Promise<EmbeddingProvider | undefined>;` fields (lines 24-25) from the search context type. Now check `embedding-provider.ts` again per Task 7 Step 2 — it should be safe to delete now.

- [ ] **Step 3: Strip the semantic branch from `searchKnowledgeAsync`**

The function (starting ~line 787, per the comment "Async companion for the optional semantic lane") should collapse to: run the deterministic search (what it currently does when `request.options.semantic === "off"`, ~line 793-802) and return that directly — delete everything from the `semanticPartial` check (~814) through the vector-hit-fusing logic and the `semanticProvider.health()` call (~862) onward, up to wherever the function returns. Keep the `semanticProgressForScopes` helper only if it's still meaningfully used elsewhere (it likely isn't — check `grep -n "semanticProgressForScopes" packages/knowledge-core/src/search-engine.ts`; if its only caller was inside the deleted branch, delete the helper function too, along with its `semantic_active_spaces` SQL query at ~line 336).

- [ ] **Step 4: Clean the diagnostics/response builder**

In the main `searchKnowledge` response builder (~line 781), remove the `semantic: { requested: semanticDeferred, ... }` diagnostics field and the `semanticDeferred`/`SEMANTIC_LANE_UNAVAILABLE` warning (~line 693) **only if** `semanticDeferred` (~line 365, driven by `plan.stages.some((stage) => stage.lane === "semantic")`) can no longer ever be true — confirm by checking whether anything still plans a `"semantic"` lane stage (it shouldn't, once Task 5's `--semantic` CLI flag and Task 6's pipeline changes are done). If `plan.stages` can still contain a `"semantic"` lane for some other structural reason, stop and re-investigate before deleting this — don't guess.

- [ ] **Step 5: Narrow the `semantic` search mode/source enums**

This step touches `packages/knowledge-contracts` (owned by Task 11) — do not do it here; just confirm via `grep -n '"semantic"' packages/knowledge-core/src/search-engine.ts` that no remaining reference needs the contracts-level enum changed before Task 11 runs, and note any such reference for that task.

- [ ] **Step 6: Build and run the search engine test**

Run: `pnpm -C packages/knowledge-core build && node --test tests/knowledge-search-engine.test.mjs`
Expected: build clean. The test file likely has semantic-specific cases — edit it now to remove only those (see Task 13 for the full test cleanup pass; you may do it here instead if it's faster to do while the context is fresh).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "remove(knowledge): strip semantic/hybrid lane from search-engine.ts"
```

---

## Task 9: Remove semantic table creation and migrations from `schema.ts`

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts:109-125,1033-1136,1209(check only),1339-1341,2429-2536,2813-2919`

**Interfaces:**
- Consumes: nothing (schema is the base layer; by this point in the plan no TypeScript code references these table names except `schema.ts` itself and the status-panel summary code touched in Step 3).
- Produces: A **fresh** `KnowledgeStore.open()` no longer creates any of the ten semantic/embedding/vector tables or their indexes. An **existing** database that already has these tables is untouched by this change (per the Global Constraints — no `DROP TABLE`); the additive-migration code that used to backfill new columns onto these tables for old DBs is removed since there's no longer a "current" schema definition for them to migrate toward.

- [ ] **Step 1: Verify `knowledge_audit_events` is genuinely semantic-specific before touching it**

```bash
grep -n "knowledge_audit_events" packages/knowledge-core/src/*.ts packages/knowledge-indexer/src/*.ts packages/knowledge-cli/src/*.ts packages/mcp/src/*.ts
```
Read every hit. If it's written to or read by any non-semantic code path (general audit logging, e.g. for index/rebuild/reset events), **leave its table definition and all non-semantic writers alone** — only remove it from the `semanticTables` list at ~1339-1341 used for the semantic-only status summary (Step 3), not from the schema's `CREATE TABLE` statements.

- [ ] **Step 2: Remove the table/index definitions**

Delete the `CREATE INDEX` statements at lines 118-125 (`idx_semantic_chunks_snapshot`, `idx_semantic_chunks_reuse`, `idx_semantic_embedding_refs_reuse`) and their names from whatever list they're declared in at 109-111. Delete the ten `CREATE TABLE IF NOT EXISTS` statements at lines 1033-1136 (`semantic_chunks`, `embedding_models`, `semantic_embedding_refs`, `semantic_vector_values` + its index, `embedding_spaces`, `embedding_generations`, `embedding_jobs`, `semantic_worker_leases`, `semantic_controls`, `semantic_active_spaces`) — **excluding `knowledge_audit_events` per Step 1's finding**.

- [ ] **Step 3: Update the status-panel semantic-tables summary**

At ~1339-1341, remove the deleted table names from the `semanticTables` array (keep `knowledge_audit_events` in/out per Step 1's finding). If this array becomes empty or near-empty, check its caller (`buildStatusPanel`/`buildStorageReport` per earlier `grep` results in `query-server.ts`) to see whether the whole "semantic storage" section of the status panel output should now be omitted rather than shown as all-zero — prefer omitting it cleanly over showing a hollow "0 chunks, 0 tables" section.

- [ ] **Step 4: Remove the additive migrations**

Delete the migration logic at ~2429-2536 (`semanticChunkCols`/`semanticRefCols`/`semanticVectorValueCols` `ALTER TABLE ADD COLUMN` blocks, the `idx_semantic_embedding_refs_generation` index creation, and the legacy-generation-id backfill `UPDATE semantic_embedding_refs SET status='legacy'...`) and the duplicate/related block at ~2813-2919 (same column-existence checks plus the `idx_semantic_embedding_refs_vec_rowid` index). Read the surrounding function bodies fully before deleting — confirm each block is scoped to semantic tables only and doesn't also perform an unrelated migration step that needs to stay.

- [ ] **Step 5: Confirm `SCHEMA_VERSION` doesn't need to bump**

Run `tests/knowledge-schema-v18.test.mjs` (edit it first — see Task 13) after this task's other steps. If it fails in a way that indicates the stored/expected schema version must change (rather than just an assertion about table presence), only then bump `SCHEMA_VERSION` at line 1209 and update the test's expectations to match — do not bump preemptively.

- [ ] **Step 6: Build and test**

Run: `pnpm -C packages/knowledge-core build && node --test tests/knowledge-schema-v18.test.mjs tests/knowledge-full-reset-policy.test.mjs`
Expected: clean build; both tests pass once their semantic-specific assertions are removed (Task 13).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "remove(knowledge): stop creating/migrating semantic tables in schema.ts"
```

---

## Task 10: Remove semantic contracts/types from `packages/knowledge-contracts`

**Files:**
- Delete: `packages/knowledge-contracts/src/semantic.ts`
- Modify: `packages/knowledge-contracts/src/search.ts:11,20,114,248,260` (drop `"semantic"` from the mode/source unions and the arrays that enumerate them)
- Modify: `packages/knowledge-contracts/src/response.ts:77` (drop `"semantic"` from the source validation list — keep `"source" | "graph" | "note" | "runtime"`)
- Modify: `packages/knowledge-contracts/src/input-schemas.ts:79` (drop `"semantic"` from the `mode` enum for `"knowledge.search"`)

**Interfaces:**
- Consumes: nothing (by this point, Task 3's `knowledge-client.ts` and Tasks 5-8 no longer import anything from `semantic.ts` or reference the `"semantic"` mode/source literal).
- Produces: The public search contract no longer advertises a `"semantic"` mode or source anywhere in its validated schema, CLI help text, or MCP tool input schema.

- [ ] **Step 1: Confirm zero remaining consumers of `semantic.ts`**

```bash
grep -rln "knowledge-contracts/src/semantic\|from \"./semantic.js\"\|from \"../semantic.js\"" packages/ src/ 2>/dev/null
```
This should now return nothing (Task 3 removed `knowledge-client.ts`'s import). If anything still shows up, go fix that call site first — do not delete `semantic.ts` until this is empty.

- [ ] **Step 2: Delete the file**

```bash
git rm packages/knowledge-contracts/src/semantic.ts
```

- [ ] **Step 3: Narrow the mode/source enums**

In `search.ts`, remove `"semantic"` from both union declarations (lines 11 and 20) and from the `source: "source" | "graph" | "note" | "runtime" | "semantic";` field type (line 114), and from the two enumerated arrays at lines 248 and 260 (check what these arrays are for — likely "valid modes" and "valid sources" lists used for validation/CLI help — remove the string from both, keep everything else in the array unchanged).

In `response.ts` line 77, change:
```ts
if (!["source", "graph", "note", "runtime", "semantic"].includes(String(value.source))) {
```
to:
```ts
if (!["source", "graph", "note", "runtime"].includes(String(value.source))) {
```

In `input-schemas.ts` line 79, remove `"semantic"` from the `enum: ["auto", "exact", "phrase", "substring", "path", "regex", "lexical", "semantic", "structural"]` array for the `"knowledge.search"` input schema.

- [ ] **Step 4: Build**

Run: `pnpm -C packages/knowledge-contracts build`
Then rebuild every downstream package that consumes it: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && pnpm -C packages/knowledge-cli build && pnpm -C packages/mcp build`
Expected: all clean — this confirms Tasks 1-9 fully severed every semantic dependency before this base package's types were narrowed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "remove(knowledge): drop semantic mode/source from knowledge-contracts"
```

---

## Task 11: Remove bundled Nomic model assets and packaging scripts

**Files:**
- Delete: `packages/knowledge-cli/bundle/models/nomic-embed-text-v1.5/` (entire directory: `config.json`, `tokenizer.json`, `manifest.json`, plus any model weight files alongside them — `ls` the directory first to get the full file list, don't assume only these three)
- Delete: `.cache/models/nomic-embed-text-v1.5/` (same — this looks like a local dev cache; confirm it's not `.gitignore`d already before `git rm`, it may just need a plain `rm -rf` if untracked)
- Modify: `config/knowledge-embedding-models.json` — delete entirely if it only lists Nomic/embedding models (confirm with `cat`), or remove just the Nomic entry if the file has a broader purpose
- Modify: `scripts/bundle-knowledge-cli.mjs`, `scripts/vendor-knowledge-runtime.mjs` — remove the steps that copy/vendor the Nomic model files and any ONNX runtime vendoring specific to the embedding backend (read each script fully first; they likely also vendor Node/native modules unrelated to Nomic that must stay)
- Delete: `scripts/knowledge-hybrid-benchmark.mjs`, `scripts/knowledge-semantic-fire-and-forget-acceptance.mjs`, `scripts/knowledge-semantic-performance-gate.mjs`, `scripts/knowledge-release-bundle-gate.mjs` (confirm this last one is semantic-only, not a general release gate, before deleting — `grep -n nomic\|semantic scripts/knowledge-release-bundle-gate.mjs` first)

**Interfaces:**
- Consumes: nothing (by this task, no runtime code loads the Nomic model).
- Produces: The CLI bundle no longer ships the ~hundreds-of-MB Nomic model files. `git status`/`du -sh .git` should show a meaningful size reduction after this is committed (the model binary weights, if they were ever committed rather than `.gitignore`d/LFS'd — check `git log --follow -- packages/knowledge-cli/bundle/models/nomic-embed-text-v1.5` to see if large blobs are actually in history; if so, this task only stops shipping them going forward — purging git history is out of scope for this plan and would need explicit separate sign-off since it rewrites history).

- [ ] **Step 1: Inventory what's actually there**

```bash
ls -la packages/knowledge-cli/bundle/models/nomic-embed-text-v1.5/ .cache/models/nomic-embed-text-v1.5/
git check-ignore .cache/models/nomic-embed-text-v1.5/config.json; echo "exit=$?"
```
(`exit=0` means it's already gitignored — just delete the local files, no `git rm` needed / nothing to commit for that directory.)

- [ ] **Step 2: Delete the model directories**

```bash
git rm -r packages/knowledge-cli/bundle/models/nomic-embed-text-v1.5/
rm -rf .cache/models/nomic-embed-text-v1.5/   # or `git rm -r` instead if Step 1 showed it's tracked
```

- [ ] **Step 3: Clean the packaging/vendoring scripts**

Read `scripts/bundle-knowledge-cli.mjs` and `scripts/vendor-knowledge-runtime.mjs` fully. Remove any step that copies the `nomic-embed-text-v1.5` directory into a release bundle, and any ONNX-runtime-specific vendoring block used only for the Transformers.js/ONNX embedding backend. Keep every other vendoring/bundling step (this script almost certainly also vendors Node itself, native `.node` addons for SQLite, etc. — those stay).

- [ ] **Step 4: Delete the semantic-only scripts**

```bash
grep -n "nomic\|semantic" scripts/knowledge-release-bundle-gate.mjs | head -5
```
If this script is entirely about gating the semantic bundle's release readiness (its name and the earlier grep hit suggest yes), delete it and its corresponding test `tests/knowledge-release-bundle-gate.test.mjs`. Otherwise, strip only its semantic-specific checks and keep the rest, noting this for Task 13.
```bash
git rm scripts/knowledge-hybrid-benchmark.mjs scripts/knowledge-semantic-fire-and-forget-acceptance.mjs scripts/knowledge-semantic-performance-gate.mjs
```

- [ ] **Step 5: Clean up `config/knowledge-embedding-models.json`**

```bash
cat config/knowledge-embedding-models.json
```
Delete the file if it exists solely to configure embedding model choices; grep for its usages first (`grep -rn "knowledge-embedding-models" packages/ scripts/`) and remove those call sites too (should already be gone via Tasks 6-8, since only the embedding indexer/provider read this config).

- [ ] **Step 6: Rebuild the CLI bundle and confirm it still works without the model**

```bash
node scripts/bundle-knowledge-cli.mjs   # or whatever this repo's actual bundle command is — check package.json scripts first
```
Then smoke-test the bundled CLI: `penguin index` on this repo, `penguin search "hybrid"`. Expected: works identically to before, no error about a missing model (nothing should try to load it anymore after Tasks 6-8).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "remove(knowledge): delete bundled Nomic model assets and semantic packaging scripts"
```

---

## Task 12: Delete or edit the semantic/vector/embedding test files

**Files (delete entirely — these test only deleted code):**
- `tests/knowledge-bundle-runtime.test.mjs`
- `tests/knowledge-embedding-indexer.test.mjs`
- `tests/knowledge-embedding-lifecycle.test.mjs`
- `tests/knowledge-installed-full-corpus.test.mjs` (confirm first — name suggests full-corpus semantic install; `grep -n semantic\|embedding` before deleting in case it also covers non-semantic install behavior worth keeping)
- `tests/knowledge-local-embedding.test.mjs`
- `tests/knowledge-model-assets.test.mjs`
- `tests/knowledge-pipeline-semantic-indexing.test.mjs`
- `tests/knowledge-release-bundle-gate.test.mjs` (pair with Task 11 Step 4's decision)
- `tests/knowledge-selected-embedding-model.test.mjs`
- `tests/knowledge-semantic-fire-and-forget.test.mjs`
- `tests/knowledge-semantic-identity.test.mjs`
- `tests/knowledge-semantic-performance-gate.test.mjs`
- `tests/knowledge-semantic-status-contract.test.mjs`
- `tests/knowledge-semantic-supervisor.test.mjs`
- `tests/knowledge-semantic-worker-leases.test.mjs`
- `tests/knowledge-semantic-worker-performance.test.mjs`
- `tests/knowledge-tauri-semantic-control.test.mjs`
- `tests/knowledge-transformers-embedding-backend.test.mjs`
- `tests/knowledge-vector-cli-mcp-parity.test.mjs`
- `tests/knowledge-vector-gc.test.mjs`
- `tests/knowledge-vector-store.test.mjs`

**Files (edit — mixed semantic + non-semantic coverage, strip only the semantic parts, per the earlier tasks that already flagged them):**
- `tests/knowledge-schema-v18.test.mjs` (Task 9)
- `tests/knowledge-search-engine.test.mjs` (Task 8)
- `tests/knowledge-mcp-tools.test.mjs` (Task 4)
- `tests/knowledge-cli-render.test.mjs` (Task 5)
- `tests/knowledge-full-reset-policy.test.mjs` (Task 6/9)
- `tests/wiki-page.test.mjs` (Task 1 — check if it asserts `SemanticWorkerPanel` renders; remove that assertion)
- `tests/knowledge-wiki-semantic-status-ui.test.mjs` — likely delete-entirely candidate, but confirm it doesn't also cover other WikiPage behavior worth keeping under a different test name

**Interfaces:**
- Consumes: nothing — this is the verification pass confirming every production file targeted in Tasks 1-11 has no orphaned test still importing it.
- Produces: `node --test tests/` (full suite) runs green with zero references to any deleted symbol/file.

- [ ] **Step 1: Confirm every delete-entirely candidate truly only tests deleted code**

For each file in the "delete entirely" list, run:
```bash
grep -n "^import\|require(" tests/<file>.test.mjs
```
and confirm every imported module was deleted in Tasks 1-11. If a file imports even one still-alive symbol for a still-alive assertion, move it to the "edit" list instead of deleting it outright.

- [ ] **Step 2: Delete the confirmed delete-entirely files**

```bash
git rm tests/knowledge-bundle-runtime.test.mjs tests/knowledge-embedding-indexer.test.mjs tests/knowledge-embedding-lifecycle.test.mjs tests/knowledge-local-embedding.test.mjs tests/knowledge-model-assets.test.mjs tests/knowledge-pipeline-semantic-indexing.test.mjs tests/knowledge-selected-embedding-model.test.mjs tests/knowledge-semantic-fire-and-forget.test.mjs tests/knowledge-semantic-identity.test.mjs tests/knowledge-semantic-performance-gate.test.mjs tests/knowledge-semantic-status-contract.test.mjs tests/knowledge-semantic-supervisor.test.mjs tests/knowledge-semantic-worker-leases.test.mjs tests/knowledge-semantic-worker-performance.test.mjs tests/knowledge-tauri-semantic-control.test.mjs tests/knowledge-transformers-embedding-backend.test.mjs tests/knowledge-vector-cli-mcp-parity.test.mjs tests/knowledge-vector-gc.test.mjs tests/knowledge-vector-store.test.mjs
```
(Add/remove `knowledge-installed-full-corpus.test.mjs`, `knowledge-release-bundle-gate.test.mjs`, `knowledge-wiki-semantic-status-ui.test.mjs` to this command based on Step 1's findings for each.)

- [ ] **Step 3: Edit the mixed-coverage files**

For each file in the "edit" list, open it and remove only the `test(...)`/`describe(...)` blocks whose name or body references semantic/embedding/vector/nomic concepts, keeping every other test case in the file byte-for-byte identical. This was already scoped per-task above (Tasks 1, 4, 5, 6, 8, 9) — this step is the final sweep to catch anything those tasks deferred.

- [ ] **Step 4: Run the full test suite**

Run: `node --test tests/`
Expected: every remaining test passes. Investigate and fix (not skip) any failure — a failure here means an earlier task missed a call site.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(knowledge): remove semantic/vector/embedding test coverage"
```

---

## Task 13: Update `docs/knowledge-v2/*` documentation

**Files:**
- Modify: `docs/knowledge-v2/capability-matrix.md`, `cli-reference.md`, `mcp-reference.md`, `schema-reference.md`, `penguin-wiki-comparison.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: Docs accurately describe the post-removal system — no dangling references to `penguin semantic`, `knowledge_semantic_status`/`knowledge_semantic_control`, the Nomic model, `VectorStore`, or the semantic search mode.

- [ ] **Step 1: Grep each doc for stale references**

```bash
grep -n "semantic\|nomic\|Nomic\|vector\|embedding" docs/knowledge-v2/capability-matrix.md docs/knowledge-v2/cli-reference.md docs/knowledge-v2/mcp-reference.md docs/knowledge-v2/schema-reference.md docs/knowledge-v2/penguin-wiki-comparison.md
```

- [ ] **Step 2: Edit each file**

Remove the rows/sections describing the semantic capability, the `penguin semantic` CLI subcommand, the `knowledge_semantic_status`/`knowledge_semantic_control` MCP tools, and the semantic table schema. Keep every other capability/command/tool/table documented as-is. Where a capability matrix row exists for "semantic search: not yet wired to production" (per `docs/quality/penguin-knowledge-power-roadmap-claude-deepseek.md`'s own assessment that it was never live end-to-end), change it to state the capability was removed rather than leaving a stale "planned"/"partial" status.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(knowledge): remove semantic/vector search from knowledge-v2 docs"
```

---

## Task 14: Full-repo verification

**Files:** none (verification only)

- [ ] **Step 1: Full build**

```bash
pnpm build   # or the repo's actual top-level build script — check package.json first
cd src-tauri && cargo build && cd -
```
Expected: clean, no errors, no warnings about unused semantic-only symbols left behind.

- [ ] **Step 2: Full typecheck**

```bash
pnpm typecheck   # or pnpm tsc --noEmit at each package — check what this repo actually wires up
```
Expected: clean.

- [ ] **Step 3: Full test suite**

```bash
node --test tests/
```
Expected: all green.

- [ ] **Step 4: Rust test suite**

```bash
cd src-tauri && cargo test && cd -
```
Expected: all green.

- [ ] **Step 5: CLI smoke test against this repo**

```bash
penguin index    # confirm original graph/symbol/keyword indexing still works
penguin search "VectorStore"    # confirm keyword search still works (should find historical mentions in docs, or nothing if fully clean — either is fine, the point is no crash)
```

- [ ] **Step 6: MCP smoke test**

From this Claude Code session (or a fresh one), call `mcp__penguin__knowledge_search` and `mcp__penguin__knowledge_context` against this repo — confirm both still return results with no error, and that `mcp__penguin__knowledge_semantic_status`/`knowledge_semantic_control` are no longer offered as tools at all (they should not appear in the MCP tool list once the server picks up the rebuilt `packages/mcp`).

- [ ] **Step 7: grep for any remaining stray reference**

```bash
grep -ril "nomic" --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.rs" --include="*.json" . 2>/dev/null | grep -v node_modules | grep -v /dist/ | grep -v /target/
```
Expected: no hits (aside from this plan document itself, and any `docs/quality/*`/`docs/superpowers/plans/*` historical records that describe past work and are intentionally left as-is as project history, not live docs).

- [ ] **Step 8: Final commit (if anything was left uncommitted)**

```bash
git status
git add -A && git commit -m "chore(knowledge): final verification pass after Nomic vector search removal"
```
