// Pure gRPC-Web wire helpers — no ConnectRPC / protobuf-runtime dependency.
//
// These power the REST module's "gRPC-Web lens": the Rust backend hands the FE
// the raw response bytes (base64), and these functions deframe it, read the
// trailer status, and produce an honest *schema-less* view of each protobuf
// message. Named-field decoding (via installed descriptors) is a separate,
// descriptor-backed path — deliberately NOT done here.
//
// gRPC-Web framing: a concatenation of length-prefixed frames
//   [1 byte flag][4 bytes big-endian length][payload]
// The trailer frame has the 0x80 bit set in its flag; its payload is an
// HTTP/1-style block of `grpc-status` / `grpc-message` lines. The 0x01 bit
// marks a compressed frame (unsupported here — surfaced as an error).

export class GrpcWebParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrpcWebParseError";
  }
}

export interface GrpcWebFrame {
  /** Raw 1-byte flag. */
  flag: number;
  /** Trailer frame (0x80 set) — carries grpc-status/grpc-message, not a message. */
  trailer: boolean;
  /** Compression bit (0x01 set). Unsupported; parsing rejects these. */
  compressed: boolean;
  data: Uint8Array;
}

export interface GrpcTrailer {
  /** Parsed grpc-status code, or null when absent/unparseable. */
  status: number | null;
  /** Parsed + percent-decoded grpc-message, or null. */
  message: string | null;
  /** Full decoded trailer text (verbatim). */
  raw: string;
  /** All trailer key/value entries, keys lowercased. */
  entries: Record<string, string>;
}

/**
 * Split a gRPC-Web body into its frames. Throws GrpcWebParseError on a
 * truncated header, an out-of-bounds length, or a compressed frame — the
 * caller renders "malformed" rather than guessing.
 */
export function parseGrpcWebFrames(bytes: Uint8Array): GrpcWebFrame[] {
  const frames: GrpcWebFrame[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + 5 > bytes.length) {
      throw new GrpcWebParseError(
        `truncated frame header at offset ${off} (need 5 bytes, have ${bytes.length - off})`,
      );
    }
    const flag = bytes[off];
    // 4-byte big-endian length; `>>> 0` keeps it an unsigned 32-bit value.
    const len =
      ((bytes[off + 1] << 24) | (bytes[off + 2] << 16) | (bytes[off + 3] << 8) | bytes[off + 4]) >>> 0;
    off += 5;
    if (off + len > bytes.length) {
      throw new GrpcWebParseError(
        `frame length ${len} at offset ${off - 5} exceeds remaining body (${bytes.length - off})`,
      );
    }
    const compressed = (flag & 0x01) !== 0;
    if (compressed) {
      throw new GrpcWebParseError("compressed gRPC-Web frames are not supported yet");
    }
    frames.push({
      flag,
      trailer: (flag & 0x80) !== 0,
      compressed,
      data: bytes.subarray(off, off + len),
    });
    off += len;
  }
  return frames;
}

