//! Result envelope and error mapping. Mirrors packages/broker-core/src/error-map.ts —
//! the two must agree, or the UI and backend disagree about what a failure means.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrokerErrorCode {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    NotSupportedHere,
    Conflict,
    RateLimited,
    SchemaIncompatible,
    SourceUnavailable,
    Timeout,
    TlsError,
    MalformedResponse,
    ReadOnlyBlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerError {
    pub code: BrokerErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEnvelope<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    pub source: String,
    pub observed_at: String,
    pub freshness_ms: u64,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrokerError>,
}

impl<T> ResultEnvelope<T> {
    pub fn ok(data: T, source: &str) -> Self {
        Self {
            data: Some(data),
            source: source.to_string(),
            observed_at: now_rfc3339(),
            freshness_ms: 0,
            warnings: Vec::new(),
            error: None,
        }
    }

    pub fn failed(error: BrokerError, source: &str) -> Self {
        Self {
            data: None,
            source: source.to_string(),
            observed_at: now_rfc3339(),
            freshness_ms: 0,
            warnings: Vec::new(),
            error: Some(error),
        }
    }
}

/// RFC-3339 / ISO-8601 UTC timestamp, e.g. `2026-09-16T12:34:56.789+00:00`.
/// The TypeScript layer (`packages/broker-contracts/src/envelope.ts`) parses
/// `observedAt` with `new Date(...)`, which requires this shape — a bare Unix
/// seconds string like "1770000000" parses as Invalid Date.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Pulsar uses 200 for reads, 202 for the schema compatibility check, and 204
/// for writes. Checking `== 200` silently loses the latter two.
pub fn is_success(status: u16) -> bool {
    matches!(status, 200 | 202 | 204)
}

/// Recognises the one 500 that is a business result rather than a fault: the
/// schema compatibility endpoint reports incompatibility by throwing.
///
/// CORRECTION vs. the Task 10 brief: the brief's draft regex also matched the
/// loose phrase "schema compatibility check" alone. That phrase also appears
/// in genuine infrastructure faults (e.g. "Error during schema compatibility
/// check: connection to zookeeper lost"), which would then be misclassified
/// as SCHEMA_INCOMPATIBLE/non-retryable and send the operator to fix a schema
/// that was never wrong. This was already corrected on the TypeScript side
/// (packages/broker-core/src/error-map.ts) to require an actual exception
/// class name; this Rust port matches that corrected behavior, not the
/// brief's draft. The real incompatibility response body carries both the
/// phrase and one of these class names (see
/// tests/fixtures/broker/schema-incompatible-500.json), so nothing true is
/// lost by dropping the phrase-only alternative.
fn is_schema_incompatibility(status: u16, reason: Option<&str>, path: &str) -> bool {
    if status != 500 || !path.contains("/schemas/") {
        return false;
    }
    // Case-insensitive, matching the TypeScript reference
    // (`/SchemaValidationException|IncompatibleSchemaException/i`) exactly —
    // Rust is made to match TypeScript here, not the reverse.
    reason.is_some_and(|r| {
        let lower = r.to_lowercase();
        lower.contains("schemavalidationexception") || lower.contains("incompatibleschemaexception")
    })
}

/// A reasoned, non-empty fallback message for when no `reason` could be
/// extracted from the response body (for example, an HTML error page rather
/// than JSON). Mirrors `fallbackMessage` in error-map.ts.
fn fallback_message(status: u16) -> String {
    if status == 401 {
        return "Authentication failed. The server rejected this request as unauthenticated; \
                this can mean the credential is missing, malformed, or expired, or that a valid \
                credential lacks sufficient privilege for this operation. The server does not \
                distinguish between these cases over HTTP, so none of them can be reported as fact."
            .to_string();
    }
    format!("The server returned HTTP {status} with no readable error detail in the response body.")
}

