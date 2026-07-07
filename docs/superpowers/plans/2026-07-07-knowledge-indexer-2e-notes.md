# Penguin Knowledge Plan 2e/5 — Note Indexing Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution. Independent of 2c/2d (parallelizable after 2b); Plan 3 (fusion) consumes the parsed wikilinks/entities.

**Goal:** Parse a Markdown note into the store: frontmatter (yaml), `[[wikilink]]`, `#tag`, entity regexes, and heading structure — creating/updating the note `node`, `notes_index` row, and FTS text. Wikilinks/entities are **captured** here; resolving them to `dst` node ids is Plan 3 (fusion). Note identity is frontmatter `id` (uuid) first, else path (Obsidian-compatible).

**Architecture:** Add `src/notes.ts` to `@penguin/knowledge-indexer`. `parseNote(source)` → structured `ParsedNote`; `indexNote(store, ...)` upserts the note node (identity = frontmatter id or path), writes `notes_index` (sensitive/mcp_access from frontmatter), updates FTS via `indexNoteText`, and emits raw wikilink/tag/entity captures for Plan 3. Note moves/renames don't break links because identity is the frontmatter uuid (path change ≠ new node).

**Tech Stack:** TypeScript · a yaml parser (prefer a tiny dependency or hand-rolled frontmatter split — decide at Task 1, YAGNI) · knowledge-core · node:test

**Depends on:** 2a (`upsertNode`, `indexNoteText`, `getNode`), 2b (package exists). No dependency on 2c/2d.

## Global Constraints (additions)

- Note identity precedence: frontmatter `id` (uuid) → else wiki-relative path (§6.4). Path change with same id must NOT create a new node.
- `sensitive=1` or `mcp_access=denied` notes: still indexed (node + notes_index), but Plan 3/§5 excludes them from MCP results. This plan sets the flags from frontmatter; enforcement is search-side (already in `searchText`, Plan 1).
- Credentials (§5 C-案): credential note **bodies never land in .md / FTS / MCP** — handled in Plan 3 (`credential_entries` table). This plan treats a note flagged credential as body-less for FTS (title/meta only). (If credential handling isn't ready, a credential-flagged note is simply not FTS-indexed — safe default.)
- Entity extraction is regex, zero LLM (§5): trace_id, reqid, playerId, proposalId, API method, config key, repo/file path, env name.

## File Structure

- `src/notes.ts` — `parseNote(...)`, `indexNote(...)`, `extractEntities(...)`
- `tests/knowledge-indexer-notes-*.test.mjs`

## Interfaces this plan PRODUCES (consumed by Plan 3)

```ts
interface ParsedNote {
  identityKey: string;             // frontmatter id or path
  title: string;                   // first H1 or frontmatter title or filename
  frontmatter: Record<string, unknown>;
  sensitive: boolean;
  mcpAccess: "allowed" | "denied";
  isCredential: boolean;
  body: string;                    // markdown minus frontmatter (for FTS)
  wikilinks: Array<{ rawTarget: string; namespace: string | null }>; // [[x]] / [[api:X]]
  tags: string[];                  // #tag
  entities: Array<{ entityType: string; value: string; normalizedValue: string }>;
  headings: Array<{ level: number; text: string }>;
  contentHash: string;
}
function parseNote(input: { path: string; source: string }): ParsedNote;
function indexNote(input: { store: KnowledgeStore; repoRelPath: string; parsed: ParsedNote }): { nodeId: string };
function extractEntities(text: string): ParsedNote["entities"];
```

## Tasks (ordered)

1. **Frontmatter + identity + title.** Split `---` frontmatter (yaml), pick identity (id→path), title (frontmatter/H1/filename), sensitive/mcp_access/credential flags. Test focus: note with id → identity=id; without → path; sensitive+mcp_access parsed; title precedence. Spec §6.4, §3.2 notes_index.
2. **Wikilink + namespace capture.** `[[X]]`, `[[api:Svc.M]]`, `[[repo:r]]`, `[[trace:…]]` → `{rawTarget, namespace}`. Test focus: plain + each namespace form parsed; malformed `[[` ignored. Spec §5 (blueprint syntax).
3. **`#tag` + heading structure.** Extract tags and heading outline. Test focus: `#foo`/`#a/b` tags; H1–H3 outline; `#` inside code fence ignored. Spec §6.4.
4. **Entity regexes.** trace_id/reqid/playerId/proposalId/API method/config key/path/env → normalized entities, deduped. Test focus: a note body with several entity kinds → expected typed+normalized set; no false-positive on prose. Spec §5 entity extraction.
5. **`indexNote` writes node + notes_index + FTS.** Upsert note node (identity), notes_index row (flags/hash), FTS via `indexNoteText`; credential/sensitive handling (credential → no body in FTS). Test focus: index → searchable by title/body; sensitive excluded by default (reuse Plan 1 search test); credential note → not in FTS. Spec §6.4, §5 sensitive/credential, §3.2.
6. **Move/rename stability.** Same frontmatter id at a new path → same node id, notes_index.path updated, no duplicate. Test focus: index at path A, re-index same id at path B → one node, path=B. Spec §6.4.

## Spec coverage: §6.4 (note indexing), §5 (wikilink/tag/entity capture — resolution is Plan 3; sensitive/credential flags). Out of scope: resolving wikilinks to edges + credential_entries table (Plan 3), watching (2f).
