# Penguin MCP Repository Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Penguin MCP answer repository dependency and logging-chain questions without requiring the target repository to run `pnpm i`.

**Architecture:** Parse committed `package.json` and optional `pnpm-lock.yaml` during indexing, persist dependency metadata as `depends_on` graph evidence, expose bounded dependency traversal from knowledge-core, and add MCP tools that return facts, inferences, evidence, and gaps. Existing RPC tools remain unchanged.

**Tech Stack:** TypeScript, Node test runner, `yaml`, SQLite via `better-sqlite3`, MCP SDK, existing Penguin knowledge indexer/core packages.

---

## File Map

- Create: `packages/knowledge-indexer/src/package-dependencies.ts` — manifest and pnpm lockfile parsing.
- Modify: `packages/knowledge-indexer/src/package-detect.ts` — return dependency specs and package metadata without reading `node_modules`.
- Modify: `packages/knowledge-indexer/src/pipeline.ts` — persist dependency provenance and lockfile-resolved versions.
- Modify: `packages/knowledge-indexer/src/index.ts` — export the new parser types/functions.
- Create: `packages/knowledge-core/src/package-query.ts` — bounded dependency traversal and path resolution.
- Modify: `packages/knowledge-core/src/index.ts` — export package-query APIs.
- Modify: `packages/mcp/src/knowledge-tool-defs.ts` — register `package_dependencies`, `dependency_path`, and `analyze_repository` schemas.
- Create: `packages/mcp/src/repository-analysis.ts` — deterministic focus selection and evidence aggregation.
- Modify: `packages/mcp/src/knowledge-tools.ts` — dispatch the new tools.
- Modify: `packages/mcp/src/index.ts` — keep `include_sensitive=true` as the default for existing desktop-data tools and preserve explicit opt-out behavior.
- Create: `tests/knowledge-package-dependencies.test.mjs` — parser and no-install fixtures.
- Create: `tests/knowledge-package-query.test.mjs` — graph traversal behavior.
- Modify: `tests/knowledge-mcp-tools.test.mjs` — tool registration, dispatch, and analysis output.
- Modify: `packages/knowledge-indexer/package.json` and `pnpm-lock.yaml` — add the direct `yaml` parser dependency.

### Task 1: Add manifest and pnpm lockfile parsing

**Files:**
- Create: `packages/knowledge-indexer/src/package-dependencies.ts`
- Create: `tests/knowledge-package-dependencies.test.mjs`
- Modify: `packages/knowledge-indexer/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the failing no-install parser test**

Create a temporary fixture containing only:

```text
package.json
pnpm-lock.yaml
```

Assert that `readPackageDependencies(root)` returns the direct dependency `@snsoft/nestjs-logger` with its `package.json` specifier and the lockfile-resolved version, while `node_modules` does not exist.

Also add a fixture without `pnpm-lock.yaml` and assert `complete === false` with a gap containing `pnpm-lock.yaml`.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
node --test tests/knowledge-package-dependencies.test.mjs
```

Expected: FAIL because `package-dependencies.ts` and `readPackageDependencies` do not exist yet.

- [ ] **Step 3: Add the YAML dependency explicitly**

Run:

```bash
pnpm add yaml --filter @penguin/knowledge-indexer
```

Keep `yaml` as a direct dependency of `@penguin/knowledge-indexer`; do not rely on a transitive copy already present in the workspace.

- [ ] **Step 4: Implement the parser**

Implement these exports:

```ts
export interface DependencySpec {
  name: string;
  specifier: string | null;
  scope: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
  resolvedVersion?: string;
  source: "package.json" | "pnpm-lock.yaml" | "indexed_dependency_repo";
}

export interface PackageDependencyReport {
  packageName: string;
  dependencies: DependencySpec[];
  lockfilePath: string | null;
  complete: boolean;
  gaps: string[];
}

export function readPackageDependencies(rootPath: string): PackageDependencyReport | null;
```

