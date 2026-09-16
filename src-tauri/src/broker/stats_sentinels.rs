//! In-band sentinel normalisers for `broker::stats`.
//!
//! Split out of `stats.rs` (Stage 0 housekeeping) purely to keep both files
//! under this project's line cap — `stats.rs` had grown back past the size
//! it was split away from once already. The seam: this file holds the three
//! sentinel-carrying enums (`BacklogAge`, `ConsumerTimestamp`,
//! `SubscriptionType`) and the normaliser functions that map Pulsar's
//! in-band magic values onto them, which is one coherent unit; `stats.rs`
//! keeps the parse entry point (`parse_topic_stats`) and the public structs
//! it builds, re-exporting these three types so every existing
//! `crate::broker::stats::{BacklogAge, ConsumerTimestamp, SubscriptionType}`
//! path keeps working unchanged. No behaviour changed by this split — see
//! `stats.rs`'s own module doc for the field-by-field `Option`-vs-default
//! rules these sentinel types exist alongside.
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

use serde::{Deserialize, Serialize};

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

/// Pulsar sends `-1` for `oldestBacklogMessageAgeSeconds` to mean "no
/// backlog has ever existed" — a determinate, healthy fact, not a missing
/// value or a negative duration one second short of zero. Only `-1` carries
/// that documented meaning: any other negative value maps to
/// [`BacklogAge::Unknown`] rather than [`BacklogAge::NoBacklog`], because
/// inventing a meaning for, say, `-7` would repeat the exact mistake this
/// type exists to fix, just for a different number.
pub(super) fn normalize_backlog_age(age: Option<i64>) -> BacklogAge {
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
pub(super) fn normalize_subscription_type(sub_type: Option<String>) -> SubscriptionType {
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
pub(super) fn normalize_consumer_timestamp(ts: Option<i64>) -> ConsumerTimestamp {
    match ts {
        None => ConsumerTimestamp::Unknown,
        Some(0) => ConsumerTimestamp::Never,
        Some(millis) => ConsumerTimestamp::Millis { millis },
    }
}

#[cfg(test)]
#[path = "stats_sentinels_tests.rs"]
mod tests;
