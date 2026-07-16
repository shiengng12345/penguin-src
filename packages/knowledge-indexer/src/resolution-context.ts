import { canonicalJson, sha256Hex } from "@penguin/knowledge-core";

export interface ResolutionContextInput {
  fileFactId: string;
  imports: Array<{ specifier: string; resolvedPath: string | null; exportsHash: string | null }>;
  ambientSymbolSurfaceHash: string;
  resolverConfigHash: string;
  resolverVersion: string;
}
export function resolutionContextFingerprint(input: ResolutionContextInput): string {
  return sha256Hex(canonicalJson({ fileFactId: input.fileFactId, imports: [...input.imports].sort((a, b) => a.specifier.localeCompare(b.specifier)), ambientSymbolSurfaceHash: input.ambientSymbolSurfaceHash, resolverConfigHash: input.resolverConfigHash, resolverVersion: input.resolverVersion }));
}
export function dependentInvalidationClosure(changedPaths: Set<string>, reverseImports: Map<string, Set<string>>): Set<string> {
  const result = new Set(changedPaths); const queue = [...changedPaths];
  while (queue.length) { const current = queue.shift(); if (current === undefined) break; for (const dependent of reverseImports.get(current) ?? []) if (!result.has(dependent)) { result.add(dependent); queue.push(dependent); } }
  return result;
}
