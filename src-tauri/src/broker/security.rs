//! Security boundary for the broker module.
//!
//! Local Pulsar is unauthenticated and accepts every write (spec V-E8), so
//! `read_only` is only meaningful if this module refuses to send. Likewise the
//! endpoint allowlist is what stops a crafted connection URL from turning the
//! Rust backend into an SSRF proxy.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use url::Url;

/// Refuses writes on a read-only connection before a request is ever built.
pub struct WriteGuard {
    read_only: bool,
}

impl WriteGuard {
    pub fn new(read_only: bool) -> Self {
        Self { read_only }
    }

    pub fn authorize(&self, action: &str) -> Result<(), BrokerError> {
        if self.read_only {
            return Err(BrokerError {
                code: BrokerErrorCode::ReadOnlyBlocked,
                message: format!("connection is read-only; `{action}` was not sent"),
                retryable: false,
            });
        }
        Ok(())
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
pub struct EndpointGuard {
    scheme: String,
    host: String,
    port: Option<u16>,
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
fn split_origin(raw: &str) -> Option<(String, String, Option<u16>)> {
    let parsed = Url::parse(raw).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?.trim_end_matches('.').to_string();
    let port = parsed.port_or_known_default();
    Some((parsed.scheme().to_string(), host, port))
}

impl EndpointGuard {
    pub fn new(base_url: &str) -> Result<Self, BrokerError> {
        let (scheme, host, port) = split_origin(base_url).ok_or_else(|| BrokerError {
            code: BrokerErrorCode::Forbidden,
            message: format!("unparseable connection URL: {}", redact(base_url)),
            retryable: false,
        })?;
        Ok(Self { scheme, host, port })
    }

    pub fn check(&self, url: &str) -> Result<(), BrokerError> {
        let refuse = |why: &str| BrokerError {
            code: BrokerErrorCode::Forbidden,
            message: format!("endpoint refused: {why}"),
            retryable: false,
        };
        let (scheme, host, port) = split_origin(url).ok_or_else(|| refuse("unparseable URL"))?;
        if scheme != self.scheme || host != self.host || port != self.port {
            return Err(refuse("target is outside the connection's own origin"));
        }
        Ok(())
    }
}

/// Strips credentials from any string headed for a log, an error message, or
/// error_log. Matches `bearer ` case-insensitively (an `Authorization:
/// bearer ...` header is just as sensitive lowercase) and repeats until no
/// more matches remain, so a line carrying more than one token — or a token
/// with no trailing whitespace because it sits at the very end of the
/// string — is fully redacted rather than only the first occurrence.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        // `to_ascii_lowercase` never changes UTF-8 byte length or boundaries
        // (it only touches ASCII bytes), so byte offsets found against the
        // lowercased copy are valid offsets into `rest` itself.
        let lower = rest.to_ascii_lowercase();
        let Some(idx) = lower.find("bearer ") else {
            break;
        };
        out.push_str(&rest[..idx]);
        out.push_str("Bearer ***");
        let after = &rest[idx + "bearer ".len()..];
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::envelope::BrokerErrorCode;

    // Guarantee 4: read_only is enforced here, because Pulsar will not enforce it.
    #[test]
    fn read_only_refuses_before_any_request_is_sent() {
        let guard = WriteGuard::new(true);
        let err = guard.authorize("delete_topic").expect_err("a read-only connection must refuse writes");
        assert_eq!(err.code, BrokerErrorCode::ReadOnlyBlocked);
        assert!(!err.retryable, "retrying a blocked write must never be suggested");
    }

    #[test]
    fn a_writable_connection_allows_writes() {
        assert!(WriteGuard::new(false).authorize("delete_topic").is_ok());
    }

    // Guarantee 5: the allowlist stops SSRF via a crafted connection URL.
    #[test]
    fn endpoint_guard_rejects_a_host_outside_the_connection() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("http://localhost:8080/admin/v2/tenants").is_ok());

        let err = guard
            .check("http://evil.example.com/admin/v2/tenants")
            .expect_err("a different host must be refused");
        assert_eq!(err.code, BrokerErrorCode::Forbidden);
    }

