//! Parses Pulsar's topic `internalStats` payload — where each
//! subscription's cursor actually sits in the ledger, as opposed to `stats`
//! (throughput and backlog counts). This is what separates "consuming
//! slowly" from "not consuming at all": a subscription can report a
//! reasonable backlog in `stats` while its cursor in `internalStats` has
//! not moved in days.
//!
//! Read-only: this module never touches the cache, the store, or the
//! database. It only turns a `serde_json::Value` into typed structs.
//!
//! Split out from `broker::stats` deliberately (not added to it): this is a
//! different payload from a different endpoint, and `stats.rs` was just
//! split three ways to get under the 400-line module cap — growing it back
//! would undo that.
//!
//! ## Positions are structured, not passed-through strings
//!
//! Pulsar encodes a cursor or ledger position as `"ledgerId:entryId"`
//! (e.g. `"251:-1"`). Keeping that as an opaque `String` would hand every
//! caller a wire format to re-parse and force each one to separately learn
//! that `-1` is Pulsar's "nothing here yet" sentinel — an in-band value
//! embedded *inside* a string, where wrapping the whole field in `Option`
//! cannot help. [`Position`] parses both components into `i64` once, here,
//! at the one place that knows the wire convention.
//!
//! ## `entry_id: -1` is kept, not normalized away
//!
//! `stats.rs` normalizes several Pulsar sentinels (`-1` backlog age,
//! `"None"` sub type, `0` timestamps) to `None` because in those cases the
//! sentinel value looks like a real answer but isn't one — passing it
//! through would misinform an operator.
//!
//! `entry_id: -1` is different: on the live `fpms_topup` topic, a cursor at
//! `251:-1` means "this subscription has acknowledged nothing in ledger
//! 251" — a real, actionable fact (this is *exactly* the "not consuming at
//! all" signal this module exists to expose), not an absence of data. There
//! is nothing to strip: `-1` is not standing in for "we don't know," it is
//! the answer. Normalizing it to `None` would delete the one detail that
//! makes `internalStats` useful. So `Position.entry_id` is a plain `i64`
//! and `-1` is preserved verbatim, both for cursor positions and for the
//! topic-level `lastConfirmedEntry`.
//!
//! What *is* still an error: a position string that does not match
//! `ledgerId:entryId` at all (missing colon, non-integer component). That
//! is not a sentinel, it is a payload we cannot read, and is reported as
//! [`BrokerErrorCode::MalformedResponse`] rather than coerced to a zeroed
//! position.
//!
//! ## Sentinel sweep of the other mapped fields
//!
//! `entriesAddedCounter`, `numberOfEntries`, and each cursor's
//! `messagesConsumedCounter` are plain non-negative counters, observed as
//! `0` on the live topic (which currently has no traffic). Counters were
//! swept for the same negative-sentinel convention `stats.rs` checked for
//! its own counters and none is documented for these either — a real `0`
//! here is a real zero, so they are `Option<u64>` only to tolerate a future
//! Pulsar version dropping or renaming the key, not to hide a magic value.
//! No `"None"`-style string sentinel or 0-epoch timestamp sentinel exists
//! among the fields this module maps (no subscription-type or timestamp
//! field is mapped here at all).
//!
//! ## Unknown fields never fail the parse
//!
//! The real payload carries 15 top-level keys; this module maps 4
//! (`entriesAddedCounter`, `numberOfEntries`, `lastConfirmedEntry`,
//! `cursors`). There is deliberately no `#[serde(deny_unknown_fields)]`
//! anywhere below, at the top level or inside each cursor object.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use serde::{Deserialize, Deserializer};
use std::collections::BTreeMap;

/// A parsed Pulsar `"ledgerId:entryId"` position. See the module doc for why
/// `entry_id: -1` is preserved rather than normalized to `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub ledger_id: i64,
    pub entry_id: i64,
}

impl Position {
    fn parse(raw: &str) -> Result<Self, String> {
        let (ledger, entry) = raw
            .split_once(':')
            .ok_or_else(|| format!("expected `ledgerId:entryId`, got `{raw}`"))?;
        let ledger_id = ledger
            .parse::<i64>()
            .map_err(|_| format!("non-integer ledgerId in `{raw}`"))?;
        let entry_id = entry
            .parse::<i64>()
            .map_err(|_| format!("non-integer entryId in `{raw}`"))?;
        Ok(Position { ledger_id, entry_id })
    }
}

