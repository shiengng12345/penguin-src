//! Topic detail and namespace overview — `broker_get_topic_detail` and
//! `broker_get_overview` (Phase A Task 8). This is where the parsing (Tasks
//! 5-6), the cursor positions, and the anomaly derivation (Task 7) finally
//! reach the IPC boundary the React app calls.
//!
//! ## `broker_list_subscriptions` is deliberately not built
//!
//! The design doc sketched a fifth command for this task,
//! `broker_list_subscriptions`. It is not built: Pulsar's `stats` payload
//! already carries the full subscription list with its consumers, so a
//! separate command would issue a second, identical HTTP request and hand
//! back a subset of what the caller just received in
//! `TopicDetailDto.stats.subscriptions`. If a later phase needs
//! subscriptions without the rest of the stats, add it then, with a reason.
//!
//! ## `broker_get_topic_detail` never touches the cache (ruling D-A2)
//!
//! Stats, subscriptions, consumers and cursor positions are the live
//! numbers read during triage — a cached backlog figure is not slightly
//! stale, it is actively misleading. This function has no `Connection`
//! parameter at all and never calls anything in `crate::broker::cache` or
//! `crate::broker::store`'s snapshot table; the only SQLite touch in
//! `broker_get_topic_detail` is `load_row`'s connection-metadata lookup
//! (name/URL/token), which is not stats. See
//! `tests/broker_topic_detail.rs`'s
//! `topic_detail_never_writes_a_cache_row` for the proof.
//!
//! ## `broker_get_overview`'s sampling cap
//!
//! Admin REST's topic-list endpoints ignore pagination and always return
//! every topic in the namespace (see `broker::topic_folding`'s module
//! doc) — a namespace with 10k topics would otherwise mean 10k live
//! `get_topic_stats` calls from one command invocation. `broker_get_overview`
//! samples at most [`MAX_OVERVIEW_TOPICS_SAMPLED`] topics (reusing the
//! cached topic *list*, per the phase's global constraint — only the list,
//! never the stats), and sets `truncated: true` plus a warning naming the
//! cap when there were more logical topics than that.
//!
//! ## `CapabilityProbeFailed` is produced here, not by `derive_anomalies`
//!
//! `anomaly::derive_anomalies` is pure and only ever sees a `TopicStats` —
//! it never holds a connection, so it can never probe anything. This
//! command holds the connection (it just built an admin client), so it is
//! the one place that can measure "can I even ask this broker basic
//! questions" and report the answer. The probe is a single, read-only
//! `broker_version()` call — not the full `capability::discover`, which (on
//! a non-read-only connection) creates and deletes a real scratch topic to
//! measure `can_write`. This phase is entirely read-only and never reaches
//! for a `WritePermit`; reusing `discover` here would smuggle one in through
//! a command whose brief explicitly forbids it. A failed probe becomes one
//! `Anomaly` (not an `IndeterminateCheck` — `CapabilityProbeFailed` is a
//! member of the closed `AnomalyKind` set precisely so overview callers can
//! switch on one set regardless of which check produced it), scoped to the
//! whole `tenant/namespace` rather than one topic, because that is what it
//! is evidence about.
//!
//! A per-topic `get_topic_stats` failure, in contrast, is reported as a
//! warning naming the topic, not as an `Anomaly` or `IndeterminateCheck`:
//! neither of those two types has a slot for "the whole payload for this
//! topic was unavailable" (every existing variant of both is about one
//! specific field within a stats payload the module DID receive), and
//! `ResultEnvelope::warnings` already exists for exactly this shape of
//! problem. Sampling continues with the remaining topics rather than
//! aborting the whole report over one topic's failure.

use crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use crate::broker::anomaly::{self, Anomaly, AnomalyKind, IndeterminateCheck};
use crate::broker::envelope::{BrokerError, BrokerErrorCode, BrokerSource, ResultEnvelope};
use crate::broker::internal_stats::{self, InternalStats};
use crate::broker::ports::{BrokerAdmin, TopicRef};
use crate::broker::stats::{self, TopicStats};
use crate::broker::store::ConnectionRow;
use crate::broker::topic_folding::{PageQueryDto, TopicSummaryDto};
use serde::Serialize;

