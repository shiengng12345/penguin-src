# Phase 1A — Trust Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every knowledge query resolves through one scope chokepoint bound to the actual checked-out git branch, carries a `KnowledgeLocator` + structured warnings, and a schema bump can never silently poison results (forced rebuild, read-only preflight).

**Architecture:** New locator/warning contracts in `knowledge-contracts`; a single `resolveQueryScope()` in `knowledge-core` that introspects git at the repo root and delegates to the existing strict `resolveRevisionContext`; CLI/MCP/query-server all route through it; schema bumped to 14 with `coverage_layers` + edge columns pre-provisioned for Phase 2.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3 via `KnowledgeStore`, `node --test` + `assert/strict` tests in `tests/*.test.mjs` importing from package `dist/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-penguin-trust-roadmap-design.md` (Phase 1 section, decisions D1–D3).
- Hard blocker ONLY for "current git branch not indexed" (`BRANCH_NOT_INDEXED`); everything else returns results + structured `warnings[]`. `--allow-fallback` downgrades the blocker to a warning.
- Schema bump to **14**; migrations are idempotent `ALTER TABLE ... ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` only. `migrate()` (`packages/knowledge-core/src/schema.ts:719`) and `isSchemaCurrent()` (`schema.ts:818`) are hand-synced mirrors — every DDL change lands in BOTH or the steady-state fast path silently breaks (comment at `schema.ts:813-817`).
- Tests import from `../packages/<pkg>/dist/index.js` — always build before running tests.
- BUILD command (used in every task):
  `pnpm -F @penguin/knowledge-contracts build && pnpm -F @penguin/knowledge-core build && pnpm -F @penguin/knowledge-indexer build && pnpm -F @penguin/knowledge-cli build && pnpm -F @penguin/mcp build`
- Run a single test file: `node --test tests/<file>.test.mjs`
- Commit after every task. Do not tag releases (user bundles releases manually).
- No new runtime dependencies.

---

### Task 1: Contracts — `KnowledgeLocator`, `StructuredWarning`, `ScopeAlignment`

**Files:**
- Create: `packages/knowledge-contracts/src/locator.ts`
- Modify: `packages/knowledge-contracts/src/index.ts` (add `export * from "./locator.js";` next to the existing exports)
- Test: `tests/knowledge-locator-contract.test.mjs`

**Interfaces:**
- Produces (later tasks depend on these exact names):

```typescript
export type WorktreeState = "clean" | "dirty" | "snapshot" | "unknown";
export type ScopeAlignment = "aligned" | "revision_behind" | "fallback" | "explicit";

export interface KnowledgeLocator {
  repoId: string;
  repoName: string;
  rootPath: string;
  branchId?: string;
  branchName?: string;
  commitSha?: string;
  snapshotId: string;
  worktreeState: WorktreeState;
  indexedAt?: string;
}

export type WarningCode =
  | "BRANCH_NOT_INDEXED_FALLBACK"
  | "SCOPE_DIFFERS_FROM_CHECKOUT"
  | "REVISION_BEHIND"
  | "WORKTREE_DRIFT"
  | "GIT_UNAVAILABLE"
  | "FALLBACK_LIVE_BRANCH"
  | "SCOPE_UNRESOLVED";

export interface StructuredWarning {
  code: WarningCode;
  message: string;
  data?: Record<string, unknown>;
}

export interface ScopeEnvelope {
  locator: KnowledgeLocator;
  alignment: ScopeAlignment;
  warnings: StructuredWarning[];
}

export function warning(code: WarningCode, message: string, data?: Record<string, unknown>): StructuredWarning;
```

- [ ] **Step 1: Write the failing test**

```javascript
// tests/knowledge-locator-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { warning } from "../packages/knowledge-contracts/dist/index.js";

test("warning() builds a structured warning and omits empty data", () => {
  const w = warning("WORKTREE_DRIFT", "worktree differs from indexed fingerprint", { dirtyFiles: 3 });
  assert.deepEqual(w, {
    code: "WORKTREE_DRIFT",
    message: "worktree differs from indexed fingerprint",
    data: { dirtyFiles: 3 },
  });
  assert.deepEqual(warning("GIT_UNAVAILABLE", "no git"), { code: "GIT_UNAVAILABLE", message: "no git" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @penguin/knowledge-contracts build && node --test tests/knowledge-locator-contract.test.mjs`
Expected: FAIL — `warning` is not exported.

- [ ] **Step 3: Implement `locator.ts`**

The interfaces above verbatim, plus:

```typescript
export function warning(code: WarningCode, message: string, data?: Record<string, unknown>): StructuredWarning {
  return { code, message, ...(data ? { data } : {}) };
}
```

Add `export * from "./locator.js";` to `packages/knowledge-contracts/src/index.ts`.

- [ ] **Step 4: Build + run test to verify it passes**
- [ ] **Step 5: Commit** — `feat(contracts): KnowledgeLocator, StructuredWarning, ScopeEnvelope`

---

