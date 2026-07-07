# Penguin Knowledge Plan 2a/5 — Store Extension for the Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@penguin/knowledge-core`'s `KnowledgeStore` + schema with the storage surface the tree-sitter indexer (Plan 2b+) will write through: the missing `files_index` table, repo/branch registration, and `symbol_versions` upsert/stale APIs — no sidecar, no parsing, pure testable store.

**Architecture:** Additive schema change (add `files_index` to the idempotent DDL, bump `SCHEMA_VERSION` 1→2) plus new methods on the existing `KnowledgeStore` class. All new writes are **parser-derived / rebuildable data** (D4) — they go through direct SQL upserts (like the existing `upsertNode`/`replaceFileEdges`), NOT through the ledger. No new dependencies.

**Tech Stack:** TypeScript 5.7 (NodeNext ESM) · better-sqlite3 v11 · node:crypto · node:test

**Spec:** `requirements/knowledge-design.md` v2.5 — implements the `files_index` table (§3.2), the repo/branch/symbol_versions write surface for §4 (branch model) and §6.3 (incremental pipeline). The indexer *logic* that calls these methods is Plan 2b–2f.

## Roadmap context

Plan 2 (索引引擎) is split into 2a–2f; this is **2a** (store extension). Confirmed architecture for later plans: **web-tree-sitter WASM sidecar + tags.scm** (spec §6). This plan deliberately contains none of that — it only lays the store methods so 2b can be built and reviewed independently.

## Global Constraints

- Package `@penguin/knowledge-core`, dir `packages/knowledge-core/`; mirror `packages/core` conventions (`"type": "module"`, tsc → `dist/`, `main`/`types`/`exports`).
- TS target `ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict true` — **every intra-package import ends in `.js`** (Node ESM runtime requirement).
- Tests: node:test runner, files at repo-root `tests/knowledge-core-*.test.mjs`, importing the built artifact `../packages/knowledge-core/dist/index.js` — **run `pnpm -F @penguin/knowledge-core build` before every test run**.
- §2.2 iron rule is unchanged: the ledger is the only source of non-rebuildable knowledge. **Everything this plan adds is rebuildable Index-layer data** written by direct SQL — never call `recordKnowledge()` / the ledger from these methods.
- Core relational model uses no SQLite-proprietary features (D4); no FTS involvement in this plan.
- No new runtime dependencies. (better-sqlite3 already present + in root `pnpm.onlyBuiltDependencies`.)
- Row ids are `randomUUID()`-based with a type prefix, matching existing code: `repo_<uuid>`, `branch_<uuid>`, `symver_<uuid>`, `fidx_<uuid>`.
- Timestamps are UTC ISO strings via `new Date().toISOString()`.
- Upserts use `INSERT ... ON CONFLICT (<unique cols>) DO UPDATE ... RETURNING id` (the atomic pattern already used by `upsertNode`), never SELECT-then-INSERT.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: `files_index` table + schema version bump

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts` (add table to `DDL`, bump `SCHEMA_VERSION`)
- Test: `tests/knowledge-core-schema-files-index.test.mjs` (new)

**Interfaces:**
- Consumes: `openDatabase(path: string): Database.Database` (Plan 1)
- Produces: a `files_index` table with columns `id, repo_id, branch_id, file_path, lang, mtime_ms, size_bytes, content_hash, indexed_at, status, error` and `UNIQUE (repo_id, branch_id, file_path)`; `SCHEMA_VERSION === 2`.

- [ ] **Step 1: Write the failing test**

`tests/knowledge-core-schema-files-index.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), "pk-fidx-")), "knowledge.db");
}

test("schema version is 2 and meta records it", () => {
  assert.equal(SCHEMA_VERSION, 2);
  const db = openDatabase(tempDbPath());
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(row.value, "2");
  db.close();
});

test("files_index table exists with the spec columns and unique key", () => {
  const db = openDatabase(tempDbPath());
  const cols = db.prepare("PRAGMA table_info(files_index)").all().map((c) => c.name);
  for (const c of [
    "id", "repo_id", "branch_id", "file_path", "lang",
    "mtime_ms", "size_bytes", "content_hash", "indexed_at", "status", "error",
  ]) {
    assert.ok(cols.includes(c), `files_index missing column: ${c}`);
  }
  // UNIQUE (repo_id, branch_id, file_path): second insert of same triple must throw
  db.prepare(
    "INSERT INTO files_index (id, repo_id, branch_id, file_path, status) VALUES ('f1','r1','b1','src/a.ts','indexed')",
  ).run();
  assert.throws(
    () =>
      db.prepare(
        "INSERT INTO files_index (id, repo_id, branch_id, file_path, status) VALUES ('f2','r1','b1','src/a.ts','indexed')",
      ).run(),
    /UNIQUE/i,
  );
  db.close();
});

