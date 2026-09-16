//! Backlog-age-focused tests for `broker::anomaly`, split out of
//! `anomaly_tests.rs` (via `#[path]`, declared as a submodule of the `tests`
//! module there) once that file reached the 400-line cap. Included as
//! `mod backlog_age_tests;` from `anomaly_tests.rs`'s `mod tests { ... }`
//! body, so this is a *descendant* of `anomaly::tests`: `use super::*;`
//! below brings in `anomaly_tests.rs`'s helpers (`sub`, `topic_with`,
//! `topic_with_backlog_age_requested`) and, transitively, everything
//! `anomaly.rs` itself exposes (`derive_anomalies`,
//! `derive_indeterminate_checks`, `AnomalyKind`, ...) — the same way
//! `anomaly_tests.rs` sees `anomaly.rs`'s items. Every test below is
//! relocated verbatim from `anomaly_tests.rs` except where noted; this is a
//! pure split, not a behaviour change.

use super::*;

#[test]
fn an_old_backlog_is_an_anomaly_at_the_threshold_boundary() {
    let stats = topic_with_backlog_age_requested(
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
        topic_with_backlog_age_requested(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Seconds { seconds: 10 });
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
    let stats = topic_with_backlog_age_requested(
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
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Unknown);
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
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", Some(0), Some(vec![]))], BacklogAge::NoBacklog);
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
    let stats = topic_with_backlog_age_requested(
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
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", None, Some(vec![]))], BacklogAge::NoBacklog);
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
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", None, Some(vec![consumer]))], BacklogAge::NoBacklog);
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
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", Some(0), Some(vec![consumer]))], BacklogAge::NoBacklog);
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
    let stats = topic_with_backlog_age_requested(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Unknown);
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
        topic_with_backlog_age_requested(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Seconds { seconds: 10 });
    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert!(!indeterminate.iter().any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold));
}


// --- Whole-stage review item 2: `earliest_time_in_backlog` must be folded
// into the backlog-age checks exactly as `exclude_consumers` is folded into
// the consumer checks above. Under the shipped scope
// (earliest_time_in_backlog: false), Pulsar returns oldestBacklogMessageAgeSeconds
// = -1, which normalizes to BacklogAge::NoBacklog — "a determinate, healthy
// fact" per that type's own doc. Before this fix, `derive_anomalies` and
// `derive_indeterminate_checks` read `stats.oldest_backlog_message_age`
// directly, so BacklogOlderThanThreshold was structurally unreachable in the
// shipped configuration AND never showed up as indeterminate either — an
// empty result read as "every check ran and found nothing" when this one
// check never ran at all, exactly what this module's doc forbids. ---

#[test]
fn an_unrequested_backlog_age_never_raises_even_when_the_parsed_value_says_seconds() {
    // Mirrors `an_excluded_consumer_list_never_raises_backlog_with_no_consumer`
    // above: a scope that did not ask for this field must not let whatever
    // BacklogAge happened to parse to (here, a real Seconds value at the
    // threshold) raise an anomaly. `earliest_time_in_backlog: false` must
    // override the parsed value, the same way `exclude_consumers` overrides
    // an empty-but-excluded consumer list.
    let stats = TopicStats {
        stats_request_scope: StatsRequestScope { earliest_time_in_backlog: false, ..TOPIC_STATS_REQUEST_SCOPE },
        ..topic_with(vec![sub("orders-sub", Some(1), Some(vec![]))], BacklogAge::Seconds { seconds: 3600 })
    };
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(
        !found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold),
        "an unrequested backlog age must never raise BacklogOlderThanThreshold, got {found:?}"
    );
}

#[test]
fn an_unrequested_backlog_age_is_marked_indeterminate_even_when_the_parsed_value_says_no_backlog() {
    // This is the exact shipped shape: earliest_time_in_backlog: false, and
    // Pulsar's own -1 sentinel normalizes to BacklogAge::NoBacklog — which
    // `derive_indeterminate_checks` deliberately never lists (see
    // `a_no_backlog_state_is_neither_an_anomaly_nor_indeterminate` above,
    // for a call that genuinely asked). But when this call did NOT ask, that
    // NoBacklog reading cannot be trusted as measured, so the check must
    // move to the indeterminate list instead of silently vanishing — an
    // empty derive_anomalies result here must not read as "checked, clear".
    let stats = TopicStats {
        stats_request_scope: StatsRequestScope { earliest_time_in_backlog: false, ..TOPIC_STATS_REQUEST_SCOPE },
        ..topic_with(vec![sub("orders-sub", Some(0), Some(vec![]))], BacklogAge::NoBacklog)
    };
    assert!(!derive_anomalies("orders", &stats, 0)
        .iter()
        .any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));

    let indeterminate = derive_indeterminate_checks("orders", &stats);
    assert!(
        indeterminate.iter().any(|c| c.kind == AnomalyKind::BacklogOlderThanThreshold && c.subscription.is_none()),
        "got {indeterminate:?}"
    );
}

#[test]
fn a_requested_backlog_age_is_unaffected_by_this_fix() {
    // Guards against the fix over-correcting: when earliest_time_in_backlog
    // WAS requested, a known age at/past the threshold must still raise
    // BacklogOlderThanThreshold exactly as it always has (this is
    // `an_old_backlog_is_an_anomaly_at_the_threshold_boundary` above,
    // re-asserted here right next to the unrequested-age tests so the
    // contrast is explicit).
    let stats = topic_with_backlog_age_requested(
        vec![sub("orders-sub", Some(1), Some(vec![]))],
        BacklogAge::Seconds { seconds: 3600 },
    );
    assert!(stats.stats_request_scope.earliest_time_in_backlog);
    let found = derive_anomalies("orders", &stats, 3600);
    assert!(found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
}