### Task 2: Schema v14 — `coverage_layers` table + `edges.evidence_id`/`edges.boundary`

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts` — `SCHEMA_VERSION` (`:702`), `SCHEMA_MIGRATIONS` (`:705-710`), DDL string (append after the `edges` indexes block ending `:186`), `migrate()` (`:719-781`), `isSchemaCurrent()` (`:818-854`)
- Test: `tests/knowledge-schema-v14.test.mjs`

**Interfaces:**
- Produces: `SCHEMA_VERSION === 14`; new table `coverage_layers(repo_id, branch_id, layer, resolved, total, updated_at, PRIMARY KEY(repo_id, branch_id, layer))` with `layer` values `file|symbol|edge|route|di|test`; new nullable columns `edges.evidence_id TEXT`, `edges.boundary TEXT` (`di|interface|callback|event` or NULL — no CHECK constraint, matching existing free-form style).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/knowledge-schema-v14.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-schema-v14-"));
  return KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
}

test("schema version is 14 and new objects exist", () => {
  const store = freshStore();
  assert.equal(SCHEMA_VERSION, 14);
  const stored = store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coverage_layers'").get();
  assert.ok(table, "coverage_layers table missing");
  const cols = store.db.prepare("PRAGMA table_info(edges)").all().map((c) => c.name);
  assert.ok(cols.includes("evidence_id"), "edges.evidence_id missing");
  assert.ok(cols.includes("boundary"), "edges.boundary missing");
  store.close();
});

test("migration upgrades a v13 store idempotently", () => {
  const store = freshStore();
  // Simulate a pre-bump database: strip the new objects and mark it v13.
  store.db.exec("DROP TABLE coverage_layers");
  store.db.prepare("UPDATE meta SET value='13' WHERE key='schema_version'").run();
  const dbPath = store.db.name;
  store.close();
  const reopened = KnowledgeStore.open({ dbPath, ledgerPath: dbPath.replace(/knowledge\.db$/, "ledger.jsonl") });
  const stored = reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  assert.ok(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='coverage_layers'").get());
  reopened.close();
});
```

- [ ] **Step 2: Build + run to verify it fails** (SCHEMA_VERSION is 13; also confirm `SCHEMA_VERSION` is exported from knowledge-core index — it is, `query-server.ts` imports it)

- [ ] **Step 3: Implement**

1. `SCHEMA_VERSION = 14` at `schema.ts:702`.
2. Append to `SCHEMA_MIGRATIONS`: `{ version: 14, description: "coverage_layers table; edges.evidence_id + edges.boundary; forced rebuild on schema bump" }` (match the existing entry shape at `:705-710`).
3. Append to the DDL string (after the edges index block):

```sql
CREATE TABLE IF NOT EXISTS coverage_layers (
  repo_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch_id, layer)
);
```

   And add `evidence_id TEXT` and `boundary TEXT` columns to the `edges` CREATE TABLE (`:161-173`) so fresh databases get them without migration.
4. In `migrate()` append a step following the existing `PRAGMA table_info` guard idiom used by the earlier column-adds (`:734-739`):

```typescript
const edgeCols = (db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>).map((c) => c.name);
if (!edgeCols.includes("evidence_id")) db.exec("ALTER TABLE edges ADD COLUMN evidence_id TEXT");
if (!edgeCols.includes("boundary")) db.exec("ALTER TABLE edges ADD COLUMN boundary TEXT");
// coverage_layers is CREATE TABLE IF NOT EXISTS in the DDL, which migrate() executes via db.exec(DDL) upstream — verify this holds; if migrate() does not re-run DDL, add the CREATE TABLE here too.
```

5. **Mirror sync:** in `isSchemaCurrent()` add `coverage_layers` to the expected-object comparison (it is regex-parsed from DDL via `DDL_OBJECT_NAMES` at `:802-806` — verify it picks the new table up automatically) and add `evidence_id`, `boundary` to the hand-maintained edges column list.

- [ ] **Step 4: Build + run both tests to verify pass**
- [ ] **Step 5: Run the full suite** — `pnpm run build && node --test --test-reporter=dot tests/*.test.mjs` (schema changes have wide blast radius; existing snapshot/branch tests must stay green)
- [ ] **Step 6: Commit** — `feat(schema): v14 — coverage_layers, edges.evidence_id/boundary`

---

### Task 3: Forced full rebuild when the index predates the current schema

**Files:**
- Modify: `packages/knowledge-indexer/src/pipeline.ts:651-653` (the `effectiveMode` ternary)
- Modify: `packages/knowledge-indexer/src/index.ts` (export the new helper)
- Test: `tests/knowledge-index-mode.test.mjs`

**Interfaces:**
- Produces: `export function resolveIndexMode(mode: "rebuild" | "incremental", prior: { parser_version?: string | null; indexed_schema_version?: number | null } | undefined, parserVersion: string, schemaVersion: number): "rebuild" | "incremental"` in `pipeline.ts`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/knowledge-index-mode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIndexMode } from "../packages/knowledge-indexer/dist/index.js";

