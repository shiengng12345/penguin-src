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
//!   value. Subscription type additionally has an in-band sentinel on top
//!   of ordinary absence — see "Sentinel values" below.
//! - **Timestamps** are `Option<i64>`. Epoch 0 is a real, very different
//!   instant (1970) from "never recorded" — collapsing the two would make a
//!   never-consumed subscription look ancient rather than untouched. The
//!   two consumer-level timestamps carry this same problem in-band, not
//!   just on absence — see "Sentinel values" below.
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
//! - **`subscriptions`** uses `#[serde(default)]` to an empty collection
//!   when the key itself is absent — a topic legitimately has zero
//!   subscriptions, and that is a fact, not an unknown.
//! - **`consumers`** (fix round 2) is `Option<Vec<ConsumerStats>>`, not a
//!   bare `Vec` defaulted to empty. An *explicit* empty array is Pulsar
//!   telling us nobody is attached — a fact `derive_anomalies` acts on (see
//!   `a_subscription_with_no_consumers_parses_with_an_empty_list`). The key
//!   being *absent* is a different fact entirely: we do not know who, if
//!   anyone, is attached. An earlier version of this module used
//!   `#[serde(default)]` here too, collapsing both into the same empty
//!   `Vec` — which meant a payload that simply omitted `consumers` read as
//!   "confirmed nobody attached" and could raise
//!   `AnomalyKind::BacklogWithNoConsumer` from data that was never actually
//!   present. That was the last remaining path where an unknown could
//!   become a confident claim; see `broker::anomaly`'s module doc for how
//!   it now handles `None` here.
//!
//! Fields the wire payload carries that this module does not map (dozens —
//! see the real fixture) are silently ignored: there is no
//! `#[serde(deny_unknown_fields)]` anywhere in this module, deliberately.
//!
//! ## Sentinel values (in-band magic numbers)
//!
//! `Option<T>` solves *absence* — a missing key. It does not by itself
//! solve Pulsar encoding "this doesn't apply" as an in-band value that
//! still type-checks. Three fields carry exactly this problem. Two of them
//! are normalized to plain `None` at the parse boundary — the only place
//! that knows Pulsar's wire conventions — so no downstream consumer has to
//! remember them:
//!
//! - **`type`** (subscription type, mapped as `sub_type`): Pulsar serializes
//!   an unset subscription type as the literal string `"None"` — not a
//!   member of its own `SubscriptionType` enum
//!   (`Exclusive`/`Shared`/`Failover`/`Key_Shared`). `"None"` is a sentinel
//!   wearing a string's clothing, and worse than `-1` in one respect: `-1`
//!   at least looks wrong, whereas "None" looks like a considered answer.
//!   The literal string `"None"` is normalized to `None`. Evidenced
//!   directly: **both** of `fpms_topup`'s real subscriptions send exactly
//!   `"type": "None"` today (captured, unmodified, in the fixture) — this
//!   was live on the user's own data, not a hypothetical.
//! - **`lastAckedTimestamp` / `lastConsumedTimestamp`** (consumer-level):
//!   Pulsar sends `0` when the consumer has never acked or consumed
//!   anything, not the Unix epoch. Epoch 0 is a real, very different
//!   instant (1 January 1970) from "never recorded" — showing it verbatim
//!   would make a consumer that never acknowledged anything look like it
//!   last did so 56 years ago, which an operator reads as a real and
//!   alarming timestamp rather than "nothing yet." Literal `0` is
//!   normalized to `None`. **Not evidenced on the live broker**: none of
//!   the user's topics has a connected consumer at capture time, so this
//!   rests on Pulsar's documented convention (the same "0 means never"
//!   default the equivalent subscription-level fields use) plus the
//!   reasoning above, not on anything actually observed here.
//!
//! The third field, `oldestBacklogMessageAgeSeconds`, does **not** collapse
//! to plain `None`: `-1` means "no backlog has ever existed," which is a
//! determinate, healthy fact, not an absent value — collapsing it into the
//! same `None` used for a genuinely withheld field would make "nothing to
//! check here" indistinguishable from "we could not tell," which is exactly
//! backwards for a module whose entire purpose is telling those two apart.
//! It is mapped as [`BacklogAge`] instead, a three-state type (see its own
//! doc). Evidenced directly: the live `fpms_topup` topic sends `-1` today
//! (captured, unmodified, in the fixture).
//!
//! A sweep of every other mapped field for a similar convention (a `-1`, a
//! `Long.MAX_VALUE`, an empty-string-means-unset) found no further case
//! warranting the same treatment: counters (`storageSize`, `backlogSize`,
//! `msgInCounter`, subscription/consumer `unackedMessages`/`msgBacklog`,
//! `availablePermits`) are unsigned or plain counts with no documented
//! negative-sentinel convention — a real `0` is a real zero — and
//! rates/throughput are computed non-negative doubles with no sentinel.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use crate::broker::stats_wire::RawTopicStats;
use serde::{Deserialize, Serialize};

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
    pub oldest_backlog_message_age: BacklogAge,
    pub subscriptions: Vec<SubscriptionStats>,
}

