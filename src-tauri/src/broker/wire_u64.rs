//! Serializes `Option<u64>` as a decimal *string* on the wire instead of a
//! bare JSON number.
//!
//! Five fields cross the Tauri IPC boundary as `u64` counters that can
//! legitimately reach into the tens of quintillions on a long-lived,
//! high-traffic topic (`msg_in_counter`, `storage_size`, `backlog_size` in
//! `broker::stats`; `entries_added_counter`, `messages_consumed_counter` in
//! `broker::internal_stats`). JavaScript's `Number` is an IEEE-754 double:
//! integers above 2^53 - 1 (9,007,199,254,740,991) round silently on
//! `JSON.parse` in the webview. `serde_json` itself round-trips a `u64`
//! exactly (Rust's `u64 <-> u64` deserialize/serialize never touches a
//! float), so a Rust-only round-trip test cannot see this failure — it is
//! purely a JavaScript-side defect, which is why the fix is to never hand
//! JavaScript a bare number for these fields at all. Spec §14.1 asks for
//! exactly this: 64-bit counters as decimal strings, parsed as a raw integer
//! on the trusted (Rust) side, never round-tripped through a JS `Number`.
//!
//! `None` still serialises as JSON `null` (via `serialize_none`), not as the
//! string `"null"` or any digit string — absence must stay distinguishable
//! from a value on the wire exactly as it already is in Rust.
//!
//! Used via `#[serde(serialize_with = "crate::broker::wire_u64::serialize")]`
//! on each of the five fields above. Deserialization is untouched (and not
//! provided here): every field this module serializes is only ever
//! constructed in-process by `parse_topic_stats`/`parse_internal_stats`,
//! which read the *raw* Pulsar JSON number straight into a plain `u64` —
//! nothing on the Rust side ever deserializes one of these wire strings back.
//!
//! Mirrored in TypeScript as `string | null` (never `number | null`) on the
//! corresponding fields in `packages/broker-contracts/src/topic-detail.ts`;
//! `src/components/broker/broker-value.ts`'s `formatBigCounter` renders the
//! string with digit-grouping, never via `Number(...)` or `parseInt`.

use serde::Serializer;

/// Serializes `Some(n)` as the quoted decimal string `"n"`; `None` as JSON
/// `null`. See the module doc for why this exists and what it must never do.
pub(super) fn serialize<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(v) => serializer.serialize_some(&v.to_string()),
        None => serializer.serialize_none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Serialize)]
    struct Wrapper {
        #[serde(serialize_with = "serialize")]
        value: Option<u64>,
    }

    #[test]
    fn some_serialises_as_a_quoted_decimal_string() {
        let json = serde_json::to_string(&Wrapper { value: Some(u64::MAX) }).unwrap();
        assert_eq!(json, r#"{"value":"18446744073709551615"}"#);
    }

    #[test]
    fn none_serialises_as_null_not_a_string() {
        let json = serde_json::to_string(&Wrapper { value: None }).unwrap();
        assert_eq!(json, r#"{"value":null}"#);
    }

    #[test]
    fn zero_serialises_as_the_string_zero_not_a_bare_number() {
        // A real, measured zero must still be a string — the point of this
        // module is "never a bare JSON number for this field", not "only
        // large numbers get quoted".
        let json = serde_json::to_string(&Wrapper { value: Some(0) }).unwrap();
        assert_eq!(json, r#"{"value":"0"}"#);
    }
}
