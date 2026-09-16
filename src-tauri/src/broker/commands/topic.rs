//! Topic listing through the snapshot cache — `broker_list_topics` and the
//! cache-read-through/recovery logic behind it (`list_topics_through_cache`).
//! Split out of the former single-file `commands.rs` (Phase A Task 4, pure
//! move: no behaviour changed, only file location).

use crate::broker::cache::{self, CacheScope, Freshness};
use crate::broker::envelope::{BrokerError, BrokerSource, ResultEnvelope};
use crate::broker::ports::BrokerAdmin;
use crate::broker::store::{self, ConnectionRow};
use crate::broker::topic_folding::{self, PageDto, PageQueryDto, TopicSummaryDto};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{load_row, now_ms, resolve_secret};

/// The two lists cached together as one JSON object, so `all` and
/// `partitioned` can never drift apart on disk (a stale `all` next to a
/// fresh `partitioned`, or vice versa, would silently corrupt folding).
#[derive(Serialize, Deserialize)]
struct TopicListSnapshot {
    all: Vec<String>,
    partitioned: Vec<String>,
}

#[tauri::command]
pub async fn broker_list_topics(
    connection_id: String,
    tenant: String,
    namespace: String,
    query: PageQueryDto,
    refresh: bool,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let conn = crate::db::open_product_db_shared()?;
    list_topics_through_cache(conn, &row, &tenant, &namespace, &query, refresh, token).await
}

/// The actual cache-read-through logic behind `broker_list_topics`, taking
/// its SQLite connection as a parameter rather than opening the product DB
/// itself. This is what makes it possible to test the caching behaviour
/// in-process against an in-memory database (see `tests/broker_cache.rs`)
/// instead of exercising the `#[tauri::command]` wrapper against the real
/// `~/.penguin/penguin.sqlite3`.
///
/// Takes the `Connection` by value, not `&Connection`, and — this is the
/// part that actually matters — never passes it into another `async fn`
/// that this function then `.await`s. `rusqlite::Connection` is `Send` but
/// not `Sync`. An *owned* `Connection` crossing an `.await` is fine (`Send`
/// never requires `Sync`), which is why it's safe for `conn` to sit alive,
/// untouched, across the broker calls below. But an async fn PARAMETER
/// typed `&Connection` gets baked into *that* function's own generator
/// state for as long as the parameter is live, and if that span crosses one
/// of its own internal `.await`s, the whole embedded future becomes
/// `!Send` — which then poisons every ancestor that `.await`s it, all the
/// way up to this `#[tauri::command]`. (An earlier version of this function
/// learned this by hitting exactly that compile error twice; see the Task 3
/// report's "Fix round 2" section for the full trace.) So the broker
/// network calls (`fetch_topic_lists`, below) take no `Connection`
/// parameter at all, and every `store::` call here is a short-lived,
/// synchronous `&conn` borrow that starts and ends within one statement,
/// never straddling an `.await`.
///
/// `refresh` means "don't serve me the cache, go ask the broker" — it does
/// NOT mean "destroy what I have". The cached row is left in the database;
/// only the freshness assessment is forced to `Absent` so the fetch below
/// actually runs. `store::put_snapshot` is a genuine upsert, so a successful
/// refetch already overwrites the row on its own — deleting it first would
/// only convert a recoverable broker failure into permanent data loss, and
/// would make a second consecutive failed refresh return a hard error
/// instead of the same fallback the first one got.
pub async fn list_topics_through_cache(
    conn: Connection,
    row: &ConnectionRow,
    tenant: &str,
    namespace: &str,
    query: &PageQueryDto,
    refresh: bool,
    token: Option<String>,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let scope = CacheScope::Topics;
    let scope_key = format!("{tenant}/{namespace}");

    let existing = store::get_snapshot(&conn, &row.id, scope.scope_name(), &scope_key).map_err(|e| e.message)?;

    // `refresh` only ever suppresses reading `existing` for the freshness
    // check below; it is never deleted.
    let snapshot = if refresh { None } else { existing.clone() };
    let now = now_ms();
    let observed_at = snapshot.as_ref().map(|(_, ts)| *ts);
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
            let (payload, _) = snapshot.expect("Fresh implies a snapshot was read");
            Some((payload, age_ms, Vec::new()))
        }
        Freshness::Stale { age_ms } => {
            let (payload, _) = snapshot.expect("Stale implies a snapshot was read");
            Some((
                payload,
                age_ms,
                vec![format!(
                    "Cached topic list is {age_ms} ms old, past its freshness window; showing the last known list."
                )],
            ))
        }
        Freshness::Skewed { ahead_ms } => {
            // Usable-but-suspect, exactly like Stale: serve the cached rows,
            // but name the skew explicitly rather than folding it into a
            // reassuring "fresh" or a meaningless age.
            let (payload, _) = snapshot.expect("Skewed implies a snapshot was read");
            Some((
                payload,
                0,
                vec![format!(
                    "Cached topic list is stamped {ahead_ms} ms ahead of this machine's clock; \
                     its age cannot be measured. Showing it anyway — check the clocks."
                )],
            ))
        }
        Freshness::Absent => None,
    };

    match cached {
        Some((payload, freshness_ms, warnings)) => match parse_topic_page(&payload, query) {
            Ok(page) => Ok(cache_envelope(page, freshness_ms, warnings)),
            Err(parse_error) => {
                // Best-effort delete: if it fails (e.g. a transient SQLite
                // lock), still proceed to the refetch below. `put_snapshot`
                // is an upsert, so a successful refetch overwrites the
                // poisoned row whether or not this delete succeeded —
                // aborting here over a delete failure would produce a hard
                // error screen while the broker is perfectly healthy.
                let _ = store::delete_snapshot(&conn, &row.id, scope.scope_name(), &scope_key);
                match fetch_topic_lists(row, tenant, namespace, token).await {
                    Ok((all, partitioned)) => {
                        build_recovered_envelope(&conn, row, scope, &scope_key, all, partitioned, query, &parse_error)
                    }
                    Err(err) => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
                }
            }
        },
        None => match fetch_topic_lists(row, tenant, namespace, token).await {
            Ok((all, partitioned)) => cache_and_build_admin_envelope(&conn, row, scope, &scope_key, all, partitioned, query),
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
                Some((payload, observed_at)) => match parse_topic_page(payload, query) {
                    Ok(page) => {
                        let age_ms = now.saturating_sub(*observed_at).max(0) as u64;
                        Ok(cache_envelope(page, age_ms, vec![err.message.clone()]))
                    }
                    Err(_parse_error) => {
                        // The existing row is ALSO corrupt, and the fetch
                        // that was supposed to replace it just failed —
                        // nothing valid remains. Self-heal for next time
                        // (best-effort, same reasoning as above) and
                        // surface the broker failure, the more actionable
                        // fact here.
                        let _ = store::delete_snapshot(&conn, &row.id, scope.scope_name(), &scope_key);
                        Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest))
                    }
                },
                None => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
            },
        },
    }
}

