//! Tests for `broker::anomaly`, split into their own file (via `#[path]`) so
//! `anomaly.rs` stays under the module size cap. Included as `mod tests;`
//! from `anomaly.rs`, so everything below is that module's body directly —
//! no `mod tests { ... }` wrapper here.
//!
//! This file itself reached the same cap once whole-stage review item 2
//! added its backlog-age-scope tests, so a further slice —
//! `anomaly_backlog_age_tests.rs` — is declared as a submodule below,
//! `mod backlog_age_tests;`. It sees every helper defined here (`sub`,
//! `topic_with`, `topic_with_backlog_age_requested`) via `use super::*;`,
//! the same way this file sees `anomaly.rs`'s items.

use super::*;
use crate::broker::stats::{
    BacklogAge, ConsumerStats, StatsRequestScope, SubscriptionStats, SubscriptionType, TopicStats,
    TOPIC_STATS_REQUEST_SCOPE,
};

#[cfg(test)]
#[path = "anomaly_backlog_age_tests.rs"]
mod backlog_age_tests;

fn sub(name: &str, backlog: Option<u64>, consumers: Option<Vec<ConsumerStats>>) -> SubscriptionStats {
    SubscriptionStats {
        name: name.into(),
        msg_backlog: backlog,
        unacked_messages: None,
        msg_rate_out: None,
        sub_type: SubscriptionType::Named { name: "Shared".into() },
        consumers,
    }
}

fn topic_with(subs: Vec<SubscriptionStats>, oldest_backlog_age: BacklogAge) -> TopicStats {
    TopicStats {
        msg_rate_in: None,
        msg_rate_out: None,
        msg_throughput_in: None,
        msg_throughput_out: None,
        storage_size: None,
        backlog_size: None,
        msg_in_counter: None,
        oldest_backlog_message_age: oldest_backlog_age,
        subscriptions: subs,
        stats_request_scope: TOPIC_STATS_REQUEST_SCOPE,
    }
}

/// Fix round 1, item 3: same as `topic_with`, but the stats carry a scope
/// that says consumers were excluded from the request (`excludeConsumers`).
/// Measured directly against the live broker: `?excludeConsumers=true`
/// returns `consumers: []` — byte-identical to Pulsar's own "confirmed
/// nobody attached" fact. Any subscription passed here should therefore be
/// built with `Some(vec![])` (never `None`), the same way a real excluded
/// response would parse — the point of these tests is that `derive_*` must
/// still treat it as unknown, not that the input shape itself is unknown.
///
/// `earliest_time_in_backlog: true` is also forced on here (unlike plain
/// `topic_with`, whose baked-in `TOPIC_STATS_REQUEST_SCOPE` has it `false` —
/// see `topic_with_backlog_age_requested`'s doc below) so this helper's
/// tests exercise the consumers-exclusion fix in isolation: the
/// `oldest_backlog_age` passed in is trusted as measured, and the only
/// scope effect under test is `exclude_consumers`.
fn topic_with_excluded_consumers(subs: Vec<SubscriptionStats>, oldest_backlog_age: BacklogAge) -> TopicStats {
    TopicStats {
        stats_request_scope: StatsRequestScope {
            exclude_consumers: true,
            earliest_time_in_backlog: true,
            ..TOPIC_STATS_REQUEST_SCOPE
        },
        ..topic_with(subs, oldest_backlog_age)
    }
}

