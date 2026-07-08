// Serialize a REST request to a copy-pasteable cURL command. Used by
// RestRequestEditor's "Copy curl" button.
//
// Auth handling: previously redacted (DEC #195 paranoid mode — kept
// plaintext off the clipboard). That decision was relaxed at user
// request once we switched to local-file secret storage and inline
// plaintext display in the Authorization tab. Copy-curl now emits the
// real values so the user can paste the curl into a terminal and have
// it work without manual fill-in.
//
// The plaintext for secret-handle auth comes from resolveSecretPlain
// — process-local IPC, no network. buildCurl is async because of this.

import { resolveSecretPlain } from "./rest-keychain";
import { fieldsToJson } from "@/lib/rest-body-fields";
import type { RestHeader, RestRequestRecord } from "./rest-types";

export async function buildCurl(req: RestRequestRecord): Promise<string> {
  const lines: string[] = [`curl -X ${req.method}`];

  for (const h of req.headers) {
    if (!h.enabled || !h.key.trim()) continue;
    lines.push(`  -H ${shellQuote(`${h.key}: ${h.value}`)}`);
  }

  // Resolve auth handles to plaintext + emit a real curl flag the
  // user can paste straight into a terminal. Missing handle / empty
  // resolved value falls back to a visible placeholder so the curl
  // still tells the recipient WHERE to put the credential.
  if (req.auth) {
    if (req.auth.kind === "bearer" && req.auth.tokenHandleId) {
      const plain = await safePlain(req.auth.tokenHandleId);
      // Keychain stores the full "Bearer <token>" string — emit as
      // an Authorization header, not -H + manual prefix.
      lines.push(`  -H ${shellQuote(`Authorization: ${plain || "Bearer <token>"}`)}`);
    } else if (req.auth.kind === "basic" && req.auth.passwordHandleId) {
      const plain = await safePlain(req.auth.passwordHandleId);
      // Keychain stores the full "Basic <base64>" header value — but
      // curl's -u flag is more idiomatic. Decode if we can; fall back
      // to the raw Authorization header otherwise.
      const decoded = decodeBasic(plain);
      if (decoded) {
        lines.push(`  -u ${shellQuote(decoded)}`);
      } else {
        lines.push(`  -H ${shellQuote(`Authorization: ${plain || "Basic <base64>"}`)}`);
      }
    } else if (
      req.auth.kind === "api-key" &&
      req.auth.name.trim() &&
      req.auth.valueHandleId
    ) {
      const plain = await safePlain(req.auth.valueHandleId);
      if (req.auth.in === "query") {
        // Query-param api-key: merge into the URL builder by treating
        // it like a synthetic queryParam row.
        // (URL builder is downstream — encode here.)
        const sep = (req.url.includes("?") ? "&" : "?");
        // Mutate `lines` so the URL we emit at the bottom carries it.
        // Done via a closure on extraQuery below.
        extraQueryFromAuth = `${sep}${encodeURIComponent(req.auth.name.trim())}=${encodeURIComponent(plain)}`;
      } else {
        lines.push(`  -H ${shellQuote(`${req.auth.name.trim()}: ${plain}`)}`);
      }
    }
  }

  if (req.body) {
    if (req.body.mode === "json") {
      lines.push(`  -H 'Content-Type: application/json'`);
      lines.push(`  -d ${shellQuote(req.body.content)}`);
    } else if (req.body.mode === "key-value") {
      // Typed key→value rows export as the JSON body they produce.
      lines.push(`  -H 'Content-Type: application/json'`);
      lines.push(`  -d ${shellQuote(fieldsToJson(req.body.fields))}`);
    } else if (req.body.mode === "raw") {
      lines.push(`  -d ${shellQuote(req.body.content)}`);
    } else if (req.body.mode === "form-urlencoded") {
      lines.push(`  -H 'Content-Type: application/x-www-form-urlencoded'`);
      const parts: string[] = [];
      for (const f of req.body.fields as RestHeader[]) {
        if (!f.enabled || !f.key.trim()) continue;
        parts.push(`${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`);
      }
      if (parts.length > 0) lines.push(`  -d ${shellQuote(parts.join("&"))}`);
    } else if (req.body.mode === "binary") {
      lines.push(`  --data-binary '<binary payload — base64 omitted from curl export>'`);
    }
  }

  // URL goes last so the curl reads top-to-bottom (verb → headers → body → URL).
  // extraQueryFromAuth is appended when api-key auth targets ?query.
  lines.push(`  ${shellQuote(buildUrlWithQueryParams(req) + extraQueryFromAuth)}`);
  extraQueryFromAuth = "";

  return lines.join(" \\\n");
}

// Set by the api-key/query branch above so the URL line at the bottom
// can append it without restructuring the function. Cleared on return.
let extraQueryFromAuth = "";

async function safePlain(handleId: string): Promise<string> {
  try {
    const r = await resolveSecretPlain({ id: handleId });
    return r.plaintext;
  } catch {
    return "";
  }
}

function decodeBasic(stored: string): string | null {
  // Stored form is "Basic <base64(user:pass)>" — peel the prefix +
  // base64-decode. Returns null if the shape doesn't match.
  const m = stored.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    return atob(m[1]);
  } catch {
    return null;
  }
}

// POSIX shell single-quote: only need to escape `'` itself. Wrapping in
// single quotes preserves everything else (including `$`, `\n`, etc.).
function shellQuote(input: string): string {
  return `'${input.replace(/'/g, "'\\''")}'`;
}

function buildUrlWithQueryParams(req: RestRequestRecord): string {
  const enabled = req.queryParams.filter((q) => q.enabled && q.key.trim());
  if (enabled.length === 0) return req.url;
  // If the URL already has a query string, append with & — otherwise ?
  const joiner = req.url.includes("?") ? "&" : "?";
  const qs = enabled
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`)
    .join("&");
  return `${req.url}${joiner}${qs}`;
}
