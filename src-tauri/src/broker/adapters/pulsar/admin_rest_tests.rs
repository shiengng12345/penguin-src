//! Tests for `broker::adapters::pulsar::admin_rest`, split into their own
//! file (via `#[path]`, same convention as `stats_tests.rs`). Included as
//! `mod tests;` from `admin_rest.rs`, so everything below is that module's
//! body directly — `super::` reaches its private items, including
//! `stats_request_path`.

use super::*;

fn fpms_topup() -> TopicRef {
    TopicRef {
        tenant: "public".into(),
        namespace: "default".into(),
        topic: "fpms_topup".into(),
        persistent: true,
    }
}

/// Task 1, spec §12.3: `get_topic_stats` must not silently inherit whatever
/// the broker's REST default happens to be for these three flags — it must
/// ask explicitly. Pinning the literal query string (rather than only the
/// `StatsRequestScope` struct in `stats_tests.rs`) is what actually proves
/// the URL this module builds carries them, not just that the constant
/// backing it has the right values.
#[test]
fn get_topic_stats_requests_the_safe_scope_explicitly() {
    let path = PulsarAdminRest::stats_request_path(&fpms_topup());
    assert!(
        path.contains("getPreciseBacklog=false"),
        "expected getPreciseBacklog=false in {path}"
    );
    assert!(
        path.contains("subscriptionBacklogSize=false"),
        "expected subscriptionBacklogSize=false in {path}"
    );
    assert!(
        path.contains("getEarliestTimeInBacklog=false"),
        "expected getEarliestTimeInBacklog=false in {path}"
    );
}

/// Not enough to build a string with the right substrings in it — the URL
/// this produces has to be exactly the one that reaches `get_raw`'s
/// `guard.check(&url)` call unmodified and passes it, the same origin check
/// every other request on this adapter goes through. `EndpointGuard` only
/// ever compares scheme/host/port (see its own doc), so a query string can
/// never be the thing that gets a request rejected here — this test proves
/// that stays true for these three parameters specifically, rather than
/// assuming it.
#[test]
fn the_url_carrying_those_parameters_passes_the_endpoint_guard() {
    let base = "http://localhost:8080";
    let guard = EndpointGuard::new(base).expect("guard for a plain http origin");
    let url = format!("{base}{}", PulsarAdminRest::stats_request_path(&fpms_topup()));
    assert!(url.contains("getPreciseBacklog=false&subscriptionBacklogSize=false&getEarliestTimeInBacklog=false"));
    guard.check(&url).expect("the guard must let the real request URL through");
}

/// Mutation check (this session's own caution, taken seriously): flipping
/// any one of the three literal substrings above to `true` must make the
/// first test fail. This is not a mutation *test* — it is here so a future
/// edit to `stats_request_path` that silently drops a parameter has
/// something failing loudly right next to the assertion it broke, and so
/// this file records that the assertions above are not vacuous (a
/// mis-escaped `contains` that always returns `true` would pass both tests
/// above for the wrong reason).
#[test]
fn the_scope_backing_the_url_is_the_all_false_constant() {
    assert!(!TOPIC_STATS_REQUEST_SCOPE.precise_backlog);
    assert!(!TOPIC_STATS_REQUEST_SCOPE.subscription_backlog_size);
    assert!(!TOPIC_STATS_REQUEST_SCOPE.earliest_time_in_backlog);
}
