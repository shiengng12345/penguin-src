//! Tests for the `broker_get_overview` side of `broker::commands::topic_detail`
//! — truncation, the capability probe, and `sample_overview`'s
//! indeterminate/topics-unavailable accounting. Split out of
//! `topic_detail_tests.rs` (via `#[path]`) once that file reached the
//! 400-line cap (see the "Watch item for Task 9+" note in the phase
//! ledger) — a pure move, not a behaviour change: every test below is
//! relocated verbatim from there except where noted. Included as
//! `mod overview_tests;` from `topic_detail.rs`, so everything below is
//! that module's body directly — no `mod tests { ... }` wrapper here.

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

// --- Fix round 1, item 1: prove `indeterminate` is not just carried in the
// type signature but actually reaches the caller non-empty when a field is
// genuinely absent. `CannedAdmin` (`topic_detail_tests.rs`) deliberately
// makes every field known (so it always produces an empty `indeterminate`),
// and the live `fpms_topup` topic (see `tests/broker_topic_detail.rs`)
// happens to report every field too — neither can distinguish the real
// wiring from `indeterminate: Vec::new()` hardcoded and
// `derive_indeterminate_checks` never called at all. This mock omits
// `consumers` from a subscription entirely (not `consumers: []`, which is a
// known, confirmed fact) so that check is genuinely un-answerable. ---
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
    // (see `CannedAdmin`'s test in `topic_detail_tests.rs`). This payload's
    // backlog is known but its consumers are not, which is exactly the
    // indeterminate case, not an anomaly.
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
    let (anomalies, indeterminate, warnings, topics_unavailable) =
        sample_overview(&CapabilityFailingAdmin, "public", "default", &items).await;

    assert_eq!(anomalies.len(), 1, "got {anomalies:?}");
    assert_eq!(anomalies[0].kind, AnomalyKind::CapabilityProbeFailed);
    assert_eq!(anomalies[0].topic, "public/default");
    assert!(indeterminate.is_empty(), "got {indeterminate:?}");
    // The per-topic loop still ran normally around the failed probe: the
    // one sampled topic's stats succeeded, so there is no "stats
    // unavailable" warning either.
    assert!(warnings.is_empty(), "got {warnings:?}");
    assert_eq!(topics_unavailable, 0, "the one sampled topic's stats succeeded");
}

#[tokio::test]
async fn sample_overview_carries_indeterminate_checks_from_a_sampled_topic_into_the_report() {
    let items = vec![one_topic_item()];
    let (anomalies, indeterminate, warnings, topics_unavailable) =
        sample_overview(&MissingConsumersAdmin::probe_succeeds(), "public", "default", &items).await;

    assert!(anomalies.is_empty(), "got {anomalies:?}");
    assert!(warnings.is_empty(), "got {warnings:?}");
    assert_eq!(topics_unavailable, 0, "the one sampled topic's stats succeeded");
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

// --- Phase A final review, finding 1: the Overview panel rendered "Every
// check ran and found nothing wrong" while a per-topic stats failure sat in
// `warnings` right above it — the free-text warning `topic_detail.rs:326`
// pushes has no determinate field a caller can reason about. `topics_total`
// counts every topic whose stats fetch failed during sampling, so
// `FindingsSection` can suppress the all-clear claim instead of just
// hoping a caller reads the warning text. This double mixes one topic
// whose stats succeed with one whose stats fail, so the count this proves
// is a real tally of failures, not just "non-zero because everything
// failed" (which a naive `!warnings.is_empty()` boolean could also pass). --
struct PartlyUnavailableAdmin;

#[async_trait::async_trait]
impl BrokerAdmin for PartlyUnavailableAdmin {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        Ok("4.2.4".to_string())
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
    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        if topic.topic == "unavailable" {
            return Err(fail());
        }
        Ok(serde_json::json!({ "subscriptions": {}, "oldestBacklogMessageAgeSeconds": -1 }))
    }
    async fn get_topic_internal_stats(&self, _topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        Ok(serde_json::json!({ "cursors": {} }))
    }
    async fn list_subscriptions(&self, _topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        Ok(vec![])
    }
}

fn two_topic_items() -> Vec<TopicSummaryDto> {
    vec![
        TopicSummaryDto {
            full_name: "persistent://public/default/ok".to_string(),
            short_name: "ok".to_string(),
            tenant: "public".to_string(),
            namespace: "default".to_string(),
            persistent: true,
            partitions: 0,
            partition_names: Vec::new(),
        },
        TopicSummaryDto {
            full_name: "persistent://public/default/unavailable".to_string(),
            short_name: "unavailable".to_string(),
            tenant: "public".to_string(),
            namespace: "default".to_string(),
            persistent: true,
            partitions: 0,
            partition_names: Vec::new(),
        },
    ]
}

#[tokio::test]
async fn sample_overview_counts_exactly_the_topics_whose_stats_fetch_failed() {
    let items = two_topic_items();
    let (anomalies, indeterminate, warnings, topics_unavailable) =
        sample_overview(&PartlyUnavailableAdmin, "public", "default", &items).await;

    assert!(anomalies.is_empty(), "got {anomalies:?}");
    assert!(indeterminate.is_empty(), "got {indeterminate:?}");
    assert_eq!(warnings.len(), 1, "got {warnings:?}");
    assert!(warnings[0].contains("unavailable"), "got {warnings:?}");
    assert_eq!(topics_unavailable, 1, "exactly one of the two sampled topics failed");
}
