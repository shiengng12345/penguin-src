// packages/broker-core/src/error-map.ts
import type { BrokerError } from "@penguin/broker-contracts";

/** Pulsar uses 200 for reads, 202 for the schema compatibility check, and 204
 *  for writes. A `=== 200` check silently loses the latter two. */
export function isSuccess(status: number): boolean {
  return status === 200 || status === 202 || status === 204;
}

/** Recognises the one 500 that is a business result rather than a fault:
 *  the schema compatibility endpoint reports incompatibility by throwing. */
function isSchemaIncompatibility(status: number, reason: string | null, path: string): boolean {
  if (status !== 500 || !reason) return false;
  if (!path.includes("/schemas/")) return false;
  return /SchemaValidationException|IncompatibleSchemaException|schema compatibility check/i.test(reason);
}

/**
 * Measured against a real JWT-enabled Pulsar (Task 3 Step 6): a 401 is
 * returned for a missing token, a malformed token, an expired token, AND a
 * cryptographically valid token that simply lacks superuser privilege on a
 * superuser-gated endpoint (e.g. `GET /admin/v2/tenants`). The first three
 * are byte-identical generic Jetty HTML with no machine-readable reason; the
 * fourth is a 401 that *does* carry a JSON `reason`. Pulsar gives the caller
 * no way to tell these apart over HTTP, so claiming any one of them
 * ("token expired", "invalid token") would be presenting inference as fact.
 * This fallback is used only when no `reason` could be extracted from the
 * body (i.e. the caller's parse attempt returned null, as it does for the
 * Jetty HTML pages) — when a `reason` IS available (the superuser-gated
 * case), it is used as-is below, since it is itself an honest, specific
 * statement ("Unauthorized ... about operation ...") rather than a guess.
 */
const AUTHENTICATION_FAILED_FALLBACK =
  "Authentication failed. The server rejected this request as unauthenticated; " +
  "this can mean the credential is missing, malformed, or expired, or that a valid " +
  "credential lacks sufficient privilege for this operation. The server does not " +
  "distinguish between these cases over HTTP, so none of them can be reported as fact.";

/** Honest, readable, never-empty, never-HTML fallback for any status when no
 *  `reason` could be extracted from the response body (for example because
 *  the body was an HTML error page, not JSON). `bodyKind` does not correlate
 *  with `status` — a 401 can carry JSON or HTML — so this is reached purely
 *  because parsing failed, never because of which status code this is. */
function fallbackMessage(status: number): string {
  if (status === 401) return AUTHENTICATION_FAILED_FALLBACK;
  return `The server returned HTTP ${status} with no readable error detail in the response body.`;
}

export function mapHttpError(status: number, reason: string | null, path: string): BrokerError {
  // `reason` is the caller's best-effort parse of the response body. It may
  // be present or absent at ANY status, including 401 (see the fallback
  // comment above) — never branch on `status` to decide whether a `reason`
  // is plausible; always prefer it when it is non-empty, and degrade
  // gracefully to `fallbackMessage` only when it is not.
  const message = reason && reason.trim().length > 0 ? reason : fallbackMessage(status);

  if (isSchemaIncompatibility(status, reason, path)) {
    return { code: "SCHEMA_INCOMPATIBLE", message, retryable: false };
  }

  switch (status) {
    case 401: return { code: "AUTHENTICATION_FAILED", message, retryable: false };
    case 403: return { code: "FORBIDDEN", message, retryable: false };
    case 404: return { code: "NOT_FOUND", message, retryable: false };
    case 405: return { code: "NOT_SUPPORTED_HERE", message, retryable: false };
    case 409: return { code: "CONFLICT", message, retryable: false };
    case 429: return { code: "RATE_LIMITED", message, retryable: true };
    default:
      if (status >= 500) return { code: "SOURCE_UNAVAILABLE", message, retryable: true };
      return { code: "SOURCE_UNAVAILABLE", message, retryable: false };
  }
}

export function mapTransportError(err: {
  kind: "timeout" | "tls" | "connect" | "parse";
  message: string;
}): BrokerError {
  switch (err.kind) {
    case "timeout": return { code: "TIMEOUT", message: err.message, retryable: true };
    case "tls":     return { code: "TLS_ERROR", message: err.message, retryable: false };
    case "connect": return { code: "SOURCE_UNAVAILABLE", message: err.message, retryable: true };
    case "parse":   return { code: "MALFORMED_RESPONSE", message: err.message, retryable: false };
  }
}