/** Extract the trailer (status/message) from a parsed frame list, if present. */
export function parseGrpcTrailers(frames: GrpcWebFrame[]): GrpcTrailer | null {
  const trailerFrame = frames.find((f) => f.trailer);
  if (!trailerFrame) return null;
  const raw = utf8Decode(trailerFrame.data, /* fatal */ false) ?? "";
  const entries: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    entries[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const statusText = entries["grpc-status"];
  const statusNum = statusText !== undefined && statusText !== "" ? Number(statusText) : NaN;
  const message = entries["grpc-message"];
  return {
    status: Number.isFinite(statusNum) ? statusNum : null,
    message: message !== undefined ? decodeGrpcMessage(message) : null,
    raw,
    entries,
  };
}

// ---- Schema-less protobuf wire decode ------------------------------------

export interface WireDecodeCaps {
  maxDepth: number;
  maxFields: number;
}

const DEFAULT_CAPS: WireDecodeCaps = { maxDepth: 6, maxFields: 1000 };

export interface WireField {
  fieldNumber: number;
  /** protobuf wire type: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
  wireType: number;
  /** wireType 0 — every reasonable interpretation, none chosen. */
  varint?: { unsigned: string; signed: string; zigzag: string; bool: boolean | null };
  /** wireType 1 */
  fixed64?: { hex: string; uint: string; int: string; double: number };
  /** wireType 5 */
  fixed32?: { hex: string; uint: number; int: number; float: number };
  /** wireType 2 — bytes always kept; utf8/nested only when they validate. */
  lengthDelimited?: { base64: string; utf8: string | null; nested: WireView | null };
}

/** Field-number-keyed view; repeated occurrences preserved in order. */
export type WireView = Record<string, WireField[]>;

/**
 * Best-effort schema-less protobuf decode. Keys are field NUMBERS (no names).
 * Every wire type is surfaced with all plausible interpretations as separate
 * candidates — the decoder never commits to one. Throws GrpcWebParseError on a
 * structurally invalid message (bad tag, truncated field, cap exceeded).
 */
export function decodeUnknownMessage(
  bytes: Uint8Array,
  caps: WireDecodeCaps = DEFAULT_CAPS,
  depth = 0,
): WireView {
  if (depth > caps.maxDepth) {
    throw new GrpcWebParseError(`nesting exceeds max depth ${caps.maxDepth}`);
  }
  const view: WireView = {};
  let off = 0;
  let fieldCount = 0;
  while (off < bytes.length) {
    if (++fieldCount > caps.maxFields) {
      throw new GrpcWebParseError(`field count exceeds max ${caps.maxFields}`);
    }
    const [tag, tagEnd] = readVarint(bytes, off);
    off = tagEnd;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber <= 0) {
      throw new GrpcWebParseError(`invalid field number ${fieldNumber}`);
    }
    const field: WireField = { fieldNumber, wireType };
    switch (wireType) {
      case 0: {
        const [v, end] = readVarint(bytes, off);
        off = end;
        field.varint = {
          unsigned: v.toString(),
          signed: BigInt.asIntN(64, v).toString(),
          zigzag: ((v >> 1n) ^ -(v & 1n)).toString(),
          bool: v === 0n ? false : v === 1n ? true : null,
        };
        break;
      }
      case 1: {
        if (off + 8 > bytes.length) throw new GrpcWebParseError("truncated fixed64");
        const slice = bytes.subarray(off, off + 8);
        off += 8;
        const dv = new DataView(slice.buffer, slice.byteOffset, 8);
        const u = dv.getBigUint64(0, /* le */ true);
        field.fixed64 = {
          hex: bytesToHex(slice),
          uint: u.toString(),
          int: BigInt.asIntN(64, u).toString(),
          double: dv.getFloat64(0, true),
        };
        break;
      }
      case 5: {
        if (off + 4 > bytes.length) throw new GrpcWebParseError("truncated fixed32");
        const slice = bytes.subarray(off, off + 4);
        off += 4;
        const dv = new DataView(slice.buffer, slice.byteOffset, 4);
        field.fixed32 = {
          hex: bytesToHex(slice),
          uint: dv.getUint32(0, true),
          int: dv.getInt32(0, true),
          float: dv.getFloat32(0, true),
        };
        break;
      }
      case 2: {
        const [lenBig, lenEnd] = readVarint(bytes, off);
        off = lenEnd;
        const len = Number(lenBig);
        if (off + len > bytes.length) throw new GrpcWebParseError("truncated length-delimited field");
        const slice = bytes.subarray(off, off + len);
        off += len;
        field.lengthDelimited = {
          base64: bytesToBase64(slice),
          utf8: utf8Decode(slice, /* fatal */ true),
          nested: tryDecodeNested(slice, caps, depth + 1),
        };
        break;
      }
      default:
        // Wire types 3/4 (start/end group) are deprecated and unsupported.
        throw new GrpcWebParseError(`unsupported wire type ${wireType} for field ${fieldNumber}`);
    }
    (view[String(fieldNumber)] ??= []).push(field);
  }
  return view;
}

