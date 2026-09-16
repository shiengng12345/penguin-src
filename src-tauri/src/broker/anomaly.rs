//! Decides what counts as "wrong" on a topic. This is the logic behind the
//! Overview screen's anomaly panel (ruling D-A3: that panel answers "what is
//! broken", never "how many topics exist").
//!
//! Pure logic only — no I/O, no cache, no store, no network. Every input is
//! a value already parsed by `broker::stats`; every output is a plain value
//! handed back to the caller.
//!
//! ## The central rule: unknown is neither wrong nor fine
//!
//! `broker::stats` made almost every field `Option` on purpose, so that "the
//! broker did not report this" (`None`) is distinguishable from a real zero.
//! This module has to honour that distinction in both directions:
//!
//! - **A `None` never raises an [`Anomaly`].** If a subscription's
//!   `msg_backlog` is `None`, we do not know whether there is a backlog, so
//!   [`AnomalyKind::BacklogWithNoConsumer`] must not fire — claiming a
//!   problem the data cannot support is how an operator stops trusting the
//!   panel. The same holds for a consumer's `blocked_on_unacked_msgs`, for
//!   a subscription's `consumers` itself being `None` (fix round 2 — see
//!   below), and, via [`BacklogAge::Unknown`], a topic's
//!   `oldest_backlog_message_age`.
//! - **A `None` is not silently read as healthy either.** An empty
//!   [`derive_anomalies`] result must mean "every check ran and found
//!   nothing", never "some checks could not run". Collapsing those two
//!   would hide precisely the situation this module exists to catch: a
//!   broker that has quietly stopped sending the one field an operator
//!   needed.
//!
//! [`derive_anomalies`]'s signature is fixed by the task brief to
//! `Vec<Anomaly>`, and [`AnomalyKind`] is a closed, fixed set of four
//! variants — none of which mean "could not tell". Inventing a fifth
//! "unknown" variant, or smuggling an extra field onto [`Anomaly`], would
//! make every caller that matches on `kind` (Task 8's Overview command,
//! eventually a UI switch/case) reason about a state that is not actually an
//! anomaly. Instead, [`derive_indeterminate_checks`] is a second, separate
//! pure function returning a distinct type, [`IndeterminateCheck`] — "a
//! separate return value" as the brief's central-constraint section
//! suggests. It reuses [`AnomalyKind`] as a discriminant (which check could
//! not be evaluated) without adding a variant that would ever appear inside
//! an actual `Anomaly`. A caller that ignores it loses nothing it had before;
//! a caller that surfaces it (as Task 8's `OverviewReport` eventually might,
//! the same way it surfaces `truncated`) can tell "checked and clear" apart
//! from "could not tell" without that fact ever posing as a found anomaly.
//!
//! One field, `oldest_backlog_message_age`, used to be a plain
//! `Option<i64>` seconds value in which Task 5 normalized Pulsar's `-1`
//! sentinel ("no backlog has ever existed" — a genuine, healthy fact) to
//! the same `None` used for a withheld/absent field. This module could not
//! recover which of the two applies from a bare `None`, so an earlier
//! version of this file treated every `None` here conservatively — never
//! raising [`AnomalyKind::BacklogOlderThanThreshold`], but always recording
//! it via [`derive_indeterminate_checks`] — which flooded the indeterminate
//! list with every quiescent topic (which commonly carries the `-1`
//! sentinel). Fix round 1 corrected this at the source: `broker::stats` now
//! reports [`BacklogAge`], a three-state type that keeps `NoBacklog`
//! (determinate and healthy) distinct from `Unknown` (genuinely absent, or
//! an undocumented negative value). This module now only ever treats
//! `BacklogAge::Unknown` as indeterminate; `NoBacklog` is a clean, positive
//! result — neither an anomaly nor an indeterminate check.
//!
//! Fix round 2 closed the last such path: `SubscriptionStats::consumers` was
//! `Vec<ConsumerStats>` defaulted from a missing key, so "Pulsar never sent
//! `consumers`" and "Pulsar sent `consumers: []`" were indistinguishable —
//! both parsed to an empty `Vec`. `derive_anomalies` read either one as the
//! confirmed fact "nobody is attached" and could raise
//! `BacklogWithNoConsumer` from a field that was never actually observed.
//! `consumers` is now `Option<Vec<ConsumerStats>>`: `Some(vec![])` stays the
//! confirmed, actionable fact it always was; `None` now takes the same path
//! as every other unknown in this module — never an anomaly, always an
//! [`IndeterminateCheck`] (for both `BacklogWithNoConsumer` and
//! `ConsumerBlockedOnUnacked`, since neither check has anything to look at
//! without knowing who, if anyone, is attached).
//!
//! Task 1 fix round 1, item 3 reopened a variant of exactly this bug one
//! level up, from the request side rather than the parse side: Pulsar's
//! `excludeConsumers=true` REST parameter makes the broker send
//! `consumers: []` — measured directly, this is **byte-identical** on the
//! wire to Pulsar's own confirmed "nobody attached" fact. `broker::stats`
//! cannot fix this by adding a fourth state to `consumers` (the JSON gives
//! it nothing to distinguish), so this module reads
//! `TopicStats::stats_request_scope.exclude_consumers` directly and, when
//! it is `true`, treats every subscription's consumer list as if it were
//! `None` for both checks below — regardless of what that list actually
//! contains. An excluded list is not an empty list (spec §12.3); this is
//! the same "we did not ask" vs. "we asked and got nothing" distinction
//! Task 1's `StatsRequestScope` exists to preserve, applied to the one
//! field where collapsing it would fabricate a specific, alarming claim
//! (`BacklogWithNoConsumer`) rather than merely hide a number.
//!
//! ## Wording discipline
//!
//! `msgRateOut` (used nowhere in this file) proves delivery to a consumer,
//! never business completion — no `detail` string may imply a message was
//! processed. Every [`Anomaly`] also carries an `observed_value` that is the
//! actual figure observed (a count, an age in seconds, a boolean flag as
//! reported), never a restatement of the rule that fired.
//!
//! [`AnomalyKind::CapabilityProbeFailed`] is intentionally never produced by
//! this module: its evidence lives in a `CapabilitySnapshot`, which this
//! module never sees (see the module's own signature — it takes `TopicStats`
//! only). Task 8's `broker_get_overview` command emits that variant, since
//! it holds the connection.
//!
//! ## Whole-stage review item 2: `earliest_time_in_backlog` must be folded too
//!
//! `exclude_consumers` is folded into `None` for the two consumer checks
//! above, but `oldest_backlog_message_age` used to be read straight off
//! `TopicStats` in both [`derive_anomalies`] and
//! [`derive_indeterminate_checks`], with no equivalent check of
//! `stats_request_scope.earliest_time_in_backlog`. Under the scope this
//! codebase actually ships (`earliest_time_in_backlog: false`), Pulsar
//! returns `oldestBacklogMessageAgeSeconds: -1`, which normalizes to
//! [`BacklogAge::NoBacklog`] — "a determinate, healthy fact" per that type's
//! own doc. That made [`AnomalyKind::BacklogOlderThanThreshold`]
//! structurally unreachable in the shipped configuration, and — because
//! [`derive_indeterminate_checks`] deliberately never lists `NoBacklog` as
//! indeterminate (it is a genuine, healthy reading when actually measured) —
//! the check did not surface as indeterminate either. An empty result then
//! read as "every check ran and found nothing" when this one check never
//! ran at all, exactly the failure mode this module's own central rule
//! forbids.
//!
//! [`effective_backlog_age`] fixes this the same way [`derive_anomalies`]
//! already folds `exclude_consumers`: when `earliest_time_in_backlog` is
//! `false`, the parsed `BacklogAge` — whatever it came out as — is not
//! trusted as measured and is treated as [`BacklogAge::Unknown`] for both
//! functions, so the check raises nothing **and** appears on the
//! indeterminate list instead of vanishing silently.