test("schema bump forces rebuild even when parser version matches", () => {
  assert.equal(resolveIndexMode("incremental", { parser_version: "p1", indexed_schema_version: 13 }, "p1", 14), "rebuild");
  assert.equal(resolveIndexMode("incremental", { parser_version: "p1", indexed_schema_version: 14 }, "p1", 14), "incremental");
  assert.equal(resolveIndexMode("incremental", { parser_version: "p0", indexed_schema_version: 14 }, "p1", 14), "rebuild");
  assert.equal(resolveIndexMode("rebuild", { parser_version: "p1", indexed_schema_version: 14 }, "p1", 14), "rebuild");
  // No prior branch row (first index) → incremental is fine; pipeline treats it as fresh anyway.
  assert.equal(resolveIndexMode("incremental", undefined, "p1", 14), "incremental");
});
```

- [ ] **Step 2: Build + run to verify FAIL** (`resolveIndexMode` not exported)

- [ ] **Step 3: Implement**

In `pipeline.ts`, extract the existing inline decision (currently `:651-653`):

```typescript
export function resolveIndexMode(
  mode: "rebuild" | "incremental",
  prior: { parser_version?: string | null; indexed_schema_version?: number | null } | undefined,
  parserVersion: string,
  schemaVersion: number,
): "rebuild" | "incremental" {
  if (mode === "rebuild") return "rebuild";
  if (!prior) return "incremental";
  if (prior.parser_version !== parserVersion) return "rebuild";
  if ((prior.indexed_schema_version ?? 0) !== schemaVersion) return "rebuild";
  return "incremental";
}
```

Replace the ternary call site with `const effectiveMode = resolveIndexMode(mode, prior, KNOWLEDGE_PARSER_VERSION, SCHEMA_VERSION);` (both constants are already imported/available in pipeline.ts — the snapshot key at `:686` already uses them). Ensure the `prior` row SELECT includes `indexed_schema_version` (the branches column exists; add it to the SELECT if missing). Export from `packages/knowledge-indexer/src/index.ts`.

- [ ] **Step 4: Build + run to verify PASS**
- [ ] **Step 5: Commit** — `feat(indexer): force full rebuild when indexed_schema_version != SCHEMA_VERSION`

---

### Task 4: Read-only schema preflight — reads never migrate

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts` — `openDatabase()` (`:856-914`)
- Modify: `packages/knowledge-core/src/store.ts` — `KnowledgeStore.open` (`:187-192`) to accept and forward `allowSchemaMutation`
- Modify: `packages/knowledge-cli/src/command-dispatch.ts` — pass `allowSchemaMutation: false` when the verb is in `READ_VERBS` (`:130`); catch the new error and print the remediation hint
- Test: `tests/knowledge-readonly-preflight.test.mjs`

**Interfaces:**
- Produces: `openDatabase(path, { allowSchemaMutation?: boolean })` (default `true`, preserving current behavior); throws `Error` with `.code === "SCHEMA_OUTDATED"` when the DB needs DDL/migration but mutation is disallowed. `KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation? })`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/knowledge-readonly-preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("outdated schema + read-only open throws SCHEMA_OUTDATED instead of migrating", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-readonly-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  store.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run();
  store.close();

  assert.throws(
    () => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false }),
    (err) => err.code === "SCHEMA_OUTDATED",
  );
  // Stored version untouched by the failed read-only open:
  const writable = KnowledgeStore.open({ dbPath, ledgerPath });
  // (writable open migrates as before)
  const stored = writable.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  writable.close();
});
```

- [ ] **Step 2: Build + run to verify FAIL**

- [ ] **Step 3: Implement**

In `openDatabase`, after the steady-state early return (`:893-899`) and the newer-DB guard (`:885-891`), before executing DDL/migrate (`:901-914`):

```typescript
if (!options?.allowSchemaMutation) {
  db.close();
  throw Object.assign(
    new Error(`knowledge database schema is outdated (stored=${storedVersion}, supported=${SCHEMA_VERSION}); run \`penguin index\` (or any write command) to upgrade`),
    { code: "SCHEMA_OUTDATED" },
  );
}
```

Default `allowSchemaMutation: true` so all existing call sites keep today's behavior. Thread through `KnowledgeStore.open`. In `command-dispatch.ts`, where the store opens for dispatch (`:1240`), pass `allowSchemaMutation: !READ_VERBS.has(verb) === false ? true : …` — concretely: `allowSchemaMutation: !READ_VERBS.has(verb)`. Wrap the open in try/catch: on `SCHEMA_OUTDATED`, `deps.err(error.message)` and return exit code 3 (match the existing missing-store exit-code convention used by `runQueryServer` at `query-server.ts:33`).

**Note:** ledger `materialize()` on open (`store.ts:190`) still runs for read verbs — it is a no-op when there are no pending events and is out of scope here.

- [ ] **Step 4: Build + run to verify PASS; run full suite**
- [ ] **Step 5: Commit** — `feat(core): read-only opens fail loud with SCHEMA_OUTDATED instead of migrating`

---

### Task 5: `resolveQueryScope()` — the single scope chokepoint

**Files:**
- Create: `packages/knowledge-core/src/query-scope.ts`
- Modify: `packages/knowledge-core/src/index.ts` (export everything from `query-scope.js`)
- Test: `tests/knowledge-query-scope.test.mjs`

**Interfaces:**
- Consumes: `resolveRevisionContext`, `RevisionContext`, `RevisionSelector` (`revision.ts`); `KnowledgeLocator`, `ScopeEnvelope`, `StructuredWarning`, `warning` (Task 1).
- Produces:

```typescript
export interface GitState {
  branch: string | null;      // null when detached HEAD
  headSha: string | null;
  dirty: boolean;
}
export type GitStateReader = (rootPath: string) => GitState | null; // null = git unavailable

