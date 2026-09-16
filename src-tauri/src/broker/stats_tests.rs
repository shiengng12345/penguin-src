//! Tests for `broker::stats`, split into their own file (via `#[path]`) so
//! `stats.rs` stays under the module size cap. Included as `mod tests;` from
//! `stats.rs`, so everything below is that module's body directly — no
//! `mod tests { ... }` wrapper here.

use super::*;

fn real_fixture() -> serde_json::Value {
    let raw = include_str!("../../tests/fixtures/broker/topic-stats.json");
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

#[test]
fn parses_the_real_captured_stats() {
    let stats = parse_topic_stats(&real_fixture()).expect("parses");
    // fpms_topup carries exactly these two subscriptions on the user's broker.
    let names: Vec<_> = stats.subscriptions.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"rg_deposit_accumulate_LOCAL"), "got {names:?}");
    assert!(names.contains(&"anti_addiction_deposit_limit_fpmsnt"), "got {names:?}");
}

#[test]
fn an_unknown_field_does_not_break_the_parse() {
    // A future Pulsar version will add fields. Mapping only what we use
    // means that is a non-event; strict mapping would blank the screen.
    let mut raw = real_fixture();
    raw["someFieldFromAFutureVersion"] = serde_json::json!({"nested": [1, 2, 3]});
    assert!(parse_topic_stats(&raw).is_ok());
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

#[test]
fn a_wrong_type_is_an_error_not_a_silent_zero() {
    // If msgBacklog arrives as a string, reporting 0 would tell an
    // operator the queue is drained when we simply could not read it.
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["msgBacklog"] =
        serde_json::json!("not a number");
    let err = parse_topic_stats(&raw).expect_err("must not coerce to zero");
    assert_eq!(err.code, crate::broker::envelope::BrokerErrorCode::MalformedResponse);
    // The message must name the offending field, not just report "some
    // field somewhere was the wrong type" — with subscriptions keyed by
    // name and a nested consumers array, a path-less message tells a
    // diagnosing engineer nothing about where to look.
    assert!(
        err.message.contains("subscriptions.rg_deposit_accumulate_LOCAL.msgBacklog"),
        "message did not name the offending path: {}",
        err.message
    );
}

#[test]
fn a_subscription_with_no_consumers_parses_with_an_empty_list() {
    // This is the shape that matters most for the anomaly panel: backlog
    // present, nobody consuming. An *explicit* empty array is Pulsar's own
    // confirmed fact, so it must parse to `Some(vec![])`, not `None` —
    // `None` is reserved for the key being absent entirely (see the test
    // immediately below, added in fix round 2).
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] = serde_json::json!([]);
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .expect("subscription present");
    assert_eq!(sub.consumers, Some(vec![]));
}

/// Fix round 2: the last remaining path where an unknown could become a
/// confident claim. An earlier version of this module used
/// `#[serde(default)]` on `consumers`, so an omitted key and an explicit
/// `[]` parsed identically to an empty `Vec` — meaning `derive_anomalies`
/// would read a Pulsar payload that simply never sent `consumers` as
/// "confirmed nobody attached" and raise `BacklogWithNoConsumer` from data
/// that was never actually observed. Omitting the key entirely must parse
/// to `None`, distinguishable from the confirmed-empty case above.
#[test]
fn a_subscription_with_the_consumers_key_omitted_parses_to_none_not_an_empty_list() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]
        .as_object_mut()
        .unwrap()
        .remove("consumers");
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .expect("subscription present");
    assert_eq!(sub.consumers, None);
}

#[test]
fn blocked_on_unacked_is_carried_through_verbatim() {
    // The single most diagnostic consumer field — it says the broker
    // itself stopped delivering. It must never be inferred or defaulted.
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] = serde_json::json!([{
        "consumerName": "probe",
        "blockedConsumerOnUnackedMsgs": true
    }]);
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats.subscriptions.iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL").unwrap();
    assert_eq!(sub.consumers.as_ref().unwrap()[0].blocked_on_unacked_msgs, Some(true));
}

