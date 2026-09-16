//! Tests for `broker::commands::topic_detail`, split into their own file
//! (via `#[path]`) so `topic_detail.rs` stays under the 400-line module
//! cap — the same reason `broker::anomaly` splits into `anomaly_tests.rs`.
//! Included as `mod tests;` from `topic_detail.rs`.

use super::*;

#[test]
fn truncated_when_the_cap_left_topics_unsampled() {
    assert!(overview_is_truncated(150, MAX_OVERVIEW_TOPICS_SAMPLED));
}

#[test]
fn not_truncated_when_every_topic_was_sampled() {
    assert!(!overview_is_truncated(10, 10));
    assert!(!overview_is_truncated(0, 0));
}

/// Guards the boundary itself: sampling exactly the cap when the
/// namespace holds exactly that many topics is a complete sample, not a
/// truncated one. A `>=` in place of `>` here would falsely warn on
/// every namespace whose topic count exactly equals the cap.
#[test]
fn sampling_exactly_the_total_is_not_truncated() {
    assert!(!overview_is_truncated(MAX_OVERVIEW_TOPICS_SAMPLED, MAX_OVERVIEW_TOPICS_SAMPLED));
}

fn fail() -> BrokerError {
    BrokerError { code: BrokerErrorCode::SourceUnavailable, message: "unreachable".to_string(), retryable: true }
}

#[test]
fn a_successful_probe_produces_no_anomaly() {
    assert_eq!(capability_probe_anomaly("public/default", Ok("4.2.4".to_string())), None);
}

#[test]
fn a_failed_probe_produces_exactly_one_capability_probe_failed_anomaly_scoped_to_the_namespace() {
    let anomaly = capability_probe_anomaly("public/default", Err(fail())).expect("must produce an anomaly");
    assert_eq!(anomaly.kind, AnomalyKind::CapabilityProbeFailed);
    assert_eq!(anomaly.topic, "public/default", "scoped to the namespace, not a topic");
    assert_eq!(anomaly.subscription, None);
    assert_eq!(anomaly.observed_value, "unreachable", "must carry the actual probe failure, not a restatement");
    assert!(anomaly.detail.contains("basic capabilities"));
}

/// A trait double whose every method fails, used only to prove
/// `build_topic_detail` propagates a fetch failure as `Err` rather than
/// panicking or silently producing an empty/default detail. No real
/// `BrokerAdmin` mock existed anywhere in this codebase before this
/// test; every other broker test either exercises `PulsarAdminRest`
/// directly against the live broker, or (like `read_through_cache`)
/// never calls a `BrokerAdmin` method that could plausibly fail this
/// way in isolation.
struct FailingAdmin;

#[async_trait::async_trait]
impl BrokerAdmin for FailingAdmin {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        Err(fail())
    }
    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_namespaces(&self, _tenant: &str) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_topics(&self, _tenant: &str, _namespace: &str) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_partitioned_topics(&self, _tenant: &str, _namespace: &str) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn get_topic_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Err(fail())
    }
    async fn get_topic_internal_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Err(fail())
    }
    async fn list_subscriptions(&self, _topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
}

#[tokio::test]
async fn build_topic_detail_propagates_a_stats_fetch_failure_instead_of_swallowing_it() {
    let topic_ref = TopicRef { tenant: "public".into(), namespace: "default".into(), topic: "x".into(), persistent: true };
    let err = build_topic_detail(&FailingAdmin, &topic_ref).await.expect_err("must be Err, never a fabricated detail");
    assert_eq!(err.message, "unreachable");
}

/// A trait double that returns fixed, hand-built `stats`/`internalStats`
/// payloads engineered to trip both a `BacklogWithNoConsumer` and a
/// `BacklogOlderThanThreshold` anomaly. The live broker's own topics
/// (see `tests/broker_topic_detail.rs`) currently carry no backlog at
/// all, so an equality check against independently-derived anomalies
/// there is always comparing two empty lists — it would not catch a
/// wiring bug (wrong threshold, wrong topic name, a dropped
/// `derive_indeterminate_checks` call) that happened to still produce
/// an empty result. This canned payload is what actually exercises
/// `build_topic_detail`'s wiring end to end, independent of what the
/// live broker's business data happens to look like today.
struct CannedAdmin;

#[async_trait::async_trait]
impl BrokerAdmin for CannedAdmin {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        Err(fail())
    }
    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_namespaces(&self, _tenant: &str) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_topics(&self, _tenant: &str, _namespace: &str) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn list_partitioned_topics(&self, _tenant: &str, _namespace: &str) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
    async fn get_topic_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Ok(serde_json::json!({
            "msgRateIn": 1.0,
            "msgRateOut": 0.5,
            "msgThroughputIn": 10.0,
            "msgThroughputOut": 5.0,
            "storageSize": 100,
            "backlogSize": 5,
            "msgInCounter": 20,
            // Above OLDEST_BACKLOG_THRESHOLD_SECS (3600) — must trip
            // BacklogOlderThanThreshold.
            "oldestBacklogMessageAgeSeconds": 7200,
            "subscriptions": {
                "sub-a": {
                    "msgBacklog": 5,
                    "unackedMessages": 0,
                    "msgRateOut": 0.0,
                    "type": "Shared",
                    // Confirmed empty (not absent) — a known backlog
                    // with zero attached consumers must trip
                    // BacklogWithNoConsumer.
                    "consumers": []
                }
            }
        }))
    }
    async fn get_topic_internal_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Ok(serde_json::json!({
            "entriesAddedCounter": 20,
            "numberOfEntries": 20,
            "lastConfirmedEntry": "1:5",
            "cursors": {
                "sub-a": { "markDeletePosition": "1:0", "readPosition": "1:1", "messagesConsumedCounter": 0 }
            }
        }))
    }
    async fn list_subscriptions(&self, _topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
}

#[tokio::test]
async fn build_topic_detail_derives_both_anomalies_from_a_canned_payload() {
    let topic_ref = TopicRef { tenant: "public".into(), namespace: "default".into(), topic: "canned-topic".into(), persistent: true };
    let detail = build_topic_detail(&CannedAdmin, &topic_ref).await.expect("canned detail");

    assert_eq!(detail.topic, "canned-topic");
    assert_eq!(detail.stats.subscriptions.len(), 1);
    assert_eq!(detail.internal.cursors.len(), 1);
    assert_eq!(detail.internal.cursors[0].subscription, "sub-a");
    // Position is parsed structurally, not passed through as a string —
    // proves `internal` really is the parsed `InternalStats`, not the
    // raw JSON reflected back.
    assert_eq!(detail.internal.cursors[0].read_position.ledger_id, 1);
    assert_eq!(detail.internal.cursors[0].read_position.entry_id, 1);

    assert!(
        detail.anomalies.iter().any(|a| a.kind == AnomalyKind::BacklogWithNoConsumer),
        "got {:?}",
        detail.anomalies
    );
    assert!(
        detail.anomalies.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold),
        "got {:?}",
        detail.anomalies
    );
    assert!(
        detail.indeterminate.is_empty(),
        "every input here was known, not absent — nothing should be indeterminate: {:?}",
        detail.indeterminate
    );
}
