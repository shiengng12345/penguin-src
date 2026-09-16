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

// --- Fix round 1, item 1: prove `indeterminate` is not just carried in the
// type signature but actually reaches the caller non-empty when a field is
// genuinely absent. `CannedAdmin` above deliberately makes every field
// known (so it always produces an empty `indeterminate`), and the live
// `fpms_topup` topic (see `tests/broker_topic_detail.rs`) happens to report
// every field too — neither can distinguish the real wiring from
// `indeterminate: Vec::new()` hardcoded and `derive_indeterminate_checks`
// never called at all. This mock omits `consumers` from a subscription
// entirely (not `consumers: []`, which is a known, confirmed fact) so that
// check is genuinely un-answerable. ---
struct MissingConsumersAdmin {
    /// Lets one mock double serve both this item's `build_topic_detail`
    /// test and item 2's `sample_overview` test — the latter needs the
    /// capability probe to succeed so it is not conflated with the
    /// `CapabilityProbeFailed` case exercised separately below.
    broker_version_result: fn() -> Result<String, BrokerError>,
}

impl MissingConsumersAdmin {
    fn probe_succeeds() -> Self {
        Self { broker_version_result: || Ok("4.2.4".to_string()) }
    }
}

#[async_trait::async_trait]
impl BrokerAdmin for MissingConsumersAdmin {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        (self.broker_version_result)()
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
            "msgRateIn": 0.0,
            "msgRateOut": 0.0,
            "msgThroughputIn": 0.0,
            "msgThroughputOut": 0.0,
            "storageSize": 0,
            "backlogSize": 0,
            "msgInCounter": 0,
            // -1: NoBacklog, a determinate healthy fact — kept out of this
            // payload's indeterminate story on purpose, so the only
            // indeterminate entries this produces are the ones the
            // omitted `consumers` key causes.
            "oldestBacklogMessageAgeSeconds": -1,
            "subscriptions": {
                "sub-missing-consumers": {
                    "msgBacklog": 3,
                    "unackedMessages": 0,
                    "msgRateOut": 0.0,
                    "type": "Shared"
                    // No "consumers" key at all — Pulsar never reported
                    // who, if anyone, is attached.
                }
            }
        }))
    }
    async fn get_topic_internal_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Ok(serde_json::json!({
            "entriesAddedCounter": 0,
            "numberOfEntries": 0,
            "lastConfirmedEntry": "1:0",
            "cursors": {
                "sub-missing-consumers": { "markDeletePosition": "1:0", "readPosition": "1:0", "messagesConsumedCounter": 0 }
            }
        }))
    }
    async fn list_subscriptions(&self, _topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        Err(fail())
    }
}

#[tokio::test]
async fn build_topic_detail_derives_indeterminate_checks_from_an_absent_field() {
    let topic_ref = TopicRef { tenant: "public".into(), namespace: "default".into(), topic: "canned-topic".into(), persistent: true };
    let detail = build_topic_detail(&MissingConsumersAdmin::probe_succeeds(), &topic_ref).await.expect("canned detail");

    // No anomaly: `derive_anomalies` never raises `BacklogWithNoConsumer`
    // from an *absent* `consumers` key — only from a confirmed-empty one
    // (see `CannedAdmin`'s test above). This payload's backlog is known but
    // its consumers are not, which is exactly the indeterminate case, not
    // an anomaly.
    assert!(detail.anomalies.is_empty(), "got {:?}", detail.anomalies);

    assert!(
        detail.indeterminate.iter().any(|i| i.kind == AnomalyKind::BacklogWithNoConsumer
            && i.subscription.as_deref() == Some("sub-missing-consumers")),
        "expected a BacklogWithNoConsumer indeterminate entry for sub-missing-consumers, got {:?}",
        detail.indeterminate
    );
    assert!(
        detail.indeterminate.iter().any(|i| i.kind == AnomalyKind::ConsumerBlockedOnUnacked
            && i.subscription.as_deref() == Some("sub-missing-consumers")),
        "expected a ConsumerBlockedOnUnacked indeterminate entry for sub-missing-consumers, got {:?}",
        detail.indeterminate
    );
}

