import type { ParsedEdge } from "@penguin/knowledge-core";
import type { ExtractedRef, ExtractedSymbol } from "./extract.js";

// Resolution backend over already-indexed symbols in the same repo+branch.
// Implemented against KnowledgeStore in 2d; a fake satisfies it in tests.
export interface SymbolIndex {
  byQualifiedName(qualifiedName: string): string | null; // → nodeId
  // Bare-name candidates carry the file they're defined in so resolution can
  // scope to the current file + its imports (Plan B / import-scoped resolution).
  bareNameCandidates(bareName: string): Array<{ id: string; filePath: string | null }>;
}

export interface ResolvedEdges {
  edges: ParsedEdge[];
  unresolved: number;
}

function bareOf(qualifiedName: string): string {
  const i = qualifiedName.lastIndexOf(".");
  return i >= 0 ? qualifiedName.slice(i + 1) : qualifiedName;
}

// A bare name matching more candidates than this is too ambiguous to guess —
// common names (`error`, `log`, `find`, `get`) would otherwise collapse hundreds
// of unrelated call sites onto one arbitrary node, creating fake mega-hubs that
// swamp the graph. Above the cap we drop rather than force-resolve (§6.2.3).
const MAX_BARE_CANDIDATES = 6;

// Resolve call + type refs to graph edges (§6.2 + Plan B):
//   - `call` ref → `calls` edge (a function/method invocation)
//   - `type` ref → `references` edge (a type annotation/generic/extends/impl —
//     so DTOs, interfaces and type aliases connect to the symbols that use them)
// Priority per ref:
//   tier 1: same-file symbol by bare name → EXTRACTED
//   tier 2: same-repo unique qualified-name hit → EXTRACTED
//   tier 3: same-repo bare name — 1 hit → EXTRACTED; 2..cap → best-guess INFERRED
//           (confidence 1/N); 0 or >cap → dropped (unresolved++).
// A ref with no enclosing symbol (no caller/user) can't form an edge → dropped.
// Self-edges (a symbol referencing itself) are skipped.
export function resolveRefs(input: {
  refs: ExtractedRef[];
  fileSymbols: ExtractedSymbol[];
  fileSymbolIds: Map<string, string>; // qualifiedName → nodeId (this file)
  lookup: SymbolIndex;
  // The current file's own path + the set of files it imports. When provided,
  // an ambiguous bare name is first narrowed to candidates defined in these
  // files — an imported symbol is almost certainly the intended target, which
  // kills the fake mega-hubs that global bare-name best-guessing created.
  currentFile?: string;
  importedFiles?: Set<string>;
}): ResolvedEdges {
  const edges: ParsedEdge[] = [];
  let unresolved = 0;

  const fileByBare = new Map<string, ExtractedSymbol[]>();
  for (const s of input.fileSymbols) {
    const arr = fileByBare.get(s.name) ?? [];
    arr.push(s);
    fileByBare.set(s.name, arr);
  }

  const push = (src: string, dst: string, edgeType: string, method: "EXTRACTED" | "INFERRED", confidence?: number) => {
    if (src === dst) return; // no self-loops
    edges.push({ src, dst, edgeType, origin: "parser", method, ...(confidence != null ? { confidence } : {}) });
  };

  for (const ref of input.refs) {
    if (ref.kind !== "call" && ref.kind !== "type") continue;
    const edgeType = ref.kind === "call" ? "calls" : "references";
    const src = ref.enclosingQualifiedName
      ? input.fileSymbolIds.get(ref.enclosingQualifiedName) ?? null
      : null;
    if (!src) {
      unresolved += 1;
      continue;
    }
    const bare = bareOf(ref.rawName);

    // tier 1: same file
    const local = fileByBare.get(bare);
    if (local && local.length === 1) {
      const dst = input.fileSymbolIds.get(local[0].qualifiedName);
      if (dst) {
        push(src, dst, edgeType, "EXTRACTED");
        continue;
      }
    }

    // tier 2: same-repo unique qualified-name hit
    const qualified = input.lookup.byQualifiedName(ref.rawName);
    if (qualified) {
      push(src, qualified, edgeType, "EXTRACTED");
      continue;
    }

    // tier 3: same-repo bare name
    const candidates = input.lookup.bareNameCandidates(bare);
    if (candidates.length === 1) {
      push(src, candidates[0].id, edgeType, "EXTRACTED");
      continue;
    }

    // tier 3a: narrow an ambiguous name to the current file + its imports. An
    // imported symbol is the strongly-likely target; a unique scoped hit wins.
    if (candidates.length > 1 && (input.importedFiles || input.currentFile)) {
      const scope = input.importedFiles ?? new Set<string>();
      const scoped = candidates.filter(
        (c) => c.filePath && (c.filePath === input.currentFile || scope.has(c.filePath)),
      );
      if (scoped.length === 1) {
        push(src, scoped[0].id, edgeType, "EXTRACTED");
        continue;
      }
      if (scoped.length > 1) {
        // still ambiguous even after import scoping → refuse to guess
        unresolved += 1;
        continue;
      }
    }

    // tier 3b: no import evidence — cautious best-guess, but only when the name
    // is not wildly ambiguous (else it's a common name → drop, no fake hub).
    if (candidates.length > 1 && candidates.length <= MAX_BARE_CANDIDATES) {
      push(src, candidates[0].id, edgeType, "INFERRED", 1 / candidates.length);
    } else {
      unresolved += 1; // 0 candidates, or too ambiguous to guess
    }
  }

  return { edges, unresolved };
}
