//! Rust mirror of `packages/broker-core/src/topic-folding.ts` and
//! `pagination.ts` (Task 9). Three deliberate departures from a literal
//! transliteration, each called out where JS and Rust semantics differ:
//!
//! 1. `pagination.ts`'s sort comparator relies on JS's implicit coercion
//!    rule for `<` between two `string | number` values. Rust has no such
//!    coercion, so [`SortValue`] carries an explicit variant per type and
//!    [`compare_sort_values`] matches on it rather than comparing blindly.
//! 2. `topic-folding.ts`'s final sort uses `localeCompare` — locale-aware
//!    collation, not byte order. Rust's default `Ord` on `String` IS byte
//!    order. This port picks byte order deliberately (Rust's idiom, and
//!    deterministic without locale data); `packages/broker-contracts` and
//!    the TypeScript side must agree this is "the" order.
//! 3. Both TS files depend on `Array.prototype.sort`'s ES2019+ stability
//!    guarantee (equal-key items keep their relative order). This port uses
//!    `sort_by` / `sort_by_key` throughout — never `sort_unstable_by` — to
//!    preserve that guarantee.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageQueryDto {
    pub offset: usize,
    pub limit: usize,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub sort_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicSummaryDto {
    pub full_name: String,
    pub short_name: String,
    pub tenant: String,
    pub namespace: String,
    pub persistent: bool,
    pub partitions: usize,
    pub partition_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDto<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

/// Mirrors the JS regex `/-partition-(\d+)$/` without a `regex` dependency
/// for one pattern: split on the LAST `-partition-` and require everything
/// after it to be one or more ASCII digits. Because the match must reach the
/// end of the string either way, this converges on the same substring the
/// anchored regex would (see the worked cases in the Rust test module).
fn partition_suffix(name: &str) -> Option<(&str, u64)> {
    let (parent, digits) = name.rsplit_once("-partition-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().map(|index| (parent, index))
}

/// `persistent://tenant/namespace/short/parts` -> (tenant, namespace, short, persistent).
/// `shortParts.join("/")` in the TS is mirrored by leaving the remainder
/// un-split beyond the first two `/` separators.
fn parse_topic_name(full_name: &str) -> (String, String, String, bool) {
    let (scheme, rest) = full_name.split_once("://").unwrap_or((full_name, ""));
    let mut parts = rest.splitn(3, '/');
    let tenant = parts.next().unwrap_or("").to_string();
    let namespace = parts.next().unwrap_or("").to_string();
    let short_name = parts.next().unwrap_or("").to_string();
    (tenant, namespace, short_name, scheme == "persistent")
}

fn to_summary(full_name: &str, partitions: usize, partition_names: Vec<String>) -> TopicSummaryDto {
    let (tenant, namespace, short_name, persistent) = parse_topic_name(full_name);
    TopicSummaryDto {
        full_name: full_name.to_string(),
        short_name,
        tenant,
        namespace,
        persistent,
        partitions,
        partition_names,
    }
}

/// Admin REST's topic list returns expanded partitions
/// (`events-partition-0..2`) while only `/partitioned` knows the logical
/// topic (`events`). Rendering the raw list shows one topic as N rows. This
/// folds them.
///
/// Membership is decided by the `partitioned_topics` list, NEVER by the name
/// pattern alone — a topic legitimately named `my-partition-plan` (or one
/// whose `-partition-N`-shaped parent was never actually registered as
/// partitioned) must survive intact. This is the single most important
/// behaviour in this file; see `a_topic_matching_the_partition_pattern_whose_parent_is_not_partitioned_is_not_folded`.
pub fn fold_topics(all_topics: &[String], partitioned_topics: &[String]) -> Vec<TopicSummaryDto> {
    use std::collections::{HashMap, HashSet};

    let parents: HashSet<&str> = partitioned_topics.iter().map(String::as_str).collect();
    let mut by_parent: HashMap<&str, Vec<String>> = HashMap::new();
    let mut standalone: Vec<String> = Vec::new();

    for name in all_topics {
        let candidate_parent = partition_suffix(name).map(|(parent, _)| parent);
        match candidate_parent {
            Some(parent) if parents.contains(parent) => {
                by_parent.entry(parent).or_default().push(name.clone());
            }
            _ => standalone.push(name.clone()),
        }
    }

    let mut folded: Vec<TopicSummaryDto> =
        standalone.into_iter().map(|name| to_summary(&name, 0, Vec::new())).collect();

    for &parent in &parents {
        let mut partition_names = by_parent.remove(parent).unwrap_or_default();
        // Numeric order by partition index; `sort_by_key` is stable (see
        // module doc point 3) though no two entries share an index here.
        partition_names.sort_by_key(|n| partition_suffix(n).map(|(_, i)| i).unwrap_or(0));
        // A `/partitioned` entry with no matching expanded partitions in
        // `all_topics` still gets a row here, with partitions: 0 — this
        // surfaces the mismatch instead of silently dropping the logical
        // topic (matches the TS behaviour deliberately, see topic-folding.ts).
        folded.push(to_summary(parent, partition_names.len(), partition_names));
    }

    folded.sort_by(|a, b| a.full_name.cmp(&b.full_name));
    folded
}

/// One sorting key's value, kept as an explicit variant per field rather
/// than comparing `String`/`usize` interchangeably — see module doc point 1.
enum SortValue<'a> {
    Str(&'a str),
    Num(f64),
}

fn sort_value<'a>(item: &'a TopicSummaryDto, key: &str) -> SortValue<'a> {
    match key {
        "shortName" => SortValue::Str(&item.short_name),
        "tenant" => SortValue::Str(&item.tenant),
        "namespace" => SortValue::Str(&item.namespace),
        "partitions" => SortValue::Num(item.partitions as f64),
        // "fullName" and anything unrecognized: fullName is the one field
        // guaranteed unique and always present, so it is the sane default.
        _ => SortValue::Str(&item.full_name),
    }
}

