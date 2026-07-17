import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export type SupportedTextEncoding = "utf8" | "utf16le" | "utf16be";

export type DecodedText = {
  ok: true;
  text: string;
  encoding: SupportedTextEncoding;
} | {
  ok: false;
  reason: "unsupported_encoding";
};

export function decodeTextBuffer(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { ok: true, text: new TextDecoder("utf-16le").decode(bytes.slice(2)), encoding: "utf16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.slice(2));
    if (swapped.length % 2 !== 0) return { ok: false, reason: "unsupported_encoding" };
    swapped.swap16();
    return { ok: true, text: new TextDecoder("utf-16le").decode(swapped), encoding: "utf16be" };
  }
  try {
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start)), encoding: "utf8" };
  } catch {
    return { ok: false, reason: "unsupported_encoding" };
  }
}

export function hasNulByte(bytes: Uint8Array, sampleBytes: number): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, sampleBytes));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

/** Hash file contents incrementally for discovery/checkpoint decisions. */
export async function hashFileStream(filePath: string): Promise<{ contentHash: string; byteSize: number }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    byteSize += bytes.byteLength;
    hash.update(bytes);
  }
  return { contentHash: hash.digest("hex"), byteSize };
}

/** Decode UTF-8/UTF-16 text incrementally without a second full-size Buffer. */
export async function decodeTextFileStream(filePath: string): Promise<DecodedText> {
  const stream = createReadStream(filePath);
  let pending = Buffer.alloc(0);
  let decoder: TextDecoder | undefined;
  let encoding: SupportedTextEncoding | undefined;
  let text = "";
  let first = true;
  try {
    for await (const chunk of stream) {
      let bytes = Buffer.concat([pending, chunk as Buffer]);
      if (first) {
        // Keep enough bytes to identify a BOM when the first stream chunk is tiny.
        if (bytes.length < 3) { pending = bytes; continue; }
        first = false;
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          encoding = "utf16le"; decoder = new TextDecoder("utf-16le", { fatal: true }); bytes = bytes.subarray(2);
        } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          encoding = "utf16be"; decoder = new TextDecoder("utf-16le", { fatal: true }); bytes = bytes.subarray(2);
        } else {
          encoding = "utf8"; decoder = new TextDecoder("utf-8", { fatal: true });
          if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
        }
      }
      if (!decoder || !encoding) throw new Error("decoder not initialized");
      if (encoding === "utf16be") {
        if (bytes.length % 2 !== 0) { pending = bytes.subarray(bytes.length - 1); bytes = bytes.subarray(0, bytes.length - 1); }
        else pending = Buffer.alloc(0);
        if (bytes.length) { const swapped = Buffer.from(bytes); swapped.swap16(); text += decoder.decode(swapped, { stream: true }); }
      } else {
        pending = Buffer.alloc(0);
        text += decoder.decode(bytes, { stream: true });
      }
    }
    if (!decoder || !encoding) {
      // Empty and very small files still go through the fatal decoder path.
      return decodeTextBuffer(pending);
    }
    if (pending.length) {
      if (encoding === "utf16be" && pending.length % 2 === 0) { const swapped = Buffer.from(pending); swapped.swap16(); text += decoder.decode(swapped, { stream: true }); }
      else if (encoding !== "utf16be") text += decoder.decode(pending, { stream: true });
      else throw new Error("odd utf16be byte count");
    }
    text += decoder.decode();
    return { ok: true, text, encoding };
  } catch {
    stream.destroy();
    return { ok: false, reason: "unsupported_encoding" };
  }
}
