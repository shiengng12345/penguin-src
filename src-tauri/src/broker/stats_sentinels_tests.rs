//! Tests for `broker::stats_sentinels`, split into their own file (via
//! `#[path]`) so `stats_sentinels.rs` stays under the module size cap.
//! Included as `mod tests;` from `stats_sentinels.rs`, so everything below
//! is that module's body directly — no `mod tests { ... }` wrapper here.
//!
//! Moved out of `stats_tests.rs` verbatim (Stage 0 housekeeping, no test
//! edited) to sit next to the sentinel enums and normalisers they exercise:
//! `BacklogAge`, `ConsumerTimestamp`, `SubscriptionType`, and the
//! `normalize_*` functions in `stats_sentinels.rs`.

use super::*;
use crate::broker::stats::parse_topic_stats;

fn real_fixture() -> serde_json::Value {
    let raw = include_str!("../../tests/fixtures/broker/topic-stats.json");
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

#[test]
fn a_missing_optional_field_yields_a_default_not_an_error() {
    // Absence is not an error, but it is also not the same fact as Pulsar's
    // own "no backlog has ever existed" sentinel (see the dedicated tests
    // below) — an absent field means we genuinely do not know.
    let mut raw = real_fixture();
    raw.as_object_mut().unwrap().remove("oldestBacklogMessageAgeSeconds");
    let stats = parse_topic_stats(&raw).expect("still parses");
    assert_eq!(stats.oldest_backlog_message_age, BacklogAge::Unknown);
}

/// The live broker sends `-1` for this field on `fpms_topup` today
/// (see the captured fixture, unmodified). `-1` is Pulsar's documented
/// sentinel for "no backlog has ever existed" — a determinate, healthy
/// fact, not a negative duration one second short of zero, and (fix round
/// 1) not the same thing as the field being absent either: an earlier
/// version of this test asserted `None`, collapsing "verified clean" into
/// the same value as "we could not tell" and flooding the anomaly panel's
/// indeterminate list with perfectly healthy topics.
#[test]
fn pulsars_negative_one_backlog_age_sentinel_becomes_no_backlog_not_unknown() {
    let stats = parse_topic_stats(&real_fixture()).expect("parses");
    assert_eq!(stats.oldest_backlog_message_age, BacklogAge::NoBacklog);
}

/// Only `-1` carries Pulsar's documented "no backlog" meaning. A different
/// negative value has no documented meaning at all, so guessing it means
/// the same thing as `-1` would repeat the exact mistake fix round 1
/// corrects, just for a different number — it must fall back to `Unknown`.
#[test]
fn a_different_negative_backlog_age_is_unknown_not_no_backlog() {
    let mut raw = real_fixture();
    raw["oldestBacklogMessageAgeSeconds"] = serde_json::json!(-7);
    let stats = parse_topic_stats(&raw).expect("parses");
    assert_eq!(stats.oldest_backlog_message_age, BacklogAge::Unknown);
}

/// A genuine, positive backlog age is carried through as a plain number of
/// seconds — the ordinary case neither sentinel nor absence touches.
#[test]
fn a_positive_backlog_age_is_carried_through_as_seconds() {
    let mut raw = real_fixture();
    raw["oldestBacklogMessageAgeSeconds"] = serde_json::json!(42);
    let stats = parse_topic_stats(&raw).expect("parses");
    assert_eq!(stats.oldest_backlog_message_age, BacklogAge::Seconds { seconds: 42 });
}

#[test]
fn backlog_age_serialises_to_the_pinned_wire_shape() {
    // packages/broker-contracts/src/anomaly.ts mirrors this three-state
    // discriminated union; a rename on either side breaks the other
    // silently, so pin the wire shape here, the way BrokerSource is pinned
    // in envelope.rs.
    assert_eq!(
        serde_json::to_value(BacklogAge::Seconds { seconds: 42 }).unwrap(),
        serde_json::json!({"state": "seconds", "seconds": 42})
    );
    assert_eq!(
        serde_json::to_value(BacklogAge::NoBacklog).unwrap(),
        serde_json::json!({"state": "noBacklog"})
    );
    assert_eq!(
        serde_json::to_value(BacklogAge::Unknown).unwrap(),
        serde_json::json!({"state": "unknown"})
    );
}

/// Both of `fpms_topup`'s real subscriptions send exactly `"type": "None"`
/// today (see the captured fixture, unmodified) — this is live on the
/// user's own data, not a hypothetical. Finding 2 of the Phase A final
/// review: `"None"` is Pulsar's own determinate answer — "no consumer has
/// ever claimed a dispatcher type for this subscription" — not a missing
/// value, and not a genuine dispatcher type either. An earlier version of
/// `normalize_sub_type` collapsed it into the same `None` a withheld field
/// produces, which is exactly the mistake `BacklogAge` (fix round 1) and
/// `ConsumerTimestamp` (fix round 1, task 11) were each built to fix for a
/// different field — this is the third occurrence of the identical bug. It
/// must land on its own determinate state, `SubscriptionType::Unset`, never
/// merged with genuine absence.
#[test]
fn pulsars_none_subscription_type_sentinel_becomes_unset_not_unknown() {
    let stats = parse_topic_stats(&real_fixture()).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.sub_type, SubscriptionType::Unset);
}

