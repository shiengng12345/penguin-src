// Detect a `[[wikilink` or `#tag` autocomplete trigger from the text before the
// cursor. Pure + framework-free so the trigger logic is unit-tested without a
// CodeMirror instance (the editor wires this into a completion source). `from`
// is the absolute offset where the partial query starts (what a completion
// replaces from), given `prefix` = the document text up to the cursor.

export interface NoteCompletionTrigger {
  kind: "wikilink" | "tag";
  query: string;
  from: number;
}

export function noteCompletionTrigger(prefix: string): NoteCompletionTrigger | null {
  // `[[partial` with no closing `]]` yet, not crossing a newline.
  const wl = prefix.match(/\[\[([^\]\n]*)$/);
  if (wl) return { kind: "wikilink", query: wl[1], from: prefix.length - wl[1].length };
  // `#partial` at a word boundary (start of line or after whitespace).
  const tag = prefix.match(/(?:^|\s)#([A-Za-z0-9_/-]*)$/);
  if (tag) return { kind: "tag", query: tag[1], from: prefix.length - tag[1].length };
  return null;
}
