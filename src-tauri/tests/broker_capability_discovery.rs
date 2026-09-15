//! Live test. Requires: docker compose -f infra/broker/docker-compose.local.yml up -d
use penguin_lib::broker::capability;

const ADMIN: &str = "http://localhost:8080";
const BROKER: &str = "pulsar://localhost:6650";

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
    assert!(snap.can_write, "V-E8: local Pulsar accepts writes from anyone");
    assert!(snap.can_write_probed, "a non-read-only connection must actually attempt the probe");
    assert!(snap.has_metrics);
}

#[tokio::test]
async fn discovery_on_an_unreachable_broker_fails_without_panicking() {
    let err = capability::discover("http://localhost:1", "pulsar://localhost:1", 2_000, true, None, false)
        .await
        .expect_err("an unreachable broker must produce an error, not a panic");
    assert!(err.retryable, "a connection failure is worth retrying");
}

/// CONTROLLER RULING on the Task 14 brief: the brief's `probe_write` created
/// and deleted a real scratch topic to measure `can_write` regardless of the
/// connection's `read_only` flag — itself a write, on the one connection
/// where a write is exactly what must never happen. This is the test that
/// would have failed against that design: on a read-only connection the
/// probe must never run, `can_write` must come back `false`, and the UI must
/// be told this is "not measured", not "measured as unwritable".
#[tokio::test]
async fn a_read_only_connection_is_never_probed_for_write() {
    let snap = capability::discover(ADMIN, BROKER, 10_000, true, None, true)
        .await
        .expect("discovery against the local broker");

    assert!(!snap.can_write, "an unprobed connection must never claim can_write: true");
    assert!(!snap.can_write_probed, "read-only discovery must record that the probe did not run");
    assert!(
        snap.warnings.iter().any(|w| {
            let w = w.to_lowercase();
            w.contains("read-only") || w.contains("read only")
        }),
        "the UI must be told WHY can_write is false: {:?}",
        snap.warnings
    );
}

#[tokio::test]
async fn write_probe_leaves_no_scratch_topic_behind() {
    let _snap = capability::discover(ADMIN, BROKER, 10_000, true, None, false)
        .await
        .expect("discovery against the local broker");

    let res = reqwest::get(format!("{ADMIN}/admin/v2/persistent/public/default"))
        .await
        .expect("admin REST reachable");
    let topics: Vec<String> = res.json().await.expect("topic list is JSON");
    assert!(
        topics.iter().all(|t| !t.contains("broker-probe")),
        "a scratch topic survived discovery: {topics:?}"
    );
}
