export interface LineIndexEntry {
  line: number;
  startByte: number;
  endByte: number;
  startChar: number;
  endChar: number;
}

export interface LineIndex {
  offsetEncoding: "utf8_normalized";
  lines: LineIndexEntry[];
}

export function buildLineIndex(_rawBytes: Uint8Array, decodedContent: string): LineIndex {
  const lines: LineIndexEntry[] = [];
  const segments = decodedContent.split("\n");
  let startChar = 0;
  let startByte = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const endChar = startChar + segment.length;
    // Accumulate byte offsets per line instead of re-encoding the whole file
    // from position zero for every line. The previous form called
    // Buffer.byteLength(content.slice(0, offset)) twice per line, which is
    // quadratic in file size: a 134KB / 2914-line source cost 235ms here —
    // an order of magnitude more than tree-sitter spends parsing it. "\n" is
    // one byte, so the newline advances char and byte offsets alike.
    const endByte = startByte + Buffer.byteLength(segment, "utf8");
    lines.push({ line: index + 1, startByte, endByte, startChar, endChar });
    const newline = index < segments.length - 1 ? 1 : 0;
    startChar = endChar + newline;
    startByte = endByte + newline;
  }
  return { offsetEncoding: "utf8_normalized", lines };
}

export function locateOffset(index: LineIndex, byteOffset: number): LineIndexEntry {
  if (index.lines.length === 0) throw new Error("line index is empty");
  let low = 0;
  let high = index.lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = index.lines[middle];
    const next = index.lines[middle + 1];
    if (byteOffset < current.startByte) high = middle - 1;
    else if (next && byteOffset >= next.startByte) low = middle + 1;
    else return current;
  }
  return byteOffset < index.lines[0].startByte ? index.lines[0] : index.lines.at(-1)!;
}