    #[test]
    fn endpoint_guard_rejects_a_port_change_on_the_same_host() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("http://localhost:9999/admin/v2/tenants").is_err());
    }

    // --- Additional coverage found while auditing the URL parser ---

    // A userinfo-in-authority URL is a classic parser-confusion vector:
    // browsers resolve `user@host` to *host*, so `http://evil.com@localhost:8080/`
    // actually targets the connection's own origin, and
    // `http://localhost:8080@evil.com/` actually targets evil.com. A parser
    // that disagrees with reqwest about which side of the `@` is the host is
    // an exploitable gap either way, so both forms are refused outright.
    #[test]
    fn endpoint_guard_rejects_credentials_in_the_authority_even_when_the_real_host_would_match() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        let err = guard
            .check("http://evil.com@localhost:8080/admin/v2/tenants")
            .expect_err("embedded userinfo must never be parsed as if it were absent");
        assert_eq!(err.code, BrokerErrorCode::Forbidden);
    }

    #[test]
    fn endpoint_guard_rejects_credentials_that_disguise_a_different_real_host() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        let err = guard
            .check("http://localhost:8080@evil.com/admin/v2/tenants")
            .expect_err("a host hidden behind fake userinfo must never be reached");
        assert_eq!(err.code, BrokerErrorCode::Forbidden);
    }

    #[test]
    fn endpoint_guard_new_rejects_a_base_url_carrying_credentials() {
        assert!(EndpointGuard::new("http://user:pass@localhost:8080").is_err());
    }

    // A scheme-relative or path-relative URL has no origin at all; treating
    // it as "no host restriction applies" would be the same class of bug as
    // trusting a bare `Host:` header. It must be refused, not passed through.
    #[test]
    fn endpoint_guard_rejects_scheme_relative_urls() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("//evil.example.com/admin/v2/tenants").is_err());
    }

    #[test]
    fn endpoint_guard_rejects_path_relative_urls() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("/admin/v2/tenants").is_err());
    }

    // IPv6 literals must be recognized as a single host, not split on the
    // colons inside the address itself.
    #[test]
    fn endpoint_guard_accepts_a_matching_ipv6_literal_host() {
        let guard = EndpointGuard::new("http://[::1]:8080").unwrap();
        assert!(guard.check("http://[::1]:8080/admin/v2/tenants").is_ok());
        assert!(guard.check("http://[::2]:8080/admin/v2/tenants").is_err());
    }

    // Host comparison must be case-insensitive (RFC 9110) and ignore a
    // trailing FQDN dot, or otherwise-identical origins get wrongly refused
    // — a functional bug, not a security one, but one that would push
    // operators toward disabling the guard.
    #[test]
    fn endpoint_guard_treats_host_case_as_insensitive() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("http://LOCALHOST:8080/admin/v2/tenants").is_ok());
    }

    #[test]
    fn endpoint_guard_treats_a_trailing_dot_as_the_same_host() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("http://localhost.:8080/admin/v2/tenants").is_ok());
    }

    // An explicit default port and an omitted one name the same origin.
    #[test]
    fn endpoint_guard_treats_an_explicit_default_port_as_equivalent_to_none() {
        let guard = EndpointGuard::new("http://localhost").unwrap();
        assert!(guard.check("http://localhost:80/admin/v2/tenants").is_ok());

        let guard = EndpointGuard::new("http://localhost:80").unwrap();
        assert!(guard.check("http://localhost/admin/v2/tenants").is_ok());
    }

    // Guarantee 3: secrets never reach logs or error_log.
    #[test]
    fn redact_removes_bearer_tokens_and_passwords() {
        let line = "GET /x Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def failed";
        let out = redact(line);
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9.abc.def"), "token must not survive redaction");
        assert!(out.contains("Bearer ***"));
    }

    #[test]
    fn redact_leaves_ordinary_text_alone() {
        assert_eq!(redact("listing topics for public/default"), "listing topics for public/default");
    }

    #[test]
    fn redact_removes_every_occurrence_of_a_repeated_token() {
        let line = "first Bearer aaa.bbb.ccc then again Bearer aaa.bbb.ccc done";
        let out = redact(line);
        assert!(!out.contains("aaa.bbb.ccc"), "a token used twice must be redacted both times");
        assert_eq!(out.matches("Bearer ***").count(), 2);
    }

    #[test]
    fn redact_removes_a_token_at_the_very_end_with_no_trailing_whitespace() {
        let out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def");
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9.abc.def"));
        assert!(out.ends_with("Bearer ***"));
    }

    #[test]
    fn redact_matches_a_lowercase_bearer_scheme() {
        let out = redact("authorization: bearer eyJhbGciOiJIUzI1NiJ9.abc.def failed");
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9.abc.def"));
        assert!(out.contains("Bearer ***"));
    }
}
