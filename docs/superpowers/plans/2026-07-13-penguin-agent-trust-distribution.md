# Penguin Agent Trust and Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `penguin` the single canonical knowledge engine for Claude Code, Codex, and other MCP/CLI agents; give them compact freshness and trustworthy empty-result diagnostics; install capability-aware bounded adapters; and preserve the real debug cases as golden evaluations.

**Architecture:** Extend the existing Rust config merge and JS runtime doctor instead of introducing a second installer. Add diagnostics and compact status in `knowledge-core`, then expose the same objects through CLI and MCP. Keep context execution in the packaged knowledge CLI. Claude Code receives optional native hooks; Codex receives canonical MCP plus managed `AGENTS.md`; other agents use the same MCP or CLI fallback rather than a forked index.

**Tech Stack:** Rust/Tauri, TypeScript, Node.js test runner, SQLite/better-sqlite3, MCP stdio JSON-RPC.

## Global Constraints

- Work in `/Users/shieng/Desktop/Pengvi` on the existing `feature/knowledge-core` dirty worktree.
- Preserve all pre-existing user changes; do not stash, reset, commit, push, tag, or release.
- Do not add packages and do not read `.env*`.
- Every production behavior follows RED → verify failure → minimal GREEN → verify pass.
- Every shell command is prefixed with `rtk`.
- Config migration deletes `pengvi` only when ownership is proven; ambiguous entries remain untouched.
- Hooks are opt-in, bounded, local-only, and never index, persist prompts, write notes, or send network requests.
- Existing detailed query/status shapes remain backward compatible; new fields and compact modes are additive.
- Accuracy claims remain limited to independently verified static contracts.

---

## File Map

### Configuration and distribution

- Modify `src-tauri/src/mcp.rs`: classify/migrate legacy aliases and expose duplicate diagnostics.
- Modify `scripts/check-knowledge-runtime.mjs`: inspect Claude/Codex canonical and legacy targets without printing unrelated config.
- Modify `tests/knowledge-runtime-doctor.test.mjs`: duplicate classification and privacy fixtures.

### Query trust and compact status

- Modify `packages/knowledge-core/src/query.ts`: diagnostic envelope and compact status builder.
- Modify `packages/knowledge-core/src/index.ts`: export the new types/functions.
- Modify `packages/knowledge-cli/src/index.ts`: `status --compact` and diagnostic CLI parity.
- Modify `packages/mcp/src/knowledge-tools.ts`: MCP compact mode and shared diagnostics.
- Modify `packages/mcp/src/knowledge-tool-defs.ts`: schemas/descriptions.
- Modify `tests/knowledge-query.test.mjs`, `tests/knowledge-cli.test.mjs`, `tests/knowledge-mcp-tools.test.mjs`.

### Agent guidance and hooks

- Modify `packages/knowledge-indexer/src/agent-guidance.ts`: repo guidance hero ordering.
- Modify `src-tauri/src/knowledge.rs`: global guidance and managed Claude hook install/uninstall.
- Create `packages/knowledge-cli/src/claude-hook.ts`: bounded SessionStart/UserPromptSubmit rendering.
- Modify `packages/knowledge-cli/src/index.ts`: hook subcommands.
- Modify `src/lib/knowledge-client.ts`: typed Tauri hook setup API.
- Modify `src/components/wiki/WikiPage.tsx`: opt-in hook controls/results.
- Modify `src-tauri/src/lib.rs`: register hook setup command.
- Modify `tests/knowledge-cli.test.mjs`, `tests/wiki-page.test.mjs`.

### Golden evaluation and reporting

- Modify `scripts/knowledge-real-repo-benchmark.mjs`: add fixed Claude debug cases.
- Modify `tests/knowledge-real-repo-benchmark.test.mjs`: score call chains, search quality, and diagnostic parity.
- Modify `.codex/penguin-wiki-optimization-review.md`.
- Modify `.codex/penguin-replacement-validation-and-fix.md`.

---

### Task 1: Safe canonical alias migration and duplicate diagnosis

**Files:**

- Modify: `src-tauri/src/mcp.rs`
- Modify: `scripts/check-knowledge-runtime.mjs`
- Test: `src-tauri/src/mcp.rs` test module
- Test: `tests/knowledge-runtime-doctor.test.mjs`

