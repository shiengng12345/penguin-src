//! Parses the subset of Pulsar's topic `stats` payload the UI uses.
//!
//! Pulsar's stats payload carries dozens of fields the UI never reads, and
//! the set of fields changes between broker versions. This module maps only
//! the subset the UI actually uses and must tolerate everything else — an
//! unknown field arriving in a future Pulsar release must never fail the
//! parse (see `an_unknown_field_does_not_break_the_parse` below).
//!
//! Read-only: this module never touches the cache, the store, or the
//! database. It only turns a `serde_json::Value` into typed structs.
//!
//! ## Option<T> vs. a defaulted value
//!
//! Every mapped field below was assigned deliberately to one of two
//! treatments, never uniformly `#[serde(default)]` for convenience:
//!
//! - **Counts that answer "is the queue stuck" (backlog sizes, unacked
//!   counts, in-counters)** are `Option<T>`. A field silently defaulting to
//!   0 here would tell an operator the queue is drained or idle when we
//!   simply could not read the number — worse than an error, because 0
//!   looks like an answer.
//! - **Identity/diagnostic strings (consumer name, address, client version,
//!   subscription type)** are `Option<String>`. An empty string is a
//!   plausible real value for some of these upstream, so defaulting a
//!   missing field to `""` would be indistinguishable from a real empty
//!   value.
//! - **Timestamps** are `Option<i64>`. Epoch 0 is a real, very different
//!   instant (1970) from "never recorded" — collapsing the two would make a
//!   never-consumed subscription look ancient rather than untouched.
//! - **`blocked_on_unacked_msgs`** is `Option<bool>` specifically, per the
//!   brief: this is the single most diagnostic consumer field (the broker
//!   itself stopped delivering) and must never be inferred. Defaulting
//!   absence to `false` would say "not blocked" for a consumer we simply
//!   have no data on.
//! - **Rates and throughput (`msgRateIn/Out`, `msgThroughputIn/Out`,
//!   subscription/consumer `msgRateOut`)** are `Option<f64>`. `msgRateOut`
//!   is the delivery signal Task 7's anomaly derivation reads to decide
//!   whether a subscription with a backlog has anyone actually consuming —
//!   it is the number an operator looks at first, not a supplementary one.
//!   A genuinely quiet topic legitimately reports `Some(0.0)`; a field a
//!   future Pulsar release renames must report `None` instead, because
//!   collapsing the two into a bare `0.0` would make "we lost the field"
//!   indistinguishable from "delivery has stopped" during triage — sending
//!   someone chasing an outage that does not exist.
//! - **`subscriptions` / `consumers` collections** use `#[serde(default)]`
//!   to an empty collection when the key itself is absent. An empty list of
//!   consumers is meaningful and actionable on its own (see
//!   `a_subscription_with_no_consumers_parses_with_an_empty_list`), unlike a
//!   scalar count where 0 and "unknown" collide.
//!
//! Fields the wire payload carries that this module does not map (dozens —
//! see the real fixture) are silently ignored: there is no
//! `#[serde(deny_unknown_fields)]` anywhere in this module, deliberately.
//!
//! ## Sentinel values (in-band magic numbers)
//!
//! `Option<T>` solves *absence* — a missing key. It does not by itself
//! solve Pulsar encoding "this doesn't apply" as an in-band number that
//! still type-checks. `oldestBacklogMessageAgeSeconds` is documented Pulsar
//! behavior: `-1` means "no backlog has ever existed," not "the backlog is
//! 1 second younger than 0." Passed through verbatim, a screen would show
//! "oldest backlog message: -1 seconds," which is not a fact about
//! anything. This module normalizes any negative value to `None` at the
//! parse boundary — the only place that knows Pulsar's wire convention — so
//! no downstream consumer has to remember the sentinel.
//!
//! A sweep of every other mapped field for a similar convention (a `-1`, a
//! `Long.MAX_VALUE`, an empty-string-means-unset) found no other case that
//! warrants the same treatment here:
//! - Counters (`storageSize`, `backlogSize`, `msgInCounter`,
//!   subscription/consumer `unackedMessages`/`msgBacklog`,
//!   `availablePermits`) are unsigned or plain counts with no documented
//!   negative-sentinel convention; a real `0` is a real zero.
//! - Rates/throughput are computed non-negative doubles; no sentinel.
//! - `lastAckedTimestamp` / `lastConsumedTimestamp` (consumer-level): Pulsar
//!   itself defaults these to `0` (epoch) when nothing has happened yet,
//!   which is arguably the same class of problem as the age sentinel — an
//!   explicit `0` here is ambiguous between "acked at the Unix epoch" and
//!   "never acked." It is called out here rather than silently normalized:
//!   unlike `-1` seconds (which cannot be a real duration), epoch 0 cannot
//!   be ruled out as a real instant by inspection alone, so collapsing it
//!   to `None` is a product decision this module should not make
//!   unilaterally. Flagged for a follow-up rather than acted on.
//! - `type` (subscription type, mapped as `sub_type`): the real fixture
//!   shows the literal string `"None"` when no consumer has ever
//!   connected — not a member of Pulsar's `SubscriptionType` enum
//!   (`Exclusive`/`Shared`/`Failover`/`Key_Shared`), so it reads like a
//!   serialization of "unset." Left as a verbatim `Some("None")` pass
//!   through rather than guessed at: normalizing a string sentinel on
//!   suspicion, without a documented convention to point to the way
//!   `-1` is documented, risks inventing a rule Pulsar doesn't actually
//!   have. Flagged for a follow-up rather than acted on.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use crate::broker::stats_wire::RawTopicStats;