/// Whole-stage review item 2: same as `topic_with`, but the stats carry a
/// scope that says `earliest_time_in_backlog` (`getEarliestTimeInBacklog`)
/// WAS requested. Plain `topic_with` bakes in `TOPIC_STATS_REQUEST_SCOPE` —
/// the actual shipped scope, where this flag is `false` — so a test that
/// hands it a `BacklogAge::Seconds`/`NoBacklog` value and expects
/// `derive_anomalies`/`derive_indeterminate_checks` to trust that value as
/// measured must use this helper instead: after this fix, both functions
/// fold `oldest_backlog_message_age` to `Unknown` whenever the scope says
/// the field was not requested (mirroring `effective_consumers`'s handling
/// of `exclude_consumers` above), so a test about the *value itself*
/// (Seconds/NoBacklog/Unknown semantics, independent of whether the call
/// even asked) needs a scope that actually asked.
fn topic_with_backlog_age_requested(subs: Vec<SubscriptionStats>, oldest_backlog_age: BacklogAge) -> TopicStats {
    TopicStats {
        stats_request_scope: StatsRequestScope { earliest_time_in_backlog: true, ..TOPIC_STATS_REQUEST_SCOPE },
        ..topic_with(subs, oldest_backlog_age)
    }
}

#[test]
fn backlog_with_no_consumer_is_an_anomaly() {
    // The most common real incident: the consumer died and nobody noticed.
    // Some(vec![]) is Pulsar's own confirmed "nobody attached" fact — not
    // to be confused with `None` ("we don't know"), covered separately
    // below. BacklogAge::NoBacklog is a deliberately neutral, healthy value
    // — this test is about the backlog/consumer check, not the age check.
    let stats = topic_with(vec![sub("orders-sub", Some(3400), Some(vec![]))], BacklogAge::NoBacklog);
    let found = derive_anomalies("orders", &stats, 3600);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, AnomalyKind::BacklogWithNoConsumer);
    assert_eq!(found[0].subscription.as_deref(), Some("orders-sub"));
    assert!(found[0].observed_value.contains("3400"));
}

#[test]
fn backlog_with_a_live_consumer_is_not_an_anomaly() {
    // A queue draining normally has backlog. Backlog alone is not a fault.
    let consumer = ConsumerStats {
        consumer_name: Some("c1".into()),
        blocked_on_unacked_msgs: Some(false),
        ..Default::default()
    };
    let stats =
        topic_with(vec![sub("orders-sub", Some(3400), Some(vec![consumer]))], BacklogAge::NoBacklog);
    assert!(derive_anomalies("orders", &stats, 3600).is_empty());
}

#[test]
fn no_backlog_and_no_consumer_is_not_an_anomaly() {
    // An idle subscription with nothing waiting is fine. Flagging it
    // would bury the real incidents in noise.
    let stats = topic_with(vec![sub("orders-sub", Some(0), Some(vec![]))], BacklogAge::NoBacklog);
    assert!(derive_anomalies("orders", &stats, 3600).is_empty());
}

#[test]
fn a_blocked_consumer_is_an_anomaly_even_with_no_backlog() {
    // blockedConsumerOnUnackedMsgs means the broker stopped delivering.
    // Backlog may still read zero at the instant we sample.
    let consumer = ConsumerStats {
        consumer_name: Some("c1".into()),
        blocked_on_unacked_msgs: Some(true),
        ..Default::default()
    };
    let stats = topic_with(vec![sub("orders-sub", Some(0), Some(vec![consumer]))], BacklogAge::NoBacklog);
    let found = derive_anomalies("orders", &stats, 3600);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, AnomalyKind::ConsumerBlockedOnUnacked);
}

// --- Fix round 2, item 3: `consumers` itself can be unknown. ---

#[test]
fn no_consumers_reported_never_raises_and_marks_both_checks_indeterminate() {
    // `consumers: None` means Pulsar never sent the field at all — we do
    // not know who, if anyone, is attached. A known, large backlog
    // (msg_backlog = Some(3400)) must still not raise BacklogWithNoConsumer:
    // an unknown attachment state is not the same fact as "confirmed nobody
    // attached", however suggestive the backlog number is. Both checks that
    // depend on `consumers` — attachment and the per-consumer blocked flag —
    // are blocked, so both show up on the indeterminate list exactly once
    // each (there is no consumer to name for either).
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", Some(3400), None)], BacklogAge::NoBacklog);
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(found.is_empty(), "an unknown consumers list must never raise an anomaly");

    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert_eq!(indeterminate.len(), 2, "got {indeterminate:?}");
    let kinds: Vec<_> = indeterminate.iter().map(|c| c.kind).collect();
    assert!(kinds.contains(&AnomalyKind::BacklogWithNoConsumer));
    assert!(kinds.contains(&AnomalyKind::ConsumerBlockedOnUnacked));
    assert!(indeterminate.iter().all(|c| c.subscription.as_deref() == Some("orders-sub")));
}