/// A genuinely absent `type` key — the field was withheld, never sent, as
/// opposed to Pulsar's own `"None"` sentinel above — must land on
/// `Unknown`, distinct from `Unset`. Synthetic: the live fixture always
/// carries the key today.
#[test]
fn an_absent_subscription_type_is_unknown_not_unset() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]
        .as_object_mut()
        .unwrap()
        .remove("type");
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.sub_type, SubscriptionType::Unknown);
}

/// A real, named dispatcher type is carried through verbatim — the
/// ordinary case neither sentinel nor absence touches.
#[test]
fn a_real_subscription_type_is_carried_through_as_named() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["type"] = serde_json::json!("Shared");
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.sub_type, SubscriptionType::Named { name: "Shared".to_string() });
}

#[test]
fn subscription_type_serialises_to_the_pinned_wire_shape() {
    // packages/broker-contracts/src/topic-detail.ts mirrors this
    // three-state discriminated union; a rename on either side breaks the
    // other silently, so pin the wire shape here, the way `BacklogAge` and
    // `ConsumerTimestamp` are pinned above.
    assert_eq!(
        serde_json::to_value(SubscriptionType::Named { name: "Shared".to_string() }).unwrap(),
        serde_json::json!({"state": "named", "name": "Shared"})
    );
    assert_eq!(
        serde_json::to_value(SubscriptionType::Unset).unwrap(),
        serde_json::json!({"state": "unset"})
    );
    assert_eq!(
        serde_json::to_value(SubscriptionType::Unknown).unwrap(),
        serde_json::json!({"state": "unknown"})
    );
}

/// This cannot be observed on the live broker today — no topic has a
/// connected consumer at capture time, so a synthetic payload is the only
/// way to exercise it. It rests on Pulsar's documented "0 means never"
/// convention (the same default its equivalent subscription-level fields
/// use), not on anything captured here. A consumer that never acknowledged
/// or consumed anything must not be shown as having last done so at the
/// Unix epoch — and (fix round 1, task 11) must read as a determinate
/// "never," not the same "Unknown" a withheld field gets; see the test
/// immediately below for that distinction proven directly.
#[test]
fn pulsars_zero_timestamp_sentinel_becomes_never_not_the_unix_epoch() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] = serde_json::json!([{
        "consumerName": "probe",
        "lastAckedTimestamp": 0,
        "lastConsumedTimestamp": 0
    }]);
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.consumers.as_ref().unwrap()[0].last_acked_timestamp, ConsumerTimestamp::Never);
    assert_eq!(
        sub.consumers.as_ref().unwrap()[0].last_consumed_timestamp,
        ConsumerTimestamp::Never
    );
}

/// Fix round 1, task 11: this is the identical defect fixed for
/// `oldestBacklogMessageAgeSeconds` one task earlier, applied here. An
/// earlier version of `normalize_never_timestamp` collapsed Pulsar's `0`
/// ("never acked/consumed" — determinate) and a genuinely withheld field
/// (unknown) into the same `None`, so both printed as "Unknown" and
/// "attached but has never acked" — exactly the signal an operator wants
/// paired with `blocked_on_unacked_msgs` — was unreportable. This proves all
/// three wire inputs land on three different, correct results in one place:
/// absent, `0`, and a real timestamp must not collapse pairwise either.
#[test]
fn a_withheld_timestamp_a_never_acked_timestamp_and_a_real_timestamp_are_all_distinct() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] = serde_json::json!([
        { "consumerName": "withheld" },
        { "consumerName": "never-acked", "lastAckedTimestamp": 0, "lastConsumedTimestamp": 0 },
        {
            "consumerName": "real-timestamp",
            "lastAckedTimestamp": 1_700_000_000_000i64,
            "lastConsumedTimestamp": 1_700_000_000_000i64
        },
    ]);
    let stats = parse_topic_stats(&raw).expect("parses");
    let consumers = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap()
        .consumers
        .as_ref()
        .unwrap();

    let by_name = |name: &str| {
        consumers.iter().find(|c| c.consumer_name.as_deref() == Some(name)).unwrap()
    };

    assert_eq!(by_name("withheld").last_acked_timestamp, ConsumerTimestamp::Unknown);
    assert_eq!(by_name("never-acked").last_acked_timestamp, ConsumerTimestamp::Never);
    assert_eq!(
        by_name("real-timestamp").last_acked_timestamp,
        ConsumerTimestamp::Millis { millis: 1_700_000_000_000 }
    );
}

#[test]
fn consumer_timestamp_serialises_to_the_pinned_wire_shape() {
    // packages/broker-contracts/src/topic-detail.ts mirrors this three-state
    // discriminated union; a rename on either side breaks the other
    // silently, so pin the wire shape here, the way `BacklogAge` is pinned
    // above and `BrokerSource` is pinned in envelope.rs.
    assert_eq!(
        serde_json::to_value(ConsumerTimestamp::Millis { millis: 1_700_000_000_000 }).unwrap(),
        serde_json::json!({"state": "millis", "millis": 1_700_000_000_000i64})
    );
    assert_eq!(
        serde_json::to_value(ConsumerTimestamp::Never).unwrap(),
        serde_json::json!({"state": "never"})
    );
    assert_eq!(
        serde_json::to_value(ConsumerTimestamp::Unknown).unwrap(),
        serde_json::json!({"state": "unknown"})
    );
}
