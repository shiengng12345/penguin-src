// Penguin request-correlation ids — the SHARED authority for the MCP server
// and the knowledge CLI. Wire format: `penguin-<uuidv7>` (time-ordered, so
// ids sort by creation in logs/history). The desktop app keeps its own
// equivalent in src/lib/penguin-request-id.ts (same format, covered by
// tests/penguin-request-id.test.mjs, kept standalone so its transpile-based
// test needs no import rewriting) — any format change must land in BOTH.
//
// Uses globalThis.crypto.getRandomValues: available in browsers and Node ≥19,
// so this module stays runtime-neutral (no node:crypto import).

export const PENGUIN_REQUEST_ID_HEADER = "x-penguin-id";

const PENGUIN_ID_PREFIX = "penguin-";

// RFC 9562 UUIDv7: 48-bit big-endian Unix-ms timestamp, 4-bit version (0111),
// 12 bits random, 2-bit variant (10), 62 bits random.
function uuidv7(): string {
  const timestampMs = Date.now();
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;
  const random = new Uint8Array(10);
  globalThis.crypto.getRandomValues(random);
  bytes.set(random, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fresh `penguin-<uuidv7>` id — one per outgoing call, never reused. */
export function generatePenguinRequestId(): string {
  return `${PENGUIN_ID_PREFIX}${uuidv7()}`;
}
