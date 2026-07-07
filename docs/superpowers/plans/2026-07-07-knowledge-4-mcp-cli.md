# Penguin Knowledge Plan 4/5 — MCP Tools + CLI Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution. First user/AI-visible surface. Detailed per-command spec already exists in `requirements/cli-commands.md`.

**Goal:** Expose the knowledge graph through two thin entry points sharing one query/write implementation: the **6-pack MCP tools** (extend `@penguin/mcp`) and the **`penguin` CLI** (new `@penguin/knowledge-cli`). Both call `knowledge-core`'s query layer (same semantics) and route writes through `recordKnowledge()` (§2.2). Also implements the query layer itself (`explore_graph` traversals, `knowledge_search` unified retrieval) that both front-ends and Plan 5 UI consume.

**Architecture:** Add a query module to `@penguin/knowledge-core` (`src/query.ts`: `search`, `getNodeDetail`, `exploreGraph`, `compareBranches`, `indexStatus`) — the single implementation. `@penguin/mcp` gets 6 tool handlers that are thin adapters over it (results carry `origin/method/confidence/staleness/branch/commit`). `@penguin/knowledge-cli` (bin `penguin`) is a thin arg-parser → same query layer + one-shot index (reuses 2d `indexRepo`). CLI's `--json` is a stable contract. No CLI daemon (§8.3).

**Tech Stack:** TypeScript · `@modelcontextprotocol/sdk` (existing in mcp) · knowledge-core query layer + 2d indexer · node:test · Tauri resource bundling (existing sidecar/CLI distribution)

**Depends on:** all of 2* (store + indexer + watch) and 3 (fusion/credentials/trust). Query layer needs symbols, notes, edges, events populated.

## Global Constraints (additions)

- **Tools少而强 (§8):** 6 wide tools, not 30 narrow ones; prefer mode/param over new tool. V1 set is fixed below; do not add tools without usage data.
- Every result: `origin/method/confidence/staleness/branch/commit` where applicable (§8, §3.3); `--json` fields are a stable, versioned contract (§8.3 invariant 5).
- **CLI 6 invariants (§8.3):** thin shell (no independent search/index/business logic); CLI==MCP==UI query semantics (one impl); no daemon; writes Ledger-first; `--json` stable; V1 verb set only (not graph.md's 115 commands).
- `write_note` deliberately narrow (§8.1): actions `create_page|append_note|link_pages` only; link is part of the note-writing workflow, never a general graph-mutation API. AI writes: drafts only, append-only, never touch sensitive pages.
- Sensitive/`mcp_access=denied` → excluded from MCP results, placeholder only (§5, §8.1).
- Read verbs never write Ledger / need no ledger lock; write verbs may take ledger/index-task/SQLite/FS locks (§8.3 read-write split). Index task lock wait/skip policy: default wait (stderr who), `--no-wait` → exit code 4 (§8.3, cli-commands.md).
- CLI can't find `knowledge.db` → prompt `penguin init`; read verbs never auto-create a half-baked DB (§9).

## File Structure

- `packages/knowledge-core/src/query.ts` — `search`, `getNodeDetail`, `exploreGraph(mode,…)`, `compareBranches`, `indexStatus`
- `packages/mcp/src/knowledge-tools.ts` — 6 tool handlers + registration into existing MCP server
- `packages/knowledge-cli/` — new package, `bin/penguin`, `src/cli.ts`, per-verb modules, `--json` formatter
- `src-tauri` — bundle CLI as resource + `penguin install` symlink wiring (reuse MCP distribution)
- `tests/knowledge-query-*.test.mjs`, `tests/knowledge-mcp-tools.test.mjs`, `tests/knowledge-cli-*.test.mjs`

## Interfaces this plan PRODUCES (consumed by Plan 5 UI)

```ts
// knowledge-core/query.ts — the single query implementation
function search(store, q: string, filters?: { workspace?; repo?; type?; branch?; includeSensitive? }): SearchResult[];
function getNodeDetail(store, idOrKey: string): NodeDetail;      // versions|body(respects mcp_access)|aliases
type GraphMode = "who_calls"|"calls_of"|"impact"|"backlinks"|"path"|"timeline"|"recent_changes";
function exploreGraph(store, mode: GraphMode, node: string, options?: { branch?; workspace?; depth?; limit? }): GraphResult;
function compareBranches(store, symbol: string, a: string, b: string): BranchDiff;
function indexStatus(store): IndexStatus;   // repos/branches/workspaces + staleness (answers list_repos/list_branches)
// every result object carries provenance/staleness fields per §8/§3.3
```

## Tasks (ordered)

1. **Query layer: `search`.** Title→FTS→graph-neighbor unified retrieval, mixed note/symbol/entity, sensitive excluded, filters (workspace/repo/type/branch). Test focus: seeded graph → query returns mixed hits, sensitive excluded, filters narrow. Spec §8.1 knowledge_search.
2. **Query layer: `getNodeDetail`.** Node + version list (symbol) or body (note, respects mcp_access) + alias history. Test focus: symbol → versions; note → body honoring mcp_access; aliases listed. Spec §8.1 get_node.
3. **Query layer: `exploreGraph` modes.** who_calls/calls_of/impact/backlinks/path + timeline/recent_changes (query events table). Test focus: one assertion per mode on a seeded graph; depth/limit honored. Spec §8.1 explore_graph.
4. **Query layer: `compareBranches` + `indexStatus`.** Cross-branch symbol diff (equal hash → "no diff" fast path); index status/staleness/lists. Test focus: same symbol two branches equal/differing hash; index_status shape. Spec §8.1 compare_branches/index_status.
5. **MCP 6-pack handlers.** Register `knowledge_search`/`get_node`/`explore_graph`/`compare_branches`/`write_note`/`index_status` as thin adapters; results carry provenance/staleness; `write_note` Ledger-first + narrow actions + sensitive-page refusal. Test focus: each tool returns adapter of query layer; write_note create/append/link go through recordKnowledge; denied on sensitive. Spec §8.1, §2.2.
6. **CLI scaffold + read verbs.** `@penguin/knowledge-cli`, bin `penguin`; read verbs search/node/callers/calls/impact/backlinks/path/recent/compare/status over the query layer; `--json` stable + `--branch`; can't-find-db prompt. Test focus: `penguin search --json` structured contract; read verb == MCP semantics; no-db → prompt, exit code, no DB created. Spec §8.3 verbs + invariants + §9.
7. **CLI write + system verbs.** `init`/`index`/`rebuild` (one-shot, reuse 2d `indexRepo`; index-task-lock wait/`--no-wait` exit 4), `note new|append|link` (Ledger-first via write path), `doctor`(+`--verify` full-hash), `install`, `help`. Test focus: `init` registers repo+first index; `index` incremental; `note` appends ledger; `doctor --verify` full-hash catches mtime-trap; lock contention → wait/exit-4. Spec §8.3 lifecycle + concurrency, §9 (mtime-trap, lock, index≠watcher).
8. **Distribution wiring.** Bundle CLI as Tauri resource; `penguin install` symlinks to PATH + confirms MCP wired (reuse MCP mechanism). Test focus (where feasible): install path resolution; help lists V1 verbs only. Spec §8.3 分发.

## Spec coverage: §8 (all — 6-pack MCP, CLI verb set + invariants + concurrency + distribution + read/write split), §3.3 provenance in results, §9 (CLI error rows), plus `requirements/cli-commands.md` per-command spec. Out of scope: Wiki UI (Plan 5), V2 tools (suggest/accept/reject).
