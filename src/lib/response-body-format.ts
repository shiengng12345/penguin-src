// Elide oversized string values in a parsed response body before it's rendered.
// A gRPC `bytes` field (e.g. an embedded image) arrives as one enormous base64
// string — a single ~500KB line. The response viewer virtualizes by LINE, so a
// giant single line isn't split: the tokenizer + one massive DOM span freeze the
// UI ("response too long"). Replacing such values with a short placeholder keeps
// the response structure readable and the render cheap, while still telling the
// user what was there and how big it was.

// Strings longer than this (chars) are elided in the pretty view. 2 KB is far
// larger than any normal field, so only genuine blobs are touched.
export const MAX_DISPLAY_STRING_LEN = 2048;

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

// Recursively replace any string longer than `maxLen` with a placeholder that
// keeps a short head (so an image/base64/token is still identifiable) plus the
// elided size. Non-string leaves and short strings pass through untouched.
export function elideLargeStrings(value: unknown, maxLen: number = MAX_DISPLAY_STRING_LEN): unknown {
  if (typeof value === "string") {
    if (value.length <= maxLen) return value;
    const head = value.slice(0, 48).replace(/\s+/g, " ");
    return `«elided ${formatBytes(value.length)} — starts: ${head}…»`;
  }
  if (Array.isArray(value)) return value.map((v) => elideLargeStrings(v, maxLen));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = elideLargeStrings(v, maxLen);
    }
    return out;
  }
  return value;
}
