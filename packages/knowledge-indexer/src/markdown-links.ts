export interface MarkdownLink { sourceLine: number; rawTarget: string; targetAnchor: string | null; displayText: string | null; embedded: boolean; }

export function extractMarkdownLinks(body: string): MarkdownLink[] {
  const out: MarkdownLink[] = [];
  for (const [lineIndex, line] of body.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      const inner = match[2].trim(); const pipe = inner.indexOf("|"); const targetAndAnchor = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim(); const hash = targetAndAnchor.indexOf("#");
      out.push({ sourceLine: lineIndex + 1, rawTarget: hash >= 0 ? targetAndAnchor.slice(0, hash) : targetAndAnchor, targetAnchor: hash >= 0 ? targetAndAnchor.slice(hash + 1) : null, displayText: pipe >= 0 ? inner.slice(pipe + 1).trim() : null, embedded: match[1] === "!" });
    }
  }
  return out;
}
