import type { KnowledgeStore } from "./store.js";
import type { LineIndex, LineIndexEntry } from "./line-index.js";

// Line offsets for a blob, packed as two arrays instead of one row per line.
//
// source_blob_lines stored six integers and a two-column primary key per LINE
// of every indexed file: 2.53 GB of rows plus 3.14 GB of index for a 16 GB
// database, a third of the whole thing, to answer "which line is this offset
// in". Everything it held is derivable from two numbers per line, because
// buildLineIndex defines endChar as the next line's startChar minus its
// newline, and endByte likewise:
//
//   8 bytes per line here, against roughly a hundred there.
//
// Lookup stays O(log lines) — binary search over a typed array rather than a
// B-tree descent — so this trades no speed for the space, unlike dropping the
// offsets entirely and rescanning the blob on every hit.

export interface PackedLineOffsets {
  lineCount: number;
  totalChars: number;
  totalBytes: number;
  startChars: Uint32Array;
  startBytes: Uint32Array;
}

function packUint32(values: number[]): Buffer {
  const packed = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i += 1) packed.writeUInt32LE(values[i], i * 4);
  return packed;
}

function unpackUint32(blob: Buffer | Uint8Array): Uint32Array {
  const bytes = Buffer.from(blob);
  const out = new Uint32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readUInt32LE(i * 4);
  return out;
}

export function packLineIndex(index: LineIndex): {
  lineCount: number; totalChars: number; totalBytes: number; startChars: Buffer; startBytes: Buffer;
} {
  const last = index.lines.at(-1);
  return {
    lineCount: index.lines.length,
    totalChars: last?.endChar ?? 0,
    totalBytes: last?.endByte ?? 0,
    startChars: packUint32(index.lines.map((line) => line.startChar)),
    startBytes: packUint32(index.lines.map((line) => line.startByte)),
  };
}

export function readLineOffsets(store: KnowledgeStore, blobId: number): PackedLineOffsets | null {
  const row = store.db
    .prepare(
      "SELECT line_count AS lineCount, total_chars AS totalChars, total_bytes AS totalBytes, start_chars AS startChars, start_bytes AS startBytes FROM source_blob_line_offsets WHERE source_blob_id=?",
    )
    .get(blobId) as
    | { lineCount: number; totalChars: number; totalBytes: number; startChars: Buffer; startBytes: Buffer }
    | undefined;
  if (!row || row.lineCount === 0) return null;
  return {
    lineCount: row.lineCount,
    totalChars: row.totalChars,
    totalBytes: row.totalBytes,
    startChars: unpackUint32(row.startChars),
    startBytes: unpackUint32(row.startBytes),
  };
}

/** The full entry for a 1-based line, reconstructed from the two arrays.
 * Returns null for a line outside the file rather than clamping, so a caller
 * asking for line 900 of a 40-line file learns that instead of getting line 40. */
export function lineEntry(offsets: PackedLineOffsets, line: number): LineIndexEntry | null {
  if (line < 1 || line > offsets.lineCount) return null;
  const at = line - 1;
  const startChar = offsets.startChars[at];
  const startByte = offsets.startBytes[at];
  // The next line begins one past this line's newline, so its start minus one
  // IS this line's end — the same relation buildLineIndex writes out.
  const endChar = at + 1 < offsets.lineCount ? offsets.startChars[at + 1] - 1 : offsets.totalChars;
  const endByte = at + 1 < offsets.lineCount ? offsets.startBytes[at + 1] - 1 : offsets.totalBytes;
  return { line, startChar, endChar, startByte, endByte };
}

function lineAt(starts: Uint32Array, count: number, offset: number): number {
  if (count === 0) return 1;
  if (offset < starts[0]) return 1;
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = starts[middle];
    const nextStart = middle + 1 < count ? starts[middle + 1] : Number.POSITIVE_INFINITY;
    if (offset < start) high = middle - 1;
    else if (offset >= nextStart) low = middle + 1;
    else return middle + 1;
  }
  return count;
}

export function lineAtChar(offsets: PackedLineOffsets, charOffset: number): number {
  return lineAt(offsets.startChars, offsets.lineCount, charOffset);
}

export function lineAtByte(offsets: PackedLineOffsets, byteOffset: number): number {
  return lineAt(offsets.startBytes, offsets.lineCount, byteOffset);
}