use crate::broker::stats::{BacklogAge, TopicStats};
use serde::{Deserialize, Serialize};

/// The closed set of problems this module (and, for
/// [`AnomalyKind::CapabilityProbeFailed`], Task 8) can report about a topic.
/// `rename_all = "camelCase"` mirrors `AnomalyKind` in
/// `packages/broker-contracts/src/anomaly.ts` field-for-field — the wire
/// value for `BacklogWithNoConsumer` is the string `"backlogWithNoConsumer"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnomalyKind {
    BacklogWithNoConsumer,
    ConsumerBlockedOnUnacked,
    BacklogOlderThanThreshold,
    /// Never constructed by [`derive_anomalies`] — see the module doc. Kept
    /// here because it is part of the one shared, closed set of anomaly
    /// kinds Task 8 also reports through.
    CapabilityProbeFailed,
}

/// One concrete, evidenced problem found on a topic (or, for a
/// topic-scoped check such as [`AnomalyKind::BacklogOlderThanThreshold`], on
/// the topic as a whole — `subscription` is `None` in that case).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anomaly {
    pub kind: AnomalyKind,
    pub topic: String,
    pub subscription: Option<String>,
    pub detail: String,
    pub observed_value: String,
}

/// One check that could not be evaluated because the input it depends on
/// was `None` — see the module doc's "central rule". Never a claim that
/// something is wrong; a claim that we could not tell. `kind` names which of
/// [`AnomalyKind`]'s (non-`CapabilityProbeFailed`) checks was blocked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndeterminateCheck {
    pub kind: AnomalyKind,
    pub topic: String,
    pub subscription: Option<String>,
    pub reason: String,
}