Read dependency sections from `package.json` directly. Read `pnpm-lock.yaml` only when present. Resolve a direct dependency through the lockfile importer entry for the repository's relative root; retain the declared specifier even when no resolved version is available. Never read `node_modules`, run npm, or access the network.

- [ ] **Step 5: Run the focused test and verify it passes**

Run the same command. Expected: PASS for both lockfile-present and lockfile-missing fixtures.

- [ ] **Step 6: Export the parser from the indexer package**

Modify `packages/knowledge-indexer/src/index.ts` to export `readPackageDependencies`, `DependencySpec`, and `PackageDependencyReport`, then run:

```bash
pnpm -F @penguin/knowledge-indexer build
```

Expected: exit 0.

### Task 2: Persist dependency metadata during indexing

**Files:**
- Modify: `packages/knowledge-indexer/src/package-detect.ts`
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Modify: `tests/knowledge-package-dependencies.test.mjs`

- [ ] **Step 1: Add a failing pipeline fixture test**

Index a temporary repository containing `package.json`, `pnpm-lock.yaml`, and a source file, with no `node_modules`. Query the resulting SQLite database and assert:

```text
edge_type = depends_on
provenance.source = package.json or pnpm-lock.yaml
provenance.specifier is present
provenance.resolvedVersion is present when lockfile data exists
```

Assert that ordinary non-`@snsoft` packages such as `pino` are represented when they appear in the manifest or lockfile. Existing `@snsoft` package-to-repo nodes must remain intact.

- [ ] **Step 2: Run the fixture test and verify it fails**

Run:

```bash
node --test tests/knowledge-package-dependencies.test.mjs
```

Expected: FAIL because the current pipeline stores only bare `@snsoft/*` names and no dependency provenance.

- [ ] **Step 3: Update package detection and pipeline persistence**

Change `PackageInfo.dependencies` from `string[]` to `DependencySpec[]`. Keep the existing package registry behavior for published `@snsoft` packages. During the `packages` stage, create `depends_on` edges for all manifest dependency specs and serialize the dependency record into `ParsedEdge.provenance`.

Use `~package.json` as the manifest evidence path and `~pnpm-lock.yaml` only for lockfile-derived metadata. Do not create fake source-symbol nodes for dependency records.

- [ ] **Step 4: Run the fixture test and verify it passes**

Run the focused test again. Expected: PASS with no `node_modules` directory.

- [ ] **Step 5: Run existing indexer regression tests**

Run:

```bash
node --test tests/knowledge-indexer-scaffold.test.mjs tests/pipeline-fullstack.test.mjs tests/knowledge-remove-repo.test.mjs
```

Expected: PASS; existing gRPC and repository indexing behavior remains unchanged.

### Task 3: Add bounded dependency graph queries

**Files:**
- Create: `packages/knowledge-core/src/package-query.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Create: `tests/knowledge-package-query.test.mjs`

- [ ] **Step 1: Add failing graph-query tests**

Seed a temporary `KnowledgeStore` with package nodes and this graph:

```text
auth → nestjs-logger → console-override → pino
```

Test:

- direct dependencies return only the next node;
- transitive traversal returns all nodes through `maxDepth`;
- reverse direction returns dependents;
- `dependencyPath(auth, pino)` returns the ordered path;
- missing subject returns `subject_not_found`;
- an existing subject with no path returns `no_path`;
- traversal stops at the requested depth and reports `truncated`.

- [ ] **Step 2: Run the graph tests and verify the expected failure**

Run:

```bash
node --test tests/knowledge-package-query.test.mjs
```

Expected: FAIL because the package-query module does not exist.

- [ ] **Step 3: Implement the query API**

Export:

```ts
export type DependencyDirection = "dependencies" | "dependents" | "both";

export function packageDependencies(store: KnowledgeStore, options: {
  subject: string;
  direction: DependencyDirection;
  transitive: boolean;
  maxDepth: number;
  limit: number;
}): PackageDependencyQueryResult;

