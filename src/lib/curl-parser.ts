// Pure curl parser shared by:
// - src/components/environment/CurlImport.tsx (request panel — full env creation)
// - src/components/docs/ApiDocsPage.tsx (Knowledge Base — endpoint pre-fill)
//
// Returns a flat record of what the curl asked for. Callers decide what to do
// with it (create env, fill form, etc.). No environment-detection lives here.

export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  // Set to "hex" when the body came from a `$'...'` ANSI-C payload that decoded
  // to non-printable bytes — then `body` is a hex string (e.g. a gRPC-Web
  // frame `0000000000`) to be imported as a binary body. Absent = plain text.
  bodyEncoding?: "hex";
}

// Decode a shell ANSI-C `$'...'` string body (raw inner text, escapes intact)
// into bytes. Handles the common escapes plus \xHH, \0NNN octal, \uHHHH.
function decodeAnsiCBytes(raw: string): number[] {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const simple: Record<string, number> = {
    n: 0x0a, t: 0x09, r: 0x0d, "\\": 0x5c, "'": 0x27, '"': 0x22,
    a: 0x07, b: 0x08, f: 0x0c, v: 0x0b, e: 0x1b, "0": 0x00,
  };
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c !== "\\") {
      for (const byte of enc.encode(c)) bytes.push(byte);
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) { bytes.push(0x5c); i += 1; continue; }
    if (next === "x") {
      const m = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 2));
      if (m) { bytes.push(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
    } else if (next === "u" || next === "U") {
      const width = next === "u" ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(raw.slice(i + 2));
      if (m) {
        for (const byte of enc.encode(String.fromCodePoint(parseInt(m[0], 16)))) bytes.push(byte);
        i += 2 + m[0].length;
        continue;
      }
    } else if (next >= "0" && next <= "7") {
      const m = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
      if (m) { bytes.push(parseInt(m[0], 8) & 0xff); i += 1 + m[0].length; continue; }
    }
    if (next in simple) { bytes.push(simple[next]); i += 2; continue; }
    // Unknown escape: keep the char literally (drop the backslash).
    for (const byte of enc.encode(next)) bytes.push(byte);
    i += 2;
  }
  return bytes;
}

// Read a `$'...'` literal starting at the opening quote; returns the raw inner
// text (escapes intact) so decodeAnsiCBytes can interpret them. Honors \\ and
// \' so the closing quote is found correctly.
function extractAnsiCRaw(src: string, quoteStart: number): { raw: string; end: number } {
  let i = quoteStart + 1;
  let out = "";
  while (i < src.length) {
    if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
    if (src[i] === "'") return { raw: out, end: i + 1 };
    out += src[i];
    i += 1;
  }
  return { raw: out, end: i };
}

function bytesAreProbablyText(bytes: number[]): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function bytesToHexString(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extractQuoted(src: string, start: number): { value: string; end: number } | null {
  const ch = src[start];
  if (ch !== "'" && ch !== '"') return null;
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    if (src[i] === "\\") {
      out += src[i + 1] ?? "";
      i += 2;
    } else if (src[i] === ch) {
      return { value: out, end: i + 1 };
    } else {
      out += src[i];
      i++;
    }
  }
  return { value: out, end: i };
}

function extractToken(src: string, start: number): { value: string; end: number } {
  if (start < src.length && (src[start] === "'" || src[start] === '"')) {
    const q = extractQuoted(src, start);
    if (q) return q;
  }
  let i = start;
  while (i < src.length && src[i] !== " " && src[i] !== "\t") i++;
  return { value: src.slice(start, i), end: i };
}

function skipWs(src: string, i: number): number {
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  return i;
}