/// `stats.oldest_backlog_message_age`, folded through
/// `stats_request_scope.earliest_time_in_backlog` exactly as
/// `effective_consumers` (inline in [`derive_anomalies`] and
/// [`derive_indeterminate_checks`]) folds `exclude_consumers` for the
/// consumer checks beside it — see the module doc's "whole-stage review item
/// 2" section. When the flag is `false`, the parsed value must not be
/// trusted as measured, whatever it normalized to (a real `Seconds` age, or
/// Pulsar's own `NoBacklog` sentinel), so this returns [`BacklogAge::Unknown`]
/// instead.
fn effective_backlog_age(stats: &TopicStats) -> BacklogAge {
    if stats.stats_request_scope.earliest_time_in_backlog {
        stats.oldest_backlog_message_age
    } else {
        BacklogAge::Unknown
    }
}

/// Derives every anomaly [Task 5's `TopicStats`] gives this module enough
/// evidence to report. Never raises an anomaly from a `None` input (see the
/// module doc); use [`derive_indeterminate_checks`] alongside this to learn
/// which checks could not run at all.
pub fn derive_anomalies(topic: &str, stats: &TopicStats, oldest_backlog_threshold_secs: i64) -> Vec<Anomaly> {
    let mut anomalies = Vec::new();

    for sub in &stats.subscriptions {
        // `None` means Pulsar never sent `consumers` at all — we do not know
        // who, if anyone, is attached, so this check cannot run (it shows up
        // via `derive_indeterminate_checks` instead). `Some(&[])` is
        // Pulsar's own confirmed fact "nobody is attached" — UNLESS this
        // call excluded consumers from the request (`excludeConsumers=true`,
        // fix round 1, item 3), in which case Pulsar sends the identical
        // `[]` for a reason that carries no information at all. `effective_consumers`
        // folds that case into `None` so every check below already knows
        // how to handle it — see the module doc's fix-round-1 note.
        let effective_consumers =
            if stats.stats_request_scope.exclude_consumers { None } else { sub.consumers.as_ref() };
        if let Some(consumers) = effective_consumers {
            if consumers.is_empty() {
                if let Some(backlog) = sub.msg_backlog {
                    if backlog > 0 {
                        anomalies.push(Anomaly {
                            kind: AnomalyKind::BacklogWithNoConsumer,
                            topic: topic.to_string(),
                            subscription: Some(sub.name.clone()),
                            detail: format!(
                                "Subscription \"{}\" has a backlog and no consumer is attached to receive it.",
                                sub.name
                            ),
                            observed_value: format!("{backlog} messages backlogged, 0 consumers attached"),
                        });
                    }
                }
            }

            for consumer in consumers {
                if consumer.blocked_on_unacked_msgs == Some(true) {
                    let observed_value = match consumer.unacked_messages {
                        Some(n) => format!("{n} unacked messages (blockedOnUnackedMsgs=true)"),
                        None => "blockedOnUnackedMsgs=true (unacked count unknown)".to_string(),
                    };
                    let consumer_label = consumer.consumer_name.as_deref().unwrap_or("(unnamed consumer)");
                    anomalies.push(Anomaly {
                        kind: AnomalyKind::ConsumerBlockedOnUnacked,
                        topic: topic.to_string(),
                        subscription: Some(sub.name.clone()),
                        detail: format!(
                            "Consumer \"{consumer_label}\" on subscription \"{}\" is blocked on \
                             unacknowledged messages; the broker has stopped delivering to it.",
                            sub.name
                        ),
                        observed_value,
                    });
                }
            }
        }
    }

    // NoBacklog is a determinate, healthy fact (Pulsar's documented `-1`
    // sentinel) — it must raise nothing here, exactly like a known-young
    // age. Only a known age at or past the threshold is an anomaly; Unknown
    // never raises one (see `derive_indeterminate_checks` for that case).
    // `effective_backlog_age` folds this to Unknown outright when
    // `earliest_time_in_backlog` was not requested (whole-stage review item
    // 2), so a NoBacklog/Seconds reading this call never actually asked for
    // cannot raise (or silently clear) this check either.
    //
    // The comparison is done entirely in `u64` space rather than casting
    // `age` down to `i64`: a `u64` age near its top end would silently wrap
    // negative under `as i64`, and — the defect that actually matters here —
    // a misconfigured *negative* threshold would make `age as i64 >=
    // negative` true for every known age, drowning the panel in false
    // positives. Widening the threshold up with `try_from` instead means a
    // negative threshold simply fails to convert and matches nothing.
    if let BacklogAge::Seconds { seconds: age } = effective_backlog_age(stats) {
        if u64::try_from(oldest_backlog_threshold_secs).is_ok_and(|threshold| age >= threshold) {
            anomalies.push(Anomaly {
                kind: AnomalyKind::BacklogOlderThanThreshold,
                topic: topic.to_string(),
                subscription: None,
                detail: format!(
                    "Topic \"{topic}\" has a backlog message older than the {oldest_backlog_threshold_secs}s threshold."
                ),
                observed_value: format!(
                    "oldest backlog message is {age}s old (threshold {oldest_backlog_threshold_secs}s)"
                ),
            });
        }
    }

    anomalies
}

