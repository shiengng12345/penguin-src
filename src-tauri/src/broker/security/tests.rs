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

    // A `WritePermit` is the compile-time proof that the gate was consulted;
    // it should still carry which action it was issued for.
    #[test]
    fn a_write_permit_carries_the_authorized_action() {
        let permit = WriteGuard::new(false).authorize("delete_topic").unwrap();
        assert_eq!(permit.action(), "delete_topic");
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

    // CRITICAL 1: the rejection error must never echo the credential it
    // just refused — not the username, not the password.
    #[test]
    fn endpoint_guard_new_error_never_echoes_the_rejected_credentials() {
        let err = EndpointGuard::new("http://sensitive-user:sensitive-pass@localhost:8080")
            .expect_err("a base URL with embedded credentials must be rejected");
        assert!(!err.message.contains("sensitive-user"), "username leaked into error message: {}", err.message);
        assert!(!err.message.contains("sensitive-pass"), "password leaked into error message: {}", err.message);
    }

    #[test]
    fn endpoint_guard_check_error_never_echoes_the_rejected_credentials() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        let err = guard
            .check("http://sensitive-user:sensitive-pass@localhost:8080/admin/v2/tenants")
            .expect_err("a checked URL with embedded credentials must be rejected");
        assert!(!err.message.contains("sensitive-user"), "username leaked into error message: {}", err.message);
        assert!(!err.message.contains("sensitive-pass"), "password leaked into error message: {}", err.message);
    }

    // MINOR 4: a credentialed URL parsed fine — it was refused for carrying
    // credentials, not because it was unparseable — so the message must say so.
    #[test]
    fn endpoint_guard_new_error_names_credentials_not_unparseable() {
        let err = EndpointGuard::new("http://user:pass@localhost:8080").unwrap_err();
        assert!(err.message.contains("credentials"), "message should name the real reason: {}", err.message);
        assert!(!err.message.contains("unparseable"), "message should not call a parsed URL unparseable: {}", err.message);
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

    // CRITICAL 2: redact's contract must cover Basic auth, URL userinfo, and
    // sensitive query parameters, not just Bearer.
    #[test]
    fn redact_removes_basic_auth_tokens() {
        let out = redact("Authorization: Basic dXNlcjpwYXNzd29yZA== failed");
        assert!(!out.contains("dXNlcjpwYXNzd29yZA=="));
        assert!(out.contains("Basic ***"));
    }

    #[test]
    fn redact_matches_a_lowercase_basic_scheme() {
        let out = redact("authorization: basic dXNlcjpwYXNzd29yZA==");
        assert!(!out.contains("dXNlcjpwYXNzd29yZA=="));
        assert!(out.contains("Basic ***"));
    }

    #[test]
    fn redact_removes_url_userinfo_but_keeps_the_host_visible() {
        let out = redact("connecting to http://admin:hunter2@localhost:8080/admin/v2/tenants");
        assert!(!out.contains("admin:hunter2"));
        assert!(out.contains("http://***@localhost:8080/admin/v2/tenants"));
    }

    #[test]
    fn redact_removes_a_username_only_userinfo() {
        let out = redact("http://admin@localhost:8080/x");
        assert!(!out.contains("admin@"));
        assert!(out.contains("http://***@localhost:8080/x"));
    }

    #[test]
    fn redact_removes_a_token_query_parameter() {
        let out = redact("GET /health?token=abc123XYZ HTTP/1.1");
        assert!(!out.contains("abc123XYZ"));
        assert!(out.contains("token=***"));
    }

    #[test]
    fn redact_removes_an_apikey_query_parameter() {
        let out = redact("GET /health?apikey=abc123XYZ&other=1 HTTP/1.1");
        assert!(!out.contains("abc123XYZ"));
        assert!(out.contains("apikey=***"));
        assert!(out.contains("&other=1"), "unrelated query params must survive");
    }