export function dependencyPath(store: KnowledgeStore, options: {
  from: string;
  to: string;
  maxDepth: number;
}): DependencyPathResult;
```

Resolve by node id, `npm-package::` identity key, package title, or repo name. Traverse only active `depends_on` edges. Apply hard maximums even when callers pass larger values. Parse provenance defensively; malformed metadata becomes an evidence gap, not a query failure.

- [ ] **Step 4: Run the graph tests and verify they pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Build knowledge-core**

Run:

```bash
pnpm -F @penguin/knowledge-core build
```

Expected: exit 0.

### Task 4: Add MCP dependency tools and repository analysis

**Files:**
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Create: `packages/mcp/src/repository-analysis.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `tests/knowledge-mcp-tools.test.mjs`

- [ ] **Step 1: Add failing MCP contract tests**

Extend the existing tool-registration test to require:

```text
analyze_repository
dependency_path
package_dependencies
```

Add handler tests for the seeded package graph. Assert that a logging query returns `focus: "logging"`, keeps dependency facts in `verifiedFacts`, and places the external `stdout → Logtail → SLS` claim in `gaps` unless an indexed deployment source exists.

- [ ] **Step 2: Run the MCP tests and verify the expected failure**

Run:

```bash
node --test tests/knowledge-mcp-tools.test.mjs
```

Expected: FAIL because the new tools are not registered or dispatched.

- [ ] **Step 3: Add tool definitions**

Add schemas to `KNOWLEDGE_TOOL_DEFS` with bounded numeric inputs. Descriptions must state that the tools read indexed manifest/lockfile evidence, do not install dependencies, and return completeness gaps when lockfile data is unavailable.

- [ ] **Step 4: Implement dispatch and deterministic focus selection**

Dispatch `package_dependencies` and `dependency_path` to knowledge-core. Implement `selectAnalysisFocus(query, requestedFocus)` with explicit focus precedence:

```ts
if (requestedFocus !== "auto") return requestedFocus;
if (/depend|package|npm|pnpm|lockfile/i.test(query)) return "dependency";
if (/log|stdout|pino|sls|logtail|otel/i.test(query)) return "logging";
if (/call|caller|invoke|route/i.test(query)) return "calls";
return "architecture";
```

`analyze_repository` must return `{ focus, verifiedFacts, inferences, gaps, evidence, nextTools }`. It may combine package queries and existing graph queries, but must not turn an empty search result into a negative fact.

Keep `include_sensitive` defaulting to `true` for tools that expose desktop request data; when callers pass `false`, redact token-bearing headers and request bodies. `analyze_repository` must never invoke `call_method`, replay, or a state-changing RPC automatically.

- [ ] **Step 5: Run the MCP tests and verify they pass**

Run the same test command. Expected: PASS, including all existing knowledge tool tests.

- [ ] **Step 6: Build the MCP package**

Run:

```bash
pnpm -F @penguin/mcp build
```

Expected: exit 0.

### Task 5: Full verification and handoff

**Files:**
- No additional production files.

- [ ] **Step 1: Run focused tests**

```bash
node --test tests/knowledge-package-dependencies.test.mjs tests/knowledge-package-query.test.mjs tests/knowledge-mcp-tools.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the project knowledge test set**

```bash
pnpm test -- --test-name-pattern='knowledge|pipeline|package'
```

Expected: PASS with no failures.

- [ ] **Step 3: Run typecheck and MCP build**

```bash
pnpm typecheck
pnpm -F @penguin/mcp build
```

Expected: both exit 0.

- [ ] **Step 4: Run repository hygiene checks**

```bash
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 5: Verify the no-install acceptance case manually**

Run the new fixture through the indexer after ensuring its fixture directory has no `node_modules`, then call `package_dependencies` and `dependency_path`. Confirm the output includes manifest/lockfile evidence and does not claim external Logtail/SLS behavior.