/// The parsed subset of a Pulsar topic's `stats` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct TopicStats {
    pub msg_rate_in: Option<f64>,
    pub msg_rate_out: Option<f64>,
    pub msg_throughput_in: Option<f64>,
    pub msg_throughput_out: Option<f64>,
    pub storage_size: Option<u64>,
    pub backlog_size: Option<u64>,
    pub msg_in_counter: Option<u64>,
    pub oldest_backlog_message_age_seconds: Option<i64>,
    pub subscriptions: Vec<SubscriptionStats>,
}

/// The parsed subset of one entry in the `subscriptions` map of a topic's
/// `stats` payload. `name` is not a field of the wire object itself — it is
/// the map key the object was found under.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionStats {
    pub name: String,
    pub msg_backlog: Option<u64>,
    pub unacked_messages: Option<u64>,
    pub msg_rate_out: Option<f64>,
    pub sub_type: Option<String>,
    pub consumers: Vec<ConsumerStats>,
}

/// The parsed subset of one entry in a subscription's `consumers` array.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsumerStats {
    pub consumer_name: Option<String>,
    pub address: Option<String>,
    pub client_version: Option<String>,
    pub available_permits: Option<i64>,
    pub unacked_messages: Option<u64>,
    pub last_acked_timestamp: Option<i64>,
    pub last_consumed_timestamp: Option<i64>,
    pub msg_rate_out: Option<f64>,
    pub blocked_on_unacked_msgs: Option<bool>,
}

/// Parses the subset of a Pulsar topic `stats` response this module maps.
///
/// A field that is missing entirely is not an error (see the field-by-field
/// `Option`-vs-default reasoning in the module doc above). A field that is
/// present but the wrong JSON type is a [`BrokerErrorCode::MalformedResponse`]
/// — silently coercing it to a default would report a fabricated number as
/// fact. The error message names the JSON path of the offending field (via
/// `serde_path_to_error`) rather than just the bare type-mismatch message,
/// because `subscriptions` is keyed by name and nests a `consumers` array —
/// without a path, nothing tells a diagnosing engineer where to look.
pub fn parse_topic_stats(raw: &serde_json::Value) -> Result<TopicStats, BrokerError> {
    let parsed: RawTopicStats = serde_path_to_error::deserialize(raw).map_err(|e| BrokerError {
        code: BrokerErrorCode::MalformedResponse,
        message: format!("failed to parse topic stats at `{}`: {}", e.path(), e.inner()),
        retryable: false,
    })?;

    // BTreeMap iterates in key order already, so this is sorted by
    // construction — but subsequent SubscriptionStats identity does not
    // depend on that being a BTreeMap implementation detail, so we still
    // sort explicitly below.
    let mut subscriptions: Vec<SubscriptionStats> = parsed
        .subscriptions
        .into_iter()
        .map(|(name, sub)| SubscriptionStats {
            name,
            msg_backlog: sub.msg_backlog,
            unacked_messages: sub.unacked_messages,
            msg_rate_out: sub.msg_rate_out,
            sub_type: sub.sub_type,
            consumers: sub
                .consumers
                .into_iter()
                .map(|c| ConsumerStats {
                    consumer_name: c.consumer_name,
                    address: c.address,
                    client_version: c.client_version,
                    available_permits: c.available_permits,
                    unacked_messages: c.unacked_messages,
                    last_acked_timestamp: c.last_acked_timestamp,
                    last_consumed_timestamp: c.last_consumed_timestamp,
                    msg_rate_out: c.msg_rate_out,
                    blocked_on_unacked_msgs: c.blocked_on_unacked_msgs,
                })
                .collect(),
        })
        .collect();
    subscriptions.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(TopicStats {
        msg_rate_in: parsed.msg_rate_in,
        msg_rate_out: parsed.msg_rate_out,
        msg_throughput_in: parsed.msg_throughput_in,
        msg_throughput_out: parsed.msg_throughput_out,
        storage_size: parsed.storage_size,
        backlog_size: parsed.backlog_size,
        msg_in_counter: parsed.msg_in_counter,
        oldest_backlog_message_age_seconds: normalize_backlog_age(
            parsed.oldest_backlog_message_age_seconds,
        ),
        subscriptions,
    })
}

