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
  let startChar = 0;
  const segments = decodedContent.split("\n");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const endChar = startChar + segment.length;
    lines.push({
      line: index + 1,
      startByte: Buffer.byteLength(decodedContent.slice(0, startChar), "utf8"),
      endByte: Buffer.byteLength(decodedContent.slice(0, endChar), "utf8"),
      startChar,
      endChar,
    });
    startChar = endChar + (index < segments.length - 1 ? 1 : 0);
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
