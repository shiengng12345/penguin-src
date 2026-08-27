// Request-correlation ids for MCP-driven Penguin requests. The implementation
// lives in @penguin/core (runtime-neutral Web Crypto, bundled into this
// package by esbuild) — this module only re-exports so existing imports keep
// working. The desktop app's src/lib/penguin-request-id.ts is the one
// remaining sibling implementation (same wire format, standalone for its
// transpile-based test).
export { PENGUIN_REQUEST_ID_HEADER, generatePenguinRequestId } from "@penguin/core";