/// Reports every check [`derive_anomalies`] skipped for this topic because
/// its required input was `None` — never a duplicate of an anomaly, always
/// a distinct "could not tell" signal. See the module doc for why this is a
/// separate function rather than a new [`AnomalyKind`] variant or an extra
/// field on [`Anomaly`].
pub fn derive_indeterminate_checks(topic: &str, stats: &TopicStats) -> Vec<IndeterminateCheck> {
    let mut indeterminate = Vec::new();

    for sub in &stats.subscriptions {
        // See `derive_anomalies` above: an excluded consumer list
        // (`exclude_consumers`, fix round 1 item 3) is folded into `None`
        // here too, so both branches below treat "excluded" exactly like
        // "withheld" — never like the confirmed-empty fact `Some(&[])`
        // means when this call actually asked.
        let effective_consumers =
            if stats.stats_request_scope.exclude_consumers { None } else { sub.consumers.as_ref() };
        match effective_consumers {
            // Pulsar never sent `consumers` at all (or this call excluded
            // them): neither check that depends on it can run. This is one
            // indeterminate entry per check, not one per consumer — there is
            // no consumer to name, because whether any exist is itself the
            // unknown.
            None => {
                indeterminate.push(IndeterminateCheck {
                    kind: AnomalyKind::BacklogWithNoConsumer,
                    topic: topic.to_string(),
                    subscription: Some(sub.name.clone()),
                    reason: format!(
                        "subscription \"{}\" did not report its consumers at all, so whether it \
                         has an unattended backlog could not be determined",
                        sub.name
                    ),
                });
                indeterminate.push(IndeterminateCheck {
                    kind: AnomalyKind::ConsumerBlockedOnUnacked,
                    topic: topic.to_string(),
                    subscription: Some(sub.name.clone()),
                    reason: format!(
                        "subscription \"{}\" did not report its consumers at all, so whether any \
                         attached consumer is blocked on unacked messages could not be determined",
                        sub.name
                    ),
                });
            }
            Some(consumers) => {
                // An explicit, possibly-empty list is a fact, not an
                // unknown (Pulsar told us exactly who is attached) — but
                // whether an idle, unattended subscription has a backlog
                // waiting is still only knowable if msg_backlog was
                // actually reported.
                if consumers.is_empty() && sub.msg_backlog.is_none() {
                    indeterminate.push(IndeterminateCheck {
                        kind: AnomalyKind::BacklogWithNoConsumer,
                        topic: topic.to_string(),
                        subscription: Some(sub.name.clone()),
                        reason: format!(
                            "subscription \"{}\" has no attached consumer and msg_backlog was not \
                             reported, so whether it has an unattended backlog could not be \
                             determined",
                            sub.name
                        ),
                    });
                }

                for consumer in consumers {
                    if consumer.blocked_on_unacked_msgs.is_none() {
                        let consumer_label =
                            consumer.consumer_name.as_deref().unwrap_or("(unnamed consumer)");
                        indeterminate.push(IndeterminateCheck {
                            kind: AnomalyKind::ConsumerBlockedOnUnacked,
                            topic: topic.to_string(),
                            subscription: Some(sub.name.clone()),
                            reason: format!(
                                "consumer \"{consumer_label}\" on subscription \"{}\" did not \
                                 report blockedOnUnackedMsgs, so whether it is stalled could not \
                                 be determined",
                                sub.name
                            ),
                        });
                    }
                }
            }
        }
    }

    // BacklogAge::NoBacklog is deliberately excluded: it is Pulsar's own
    // determinate "no backlog has ever existed" fact, not an unknown, so it
    // must never appear on this list (fix round 1 — see the module doc).
    // `effective_backlog_age` folds a genuinely-measured NoBacklog/Seconds
    // reading to Unknown when `earliest_time_in_backlog` was not requested
    // (whole-stage review item 2), so that case DOES appear here — it must:
    // the check never actually ran, and silence must not read as "clear".
    if matches!(effective_backlog_age(stats), BacklogAge::Unknown) {
        indeterminate.push(IndeterminateCheck {
            kind: AnomalyKind::BacklogOlderThanThreshold,
            topic: topic.to_string(),
            subscription: None,
            reason: format!(
                "topic \"{topic}\" did not report oldestBacklogMessageAgeSeconds (or reported an \
                 undocumented negative value), so whether it has an old backlog could not be \
                 determined"
            ),
        });
    }

    indeterminate
}

#[cfg(test)]
#[path = "anomaly_tests.rs"]
mod tests;
