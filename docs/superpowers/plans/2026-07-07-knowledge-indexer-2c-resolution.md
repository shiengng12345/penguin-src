# Penguin Knowledge Plan 2c/5 — Reference Resolution + Rename→Alias Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand to full TDD before execution; 2d consumes the resolver + rename outputs.

**Goal:** Turn 2b's raw captures into resolved graph edges (`calls`/`imports`), and detect symbol renames to append `node_alias_added` to the Ledger. Pure logic over an in-memory symbol table + the store's query surface — deterministic, no watching.

**Architecture:** Add `src/resolve.ts` + `src/rename.ts` to `@penguin/knowledge-indexer`. Resolution is scope-ranked per §6.2: same-file → same-repo qualified-name → same-repo bare-name unique-hit. Unique hit → `origin=parser, method=EXTRACTED`; multi-candidate → best-effort `method=INFERRED, confidence<1`; no hit → no edge (unresolved code refs are dropped, unlike unresolved wikilinks which keep `raw_target` — that's §5/Plan 3). Rename detection compares the prior file's symbols (from `symbol_versions`) against the new extraction: symbol disappeared + new symbol appeared + `content_hash` equal → rename → `recordKnowledge({type:"node_alias_added"})` (Ledger-first, §2.2.4 boundary) — NOT a direct SQL write.

**Tech Stack:** TypeScript · knowledge-core (`KnowledgeStore`) · node:test

**Depends on:** 2b (`ExtractedFile`, `ExtractedRef`, `ExtractedSymbol`); 2a (`resolveIdentity`, `upsertNode`, `getSymbolVersion`, `recordKnowledge`).

## Global Constraints (additions)

- **Every edge must be explainable (§6.2.3):** dynamic dispatch / reflection-style calls are NOT force-resolved — no hit = no edge. Bias to precision.
- Call/import edges are parser-derived → written via 2d's per-file txn using `replaceFileEdges` (this plan produces the resolved `ParsedEdge[]`, does not write them).
- Rename→alias is non-rebuildable → MUST go through `recordKnowledge()` (Ledger), never direct SQL. This is the one Ledger write in the indexer.
- Resolution scope is **same-branch** (§6.2.2): candidates come from the branch being indexed.

## File Structure

- `src/resolve.ts` — `resolveRefs(...)`, `resolveImports(...)`
- `src/rename.ts` — `detectRenames(...)`
- Consumes a lightweight symbol-lookup interface backed by `KnowledgeStore` (define `SymbolIndex` shape so it's unit-testable with a fake).

## Interfaces this plan PRODUCES (consumed by 2d)

```ts
// A resolved edge ready for KnowledgeStore.replaceFileEdges (ParsedEdge from Plan 1).
interface ResolvedEdges {
  edges: ParsedEdge[];             // src=node id, dst=node id|null, edgeType calls|imports, origin:"parser"
  unresolved: number;              // count dropped (no hit) — for staleness/telemetry
}
function resolveRefs(input: {
  refs: ExtractedRef[];
  fileSymbolIds: Map<string, string>;   // qualifiedName → nodeId for THIS file
  lookup: SymbolIndex;                   // same-repo/branch resolution backend
  branchId: string;
}): ResolvedEdges;

interface RenameDetection {
  aliasEvents: Array<{ nodeId: string; aliasKey: string; reason: "rename" }>; // → recordKnowledge by caller
}
function detectRenames(input: {
  disappeared: ExtractedSymbol[];  // in prior version, gone now
  appeared: ExtractedSymbol[];     // new now
}): RenameDetection;

interface SymbolIndex {
  byQualifiedName(repoId: string, branchId: string, qn: string): string | null;   // → nodeId
  bareNameCandidates(repoId: string, branchId: string, bare: string): string[];   // → nodeIds
}
```

## Tasks (ordered)

1. **Same-file resolution.** A call whose name matches a symbol defined in the same file → edge to that node, EXTRACTED. Test focus: two funcs in one file, one calls the other → one `calls` edge, method EXTRACTED. Spec §6.2.2 (tier 1).
2. **Same-repo qualified-name resolution.** Call with a qualified name resolving uniquely in-repo/branch → EXTRACTED edge. Test focus: `Svc.foo()` cross-file unique → edge. Spec §6.2.2 (tier 2).
3. **Bare-name: unique hit vs multi-candidate.** Unique bare hit → EXTRACTED; multiple candidates → INFERRED with `confidence<1` (best pick) or no edge if ambiguous-and-not-rankable. Test focus: unique bare → EXTRACTED; two candidates → INFERRED conf<1; unknown → no edge. Spec §6.2.2 (tier 3), §6.2.3.
4. **Import edges.** `fileImports` → `imports` edges (file→file where resolvable). Test focus: `import './a'` → imports edge; unresolvable external → dropped (or file node kept per §9 grammar-missing — but here just drop non-repo). Spec §6.2.1.
5. **Rename detection.** disappeared+appeared+equal `content_hash` → one alias event; unequal hash → none; multiple equal-hash candidates → none (ambiguous, no auto-merge per §9 alias row). Test focus: rename fixture → one alias event; unrelated add/remove → zero. Spec §6.3 (rename step), §9 (low-confidence merge must not auto-execute).
6. **Explainability guard (no over-resolution).** A dynamic/computed call name (no static match) → no edge, counted in `unresolved`. Test focus: `obj[dynamic]()` style raw ref with no candidate → dropped, `unresolved` incremented. Spec §6.2.3.

## Spec coverage: §6.2 (all tiers), §6.2.3 (precision), §6.3 rename step, §9 alias-safety. Out of scope: writing edges/aliases to DB (2d orchestrates: `replaceFileEdges` for edges, `recordKnowledge` for aliases), note wikilinks (Plan 3).