export class ScopeResolutionError extends Error {
  readonly code: "BRANCH_NOT_INDEXED" | "REPO_REQUIRED" | "REPO_AMBIGUOUS" | "SCOPE_NOT_FOUND";
  readonly candidates: Array<{ branchName: string; commitSha: string }>;
}

export interface ResolveQueryScopeInput {
  repoId?: string;            // explicit repo (id, already resolved)
  cwd?: string;               // used only to infer repo when repoId absent
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  allowFallback?: boolean;
  readGitState?: GitStateReader;  // injectable; defaults to real git
}

export interface ResolvedQueryScope extends ScopeEnvelope {
  revision: RevisionContext;
}

export function resolveRepoForPath(store: KnowledgeStore, path: string): { repoId: string; rootPath: string } | null;
export function readGitStateDefault(rootPath: string): GitState | null;
export function resolveQueryScope(store: KnowledgeStore, input: ResolveQueryScopeInput): ResolvedQueryScope;
```

Behavior contract:
1. Repo: explicit `repoId` wins; else `resolveRepoForPath(cwd)` (longest `root_path` prefix match — port of `resolveRepoForCwd`, `command-dispatch.ts:155-162`, including `canonicalPathForCheck`-equivalent normalization; move or re-export that helper as needed); else throw `REPO_REQUIRED`.
2. Explicit selector (`branch`/`commitSha`/`snapshotId` present) → `resolveRevisionContext` as today; `alignment: "explicit"`; if git state is readable and the selected branch ≠ checked-out branch, add `SCOPE_DIFFERS_FROM_CHECKOUT` warning. `ambiguous`/`not_found` → `ScopeResolutionError` (`SCOPE_NOT_FOUND`) carrying candidates.
3. No selector → read git state at the repo's `root_path`:
   - git unavailable / detached → add `GIT_UNAVAILABLE` warning, resolve with the existing sole-live-branch rule (`resolveRevisionContext` with bare `{repoId}` — it already errors on 2+ live branches); `alignment: "fallback"`.
   - git branch known → `resolveRevisionContext({repoId, branch: gitBranch})`:
     - `resolved` → `alignment: "aligned"`, plus drift warnings: `REVISION_BEHIND` when the branch row's `last_indexed_commit` ≠ git `headSha`; `WORKTREE_DRIFT` when git `dirty` is true.
     - `not_found` → **throw `ScopeResolutionError("BRANCH_NOT_INDEXED")`** with candidates and message ending `run \`penguin index\` to index branch "<name>"` — unless `allowFallback`, in which case resolve via the sole-live-branch rule with `alignment: "fallback"` + `BRANCH_NOT_INDEXED_FALLBACK` warning.
4. Locator built from the resolved context + `repos`/`branches` rows: `repoName`, `rootPath` from `repos`; `indexedAt` from `branches.last_indexed_at`; `worktreeState` from `branches.indexed_worktree_state` (`unknown` when absent); `snapshotId`/`commitSha`/`branchId`/`branchName` from the `RevisionContext`.
5. `readGitStateDefault` uses `execFileSync("git", ["-C", rootPath, ...])` like `git()` in `packages/knowledge-indexer/src/git-topology.ts:10`: branch via `branch --show-current` (empty string → detached → `branch: null`), head via `rev-parse HEAD`, dirty via `status --porcelain=v1` non-empty. Any throw → return `null`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/knowledge-query-scope.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, resolveQueryScope, ScopeResolutionError } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-query-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const mainId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-main', last_indexed_at='2026-08-05T00:00:00Z' WHERE id=?").run(mainId);
  return { store, repoId, rootPath };
}

test("aligned: checked-out branch is indexed at head", () => {
  const { store, repoId, rootPath } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    readGitState: () => ({ branch: "main", headSha: "sha-main", dirty: false }),
  });
  assert.equal(scope.alignment, "aligned");
  assert.equal(scope.locator.branchName, "main");
  assert.equal(scope.locator.rootPath, rootPath);
  assert.deepEqual(scope.warnings, []);
  store.close();
});

test("behind + dirty: aligned with REVISION_BEHIND and WORKTREE_DRIFT warnings", () => {
  const { store, repoId } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    readGitState: () => ({ branch: "main", headSha: "sha-newer", dirty: true }),
  });
  assert.equal(scope.alignment, "aligned");
  const codes = scope.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["REVISION_BEHIND", "WORKTREE_DRIFT"]);
  store.close();
});

