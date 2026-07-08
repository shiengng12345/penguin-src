import type { ExtractedSymbol } from "./extract.js";

export interface RenameAliasEvent {
  aliasKey: string; // the OLD qualified name that should still resolve
  reason: "rename";
}

export interface RenameSuggestion {
  oldKey: string; // disappeared symbol's qualified name
  candidateKeys: string[]; // appeared symbols sharing its body (ambiguous target)
}

// Detect symbol renames within one file's re-index (§6.3/§11):
//  - CLEAN 1:1 equal content_hash across gone/appeared → `auto` alias (the old
//    name keeps resolving). Applied directly (Ledger).
//  - AMBIGUOUS equal-hash group (N gone / M appeared, not 1:1) → `suggested`:
//    the implementation clearly moved but we can't auto-pick which pairing, so
//    it goes to a confirmation queue instead of auto-merging (§9 never
//    auto-merge on ambiguity; §11 "相似度检测进确认队列").
export function detectRenames(input: {
  disappeared: ExtractedSymbol[];
  appeared: ExtractedSymbol[];
}): { auto: RenameAliasEvent[]; suggested: RenameSuggestion[] } {
  const auto: RenameAliasEvent[] = [];
  const suggested: RenameSuggestion[] = [];

  const byHash = (list: ExtractedSymbol[]) => {
    const m = new Map<string, ExtractedSymbol[]>();
    for (const s of list) {
      const arr = m.get(s.contentHash) ?? [];
      arr.push(s);
      m.set(s.contentHash, arr);
    }
    return m;
  };
  const appearedByHash = byHash(input.appeared);
  const disappearedByHash = byHash(input.disappeared);

  for (const [hash, goneList] of disappearedByHash) {
    const newList = appearedByHash.get(hash);
    if (!newList || newList.length === 0) continue;

    if (goneList.length === 1 && newList.length === 1) {
      const gone = goneList[0];
      const arrived = newList[0];
      if (gone.qualifiedName === arrived.qualifiedName) continue; // same name, not a rename
      auto.push({ aliasKey: gone.qualifiedName, reason: "rename" });
      continue;
    }

    // ambiguous same-body group → queue each gone with its candidate targets
    const candidateKeys = newList.map((s) => s.qualifiedName);
    for (const gone of goneList) {
      if (candidateKeys.includes(gone.qualifiedName)) continue;
      suggested.push({ oldKey: gone.qualifiedName, candidateKeys });
    }
  }

  return { auto, suggested };
}