// --- Fix round 1, item 2: `CapabilityProbeFailed` must travel through the
// real `.await` call site in `sample_overview`, not just through the pure
// `capability_probe_anomaly` decision function. This mock's `stats`/
// `internalStats`/topic-listing calls all succeed; only `broker_version`
// fails — proving the capability probe's failure is what produced the
// anomaly, and that per-topic sampling still runs normally around it. ---
struct CapabilityFailingAdmin;

#[async_trait::async_trait]
impl BrokerAdmin for CapabilityFailingAdmin {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        Err(fail())
    }
    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError> {
        Ok(vec!["standalone".to_string()])
    }
    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError> {
        Ok(vec!["public".to_string()])
    }
    async fn list_namespaces(&self, _tenant: &str) -> Result<Vec<String>, BrokerError> {
        Ok(vec!["public/default".to_string()])
    }
    async fn list_topics(&self, _tenant: &str, _namespace: &str) -> Result<Vec<String>, BrokerError> {
        Ok(vec!["persistent://public/default/x".to_string()])
    }
    async fn list_partitioned_topics(&self, _tenant: &str, _namespace: &str) -> Result<Vec<String>, BrokerError> {
        Ok(vec![])
    }
    async fn get_topic_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Ok(serde_json::json!({ "subscriptions": {}, "oldestBacklogMessageAgeSeconds": -1 }))
    }
    async fn get_topic_internal_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Ok(serde_json::json!({ "cursors": {} }))
    }
    async fn list_subscriptions(&self, _topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        Ok(vec![])
    }
}

fn one_topic_item() -> TopicSummaryDto {
    TopicSummaryDto {
        full_name: "persistent://public/default/x".to_string(),
        short_name: "x".to_string(),
        tenant: "public".to_string(),
        namespace: "default".to_string(),
        persistent: true,
        partitions: 0,
        partition_names: Vec::new(),
    }
}

#[tokio::test]
async fn sample_overview_reports_capability_probe_failed_through_the_real_await() {
    let items = vec![one_topic_item()];
    let (anomalies, indeterminate, warnings) =
        sample_overview(&CapabilityFailingAdmin, "public", "default", &items).await;

    assert_eq!(anomalies.len(), 1, "got {anomalies:?}");
    assert_eq!(anomalies[0].kind, AnomalyKind::CapabilityProbeFailed);
    assert_eq!(anomalies[0].topic, "public/default");
    assert!(indeterminate.is_empty(), "got {indeterminate:?}");
    // The per-topic loop still ran normally around the failed probe: the
    // one sampled topic's stats succeeded, so there is no "stats
    // unavailable" warning either.
    assert!(warnings.is_empty(), "got {warnings:?}");
}

#[tokio::test]
async fn sample_overview_carries_indeterminate_checks_from_a_sampled_topic_into_the_report() {
    let items = vec![one_topic_item()];
    let (anomalies, indeterminate, warnings) =
        sample_overview(&MissingConsumersAdmin::probe_succeeds(), "public", "default", &items).await;

    assert!(anomalies.is_empty(), "got {anomalies:?}");
    assert!(warnings.is_empty(), "got {warnings:?}");
    assert!(
        indeterminate.iter().any(|i| i.kind == AnomalyKind::BacklogWithNoConsumer
            && i.subscription.as_deref() == Some("sub-missing-consumers")),
        "expected the sampled topic's indeterminate entries to reach the overview report, got {:?}",
        indeterminate
    );
    assert!(
        indeterminate.iter().any(|i| i.kind == AnomalyKind::ConsumerBlockedOnUnacked
            && i.subscription.as_deref() == Some("sub-missing-consumers")),
        "got {:?}",
        indeterminate
    );
}
