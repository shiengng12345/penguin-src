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
//! - **Identity/diagnostic strings (consumer name, address, client
//!   version)** are `Option<String>`. An empty string is a plausible real
//!   value for some of these upstream, so defaulting a missing field to `""`
//!   would be indistinguishable from a real empty value.
//! - **`sub_type`** (subscription type) is [`SubscriptionType`], not
//!   `Option<String>` — it carries an in-band sentinel on top of ordinary
//!   absence, the same shape of problem as `oldest_backlog_message_age` and
//!   the consumer timestamps below; see "Sentinel values" below and
//!   `SubscriptionType`'s own doc.
//! - **`last_acked_timestamp` / `last_consumed_timestamp`** (consumer-level)
//!   are [`ConsumerTimestamp`], not `Option<i64>`. Epoch 0 is a real, very
//!   different instant (1970) from "never acked/consumed" — and (fix round
//!   1, task 11) "never acked/consumed" is itself a determinate fact,
//!   distinct from the field having been withheld. A bare `Option<i64>`
//!   cannot hold all three; see "Sentinel values" below and
//!   `ConsumerTimestamp`'s own doc.
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
//! still type-checks. Three field groups carry exactly this problem, and
//! (Phase A final review, finding 2) all three turned out to need the same
//! treatment: none of them collapses to plain `None`/absence, because each
//! carries a *determinate*, in-band fact that is a different thing entirely
//! from absence. Collapsing any of them into `None` would make a healthy,
//! observed answer indistinguishable from "we could not tell" — exactly
//! backwards for a module whose whole purpose is telling those two apart.
//! Each is mapped as its own three-state type instead:
//!
//! - **`type`** (subscription type, mapped as `sub_type`): Pulsar serializes
//!   an unset subscription type as the literal string `"None"` — not a
//!   member of its own dispatcher-type vocabulary
//!   (`Exclusive`/`Shared`/`Failover`/`Key_Shared`), but a determinate fact
//!   in its own right: no consumer has ever claimed a dispatcher type for
//!   this subscription. Worse than `-1` in one respect: `-1` at least looks
//!   wrong, whereas "None" looks like a considered answer, and happens to be
//!   our own vocabulary for absence. An earlier version of this module
//!   normalized the literal string `"None"` straight to `None`, merging it
//!   with a genuinely withheld field — the identical mistake fixed for
//!   `oldestBacklogMessageAgeSeconds` below and for the consumer timestamps,
//!   left uncorrected here until now. Mapped as [`SubscriptionType`] (see its
//!   own doc). Evidenced directly: **both** of `fpms_topup`'s real
//!   subscriptions send exactly `"type": "None"` today (captured,
//!   unmodified, in the fixture) — this was live on the user's own data, not
//!   a hypothetical.
//! - `oldestBacklogMessageAgeSeconds`: `-1` means "no backlog has ever
//!   existed," a determinate, healthy fact, not an absent value or a
//!   negative duration one second short of zero. Mapped as [`BacklogAge`]
//!   (see its own doc). Evidenced directly: the live `fpms_topup` topic
//!   sends `-1` today (captured, unmodified, in the fixture).
//! - **`lastAckedTimestamp` / `lastConsumedTimestamp`** (consumer-level):
//!   Pulsar sends `0` when the consumer has never acked or consumed
//!   anything, not the Unix epoch — and that "never" is itself a
//!   determinate fact, not the same thing as the field being withheld. (Fix
//!   round 1, task 11: an earlier version of this module normalized both
//!   `0` and a genuinely absent field to the same `None`, which repeated
//!   the exact mistake `BacklogAge` was built one task earlier to fix — for
//!   a different field, one task later. "Definitely never acked" and "we
//!   don't know" both printed as "Unknown" on screen, and paired with
//!   `blocked_on_unacked_msgs`, "attached but has never acked" — exactly the
//!   signal an operator wants from this pairing — was unreportable.) Mapped
//!   as [`ConsumerTimestamp`] instead (see its own doc). **Not evidenced on
//!   the live broker**: none of the user's topics has a connected consumer
//!   at capture time, so this rests on Pulsar's documented "0 means never"
//!   convention, not on anything actually observed here.
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