**Interfaces:**

- Produces Rust `LegacyAliasDiagnostic` and `CanonicalMigrationResult`.
- Produces JS `classifyMcpDuplicate(canonical, legacy, probes)` used by runtime doctor tests.
- Existing `write_claude_desktop_mcp_config_at` and `write_codex_mcp_config_at` remain the only config writers.

- [ ] **Step 1: Add failing Rust tests for proven, ambiguous, and idempotent migration**

Add fixtures that write temporary Claude JSON with `other`, `penguin`, and `pengvi` entries:

~~~rust
#[test]
fn claude_migration_removes_owned_pengvi_and_preserves_other_servers() {
    let cfg = temp_config_path("claude-legacy").with_extension("json");
    fs::write(&cfg, r#"{
      "mcpServers": {
        "other": {"command": "other-mcp"},
        "pengvi": {
          "command": "/Users/u/.nvm/node",
          "args": ["/Users/u/Desktop/Pengvi/packages/mcp/dist/index.js"]
        }
      },
      "numStartups": 42
    }"#).unwrap();
    let result = write_claude_desktop_mcp_config_at(
        &cfg,
        Path::new("/Users/u/.penguin/mcp/node"),
        Path::new("/Users/u/.penguin/mcp/dist/index.js"),
    ).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert!(saved["mcpServers"].get("pengvi").is_none());
    assert_eq!(saved["mcpServers"]["other"]["command"], "other-mcp");
    assert_eq!(saved["numStartups"], 42);
    assert_eq!(result.removed_aliases, vec!["pengvi"]);
}

#[test]
fn claude_migration_preserves_ambiguous_pengvi() {
    let cfg = temp_config_path("claude-ambiguous").with_extension("json");
    fs::write(&cfg, r#"{
      "mcpServers": {
        "pengvi": {"command": "/opt/custom/bin/server", "args": ["serve"]}
      }
    }"#).unwrap();
    let result = write_claude_desktop_mcp_config_at(
        &cfg,
        Path::new("/Users/u/.penguin/mcp/node"),
        Path::new("/Users/u/.penguin/mcp/dist/index.js"),
    ).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(saved["mcpServers"]["pengvi"]["command"], "/opt/custom/bin/server");
    assert_eq!(result.ambiguous_aliases[0].name, "pengvi");
    assert_eq!(result.ambiguous_aliases[0].safe_to_migrate, false);
}
~~~

- [ ] **Step 2: Run Rust tests and confirm RED**

Run:

~~~bash
rtk cargo test --manifest-path src-tauri/Cargo.toml mcp::tests::claude_migration
~~~

Expected: compilation failure because the writer still returns `Result<(), String>` and does not expose migration fields.

- [ ] **Step 3: Implement ownership classification and safe removal**

Add:

