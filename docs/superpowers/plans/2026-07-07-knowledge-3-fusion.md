# Penguin Knowledge Plan 3/5 — Fusion (note↔code) + Trust + Credentials Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution. Depends on the indexer producing symbols (2c) and parsed notes (2e).

**Goal:** Wire notes into the graph: resolve `[[wikilink]]`/entity captures (from 2e) to real nodes with the priority note-title → symbol → entity, create `wikilink`/`entity_mention`/`frontmatter_rel` edges (with auto-backfill when the target appears later), surface ambiguity instead of guessing, and add the `credential_entries` table (bodies never in .md/FTS/MCP, §5 C-案). Also lock the provenance/trust model (§3.3) at query time.

**Architecture:** Fusion logic lives partly in `@penguin/knowledge-indexer` (`src/fusion.ts` — resolve captures → edges, called from the note-index txn) and partly in `@penguin/knowledge-core` (the `credential_entries` table + a small credential API; unresolved-link backfill query). Link resolution reuses `KnowledgeStore.resolveIdentity` + a title/entity lookup. Unresolved link → `dst=NULL, raw_target` kept; when a matching node is later created, a backfill pass links it (§5). Ambiguity (one name, many hits) → store candidates, do not auto-pick.

**Tech Stack:** TypeScript · knowledge-core + knowledge-indexer · node:test

**Depends on:** 2c (symbol nodes + `resolveIdentity`), 2e (`ParsedNote` wikilinks/entities), 2a (edges via a note-edge writer — note edges have `branch_id=NULL`, `origin` note-source).

## Global Constraints (additions)

- Resolution priority (§5): **note title → symbol name → entity**. Namespace-forced forms (`api:`,`repo:`,`trace:`) bypass priority and target that kind directly.
- Unresolved wikilink keeps `raw_target` (unlike code refs which drop) and auto-links when target appears (§5). Backfill must be deterministic + idempotent.
- One-name-many-hits → store candidates + mark ambiguous in node meta / edge; UI shows ambiguity; never guess (§5).
- Sensitive/`mcp_access=denied` pages: excluded from MCP results, return only a "存在一个敏感关联页" placeholder (§5) — enforced in the search/MCP layer (Plan 4), flags set in 2e.
- **Credentials (§5 C-案, 2026-07-07):** credential bodies live in `credential_entries` (SQLite, Postman-style, like existing REST creds — no OS keychain, no encryption). Graph has a `node_type=credential` node (title + safety meta only); body is app-only, never FTS/MCP/AI, never synced to wiki. Mirrors the project's existing plaintext-SQLite credential stance.
- Note↔note / note↔symbol / note↔entity edges are created here, but AI-initiated linking stays behind `write_note`'s deliberate narrowing (Plan 4) — this plan is the parser/fusion side.

## File Structure

- `packages/knowledge-indexer/src/fusion.ts` — `resolveNoteLinks(...)`, `backfillUnresolved(...)`, `resolveEntities(...)`
- `packages/knowledge-core/src/schema.ts` — add `credential_entries` table (schema v3)
- `packages/knowledge-core/src/store.ts` — `putCredential`/`getCredential`/`listCredentialMeta` + a note-edge writer `replaceNoteEdges(nodeId, edges)` and `linkUnresolvedTargets(identityKey|title)`
- `tests/knowledge-fusion-*.test.mjs`, `tests/knowledge-core-credentials.test.mjs`

## Interfaces this plan PRODUCES (consumed by Plan 4)

```ts
function resolveNoteLinks(input: {
  store: KnowledgeStore; noteNodeId: string; parsed: ParsedNote; repoId: string | null;
}): { linked: number; unresolved: number; ambiguous: number };

// credential_entries (core)
interface CredentialMeta { nodeId: string; title: string; kind: string; createdAt: string }
KnowledgeStore.putCredential(p: { nodeId: string; title: string; kind: string; body: string }): void; // body app-only
KnowledgeStore.getCredential(nodeId: string): { title: string; kind: string; body: string } | null;   // never via MCP/FTS
KnowledgeStore.listCredentialMeta(): CredentialMeta[];                                                  // meta only, no body
```

## Tasks (ordered)

1. **Title resolution + wikilink edge.** `[[Some Note Title]]` → note node by title → `wikilink` edge. Test focus: note A links `[[B]]`, B exists → edge A→B, edgeType wikilink, dst set. Spec §5.
2. **Priority ladder title→symbol→entity.** Ambiguity-free name resolves in priority order; namespace form targets its kind. Test focus: `[[GetLoginURL]]` (no note, is a symbol) → symbol edge; `[[api:Svc.M]]` → symbol directly; `[[playerId]]` → entity. Spec §5.
3. **Unresolved + backfill.** `[[NotYet]]` → `dst=NULL, raw_target="NotYet"`; later create note "NotYet" → backfill links it. Test focus: unresolved edge kept; after target created + `linkUnresolvedTargets` → dst populated, idempotent on re-run. Spec §5.
4. **Ambiguity (no guessing).** Name matching multiple nodes → candidates stored, edge marked ambiguous, dst not auto-set. Test focus: two notes titled "Login" + a `[[Login]]` → ambiguous marker, no silent pick. Spec §5.
5. **Entity mention edges.** 2e entities → `entity` nodes (upsert by normalized value) + `entity_mention` edges. Test focus: note with `trace:3d0e…` → entity node + mention edge; dedupe across notes. Spec §5.
6. **`credential_entries` table + API (schema v3).** Add table; `putCredential`/`getCredential`/`listCredentialMeta`; graph credential node holds title+meta only. Test focus: body stored/retrieved via store API but NOT in FTS (`searchText` never returns it) and NOT in `listCredentialMeta`'s payload; node exists with node_type=credential. Spec §5 C-案, §3.2.
7. **Trust/provenance surfacing.** Query helper returns `origin/method/confidence` per edge/node so callers (Plan 4) render trust; verify EXTRACTED vs INFERRED vs ASSERTED distinguishable end-to-end. Test focus: mixed-origin edges → helper reports correct provenance triples. Spec §3.3.

## Spec coverage: §5 (fusion: priority, unresolved/backfill, ambiguity, entities, sensitive placeholder flags, credentials C-案), §3.3 (trust model surfacing). Out of scope: MCP/CLI exposure of these (Plan 4), UI (Plan 5).
