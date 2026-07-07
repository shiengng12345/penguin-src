# Penguin Knowledge Plan 5/5 — Wiki UI Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution. Final plan; after it lands + whole-branch review + end-to-end verify, `feature/knowledge-core` merges to `main`.

**Goal:** The user-facing Wiki inside the Penguin Tauri app: an Icon Rail entry, a file-tree sidebar (Inbox/Cases/Knowledge/Repos/Credentials), a CodeMirror-6 Markdown editor with `[[]]`/`#` autocomplete, a right context panel (properties/backlinks/related/entities/linked symbols), a local (neighbor) graph view, and unified search with `type:`/`tag:`/`repo:`/`entity:` filters. Read-first: users mostly browse/search; editing is a revision tool, not a Notion clone (§7).

**Architecture:** React in `src/` (reuse existing app shell, CodeMirror 6, Zustand, Tailwind — same stack as REST/Docs modules). All data via the Tauri commands from Plan 4's query layer + Plan 2f's watcher events (no new query logic in the UI — it's a view over the same implementation). Local graph is a React canvas (1–2 hops, node cap, edge-type filter) — **no full-DB graph** (>5000 nodes kills the browser, graphify-proven). Editor writes go through the same Ledger-first note write path (via a Tauri command wrapping `write_note`/`recordKnowledge`).

**Tech Stack:** React 19 · TypeScript · CodeMirror 6 (existing dep) · TailwindCSS 4 · Zustand · Tauri commands/events (Plan 4 query + 2f watcher) · node:test for pure UI logic (source-assertion + logic units, matching existing app test style)

**Depends on:** Plan 4 (query commands + write_note), Plan 2f (watcher status/events). This is the top of the stack.

## Global Constraints (additions)

- Follow the existing app module pattern (Icon Rail + page + sidebar), mirroring `RestPage`/`ApiDocsPage`; reuse CodeMirror 6 (no block-editor library — §7).
- Editor completeness line (§7): standard Markdown + `[[]]`/`#` autocomplete + frontmatter panel + save indicator. **Slash-blocks explicitly NOT done.**
- Local graph only (1–2 hops, node cap, edge_type filter); never render the whole DB (§7).
- Sensitive/credential pages: sensitive default, locked visual marker, excluded from FTS/MCP; credential body app-only view (Plan 3). No encryption this pass (§7).
- New quick-capture goes to Inbox without forcing a folder choice; type changeable later (frontmatter + move, identity stable — §7).
- Access gating consistent with the app's existing dev-mode/token tiers (as other modules do) — decide exact tier at Task 1 (Wiki is likely token-gated like Vault).

## File Structure

- `src/components/wiki/WikiPage.tsx` — module shell (tree | editor | context panel)
- `src/components/wiki/WikiTree.tsx` — sectioned file tree (Inbox/Cases/Knowledge/Repos/Credentials)
- `src/components/wiki/NoteEditor.tsx` — CodeMirror 6 markdown + `[[]]`/`#` autocomplete + frontmatter panel + save state
- `src/components/wiki/ContextPanel.tsx` — properties/backlinks/related/entities/linked-symbols (with branch version status)
- `src/components/wiki/LocalGraph.tsx` — neighbor graph canvas
- `src/components/wiki/WikiSearch.tsx` — search box + `type:`/`tag:`/`repo:`/`entity:` filter parsing
- `src/lib/knowledge-client.ts` — typed wrappers over Plan 4 Tauri commands + 2f events
- `src/components/layout/MainSidebar.tsx` — add Wiki icon-rail entry (modify)
- `tests/wiki-*.test.mjs`

## Interfaces this plan CONSUMES (from Plan 4 / 2f)

`search`, `getNodeDetail`, `exploreGraph(mode,…)`, `compareBranches`, `indexStatus` (Tauri commands); `write_note` command; `knowledge_index_status`/`knowledge:index-progress` (2f). UI adds no query logic.

## Tasks (ordered)

1. **Icon Rail entry + module shell + client wrappers.** Wiki entry in `MainSidebar`; `WikiPage` 3-pane scaffold; `knowledge-client.ts` typed command wrappers. Test focus: rail entry gated correctly; client wrappers call the right commands (source/logic assertions). Spec §7 layout.
2. **File tree (sections).** Sectioned tree from `indexStatus`/node listing; select → open note. Test focus: sections render Inbox/Cases/Knowledge/Repos/Credentials; credential section shows locked markers. Spec §7 layout, §5 sensitive.
3. **Note editor (read + save).** CodeMirror 6 markdown, load node body (respects access), save via `write_note` (Ledger-first), save indicator. Test focus: load/edit/save round-trip goes through the write command; sensitive/credential body handling. Spec §7 editor, §2.2.
4. **`[[]]` + `#` autocomplete + frontmatter panel.** Autocomplete over notes+symbols+entities; `#tag` complete; frontmatter attribute panel. Test focus: completion source queries the graph; frontmatter edits persist. Spec §7 editor (completeness line).
5. **Context panel.** Properties | backlinks | related | entity mentions | linked symbols (with current-branch version status via `exploreGraph`/`getNodeDetail`). Test focus: backlinks/related/linked-symbols populated from query layer; branch version status shown. Spec §7 context panel, §4.4 staleness.
6. **Local graph view.** Neighbor graph (1–2 hops, node cap, edge_type filter), React canvas, centered on current node. Test focus: graph limited to cap + hop depth; edge-type filter works; never fetches full DB. Spec §7 local graph.
7. **Search + filter syntax.** Search box → `search` with `type:`/`tag:`/`repo:`/`entity:` parsed into filters; sensitive excluded, unlock toggle. Test focus: filter-syntax parser → correct filter object; sensitive excluded by default, included on unlock. Spec §7 search, §5.
8. **Staleness surfacing + quick capture.** Live staleness banner from 2f events; quick-new → Inbox without folder choice, type changeable. Test focus: index-progress event → banner; quick-create lands in Inbox with stable identity on later type change. Spec §7 capture, §9 index-in-progress.

## Merge-to-main gate (after this plan)

- Final whole-branch review (0d7d900..HEAD range at that point).
- End-to-end verify: `penguin init` a real repo → symbols/edges indexed → search + graph + node detail correct in UI **and** MCP **and** CLI (same semantics) → write a note via UI/AI → appears linked. Watcher live-updates on edit; branch switch reflects.
- Then merge `feature/knowledge-core` → `main`. Release only on user confirmation.

## Spec coverage: §7 (all: layout, editor, context panel, local graph, search, capture, credentials-area), consumes §8 query layer, surfaces §3.3/§4.4 provenance+staleness. Out of scope: full-DB graph (intentionally excluded), slash-blocks (excluded), encryption (excluded), V2 AI-suggestion UI.