/// `reason` is the caller's best-effort parse of the response body. It may be
/// present or absent at ANY status, including 401 — a 401 can carry a JSON
/// `reason` (a superuser-gated endpoint rejecting a valid-but-underprivileged
/// token) or byte-identical Jetty HTML with none. Never branch on `status` to
/// decide whether a `reason` is plausible; always prefer it when non-empty,
/// and degrade to `fallback_message` only when it is not.
pub fn map_http_error(status: u16, reason: Option<&str>, path: &str) -> BrokerError {
    // Matches error-map.ts: `reason && reason.trim().length > 0 ? reason : fallback`.
    // A whitespace-only reason counts as absent, but a genuinely present reason
    // is used verbatim, untrimmed — the two layers must show the operator the
    // exact same string, whitespace included.
    let reason = reason.filter(|r| !r.trim().is_empty());
    let message = reason.map(str::to_string).unwrap_or_else(|| fallback_message(status));

    if is_schema_incompatibility(status, reason, path) {
        return BrokerError { code: BrokerErrorCode::SchemaIncompatible, message, retryable: false };
    }

    let (code, retryable) = match status {
        401 => (BrokerErrorCode::AuthenticationFailed, false),
        403 => (BrokerErrorCode::Forbidden, false),
        404 => (BrokerErrorCode::NotFound, false),
        405 => (BrokerErrorCode::NotSupportedHere, false),
        409 => (BrokerErrorCode::Conflict, false),
        429 => (BrokerErrorCode::RateLimited, true),
        s if s >= 500 => (BrokerErrorCode::SourceUnavailable, true),
        _ => (BrokerErrorCode::SourceUnavailable, false),
    };
    BrokerError { code, message, retryable }
}