use super::{load_row, resolve_secret};

/// `BacklogOlderThanThreshold` fires at or past one hour old. Matches the
/// value every threshold-boundary test in `anomaly_tests.rs` exercises
/// (`derive_anomalies(.., 3600)`), so a topic already known to sit exactly
/// at this project's understood "old backlog" line does not silently start
/// reporting a different one over the IPC boundary than it does in the
/// already-tested pure logic.
pub const OLDEST_BACKLOG_THRESHOLD_SECS: i64 = 3600;

/// The most logical topics `broker_get_overview` will sample stats for in
/// one call. Named and bounded specifically so a namespace with 10k topics
/// costs one topic-list call plus 100 stats calls, never 10k — see the
/// module doc.
pub const MAX_OVERVIEW_TOPICS_SAMPLED: usize = 100;

/// What `broker_get_topic_detail` returns. Mirrors `TopicDetail` in
/// `packages/broker-contracts/src/topic-detail.ts`.
///
/// Carries `indeterminate` alongside `anomalies`, even though the Task 8
/// brief's sketch of this type listed only `{ topic, stats, internal,
/// anomalies }`. Dropping it would make this the one place in the whole
/// module that ignores the phase's own central rule ("nothing is presented
/// as measured unless it was measured... a check that could not run must
/// reach the caller as an `IndeterminateCheck`, never as silence") — and it
/// would make `derive_indeterminate_checks`, which the brief explicitly
/// lists as an interface this task consumes, a function this task calls
/// and then throws the result away. Keeping it is the reading consistent
/// with every other ruling in this brief and the anomaly module it draws
/// on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDetailDto {
    pub topic: String,
    pub stats: TopicStats,
    pub internal: InternalStats,
    pub anomalies: Vec<Anomaly>,
    pub indeterminate: Vec<IndeterminateCheck>,
}

/// What `broker_get_overview` returns. Mirrors `OverviewReport` in
/// `packages/broker-contracts/src/anomaly.ts` field-for-field (that
/// contract already existed, written alongside Task 7's TypeScript;
/// this is its Rust counterpart).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewReportDto {
    pub tenant: String,
    pub namespace: String,
    pub topics_sampled: usize,
    pub topics_total: usize,
    pub truncated: bool,
    pub anomalies: Vec<Anomaly>,
    pub indeterminate: Vec<IndeterminateCheck>,
}

/// Fetches, parses, and derives anomalies for one topic's stats + internal
/// stats — the logic behind `broker_get_topic_detail`, factored out so
/// `tests/broker_topic_detail.rs` can exercise it directly against the live
/// broker without needing a SQLite-backed connection row, the same way
/// `tests/broker_topic_list.rs` calls `BrokerAdmin` methods directly instead
/// of the `#[tauri::command]` wrapper. Takes `&dyn BrokerAdmin`, not a
/// concrete adapter, per the brief: "Use the trait; do not build your own
/// request."
///
/// Never touches the cache — see the module doc's ruling D-A2 section.
pub async fn build_topic_detail(
    admin: &dyn BrokerAdmin,
    topic_ref: &TopicRef,
) -> Result<TopicDetailDto, BrokerError> {
    let raw_stats = admin.get_topic_stats(topic_ref).await?;
    let parsed_stats = stats::parse_topic_stats(&raw_stats)?;

    let raw_internal = admin.get_topic_internal_stats(topic_ref).await?;
    let parsed_internal = internal_stats::parse_internal_stats(&raw_internal)?;

    let anomalies = anomaly::derive_anomalies(&topic_ref.topic, &parsed_stats, OLDEST_BACKLOG_THRESHOLD_SECS);
    let indeterminate = anomaly::derive_indeterminate_checks(&topic_ref.topic, &parsed_stats);

    Ok(TopicDetailDto {
        topic: topic_ref.topic.clone(),
        stats: parsed_stats,
        internal: parsed_internal,
        anomalies,
        indeterminate,
    })
}

