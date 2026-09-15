//! Security boundary for the broker module.
//!
//! Local Pulsar is unauthenticated and accepts every write (spec V-E8), so
//! `read_only` is only meaningful if this module refuses to send. Likewise the
//! endpoint allowlist is what stops a crafted connection URL from turning the
//! Rust backend into an SSRF proxy.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use url::Url;

/// Proof that a write was authorized by [`WriteGuard::authorize`]. There is
/// no public constructor and no public fields: the only way to obtain one is
/// to ask a `WriteGuard` for it, so a write path that requires `&WritePermit`
/// (or ownership of one) cannot compile if the gate was skipped. Given that
/// the broker itself refuses nothing — every write returns 204
/// unauthenticated (spec V-E8) — a merely-advisory `Result` return value is
/// not a strong enough guarantee for the one function standing between an
/// operator and an irreversible write.
#[derive(Debug)]
pub struct WritePermit {
    action: String,
}

impl WritePermit {
    /// The action this permit was issued for, for logging/diagnostics.
    pub fn action(&self) -> &str {
        &self.action
    }
}

/// Refuses writes on a read-only connection before a request is ever built.
pub struct WriteGuard {
    read_only: bool,
}

impl WriteGuard {
    pub fn new(read_only: bool) -> Self {
        Self { read_only }
    }

    pub fn authorize(&self, action: &str) -> Result<WritePermit, BrokerError> {
        if self.read_only {
            return Err(BrokerError {
                code: BrokerErrorCode::ReadOnlyBlocked,
                message: format!("connection is read-only; `{action}` was not sent"),
                retryable: false,
            });
        }
        Ok(WritePermit { action: action.to_string() })
    }
}

/// Pins every request to the scheme, host and port of the connection's own URL.
///
/// This deliberately parses with the `url` crate rather than a hand-rolled
/// `scheme://host:port` splitter. `reqwest` itself builds every outgoing
/// request by parsing the target string with `url::Url` internally, so
/// using that same crate here guarantees this guard's notion of "the
/// target's origin" can never diverge from the origin `reqwest` will
/// actually connect to. A hand-rolled splitter agrees with `url` on
/// well-formed URLs but disagrees on embedded-credential and malformed
/// forms (e.g. `http://evil.com@localhost:8080/...`) — exactly where an
/// attacker would look for daylight between "what the guard thinks" and
/// "what the HTTP client does".
#[derive(Debug)]
pub struct EndpointGuard {
    scheme: String,
    host: String,
    port: Option<u16>,
}

/// Why a string could not be treated as a checkable origin. Deliberately
/// never carries the raw input or any credential extracted from it — only
/// what is safe to put in an operator-facing error message.
enum OriginError {
    /// Not an absolute `http`/`https` URL at all (unparseable, or
    /// scheme-/path-relative).
    Unparseable,
    /// Parsed fine, but carries a userinfo component (`user:pass@host` or
    /// `user@host`). Carries only the safe part of what was parsed — never
    /// the username or password — so a caller can still say *which* origin
    /// was rejected without echoing the credential back into a log.
    CredentialsPresent { scheme: String, host: String, port: Option<u16> },
}

fn describe_origin_error(err: &OriginError) -> String {
    match err {
        OriginError::Unparseable => {
            "could not be parsed as an absolute http(s) URL".to_string()
        }
        OriginError::CredentialsPresent { scheme, host, port } => match port {
            Some(port) => format!(
                "carries embedded credentials (user:pass@host) for {scheme}://{host}:{port} — remove them; this module does not accept credentials in the connection URL"
            ),
            None => format!(
                "carries embedded credentials (user:pass@host) for {scheme}://{host} — remove them; this module does not accept credentials in the connection URL"
            ),
        },
    }
}

/// Parses a URL's origin the same way `reqwest` will, and normalizes it so
/// that equivalent origins compare equal instead of being wrongly refused:
///
/// - `url::Url` already lowercases and IDNA-normalizes the host for
///   `http`/`https` (host comparison is case-insensitive per RFC 9110), so
///   `HTTP://LOCALHOST:8080` and `http://localhost:8080` match;
/// - a trailing dot on the hostname (an explicit FQDN root — DNS-equivalent
///   to the same name without it) is stripped;
/// - a default port written explicitly (`:80` for http, `:443` for https)
///   is treated the same as an omitted port, via `port_or_known_default`.
///
/// URLs carrying embedded credentials (`user:pass@host`) are refused
/// outright rather than parsed further: a userinfo component is a
/// well-known vector for host-parsing disagreements between tools (which
/// side of the `@` is "the host" is exactly the ambiguity attackers rely
/// on), and no caller in this module has a legitimate reason to send one.
fn split_origin(raw: &str) -> Result<(String, String, Option<u16>), OriginError> {
    let parsed = Url::parse(raw).map_err(|_| OriginError::Unparseable)?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(OriginError::CredentialsPresent {
            scheme: parsed.scheme().to_string(),
            host: parsed
                .host_str()
                .map(|h| h.trim_end_matches('.').to_string())
                .unwrap_or_default(),
            port: parsed.port_or_known_default(),
        });
    }
    let host = parsed
        .host_str()
        .ok_or(OriginError::Unparseable)?
        .trim_end_matches('.')
        .to_string();
    let port = parsed.port_or_known_default();
    Ok((parsed.scheme().to_string(), host, port))
}

impl EndpointGuard {
    pub fn new(base_url: &str) -> Result<Self, BrokerError> {
        let (scheme, host, port) = split_origin(base_url).map_err(|reason| BrokerError {
            code: BrokerErrorCode::Forbidden,
            message: format!("connection URL {}", describe_origin_error(&reason)),
            retryable: false,
        })?;
        Ok(Self { scheme, host, port })
    }

