//! Tests for `broker::anomaly`, split into their own file (via `#[path]`) so
//! `anomaly.rs` stays under the module size cap. Included as `mod tests;`
//! from `anomaly.rs`, so everything below is that module's body directly —
//! no `mod tests { ... }` wrapper here.

use super::*;
use crate::broker::stats::{BacklogAge, ConsumerStats, SubscriptionStats, TopicStats};

fn sub(name: &str, backlog: Option<u64>, consumers: Option<Vec<ConsumerStats>>) -> SubscriptionStats {
    SubscriptionStats {
        name: name.into(),
        msg_backlog: backlog,
        unacked_messages: None,
        msg_rate_out: None,
        sub_type: Some("Shared".into()),
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

#[test]
fn an_old_backlog_is_an_anomaly_at_the_threshold_boundary() {
    let stats = topic_with(
        vec![sub("orders-sub", Some(1), Some(vec![]))],
        BacklogAge::Seconds { seconds: 3600 },
    );
    let found = derive_anomalies("orders", &stats, 3600);
    // Exactly at the threshold counts — "older than an hour" should fire
    // at an hour, and a boundary that silently excludes is a bug.
    assert!(found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn a_backlog_age_below_the_threshold_is_not_an_anomaly() {
    // Fix round 2, item 2: every other test that exercises the threshold
    // comparison uses an age at or above it. A mutation that dropped the
    // `>=` check entirely (raising for any known Seconds value) would pass
    // the whole suite without this case — it is the only one asserting the
    // "not yet old enough" side of the comparison.
    let stats =
        topic_with(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Seconds { seconds: 10 });
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(!found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn a_negative_threshold_matches_no_known_backlog_age() {
    // Fix round 2, item 1: `age as i64 >= threshold` made any negative
    // threshold true for every known age (and could wrap a huge `u64` age
    // negative under the cast). A misconfigured threshold must not drown
    // the panel in false positives, so a threshold that cannot even
    // convert to `u64` must match nothing, however old the backlog is.
    let stats = topic_with(
        vec![sub("orders-sub", Some(1), Some(vec![]))],
        BacklogAge::Seconds { seconds: 999_999 },
    );
    let found = derive_anomalies("orders", &stats, -1);
    assert!(!found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn an_unknown_backlog_age_is_not_treated_as_zero_or_as_an_anomaly() {
    // BacklogAge::Unknown ("we do not know") must never be treated as a
    // young age that trivially clears the threshold, and must never itself
    // raise BacklogOlderThanThreshold — see the dedicated indeterminate
    // test below for the other half of this: it must still surface as
    // "could not tell" rather than silently "clear".
    let stats = topic_with(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Unknown);
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(!found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn a_no_backlog_state_is_neither_an_anomaly_nor_indeterminate() {
    // This is the whole point of fix round 1: NoBacklog (Pulsar's `-1`
    // sentinel) is a determinate, healthy fact, not an unknown. Even a
    // threshold of 0 — which a Seconds value of anything would clear —
    // must not raise BacklogOlderThanThreshold here, and it must not show
    // up as indeterminate either.
    let stats = topic_with(vec![sub("orders-sub", Some(0), Some(vec![]))], BacklogAge::NoBacklog);
    assert!(!derive_anomalies("orders", &stats, 0)
        .iter()
        .any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
    assert!(!derive_indeterminate_checks("orders", &stats)
        .iter()
        .any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold));
}

#[test]
fn one_subscription_can_raise_two_distinct_anomalies() {
    let consumer = ConsumerStats {
        consumer_name: Some("c1".into()),
        blocked_on_unacked_msgs: Some(true),
        ..Default::default()
    };
    let stats = topic_with(
        vec![sub("orders-sub", Some(99), Some(vec![consumer]))],
        BacklogAge::Seconds { seconds: 7200 },
    );
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
    // consumers is Some(vec![]) here (confirmed nobody attached) and
    // oldest_backlog_message_age is NoBacklog (known, healthy), both
    // deliberately, so only the check under test — backlog visibility —
    // is exercised; consumers itself being unknown is covered by its own
    // dedicated test below.
    let stats = topic_with(vec![sub("orders-sub", None, Some(vec![]))], BacklogAge::NoBacklog);
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
    let stats = topic_with(vec![sub("orders-sub", None, Some(vec![consumer]))], BacklogAge::NoBacklog);
    assert!(derive_anomalies("orders", &stats, 3600).is_empty());
    assert!(derive_indeterminate_checks("orders", &stats).is_empty());
}

#[test]
fn an_unknown_blocked_flag_never_raises_and_is_marked_indeterminate() {
    // blocked_on_unacked_msgs is None: the broker did not report the one
    // field that reveals a stalled consumer. Assuming "not blocked"
    // would hide a real outage; assuming "blocked" would fabricate one.
    // oldest_backlog_message_age is NoBacklog here so only the
    // blocked-flag check is exercised; Unknown there is covered by its own
    // dedicated test below.
    let consumer = ConsumerStats { consumer_name: Some("c1".into()), ..Default::default() };
    let stats = topic_with(vec![sub("orders-sub", Some(0), Some(vec![consumer]))], BacklogAge::NoBacklog);
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(found.is_empty(), "a None input must never raise an anomaly");

    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert_eq!(indeterminate.len(), 1);
    assert_eq!(indeterminate[0].kind, AnomalyKind::ConsumerBlockedOnUnacked);
    assert_eq!(indeterminate[0].subscription.as_deref(), Some("orders-sub"));
}

#[test]
fn an_unknown_backlog_age_never_raises_and_is_marked_indeterminate() {
    // Fix round 1: BacklogAge::Unknown means the field was genuinely
    // absent (or carried an undocumented negative value) — `broker::stats`
    // now keeps this distinct from BacklogAge::NoBacklog (Pulsar's `-1`
    // sentinel, a determinate healthy fact), so only Unknown belongs here.
    let stats = topic_with(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Unknown);
    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert!(indeterminate
        .iter()
        .any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold && c.subscription.is_none()));
}

#[test]
fn a_known_backlog_age_is_never_indeterminate_regardless_of_threshold() {
    // Renamed in fix round 2: the old name
    // (`a_known_backlog_age_under_threshold_is_not_indeterminate`) claimed
    // to cover the threshold comparison, but `derive_indeterminate_checks`
    // does not take a threshold at all — this only ever exercised "a known
    // age is not indeterminate". The threshold comparison itself is
    // exercised by `a_backlog_age_below_the_threshold_is_not_an_anomaly`
    // and `a_negative_threshold_matches_no_known_backlog_age` above, via
    // `derive_anomalies`.
    let stats =
        topic_with(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Seconds { seconds: 10 });
    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert!(!indeterminate.iter().any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold));
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
    let stats = topic_with(vec![sub("orders-sub", Some(3400), None)], BacklogAge::NoBacklog);
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
    let stats = topic_with(vec![sub("orders-sub", None, None)], BacklogAge::NoBacklog);
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
        topic_with(vec![sub("orders-sub", Some(5), Some(vec![consumer]))], BacklogAge::NoBacklog);
    assert!(derive_indeterminate_checks("orders", &stats).is_empty());
}