test("checked-out branch not indexed → hard BRANCH_NOT_INDEXED", () => {
  const { store, repoId } = fixture();
  assert.throws(
    () => resolveQueryScope(store, { repoId, readGitState: () => ({ branch: "feature-x", headSha: "sha-f", dirty: false }) }),
    (err) => err instanceof ScopeResolutionError && err.code === "BRANCH_NOT_INDEXED" && /penguin index/.test(err.message),
  );
  store.close();
});

test("allowFallback downgrades the blocker to a warning and falls back to the live branch", () => {
  const { store, repoId } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    allowFallback: true,
    readGitState: () => ({ branch: "feature-x", headSha: "sha-f", dirty: false }),
  });
  assert.equal(scope.alignment, "fallback");
  assert.equal(scope.locator.branchName, "main");
  assert.ok(scope.warnings.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"));
  store.close();
});

test("explicit branch selector differing from checkout warns SCOPE_DIFFERS_FROM_CHECKOUT", () => {
  const { store, repoId } = fixture();
  const scope = resolveQueryScope(store, {
    repoId,
    branch: "main",
    readGitState: () => ({ branch: "feature-x", headSha: "sha-f", dirty: false }),
  });
  assert.equal(scope.alignment, "explicit");
  assert.ok(scope.warnings.some((w) => w.code === "SCOPE_DIFFERS_FROM_CHECKOUT"));
  store.close();
});

