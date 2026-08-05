# Phase 1B — Wiki Trust Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Wiki surfaces the trust data Phase 1A plumbed — real status footer, locator/warning display, scope-blocker rendering, locator-preserving navigation — and the temporary bridge `--allow-fallback` injection is removed.

**Architecture:** Core gets a small GitState cache + one new `knowledge.status_panel` capability; the Tauri allowlist widens; `src/lib/knowledge-client.ts` grows typed helpers; the Wiki components consume envelope fields that already arrive in every CLI-bridge response. Strictness order matters: UI learns to *render* blockers (Tasks 5-7) before the bridge stops shielding it (Task 8).

**Tech Stack:** TypeScript, React (src/), Tauri (src-tauri, Rust — one allowlist edit), node --test for core/CLI/client-testable logic. React components have no test harness in this repo — UI tasks gate on `pnpm run build` (tsc -b + vite) plus assertions at the knowledge-client/query-server layer where the logic actually lives.

## Global Constraints

- Carryover source: `docs/superpowers/plans/2026-08-05-phase1b-carryover-notes.md` (terminal review findings). Spec: `docs/superpowers/specs/2026-08-05-penguin-trust-roadmap-design.md` Phase 1.
- Envelope contract (from 1A, do not change shapes): every knowledge.cli bridge JSON result may carry `locator: KnowledgeLocator`, `alignment: "aligned"|"revision_behind"|"fallback"|"explicit"`, `warnings: StructuredWarning[]`, and legacy verbs may carry `scopeFallback`. `KnowledgeLocator` fields: repoId, repoName, rootPath, branchId?, branchName?, commitSha?, snapshotId, worktreeState, indexedAt?.
- Task ordering is load-bearing: Task 8 (remove bridge injection) MUST come after Tasks 5-7 (UI renders blockers/warnings). Never reorder.
- Tests: `node --test tests/<file>.test.mjs`, import from package dist; build first (`pnpm -F @penguin/knowledge-contracts build && pnpm -F @penguin/knowledge-core build && pnpm -F @penguin/knowledge-indexer build && pnpm -F @penguin/api-doc-generator build && pnpm -F @penguin/knowledge-cli build`). Full UI build: `pnpm run build`.
- NEVER run tests/knowledge-surface-parity.test.mjs (hangs indefinitely on this machine); never run the unfiltered full suite.
- Commit per task, conventional commits, body trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. No release tagging.
- No new dependencies.
- UI text is English (existing Wiki copy is English).

---

### Task 1: GitState TTL cache in `resolveQueryScope`

**Files:**
- Modify: `packages/knowledge-core/src/query-scope.ts` (readGitStateDefault call sites)
- Test: `tests/knowledge-query-scope.test.mjs` (extend)

**Interfaces:**
- Consumes: existing `readGitStateDefault`, `GitStateReader`.
- Produces: `export function cachedGitStateReader(ttlMs?: number): GitStateReader` (default TTL 2000ms) — memoizes per rootPath with a timestamp injected via an optional `now?: () => number` second parameter for testability: `cachedGitStateReader(ttlMs?: number, now?: () => number)`. `resolveQueryScope` uses a module-level `cachedGitStateReader()` instance as its default instead of calling `readGitStateDefault` directly (explicit `input.readGitState` still wins).

- [ ] **Step 1: Write the failing test** — extend tests/knowledge-query-scope.test.mjs:

```javascript
test("cachedGitStateReader memoizes per rootPath within TTL and refreshes after", () => {
  let calls = 0;
  let clock = 0;
  const inner = () => { calls += 1; return { branch: "main", headSha: `sha-${calls}`, dirty: false }; };
  // implementer: cachedGitStateReader wraps readGitStateDefault by default; for the test,
  // expose the wrapping via an internal injectable — add an optional third param `read?: GitStateReader`
  // to cachedGitStateReader(ttlMs, now, read) so the test controls the underlying reader.
  const { cachedGitStateReader } = awaitCoreImport(); // implementer: normal static import from dist
  const reader = cachedGitStateReader(2000, () => clock, inner);
  assert.equal(reader("/repo-a").headSha, "sha-1");
  clock = 1000;
  assert.equal(reader("/repo-a").headSha, "sha-1"); // cached
  assert.equal(reader("/repo-b").headSha, "sha-2"); // different root, separate entry
  clock = 3001;
  assert.equal(reader("/repo-a").headSha, "sha-3"); // TTL expired, re-read
  assert.equal(calls, 3);
});
```