#[tauri::command]
pub async fn broker_get_topic_detail(
    connection_id: String,
    tenant: String,
    namespace: String,
    topic: String,
    persistent: bool,
) -> Result<ResultEnvelope<TopicDetailDto>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let admin = PulsarAdminRest::new(row.admin_url.clone(), row.timeout_ms as u64, row.tls_verify, token)
        .map_err(|e| e.message)?;

    let topic_ref = TopicRef { tenant, namespace, topic, persistent };
    match build_topic_detail(&admin, &topic_ref).await {
        Ok(dto) => Ok(ResultEnvelope::ok(dto, BrokerSource::AdminRest)),
        Err(err) => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
    }
}

/// Whether sampling stopped before covering every logical topic in the
/// namespace. Split out as its own pure function, unit-tested directly
/// below, because nothing in this test suite can spin up a live 10k-topic
/// broker to exercise the cap end-to-end — this is the decision the cap
/// actually rests on, proven without one.
fn overview_is_truncated(topics_total: usize, topics_sampled: usize) -> bool {
    topics_total > topics_sampled
}

/// Turns the outcome of the capability probe (a bare `broker_version()`
/// call — see the module doc) into `Some(Anomaly)` on failure, `None` on
/// success. Split out as a pure function of an already-resolved `Result`,
/// rather than inlining the match on the live `.await` call, specifically
/// so this decision — which is the entire reason `broker_get_overview`
/// exists to emit `CapabilityProbeFailed` at all — is unit-testable without
/// a live broker or a hand-rolled `BrokerAdmin` mock (see the tests below).
fn capability_probe_anomaly(scope: &str, probe: Result<String, BrokerError>) -> Option<Anomaly> {
    probe.err().map(|err| Anomaly {
        kind: AnomalyKind::CapabilityProbeFailed,
        topic: scope.to_string(),
        subscription: None,
        detail: format!(
            "Could not confirm this connection's basic capabilities: the broker version probe \
             failed ({}). Anomaly checks below may be based on a broker that is only partially \
             reachable.",
            err.message
        ),
        observed_value: err.message,
    })
}

#[tauri::command]
pub async fn broker_get_overview(connection_id: String) -> Result<ResultEnvelope<OverviewReportDto>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let conn = crate::db::open_product_db_shared()?;
    build_overview(conn, &row, token).await
}