/// What this call actually asked the broker for, alongside the stats it
/// returned (Task 1, controller ruling R34).
///
/// The product spec's §14.1 sketch asked for a generic `Metric<T>` with a
/// seven-state `quality` tag on every field. That is rejected: of the seven
/// states, only `notRequested` genuinely varies field-by-field within one
/// response (`forbidden` is response-level — a 403 the envelope already
/// carries; `unsupported` needs a per-broker-version capability matrix that
/// does not exist until Stage B). And the existing three-state enums
/// (`BacklogAge`, `ConsumerTimestamp`, `SubscriptionType`) already carry
/// *more* information than a generic `quality` tag would — collapsing
/// `BacklogAge::NoBacklog` (a determinate, healthy fact) into a bare
/// `quality: "unknown"` would destroy exactly the distinction those types
/// exist to preserve. This struct adds only the one axis those enums cannot
/// express on their own: whether the underlying REST call even asked.
///
/// Mirrors `StatsRequestScope` in
/// `packages/broker-contracts/src/topic-detail.ts` field-for-field; the wire
/// shape (a plain object, not an internally-tagged enum like `BacklogAge` —
/// there is no sentinel here, every field is a plain bool) is pinned by
/// `stats_request_scope_serialises_to_the_pinned_wire_shape` in
/// `stats_tests.rs`. The field↔flag mapping that tells the UI which
/// `TopicStats`/`SubscriptionStats` fields each flag governs lives in
/// TypeScript as code, not a comment — see
/// `src/components/broker/broker-value.ts` (ruling R38) — deliberately not
/// duplicated here as a list of strings for the UI to match against: that
/// is the exact defect the Overview panel was fixed for (a free-text list a
/// panel can only display, never reason about).
///
/// (Fix round 1, item 1) `precise_backlog` is **not** in the R38 "not
/// requested" mapping, on purpose: measured directly against the live
/// broker, `?getPreciseBacklog=false` and `?getPreciseBacklog=true` both
/// return `backlogSize` — the flag governs the number's *precision*, not
/// its presence. Rendering "Not requested" for a field the broker actually
/// answered would be the inverse of the lie this whole task exists to stop
/// (hiding a real number rather than fabricating a missing one). The flag
/// still belongs in this struct — it is a true, useful record of what was
/// asked — just not in the field-presence mapping.
///
/// (Fix round 1, item 4) This struct records **what this call asked for,
/// never what the broker actually did.** A 200 response does not prove the
/// broker honoured every query parameter — an unfamiliar broker version may
/// silently ignore a parameter it does not recognise (spec §12.3's closing
/// caution) — so `StatsRequestScope` is a fact about the request this
/// process sent, not a measurement of the broker's behaviour. Nothing in
/// this codebase may present it as the latter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRequestScope {
    /// `getPreciseBacklog` query parameter. Governs whether `backlogSize`
    /// was computed precisely (walking ledger metadata) or as a fast
    /// estimate — Pulsar always returns *a* number either way (measured
    /// directly — see the struct doc's fix-round-1 note), so this flag
    /// affects the number's precision, not its presence. Deliberately
    /// excluded from the R38 "not requested" field mapping for that reason.
    pub precise_backlog: bool,
    /// `subscriptionBacklogSize` query parameter. Per spec §12.3, computing
    /// this precisely can take ledger locks and is unsafe to request
    /// unconditionally against a busy broker — this is the flag Task 1
    /// exists to pin to `false` explicitly, rather than silently inheriting
    /// whatever the REST default happens to be.
    pub subscription_backlog_size: bool,
    /// `getEarliestTimeInBacklog` query parameter.
    pub earliest_time_in_backlog: bool,
    /// `excludePublishers` query parameter. Spec §12.3's default policy is
    /// "true for a lightweight view, false when instance detail is needed" —
    /// this codebase needs instance detail, so it is requested `false`
    /// explicitly (never left to the REST default, per the same §12.3
    /// caution `subscription_backlog_size` follows). No mapped field
    /// currently reads Pulsar's `publishers` array — nothing to gate on this
    /// flag yet — but it is recorded here so that changes the day something
    /// does.
    pub exclude_publishers: bool,
    /// `excludeConsumers` query parameter. Same default policy as
    /// `exclude_publishers`, requested `false` for the same reason. Measured
    /// directly against the live broker (fix round 1, item 3):
    /// `?excludeConsumers=true` returns `consumers: []` — **byte-identical**
    /// to a subscription Pulsar has confirmed has nobody attached. An
    /// excluded list is not an empty list (spec §12.3: "被排除的列表不是「列表为空」").
    /// `broker::anomaly` reads this flag directly off `TopicStats` and
    /// treats an excluded consumer list exactly like a withheld one (`None`)
    /// — see that module's doc for why `BacklogWithNoConsumer` must never
    /// fire from data this call declined to receive.
    pub exclude_consumers: bool,
}

/// The fixed `/stats` request scope this codebase sends today (Task 1; fix
/// round 1 added the last two fields): `PulsarAdminRest::get_topic_stats`
/// builds its request URL from exactly these five values, and
/// `parse_topic_stats` stamps every `TopicStats` it produces with this same
/// constant. One source of truth, so the URL that was actually sent and the
/// scope the UI (and `broker::anomaly`) are told to trust can never drift
/// apart. All five are `false` — the REST defaults are not the same as the
/// CLI defaults, and this codebase needs full instance detail (not the
/// lightweight view `exclude_publishers`/`exclude_consumers: true` would
/// give), so every flag is asked explicitly rather than inheriting whatever
/// the broker's REST default happens to be (spec §12.3).
pub const TOPIC_STATS_REQUEST_SCOPE: StatsRequestScope = StatsRequestScope {
    precise_backlog: false,
    subscription_backlog_size: false,
    earliest_time_in_backlog: false,
    exclude_publishers: false,
    exclude_consumers: false,
};

