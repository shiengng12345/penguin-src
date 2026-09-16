//! Tests for `broker::commands::topic_detail`'s `build_topic_detail` path,
//! split into their own file (via `#[path]`) so `topic_detail.rs` stays
//! under the 400-line module cap — the same reason `broker::anomaly` splits
//! into `anomaly_tests.rs`. Included as `mod tests;` from `topic_detail.rs`.
//!
//! Overview-level tests (truncation, the capability probe, and
//! `sample_overview`'s indeterminate/topics-unavailable accounting) moved
//! out to `topic_detail_overview_tests.rs` when this file reached the cap —
//! see that file's own module doc.

use super::*;

fn fail() -> BrokerError {
    BrokerError { code: BrokerErrorCode::SourceUnavailable, message: "unreachable".to_string(), retryable: true }
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
}

#[tokio::test]
async fn build_topic_detail_propagates_a_stats_fetch_failure_instead_of_swallowing_it() {
    let topic_ref = TopicRef { tenant: "public".into(), namespace: "default".into(), topic: "x".into(), persistent: true };
    let err = build_topic_detail(&FailingAdmin, &topic_ref).await.expect_err("must be Err, never a fabricated detail");
    assert_eq!(err.message, "unreachable");
}

/// A trait double that returns fixed, hand-built `stats`/`internalStats`
/// payloads engineered to trip a `BacklogWithNoConsumer` anomaly and (via
/// `oldestBacklogMessageAgeSeconds: 7200`, above `OLDEST_BACKLOG_THRESHOLD_SECS`)
/// exercise the `BacklogOlderThanThreshold` check. The live broker's own
/// topics (see `tests/broker_topic_detail.rs`) currently carry no backlog at
/// all, so an equality check against independently-derived anomalies there
/// is always comparing two empty lists — it would not catch a wiring bug
/// (wrong threshold, wrong topic name, a dropped
/// `derive_indeterminate_checks` call) that happened to still produce an
/// empty result. This canned payload is what actually exercises
/// `build_topic_detail`'s wiring end to end, independent of what the live
/// broker's business data happens to look like today.
///
/// Whole-stage review item 2: `build_topic_detail` always parses through the
/// real `TOPIC_STATS_REQUEST_SCOPE`, which has `earliest_time_in_backlog:
/// false` — so however old this payload's `oldestBacklogMessageAgeSeconds`
/// claims to be, `derive_anomalies`/`derive_indeterminate_checks` must not
/// trust it as measured. The `BacklogOlderThanThreshold` check therefore
/// never fires through this real pipeline; it shows up as an
/// `IndeterminateCheck` instead (see the test below) — that is the fix, not
/// a gap in this double.
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
            // Above OLDEST_BACKLOG_THRESHOLD_SECS (3600) — but
            // TOPIC_STATS_REQUEST_SCOPE.earliest_time_in_backlog is false, so
            // this must never be trusted as measured (whole-stage review
            // item 2): it surfaces as an IndeterminateCheck, not an anomaly.
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
}

#[tokio::test]
async fn build_topic_detail_derives_an_anomaly_and_an_indeterminate_check_from_a_canned_payload() {
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
    // Whole-stage review item 2: `oldestBacklogMessageAgeSeconds: 7200` in
    // the canned payload above is past the threshold, but
    // `TOPIC_STATS_REQUEST_SCOPE.earliest_time_in_backlog` is `false` on the
    // real pipeline this test exercises — so that reading is never trusted
    // as measured. `BacklogOlderThanThreshold` must not appear as an
    // anomaly here...
    assert!(
        !detail.anomalies.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold),
        "an unrequested backlog age must never raise BacklogOlderThanThreshold, got {:?}",
        detail.anomalies
    );
    // ...and the check must not silently vanish either: it has to appear as
    // an indeterminate check instead, so an empty `indeterminate` never
    // reads as "every check ran and found nothing" when this one never ran.
    assert!(
        detail
            .indeterminate
            .iter()
            .any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold && c.subscription.is_none()),
        "got {:?}",
        detail.indeterminate
    );
}
