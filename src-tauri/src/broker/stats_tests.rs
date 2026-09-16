//! Tests for `broker::stats`, split into their own file (via `#[path]`) so
//! `stats.rs` stays under the module size cap. Included as `mod tests;` from
//! `stats.rs`, so everything below is that module's body directly — no
//! `mod tests { ... }` wrapper here.
//!
//! Tests for the three sentinel-carrying enums (`BacklogAge`,
//! `ConsumerTimestamp`, `SubscriptionType`) and their normalisers live
//! next to those types instead, in `stats_sentinels_tests.rs`.

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

/// `packages/broker-contracts/src/topic-detail.ts`'s `StatsRequestScope`
/// mirrors this field-for-field; a rename on either side breaks the other
/// silently, so pin the wire shape here — following `BacklogAge`'s
/// precedent above, but unlike `BacklogAge` this is a plain object (three
/// bools), never an internally-tagged enum: there is no sentinel value to
/// carry, only "did this call ask or not".
#[test]
fn stats_request_scope_serialises_to_the_pinned_wire_shape() {
    // Fix round 1: spec §12.3 lists five parameters, not three —
    // `excludePublishers`/`excludeConsumers` were missing from the original
    // task brief's paraphrase. Both are pinned here alongside the original
    // three, all five `false` (this codebase needs full instance detail).
    assert_eq!(
        serde_json::to_value(TOPIC_STATS_REQUEST_SCOPE).unwrap(),
        serde_json::json!({
            "preciseBacklog": false,
            "subscriptionBacklogSize": false,
            "earliestTimeInBacklog": false,
            "excludePublishers": false,
            "excludeConsumers": false,
        })
    );
}

/// Every `TopicStats` `parse_topic_stats` produces is stamped with the
/// fixed scope this codebase actually requested — never a per-call
/// default, and never left for a caller to guess at. This is what lets the
/// UI trust `stats.statsRequestScope` as a true account of what was asked,
/// not just what this parser assumes.
#[test]
fn parsed_stats_carry_the_actual_request_scope() {
    let stats = parse_topic_stats(&real_fixture()).expect("parses");
    assert_eq!(stats.stats_request_scope, TOPIC_STATS_REQUEST_SCOPE);
    assert!(!stats.stats_request_scope.precise_backlog);
    assert!(!stats.stats_request_scope.subscription_backlog_size);
    assert!(!stats.stats_request_scope.earliest_time_in_backlog);
}

/// Whole-stage review item 4: `SHIPPED_SCOPE` in
/// `src/test/broker-scope-fixtures.ts` — the default `StatsRequestScope`
/// fixture every broker UI test is now required to render under — must
/// equal this constant. Neither side of the language boundary can import
/// the other's source, so both are pinned against the same checked-in
/// fixture instead:
/// `tests/fixtures/broker/shipped-stats-request-scope.json`.
///
/// This is the enforcement half of that contract: if
/// `TOPIC_STATS_REQUEST_SCOPE` ever changes, THIS test fails first, because
/// the checked-in fixture no longer matches. Fixing it here means editing
/// the fixture — and the next `pnpm test:ui` run then fails loudly on the
/// TS side too, because `broker-scope-fixtures.test.tsx` reads that exact
/// same file and compares it against the still-unedited `SHIPPED_SCOPE`
/// literal. Neither side can drift without the other noticing.
#[test]
fn topic_stats_request_scope_matches_the_shipped_scope_fixture_the_ts_side_reads() {
    let raw = include_str!("../../tests/fixtures/broker/shipped-stats-request-scope.json");
    let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    assert_eq!(serde_json::to_value(TOPIC_STATS_REQUEST_SCOPE).unwrap(), fixture);
}

/// Task 3: a `u64` counter above JS's safe-integer ceiling (2^53 - 1 =
/// 9,007,199,254,740,991) must cross the wire as a *quoted decimal string*,
/// never a bare JSON number — a bare number round-trips exactly inside
/// serde/Rust (u64 <-> u64), but silently rounds the instant the webview's
/// `JSON.parse` reads it as an IEEE-754 double. Asserting on the Rust value
/// alone (`stats.msg_in_counter == Some(u64::MAX)`) would not catch that: the
/// loss happens in JavaScript, not serde, so the test must inspect the
/// *serialised JSON text* itself. This must be red before the `serialize_with`
/// change lands — see the report for the failing output.
#[test]
fn msg_in_counter_above_2_pow_53_survives_the_wire_as_a_quoted_decimal_string() {
    let mut raw = real_fixture();
    raw["msgInCounter"] = serde_json::json!(u64::MAX);
    raw["storageSize"] = serde_json::json!(u64::MAX);
    raw["backlogSize"] = serde_json::json!(u64::MAX);
    let stats = parse_topic_stats(&raw).expect("parses");

    // Sanity check: the value survives the Rust-side parse exactly. This
    // alone is not the property under test — see the doc comment above.
    assert_eq!(stats.msg_in_counter, Some(u64::MAX));
    assert_eq!(stats.storage_size, Some(u64::MAX));
    assert_eq!(stats.backlog_size, Some(u64::MAX));

    let json = serde_json::to_string(&stats).expect("serializes");
    assert!(
        json.contains("\"msgInCounter\":\"18446744073709551615\""),
        "msgInCounter must serialise as a quoted decimal string, got: {json}"
    );
    assert!(
        json.contains("\"storageSize\":\"18446744073709551615\""),
        "storageSize must serialise as a quoted decimal string, got: {json}"
    );
    assert!(
        json.contains("\"backlogSize\":\"18446744073709551615\""),
        "backlogSize must serialise as a quoted decimal string, got: {json}"
    );
    // And never as a bare number under the same key — the specific failure
    // mode this test exists to catch.
    assert!(!json.contains("\"msgInCounter\":18446744073709551615"));
    assert!(!json.contains("\"storageSize\":18446744073709551615"));
    assert!(!json.contains("\"backlogSize\":18446744073709551615"));
}

/// A withheld counter must stay distinguishable from a present one: `None`
/// serialises as JSON `null`, never as a quoted string (which would read as
/// a real, if odd, value) and never as a bare `0` (which would read as a
/// measured queue).
#[test]
fn a_missing_u64_counter_serialises_as_null_not_a_string_or_zero() {
    let mut raw = real_fixture();
    raw.as_object_mut().unwrap().remove("msgInCounter");
    raw.as_object_mut().unwrap().remove("storageSize");
    raw.as_object_mut().unwrap().remove("backlogSize");
    let stats = parse_topic_stats(&raw).expect("still parses");
    assert_eq!(stats.msg_in_counter, None);

    let json = serde_json::to_string(&stats).expect("serializes");
    assert!(json.contains("\"msgInCounter\":null"), "got: {json}");
    assert!(json.contains("\"storageSize\":null"), "got: {json}");
    assert!(json.contains("\"backlogSize\":null"), "got: {json}");
}