~~~rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct CanonicalMigrationResult {
    canonical: &'static str,
    written: bool,
    removed_aliases: Vec<String>,
    ambiguous_aliases: Vec<LegacyAliasDiagnostic>,
    preserved_servers: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct LegacyAliasDiagnostic {
    name: String,
    classification: String,
    safe_to_migrate: bool,
    reason: String,
}

fn is_owned_penguin_target(command: &str, server: &str) -> bool {
    let normalized = format!("{command}\n{server}").to_ascii_lowercase();
    normalized.contains("/.penguin/")
        || normalized.contains("/.pengvi/")
        || normalized.contains("/pengvi/packages/mcp/")
        || normalized.contains("/penguin/packages/mcp/")
}
~~~

Before inserting canonical `penguin`, inspect `pengvi`. Remove it only when `is_owned_penguin_target` is true. Preserve and report every ambiguous entry. Apply the same rule to TOML.

- [ ] **Step 4: Run Rust tests and confirm GREEN**

Run:

~~~bash
rtk cargo test --manifest-path src-tauri/Cargo.toml mcp::tests
~~~

Expected: all MCP config/runtime tests pass.

- [ ] **Step 5: Add failing JS doctor tests**

Test same-target, same-surface, name-collision, and privacy:

~~~js
test("doctor classifies legacy pengvi without exposing unrelated config", async () => {
  const result = classifyMcpDuplicate(
    { name: "penguin", command: "/u/.penguin/mcp/node", server: "/u/.penguin/mcp/dist/index.js" },
    { name: "pengvi", command: "/old/node", server: "/work/Pengvi/packages/mcp/dist/index.js" },
    {
      penguin: { serverName: "penguin-mcp", tools: ["index_status", "knowledge_explore"] },
      pengvi: { serverName: "penguin-mcp", tools: ["knowledge_explore", "index_status"] },
    },
  );
  assert.equal(result.classification, "legacy_alias_same_surface");
  assert.equal(result.safeToMigrate, true);
  assert.doesNotMatch(JSON.stringify(result), /token|headers|env/i);
});
~~~

- [ ] **Step 6: Run doctor test and confirm RED**

Run:

~~~bash
rtk test node --test tests/knowledge-runtime-doctor.test.mjs
~~~

Expected: import failure because `classifyMcpDuplicate` does not exist.

- [ ] **Step 7: Implement doctor classification**

Export a pure `classifyMcpDuplicate` that:

- returns `legacy_alias_same_target` for identical normalized command/server;
- returns `legacy_alias_same_surface` for `penguin-mcp` plus equal sorted tool sets;
- returns `name_collision` when `pengvi` exists but ownership is not proven;
- returns `none` when no legacy entry exists.

Extend `main()` output with `duplicates` while retaining current `bundle` and `configuredCodex`.

- [ ] **Step 8: Run doctor tests and checkpoint**

Run:

~~~bash
rtk test node --test tests/knowledge-runtime-doctor.test.mjs
rtk git diff --check -- src-tauri/src/mcp.rs scripts/check-knowledge-runtime.mjs tests/knowledge-runtime-doctor.test.mjs
~~~

Expected: tests pass and diff check is clean.

---

### Task 2: Trustworthy empty-result diagnostics

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Test: `tests/knowledge-query.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`

**Interfaces:**

- Produces `QueryDiagnostics`.
- Adds `diagnostics` to `ExploreResult` and `GraphResult`; existing result fields remain unchanged.

- [ ] **Step 1: Add RED fixtures for no-match, no-static-edge, stale-only, and unresolved evidence**

~~~js
test("explore diagnostics distinguish no match from a resolved node with no edge", () => {
  const { store, helper } = seed();
  const missing = buildExplorePack(store, "does-not-exist");
  assert.equal(missing.diagnostics.resolutionStatus, "no_match");
  assert.equal(missing.diagnostics.resultStatus, "query_error");

  const isolated = exploreGraph(store, "who_calls", helper);
  assert.equal(isolated.diagnostics.resolutionStatus, "resolved");
  assert.equal(isolated.diagnostics.resultStatus, "no_static_edge");
  assert.equal(isolated.diagnostics.target.resolvedNodeId, helper);
  assert.deepEqual(isolated.diagnostics.evidence.incomingByType, {});
  store.close();
});
~~~

Create a stale-only node and an unresolved `edge_refs` fixture, then assert `stale_target` and `unresolved_edges`.

- [ ] **Step 2: Run query test and confirm RED**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-query.test.mjs
~~~

Expected: assertions fail because `diagnostics` is absent.

- [ ] **Step 3: Add the shared diagnostic type and builder**

~~~ts
export interface QueryDiagnostics {
  resolutionStatus:
    | "resolved" | "no_match" | "ambiguous"
    | "stale_target" | "not_indexed" | "assembly_error";
  resultStatus:
    | "has_results" | "no_static_edge"
    | "unresolved_edges" | "query_error";
  target: {
    requested: string;
    resolvedNodeId: string | null;
    repo: string | null;
    branch: string | null;
  };
  freshness: {
    status: "fresh" | "dirty" | "stale" | "unknown";
    indexedCommit: string | null;
    headCommit: string | null;
    dirtyFileCount: number | null;
  } | null;
  evidence: {
    incomingByType: Record<string, number>;
    outgoingByType: Record<string, number>;
    unresolvedReferenceCount: number;
  };
  coverageGaps: string[];
}
~~~

Implement `buildQueryDiagnostics(store, requested, resolution, nodes)` using grouped edge counts and existing trust rows. Do not calculate invented coverage percentages.

- [ ] **Step 4: Attach diagnostics without breaking current shapes**

Attach diagnostics in `exploreGraph` and all `buildExplorePack` return paths, including ambiguity/error paths. MCP must return the shared objects unchanged.

- [ ] **Step 5: Run core and MCP tests GREEN**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-query.test.mjs tests/knowledge-mcp-tools.test.mjs
~~~

Expected: all selected tests pass.

- [ ] **Step 6: Diff checkpoint**

Run:

~~~bash
rtk git diff --check -- packages/knowledge-core/src/query.ts packages/knowledge-core/src/index.ts packages/mcp/src/knowledge-tools.ts tests/knowledge-query.test.mjs tests/knowledge-mcp-tools.test.mjs
~~~

Expected: clean.

---

### Task 3: Compact status with CLI/MCP parity

**Files:**

- Modify: `packages/knowledge-core/src/query.ts`
- Modify: `packages/knowledge-core/src/index.ts`
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `packages/mcp/src/knowledge-tools.ts`
- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Test: `tests/knowledge-query.test.mjs`
- Test: `tests/knowledge-cli.test.mjs`
- Test: `tests/knowledge-mcp-tools.test.mjs`

**Interfaces:**

- Produces `CompactIndexStatus` and `compactIndexStatus(store)`.
- CLI consumes `status --compact --json`.
- MCP consumes `index_status({ mode: "compact" })`.

- [ ] **Step 1: Write failing compact status tests**

~~~js
test("compact index status keeps one bounded row per repo", () => {
  const { store } = seed();
  const compact = compactIndexStatus(store);
  assert.deepEqual(Object.keys(compact.repos[0]).sort(), [
    "dirtyFileCount", "freshness", "headCommit", "indexErrorCount",
    "indexedCommit", "liveBranch", "parserVersion", "repo",
  ]);
  assert.equal(compact.summary.totalRepos, 1);
  store.close();
});
~~~

CLI and MCP tests must deep-equal the compact object from the same fixture.

- [ ] **Step 2: Run selected tests and confirm RED**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-query.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-mcp-tools.test.mjs
~~~

Expected: import/shape failures because compact mode is missing.

- [ ] **Step 3: Implement compact projection**

~~~ts
export interface CompactIndexStatus {
  summary: {
    totalRepos: number;
    fresh: number;
    dirty: number;
    stale: number;
    unknown: number;
    errors: number;
  };
  repos: CompactRepoStatus[];
}

export function compactIndexStatus(store: KnowledgeStore): CompactIndexStatus {
  const detailed = indexStatus(store);
  const repos = detailed.repos.map((repo) => {
    const live = repo.branches.find((branch) => branch.status === "live") ?? null;
    const trust = live?.trust ?? null;
    const errorRow = store.db.prepare(
      \`SELECT COUNT(*) AS n
         FROM files f JOIN branches b ON b.id=f.branch_id
        WHERE b.repo_id=? AND f.status='error'\`,
    ).get(repo.repoId) as { n: number };
    const freshness =
      trust === null ? "unknown"
      : trust.stale ? "stale"
      : trust.worktreeState === "dirty" ? "dirty"
      : trust.worktreeState === "unknown" ? "unknown"
      : "fresh";
    return {
      repo: repo.name,
      liveBranch: live?.name ?? null,
      freshness,
      dirtyFileCount: trust?.dirtyFiles.length ?? null,
      indexedCommit: trust?.indexedCommit ?? null,
      headCommit: trust?.headCommit ?? null,
      parserVersion: trust?.parserVersion ?? null,
      indexErrorCount: errorRow.n,
    } satisfies CompactRepoStatus;
  });
  return {
    summary: {
      totalRepos: repos.length,
      fresh: repos.filter((repo) => repo.freshness === "fresh").length,
      dirty: repos.filter((repo) => repo.freshness === "dirty").length,
      stale: repos.filter((repo) => repo.freshness === "stale").length,
      unknown: repos.filter((repo) => repo.freshness === "unknown").length,
      errors: repos.reduce((sum, repo) => sum + repo.indexErrorCount, 0),
    },
    repos,
  };
}
~~~

Use existing branch/worktree trust fields. A Git failure maps only that repo to `unknown`.

- [ ] **Step 4: Wire CLI and MCP**

- CLI detects `--compact` only for `status`.
- MCP `index_status` accepts `mode: "detailed" | "compact"` and defaults to detailed.
- MCP tool schema documents both modes.

- [ ] **Step 5: Run selected tests GREEN**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-query.test.mjs tests/knowledge-cli.test.mjs tests/knowledge-mcp-tools.test.mjs
~~~

Expected: selected tests pass and detailed status assertions remain unchanged.

---

### Task 4: Hero tool descriptions and managed guidance

**Files:**

- Modify: `packages/mcp/src/knowledge-tool-defs.ts`
- Modify: `packages/knowledge-indexer/src/agent-guidance.ts`
- Modify: `src-tauri/src/knowledge.rs`
- Test: `tests/knowledge-mcp-tools.test.mjs`
- Test: `tests/knowledge-indexer-pipeline.test.mjs`
- Test: Rust tests in `src-tauri/src/knowledge.rs`

**Interfaces:**

- Guidance order is `knowledge_explore` → narrow search/node/graph tools.
- Empty-result copy requires inspecting `diagnostics`.

- [ ] **Step 1: Add failing description/guidance assertions**

Assert:

~~~js
assert.match(exploreDef.description, /default|first|首选/i);
assert.match(exploreDef.description, /diagnostics/i);
assert.match(graphDef.description, /no_static_edge|diagnostics/i);
~~~

Rust guidance test must require `knowledge_explore` before `knowledge_search`.

- [ ] **Step 2: Verify RED**

Run:

~~~bash
rtk test node --test tests/knowledge-mcp-tools.test.mjs tests/knowledge-indexer-pipeline.test.mjs
rtk cargo test --manifest-path src-tauri/Cargo.toml knowledge::tests
~~~

Expected: guidance ordering/copy assertions fail.

- [ ] **Step 3: Update the three managed guidance sources**

Use the same concise rules:

~~~text
- Start code-understanding work with `knowledge_explore`.
- Use `knowledge_search` for exact symbol discovery, `get_node` for one source,
  and `explore_graph` for narrow traversal/debugging.
- Before claiming an empty caller/path result, inspect `diagnostics`.
~~~

The MCP description also documents bounded/truncated results and `nextQueryHint`.

- [ ] **Step 4: Verify GREEN and idempotence**

Run:

~~~bash
rtk test node --test tests/knowledge-mcp-tools.test.mjs tests/knowledge-indexer-pipeline.test.mjs
rtk cargo test --manifest-path src-tauri/Cargo.toml knowledge::tests
~~~

Expected: all selected tests pass; rerunning guidance reconciliation produces no write.

---

### Task 5: Capability-aware agent integration and opt-in bounded Claude Code hooks

**Files:**

- Create: `packages/knowledge-cli/src/claude-hook.ts`
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src/components/wiki/WikiPage.tsx`
- Test: `tests/knowledge-cli.test.mjs`
- Test: `tests/wiki-page.test.mjs`
- Test: Rust tests in `src-tauri/src/knowledge.rs`

**Interfaces:**

~~~ts
export interface ClaudeHookOptions {
  event: "session-start" | "user-prompt-submit";
  prompt?: string;
  timeoutMs?: number;
  maxChars?: number;
}

export function selectPromptTarget(prompt: string): string | null;
export function renderSessionStart(status: CompactIndexStatus, maxChars?: number): string;
export async function runClaudeHook(
  options: ClaudeHookOptions,
  deps: { runPenguin(args: string[], timeoutMs: number): Promise<unknown> },
): Promise<string>;
~~~

Extend `CliDeps` with `readStdin?: () => Promise<string>`. `bin.ts` supplies a
bounded stdin reader only for the `hook` verb. For `UserPromptSubmit`, parse
Claude's stdin JSON and pass only its string `prompt` field to `runClaudeHook`;
malformed or oversized input returns an empty hook response and exit code 0.

Tauri command:

~~~rust
knowledge_agent_hook_setup(
    session_start: bool,
    user_prompt_submit: bool,
) -> Result<HookSetupResult, String>
~~~

- [ ] **Step 1: Write RED unit tests for token selection, bounds, timeout, and no-op**

~~~js
test("prompt hook only queries explicit code targets and truncates output", async () => {
  assert.equal(selectPromptTarget("hello, summarize this idea"), null);
  assert.equal(
    selectPromptTarget("who calls BpAccountClosureService.closeAccount?"),
    "BpAccountClosureService.closeAccount",
  );
  const calls = [];
  const text = await runClaudeHook(
    { event: "user-prompt-submit", prompt: "check /api/player/register", maxChars: 80 },
    { runPenguin: async (args) => { calls.push(args); return { focus: { title: "register" } }; } },
  );
  assert.equal(calls.length, 1);
  assert.ok(text.length <= 80);
});
~~~

Also assert SessionStart invokes only `status --compact --json`, timeout returns bounded unavailable text, and no prompt is persisted.

- [ ] **Step 2: Verify hook RED**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-cli.test.mjs
~~~

Expected: module/functions do not exist.

- [ ] **Step 3: Implement minimal hook renderer**

- Extract only explicit dotted symbols, route-like `/...`, `grpc::...`, or source filenames.
- SessionStart: 800ms default, 900 characters.
- UserPromptSubmit: 1200ms default, 1800 characters.
- Use a timeout race and return an unavailable marker on timeout.
- Never call index/write verbs.

- [ ] **Step 4: Add RED managed-config tests**

Temporary `~/.claude/settings.json` fixtures must prove:

- session hook can be installed alone;
- prompt hook is separately opt-in;
- unrelated hooks/unknown fields survive;
- disable removes only Penguin-managed command entries;
- repeated setup is idempotent.

- [ ] **Step 5: Implement managed hook config**

Use Claude's existing nested event-group shape with an exact managed marker
argument. SessionStart adds:

~~~json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "penguin hook session-start --managed-by=penguin"
    }
  ]
}
~~~

UserPromptSubmit adds:

~~~json
{
  "hooks": [
    {
      "type": "command",
      "command": "penguin hook user-prompt-submit --managed-by=penguin"
    }
  ]
}
~~~

Preserve all other hook arrays. Invalid JSON returns before any write. Register the Tauri command and typed client wrapper.

- [ ] **Step 6: Add the explicit UI opt-in**

In Wiki onboarding, keep both toggles unchecked by default:

- `SessionStart compact status`
- `UserPromptSubmit bounded context`

Call hook setup only after the user selects at least one. Show written/skipped status separately from MCP/guidance status.

- [ ] **Step 7: Verify hook/UI GREEN**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk test node --test tests/knowledge-cli.test.mjs tests/wiki-page.test.mjs
rtk cargo test --manifest-path src-tauri/Cargo.toml knowledge::tests
rtk npm run typecheck
~~~

Expected: all selected tests and typecheck pass.

---

### Task 6: Real Claude debug golden evaluation

**Files:**

- Modify: `scripts/knowledge-real-repo-benchmark.mjs`
- Modify: `tests/knowledge-real-repo-benchmark.test.mjs`

**Interfaces:**

- Adds `CLAUDE_DEBUG_CASES`.
- Produces a separate summary so future RED features are never counted as current success.

- [ ] **Step 1: Add failing summary tests**

~~~js
test("Claude debug gate requires every GREEN case and excludes future RED cases", () => {
  const summary = summarizeClaudeDebugCases([
    { id: "update-account-status-caller", passed: true, parity: true },
    { id: "auth-risk-close-account-flow", passed: true, parity: true },
    { id: "frontend-rg-handler", passed: true, parity: true },
    { id: "close-account-search-quality", passed: true, parity: true },
  ]);
  assert.deepEqual(summary, {
    expected: 4,
    passedCases: 4,
    parityFailures: 0,
    passed: true,
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run:

~~~bash
rtk test node --test tests/knowledge-real-repo-benchmark.test.mjs
~~~

Expected: missing export/function.

- [ ] **Step 3: Implement four fixed GREEN cases**

Add exact assertions:

1. caller query contains `BpAccountClosureService.closeAccount`;
2. path includes Auth client, Risk endpoint, and Risk handler in order;
3. frontend RG endpoint reaches Auth controller handler;
4. `closeAccount` search has no duplicate identity and every symbol hit has snippet.

Keep field writes, Mongo collection, and log literal cases in a printed `futureAcceptance` section only; do not score them.

- [ ] **Step 4: Verify unit and live real benchmark**

Run:

~~~bash
rtk test node --test tests/knowledge-real-repo-benchmark.test.mjs
rtk npm run knowledge:benchmark:real
~~~

Expected: four Claude debug cases pass with CLI/MCP parity; the existing 415 shadow queries and Auth mappings remain green.

---

### Task 7: Installed runtime, full verification, and report update

**Files:**

- Modify: `.codex/penguin-wiki-optimization-review.md`
- Modify: `.codex/penguin-replacement-validation-and-fix.md`
- Generated/synced: `packages/mcp/bundle/**` and `~/.penguin/mcp/**` through existing scripts only

**Interfaces:**

- No new API; this task proves the integrated result.

- [ ] **Step 1: Run all knowledge and Connect RPC tests**

Run:

~~~bash
rtk test node --test tests/knowledge-*.test.mjs
rtk test node --test tests/connect-rpc-client.test.mjs
~~~

Expected: zero failures.

- [ ] **Step 2: Build and typecheck**

Run:

~~~bash
rtk npm run typecheck
rtk npm run knowledge:bundle
~~~

Expected: both exit 0.

- [ ] **Step 3: Refresh vendored and installed MCP using the verified bundle**

Run:

~~~bash
rtk npm run knowledge:bundle
rtk proxy rsync -a --delete packages/mcp/bundle/ /Users/shieng/.penguin/mcp/
rtk npm run knowledge:doctor
~~~

Expected:

- `healthy: true`;
- configured canonical server is `penguin-mcp`;
- Node 22/native ABI match;
- duplicate classification is `none`;
- 30 expected tools remain exposed.

- [ ] **Step 4: Run synthetic, real, and boundary gates**

Run:

~~~bash
rtk npm run knowledge:benchmark
rtk npm run knowledge:benchmark:real
rtk proxy node scripts/knowledge-projects-boundary-audit.mjs
~~~

Expected:

- synthetic precision/recall remains 1;
- all 21 repos remain covered;
- real shadow parity failures and material misses remain 0;
- Claude debug GREEN cases are 4/4;
- boundary FP/FN remain 0.

- [ ] **Step 5: Verify canonical user config without printing unrelated settings**

Run:

~~~bash
rtk proxy node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("/Users/shieng/.claude.json","utf8"));const p=j.mcpServers?.penguin;console.log(JSON.stringify({penguin:!!p,pengvi:!!j.mcpServers?.pengvi,command:p?.command,args:p?.args},null,2))'
~~~

It must print only:

~~~json
{
  "penguin": true,
  "pengvi": false,
  "command": "/Users/shieng/.penguin/mcp/node",
  "args": ["/Users/shieng/.penguin/mcp/dist/index.js"]
}
~~~

Expected: exact canonical shape above.

- [ ] **Step 6: Update `.codex` reports with fresh evidence**

Record:

- canonical migration/duplicate doctor result;
- diagnostics cases;
- compact status size and parity;
- hook defaults and safety bounds;
- golden eval counts;
- full verification counts;
- remaining B tranche backlog.

- [ ] **Step 7: Refresh Graphify and final diff checks**

Run:

~~~bash
rtk graphify update .
rtk git diff --check
rtk git status --short
~~~

Expected: Graphify update exits 0, diff check is clean, and status contains only preserved pre-existing changes plus this plan's intended files.

---

## Completion Checklist

- [ ] Only canonical `penguin` is configured.
- [ ] Installer safely migrates proven legacy aliases and preserves ambiguous ones.
- [ ] Doctor detects target/surface duplicates without leaking unrelated config.
- [ ] Empty results carry resolution, result, freshness, evidence, and coverage-gap diagnostics.
- [ ] Detailed status remains compatible; compact CLI/MCP outputs match.
- [ ] `knowledge_explore` is the documented hero entry.
- [ ] Hooks are off by default, separately opt-in, bounded, and removable.
- [ ] Four Claude debug GREEN cases are permanent benchmark gates.
- [ ] Future field/Mongo/log cases remain explicitly RED and are not counted as success.
- [ ] Full tests, builds, installed doctor, benchmarks, boundary audit, and diff checks pass fresh.
