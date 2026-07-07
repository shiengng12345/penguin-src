# Penguin Knowledge Plan 2b/5 — Symbol Extraction (web-tree-sitter sidecar) Implementation Plan (Charter)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **STATUS: Charter** — expand each task to full bite-sized TDD (exact signatures + code, per Plan 2a) just before execution; the extraction output types this plan produces are the interface 2c/2d/2e consume, so they must be finalized here first.

**Goal:** Stand up `@penguin/knowledge-indexer` — a Node sidecar that loads web-tree-sitter WASM grammars and extracts symbols (definitions) from a single source file into a normalized `ExtractedSymbol[]`, with language-aware qualified-name building. Pure extraction: no DB writes, no reference resolution, no watching.

**Architecture:** New TS package `packages/knowledge-indexer`. `web-tree-sitter` loads per-language `.wasm` grammars from a bundled `grammars/` dir via a registry (`registry.ts` maps lang → wasm path + `tags.scm` query + scope-node names). One extraction pipeline (`extract.ts`) runs the official tree-sitter `tags.scm` query and walks scope nodes (class/impl/namespace/module) to build `qualified_name`. Output is a plain data structure the store layer (2a) and resolver (2c) consume — the sidecar in this plan is a **library**, exercised directly in node:test; its process/IPC shell is wired in 2f.

**Tech Stack:** TypeScript 5.7 (NodeNext ESM) · `web-tree-sitter` (WASM) · bundled tree-sitter grammar `.wasm` + `tags.scm` files · node:test

**Depends on:** 2a (for the `lang`/`kind`/qualified-name conventions the store expects; no code dependency, but the `ExtractedSymbol` shape must map cleanly onto `upsertNode` + `upsertSymbolVersion`).

## Global Constraints (additions to roadmap invariants)

- New package `@penguin/knowledge-indexer`, mirrors package conventions (ESM, tsc→dist, `.js` imports); add to root `build`/`typecheck` scripts.
- `web-tree-sitter` is the ONLY parsing dependency (WASM → no per-platform native build). Add to `pnpm.onlyBuiltDependencies` only if it ships native bits (it doesn't — pure WASM loader; confirm at Task 1).
- First-wave grammars (spec §6.1): TS/TSX/JS, Rust, Go, Java, PHP, Python, C, C++, C#, Ruby, Kotlin, Swift, proto, SQL, Bash, HTML, CSS, JSON, YAML. **Adding a language = one wasm + one registry row** — the pipeline must stay language-agnostic.
- Skips (§6.1): ignored dirs (`node_modules`/`target`/`dist`, honoring `.gitignore`) + files >1MB. (Dir/gitignore walking is 2d; here the extractor just accepts a size guard + a `lang` it's given.)
- `qualified_name` is `repo:<scoped.name>` per §3.2 (identity_key convention); scope assembly is per-language via registry scope-node names.

## File Structure

- `packages/knowledge-indexer/package.json`, `tsconfig.json`, `src/index.ts`
- `src/registry.ts` — `LANG_REGISTRY: Record<Lang, { wasm: string; tagsQuery: string; scopeNodes: string[]; commentNodes?: string[] }>`; `langForExtension(path): Lang | null`
- `src/grammars/` — bundled `.wasm` + `.scm` assets (checked in or fetched at build; Task decides)
- `src/parser.ts` — `loadParser(lang): Promise<Parser>` (web-tree-sitter init + grammar cache)
- `src/extract.ts` — `extractSymbols(input): ExtractedFile` (the core)
- `tests/knowledge-indexer-*.test.mjs`

## Interfaces this plan PRODUCES (consumed by 2c/2d/2e)

```ts
type Lang = "ts" | "tsx" | "js" | "rust" | "go" | "java" | "php" | "python"
  | "c" | "cpp" | "csharp" | "ruby" | "kotlin" | "swift" | "proto" | "sql"
  | "bash" | "html" | "css" | "json" | "yaml";

interface ExtractedSymbol {
  qualifiedName: string;   // scope-joined, no repo prefix (caller adds repo:)
  name: string;            // leaf name
  kind: string;            // function|class|method|interface|struct|const|…
  signature: string | null;
  startLine: number; endLine: number;
  contentHash: string;     // sha256 of the symbol's source slice (from knowledge-core canonical? no — raw slice hash)
}
interface ExtractedRef {           // raw @reference.* captures — 2c resolves these to edges
  kind: "call" | "import";
  rawName: string;                 // captured callee/import text
  startLine: number;
}
interface ExtractedFile {
  lang: Lang;
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];            // populated here (captured), resolved in 2c
  fileImports: string[];          // raw import/require/use targets (for file→file import edges in 2c)
  parseError: string | null;      // set when grammar missing / parse failed → file-level degrade (§9)
}

function extractSymbols(input: { lang: Lang; source: string; maxBytes?: number }): Promise<ExtractedFile>;
function langForExtension(filePath: string): Lang | null;
```

## Tasks (ordered)

1. **Package scaffold + web-tree-sitter smoke test.** Create package; `loadParser("ts")` parses `const x=1` without error. Test focus: WASM loads under node:test, dist importable. Spec: §6.1.
2. **Language registry + `langForExtension`.** Registry rows for the 20 langs (wasm path + tags query path + scope nodes); extension→lang map. Test focus: `.ts`→ts, `.rs`→rust, unknown→null; every registry row has a resolvable wasm+scm asset. Spec: §6.1.
3. **Symbol extraction via `tags.scm` (TS first).** `extractSymbols` runs the tags query, emits `ExtractedSymbol[]` with kind from capture name. Test focus: a TS fixture with function/class/method → expected names+kinds+line ranges. Spec: §6.1.
4. **Qualified-name assembly (scoped).** Walk scope nodes to prefix `Class.method`, `namespace.fn`. Test focus: nested class/namespace fixture → correct `qualifiedName`; top-level → bare name. Spec: §6.1.
5. **Reference + import capture (raw).** Populate `refs` (`@reference.call`) and `fileImports` (import/require/use). No resolution. Test focus: TS fixture with calls+imports → captured raw names + lines. Spec: §6.2 (capture half only).
6. **Multi-language coverage + degrade.** Add ≥3 more grammars (rust, go, python) end-to-end; missing-grammar/parse-fail → `parseError` set, `symbols=[]` (file-level degrade). Test focus: one fixture per added lang; a `.xyz`/corrupt input → `parseError` non-null, no throw. Spec: §6.1, §9 (grammar-missing / parse-fail rows). Remaining grammars are registry rows + fixtures, added incrementally without pipeline change.
7. **contentHash + signature slicing.** Per-symbol `contentHash` (sha256 of source slice) + `signature` extraction. Test focus: identical body → identical hash; whitespace-only change in another symbol doesn't change this symbol's hash. Spec: §3.2 (`content_hash` semantics), §4.4.

## Spec coverage: §6.1 (extraction), §6.2 (capture), §9 (grammar-missing + parse-fail degrade). Out of scope: resolution→edges (2c), DB writes (2d), dir walking/gitignore/size-walk (2d), watching (2f).