/// Classifies a reqwest failure. TLS is not retryable — a bad certificate will
/// still be bad on the next attempt.
pub fn map_reqwest_error(err: &reqwest::Error) -> BrokerError {
    let message = err.to_string();
    let (code, retryable) = if err.is_timeout() {
        (BrokerErrorCode::Timeout, true)
    } else if message.contains("certificate") || message.contains("tls") || message.contains("TLS") {
        (BrokerErrorCode::TlsError, false)
    } else if err.is_decode() {
        (BrokerErrorCode::MalformedResponse, false)
    } else {
        (BrokerErrorCode::SourceUnavailable, true)
    };
    BrokerError { code, message, retryable }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_spans_200_202_and_204() {
        assert!(is_success(200));
        assert!(is_success(202)); // schema compatibility check
        assert!(is_success(204)); // every write
        assert!(!is_success(404));
    }

    #[test]
    fn schema_incompatibility_is_a_result_not_a_fault() {
        let reason = "Error during schema compatibility check with strategy FULL: \
                      org.apache.avro.SchemaValidationException: Unable to read schema";
        let err = map_http_error(500, Some(reason), "/admin/v2/schemas/public/default/t/compatibility");
        assert_eq!(err.code, BrokerErrorCode::SchemaIncompatible);
        assert!(!err.retryable);
    }

    /// Drives the mapping directly off the captured real Pulsar response body
    /// (tests/fixtures/broker/schema-incompatible-500.json) rather than a
    /// hand-copied string literal — this project has already caught three
    /// hand-copied-constant defects, so evidence beats a literal here.
    #[test]
    fn schema_incompatibility_matches_captured_fixture() {
        let raw = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/broker/schema-incompatible-500.json"),
        )
        .expect("captured fixture should be readable from src-tauri/");
        let body: serde_json::Value = serde_json::from_str(&raw).expect("fixture should be valid JSON");
        let reason = body["reason"].as_str().expect("fixture should carry a `reason` field");

        let err = map_http_error(500, Some(reason), "/admin/v2/schemas/public/default/t/compatibility");
        assert_eq!(err.code, BrokerErrorCode::SchemaIncompatible);
        assert!(!err.retryable);
    }

    /// The correction this task makes over the brief's draft regex: a genuine
    /// infrastructure fault whose message merely mentions the phrase "schema
    /// compatibility check" (with no exception class name) must NOT be
    /// misclassified as SCHEMA_INCOMPATIBLE — a retry would actually help
    /// here, but telling the operator their schema is broken would not.
    #[test]
    fn schema_compatibility_phrase_without_exception_class_stays_retryable() {
        let reason = "Error during schema compatibility check: connection to zookeeper lost";
        let err = map_http_error(500, Some(reason), "/admin/v2/schemas/public/default/t/compatibility");
        assert_eq!(err.code, BrokerErrorCode::SourceUnavailable);
        assert!(err.retryable);
    }

    #[test]
    fn a_genuine_500_stays_retryable() {
        let err = map_http_error(500, Some("Internal server error"), "/admin/v2/tenants");
        assert_eq!(err.code, BrokerErrorCode::SourceUnavailable);
        assert!(err.retryable);
    }

    #[test]
    fn peek_on_partitioned_is_not_supported_here() {
        let err = map_http_error(405, Some("Peek messages on a partitioned topic is not allowed"), "/peek");
        assert_eq!(err.code, BrokerErrorCode::NotSupportedHere);
    }

    #[test]
    fn conflict_and_auth_are_terminal() {
        assert_eq!(map_http_error(409, None, "/x").code, BrokerErrorCode::Conflict);
        assert_eq!(map_http_error(401, None, "/x").code, BrokerErrorCode::AuthenticationFailed);
        assert_eq!(map_http_error(403, None, "/x").code, BrokerErrorCode::Forbidden);
        assert!(map_http_error(429, None, "/x").retryable);
    }

    /// A 401 sometimes carries JSON with a `reason`, sometimes Jetty HTML with
    /// none. Nothing in the mapper may branch on status to decide whether a
    /// reason exists — always use the reason when one was passed in, at any
    /// status, and only fall back when it is genuinely absent/blank.
    #[test]
    fn a_401_with_a_reason_uses_it_verbatim_not_the_generic_fallback() {
        let err = map_http_error(401, Some("Unauthorized to perform this operation"), "/admin/v2/tenants");
        assert_eq!(err.code, BrokerErrorCode::AuthenticationFailed);
        assert_eq!(err.message, "Unauthorized to perform this operation");
    }

    #[test]
    fn a_401_with_no_reason_falls_back_to_the_honest_generic_message() {
        let err = map_http_error(401, None, "/admin/v2/tenants");
        assert_eq!(err.code, BrokerErrorCode::AuthenticationFailed);
        assert!(err.message.contains("does not distinguish"));
    }

    /// A whitespace-only reason must count as absent, matching
    /// `reason.trim().length > 0` in error-map.ts.
    #[test]
    fn a_whitespace_only_reason_falls_back_like_no_reason_at_all() {
        let err = map_http_error(401, Some("   \n\t  "), "/admin/v2/tenants");
        assert_eq!(err.code, BrokerErrorCode::AuthenticationFailed);
        assert!(err.message.contains("does not distinguish"));
    }

    /// The message shown to the user must match TypeScript's exactly,
    /// including any surrounding whitespace in a genuinely present reason —
    /// error-map.ts does not trim it before using it as the message.
    #[test]
    fn a_present_reason_is_used_untrimmed_as_the_message() {
        let err = map_http_error(409, Some("  conflict detail  "), "/x");
        assert_eq!(err.message, "  conflict detail  ");
    }

    /// TypeScript matches the exception class names case-insensitively
    /// (`/SchemaValidationException|IncompatibleSchemaException/i`). Rust must
    /// agree, or the UI and backend classify the same response differently.
    #[test]
    fn schema_incompatibility_match_is_case_insensitive() {
        let reason = "error during schema compatibility check: \
                      org.apache.avro.schemavalidationexception: unable to read schema";
        let err = map_http_error(500, Some(reason), "/admin/v2/schemas/public/default/t/compatibility");
        assert_eq!(err.code, BrokerErrorCode::SchemaIncompatible);
        assert!(!err.retryable);
    }

    /// `observedAt` is parsed by the TypeScript layer with `new Date(...)`,
    /// which requires a real ISO-8601/RFC-3339 string, not a bare Unix
    /// seconds count.
    #[test]
    fn observed_at_is_a_valid_rfc3339_timestamp() {
        let envelope = ResultEnvelope::ok(42, "test");
        chrono::DateTime::parse_from_rfc3339(&envelope.observed_at)
            .expect("observed_at should parse as RFC-3339");
    }
}
