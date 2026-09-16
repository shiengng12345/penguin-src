//! Tests for `broker::anomaly`, split into their own file (via `#[path]`) so
//! `anomaly.rs` stays under the module size cap. Included as `mod tests;`
//! from `anomaly.rs`, so everything below is that module's body directly —
//! no `mod tests { ... }` wrapper here.

use super::*;
use crate::broker::stats::{ConsumerStats, SubscriptionStats, TopicStats};

fn sub(name: &str, backlog: Option<u64>, consumers: Vec<ConsumerStats>) -> SubscriptionStats {
    SubscriptionStats {
        name: name.into(),
        msg_backlog: backlog,
        unacked_messages: None,
        msg_rate_out: None,
        sub_type: Some("Shared".into()),
        consumers,
    }
}

fn topic_with(subs: Vec<SubscriptionStats>, oldest_backlog_secs: Option<i64>) -> TopicStats {
    TopicStats {
        msg_rate_in: None,
        msg_rate_out: None,
        msg_throughput_in: None,
        msg_throughput_out: None,
        storage_size: None,
        backlog_size: None,
        msg_in_counter: None,
        oldest_backlog_message_age_seconds: oldest_backlog_secs,
        subscriptions: subs,
    }
}

#[test]
fn backlog_with_no_consumer_is_an_anomaly() {
    // The most common real incident: the consumer died and nobody noticed.
    let stats = topic_with(vec![sub("orders-sub", Some(3400), vec![])], None);
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
    let stats = topic_with(vec![sub("orders-sub", Some(3400), vec![consumer])], None);
    assert!(derive_anomalies("orders", &stats, 3600).is_empty());
}

#[test]
fn no_backlog_and_no_consumer_is_not_an_anomaly() {
    // An idle subscription with nothing waiting is fine. Flagging it
    // would bury the real incidents in noise.
    let stats = topic_with(vec![sub("orders-sub", Some(0), vec![])], None);
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
    let stats = topic_with(vec![sub("orders-sub", Some(0), vec![consumer])], None);
    let found = derive_anomalies("orders", &stats, 3600);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, AnomalyKind::ConsumerBlockedOnUnacked);
}

#[test]
fn an_old_backlog_is_an_anomaly_at_the_threshold_boundary() {
    let stats = topic_with(vec![sub("orders-sub", Some(1), vec![])], Some(3600));
    let found = derive_anomalies("orders", &stats, 3600);
    // Exactly at the threshold counts — "older than an hour" should fire
    // at an hour, and a boundary that silently excludes is a bug.
    assert!(found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn a_missing_backlog_age_is_not_treated_as_zero() {
    // Absent means "we do not know", not "brand new". Reporting no
    // anomaly for an unknown age is correct; reporting one is not.
    let stats = topic_with(vec![sub("orders-sub", Some(1), vec![])], None);
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(!found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn one_subscription_can_raise_two_distinct_anomalies() {
    let consumer = ConsumerStats {
        consumer_name: Some("c1".into()),
        blocked_on_unacked_msgs: Some(true),
        ..Default::default()
    };
    let stats = topic_with(vec![sub("orders-sub", Some(99), vec![consumer])], Some(7200));
    let kinds: Vec<_> = derive_anomalies("orders", &stats, 3600).into_iter().map(|a| a.kind).collect();
    assert!(kinds.contains(&AnomalyKind::ConsumerBlockedOnUnacked));
    assert!(kinds.contains(&AnomalyKind::BacklogOlderThanThreshold));
}

// --- Unknown-input cases: the central constraint under test. ---

#[test]
fn an_unknown_backlog_with_no_consumer_never_raises_and_is_marked_indeterminate() {
    // msg_backlog is None: we cannot see whether there is a backlog at
    // all. Raising BacklogWithNoConsumer here would be a fabricated
    // claim, not a measurement. But silence must not be read as "clear"
    // either — the check has to show up as unresolved somewhere.
    // oldest_backlog_secs is Some(0) here (known, under any threshold),
    // deliberately, so only the check under test — backlog visibility —
    // is exercised; None there is covered by its own dedicated test below.
    let stats = topic_with(vec![sub("orders-sub", None, vec![])], Some(0));
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(found.is_empty(), "a None input must never raise an anomaly");

    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert_eq!(indeterminate.len(), 1);
    assert_eq!(indeterminate[0].kind, AnomalyKind::BacklogWithNoConsumer);
    assert_eq!(indeterminate[0].subscription.as_deref(), Some("orders-sub"));
}

#[test]
fn an_attached_consumer_makes_an_unknown_backlog_moot() {
    // Consumers being present is itself a known fact (an empty list is a
    // fact too — see the module doc). With a consumer attached, whether
    // the backlog count came through is irrelevant to this specific
    // check, so nothing is indeterminate here.
    // blocked_on_unacked_msgs is set (not left None) so this test isolates
    // the backlog-visibility check; the blocked-flag check has its own
    // dedicated unknown-input test below.
    let consumer = ConsumerStats {
        consumer_name: Some("c1".into()),
        blocked_on_unacked_msgs: Some(false),
        ..Default::default()
    };
    let stats = topic_with(vec![sub("orders-sub", None, vec![consumer])], Some(0));
    assert!(derive_anomalies("orders", &stats, 3600).is_empty());
    assert!(derive_indeterminate_checks("orders", &stats).is_empty());
}

#[test]
fn an_unknown_blocked_flag_never_raises_and_is_marked_indeterminate() {
    // blocked_on_unacked_msgs is None: the broker did not report the one
    // field that reveals a stalled consumer. Assuming "not blocked"
    // would hide a real outage; assuming "blocked" would fabricate one.
    // oldest_backlog_secs is Some(0) here so only the blocked-flag check
    // is exercised; None there is covered by its own dedicated test below.
    let consumer = ConsumerStats { consumer_name: Some("c1".into()), ..Default::default() };
    let stats = topic_with(vec![sub("orders-sub", Some(0), vec![consumer])], Some(0));
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(found.is_empty(), "a None input must never raise an anomaly");

    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert_eq!(indeterminate.len(), 1);
    assert_eq!(indeterminate[0].kind, AnomalyKind::ConsumerBlockedOnUnacked);
    assert_eq!(indeterminate[0].subscription.as_deref(), Some("orders-sub"));
}

#[test]
fn an_unknown_backlog_age_never_raises_and_is_marked_indeterminate() {
    // None here means either "no backlog has ever existed" (the -1
    // sentinel, already normalized away by Task 5) or "the field was
    // withheld" — both collapse to the same value, and derive_anomalies
    // cannot tell them apart. Treating that as silently healthy would
    // hide the second case, so it is reported indeterminate instead.
    let stats = topic_with(vec![sub("orders-sub", Some(1), vec![])], None);
    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert!(indeterminate
        .iter()
        .any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold && c.subscription.is_none()));
}

#[test]
fn a_known_backlog_age_under_threshold_is_not_indeterminate() {
    // A conclusive "no" is not the same as "could not tell" — only a
    // genuinely missing input belongs on the indeterminate list.
    let stats = topic_with(vec![sub("orders-sub", Some(1), vec![])], Some(10));
    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert!(!indeterminate.iter().any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold));
}