test("cwd inside the repo root infers the repo", () => {
  const { store, rootPath } = fixture();
  const scope = resolveQueryScope(store, {
    cwd: join(rootPath, "src", "deep"),
    readGitState: () => ({ branch: "main", headSha: "sha-main", dirty: false }),
  });
  assert.equal(scope.locator.repoName, "demo");
  store.close();
});
```

- [ ] **Step 2: Build + run to verify FAIL** (module not found / not exported)
- [ ] **Step 3: Implement `query-scope.ts` per the behavior contract above** (pure functions; the only I/O is the injectable git reader and store reads)
- [ ] **Step 4: Build + run to verify PASS**
- [ ] **Step 5: Commit** — `feat(core): resolveQueryScope — git-aware scope chokepoint with locator + warnings`

---

### Task 6: CLI wiring — default scope, `--allow-fallback`, kill the search fallback, envelope on emit

**Files:**
- Modify: `packages/knowledge-cli/src/command-dispatch.ts`:
  - `resolveCliRevision` (`:185-194`)
  - the search verb's bespoke fallback (`:1304-1342`, the raw `ORDER BY default_branch DESC, name LIMIT 1` SQL at `:1339-1342`)
  - `emit` (`:202-208`)
  - flag parsing (add `--allow-fallback` where `--repo/--branch/--commit/--snapshot` are parsed)
  - error reporting (`reportRevisionResolutionError` at `:173` gains a sibling for `ScopeResolutionError`)
- Test: `tests/knowledge-cli-scope.test.mjs`

**Interfaces:**
- Consumes: `resolveQueryScope`, `ScopeResolutionError`, `resolveRepoForPath` (Task 5).
- Produces: every scoped read verb (`context`, `flow`, `path`, `explore`, `locate`, `compare`, `search`, `affected`) resolves scope via `resolveQueryScope` when no explicit selector flags are given; JSON output gains top-level `locator`, `alignment`, `warnings` fields; `BRANCH_NOT_INDEXED` exits 4 with the remediation message.

Implementation notes (executor: verify anchors before editing — this file is ~1700 lines):

1. Change `resolveCliRevision` so the no-selector path resolves instead of returning `undefined`:

```typescript
function resolveCliRevision(
  store: KnowledgeStore,
  target: string,
  selector: { repo?: string; branch?: string; commitSha?: string; snapshotId?: string; allowFallback?: boolean },
  deps: { cwd(): string },
): { revision: RevisionContext; scope: ScopeEnvelope } {
  let repoId = selector.repo ? resolveRepoId(store, selector.repo) ?? undefined : undefined;
  if (!repoId && target) {
    const match = resolveSymbolMatches(store, target);
    if (match.kind === "unique") repoId = store.getNode(match.nodeId)?.repo_id ?? undefined;
  }
  const scope = resolveQueryScope(store, {
    ...(repoId ? { repoId } : {}),
    cwd: deps.cwd(),
    branch: selector.branch,
    commitSha: selector.commitSha,
    snapshotId: selector.snapshotId,
    allowFallback: selector.allowFallback,
  });
  return { revision: scope.revision, scope };
}
```

   `CliDeps` may not expose `cwd` yet — add `cwd?: () => string` defaulting to `() => process.cwd()`. Update the ~8 call sites (`:1430, :1445, :1474, :1488, :1541, :1585, :1522-ish, :1625`); each currently passes the result as `{ revision }` options — now pass `result.revision` and hold `result.scope` for emit. The `timeline` call site currently swallows errors in an IIFE (`catch { return undefined }`) — remove the swallow; let `ScopeResolutionError` propagate like the others.
2. Search verb: delete the raw-SQL snapshot pick (`:1339-1342`) and the cwd-only repo inference around it; call `resolveQueryScope` the same way, then feed `scope.revision.snapshotId` (and repoId) into the existing scopes plumbing. Keep `DEFAULT_WORKSPACE_SCOPE` warning only for the genuinely-no-repo-inferable case (`REPO_REQUIRED` → fall back to workspace-wide search, which stays legal for search only, with the warning).
3. `emit` envelope — change signature to accept an optional scope:

```typescript
function emit(deps: CliDeps, json: boolean, human: string, data: unknown, scope?: ScopeEnvelope): void {
  const payload = scope && data && typeof data === "object" && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), locator: scope.locator, alignment: scope.alignment, warnings: scope.warnings }
    : data;
  if (EVENT_OUTPUT.get(deps)) { deps.out(JSON.stringify({ type: "result", result: payload })); return; }
  deps.out(json ? JSON.stringify(payload) : human);
}
```

   Pass `scope` at the scoped-verb emit sites. Human output: append a one-line footer `scope: <repoName>@<branchName> <commitSha7> (<alignment>)` plus one line per warning.
4. New error reporter next to `reportRevisionResolutionError`:

```typescript
function reportScopeResolutionError(deps: CliDeps, error: unknown): number {
  if (!(error instanceof ScopeResolutionError)) throw error;
  deps.err([error.message,
    error.candidates.length ? `Indexed branches:\n${error.candidates.map((c) => `  ${c.branchName} @ ${c.commitSha}`).join("\n")}` : "",
    error.code === "BRANCH_NOT_INDEXED" ? "Pass --allow-fallback to query another indexed branch instead." : "",
  ].filter(Boolean).join("\n"));
  return 4;
}
```

5. Parse `--allow-fallback` alongside the existing selector flags and thread into the selector object.

- [ ] **Step 1: Write the failing test** (fixture pattern from `tests/knowledge-revision-isolation.test.mjs`; `runCli` deps pattern from `tests/knowledge-affected.test.mjs` — adapt the deps construction from that file)

```javascript
// tests/knowledge-cli-scope.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-cli-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-main' WHERE id=?").run(branchId);
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Alpha`, repoId, title: "Alpha" });
  store.upsertSymbolVersion({ nodeId, branchId, commitSha: "sha-main", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "Alpha()", contentHash: "h1" });
  store.indexSymbolText({ nodeId, name: "Alpha", signature: "Alpha()" });
  return { store, dir, rootPath };
}

function cliDeps(store, cwd, lines) {
  // NOTE for implementer: mirror the CliDeps construction used in tests/knowledge-affected.test.mjs,
  // overriding: openStore: () => store, storeExists: () => true, out/err: (l) => lines.push(l), cwd: () => cwd.
  return { openStore: () => store, storeExists: () => true, out: (l) => lines.push(l), err: (l) => lines.push(l), cwd: () => cwd };
}

test("context on an un-indexed checked-out branch exits 4 with BRANCH_NOT_INDEXED", async () => {
  const { store, rootPath } = fixture();
  // rootPath is not a real git repo → GIT_UNAVAILABLE path would fall back; simulate un-indexed
  // branch instead via a real git repo in CI-free way: init one.
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const lines = [];
  const code = await runCli(["context", "Alpha", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 4);
  assert.match(lines.join("\n"), /penguin index/);
  store.close();
});

test("context with --allow-fallback answers from the live branch and carries the envelope", async () => {
  const { store, rootPath } = fixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const lines = [];
  const code = await runCli(["context", "Alpha", "--allow-fallback", "--json"], cliDeps(store, rootPath, lines));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.locator.branchName, "main");
  assert.equal(payload.alignment, "fallback");
  assert.ok(payload.warnings.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"));
  store.close();
});
```

- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement per the notes above** (work verb-by-verb; keep each call-site edit mechanical)
- [ ] **Step 4: Build + run to verify PASS; run the full suite** — existing CLI tests will exercise every verb; fix regressions before proceeding (expected friction: tests whose fixtures have no git repo now hit the `GIT_UNAVAILABLE` → sole-live-branch path, which preserves old behavior for single-live-branch fixtures)
- [ ] **Step 5: Commit** — `feat(cli): git-aware scope resolution, --allow-fallback, locator envelope`

---

### Task 7: Core fallback honesty — mark every `liveBranchOf` fallback

**Files:**
- Modify: `packages/knowledge-core/src/query.ts` — the four `liveBranchOf` call sites: `buildFlow` (`:1803`), `buildContextPack` (`:1461`), `exploreGraph` (`:881`), `buildQueryDiagnostics` (`:735`)
- Test: `tests/knowledge-fallback-honesty.test.mjs`

**Interfaces:**
- Produces: `FlowResult`, `ContextPack`, `ExplorePack` gain optional `scopeFallback?: { branchId: string }` set ONLY when `liveBranchOf` supplied the branch (no revision passed in). CLI emit (Task 6) maps it to a `FALLBACK_LIVE_BRANCH` warning when present (this mapping is part of this task; extend the Task 6 emit envelope: if `data.scopeFallback` exists and no scope was resolved, append the warning).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/knowledge-fallback-honesty.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, buildFlow, buildContextPack } from "../packages/knowledge-core/dist/index.js";

