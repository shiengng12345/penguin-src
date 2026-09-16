//! Live test. Requires: docker compose -f infra/broker/docker-compose.local.yml up -d
//!
//! Task 14: drives the same call sequence the UI does, against the live
//! broker — tenants -> namespaces -> topics (the topology tree's own path),
//! then one real topic's detail, then anomaly derivation over whatever that
//! topic's live state happens to be. This is the regression-testable half
//! of the manual GUI walkthrough (task-14-brief.md, Step 4): it proves the
//! data path end to end without needing a running Tauri window, but it does
//! not — and cannot — prove the window itself renders correctly. See
//! task-14-report.md for the walkthrough checklist a human still owes this
//! phase.
//!
//! Read-only throughout: never touches anything under the `broker-probe-`
//! prefix, never creates or deletes a topic, and asserts on the *shape* of
//! whatever `derive_anomalies` returns rather than a fixed count — the
//! live `fpms_topup` topic's actual backlog/consumer state can change
//! between runs, and this test must not become flaky by asserting a
//! snapshot of production data.
use penguin_lib::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use penguin_lib::broker::anomaly::{derive_anomalies, AnomalyKind};
use penguin_lib::broker::ports::{BrokerAdmin, TopicRef};
use penguin_lib::broker::stats::parse_topic_stats;

#[tokio::test]
async fn the_console_path_works_against_the_real_broker() {
    let admin = PulsarAdminRest::new("http://localhost:8080".into(), 10_000, true, None).unwrap();

    // 1. tenants -> namespaces -> topics, the tree's own path
    let tenants = admin.list_tenants().await.expect("tenants");
    assert!(tenants.contains(&"public".to_string()));

    let namespaces = admin.list_namespaces("public").await.expect("namespaces");
    assert!(namespaces.iter().any(|n| n == "public/default"));

    let topics = admin.list_topics("public", "default").await.expect("topics");
    assert!(topics.iter().any(|t| t.ends_with("/fpms_topup")));

    // 2. topic detail for the user's real topic
    let topic = TopicRef {
        tenant: "public".into(),
        namespace: "default".into(),
        topic: "fpms_topup".into(),
        persistent: true,
    };
    let stats = parse_topic_stats(&admin.get_topic_stats(&topic).await.expect("stats"))
        .expect("stats parse");
    assert_eq!(stats.subscriptions.len(), 2);

    // 3. anomaly derivation runs over real data without panicking, whatever
    //    the live state happens to be
    let found = derive_anomalies("fpms_topup", &stats, 3600);
    for a in &found {
        assert!(!a.observed_value.is_empty(), "every anomaly names its measurement");
        assert!(
            matches!(
                a.kind,
                AnomalyKind::BacklogWithNoConsumer
                    | AnomalyKind::ConsumerBlockedOnUnacked
                    | AnomalyKind::BacklogOlderThanThreshold
            ),
            "unexpected kind {:?}",
            a.kind
        );
    }
}