(Implementer: replace the `awaitCoreImport()` placeholder comment with the file's normal static import list; the signature is `cachedGitStateReader(ttlMs = 2000, now = Date.now, read = readGitStateDefault)`.)

- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement** — a Map<string, {state, at}> keyed by rootPath; entries also cache `null` results (git-unavailable is worth caching too). Swap `resolveQueryScope`'s two default call sites to a shared module-level `defaultGitReader = cachedGitStateReader()`.
- [ ] **Step 4: Build + run the whole file to verify PASS** (all prior scope tests must stay green — they inject their own readers so the cache must not intercept injected readers)
- [ ] **Step 5: Commit** — `perf(core): cache git introspection per rootPath with 2s TTL`

---

### Task 2: Search verb repo inference — cwd first, disclosure warning on divergence

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts` (search verb's resolveCliRevision call / resolveCliRevision itself — add a `preferCwd` flag used only by search)
- Modify: `packages/knowledge-contracts/src/locator.ts` (add `"REPO_INFERRED_FROM_QUERY"` to WarningCode)
- Test: `tests/knowledge-cli-scope.test.mjs` (extend)

**Interfaces:**
- Consumes: `resolveQueryScope`, `resolveRepoForPath` from knowledge-core.
- Produces: for the search verb ONLY, repo inference order becomes cwd-prefix-match FIRST, unique-symbol-match second; when the symbol-match repo differs from the cwd repo (both resolvable), cwd wins and a `REPO_INFERRED_FROM_QUERY`-class situation cannot occur silently — if cwd yields no repo and symbol match does, proceed with symbol match but append warning `REPO_INFERRED_FROM_QUERY` ("search scope inferred from query text match in <repoName>, not your working directory"). Other verbs unchanged (target-first inference is correct for them).

- [ ] **Step 1: Write the failing test** — fixture with two repos (A = cwd, both with distinct symbols; query text uniquely matching a symbol in B). Assert: `search <B-symbol> --json` run with cwd inside repo A scopes to A (locator.repoName === "A"); and with cwd outside any repo, scopes to B with the `REPO_INFERRED_FROM_QUERY` warning present.
- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement** (keep the change inside the search dispatch path; do not disturb context/flow inference)
- [ ] **Step 4: Build + run covering file + `tests/knowledge-cli.test.mjs` to verify PASS**
- [ ] **Step 5: Commit** — `fix(cli): search scopes to cwd repo before query-text symbol inference`

---

### Task 3: `knowledge.status_panel` capability

**Files:**
- Modify: `packages/knowledge-contracts/src/capabilities.ts` (register capability id `knowledge.status_panel`, non-mutating; follow the existing entry shape)
- Modify: `packages/knowledge-core/src/query.ts` or new `packages/knowledge-core/src/status-panel.ts` (prefer the new file): `buildStatusPanel(store): StatusPanel`
- Modify: `packages/knowledge-cli/src/query-server.ts` (native `invoke` branch for the capability)
- Modify: `packages/knowledge-contracts/src/surface.ts` (add to implemented-capability sets as the existing pattern requires)
- Test: `tests/knowledge-status-panel.test.mjs`

**Interfaces:**
- Produces (consumed by Tasks 4/6):

```typescript
export interface RepoStatusPanel {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchName: string | null;        // checked-out git branch (cached reader), null if git unavailable
  revisionAlignment: "aligned" | "behind" | "branch_not_indexed" | "git_unavailable";
  indexedBranch: string | null;     // best indexed branch for that checkout (or live fallback)
  lastIndexedAt: string | null;
  staleReason: string | null;       // branches.stale_reason passthrough
  coverage: { admitted: number; excluded: number; failed: number } | null;
}
export interface StatusPanel {
  db: { connected: true; schemaVersion: number };
  repos: RepoStatusPanel[];
}
export function buildStatusPanel(store: KnowledgeStore): StatusPanel;
```

Semantics: per registered repo, read git via the Task-1 cached reader; compare to `branches` rows (name match → aligned/behind by last_indexed_commit vs headSha; no row → branch_not_indexed). Coverage from `coverage_records` grouped counts (`SELECT coverage_status, COUNT(*) ... GROUP BY`). This is read-only assembly — no scope resolution, no throwing; every failure degrades to nulls.

- [ ] **Step 1: Write the failing test** — fixture: repo with real git dir on branch `main`, `main` indexed at head → `revisionAlignment: "aligned"`; second scenario git branch `feature-x` un-indexed → `"branch_not_indexed"`; assert `db.schemaVersion === 14` and coverage counts match inserted coverage_records rows. Drive through `runQueryServer` with a `knowledge.status_panel` request frame (native path, like tests/knowledge-query-server-scope.test.mjs does).
- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement** (capability registration, buildStatusPanel, invoke branch)
- [ ] **Step 4: Build + run covering file + `tests/knowledge-capability-manifest.test.mjs` (capability registry snapshot will need regenerating — follow whatever `tests/snapshots/knowledge-capabilities.json` regeneration flow exists; document it)**
- [ ] **Step 5: Commit** — `feat(core): knowledge.status_panel capability — split DB/revision/index/coverage status`

---

### Task 4: Tauri allowlist + knowledge-client `knowledgeStatusPanel()`

**Files:**
- Modify: `src-tauri/src/knowledge.rs` — the `knowledge_query_canonical` allowlist (currently `knowledge.search` + `knowledge.get_hit`) gains `knowledge.status_panel`
- Modify: `src/lib/knowledge-client.ts` — `export async function knowledgeStatusPanel(): Promise<StatusPanel>` via `canonicalQuery("knowledge.status_panel", {})`, plus the `StatusPanel`/`RepoStatusPanel` TS types mirrored
- Test: `tests/knowledge-status-panel.test.mjs` (extend with a serialization-shape assertion if feasible; Rust allowlist verified by grep in review — note as ⚠️ manual)

- [ ] **Step 1: Implement the client + allowlist** (this task is wiring; the capability itself was TDD'd in Task 3 — no new failing test required, but `pnpm run build` and `cargo check` (run `cargo check` from src-tauri; if the toolchain is unavailable report it) must pass)
- [ ] **Step 2: Verify** — `pnpm run build` green
- [ ] **Step 3: Commit** — `feat(ui): expose knowledge.status_panel through the canonical bridge`

---

### Task 5: Wiki footer — real status panel

**Files:**
- Modify: `src/components/wiki/WikiPage.tsx` — replace the hardcoded footer (`Connected · SQLite · Workspace Penguin`, was :280-284 pre-1A; re-locate) with data from `knowledgeStatusPanel()`
- Create: `src/components/wiki/WikiStatusFooter.tsx`

**Interfaces:**
- Consumes: `knowledgeStatusPanel()` (Task 4).
- Produces: `<WikiStatusFooter />` — self-fetching (poll every 30s + on window focus), rendering per current repo (or first repo when no focus): `DB: Connected (v14)` · `Revision: Aligned | Behind | Branch not indexed | Git unavailable` · `Index: <relative last-indexed time>` · `Coverage: <admitted>/<admitted+excluded+failed> files`. `branch_not_indexed` renders in warning color with text `run penguin index`. Fetch failure renders `DB: Unavailable` (never the old fake green).

- [ ] **Step 1: Implement component + swap into WikiPage** (follow the file-per-component convention from the recent WikiPage god-file split; match existing Tailwind/styling idiom of sibling components)
- [ ] **Step 2: Verify** — `pnpm run build` green; `node --test tests/knowledge-status-panel.test.mjs` still green
- [ ] **Step 3: Commit** — `feat(wiki): real status footer — DB/revision/index/coverage split`

---

### Task 6: Warning + locator display in Context/Search results

**Files:**
- Modify: `src/lib/knowledge-client.ts` — `ContextPack` (and graph/flow result types the UI declares) gain optional `locator?`, `alignment?`, `warnings?`, `scopeFallback?` fields (types only — data already arrives from the bridge)
- Create: `src/components/wiki/ScopeBadge.tsx`
- Modify: `src/components/wiki/WikiContextPane.tsx`, `src/components/wiki/WikiSearchPage.tsx` — render the badge

**Interfaces:**
- Produces: `<ScopeBadge locator alignment warnings />` — one compact line: `<repoName>@<branchName> <sha7> (<worktreeState>)`; alignment `aligned` = neutral, `fallback`/`explicit`-with-warnings = amber with a tooltip listing each warning's message; `warnings` containing `BRANCH_NOT_INDEXED_FALLBACK` additionally shows `answering from <branchName> — your checkout is not indexed`.
- Mounted at the top of the Context pane and beside search-result scope info.

- [ ] **Step 1: Implement types + component + mounts**
- [ ] **Step 2: Verify** — `pnpm run build` green
- [ ] **Step 3: Commit** — `feat(wiki): scope badge — locator, alignment, warnings on every answer`

---

### Task 7: Search-hit → Context keeps the full locator; service-graph branch picker

**Files:**
- Modify: `src/lib/knowledge-client.ts` — `knowledgeContext(target, opts)` gains `{ snapshotId?, repoId? }` options mapped to `["context", target, "--snapshot", id, "--repo", repoId]`
- Modify: `src/components/wiki/WikiSearchPage.tsx` — the hit→context call (was :133-136 pre-1A) passes `hit.locator.revisionId` + repo
- Modify: `src/components/wiki/WikiPage.tsx` — `onGraphNodeClick` service-node branch pick (was :137: `find live ?? [0]`) → when >1 live branch, open a small popover listing branches (name, last-indexed, live/stale) and require a pick; 1 branch → open directly
- Create: `src/components/wiki/BranchPickerPopover.tsx`
- Test: `tests/knowledge-cli-scope.test.mjs` (extend: `context <symbol> --snapshot <id> --json` resolves that snapshot's scope — exercises the CLI side of the passthrough)

**Interfaces:**
- Consumes: CLI `--snapshot/--repo` flags (existing from 1A resolveCliRevision), `SearchLocator.revisionId` on hits.
- Produces: context packs opened from search hits are pinned to the hit's snapshot (locator in the response must echo it); service-graph never auto-picks among multiple live branches.

- [ ] **Step 1: Write the failing CLI test** (snapshot passthrough)
- [ ] **Step 2: Build + run to verify FAIL, implement CLI-side if gap exists (repo inference from snapshotId may need resolveCliRevision to accept snapshot without --repo when the snapshot uniquely identifies the repo — implement if missing)**
- [ ] **Step 3: Implement client + UI changes; `pnpm run build` green**
- [ ] **Step 4: Run covering tests to verify PASS**
- [ ] **Step 5: Commit** — `feat(wiki): locator-preserving context navigation + service-graph branch picker`

---

### Task 8: Render scope blockers; remove the bridge `--allow-fallback` injection

**Files:**
- Modify: `packages/knowledge-cli/src/query-server.ts` — remove the Task-6(1A) `--allow-fallback` force-injection (the comment marks it); on CLI exit 4 through the bridge, return a structured error frame `{ code: "BRANCH_NOT_INDEXED", message, candidates? }` instead of the opaque last-line throw (parse the CLI's stderr/stdout error payload)
- Modify: `src/lib/knowledge-client.ts` — bridge callers surface that error shape as a typed `ScopeBlockedError`
- Create: `src/components/wiki/ScopeBlockerPanel.tsx` — full-pane blocker: `Branch <name> is not indexed` + `penguin index` instruction + button `Answer from <indexed branch> instead` which retries the same query with `allow_fallback: true` (client passes `--allow-fallback` explicitly for that retry)
- Modify: `src/components/wiki/WikiPage.tsx` / `WikiSearchPage.tsx` — catch `ScopeBlockedError` from context/flow/graph loads and render the panel
- Test: extend `tests/knowledge-cli-scope.test.mjs` (or the query-server test file): bridge WITHOUT injection now returns the structured BRANCH_NOT_INDEXED error frame for an un-indexed checkout; retry frame with `--allow-fallback` succeeds with fallback envelope — replaces the old force-injection test (update it, do not delete coverage)

**Interfaces:**
- Consumes: everything above — THIS TASK MUST BE LAST.
- Produces: strict trust semantics end-to-end: un-indexed checkout in the Wiki shows an actionable blocker; one click opts into fallback per query.

- [ ] **Step 1: Write the failing bridge test** (structured error frame, no injection)
- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement bridge change + client error type + panel + mounts**
- [ ] **Step 4: Build + run covering files + `pnpm run build`; verify the OLD injection test is updated to the new contract**
- [ ] **Step 5: Commit** — `feat(wiki)!: render scope blockers; bridge no longer auto-falls-back`

---

### Task 9: Resident-server migration exemption — decide and enforce

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts` — `__query-server` dispatch opens the store with `allowSchemaMutation: false`; on `SCHEMA_OUTDATED`, `runQueryServer` (modify `packages/knowledge-cli/src/query-server.ts`) emits a hello-equivalent error frame `{ type: "hello", error: { code: "SCHEMA_OUTDATED", message } }` shape-compatible with the Tauri validator (check `src-tauri/src/knowledge.rs` hello validation — extend it to surface the error to the UI rather than retry-looping)
- Modify: `packages/mcp/src/knowledge-tools.ts:~110` — MCP store open also `allowSchemaMutation: false`; SCHEMA_OUTDATED converts to the standard MCP error with the `penguin index` hint
- Modify: `src/components/wiki/WikiStatusFooter.tsx` / onboarding gate — render `Index upgrade required — run penguin index` when the bridge reports SCHEMA_OUTDATED
- Test: `tests/knowledge-readonly-preflight.test.mjs` (extend): spawn `runQueryServer` against a version-spoofed store → error frame, no migration (stored version unchanged); MCP path likewise in `tests/knowledge-mcp-scope.test.mjs`

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement (CLI, MCP, Rust validator pass-through, footer state)**
- [ ] **Step 4: Build + run covering files + `pnpm run build`**
- [ ] **Step 5: Commit** — `fix(core)!: long-lived read servers never migrate — surface SCHEMA_OUTDATED to the UI`

---

### Task 10: WikiNoteEditor legacy search → canonical

**Files:**
- Modify: `src/components/wiki/WikiNoteEditor.tsx` (was :35 `knowledgeSearch(q)`) → `knowledgeSearchV2` (canonical `knowledge.search`, no git spawns, no bridge CLI)

- [ ] **Step 1: Implement the swap** (match how WikiSearchPage already calls knowledgeSearchV2; keep the editor's result shape via a small adapter if the hit shape differs)
- [ ] **Step 2: Verify** — `pnpm run build` green
- [ ] **Step 3: Commit** — `perf(wiki): note editor uses canonical search, off the CLI bridge`

---

## Deliberately deferred (recorded, not tasks)

- Worktree-aware git introspection (terminal-review Important #4) — spec amendment; schedule with Phase 2 planning.
- MCP `knowledge_search` trust plumbing (Important #5) — Phase 2 (touches search scoping semantics anyway).
- explore_graph schema repair + 3-tool scope unification — after schema fix, Phase 2.
- Exit-code table doc, dual warnings-vocabulary doc note — roll into Phase 2 docs task.

## Post-plan checks

- [ ] Full battery: the 12-file scope/schema battery from 1A + new status-panel/bridge tests all green; `pnpm run build` green.
- [ ] Manual smoke in the dev app (`pnpm run dev` or tauri dev): footer shows real states; un-indexed branch shows blocker with working fallback button; search-hit context shows pinned locator badge.
- [ ] Then: bundle release 1A+1B together (user confirms release), install, kill stale resident processes, run the real-DB migration smoke from the carryover notes.

## Self-review notes

- Ordering constraint (8 after 5-7, 9 after 5) is stated in Global Constraints and on the tasks.
- UI tasks lack unit-test harness — gates are build + logic-layer tests + final manual smoke; this is the honest ceiling of this repo's test infra today.
- Task 3's StatusPanel deliberately avoids resolveQueryScope (no throwing in a status assembly); alignment here is informational, computed directly.