#[test]
fn unknown_consumers_is_indeterminate_even_when_backlog_is_also_unknown() {
    // Both msg_backlog and consumers absent at once must not somehow
    // produce two BacklogWithNoConsumer entries or an anomaly — still
    // exactly one indeterminate entry per check, driven by `consumers`
    // being unknown, not by the also-unknown backlog.
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", None, None)], BacklogAge::NoBacklog);
    assert!(derive_anomalies("orders", &stats, 3600).is_empty());
    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert_eq!(indeterminate.len(), 2, "got {indeterminate:?}");
}

#[test]
fn a_fully_known_subscription_is_never_indeterminate() {
    // The converse of the above: once consumers are reported and every
    // consumer's blocked flag is known, nothing about this subscription
    // belongs on the indeterminate list.
    let consumer = ConsumerStats {
        consumer_name: Some("c1".into()),
        blocked_on_unacked_msgs: Some(false),
        ..Default::default()
    };
    let stats =
        topic_with_backlog_age_requested(vec![sub("orders-sub", Some(5), Some(vec![consumer]))], BacklogAge::NoBacklog);
    assert!(derive_indeterminate_checks("orders", &stats).is_empty());
}

// --- Fix round 1 (Task 1), item 3: an excluded consumer list is not an
// empty one. ---

#[test]
fn an_excluded_consumer_list_never_raises_backlog_with_no_consumer() {
    // The exact false-positive fix round 1 exists to close: `excludeConsumers:
    // true` makes Pulsar send `consumers: []`, which is byte-identical to a
    // subscription genuinely confirmed to have nobody attached. Before this
    // fix, this payload (a real backlog, an empty-but-excluded consumer
    // list) raised `BacklogWithNoConsumer` — a fabricated outage at exactly
    // the moment the caller chose the lightweight view. It must instead be
    // treated exactly like `consumers: None` (see
    // `no_consumers_reported_never_raises_and_marks_both_checks_indeterminate`
    // above, which this test's expected shape deliberately matches): zero
    // anomalies, and both consumer-dependent checks moved to indeterminate.
    let stats =
        topic_with_excluded_consumers(vec![sub("orders-sub", Some(3400), Some(vec![]))], BacklogAge::NoBacklog);

    let found = derive_anomalies("orders", &stats, 3600);
    assert!(
        found.is_empty(),
        "an excluded consumer list must never raise an anomaly, got {found:?}"
    );
    assert_eq!(
        found.iter().filter(|a| a.kind == AnomalyKind::BacklogWithNoConsumer).count(),
        0,
        "BacklogWithNoConsumer must not fire from an excluded (not empty) consumer list"
    );

    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert_eq!(
        indeterminate.iter().filter(|c| c.kind == AnomalyKind::BacklogWithNoConsumer).count(),
        1,
        "got {indeterminate:?}"
    );
    assert!(indeterminate.iter().all(|c| c.subscription.as_deref() == Some("orders-sub")));
}

#[test]
fn a_non_excluded_empty_consumer_list_is_unaffected_by_this_fix() {
    // Guards against the fix over-correcting: when consumers were NOT
    // excluded, Pulsar's own confirmed-empty list must still raise
    // BacklogWithNoConsumer exactly as it always has (this is
    // `backlog_with_no_consumer_is_an_anomaly` above, re-asserted here
    // right next to the excluded-list test so the contrast is explicit).
    let stats = topic_with(vec![sub("orders-sub", Some(3400), Some(vec![]))], BacklogAge::NoBacklog);
    let found = derive_anomalies("orders", &stats, 3600);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, AnomalyKind::BacklogWithNoConsumer);
}