import { resolveRevisionContext } from "../packages/knowledge-core/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-fallback-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "demo", rootPath: join(dir, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha", status: "live" });
  const a = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::A`, repoId, title: "A" });
  const b = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::B`, repoId, title: "B" });
  store.upsertSymbolVersion({ nodeId: a, branchId, commitSha: "sha", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "A()", contentHash: "ha" });
  store.upsertSymbolVersion({ nodeId: b, branchId, commitSha: "sha", filePath: "src/b.ts", lang: "typescript", kind: "function", signature: "B()", contentHash: "hb" });
  store.indexSymbolText({ nodeId: a, name: "A", signature: "A()" });
  store.db.prepare("INSERT INTO edges (id, src, dst, edge_type, branch_id, origin, method, status) VALUES ('e1', ?, ?, 'calls', ?, 'parser', 'EXTRACTED', 'active')").run(a, b, branchId);
  return { store, repoId, a, branchId };
}

test("buildFlow without a revision marks the live-branch fallback", () => {
  const { store, branchId } = fixture();
  const flow = buildFlow(store, "A");
  assert.deepEqual(flow.scopeFallback, { branchId });
  store.close();
});

test("buildFlow with an explicit revision does NOT mark fallback", () => {
  const { store, repoId } = fixture();
  const revision = resolveRevisionContext(store, { repoId, branch: "main" }).context;
  const flow = buildFlow(store, "A", { revision });
  assert.equal(flow.scopeFallback, undefined);
  store.close();
});