/// The parsed subset of a Pulsar topic's `stats` payload.
///
/// `Serialize` (Task 8) is additive: every other consumer of this type
/// (`anomaly.rs`, this module's own tests) only ever builds or matches on
/// it in-process. Task 8 is the first to put it on the wire —
/// `TopicDetailDto.stats` in `broker::commands::topic_detail` — so this is
/// where the derive was added, `rename_all = "camelCase"` to match the
/// mirror in `packages/broker-contracts/src/topic-detail.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
    /// What this call actually asked the broker for (Task 1, R34) — see
    /// [`StatsRequestScope`]'s own doc.
    pub stats_request_scope: StatsRequestScope,
}

/// The age of a topic's oldest backlog message, as Pulsar's
/// `oldestBacklogMessageAgeSeconds` actually distinguishes three cases that
/// a bare `Option<i64>` cannot: a real age, a documented "healthy, nothing
/// to check" sentinel, and genuine absence. Merging the last two (as an
/// earlier version of this module did) made every quiescent topic — which
/// commonly sends the `-1` sentinel — report as "could not tell" on the
/// anomaly panel, indistinguishable from a topic where the field was
/// actually withheld. Mirrors `BacklogAge` in
/// `packages/broker-contracts/src/topic-detail.ts` field-for-field; the wire
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

/// A consumer's `lastAckedTimestamp`/`lastConsumedTimestamp`, as Pulsar's
/// wire value actually distinguishes three cases a bare `Option<i64>`
/// cannot: a real epoch-millisecond timestamp, Pulsar's own documented `0`
/// sentinel ("this consumer has never acked/consumed" — a determinate fact,
/// not a missing value), and genuine absence. (Fix round 1, task 11: an
/// earlier version of this module normalized `0` and absence to the same
/// `None`, repeating for this field the exact mistake `BacklogAge` exists to
/// fix for `oldestBacklogMessageAgeSeconds` — see the module doc's "Sentinel
/// values" section.) Mirrors `BacklogAge` field-for-field, including the
/// wire shape (an internally-tagged `{"state": ...}` object), pinned by
/// `consumer_timestamp_serialises_to_the_pinned_wire_shape` in
/// `stats_tests.rs`. Mirrored in
/// `packages/broker-contracts/src/topic-detail.ts` as `ConsumerTimestamp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ConsumerTimestamp {
    /// A real timestamp, in the epoch milliseconds Pulsar sends on the wire.
    Millis { millis: i64 },
    /// Pulsar's `0`: the consumer has never acked (or consumed, for
    /// `last_consumed_timestamp`). A determinate fact — there is nothing
    /// here for an anomaly check to be unsure about — not the Unix epoch.
    Never,
    /// The field was absent. We do not know.
    #[default]
    Unknown,
}

/// A subscription's dispatcher `type`, as Pulsar's wire value actually
/// distinguishes three cases a bare `Option<String>` cannot: a real, named
/// dispatcher type (`Exclusive`/`Shared`/`Failover`/`Key_Shared`), Pulsar's
/// own documented `"None"` sentinel ("no consumer has ever claimed a
/// dispatcher type for this subscription" — a determinate fact, not a
/// missing value), and genuine absence (the field was withheld). Phase A
/// final review, finding 2: this is the third field group with exactly the
/// shape [`BacklogAge`] and [`ConsumerTimestamp`] were each built to fix —
/// an earlier version of this module folded the `"None"` sentinel into
/// plain absence via `Option::filter`, so both printed as "Unknown" and
/// "the broker withheld this field" became indistinguishable from "the
/// broker answered: nobody has claimed a type." Mirrors `BacklogAge` and
/// `ConsumerTimestamp` field-for-field, including the wire shape (an
/// internally-tagged `{"state": ...}` object), pinned by
/// `subscription_type_serialises_to_the_pinned_wire_shape` in
/// `stats_tests.rs`. Mirrored in
/// `packages/broker-contracts/src/topic-detail.ts` as `SubscriptionType`.
///
/// Deliberately not unified with `BacklogAge`/`ConsumerTimestamp` behind a
/// generic `Tri<T>`: three occurrences is a pattern, but the three carry
/// different payloads (`u64` seconds, `i64` millis, a `String` name) and
/// different domain meanings, and a generic would obscure both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SubscriptionType {
    /// A real, named dispatcher type exactly as Pulsar reports it (e.g.
    /// `"Shared"`, `"Exclusive"`, `"Failover"`, `"Key_Shared"`).
    Named { name: String },
    /// Pulsar's `"None"`: no consumer has ever claimed a dispatcher type for
    /// this subscription. A determinate fact — there is nothing here for an
    /// anomaly check to be unsure about — not the same thing as the field
    /// being withheld.
    Unset,
    /// The field was absent. We do not know.
    Unknown,
}