impl<'de> Deserialize<'de> for Position {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Position::parse(&raw).map_err(serde::de::Error::custom)
    }
}

/// The parsed subset of a Pulsar topic's `internalStats` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct InternalStats {
    pub entries_added_counter: Option<u64>,
    pub number_of_entries: Option<u64>,
    pub last_confirmed_entry: Option<Position>,
    pub cursors: Vec<CursorPosition>,
}

/// The parsed subset of one entry in the `cursors` map of an
/// `internalStats` payload. `subscription` is not a field of the wire
/// object itself — it is the map key the object was found under.
#[derive(Debug, Clone, PartialEq)]
pub struct CursorPosition {
    pub subscription: String,
    pub mark_delete_position: Position,
    pub read_position: Position,
    pub messages_consumed_counter: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInternalStats {
    #[serde(default)]
    entries_added_counter: Option<u64>,
    #[serde(default)]
    number_of_entries: Option<u64>,
    #[serde(default)]
    last_confirmed_entry: Option<Position>,
    #[serde(default)]
    cursors: BTreeMap<String, RawCursor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCursor {
    mark_delete_position: Position,
    read_position: Position,
    #[serde(default)]
    messages_consumed_counter: Option<u64>,
}

/// Parses the subset of a Pulsar topic `internalStats` response this module
/// maps. A field missing entirely is not an error (see the module doc). A
/// field present but the wrong JSON type — including a position string that
/// does not match `ledgerId:entryId` — is a
/// [`BrokerErrorCode::MalformedResponse`], with the JSON path of the
/// offending field named via `serde_path_to_error`, exactly as
/// `parse_topic_stats` does for `stats`.
pub fn parse_internal_stats(raw: &serde_json::Value) -> Result<InternalStats, BrokerError> {
    let parsed: RawInternalStats = serde_path_to_error::deserialize(raw).map_err(|e| BrokerError {
        code: BrokerErrorCode::MalformedResponse,
        message: format!("failed to parse internal stats at `{}`: {}", e.path(), e.inner()),
        retryable: false,
    })?;

    let mut cursors: Vec<CursorPosition> = parsed
        .cursors
        .into_iter()
        .map(|(subscription, cursor)| CursorPosition {
            subscription,
            mark_delete_position: cursor.mark_delete_position,
            read_position: cursor.read_position,
            messages_consumed_counter: cursor.messages_consumed_counter,
        })
        .collect();
    // BTreeMap iterates in key order already, so this is sorted by
    // construction — but CursorPosition identity does not depend on that
    // being a BTreeMap implementation detail, so sort explicitly.
    cursors.sort_by(|a, b| a.subscription.cmp(&b.subscription));

    Ok(InternalStats {
        entries_added_counter: parsed.entries_added_counter,
        number_of_entries: parsed.number_of_entries,
        last_confirmed_entry: parsed.last_confirmed_entry,
        cursors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_fixture() -> serde_json::Value {
        let raw = include_str!("../../tests/fixtures/broker/topic-internal-stats.json");
        serde_json::from_str(raw).expect("fixture is valid JSON")
    }

    #[test]
    fn parses_real_internal_stats_with_both_cursors() {
        let internal = parse_internal_stats(&real_fixture()).expect("parses");
        let subs: Vec<_> = internal.cursors.iter().map(|c| c.subscription.as_str()).collect();
        assert!(subs.contains(&"rg_deposit_accumulate_LOCAL"), "got {subs:?}");
        assert!(subs.contains(&"anti_addiction_deposit_limit_fpmsnt"), "got {subs:?}");
    }

    #[test]
    fn cursors_are_sorted_by_subscription_name() {
        let internal = parse_internal_stats(&real_fixture()).expect("parses");
        let subs: Vec<_> = internal.cursors.iter().map(|c| c.subscription.clone()).collect();
        let mut sorted = subs.clone();
        sorted.sort();
        assert_eq!(subs, sorted);
    }

    #[test]
    fn cursor_positions_are_parsed_into_structured_ledger_and_entry_ids() {
        // The live fixture carries "251:-1" / "251:0" — a passed-through
        // String would leave the -1 sentinel embedded and unreadable by
        // callers without re-parsing.
        let internal = parse_internal_stats(&real_fixture()).expect("parses");
        let cursor = internal
            .cursors
            .iter()
            .find(|c| c.subscription == "rg_deposit_accumulate_LOCAL")
            .expect("cursor present");
        assert_eq!(cursor.mark_delete_position.ledger_id, 251);
        assert_eq!(cursor.mark_delete_position.entry_id, -1);
        assert_eq!(cursor.read_position.ledger_id, 251);
        assert_eq!(cursor.read_position.entry_id, 0);
    }

    #[test]
    fn entry_id_negative_one_is_preserved_not_normalized_away() {
        // This is the deliberate divergence from stats.rs's sentinel
        // normalization: -1 here is a real fact ("acknowledged nothing in
        // this ledger"), not a stand-in for missing data, so it must survive
        // parsing unchanged rather than becoming None or 0.
        let internal = parse_internal_stats(&real_fixture()).expect("parses");
        assert_eq!(
            internal.last_confirmed_entry,
            Some(Position { ledger_id: 251, entry_id: -1 })
        );
    }

    #[test]
    fn internal_stats_tolerate_an_unknown_top_level_field() {
        let mut raw = real_fixture();
        raw["futureField"] = serde_json::json!(true);
        assert!(parse_internal_stats(&raw).is_ok());
    }

    #[test]
    fn internal_stats_tolerate_an_unknown_nested_cursor_field() {
        // Proves tolerance at the nested cursor level too, not only the top.
        let mut raw = real_fixture();
        raw["cursors"]["rg_deposit_accumulate_LOCAL"]["futureCursorField"] =
            serde_json::json!({"nested": [1, 2, 3]});
        assert!(parse_internal_stats(&raw).is_ok());
    }

    #[test]
    fn a_malformed_position_string_is_an_error_not_a_silent_zero() {
        let mut raw = real_fixture();
        raw["cursors"]["rg_deposit_accumulate_LOCAL"]["markDeletePosition"] =
            serde_json::json!("not-a-position");
        let err = parse_internal_stats(&raw).expect_err("must not coerce to a default position");
        assert_eq!(err.code, BrokerErrorCode::MalformedResponse);
        assert!(
            err.message.contains("cursors.rg_deposit_accumulate_LOCAL.markDeletePosition"),
            "message did not name the offending path: {}",
            err.message
        );
    }

    /// The no-colon case is covered above. This is the sneakier half: the
    /// string has the right *shape*, so a parser that splits first and
    /// converts carelessly can still end up with one real component and one
    /// invented zero. A cursor reported at `5:0` reads as "at the start of
    /// ledger 5", which is a specific operational claim, and a wrong one.
    #[test]
    fn a_position_with_one_bad_component_is_an_error_not_a_half_invented_one() {
        for bad in ["5:abc", "abc:5"] {
            let mut raw = real_fixture();
            raw["cursors"]["rg_deposit_accumulate_LOCAL"]["readPosition"] =
                serde_json::json!(bad);
            let err = parse_internal_stats(&raw)
                .expect_err("a half-parsable position must not yield a half-invented one");
            assert_eq!(err.code, BrokerErrorCode::MalformedResponse, "for {bad}");
            assert!(
                err.message.contains("cursors.rg_deposit_accumulate_LOCAL.readPosition"),
                "message did not name the offending path for {bad}: {}",
                err.message
            );
        }
    }

    #[test]
    fn a_missing_optional_counter_yields_none_not_zero() {
        let mut raw = real_fixture();
        raw.as_object_mut().unwrap().remove("entriesAddedCounter");
        let internal = parse_internal_stats(&raw).expect("still parses");
        assert_eq!(internal.entries_added_counter, None);
    }

    #[test]
    fn a_wrong_typed_counter_is_an_error_not_a_silent_zero() {
        let mut raw = real_fixture();
        raw["numberOfEntries"] = serde_json::json!("not a number");
        let err = parse_internal_stats(&raw).expect_err("must not coerce to zero");
        assert_eq!(err.code, BrokerErrorCode::MalformedResponse);
        assert!(
            err.message.contains("numberOfEntries"),
            "message did not name the offending path: {}",
            err.message
        );
    }
}
