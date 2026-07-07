import type { ParsedEdge } from "@penguin/knowledge-core";
import type { ExtractedRef, ExtractedSymbol } from "./extract.js";

// Resolution backend over already-indexed symbols in the same repo+branch.
// Implemented against KnowledgeStore in 2d; a fake satisfies it in tests.
export interface SymbolIndex {
  byQualifiedName(qualifiedName: string): string | null; // → nodeId
  bareNameCandidates(bareName: string): string[]; // → nodeIds
}

export interface ResolvedEdges {
  edges: ParsedEdge[];
  unresolved: number;
}

function bareOf(qualifiedName: string): string {
  const i = qualifiedName.lastIndexOf(".");
  return i >= 0 ? qualifiedName.slice(i + 1) : qualifiedName;
}

// Resolve call refs to `calls` edges (§6.2). Priority per ref:
//   tier 1: same-file symbol by qualified or bare name → EXTRACTED
//   tier 2: same-repo unique qualified-name hit → EXTRACTED
//   tier 3: same-repo bare name — 1 hit → EXTRACTED; >1 → best-guess INFERRED
//           (confidence 1/N); 0 → dropped (unresolved++). Dynamic/unmatched
//           calls are never force-resolved (§6.2.3).
// A ref with no enclosing symbol (no caller) can't form a caller→callee edge → dropped.
export function resolveRefs(input: {
  refs: ExtractedRef[];
  fileSymbols: ExtractedSymbol[];
  fileSymbolIds: Map<string, string>; // qualifiedName → nodeId (this file)
  lookup: SymbolIndex;
}): ResolvedEdges {
  const edges: ParsedEdge[] = [];
  let unresolved = 0;

  const fileByBare = new Map<string, ExtractedSymbol[]>();
  for (const s of input.fileSymbols) {
    const arr = fileByBare.get(s.name) ?? [];
    arr.push(s);
    fileByBare.set(s.name, arr);
  }

  for (const ref of input.refs) {
    if (ref.kind !== "call") continue;
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
        edges.push({ src, dst, edgeType: "calls", origin: "parser", method: "EXTRACTED" });
        continue;
      }
    }

    // tier 2: same-repo unique qualified-name hit
    const qualified = input.lookup.byQualifiedName(ref.rawName);
    if (qualified) {
      edges.push({ src, dst: qualified, edgeType: "calls", origin: "parser", method: "EXTRACTED" });
      continue;
    }

    // tier 3: same-repo bare name
    const candidates = input.lookup.bareNameCandidates(bare);
    if (candidates.length === 1) {
      edges.push({ src, dst: candidates[0], edgeType: "calls", origin: "parser", method: "EXTRACTED" });
    } else if (candidates.length > 1) {
      edges.push({
        src,
        dst: candidates[0],
        edgeType: "calls",
        origin: "parser",
        method: "INFERRED",
        confidence: 1 / candidates.length,
      });
    } else {
      unresolved += 1;
    }
  }

  return { edges, unresolved };
}