/// The parsed subset of one entry in the `subscriptions` map of a topic's
/// `stats` payload. `name` is not a field of the wire object itself — it is
/// the map key the object was found under.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStats {
    pub name: String,
    pub msg_backlog: Option<u64>,
    pub unacked_messages: Option<u64>,
    pub msg_rate_out: Option<f64>,
    pub sub_type: SubscriptionType,
    /// `None` when Pulsar omitted the `consumers` key entirely — we do not
    /// know who, if anyone, is attached. `Some(vec![])` is a different,
    /// determinate fact: Pulsar sent the key with zero entries, i.e.
    /// "confirmed nobody attached". See the module doc's "fix round 2" note.
    pub consumers: Option<Vec<ConsumerStats>>,
}

/// The parsed subset of one entry in a subscription's `consumers` array.
///
/// `Default` is derived — every `Option` field defaults to `None` and both
/// `ConsumerTimestamp` fields default to `ConsumerTimestamp::Unknown` (its
/// own derived default) — purely so `anomaly.rs`'s tests can build a
/// `ConsumerStats` with `..Default::default()` and set only the field under
/// test — production code always goes through `parse_topic_stats` and never
/// relies on this.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerStats {
    pub consumer_name: Option<String>,
    pub address: Option<String>,
    pub client_version: Option<String>,
    pub available_permits: Option<i64>,
    pub unacked_messages: Option<u64>,
    pub last_acked_timestamp: ConsumerTimestamp,
    pub last_consumed_timestamp: ConsumerTimestamp,
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
            sub_type: normalize_subscription_type(sub.sub_type),
            consumers: sub.consumers.map(|consumers| {
                consumers
                    .into_iter()
                    .map(|c| ConsumerStats {
                        consumer_name: c.consumer_name,
                        address: c.address,
                        client_version: c.client_version,
                        available_permits: c.available_permits,
                        unacked_messages: c.unacked_messages,
                        last_acked_timestamp: normalize_consumer_timestamp(c.last_acked_timestamp),
                        last_consumed_timestamp: normalize_consumer_timestamp(
                            c.last_consumed_timestamp,
                        ),
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
        stats_request_scope: TOPIC_STATS_REQUEST_SCOPE,
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
/// `"None"` — a determinate fact ("no consumer has ever claimed a
/// dispatcher type for this subscription"), not a genuine dispatcher type
/// and not the same thing as the field being withheld. Both of
/// `fpms_topup`'s real subscriptions send exactly this today; passing it
/// through would print the word "None" as if it were a considered answer.
/// The two real inputs distinguished here are `None` (the key was absent —
/// genuinely unknown) and `Some("None")` (Pulsar's own sentinel, mapped to
/// [`SubscriptionType::Unset`]); mirrors `normalize_backlog_age` and
/// `normalize_consumer_timestamp` above. Phase A final review, finding 2:
/// an earlier version of this function used `Option::filter` to drop the
/// sentinel straight to `None`, merging it with genuine absence — the same
/// mistake fixed for the other two sentinel groups, left standing here.
fn normalize_subscription_type(sub_type: Option<String>) -> SubscriptionType {
    match sub_type {
        None => SubscriptionType::Unknown,
        Some(value) if value == "None" => SubscriptionType::Unset,
        Some(name) => SubscriptionType::Named { name },
    }
}

/// Pulsar sends `0` for `lastAckedTimestamp` / `lastConsumedTimestamp` when
/// the consumer has never acked or consumed anything — not the Unix epoch,
/// and (fix round 1, task 11) a determinate fact in its own right, not the
/// same thing as the field being withheld. The two real inputs distinguished
/// here are `None` (the key was absent — genuinely unknown) and `Some(0)`
/// (Pulsar's own "never" sentinel); mirrors `normalize_backlog_age` above.
/// This cannot be observed on the live broker today (no topic has a
/// connected consumer at capture time); it rests on Pulsar's documented "0
/// means never" convention, not on captured evidence.
fn normalize_consumer_timestamp(ts: Option<i64>) -> ConsumerTimestamp {
    match ts {
        None => ConsumerTimestamp::Unknown,
        Some(0) => ConsumerTimestamp::Never,
        Some(millis) => ConsumerTimestamp::Millis { millis },
    }
}

#[cfg(test)]
#[path = "stats_tests.rs"]
mod tests;