    pub fn check(&self, url: &str) -> Result<(), BrokerError> {
        let (scheme, host, port) = split_origin(url).map_err(|reason| BrokerError {
            code: BrokerErrorCode::Forbidden,
            message: format!("endpoint refused: target URL {}", describe_origin_error(&reason)),
            retryable: false,
        })?;
        if scheme != self.scheme || host != self.host || port != self.port {
            return Err(BrokerError {
                code: BrokerErrorCode::Forbidden,
                message: "endpoint refused: target is outside the connection's own origin".to_string(),
                retryable: false,
            });
        }
        Ok(())
    }
}

/// Case-insensitive names, in a query string, whose value is treated as a
/// credential and redacted. Not exhaustive by design: `redact`'s job is to
/// bias toward over-redaction (a benign field that merely looks sensitive
/// gets masked for free) rather than risk letting a real one through.
const SENSITIVE_QUERY_KEYS: &[&str] =
    &["token", "apikey", "api_key", "access_token", "refresh_token", "password", "secret"];

/// Strips credentials from any string a caller passes through it. This
/// function exists for callers that handle credential-bearing text headed
/// for a log, an error message, or `error_log` — but it currently has no
/// production callers: the broker token travels only in an Authorization
/// header, never in a URL, and `EndpointGuard` rejects URLs carrying
/// userinfo, so `EndpointProbe.reason` and `warnings` carry raw error text
/// today without a live leak. Any future logging path that carries
/// user-supplied or error text which could contain a credential should
/// route through this function rather than assuming the current call sites
/// are the only ones that ever will. Within what it does cover, this is the
/// full extent of it — anything else that looks like a secret but isn't one
/// of these shapes will pass through unredacted:
///
/// - `Authorization: Bearer <token>` / `bearer <token>` (case-insensitive
///   scheme, matched even lowercase since the header value is just as
///   sensitive either way);
/// - `Authorization: Basic <token>` / `basic <token>` (same, for HTTP Basic);
/// - URL userinfo — `scheme://user:pass@host/...` or `scheme://user@host/...`
///   in any `://`-delimited URL appearing in the text, replaced with `***@`
///   so the host stays visible for debugging;
/// - query-string parameters named (case-insensitively) `token`, `apikey`,
///   `api_key`, `access_token`, `refresh_token`, `password`, or `secret` —
///   the key name is kept and only the value is masked.
///
/// Each case repeats until no more matches remain and handles a match with
/// no trailing delimiter because it sits at the very end of the string, so a
/// line carrying more than one credential is fully redacted, not just the
/// first occurrence.
pub fn redact(text: &str) -> String {
    let text = redact_scheme_token(text, "bearer", "Bearer ***");
    let text = redact_scheme_token(&text, "basic", "Basic ***");
    let text = redact_url_userinfo(&text);
    redact_query_secrets(&text)
}

/// Redacts `"<scheme> <value>"` (case-insensitive on `scheme`, e.g. an
/// `Authorization` header's auth-scheme token) wherever it appears, replacing
/// the whole match with `marker` and stopping the value at the next
/// whitespace or end of string.
fn redact_scheme_token(text: &str, scheme: &str, marker: &str) -> String {
    let needle = format!("{scheme} ").to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        // `to_ascii_lowercase` never changes UTF-8 byte length or boundaries
        // (it only touches ASCII bytes), so byte offsets found against the
        // lowercased copy are valid offsets into `rest` itself.
        let lower = rest.to_ascii_lowercase();
        let Some(idx) = lower.find(&needle) else {
            break;
        };
        out.push_str(&rest[..idx]);
        out.push_str(marker);
        let after = &rest[idx + needle.len()..];
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Redacts the userinfo component of any `scheme://user[:pass]@host` (or
/// `scheme://user@host`) found in `text`, replacing it with `***@` and
/// leaving the host and everything else untouched.
fn redact_url_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(scheme_idx) = rest.find("://") else {
            break;
        };
        let authority_start = scheme_idx + 3;
        let authority = &rest[authority_start..];
        let authority_end = authority
            .find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace())
            .unwrap_or(authority.len());
        let authority_slice = &authority[..authority_end];
        // `rfind` (not `find`): the host begins right after the *last* `@`
        // in the authority, so this stays correct even in the unlikely case
        // a (percent-decoded) password itself contains an `@`.
        if let Some(at_idx) = authority_slice.rfind('@') {
            out.push_str(&rest[..authority_start]);
            out.push_str("***@");
            rest = &authority[at_idx + 1..];
        } else {
            out.push_str(&rest[..authority_start + authority_end]);
            rest = &authority[authority_end..];
        }
    }
    out.push_str(rest);
    out
}

/// Redacts the value of any `key=value` pair in `text` whose key
/// case-insensitively matches [`SENSITIVE_QUERY_KEYS`], keeping the key
/// visible and masking only the value.
fn redact_query_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let earliest = SENSITIVE_QUERY_KEYS
            .iter()
            .filter_map(|key| {
                let needle = format!("{key}=");
                lower.find(&needle).map(|idx| (idx, needle.len()))
            })
            .min_by_key(|(idx, _)| *idx);
        let Some((idx, needle_len)) = earliest else {
            break;
        };
        out.push_str(&rest[..idx + needle_len]);
        out.push_str("***");
        let after = &rest[idx + needle_len..];
        let end = after
            .find(|c: char| c == '&' || c == '#' || c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
#[path = "security/tests.rs"]
mod tests;