test("openDatabase remains idempotent with the new table", () => {
  const path = tempDbPath();
  openDatabase(path).close();
  const db = openDatabase(path); // second open must not throw on existing files_index
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files_index").get().n, 0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-schema-files-index.test.mjs`
Expected: FAIL — `SCHEMA_VERSION` is `1` (assertion fails) and/or `no such table: files_index`.

- [ ] **Step 3: Add the table to the DDL and bump the version**

In `packages/knowledge-core/src/schema.ts`, add this block to the `DDL` template string, immediately after the `edges` table's two `CREATE INDEX` lines (keep it adjacent to the other Index-layer tables):

```sql
CREATE TABLE IF NOT EXISTS files_index (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  file_path TEXT NOT NULL,
  lang TEXT,
  mtime_ms INTEGER,
  size_bytes INTEGER,
  content_hash TEXT,
  indexed_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  UNIQUE (repo_id, branch_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_files_index_scope ON files_index(repo_id, branch_id);
```

Then change the version constant:

```typescript
export const SCHEMA_VERSION = 2;
```

Leave the `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)` line as-is — but note it uses `INSERT OR IGNORE`, so a DB created at v1 keeps its old `meta.schema_version='1'` row. That is acceptable here because knowledge-core has never shipped (unmerged branch) and the DDL is purely additive (`CREATE TABLE IF NOT EXISTS`); no data migration is required. The `SCHEMA_VERSION === 2` constant + the fresh-DB meta row are what the test checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-schema-files-index.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/schema.ts tests/knowledge-core-schema-files-index.test.mjs
git commit -m "$(cat <<'EOF'
feat(knowledge): add files_index table + bump schema to v2

Adds the per-file incremental-index checkpoint table (spec §3.2 / §6.3.1)
that the indexer (Plan 2b+) writes through. Purely additive DDL
(CREATE TABLE IF NOT EXISTS) + scope index; SCHEMA_VERSION 1→2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: repo + branch registration API

**Files:**
- Modify: `packages/knowledge-core/src/store.ts` (add types + methods on `KnowledgeStore`)
- Test: `tests/knowledge-core-store-registry.test.mjs` (new)

**Interfaces:**
- Consumes: `KnowledgeStore.open`, `store.db` (Plan 1); the `repos` / `branches` tables (Plan 1 schema).
- Produces (all on `KnowledgeStore`):
  - `type BranchStatus = "live" | "snapshot" | "gone"`
  - `interface RepoRow { id: string; name: string; root_path: string; remote_url: string | null; created_at: string }`
  - `interface BranchRow { id: string; repo_id: string; name: string; head_commit: string | null; last_indexed_commit: string | null; last_indexed_at: string | null; checkout_path: string | null; status: string }`
  - `registerRepo(p: { name: string; rootPath: string; remoteUrl?: string | null }): string` — idempotent on `root_path`; updates `name`/`remote_url` on conflict; returns repo id.
  - `getRepoByRoot(rootPath: string): RepoRow | null`
  - `registerBranch(p: { repoId: string; name: string; headCommit?: string | null; checkoutPath?: string | null; status: BranchStatus }): string` — idempotent on `(repo_id, name)`; updates `head_commit`/`checkout_path`/`status` on conflict; returns branch id.
  - `getBranch(repoId: string, name: string): BranchRow | null`
  - `setBranchStatus(branchId: string, status: BranchStatus): void`
  - `recordBranchIndexed(p: { branchId: string; commit?: string | null }): void` — sets `last_indexed_commit` (if `commit` provided) and `last_indexed_at = now`.

- [ ] **Step 1: Write the failing test**

`tests/knowledge-core-store-registry.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-reg-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

test("registerRepo is idempotent on root_path and updates name", () => {
  const store = openTemp();
  const id1 = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const id2 = store.registerRepo({ name: "fpms-renamed", rootPath: "/work/fpms" });
  assert.equal(id1, id2);
  const repo = store.getRepoByRoot("/work/fpms");
  assert.equal(repo.id, id1);
  assert.equal(repo.name, "fpms-renamed");
  assert.equal(repo.remote_url, null);
  assert.equal(store.getRepoByRoot("/work/nope"), null);
  store.close();
});

test("registerBranch is idempotent on (repo_id, name) and updates status/head", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const b1 = store.registerBranch({ repoId, name: "main", headCommit: "abc", status: "live" });
  const b2 = store.registerBranch({ repoId, name: "main", headCommit: "def", status: "snapshot" });
  assert.equal(b1, b2);
  const branch = store.getBranch(repoId, "main");
  assert.equal(branch.head_commit, "def");
  assert.equal(branch.status, "snapshot");
  // distinct branch name → distinct row
  const feat = store.registerBranch({ repoId, name: "feature/x", status: "live" });
  assert.notEqual(feat, b1);
  store.close();
});

test("setBranchStatus and recordBranchIndexed mutate the branch row", () => {
  const store = openTemp();
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });

  store.setBranchStatus(branchId, "gone");
  assert.equal(store.getBranch(repoId, "main").status, "gone");

  store.recordBranchIndexed({ branchId, commit: "abc123" });
  const after = store.getBranch(repoId, "main");
  assert.equal(after.last_indexed_commit, "abc123");
  assert.ok(after.last_indexed_at, "last_indexed_at should be set");
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store-registry.test.mjs`
Expected: FAIL — `store.registerRepo is not a function` (methods don't exist yet).

- [ ] **Step 3: Add the types and methods**

In `packages/knowledge-core/src/store.ts`, add the exported types near the other interface declarations (e.g. after `SearchHit`):

```typescript
export type BranchStatus = "live" | "snapshot" | "gone";

export interface RepoRow {
  id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  created_at: string;
}

export interface BranchRow {
  id: string;
  repo_id: string;
  name: string;
  head_commit: string | null;
  last_indexed_commit: string | null;
  last_indexed_at: string | null;
  checkout_path: string | null;
  status: string;
}
```

Then add these methods inside the `KnowledgeStore` class (place them after `getNode`, before `replaceFileEdges`):

```typescript
  // —— repo / branch 登记（可再生 Index 层，直写）——
  registerRepo(p: { name: string; rootPath: string; remoteUrl?: string | null }): string {
    const row = this.db
      .prepare(
        `INSERT INTO repos (id, name, root_path, remote_url, created_at)
         VALUES (@id, @name, @rootPath, @remoteUrl, @createdAt)
         ON CONFLICT (root_path) DO UPDATE SET
           name = excluded.name,
           remote_url = excluded.remote_url
         RETURNING id`,
      )
      .get({
        id: `repo_${randomUUID()}`,
        name: p.name,
        rootPath: p.rootPath,
        remoteUrl: p.remoteUrl ?? null,
        createdAt: new Date().toISOString(),
      }) as { id: string };
    return row.id;
  }

  getRepoByRoot(rootPath: string): RepoRow | null {
    return (
      (this.db.prepare("SELECT * FROM repos WHERE root_path = ?").get(rootPath) as
        | RepoRow
        | undefined) ?? null
    );
  }

  registerBranch(p: {
    repoId: string;
    name: string;
    headCommit?: string | null;
    checkoutPath?: string | null;
    status: BranchStatus;
  }): string {
    const row = this.db
      .prepare(
        `INSERT INTO branches (id, repo_id, name, head_commit, checkout_path, status)
         VALUES (@id, @repoId, @name, @headCommit, @checkoutPath, @status)
         ON CONFLICT (repo_id, name) DO UPDATE SET
           head_commit = excluded.head_commit,
           checkout_path = excluded.checkout_path,
           status = excluded.status
         RETURNING id`,
      )
      .get({
        id: `branch_${randomUUID()}`,
        repoId: p.repoId,
        name: p.name,
        headCommit: p.headCommit ?? null,
        checkoutPath: p.checkoutPath ?? null,
        status: p.status,
      }) as { id: string };
    return row.id;
  }

  getBranch(repoId: string, name: string): BranchRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM branches WHERE repo_id = ? AND name = ?")
        .get(repoId, name) as BranchRow | undefined) ?? null
    );
  }

  setBranchStatus(branchId: string, status: BranchStatus): void {
    this.db.prepare("UPDATE branches SET status = ? WHERE id = ?").run(status, branchId);
  }

  recordBranchIndexed(p: { branchId: string; commit?: string | null }): void {
    this.db
      .prepare(
        `UPDATE branches
         SET last_indexed_at = @at,
             last_indexed_commit = COALESCE(@commit, last_indexed_commit)
         WHERE id = @branchId`,
      )
      .run({ branchId: p.branchId, commit: p.commit ?? null, at: new Date().toISOString() });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store-registry.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/store.ts tests/knowledge-core-store-registry.test.mjs
git commit -m "$(cat <<'EOF'
feat(knowledge): repo + branch registration API on KnowledgeStore

Idempotent registerRepo (by root_path) / registerBranch (by repo_id+name),
plus setBranchStatus and recordBranchIndexed for the branch lifecycle
(live/snapshot/gone, last-indexed tracking) the indexer needs (spec §4).
All direct-SQL rebuildable writes — no ledger involvement.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `symbol_versions` upsert + stale API

**Files:**
- Modify: `packages/knowledge-core/src/store.ts`
- Test: `tests/knowledge-core-store-symver.test.mjs` (new)

**Interfaces:**
- Consumes: `KnowledgeStore.open`, `upsertNode`, `registerRepo`, `registerBranch` (Tasks above); `symbol_versions` table (Plan 1 schema, `UNIQUE (node_id, branch_id)`).
- Produces (on `KnowledgeStore`):
  - `type SymbolStatus = "fresh" | "stale"`
  - `interface SymbolVersionRow { id: string; node_id: string; branch_id: string; commit_sha: string; file_path: string; lang: string; kind: string; signature: string | null; start_line: number | null; end_line: number | null; content_hash: string; status: string; first_seen_at: string | null; last_seen_at: string | null }`
  - `upsertSymbolVersion(v: { nodeId: string; branchId: string; commitSha: string; filePath: string; lang: string; kind: string; signature?: string | null; startLine?: number | null; endLine?: number | null; contentHash: string; status?: SymbolStatus }): string` — upsert on `(node_id, branch_id)`; on insert sets `first_seen_at = last_seen_at = now`; on update refreshes everything and sets `last_seen_at = now` but preserves `first_seen_at`; `status` defaults to `"fresh"`; returns version row id.
  - `getSymbolVersion(nodeId: string, branchId: string): SymbolVersionRow | null`
  - `markFileSymbolsStale(p: { branchId: string; filePath: string }): number` — sets `status = 'stale'` for all versions on that branch+file; returns rows affected.

- [ ] **Step 1: Write the failing test**

`tests/knowledge-core-store-symver.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-symver-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function setup(store) {
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const nodeId = store.upsertNode({
    nodeType: "symbol", identityKey: "fpms:GetLoginURL", title: "GetLoginURL", repoId,
  });
  return { repoId, branchId, nodeId };
}

test("upsertSymbolVersion is idempotent on (node_id, branch_id) and preserves first_seen_at", () => {
  const store = openTemp();
  const { branchId, nodeId } = setup(store);
  const v1 = store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "abc", filePath: "src/login.ts",
    lang: "ts", kind: "function", contentHash: "h1",
  });
  const first = store.getSymbolVersion(nodeId, branchId);
  assert.equal(first.status, "fresh");
  assert.equal(first.content_hash, "h1");
  assert.ok(first.first_seen_at);

  const v2 = store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "def", filePath: "src/login.ts",
    lang: "ts", kind: "function", contentHash: "h2",
  });
  assert.equal(v1, v2); // same row
  const after = store.getSymbolVersion(nodeId, branchId);
  assert.equal(after.commit_sha, "def");
  assert.equal(after.content_hash, "h2");
  assert.equal(after.first_seen_at, first.first_seen_at); // preserved
  store.close();
});

