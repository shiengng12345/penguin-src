// Auto request-correlation id attached to every MCP-driven Penguin request.
// Mirrors src/lib/penguin-request-id.ts (the desktop UI's send-pipeline
// generator) but swaps Web Crypto for node:crypto — this package is a
// standalone Node18 esbuild bundle with no dependency on the Tauri app's
// frontend source, so it can't import that file directly. Keep the output
// shape identical (`penguin-<uuidv7>`) so ids from either path are
// indistinguishable in server logs.
import { randomBytes } from "node:crypto";

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

  bytes.set(randomBytes(10), 6);

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Generate a fresh `penguin-<uuidv7>` id. Called once per outgoing call so
// every request carries a unique, time-ordered correlation id.
export function generatePenguinRequestId(): string {
  return `${PENGUIN_ID_PREFIX}${uuidv7()}`;
}