function tryDecodeNested(slice: Uint8Array, caps: WireDecodeCaps, depth: number): WireView | null {
  if (slice.length === 0) return null;
  try {
    const nested = decodeUnknownMessage(slice, caps, depth);
    // Only accept when the whole slice parsed into at least one field —
    // otherwise arbitrary bytes masquerade as an empty message.
    return Object.keys(nested).length > 0 ? nested : null;
  } catch {
    return null;
  }
}

// ---- low-level helpers ----------------------------------------------------

/** Read a base-128 varint as a BigInt. Returns [value, nextOffset]. */
function readVarint(bytes: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let off = start;
  while (true) {
    if (off >= bytes.length) throw new GrpcWebParseError("truncated varint");
    if (shift > 63n) throw new GrpcWebParseError("varint too long (>10 bytes)");
    const b = bytes[off++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [BigInt.asUintN(64, result), off];
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Build a latin1 string in chunks (avoids arg-count limits) then btoa.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode UTF-8. When `fatal`, returns null on any invalid byte OR any control
 * character other than tab/newline/CR — so binary payloads aren't mislabeled
 * as text. When not fatal, returns a lossy decode (for trailer text).
 */
function utf8Decode(bytes: Uint8Array, fatal: boolean): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal }).decode(bytes);
    if (fatal) {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
      }
    }
    return text;
  } catch {
    return null;
  }
}

/** gRPC percent-encodes grpc-message; decode best-effort, fall back to raw. */
function decodeGrpcMessage(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---- Connect protocol helpers ----------------------------------------------

/** Connect streaming envelope flag marking the JSON EndStreamResponse frame. */
export const CONNECT_END_STREAM_FLAG = 0x02;

/** Connect streaming EndStreamResponse: JSON `{error?, metadata?}`. */
export interface ConnectEndStream {
  error: { code: string; message: string } | null;
  raw: string;
}

/** Parse a Connect end-stream frame's JSON payload. Never throws — an
 * unparseable payload degrades to `{ error: null, raw }`. */
export function parseConnectEndStream(data: Uint8Array): ConnectEndStream {
  const raw = new TextDecoder().decode(data);
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
    if (!parsed || typeof parsed !== "object" || !parsed.error) return { error: null, raw };
    return {
      error: {
        code: typeof parsed.error.code === "string" ? parsed.error.code : "unknown",
        message: typeof parsed.error.message === "string" ? parsed.error.message : "",
      },
      raw,
    };
  } catch {
    return { error: null, raw };
  }
}

/** How a proto response body is shaped, by content-type. */
export type ProtoResponseKind = "grpc-web" | "proto-unary" | "connect-stream";

/**
 * Classify a response into a proto lens kind from its content-type (the part
 * before `;`) and HTTP status.
 *
 * - gRPC-Web content-types → framed body, any HTTP status.
 * - `application/proto` → one bare, un-framed message (Connect unary and
 *   friends) — but ONLY on HTTP 200: Connect errors arrive as
 *   application/json, so a non-200 proto body is an error payload from a
 *   non-Connect server, not a decodable message.
 * - `application/connect+proto` → Connect streaming envelopes (end-stream
 *   frame is CONNECT_END_STREAM_FLAG with JSON, not 0x80 text trailers).
 */
export function classifyProtoResponse(
  contentType: string | null | undefined,
  httpStatus: number,
): ProtoResponseKind | null {
  const ct = contentType?.split(";")[0].trim().toLowerCase();
  if (ct === "application/grpc-web" || ct === "application/grpc-web+proto") return "grpc-web";
  if (ct === "application/proto" && httpStatus === 200) return "proto-unary";
  if (ct === "application/connect+proto") return "connect-stream";
  return null;
}