/// Strengthens the inherited test above: that test only proves an
/// explicit `true` survives untouched, which would pass just as well if
/// the field were a plain `bool` default. This proves the other half of
/// "must never be inferred or defaulted" — when the field is absent
/// entirely, the result must be `None`, not `Some(false)`. A consumer we
/// have no data on must never read as "confirmed not blocked".
#[test]
fn blocked_on_unacked_is_none_when_absent_not_defaulted_to_false() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] =
        serde_json::json!([{ "consumerName": "probe" }]);
    let stats = parse_topic_stats(&raw).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.consumers.as_ref().unwrap()[0].blocked_on_unacked_msgs, None);
}

/// `msgRateOut` is the delivery signal Task 7's anomaly derivation reads
/// to decide whether a subscription with a backlog has anyone actually
/// consuming, and it is the number an operator looks at first. If a
/// future Pulsar release renames it, defaulting the absence to `0.0`
/// would make that look identical to a real, live "nothing being
/// delivered right now" — sending someone chasing an outage that does
/// not exist. Absence must stay distinguishable as `None`.
#[test]
fn an_absent_rate_is_unknown_not_zero_because_zero_reads_as_a_dead_consumer() {
    let mut raw = real_fixture();
    raw.as_object_mut().unwrap().remove("msgRateOut");
    raw.as_object_mut().unwrap().remove("msgRateIn");
    raw.as_object_mut().unwrap().remove("msgThroughputOut");
    raw.as_object_mut().unwrap().remove("msgThroughputIn");
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]
        .as_object_mut()
        .unwrap()
        .remove("msgRateOut");
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] =
        serde_json::json!([{ "consumerName": "probe" }]);

    let stats = parse_topic_stats(&raw).expect("parses");
    assert_eq!(stats.msg_rate_in, None);
    assert_eq!(stats.msg_rate_out, None);
    assert_eq!(stats.msg_throughput_in, None);
    assert_eq!(stats.msg_throughput_out, None);
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.msg_rate_out, None);
    assert_eq!(sub.consumers.as_ref().unwrap()[0].msg_rate_out, None);
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

/// Both subscriptions in the real fixture have `consumers: []`, and
/// every synthetic consumer payload elsewhere in this file supplies
/// only mapped fields — so nothing else in this suite would catch
/// `#[serde(deny_unknown_fields)]` being added to `RawConsumerStats`. A
/// consumer object is the most likely place for a future Pulsar version
/// to add a field (it is the most nested, most frequently-changed shape
/// in the payload), so this proves tolerance there specifically, not
/// just at the topic level.
#[test]
fn an_unknown_field_inside_a_consumer_does_not_break_the_parse() {
    let mut raw = real_fixture();
    raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] = serde_json::json!([{
        "consumerName": "probe",
        "unackedMessages": 7,
        "aFieldNoPulsarVersionHasEverSent": {"nested": true}
    }]);
    let stats = parse_topic_stats(&raw).expect("parses despite the unknown consumer field");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.consumers.as_ref().unwrap()[0].consumer_name.as_deref(), Some("probe"));
    assert_eq!(sub.consumers.as_ref().unwrap()[0].unacked_messages, Some(7));
}

/// Both of `fpms_topup`'s real subscriptions send exactly `"type": "None"`
/// today (see the captured fixture, unmodified) — this is live on the
/// user's own data, not a hypothetical. `"None"` is Pulsar's serialization
/// of "no subscription type is set," not a genuine member of
/// `SubscriptionType`; passed through verbatim it would print the literal
/// word "None" as if it were a considered answer about the subscription's
/// mode.
#[test]
fn pulsars_none_subscription_type_sentinel_becomes_unknown_not_a_real_type() {
    let stats = parse_topic_stats(&real_fixture()).expect("parses");
    let sub = stats
        .subscriptions
        .iter()
        .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
        .unwrap();
    assert_eq!(sub.sub_type, None);
}

/// This cannot be observed on the live broker today — no topic has a
/// connected consumer at capture time, so a synthetic payload is the only
/// way to exercise it. It rests on Pulsar's documented "0 means never"
/// convention (the same default its equivalent subscription-level fields
/// use), not on anything captured here. A consumer that never acknowledged
/// or consumed anything must not be shown as having last done so at the
/// Unix epoch.
#[test]
fn pulsars_zero_timestamp_sentinel_becomes_unknown_not_the_unix_epoch() {
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
    assert_eq!(sub.consumers.as_ref().unwrap()[0].last_acked_timestamp, None);
    assert_eq!(sub.consumers.as_ref().unwrap()[0].last_consumed_timestamp, None);
}