test("buildContextPack marks fallback the same way", () => {
  const { store, repoId, a, branchId } = fixture();
  const noRevision = buildContextPack(store, a);
  assert.deepEqual(noRevision.scopeFallback, { branchId });
  const revision = resolveRevisionContext(store, { repoId, branch: "main" }).context;
  assert.equal(buildContextPack(store, a, { revision }).scopeFallback, undefined);
  store.close();
});
```

- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement** — at each of the four sites, capture whether the branch came from `liveBranchOf`:

```typescript
const explicitBranchId = revisionBranchId(options);
const branchId = explicitBranchId ?? liveBranchOf(store, focus);
const scopeFallback = !explicitBranchId && branchId ? { branchId } : undefined;
// ...spread into the returned object: ...(scopeFallback ? { scopeFallback } : {})
```

  And in the CLI emit envelope (Task 6 code): when the emitted payload has `scopeFallback` and the resolved scope's alignment is not `fallback` already, append `warning("FALLBACK_LIVE_BRANCH", ...)`. (After Task 6, CLI/MCP always pass a revision, so in practice this fires only for direct library consumers and the legacy graph verbs at `command-dispatch.ts:1671`.)

- [ ] **Step 4: Build + run to verify PASS; full suite**
- [ ] **Step 5: Commit** — `feat(core): mark liveBranchOf fallbacks as scopeFallback instead of staying silent`

---

### Task 8: MCP wiring — shared chokepoint, kill the duplicate resolver

**Files:**
- Modify: `packages/mcp/src/knowledge-tools.ts` — `resolveMcpRevision` (`:412-438`), `nodeRepoId` (`:440`), handlers for `knowledge_context`/`flow`/`affected`/`path`/`locate`/`explore`/`callers`/`callees`/`impact` (`:665-766`)
- Test: `tests/knowledge-mcp-scope.test.mjs`

**Interfaces:**
- Consumes: `resolveQueryScope`, `ScopeResolutionError` from `@penguin/knowledge-core`.
- Produces: `resolveMcpRevision(store, args, target)` now returns `{ revision, scope } ` by delegating to `resolveQueryScope` with `repoId` from (explicit arg → `nodeRepoId(target)` inference) — note MCP has no meaningful cwd, so repo inference is arg/symbol-based and git introspection happens at the repo's registered `root_path`. Tool results gain `locator`/`alignment`/`warnings`. `BRANCH_NOT_INDEXED` maps to an MCP tool error whose message contains the `penguin index` hint and the indexed-branch candidates.

- [ ] **Step 1: Write the failing test** — same fixture pattern as Task 6 (real `git init -b feature-x` repo + registered `main` branch), calling `handleKnowledgeTool` (or `runKnowledgeTool`) directly from `../packages/mcp/dist/…` for `knowledge_context` with `{ target: "Alpha" }`: assert the un-indexed-checkout case returns an error payload matching `/BRANCH_NOT_INDEXED/` and the `allow_fallback: true` case returns `locator.branchName === "main"` with the `BRANCH_NOT_INDEXED_FALLBACK` warning. (Implementer: check how `packages/mcp/dist` exposes the handler — `runKnowledgeTool` at `knowledge-tools.ts:267` is the entry; construct its deps the way `packages/mcp/src/index.ts:603` does.)
- [ ] **Step 2: Build + run to verify FAIL**
- [ ] **Step 3: Implement** — replace `resolveMcpRevision` internals with a `resolveQueryScope` call; add `allow_fallback` boolean to the tool input schemas in `packages/mcp/src/knowledge-tool-defs.ts` for the scoped tools; attach `locator/alignment/warnings` to each handler's return object; catch `ScopeResolutionError` in `handleKnowledgeTool`'s switch wrapper and convert to the MCP error shape used for existing errors.
- [ ] **Step 4: Build + run to verify PASS; full suite**
- [ ] **Step 5: Commit** — `feat(mcp): route scope through resolveQueryScope; surface BRANCH_NOT_INDEXED`

---

### Task 9: query-server — stop dropping repoName/branch search scopes

**Files:**
- Modify: `packages/knowledge-cli/src/query-server.ts:53-58` (the `knowledge.search` scope mapping)
- Test: `tests/knowledge-query-server-scope.test.mjs`

**Interfaces:**
- Consumes: `resolveRevisionContext` (already exported from knowledge-core), store lookups.
- Produces: `scope.revisions` entries carrying `repoName`/`branch` (no `snapshotId`) are resolved to snapshot scopes before the filter, instead of being silently discarded. Unresolvable entries produce a `SCOPE_UNRESOLVED` warning in the search response's diagnostics rather than vanishing.

- [ ] **Step 1: Write the failing test** — spawn `runQueryServer` in-process with a fixture store (deps shape per `CliDeps`; see how `runQueryServer(deps, input, output)` is invoked — feed it a readable stream of one `knowledge.search` request frame with `scope: { revisions: [{ repoName: "demo", branch: "feature" }] }` where `feature` is a registered *snapshot* branch with a distinct symbol, and assert the response hits come from `feature`, not `main`). Frame encoding helpers `encodeFrame`/`parseFrame` are exported from `packages/knowledge-cli/dist` (`query-protocol.js` re-exports — verify export surface; if not exported from the package index, import the compiled `dist/query-protocol.js` directly).
- [ ] **Step 2: Build + run to verify FAIL** (hits come from all live scopes because the entry was dropped)
- [ ] **Step 3: Implement** — replace the filter at `:55-56` with a mapper:

```typescript
const requested = request.scope?.revisions ?? [];
const scopes: Array<{ repoId?: string; snapshotId: string }> = [];
const scopeWarnings: Array<{ code: string; message: string }> = [];
for (const rev of requested) {
  if (typeof rev.snapshotId === "string") { scopes.push({ ...(rev.repoId ? { repoId: rev.repoId } : {}), snapshotId: rev.snapshotId }); continue; }
  const repoRow = rev.repoId ?? rev.repoName
    ? store.db.prepare("SELECT id FROM repos WHERE id=? OR name=? LIMIT 1").get(rev.repoId ?? rev.repoName, rev.repoName ?? rev.repoId)
    : undefined;
  if (!repoRow) { scopeWarnings.push({ code: "SCOPE_UNRESOLVED", message: `scope entry did not match a repo: ${JSON.stringify(rev)}` }); continue; }
  const resolution = resolveRevisionContext(store, { repoId: repoRow.id, ...(rev.branch ? { branch: rev.branch } : {}) });
  if (resolution.status === "resolved") scopes.push({ repoId: repoRow.id, snapshotId: resolution.context.snapshotId });
  else scopeWarnings.push({ code: "SCOPE_UNRESOLVED", message: resolution.reason });
}
```

  Thread `scopeWarnings` into the search response's `diagnostics.warnings` (merge with whatever `searchKnowledge` returns). Extend the request type destructuring at `:54` to include `repoName`/`branch` fields.
- [ ] **Step 4: Build + run to verify PASS; full suite**
- [ ] **Step 5: Commit** — `fix(query-server): resolve repoName/branch search scopes instead of dropping them`

---

## Post-plan checks

- [ ] Full suite green: `pnpm run build && node --test --test-reporter=dot tests/*.test.mjs`
- [ ] Manual smoke on this repo: `penguin index`, then `penguin context WikiSearchPage --json` → payload has `locator` with `branchName: "main"`, `alignment: "aligned"`; `git checkout -b tmp-branch && penguin context WikiSearchPage` → exits 4 with `BRANCH_NOT_INDEXED` (then `git checkout main && git branch -D tmp-branch`).
- [ ] Note follow-ups: Plan 1B (Wiki UI surfaces) consumes the envelope; Phase 2 consumes `coverage_layers` + `edges.boundary`.

## Self-review notes

- Spec coverage: D1 → Tasks 1, 6, 7, 8; D2 → Tasks 5–9; D3 → Tasks 2–4. Limitations 1/2/8-partial/12-partial/14/15 addressed here; 8/12/13/16 UI halves land in Plan 1B.
- Anchors quoted from a 2026-08-05 survey — line numbers may drift; executors must re-verify each anchor before editing.
- `tests/knowledge-affected.test.mjs` and `tests/knowledge-revision-isolation.test.mjs` are the convention references for CliDeps and store fixtures respectively.