fn compare_sort_values(a: &SortValue, b: &SortValue) -> std::cmp::Ordering {
    match (a, b) {
        (SortValue::Str(x), SortValue::Str(y)) => x.cmp(y),
        (SortValue::Num(x), SortValue::Num(y)) => x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal),
        // `sort_value` always returns one variant per key, so the variants
        // never actually mismatch in practice; no JS-style coercion here.
        _ => std::cmp::Ordering::Equal,
    }
}

/// Pagination lives here because Pulsar's Admin REST ignores `page`/`size`
/// entirely and always returns the full array (spec V-A5). Filter, then
/// sort, then slice — `total` describes the filtered set, matching
/// `pagination.ts`, so the UI's page count is never computed from the wrong
/// denominator.
pub fn paginate(items: Vec<TopicSummaryDto>, query: &PageQueryDto) -> PageDto<TopicSummaryDto> {
    let mut working = items;

    if let Some(search) = query.search.as_deref() {
        let needle = search.trim().to_lowercase();
        if !needle.is_empty() {
            working.retain(|t| t.full_name.to_lowercase().contains(&needle));
        }
    }

    if let Some(sort_by) = query.sort_by.as_deref() {
        let desc = query.sort_dir.as_deref() == Some("desc");
        // `sort_by` (stable), never `sort_unstable_by` — module doc point 3.
        working.sort_by(|a, b| {
            let ord = compare_sort_values(&sort_value(a, sort_by), &sort_value(b, sort_by));
            if desc { ord.reverse() } else { ord }
        });
    }

    let total = working.len();
    let offset = query.offset;
    // A zero limit is clamped up to 1 rather than rejected, matching
    // pagination.ts: this is a read-only list endpoint, so a malformed
    // query degrades to "the smallest sensible page" instead of failing.
    // (A negative limit can't reach here at all: `limit` is `usize`, so the
    // IPC boundary itself rejects a negative JSON number during
    // deserialization rather than silently clamping it — stricter than the
    // TS side, but no different in effect for any input the UI ever sends.)
    let limit = query.limit.max(1);
    let items = working.into_iter().skip(offset).take(limit).collect();

    PageDto { items, total, offset, limit }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topics(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_partitioned_topic_folds_into_one_row_not_n() {
        let listed = topics(&[
            "persistent://public/default/orders",
            "persistent://public/default/events-partition-0",
            "persistent://public/default/events-partition-1",
            "persistent://public/default/events-partition-2",
        ]);
        let partitioned = topics(&["persistent://public/default/events"]);
        let folded = fold_topics(&listed, &partitioned);
        assert_eq!(folded.len(), 2, "4 listed entries collapse to 2 logical topics");

        let events = folded.iter().find(|t| t.short_name == "events").unwrap();
        assert_eq!(events.partitions, 3);
        assert_eq!(
            events.partition_names,
            vec![
                "persistent://public/default/events-partition-0",
                "persistent://public/default/events-partition-1",
                "persistent://public/default/events-partition-2",
            ]
        );

        let orders = folded.iter().find(|t| t.short_name == "orders").unwrap();
        assert_eq!(orders.partitions, 0);
        assert!(orders.partition_names.is_empty());
        assert_eq!(orders.tenant, "public");
        assert_eq!(orders.namespace, "default");
        assert!(orders.persistent);
    }

    #[test]
    fn a_topic_merely_containing_partition_dash_is_not_mistaken_for_one() {
        // A real topic can legitimately be called "my-partition-plan". It
        // must not be folded into a phantom parent.
        let listed = topics(&["persistent://public/default/my-partition-plan"]);
        let folded = fold_topics(&listed, &[]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].short_name, "my-partition-plan");
        assert_eq!(folded[0].partitions, 0);
    }

    #[test]
    fn non_persistent_topics_are_flagged() {
        let folded = fold_topics(&topics(&["non-persistent://public/default/tmp"]), &[]);
        assert!(!folded[0].persistent);
    }

    /// THE test: membership is decided by the `/partitioned` list, never by
    /// the name pattern. The name here DOES match `-partition-N`, but its
    /// parent ("events") is absent from `partitioned_topics`. An
    /// implementation that folded on the name pattern alone (ignoring the
    /// partitioned list) would incorrectly collapse this into a phantom
    /// "events" row. It must instead survive standalone, full name intact.
    #[test]
    fn a_topic_matching_the_partition_pattern_whose_parent_is_not_partitioned_is_not_folded() {
        let listed = topics(&["persistent://public/default/events-partition-0"]);
        let folded = fold_topics(&listed, &[]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].full_name, "persistent://public/default/events-partition-0");
        assert_eq!(folded[0].short_name, "events-partition-0");
        assert_eq!(folded[0].partitions, 0);
        assert!(folded[0].partition_names.is_empty());
        assert!(folded.iter().all(|t| t.short_name != "events"), "no phantom parent row");
    }

    #[test]
    fn a_partitioned_entry_with_no_matching_expanded_partitions_still_gets_a_row() {
        let folded = fold_topics(&[], &topics(&["persistent://public/default/events"]));
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].short_name, "events");
        assert_eq!(folded[0].partitions, 0);
        assert!(folded[0].partition_names.is_empty());
    }

    fn sample_page(n: usize) -> Vec<TopicSummaryDto> {
        (0..n)
            .map(|i| to_summary(&format!("persistent://public/default/topic-{i:03}"), 0, Vec::new()))
            .collect()
    }

    fn query(offset: usize, limit: usize) -> PageQueryDto {
        PageQueryDto { offset, limit, search: None, sort_by: None, sort_dir: None }
    }

    #[test]
    fn returns_one_page_and_the_true_total() {
        let page = paginate(sample_page(250), &query(0, 25));
        assert_eq!(page.items.len(), 25);
        assert_eq!(page.total, 250);
        assert_eq!(page.offset, 0);
    }

    #[test]
    fn offset_walks_the_list() {
        let page = paginate(sample_page(250), &query(240, 25));
        assert_eq!(page.items.len(), 10, "last page is short, not padded");
        assert_eq!(page.items[0].short_name, "topic-240");
    }

    #[test]
    fn search_narrows_before_paging_and_total_reflects_the_filtered_set() {
        let mut q = query(0, 25);
        q.search = Some("topic-01".to_string());
        let page = paginate(sample_page(250), &q);
        assert_eq!(page.total, 10, "topic-010..019");
        assert!(page.items.iter().all(|t| t.short_name.contains("topic-01")));
    }

    #[test]
    fn search_is_case_insensitive() {
        let mut q = query(0, 5);
        q.search = Some("TOPIC-1".to_string());
        let page = paginate(sample_page(250), &q);
        assert!(page.total > 0);
    }

    #[test]
    fn sorting_applies_before_paging() {
        let mut q = query(0, 3);
        q.sort_by = Some("partitions".to_string());
        q.sort_dir = Some("desc".to_string());
        let mut items = sample_page(5);
        for (i, item) in items.iter_mut().enumerate() {
            item.partitions = i;
        }
        let page = paginate(items, &q);
        assert_eq!(page.items.iter().map(|t| t.partitions).collect::<Vec<_>>(), vec![4, 3, 2]);
    }

    #[test]
    fn an_offset_past_the_end_yields_an_empty_page_not_a_crash() {
        let page = paginate(sample_page(250), &query(9999, 25));
        assert!(page.items.is_empty());
        assert_eq!(page.total, 250);
    }

    #[test]
    fn an_empty_source_yields_an_empty_page() {
        let page = paginate(Vec::new(), &query(0, 25));
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
    }

    #[test]
    fn a_zero_limit_is_clamped_up_to_one_not_rejected() {
        let page = paginate(sample_page(250), &query(0, 0));
        assert_eq!(page.limit, 1);
        assert_eq!(page.items.len(), 1);
    }
}