/// The age of a topic's oldest backlog message, as Pulsar's
/// `oldestBacklogMessageAgeSeconds` actually distinguishes three cases that
/// a bare `Option<i64>` cannot: a real age, a documented "healthy, nothing
/// to check" sentinel, and genuine absence. Merging the last two (as an
/// earlier version of this module did) made every quiescent topic — which
/// commonly sends the `-1` sentinel — report as "could not tell" on the
/// anomaly panel, indistinguishable from a topic where the field was
/// actually withheld. Mirrors `BacklogAge` in
/// `packages/broker-contracts/src/anomaly.ts` field-for-field; the wire
/// shape (an internally-tagged `{"state": ...}` object) is pinned by
/// `backlog_age_serialises_to_the_pinned_wire_shape` in `stats_tests.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum BacklogAge {
    /// A backlog exists and its oldest message is this many seconds old.
    Seconds { seconds: u64 },
    /// Pulsar's `-1`: no backlog has ever existed. A determinate, healthy
    /// fact — there is nothing here for an anomaly check to be unsure about.
    NoBacklog,
    /// The field was absent, or carried a negative value other than the
    /// documented `-1` sentinel. We do not know the backlog's age.
    Unknown,
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
    /// `None` when Pulsar omitted the `consumers` key entirely — we do not
    /// know who, if anyone, is attached. `Some(vec![])` is a different,
    /// determinate fact: Pulsar sent the key with zero entries, i.e.
    /// "confirmed nobody attached". See the module doc's "fix round 2" note.
    pub consumers: Option<Vec<ConsumerStats>>,
}

/// The parsed subset of one entry in a subscription's `consumers` array.
///
/// `Default` is derived (every field is `Option`, so `None` is a legitimate
/// default) purely so `anomaly.rs`'s tests can build a `ConsumerStats` with
/// `..Default::default()` and set only the field under test — production
/// code always goes through `parse_topic_stats` and never relies on this.
#[derive(Debug, Clone, Default, PartialEq)]
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
            sub_type: normalize_sub_type(sub.sub_type),
            consumers: sub.consumers.map(|consumers| {
                consumers
                    .into_iter()
                    .map(|c| ConsumerStats {
                        consumer_name: c.consumer_name,
                        address: c.address,
                        client_version: c.client_version,
                        available_permits: c.available_permits,
                        unacked_messages: c.unacked_messages,
                        last_acked_timestamp: normalize_never_timestamp(c.last_acked_timestamp),
                        last_consumed_timestamp: normalize_never_timestamp(c.last_consumed_timestamp),
                        msg_rate_out: c.msg_rate_out,
                        blocked_on_unacked_msgs: c.blocked_on_unacked_msgs,
                    })
                    .collect()
            }),
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
        oldest_backlog_message_age: normalize_backlog_age(
            parsed.oldest_backlog_message_age_seconds,
        ),
        subscriptions,
    })
}

/// Pulsar sends `-1` for `oldestBacklogMessageAgeSeconds` to mean "no
/// backlog has ever existed" — a determinate, healthy fact, not a missing
/// value or a negative duration one second short of zero. Only `-1` carries
/// that documented meaning: any other negative value maps to
/// [`BacklogAge::Unknown`] rather than [`BacklogAge::NoBacklog`], because
/// inventing a meaning for, say, `-7` would repeat the exact mistake this
/// type exists to fix, just for a different number.
fn normalize_backlog_age(age: Option<i64>) -> BacklogAge {
    match age {
        None => BacklogAge::Unknown,
        Some(-1) => BacklogAge::NoBacklog,
        Some(seconds) if seconds >= 0 => BacklogAge::Seconds { seconds: seconds as u64 },
        Some(_) => BacklogAge::Unknown,
    }
}

/// Pulsar serializes an unset subscription type as the literal string
/// `"None"` — not a member of its own `SubscriptionType` enum. Both of
/// `fpms_topup`'s real subscriptions send exactly this today; passing it
/// through would print the word "None" as if it were a real subscription
/// type. Normalized to `None` here, at the one place that knows the wire
/// convention.
fn normalize_sub_type(sub_type: Option<String>) -> Option<String> {
    sub_type.filter(|value| value != "None")
}

/// Pulsar sends `0` for `lastAckedTimestamp` / `lastConsumedTimestamp` when
/// the consumer has never acked or consumed anything — not the Unix epoch.
/// Shown verbatim, a consumer that has never acknowledged anything would
/// appear to have last done so on 1 January 1970, which an operator reads
/// as a real and alarming timestamp rather than "nothing yet." Normalized
/// to `None` here. This cannot be observed on the live broker today (no
/// topic has a connected consumer at capture time); it rests on Pulsar's
/// documented "0 means never" convention, not on captured evidence.
fn normalize_never_timestamp(ts: Option<i64>) -> Option<i64> {
    ts.filter(|value| *value != 0)
}

#[cfg(test)]
#[path = "stats_tests.rs"]
mod tests;
