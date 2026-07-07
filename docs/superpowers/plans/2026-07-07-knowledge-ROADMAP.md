# Penguin Knowledge — Full Implementation Roadmap

**Spec:** `requirements/knowledge-design.md` v2.5 (brainstormed + approved).
**Branch:** `feature/knowledge-core` — merges to `main` ONLY when the whole feature is user-usable (user directive 2026-07-07). Each plan is committed on this branch; no interim release.

## Why plans are split this way

The spec is one large system spanning independent subsystems. Per writing-plans' scope rule, each plan produces working, testable software on its own and gets a fresh reviewer's gate. **Task-level TDD detail (exact signatures + code, like Plan 1 and Plan 2a) is written just-in-time before each plan executes**, because a downstream plan's signatures depend on the upstream plan's actual output types. The charters below lock scope, file structure, task ordering, and cross-plan interfaces so the sequence is fixed even before the code-level detail exists.

## Plan sequence

| Plan | Title | Delivers | New/changed packages | Depends on | Status |
|------|-------|----------|----------------------|------------|--------|
| 1/5 | Storage core | Ledger + SQLite + KnowledgeStore | `@penguin/knowledge-core` | — | ✅ done (42 tests) |
| 2a | Store extension | `files_index` table + repo/branch/symbol_versions/checkpoint APIs | knowledge-core | 1 | ✅ plan written (full TDD) |
| 2b | Symbol extraction | web-tree-sitter sidecar + `tags.scm` symbol extraction + qualified names | `@penguin/knowledge-indexer` (new) | 2a | charter |
| 2c | Reference resolution | call/import edges + rename→alias detection (Ledger) | knowledge-indexer | 2b | charter |
| 2d | Incremental pipeline | per-file txn + delete detect + `.git/HEAD` branch model + non-git degrade + restart reconcile | knowledge-indexer | 2a,2b,2c | charter |
| 2e | Note indexing | frontmatter/wikilink/#tag/entity/markdown structure | knowledge-indexer | 2a,2b | charter |
| 2f | Watch + wiring | chokidar debounce watcher + sidecar lifecycle in Tauri app | knowledge-indexer + `src-tauri` | 2d,2e | charter |
| 3/5 | Fusion | wikilink→node resolution (title→symbol→entity), entity mentions, ambiguity, trust model, credentials table | knowledge-core + knowledge-indexer | 2c,2e | charter |
| 4/5 | MCP + CLI | 6-pack MCP tools + `penguin` CLI (init/index/rebuild/search/…) | `@penguin/mcp` + `@penguin/knowledge-cli` (new) | 2*,3 | charter |
| 5/5 | Wiki UI | Tauri Wiki: icon rail, file tree, CodeMirror editor, context panel, local graph, search | `src/` (React) + `src-tauri` | 4 | charter |

## Merge gate

`feature/knowledge-core` → `main` after Plan 5 lands and the whole feature verifies end-to-end (index a real repo → search/graph in UI + MCP + CLI). Final whole-branch review before merge. No release until user confirms.

## Cross-plan invariants (every plan inherits)

- **§2.2 iron rule:** non-rebuildable knowledge only via `recordKnowledge()` (Ledger-first); parser-derived data via direct-SQL upserts. Never widen this.
- **D4:** core relational model uses no SQLite-proprietary features; FTS5 stays in `fts_*` + search methods.
- Node identity is branch-independent; only `symbol_versions` is branch-scoped (D6/D7).
- Every query result carries `origin/method/confidence/staleness/branch/commit` where applicable (§8, §3.3).
- New native deps only when unavoidable, added to root `pnpm.onlyBuiltDependencies`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Per-plan charter files

- `2026-07-07-knowledge-indexer-2a-store.md` (full TDD)
- `2026-07-07-knowledge-indexer-2b-extraction.md`
- `2026-07-07-knowledge-indexer-2c-resolution.md`
- `2026-07-07-knowledge-indexer-2d-pipeline.md`
- `2026-07-07-knowledge-indexer-2e-notes.md`
- `2026-07-07-knowledge-indexer-2f-watch.md`
- `2026-07-07-knowledge-3-fusion.md`
- `2026-07-07-knowledge-4-mcp-cli.md`
- `2026-07-07-knowledge-5-wiki-ui.md`