/// The logic behind `broker_get_overview`, factored out exactly like
/// `topic::list_topics_through_cache` — takes its `Connection` by value
/// (never a `&Connection` held across an `.await`; see that function's own
/// doc comment for why) so `tests/broker_topic_detail.rs` can exercise it
/// against a scratch SQLite file instead of the real product database, the
/// same way `tests/broker_cache.rs` and `tests/broker_topology.rs` do for
/// their own cache-backed commands.
pub async fn build_overview(
    conn: rusqlite::Connection,
    row: &ConnectionRow,
    token: Option<String>,
) -> Result<ResultEnvelope<OverviewReportDto>, String> {
    let tenant = row.default_tenant.clone();
    let namespace = row.default_namespace.clone();

    // The topic *list* is allowed to come from the cache (it is structural,
    // not a live number) — this is the one place `broker_get_overview` may
    // touch `broker::cache` at all. Every stats call made below this point
    // is live; see the module doc.
    let query = PageQueryDto { offset: 0, limit: MAX_OVERVIEW_TOPICS_SAMPLED, search: None, sort_by: None, sort_dir: None };
    let list_envelope =
        super::topic::list_topics_through_cache(conn, row, &tenant, &namespace, &query, false, token.clone()).await?;

    let Some(page) = list_envelope.data else {
        // Could not learn which topics exist at all (no cache, and the live
        // fetch failed) — there is nothing to sample, so the whole command
        // fails the same way `broker_list_topics` would for the identical
        // input.
        let error = list_envelope.error.unwrap_or_else(|| BrokerError {
            code: BrokerErrorCode::SourceUnavailable,
            message: "topic list unavailable for reasons the broker did not report".to_string(),
            retryable: true,
        });
        return Ok(ResultEnvelope::failed(error, list_envelope.source));
    };

    let topics_total = page.total;
    let topics_sampled = page.items.len();
    let truncated = overview_is_truncated(topics_total, topics_sampled);

    let mut warnings = list_envelope.warnings;
    if truncated {
        warnings.push(format!(
            "Sampled {topics_sampled} of {topics_total} topics in {tenant}/{namespace} (cap: \
             {MAX_OVERVIEW_TOPICS_SAMPLED}); anomalies below reflect only the sampled subset, \
             not the whole namespace."
        ));
    }

    let admin = PulsarAdminRest::new(row.admin_url.clone(), row.timeout_ms as u64, row.tls_verify, token)
        .map_err(|e| e.message)?;

    let (anomalies, indeterminate, sample_warnings) = sample_overview(&admin, &tenant, &namespace, &page.items).await;
    warnings.extend(sample_warnings);

    let report = OverviewReportDto { tenant, namespace, topics_sampled, topics_total, truncated, anomalies, indeterminate };
    let mut envelope = ResultEnvelope::ok(report, BrokerSource::AdminRest);
    envelope.warnings = warnings;
    Ok(envelope)
}

/// The post-topic-list half of `build_overview`: the capability probe plus
/// per-topic sampling. Factored out (fix round 1, items 1 & 2) specifically
/// so a test can drive a real (if canned) `BrokerAdmin` through the actual
/// `.await` and `Result`/`Vec::extend` handling here — both
/// `capability_probe_anomaly` (a pure decision function) and the live
/// `fpms_topup` topic (which has no unknown fields today, and no
/// capability-probe failure to exercise) were each, on their own, unable to
/// prove this code path actually carries a failure/an indeterminate entry
/// through to the report rather than silently dropping it. Parameterized
/// over `&dyn BrokerAdmin` and an already-resolved topic list — never over
/// a `Connection` — so it cannot touch the cache either (same ruling D-A2
/// as `build_topic_detail`).
async fn sample_overview(
    admin: &dyn BrokerAdmin,
    tenant: &str,
    namespace: &str,
    items: &[TopicSummaryDto],
) -> (Vec<Anomaly>, Vec<IndeterminateCheck>, Vec<String>) {
    let mut anomalies = Vec::new();
    let mut indeterminate = Vec::new();
    let mut warnings = Vec::new();

    // A single, read-only capability probe, scoped to the whole namespace —
    // see the module doc for why this is `broker_version()` and not the
    // full write-capable `capability::discover`.
    let probe_result = admin.broker_version().await;
    if let Some(anomaly) = capability_probe_anomaly(&format!("{tenant}/{namespace}"), probe_result) {
        anomalies.push(anomaly);
    }

    for item in items {
        let topic_ref =
            TopicRef { tenant: item.tenant.clone(), namespace: item.namespace.clone(), topic: item.short_name.clone(), persistent: item.persistent };
        match build_topic_detail(admin, &topic_ref).await {
            Ok(detail) => {
                anomalies.extend(detail.anomalies);
                indeterminate.extend(detail.indeterminate);
            }
            Err(err) => {
                // One topic's stats being unavailable does not invalidate
                // the rest of the sample — see the module doc for why this
                // is a warning, not an Anomaly/IndeterminateCheck.
                warnings.push(format!("topic \"{}\": stats unavailable ({})", item.full_name, err.message));
            }
        }
    }

    (anomalies, indeterminate, warnings)
}

#[cfg(test)]
#[path = "topic_detail_tests.rs"]
mod tests;
