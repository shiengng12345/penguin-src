//! Live test. Requires: docker compose -f infra/broker/docker-compose.local.yml up -d
use penguin_lib::broker::capability;

const ADMIN: &str = "http://localhost:8080";
const BROKER: &str = "pulsar://localhost:6650";

/// Raw response body for the tenant/namespace's topic list, fetched fresh
/// each call. Compared byte-for-byte (not just parsed and re-sorted) so a
/// stray create-then-delete would still show up as a diff even if it
/// happened to leave the set of names unchanged (e.g. same count, different
/// transient ordering from a broker-side cache invalidation).
async fn topics_text() -> String {
    reqwest::get(format!("{ADMIN}/admin/v2/persistent/public/default"))
        .await
        .expect("admin REST reachable")
        .text()
        .await
        .expect("topic list response body")
}

#[tokio::test]
async fn discovery_reports_measured_facts_not_configured_ones() {
    let snap = capability::discover(ADMIN, BROKER, 10_000, true, None, false)
        .await
        .expect("discovery against the local broker");

    assert_eq!(snap.broker_version.as_deref(), Some("4.2.4"));
    assert!(snap.clusters.contains(&"standalone".to_string()));

    // These are the findings that shape Phases B, C and E. If any flips, the
    // affected phase's design is stale.
    assert!(!snap.peek_on_partitioned_allowed, "V-B4: peek is rejected on partitioned topics");
    assert!(snap.binary_protocol_reachable, "V-C3: :6650 must be reachable");
    assert!(snap.has_metrics);

    // Local Pulsar is unauthenticated, so `list_clusters` succeeds — and a
    // successful read is NOT evidence of write access (Stage 0 Task 2:
    // `probe_write` is gone, nothing here ever attempts an actual write).
    assert!(!snap.can_write, "this stage never attempts a write; can_write must default to false");
    assert!(!snap.can_write_probed, "a successful read must not be reported as a write measurement");
    assert!(
        snap.warnings.iter().any(|w| {
            let w = w.to_lowercase();
            w.contains("not measured") || w.contains("not probed")
        }),
        "the UI must be told can_write is unmeasured, not silently false: {:?}",
        snap.warnings
    );
}

#[tokio::test]
async fn discovery_on_an_unreachable_broker_fails_without_panicking() {
    let err = capability::discover("http://localhost:1", "pulsar://localhost:1", 2_000, true, None, false)
        .await
        .expect_err("an unreachable broker must produce an error, not a panic");
    assert!(err.retryable, "a connection failure is worth retrying");
}

/// CONTROLLER RULING on the Task 2 brief (Stage 0): Task 14's `probe_write`
/// created and deleted a real scratch topic to measure `can_write`,
/// unconditionally — including when `read_only` was set. `read_only` only
/// ever gated *whether the probe ran*, never whether a write path existed at
/// all; on a super-admin-scoped credential pointed at a real cluster, that
/// PUT/DELETE would genuinely execute. `probe_write` is now deleted outright
/// (grep -c -E '\.put\(|\.delete\(' over capability.rs is 0), so this
/// asserts the thing that actually matters: no write happens, under EITHER
/// value of `read_only` — not just the one the old code happened to guard.
#[tokio::test]
async fn discovery_never_writes_regardless_of_read_only_flag() {
    for read_only in [true, false] {
        let before = topics_text().await;

        let snap = capability::discover(ADMIN, BROKER, 10_000, true, None, read_only)
            .await
            .expect("discovery against the local broker");

        let after = topics_text().await;

        assert_eq!(
            before, after,
            "discover() must never create or delete a topic (read_only={read_only})"
        );
        assert!(!snap.can_write, "no write is ever attempted (read_only={read_only})");
        assert!(!snap.can_write_probed, "a successful read is not a write measurement (read_only={read_only})");
    }
}

/// The test that would have caught the original defect directly: run the
/// discovery path once against the real local broker and assert the topic
/// list is byte-identical before and after, not merely "no `broker-probe-`
/// name survived" (which a create-then-successfully-delete would also
/// satisfy).
#[tokio::test]
async fn topic_list_is_byte_identical_before_and_after_discovery() {
    let before = topics_text().await;

    let _snap = capability::discover(ADMIN, BROKER, 10_000, true, None, false)
        .await
        .expect("discovery against the local broker");

    let after = topics_text().await;

    assert_eq!(
        before, after,
        "discover() must not create or delete any topic — this is the check that would have \
         caught probe_write's PUT/DELETE in the first place"
    );
}