/// Pulsar sends `-1` for `oldestBacklogMessageAgeSeconds` to mean "no
/// backlog has ever existed," not a negative duration. A screen rendering
/// that value verbatim would report "-1 seconds," which is not a fact about
/// anything, so it is normalized to `None` here, at the one place that
/// knows the wire convention. Any negative value (not only exactly `-1`) is
/// treated the same way, in case a future broker version picks a different
/// negative sentinel for the same "not applicable" meaning.
fn normalize_backlog_age(age: Option<i64>) -> Option<i64> {
    age.filter(|seconds| *seconds >= 0)
}

#[cfg(test)]
mod tests {
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
        // oldestBacklogMessageAgeSeconds is absent on topics that never had a
        // backlog. That is normal, not a failure.
        let mut raw = real_fixture();
        raw.as_object_mut().unwrap().remove("oldestBacklogMessageAgeSeconds");
        let stats = parse_topic_stats(&raw).expect("still parses");
        assert_eq!(stats.oldest_backlog_message_age_seconds, None);
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
        // present, nobody consuming.
        let mut raw = real_fixture();
        raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] =
            serde_json::json!([]);
        let stats = parse_topic_stats(&raw).expect("parses");
        let sub = stats
            .subscriptions
            .iter()
            .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
            .expect("subscription present");
        assert!(sub.consumers.is_empty());
    }

    #[test]
    fn blocked_on_unacked_is_carried_through_verbatim() {
        // The single most diagnostic consumer field — it says the broker
        // itself stopped delivering. It must never be inferred or defaulted.
        let mut raw = real_fixture();
        raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] =
            serde_json::json!([{
                "consumerName": "probe",
                "blockedConsumerOnUnackedMsgs": true
            }]);
        let stats = parse_topic_stats(&raw).expect("parses");
        let sub = stats.subscriptions.iter()
            .find(|s| s.name == "rg_deposit_accumulate_LOCAL").unwrap();
        assert_eq!(sub.consumers[0].blocked_on_unacked_msgs, Some(true));
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
        assert_eq!(sub.consumers[0].blocked_on_unacked_msgs, None);
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
        assert_eq!(sub.consumers[0].msg_rate_out, None);
    }

    /// The live broker sends `-1` for this field on `fpms_topup` today
    /// (see the captured fixture, unmodified). `-1` is Pulsar's documented
    /// sentinel for "no backlog has ever existed," not a negative duration
    /// one second short of zero — passing it through as a number would let
    /// a screen say "oldest backlog message: -1 seconds," which is not a
    /// fact about anything.
    #[test]
    fn pulsars_negative_one_backlog_age_sentinel_becomes_unknown_not_a_negative_duration() {
        let stats = parse_topic_stats(&real_fixture()).expect("parses");
        assert_eq!(stats.oldest_backlog_message_age_seconds, None);
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
        assert_eq!(sub.consumers[0].consumer_name.as_deref(), Some("probe"));
        assert_eq!(sub.consumers[0].unacked_messages, Some(7));
    }
}