export function parseCurl(input: string): ParsedCurl | null {
  const normalized = input
    .trim()
    .replace(/\\\r?\n/g, " ")
    .replace(/[\r\n]+/g, " ");

  if (!normalized.toLowerCase().startsWith("curl")) return null;

  let method = "";
  let url = "";
  const headers: Record<string, string> = {};
  let body = "";
  let bodyEncoding: "hex" | undefined;

  let i = 4;
  while (i < normalized.length) {
    i = skipWs(normalized, i);
    if (i >= normalized.length) break;

    if (normalized[i] === "-") {
      if (normalized.startsWith("-X", i)) {
        i = skipWs(normalized, i + 2);
        const tok = extractToken(normalized, i);
        method = tok.value.toUpperCase();
        i = tok.end;
      } else if (normalized.startsWith("-H", i) || normalized.startsWith("--header", i)) {
        i += normalized.startsWith("--header", i) ? 8 : 2;
        i = skipWs(normalized, i);
        const tok = extractToken(normalized, i);
        i = tok.end;
        const colonIdx = tok.value.indexOf(":");
        if (colonIdx > 0) {
          headers[tok.value.slice(0, colonIdx).trim()] = tok.value.slice(colonIdx + 1).trim();
        }
      } else if (
        normalized.startsWith("-d", i) ||
        normalized.startsWith("--data-raw", i) ||
        normalized.startsWith("--data-binary", i) ||
        normalized.startsWith("--data", i)
      ) {
        const flagLen = normalized.startsWith("--data-raw", i)
          ? 10
          : normalized.startsWith("--data-binary", i)
          ? 13
          : normalized.startsWith("--data", i)
          ? 6
          : 2;
        i += flagLen;
        i = skipWs(normalized, i);
        if (normalized[i] === "$" && normalized[i + 1] === "'") {
          // ANSI-C quoting: `$'...'` interprets escape sequences (e.g. a
          // gRPC-Web frame `$'\x00\x00\x00\x00\x00'`). Decode to real bytes;
          // non-printable payloads become a hex binary body.
          const { raw, end } = extractAnsiCRaw(normalized, i + 1);
          const bytes = decodeAnsiCBytes(raw);
          i = end;
          if (bytesAreProbablyText(bytes)) {
            body = new TextDecoder().decode(Uint8Array.from(bytes));
          } else {
            body = bytesToHexString(bytes);
            bodyEncoding = "hex";
          }
        } else {
          // Skip a bare `$` sigil before a normal quoted token.
          if (i < normalized.length && normalized[i] === "$") i++;
          const tok = extractToken(normalized, i);
          body = tok.value;
          i = tok.end;
        }
      } else {
        const tok = extractToken(normalized, i);
        i = tok.end;
        // No-arg flags we silently skip — they don't affect parsed shape.
        if (
          tok.value === "--compressed" ||
          tok.value === "-k" ||
          tok.value === "--insecure" ||
          tok.value === "-s" ||
          tok.value === "--silent" ||
          tok.value === "-v" ||
          tok.value === "--verbose" ||
          tok.value === "-L" ||
          tok.value === "--location"
        ) {
          continue;
        }
        // Unknown short flag with value — swallow the value token too.
        if (tok.value.startsWith("-") && !tok.value.startsWith("--") && tok.value.length === 2) {
          i = skipWs(normalized, i);
          const valTok = extractToken(normalized, i);
          i = valTok.end;
        }
      }
    } else {
      const tok = extractToken(normalized, i);
      i = tok.end;
      const looksLikeUrl = tok.value.startsWith("http://") || tok.value.startsWith("https://");
      if (!url && looksLikeUrl) {
        url = tok.value;
      }
    }
  }

  if (!url) return null;
  if (!method) method = body ? "POST" : "GET";

  // Best-effort pretty-print JSON body so the editor shows a readable example;
  // leave non-JSON bodies (form data, raw text) untouched. Never touch a hex
  // binary body.
  if (!bodyEncoding) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // leave as-is
    }
  }

  return { url, method, headers, body, bodyEncoding };
}

// Split a parsed URL into (origin, pathWithQuery) — KB editor fills baseUrl
// and path separately so the user can adjust either side.
export function splitUrlForKb(url: string): { baseUrl: string; path: string } {
  try {
    const u = new URL(url);
    const baseUrl = `${u.protocol}//${u.host}`;
    const path = `${u.pathname}${u.search}`;
    return { baseUrl, path };
  } catch {
    return { baseUrl: "", path: url };
  }
}

// Lookup helper for headers — case-insensitive, returns empty string if missing.
export function getHeader(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return "";
}