/// Parses one cached `TopicListSnapshot`, folds it, and pages it — the pure,
/// synchronous part of serving a cached response. Returns the deserialize
/// error message on a corrupt payload so the caller can decide how to
/// recover, rather than surfacing it as a hard failure.
fn parse_topic_page(payload: &str, query: &PageQueryDto) -> Result<PageDto<TopicSummaryDto>, String> {
    let cached: TopicListSnapshot = serde_json::from_str(payload).map_err(|e| e.to_string())?;
    let folded = topic_folding::fold_topics(&cached.all, &cached.partitioned);
    Ok(topic_folding::paginate(folded, query))
}

fn cache_envelope(
    page: PageDto<TopicSummaryDto>,
    freshness_ms: u64,
    warnings: Vec<String>,
) -> ResultEnvelope<PageDto<TopicSummaryDto>> {
    let mut envelope = ResultEnvelope::ok(page, BrokerSource::Cache);
    envelope.freshness_ms = freshness_ms;
    envelope.warnings = warnings;
    envelope
}

/// Fetches both topic lists from the broker — a pure network call, with no
/// `Connection` parameter at all. Kept free of any cache access specifically
/// so it can be `.await`ed safely from `list_topics_through_cache` without
/// risking the `!Send` trap described on that function's doc comment.
async fn fetch_topic_lists(
    row: &ConnectionRow,
    tenant: &str,
    namespace: &str,
    token: Option<String>,
) -> Result<(Vec<String>, Vec<String>), BrokerError> {
    // Admin REST ignores paging, so fetch the full lists here; folding
    // partitions and paging happens in Rust afterward (spec V-A5 / V-A6).
    let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(
        row.admin_url.clone(),
        row.timeout_ms as u64,
        row.tls_verify,
        token,
    )?;
    match (
        admin.list_topics(tenant, namespace).await,
        admin.list_partitioned_topics(tenant, namespace).await,
    ) {
        (Ok(all), Ok(partitioned)) => Ok((all, partitioned)),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}

/// Folds and pages a freshly-fetched topic list, writes it to the cache as
/// one `TopicListSnapshot` JSON object (so `all` and `partitioned` cannot
/// drift apart on disk), and returns the paginated `BrokerSource::AdminRest`
/// envelope. Purely synchronous — never `.await`s — so taking `&Connection`
/// here carries none of the `!Send` risk described above.
fn cache_and_build_admin_envelope(
    conn: &Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    all: Vec<String>,
    partitioned: Vec<String>,
    query: &PageQueryDto,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let folded = topic_folding::fold_topics(&all, &partitioned);
    let snap = TopicListSnapshot { all, partitioned };
    let json = serde_json::to_string(&snap).map_err(|e| e.to_string())?;
    store::put_snapshot(conn, &row.id, scope.scope_name(), scope_key, &json).map_err(|e| e.message)?;
    let page = topic_folding::paginate(folded, query);
    Ok(ResultEnvelope::ok(page, BrokerSource::AdminRest))
}

/// Same as `cache_and_build_admin_envelope`, plus a warning naming the
/// corrupt entry that was just discarded to make room for this fresh read —
/// used by the `Fresh`/`Stale`/`Skewed` corrupt-cache-recovery paths above.
fn build_recovered_envelope(
    conn: &Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    all: Vec<String>,
    partitioned: Vec<String>,
    query: &PageQueryDto,
    parse_error: &str,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let mut envelope = cache_and_build_admin_envelope(conn, row, scope, scope_key, all, partitioned, query)?;
    envelope.warnings.push(format!(
        "The cached topic list entry was unreadable ({parse_error}) and was discarded; showing a fresh read from the broker."
    ));
    Ok(envelope)
}
