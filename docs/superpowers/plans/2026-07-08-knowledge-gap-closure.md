# Penguin Knowledge — §11 Gap-Closure Roadmap (Plans 6–9)

> Follow-up after re-reading `requirements/knowledge-design.md` §10/§11. The
> original 5-plan roadmap under-covered §11's "完整交付范围 = 上线门". These
> plans close the gap. Same discipline: TDD, committed increments, verified via
> typecheck + cargo check + vite build + tests. Merge to main only after all of
> §11 is delivered + end-to-end verified (user directive: 不完整不上线).

## Plan 6 — Ledger features (core + query + MCP + CLI)
Gap A1/A5/A2. Pure logic, testable inline.
- **AI suggestion flow (§8.2/§11):** `suggest_links` writes `origin=ai, method=INFERRED` edges to a pending queue (ledger event `ai_suggestion_created`); `accept`/`reject` write `ai_suggestion_accepted|rejected`. Trust filter: **unconfirmed AI assertions excluded from default search/graph** (only surfaced with an explicit includeSuggested flag). Materializer handles the 3 events; store gains listSuggestions/acceptSuggestion/rejectSuggestion; query layer + MCP + CLI expose them.
- **Similarity-rename queue (§6.3/§11):** detectRenames gains a similarity tier — near-but-not-equal body → emit a *suggested* rename (INFERRED, into the queue) instead of auto-alias. Exact-hash stays auto.
- **Snapshot manifest (§11):** `snapshot_create(name, nodeIds)` → ledger `snapshot_manifest_created`; `snapshot_list`. Pins a set of node+version ids to a named world-state.

## Plan 7 — Git objects in graph (indexer + core)
Gap A3. `commit` / `tag` nodes + `parent`/`tagged`/`merge` edges, read on demand from `.git` (no full history copy into SQLite, §11). Read loose + packed commit objects (zlib inflate) or shell `git log` as a bounded fallback; cap depth. Node identity `commit:<sha>` / `tag:<name>`.

## Plan 8 — Wiki full form (UI, build-verified)
Gap B6/B7/B8 + A4.
- File tree sidebar (Inbox/Cases/Knowledge/Repos/Credentials sections).
- CodeMirror 6 markdown editor (reuse app dep) + `[[]]`/`#` autocomplete (completion source over nodes/entities) + frontmatter panel + save via write_note.
- Local-graph canvas (1–2 hops, node cap, edge_type filter) — React canvas.
- **Timeline / recent_changes UI** (over exploreGraph timeline/recent_changes modes).

## Plan 9 — Completeness (CLI + grammars + workspaces + tests + packaging)
Gap C9/D10/D11/D12/D13.
- CLI verbs: `note new|append|link` (write_note path), `doctor` (+ `--verify` full-hash rescan, orphan-row check), `install` (PATH symlink logic固化).
- More tags queries: php, c, cpp, csharp, ruby (+ proto/sql when wasm bundled) → broaden 全语言.
- Workspaces API: create/list/add-repo + `--workspace` scope in query layer.
- §10 test gaps: two-branch fixture integration (versions双行 + compare), three-source rebuild, CLI --json schema-snapshot + exit-code matrix + lock wait/--no-wait, UI smoke.
- Release packaging: esbuild self-contained CLI + native better-sqlite3 / tree-sitter wasm bundling; Tauri resources + `penguin install`.

## Execution order
6 → 9(CLI verbs + grammars) → 7 → 8 → 9(rest) . Each committed; ledger tracked in `.superpowers/sdd/progress.md`.
