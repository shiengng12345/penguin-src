//! The one read-through-cache policy shared by topic, tenant, and namespace
//! listing (Task 4 fix round 1). `topic::list_topics_through_cache` and
//! `topology::list_tenants_through_cache` / `list_namespaces_through_cache`
//! used to each carry their own ~70-line copy of this exact policy — read
//! snapshot, assess freshness, reduce the four `Freshness` arms to
//! `(payload, freshness_ms, warnings)`, one shared corrupt-recovery body,
//! `Absent` fetches, fall back to `existing` on a broker error — differing
//! only in how the payload parses, how the fetch happens, how the success
//! envelope is built, and the wording of two warnings. That is the same
//! duplication defect fix round 3 removed inside one function (the
//! triplicated per-`Freshness`-arm recovery body), one level up: two copies
//! in two files instead of three copies in one. This module holds the
//! policy once, generic over:
//!
//! - `Snapshot`: what gets stored as JSON — `TopicListSnapshot` for topics,
//!   `Vec<String>` for tenants/namespaces.
//! - `Out`: what the caller gets back — a folded/paginated topic page for
//!   topics, essentially a clone for topology (topology's callers do their
//!   own tenant/namespace DTO mapping afterward, outside this policy, since
//!   `render` has no side channel to add the extra warnings a malformed
//!   `"tenant/namespace"` split needs — see `topology::list_namespaces_through_cache`).

use crate::broker::cache::{self, CacheScope, Freshness};
use crate::broker::envelope::{BrokerError, BrokerSource, ResultEnvelope};
use crate::broker::store::{self, ConnectionRow};
use rusqlite::Connection;

use super::now_ms;

/// Takes `conn: Connection` by value and never accepts or holds a
/// `&Connection` across an `.await`. `rusqlite::Connection` is `Send` but
/// not `Sync`; an *owned* `Connection` crossing an `.await` is fine (`Send`
/// never requires `Sync`), which is why it's safe for `conn` to sit alive,
/// untouched, across `fetch.await` below. But an async fn PARAMETER typed
/// `&Connection` gets baked into that function's own generator state for as
/// long as the parameter is live, and if that span crosses one of its own
/// internal `.await`s, the whole embedded future becomes `!Send` — which
/// then poisons every ancestor that `.await`s it, all the way up to the
/// `#[tauri::command]`. So `fetch` carries no `Connection` at all, and every
/// `store::` call here is a short-lived, synchronous `&conn` borrow that
/// starts and ends within one statement, never straddling an `.await`.
/// `render` is synchronous for the same reason.
///
/// `refresh` means "don't serve me the cache, go ask the broker" — it does
/// NOT mean "destroy what I have". The cached row is left in the database;
/// only the freshness assessment is forced to `Absent` so the fetch below
/// actually runs. `store::put_snapshot` is a genuine upsert, so a successful
/// refetch already overwrites the row on its own — deleting it first would
/// only convert a recoverable broker failure into permanent data loss, and
/// would make a second consecutive failed refresh return a hard error
/// instead of the same fallback the first one got.
pub(super) async fn read_through_cache<Snapshot, Out, Fetch, Render>(
    conn: Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    refresh: bool,
    fetch: Fetch,
    render: Render,
) -> Result<ResultEnvelope<Out>, String>
where
    Snapshot: serde::Serialize + serde::de::DeserializeOwned,
    Fetch: std::future::Future<Output = Result<Snapshot, BrokerError>> + Send,
    Render: Fn(&Snapshot) -> Out + Send,
{
    let existing = store::get_snapshot(&conn, &row.id, scope.scope_name(), scope_key).map_err(|e| e.message)?;

    // `refresh` only ever suppresses reading `existing` for the freshness
    // check below; it is never deleted.
    let snapshot_row = if refresh { None } else { existing.clone() };
    let now = now_ms();
    let observed_at = snapshot_row.as_ref().map(|(_, ts)| *ts);
    let freshness = cache::assess(scope, observed_at, now);

    // The three cached-data variants (`Fresh`/`Stale`/`Skewed`) differ from
    // each other in exactly one respect — how a *successful* parse of the
    // payload is presented (the freshness to report, and what to warn
    // about) — and are identical in how a *corrupt* payload is recovered
    // from. Reducing each to (payload, freshness_ms, warnings) here, once,
    // is what lets the recovery path below be written once instead of
    // three times. `Absent` has no cached data at all, so it reduces to
    // `None` and is handled entirely separately below (it goes straight to
    // the broker; there is no payload to parse in the first place). The
    // match stays exhaustive and every variant stays named — the point of
    // `Skewed` existing as its own variant is that a human decided what it
    // shows (`freshness_ms: 0`, a warning naming the skew, never a
    // fabricated age), and that decision has to stay visible here, not get
    // absorbed into a generic branch.
    let cached: Option<(String, u64, Vec<String>)> = match freshness {
        Freshness::Fresh { age_ms } => {
            let (payload, _) = snapshot_row.expect("Fresh implies a snapshot was read");
            Some((payload, age_ms, Vec::new()))
        }
        Freshness::Stale { age_ms } => {
            let (payload, _) = snapshot_row.expect("Stale implies a snapshot was read");
            Some((
                payload,
                age_ms,
                vec![format!(
                    "Cached {} list is {age_ms} ms old, past its freshness window; showing the last known list.",
                    scope.subject()
                )],
            ))
        }
        Freshness::Skewed { ahead_ms } => {
            // Usable-but-suspect, exactly like Stale: serve the cached rows,
            // but name the skew explicitly rather than folding it into a
            // reassuring "fresh" or a meaningless age.
            let (payload, _) = snapshot_row.expect("Skewed implies a snapshot was read");
            Some((
                payload,
                0,
                vec![format!(
                    "Cached {} list is stamped {ahead_ms} ms ahead of this machine's clock; \
                     its age cannot be measured. Showing it anyway — check the clocks.",
                    scope.subject()
                )],
            ))
        }
        Freshness::Absent => None,
    };

    match cached {
        Some((payload, freshness_ms, warnings)) => match parse_snapshot::<Snapshot>(&payload) {
            Ok(snapshot) => Ok(cache_envelope(render(&snapshot), freshness_ms, warnings)),
            Err(parse_error) => {
                // Best-effort delete: if it fails (e.g. a transient SQLite
                // lock), still proceed to the refetch below. `put_snapshot`
                // is an upsert, so a successful refetch overwrites the
                // poisoned row whether or not this delete succeeded —
                // aborting here over a delete failure would produce a hard
                // error screen while the broker is perfectly healthy.
                let _ = store::delete_snapshot(&conn, &row.id, scope.scope_name(), scope_key);
                match fetch.await {
                    Ok(snapshot) => build_recovered_envelope(&conn, row, scope, scope_key, snapshot, &render, &parse_error),
                    Err(err) => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
                }
            }
        },
        None => match fetch.await {
            Ok(snapshot) => cache_and_build_envelope(&conn, row, scope, scope_key, snapshot, &render),
            Err(err) => match &existing {
                // Either `refresh` bypassed a still-good row, or there
                // never was one. If there was, and it is still readable,
                // fall back to it — losing the screen entirely because a
                // refresh failed is worse than showing what we last
                // knew, clearly marked with the failure. This is
                // repeatable: `existing` is read fresh from the DB on
                // every call and nothing here deletes it, so a second,
                // third, or Nth consecutive failed refresh gets the same
                // fallback as the first.
                Some((payload, observed_at)) => match parse_snapshot::<Snapshot>(payload) {
                    Ok(snapshot) => {
                        let age_ms = now.saturating_sub(*observed_at).max(0) as u64;
                        Ok(cache_envelope(render(&snapshot), age_ms, vec![err.message.clone()]))
                    }
                    Err(_parse_error) => {
                        // The existing row is ALSO corrupt, and the fetch
                        // that was supposed to replace it just failed —
                        // nothing valid remains. Self-heal for next time
                        // (best-effort, same reasoning as above) and
                        // surface the broker failure, the more actionable
                        // fact here.
                        let _ = store::delete_snapshot(&conn, &row.id, scope.scope_name(), scope_key);
                        Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest))
                    }
                },
                None => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
            },
        },
    }
}