test("markFileSymbolsStale marks only the matching branch+file and reports count", () => {
  const store = openTemp();
  const { repoId, branchId, nodeId } = setup(store);
  const other = store.upsertNode({
    nodeType: "symbol", identityKey: "fpms:Helper", title: "Helper", repoId,
  });
  store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "abc", filePath: "src/login.ts",
    lang: "ts", kind: "function", contentHash: "h1",
  });
  store.upsertSymbolVersion({
    nodeId: other, branchId, commitSha: "abc", filePath: "src/other.ts",
    lang: "ts", kind: "function", contentHash: "h9",
  });

  const n = store.markFileSymbolsStale({ branchId, filePath: "src/login.ts" });
  assert.equal(n, 1);
  assert.equal(store.getSymbolVersion(nodeId, branchId).status, "stale");
  assert.equal(store.getSymbolVersion(other, branchId).status, "fresh"); // untouched
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store-symver.test.mjs`
Expected: FAIL — `store.upsertSymbolVersion is not a function`.

- [ ] **Step 3: Add the types and methods**

In `store.ts`, add types near the others:

```typescript
export type SymbolStatus = "fresh" | "stale";

export interface SymbolVersionRow {
  id: string;
  node_id: string;
  branch_id: string;
  commit_sha: string;
  file_path: string;
  lang: string;
  kind: string;
  signature: string | null;
  start_line: number | null;
  end_line: number | null;
  content_hash: string;
  status: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
}
```

Add these methods inside the `KnowledgeStore` class (after `recordBranchIndexed`):

```typescript
  // —— symbol_versions（分支作用域的实现快照，可再生直写）——
  // first_seen_at 在插入时定；更新只刷新 last_seen_at 与内容字段，不动 first_seen_at。
  upsertSymbolVersion(v: {
    nodeId: string;
    branchId: string;
    commitSha: string;
    filePath: string;
    lang: string;
    kind: string;
    signature?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    contentHash: string;
    status?: SymbolStatus;
  }): string {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO symbol_versions
           (id, node_id, branch_id, commit_sha, file_path, lang, kind, signature,
            start_line, end_line, content_hash, status, first_seen_at, last_seen_at)
         VALUES (@id, @nodeId, @branchId, @commitSha, @filePath, @lang, @kind, @signature,
            @startLine, @endLine, @contentHash, @status, @now, @now)
         ON CONFLICT (node_id, branch_id) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           file_path = excluded.file_path,
           lang = excluded.lang,
           kind = excluded.kind,
           signature = excluded.signature,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           content_hash = excluded.content_hash,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at
         RETURNING id`,
      )
      .get({
        id: `symver_${randomUUID()}`,
        nodeId: v.nodeId,
        branchId: v.branchId,
        commitSha: v.commitSha,
        filePath: v.filePath,
        lang: v.lang,
        kind: v.kind,
        signature: v.signature ?? null,
        startLine: v.startLine ?? null,
        endLine: v.endLine ?? null,
        contentHash: v.contentHash,
        status: v.status ?? "fresh",
        now,
      }) as { id: string };
    return row.id;
  }

  getSymbolVersion(nodeId: string, branchId: string): SymbolVersionRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM symbol_versions WHERE node_id = ? AND branch_id = ?")
        .get(nodeId, branchId) as SymbolVersionRow | undefined) ?? null
    );
  }

  markFileSymbolsStale(p: { branchId: string; filePath: string }): number {
    const info = this.db
      .prepare(
        "UPDATE symbol_versions SET status = 'stale' WHERE branch_id = ? AND file_path = ?",
      )
      .run(p.branchId, p.filePath);
    return info.changes;
  }
```

Note on `ON CONFLICT ... last_seen_at = excluded.last_seen_at`: since both `first_seen_at` and `last_seen_at` are bound to the same `@now` on insert, and the UPDATE clause only assigns `last_seen_at` (never `first_seen_at`), `first_seen_at` is preserved on conflict — this is what the test asserts.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store-symver.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/store.ts tests/knowledge-core-store-symver.test.mjs
git commit -m "$(cat <<'EOF'
feat(knowledge): symbol_versions upsert + mark-stale API

upsertSymbolVersion (idempotent per node+branch, preserves first_seen_at,
refreshes last_seen_at) and markFileSymbolsStale for the disappeared-symbol
path (spec §4.4 / §6.3.2 delete detection). Direct-SQL rebuildable writes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `files_index` checkpoint API

**Files:**
- Modify: `packages/knowledge-core/src/store.ts`
- Test: `tests/knowledge-core-store-fileindex.test.mjs` (new)

**Interfaces:**
- Consumes: `KnowledgeStore.open`, `registerRepo`, `registerBranch`; the `files_index` table (Task 1).
- Produces (on `KnowledgeStore`):
  - `type FileStatus = "indexed" | "deleted" | "error" | "skipped"`
  - `interface FileCheckpointRow { id: string; repo_id: string; branch_id: string; file_path: string; lang: string | null; mtime_ms: number | null; size_bytes: number | null; content_hash: string | null; indexed_at: string | null; status: string; error: string | null }`
  - `getFileCheckpoint(repoId: string, branchId: string, filePath: string): FileCheckpointRow | null`
  - `upsertFileCheckpoint(p: { repoId: string; branchId: string; filePath: string; lang?: string | null; mtimeMs?: number | null; sizeBytes?: number | null; contentHash?: string | null; status: FileStatus; error?: string | null }): string` — upsert on `(repo_id, branch_id, file_path)`; always sets `indexed_at = now`; returns row id.
  - `listFileCheckpoints(repoId: string, branchId: string): FileCheckpointRow[]` — all rows for a repo+branch (delete-detection scan input), ordered by `file_path`.
  - `markFileDeleted(p: { repoId: string; branchId: string; filePath: string }): void` — sets `status = 'deleted'` for that checkpoint (no-op if absent).

- [ ] **Step 1: Write the failing test**

`tests/knowledge-core-store-fileindex.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-fchk-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function scope(store) {
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  return { repoId, branchId };
}

test("upsertFileCheckpoint stores + updates on (repo,branch,path) and stamps indexed_at", () => {
  const store = openTemp();
  const { repoId, branchId } = scope(store);
  const id1 = store.upsertFileCheckpoint({
    repoId, branchId, filePath: "src/a.ts", lang: "ts",
    mtimeMs: 1000, sizeBytes: 50, contentHash: "h1", status: "indexed",
  });
  const c1 = store.getFileCheckpoint(repoId, branchId, "src/a.ts");
  assert.equal(c1.content_hash, "h1");
  assert.equal(c1.mtime_ms, 1000);
  assert.ok(c1.indexed_at);

  const id2 = store.upsertFileCheckpoint({
    repoId, branchId, filePath: "src/a.ts",
    mtimeMs: 2000, sizeBytes: 60, contentHash: "h2", status: "indexed",
  });
  assert.equal(id1, id2);
  const c2 = store.getFileCheckpoint(repoId, branchId, "src/a.ts");
  assert.equal(c2.content_hash, "h2");
  assert.equal(c2.mtime_ms, 2000);
  assert.equal(store.getFileCheckpoint(repoId, branchId, "src/missing.ts"), null);
  store.close();
});

test("listFileCheckpoints returns the branch's files ordered by path", () => {
  const store = openTemp();
  const { repoId, branchId } = scope(store);
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "src/b.ts", status: "indexed" });
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "src/a.ts", status: "indexed" });
  const other = store.registerBranch({ repoId, name: "feature/x", status: "live" });
  store.upsertFileCheckpoint({ repoId, branchId: other, filePath: "src/z.ts", status: "indexed" });

  const paths = store.listFileCheckpoints(repoId, branchId).map((r) => r.file_path);
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]); // ordered, other branch excluded
  store.close();
});

test("markFileDeleted flips status to deleted", () => {
  const store = openTemp();
  const { repoId, branchId } = scope(store);
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "src/a.ts", status: "indexed" });
  store.markFileDeleted({ repoId, branchId, filePath: "src/a.ts" });
  assert.equal(store.getFileCheckpoint(repoId, branchId, "src/a.ts").status, "deleted");
  // absent path → no throw, no row created
  store.markFileDeleted({ repoId, branchId, filePath: "src/nope.ts" });
  assert.equal(store.getFileCheckpoint(repoId, branchId, "src/nope.ts"), null);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store-fileindex.test.mjs`
Expected: FAIL — `store.upsertFileCheckpoint is not a function`.

- [ ] **Step 3: Add the types and methods**

In `store.ts`, add types near the others:

```typescript
export type FileStatus = "indexed" | "deleted" | "error" | "skipped";

export interface FileCheckpointRow {
  id: string;
  repo_id: string;
  branch_id: string;
  file_path: string;
  lang: string | null;
  mtime_ms: number | null;
  size_bytes: number | null;
  content_hash: string | null;
  indexed_at: string | null;
  status: string;
  error: string | null;
}
```

Add these methods inside the `KnowledgeStore` class (after `markFileSymbolsStale`):

```typescript
  // —— files_index：逐文件增量检查点（可再生直写，spec §6.3.1）——
  getFileCheckpoint(
    repoId: string,
    branchId: string,
    filePath: string,
  ): FileCheckpointRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM files_index WHERE repo_id = ? AND branch_id = ? AND file_path = ?",
        )
        .get(repoId, branchId, filePath) as FileCheckpointRow | undefined) ?? null
    );
  }

  upsertFileCheckpoint(p: {
    repoId: string;
    branchId: string;
    filePath: string;
    lang?: string | null;
    mtimeMs?: number | null;
    sizeBytes?: number | null;
    contentHash?: string | null;
    status: FileStatus;
    error?: string | null;
  }): string {
    const row = this.db
      .prepare(
        `INSERT INTO files_index
           (id, repo_id, branch_id, file_path, lang, mtime_ms, size_bytes,
            content_hash, indexed_at, status, error)
         VALUES (@id, @repoId, @branchId, @filePath, @lang, @mtimeMs, @sizeBytes,
            @contentHash, @indexedAt, @status, @error)
         ON CONFLICT (repo_id, branch_id, file_path) DO UPDATE SET
           lang = excluded.lang,
           mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at,
           status = excluded.status,
           error = excluded.error
         RETURNING id`,
      )
      .get({
        id: `fidx_${randomUUID()}`,
        repoId: p.repoId,
        branchId: p.branchId,
        filePath: p.filePath,
        lang: p.lang ?? null,
        mtimeMs: p.mtimeMs ?? null,
        sizeBytes: p.sizeBytes ?? null,
        contentHash: p.contentHash ?? null,
        indexedAt: new Date().toISOString(),
        status: p.status,
        error: p.error ?? null,
      }) as { id: string };
    return row.id;
  }

  listFileCheckpoints(repoId: string, branchId: string): FileCheckpointRow[] {
    return this.db
      .prepare(
        "SELECT * FROM files_index WHERE repo_id = ? AND branch_id = ? ORDER BY file_path",
      )
      .all(repoId, branchId) as FileCheckpointRow[];
  }

  markFileDeleted(p: { repoId: string; branchId: string; filePath: string }): void {
    this.db
      .prepare(
        "UPDATE files_index SET status = 'deleted' WHERE repo_id = ? AND branch_id = ? AND file_path = ?",
      )
      .run(p.repoId, p.branchId, p.filePath);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-store-fileindex.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole knowledge suite + typecheck, then commit**

Run: `pnpm -F @penguin/knowledge-core build && node --test tests/knowledge-core-*.test.mjs && pnpm typecheck`
Expected: all knowledge tests PASS (Plan 1's 42 + this plan's 11 = 53), typecheck clean.

```bash
git add packages/knowledge-core/src/store.ts tests/knowledge-core-store-fileindex.test.mjs
git commit -m "$(cat <<'EOF'
feat(knowledge): files_index checkpoint API on KnowledgeStore

get/upsert/list/markDeleted over the per-file incremental checkpoint
(spec §6.3.1) — the get→compare→upsert loop the indexer runs per file, and
the list scan that drives delete detection. Direct-SQL rebuildable writes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage (this plan's slice):**
- `files_index` table (§3.2) → Task 1 ✅
- repo/branch registration + lifecycle (§4.1/§4.6) → Task 2 ✅
- symbol_versions write + stale marking (§4.4, §6.3.2) → Task 3 ✅
- per-file checkpoint get/upsert/list/delete (§6.3.1) → Task 4 ✅
- Out of scope (later sub-plans, intentionally): tree-sitter extraction (2b), reference resolution + rename→alias (2c), the incremental *orchestration* / git HEAD parsing (2d), note indexing (2e), chokidar watch (2f). This plan is the passive store surface only.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every test has full assertions. ✅

**3. Type consistency:** `BranchStatus`/`SymbolStatus`/`FileStatus` string unions defined once and reused; row interfaces use snake_case (raw DB column names, matching Plan 1's `NodeRow` convention) while method params use camelCase (matching Plan 1's `upsertNode`); ids prefixed `repo_`/`branch_`/`symver_`/`fidx_`. `RETURNING id` upsert pattern matches Plan 1's `upsertNode`. ✅

**4. Rebuildability invariant:** every method added is direct-SQL over rebuildable Index-layer tables (repos/branches/symbol_versions/files_index) — none touch the ledger or the ledger-materialized tables (events/node_aliases/manual edges). Consistent with §2.2 / D4. ✅
