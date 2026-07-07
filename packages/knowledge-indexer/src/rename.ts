import type { ExtractedSymbol } from "./extract.js";

export interface RenameAliasEvent {
  aliasKey: string; // the OLD qualified name that should still resolve
  reason: "rename";
}

// Detect symbol renames within one file's re-index (§6.3): a symbol that
// disappeared + a symbol that appeared + identical content_hash = the same
// implementation under a new name → emit an alias so the old name still
// resolves. Ambiguity (an equal hash matched by multiple appeared symbols, or
// multiple disappeared sharing a hash) yields NO alias — never auto-merge on
// ambiguity (§9). The caller feeds each alias to recordKnowledge() (Ledger).
export function detectRenames(input: {
  disappeared: ExtractedSymbol[];
  appeared: ExtractedSymbol[];
}): RenameAliasEvent[] {
  const events: RenameAliasEvent[] = [];

  // Group by content_hash; a rename is a 1:1 hash match across the two sets.
  const appearedByHash = new Map<string, ExtractedSymbol[]>();
  for (const s of input.appeared) {
    const arr = appearedByHash.get(s.contentHash) ?? [];
    arr.push(s);
    appearedByHash.set(s.contentHash, arr);
  }
  const disappearedByHash = new Map<string, ExtractedSymbol[]>();
  for (const s of input.disappeared) {
    const arr = disappearedByHash.get(s.contentHash) ?? [];
    arr.push(s);
    disappearedByHash.set(s.contentHash, arr);
  }

  for (const [hash, goneList] of disappearedByHash) {
    const newList = appearedByHash.get(hash);
    if (!newList) continue;
    // Only a clean 1:1 hash match is an unambiguous rename.
    if (goneList.length !== 1 || newList.length !== 1) continue;
    const gone = goneList[0];
    const arrived = newList[0];
    if (gone.qualifiedName === arrived.qualifiedName) continue; // same name, not a rename
    events.push({ aliasKey: gone.qualifiedName, reason: "rename" });
  }

  return events;
}