/// Parses one cached JSON payload into `Snapshot` — the pure, synchronous
/// part of serving a cached response. Returns the deserialize error message
/// on a corrupt payload so the caller can decide how to recover, rather than
/// surfacing it as a hard failure.
fn parse_snapshot<Snapshot: serde::de::DeserializeOwned>(payload: &str) -> Result<Snapshot, String> {
    serde_json::from_str(payload).map_err(|e| e.to_string())
}

fn cache_envelope<Out>(data: Out, freshness_ms: u64, warnings: Vec<String>) -> ResultEnvelope<Out> {
    let mut envelope = ResultEnvelope::ok(data, BrokerSource::Cache);
    envelope.freshness_ms = freshness_ms;
    envelope.warnings = warnings;
    envelope
}

/// Writes a freshly-fetched snapshot to the cache as JSON and returns the
/// rendered `BrokerSource::AdminRest` envelope. Purely synchronous — never
/// `.await`s — so taking `&Connection` here carries none of the `!Send`
/// risk described on `read_through_cache`'s doc comment.
fn cache_and_build_envelope<Snapshot, Out>(
    conn: &Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    snapshot: Snapshot,
    render: &impl Fn(&Snapshot) -> Out,
) -> Result<ResultEnvelope<Out>, String>
where
    Snapshot: serde::Serialize,
{
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    store::put_snapshot(conn, &row.id, scope.scope_name(), scope_key, &json).map_err(|e| e.message)?;
    Ok(ResultEnvelope::ok(render(&snapshot), BrokerSource::AdminRest))
}

/// Same as `cache_and_build_envelope`, plus a warning naming the corrupt
/// entry that was just discarded to make room for this fresh read — used by
/// the `Fresh`/`Stale`/`Skewed` corrupt-cache-recovery path above.
fn build_recovered_envelope<Snapshot, Out>(
    conn: &Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    snapshot: Snapshot,
    render: &impl Fn(&Snapshot) -> Out,
    parse_error: &str,
) -> Result<ResultEnvelope<Out>, String>
where
    Snapshot: serde::Serialize,
{
    let mut envelope = cache_and_build_envelope(conn, row, scope, scope_key, snapshot, render)?;
    envelope.warnings.push(format!(
        "The cached {} list entry was unreadable ({parse_error}) and was discarded; showing a fresh read from the broker.",
        scope.subject()
    ));
    Ok(envelope)
}
