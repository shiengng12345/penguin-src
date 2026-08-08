// Shared curl → RestRequestRecord mapping with DEC #195 secret promotion.
//
// Used by:
// - RestCurlImportDialog (paste-curl-then-pick-collection flow)
// - RestRequestEditor URL bar onPaste (paste-curl-into-existing-request)
//
// Keeping the parse + auth-promote + body-infer logic in one place
// guarantees plaintext credentials are never written to app_kv / IPC /
// request history regardless of which entry point the user takes.

import { parseCurl, type ParsedCurl } from "@/lib/curl-parser";
import { jsonToFields } from "@/lib/rest-body-fields";
import { saveSecret } from "./rest-keychain";
import type {
  RestAuth,
  RestBody,
  RestHeader,
  RestMethod,
  RestRequestRecord,
} from "./rest-types";

export const API_KEY_HEADER_NAMES = new Set([
  "x-api-key",
  "x-api-token",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
]);

const VALID_METHODS = new Set<RestMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function inferBody(parsed: ParsedCurl): RestBody | undefined {
  if (!parsed.body) return undefined;
  // ANSI-C `$'...'` payload that decoded to raw bytes (e.g. a gRPC-Web frame)
  // → a hex binary body, sent byte-identically.
  if (parsed.bodyEncoding === "hex") {
    return { mode: "binary", content: parsed.body, encoding: "hex" };
  }
  const contentType = (
    findHeader(parsed.headers, "Content-Type") ?? ""
  ).toLowerCase();
  // A JSON-object body → land straight in the editable key-value form (it stays
  // in sync with the JSON tab). Non-object JSON (array/primitive) → JSON tab.
  const fields = jsonToFields(parsed.body);
  if (fields.length > 0) {
    return { mode: "key-value", fields };
  }
  if (contentType.includes("application/json")) {
    return { mode: "json", content: parsed.body };
  }
  // WHY: form-urlencoded imports stay raw — a fields-based form body would be
  // invisible here. Raw + the preserved Content-Type header sends byte-identical
  // form data.
  return { mode: "raw", content: parsed.body };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lc) return v;
  }
  return undefined;
}

// Promote Authorization / well-known API-key headers into req.auth via
// saveSecret() — the plaintext value goes to the OS keychain and the
// header is stripped from the kept list. If saveSecret fails (keychain
// unreachable), the header is kept rather than silently lost.
//
// Idempotent w.r.t. order — only the FIRST auth-like header wins; the
// rest fall through to the kept list. Multiple auth schemes in one
// curl is rare and ambiguous; rather than guess, we promote the first
// and keep the others as-is for the user to deal with.
export async function promoteAuthHeaders(
  rawHeaders: RestHeader[],
  collectionId: string,
): Promise<{ headers: RestHeader[]; auth?: RestAuth }> {
  const kept: RestHeader[] = [];
  let auth: RestAuth | undefined;
  for (const h of rawHeaders) {
    const lc = h.key.toLowerCase();
    if (lc === "authorization" && /^bearer\s+/i.test(h.value) && !auth) {
      try {
        const handle = await saveSecret({
          collectionId,
          key: `rest:imported:${Date.now()}:auth:bearer`,
          plaintext: h.value.trim(),
        });
        auth = { kind: "bearer", tokenHandleId: handle.id };
        continue;
      } catch {
        kept.push(h);
      }
      continue;
    }
    if (lc === "authorization" && /^basic\s+/i.test(h.value) && !auth) {
      const b64 = h.value.replace(/^basic\s+/i, "").trim();
      let username = "(from curl)";
      try {
        const decoded = atob(b64);
        const idx = decoded.indexOf(":");
        if (idx > 0) username = decoded.slice(0, idx);
      } catch {
        // base64 garbage — leave username as placeholder, still save value
      }
      try {
        const handle = await saveSecret({
          collectionId,
          key: `rest:imported:${Date.now()}:auth:basic`,
          plaintext: h.value.trim(),
        });
        auth = { kind: "basic", username, passwordHandleId: handle.id };
        continue;
      } catch {
        kept.push(h);
      }
      continue;
    }
    if (API_KEY_HEADER_NAMES.has(lc) && !auth) {
      try {
        const handle = await saveSecret({
          collectionId,
          key: `rest:imported:${Date.now()}:auth:api-key`,
          plaintext: h.value,
        });
        auth = {
          kind: "api-key",
          in: "header",
          name: h.key,
          valueHandleId: handle.id,
        };
        continue;
      } catch {
        kept.push(h);
      }
      continue;
    }
    kept.push(h);
  }
  return { headers: kept, auth };
}

// Outcome of applying a pasted curl to the current request. `null`
// means the input wasn't a curl command (caller should fall through to
// normal paste behavior); otherwise `patch` is the partial record to
// merge via the editor's onChange.
export interface CurlApplyResult {
  patch: Partial<RestRequestRecord>;
  promotedAuth: boolean;
  parsedHeaderCount: number;
  hasBody: boolean;
}

export async function applyCurlToRequest(
  curl: string,
  collectionId: string,
): Promise<CurlApplyResult | null> {
  const parsed = parseCurl(curl);
  if (!parsed) return null;
  const method = parsed.method.toUpperCase() as RestMethod;
  if (!VALID_METHODS.has(method)) return null;
  const rawHeaders: RestHeader[] = Object.entries(parsed.headers).map(
    ([key, value]) => ({ key, value, enabled: true }),
  );
  const { headers, auth } = await promoteAuthHeaders(rawHeaders, collectionId);
  const body = inferBody(parsed);
  return {
    patch: {
      method,
      url: parsed.url,
      headers,
      // WHY: the curl URL already encodes its own query string, and the
      // simplified editor has no Params tab — leftover queryParams from the
      // previous request would be appended invisibly on send. Clear them.
      queryParams: [],
      body,
      auth,
    },
    promotedAuth: !!auth,
    parsedHeaderCount: Object.keys(parsed.headers).length,
    hasBody: !!parsed.body,
  };
}
