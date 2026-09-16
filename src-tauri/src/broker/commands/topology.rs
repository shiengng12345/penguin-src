//! Tenant and namespace listing through the snapshot cache —
//! `broker_list_tenants` and `broker_list_namespaces`. Added in Phase A Task
//! 4, on top of the `commands/` split Task 4 also did (see `mod.rs`).
//!
//! Both commands read through the cache with the same shape as
//! `topic::list_topics_through_cache` — same four-arm `Freshness` reduction
//! to `(payload, freshness_ms, warnings)`, same "refresh bypasses the read,
//! never deletes the row" rule, same corrupt-cache self-heal, same
//! `Connection`-by-value / no-`&Connection`-across-`.await` discipline (see
//! that function's doc comment for the full rationale). The one real
//! difference: neither tenants nor namespaces are paginated, so the cached
//! payload here is a bare `Vec<String>` rather than a folded/paginated topic
//! page — which is also why this is written once, generically, as
//! `list_strings_through_cache`, instead of copied twice.

use crate::broker::cache::{self, CacheScope, Freshness};
use crate::broker::envelope::{BrokerError, BrokerSource, ResultEnvelope};
use crate::broker::ports::BrokerAdmin;
use crate::broker::store::{self, ConnectionRow};
use rusqlite::Connection;
use serde::Serialize;

use super::{load_row, now_ms, resolve_secret};

/// A tenant. Mirrors `TenantSummary` in
/// `packages/broker-contracts/src/topology.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantSummaryDto {
    pub name: String,
}

/// A namespace, split from Pulsar's `"tenant/namespace"` wire form. Mirrors
/// `NamespaceSummary` in `packages/broker-contracts/src/topology.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceSummaryDto {
    pub tenant: String,
    pub name: String,
    pub full: String,
}

/// Splits `"tenant/namespace"` into parts. A name arriving with no `/` is
/// not a case the Admin REST endpoint is documented to produce, but it must
/// not panic and must not be silently dropped — it becomes `name` with an
/// empty `tenant`, and a warning naming the malformed entry is pushed onto
/// `warnings` so it stays visible rather than quietly wrong.
fn split_namespace(full: &str, warnings: &mut Vec<String>) -> NamespaceSummaryDto {
    match full.split_once('/') {
        Some((tenant, name)) => NamespaceSummaryDto { tenant: tenant.to_string(), name: name.to_string(), full: full.to_string() },
        None => {
            warnings.push(format!(
                "namespace {full:?} did not contain the expected \"tenant/namespace\" separator; \
                 treating it as a bare name with no tenant"
            ));
            NamespaceSummaryDto { tenant: String::new(), name: full.to_string(), full: full.to_string() }
        }
    }
}

#[tauri::command]
pub async fn broker_list_tenants(connection_id: String, refresh: bool) -> Result<ResultEnvelope<Vec<TenantSummaryDto>>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let conn = crate::db::open_product_db_shared()?;
    list_tenants_through_cache(conn, &row, refresh, token).await
}

#[tauri::command]
pub async fn broker_list_namespaces(
    connection_id: String,
    tenant: String,
    refresh: bool,
) -> Result<ResultEnvelope<Vec<NamespaceSummaryDto>>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let conn = crate::db::open_product_db_shared()?;
    list_namespaces_through_cache(conn, &row, &tenant, refresh, token).await
}

/// The cache-read-through logic behind `broker_list_tenants`. Scope key is
/// `"*"` — there is only ever one tenant list per connection.
pub async fn list_tenants_through_cache(
    conn: Connection,
    row: &ConnectionRow,
    refresh: bool,
    token: Option<String>,
) -> Result<ResultEnvelope<Vec<TenantSummaryDto>>, String> {
    let admin_url = row.admin_url.clone();
    let timeout_ms = row.timeout_ms as u64;
    let tls_verify = row.tls_verify;
    let fetch = async move {
        let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(admin_url, timeout_ms, tls_verify, token)?;
        admin.list_tenants().await
    };
    let envelope = list_strings_through_cache(conn, row, CacheScope::Tenants, "*", refresh, fetch).await?;
    Ok(map_string_list(envelope, |name| TenantSummaryDto { name }))
}

/// The cache-read-through logic behind `broker_list_namespaces`. Scope key
/// is the tenant name — one cached list per tenant.
pub async fn list_namespaces_through_cache(
    conn: Connection,
    row: &ConnectionRow,
    tenant: &str,
    refresh: bool,
    token: Option<String>,
) -> Result<ResultEnvelope<Vec<NamespaceSummaryDto>>, String> {
    let admin_url = row.admin_url.clone();
    let timeout_ms = row.timeout_ms as u64;
    let tls_verify = row.tls_verify;
    let tenant_owned = tenant.to_string();
    let fetch = async move {
        let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(admin_url, timeout_ms, tls_verify, token)?;
        admin.list_namespaces(&tenant_owned).await
    };
    let envelope = list_strings_through_cache(conn, row, CacheScope::Namespaces, tenant, refresh, fetch).await?;

    let mut warnings = envelope.warnings;
    let data = envelope.data.map(|names| names.into_iter().map(|n| split_namespace(&n, &mut warnings)).collect());
    Ok(ResultEnvelope {
        data,
        source: envelope.source,
        observed_at: envelope.observed_at,
        freshness_ms: envelope.freshness_ms,
        warnings,
        error: envelope.error,
    })
}

/// Generic read-through cache shared by `list_tenants_through_cache` and
/// `list_namespaces_through_cache`. Structurally identical to
/// `topic::list_topics_through_cache` — see that function's doc comment for
/// the full `Connection` Send-not-Sync rationale and the four-`Freshness`-arm
/// reduction this repeats — except the cached payload is a bare
/// `Vec<String>` rather than a folded/paginated topic page, since neither
/// tenants nor namespaces are paginated.
///
/// `fetch` is an already-constructed (but not yet polled) future rather than
/// a closure: every call path below awaits it at most once, so passing it by
/// value avoids the ceremony of a generic `Fn() -> impl Future` bound while
/// keeping the same "no `Connection` in anything `.await`-able" discipline —
/// `fetch` itself never touches `conn`.
async fn list_strings_through_cache<F>(
    conn: Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    refresh: bool,
    fetch: F,
) -> Result<ResultEnvelope<Vec<String>>, String>
where
    F: std::future::Future<Output = Result<Vec<String>, BrokerError>> + Send,
{
    let existing = store::get_snapshot(&conn, &row.id, scope.scope_name(), scope_key).map_err(|e| e.message)?;

    // `refresh` only ever suppresses reading `existing` for the freshness
    // check below; it is never deleted (same ruling as topics).
    let snapshot = if refresh { None } else { existing.clone() };
    let now = now_ms();
    let observed_at = snapshot.as_ref().map(|(_, ts)| *ts);
    let freshness = cache::assess(scope, observed_at, now);

    // Same reduction as `list_topics_through_cache`: the three cached-data
    // variants differ only in how a *successful* parse is presented, and
    // share one recovery body for a *corrupt* payload. `Skewed` keeps its
    // own named arm rather than folding into `Fresh` or a catch-all — the
    // point of the variant existing is that a human decided what it shows
    // (`freshness_ms: 0`, a warning naming the skew, never a fabricated
    // age), and that has to stay visible here.
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
                    "Cached {} list is {age_ms} ms old, past its freshness window; showing the last known list.",
                    scope.scope_name()
                )],
            ))
        }
        Freshness::Skewed { ahead_ms } => {
            let (payload, _) = snapshot.expect("Skewed implies a snapshot was read");
            Some((
                payload,
                0,
                vec![format!(
                    "Cached {} list is stamped {ahead_ms} ms ahead of this machine's clock; \
                     its age cannot be measured. Showing it anyway — check the clocks.",
                    scope.scope_name()
                )],
            ))
        }
        Freshness::Absent => None,
    };

    match cached {
        Some((payload, freshness_ms, warnings)) => match parse_string_list(&payload) {
            Ok(list) => Ok(string_list_cache_envelope(list, freshness_ms, warnings)),
            Err(parse_error) => {
                // Best-effort delete: a failure here (e.g. a transient
                // SQLite lock) must not block the refetch below.
                // `put_snapshot` is an upsert, so a successful refetch
                // overwrites the poisoned row regardless.
                let _ = store::delete_snapshot(&conn, &row.id, scope.scope_name(), scope_key);
                match fetch.await {
                    Ok(list) => build_recovered_string_envelope(&conn, row, scope, scope_key, list, &parse_error),
                    Err(err) => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
                }
            }
        },
        None => match fetch.await {
            Ok(list) => cache_and_build_string_envelope(&conn, row, scope, scope_key, list),
            Err(err) => match &existing {
                // Either `refresh` bypassed a still-good row, or there
                // never was one. Fall back to a still-readable row rather
                // than losing the screen entirely — repeatable across a
                // second, third, or Nth consecutive failed refresh, since
                // `existing` is read fresh from the DB every call and
                // nothing here deletes it.
                Some((payload, observed_at)) => match parse_string_list(payload) {
                    Ok(list) => {
                        let age_ms = now.saturating_sub(*observed_at).max(0) as u64;
                        Ok(string_list_cache_envelope(list, age_ms, vec![err.message.clone()]))
                    }
                    Err(_parse_error) => {
                        // The existing row is ALSO corrupt, and the fetch
                        // that was supposed to replace it just failed —
                        // self-heal for next time and surface the broker
                        // failure, the more actionable fact here.
                        let _ = store::delete_snapshot(&conn, &row.id, scope.scope_name(), scope_key);
                        Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest))
                    }
                },
                None => Ok(ResultEnvelope::failed(err, BrokerSource::AdminRest)),
            },
        },
    }
}

fn parse_string_list(payload: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(payload).map_err(|e| e.to_string())
}

fn string_list_cache_envelope(list: Vec<String>, freshness_ms: u64, warnings: Vec<String>) -> ResultEnvelope<Vec<String>> {
    let mut envelope = ResultEnvelope::ok(list, BrokerSource::Cache);
    envelope.freshness_ms = freshness_ms;
    envelope.warnings = warnings;
    envelope
}

/// Writes a freshly-fetched list to the cache and returns the
/// `BrokerSource::AdminRest` envelope. Purely synchronous — never
/// `.await`s — so taking `&Connection` here carries none of the `!Send`
/// risk described on `list_strings_through_cache`'s doc comment.
fn cache_and_build_string_envelope(
    conn: &Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    list: Vec<String>,
) -> Result<ResultEnvelope<Vec<String>>, String> {
    let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    store::put_snapshot(conn, &row.id, scope.scope_name(), scope_key, &json).map_err(|e| e.message)?;
    Ok(ResultEnvelope::ok(list, BrokerSource::AdminRest))
}

/// Same as `cache_and_build_string_envelope`, plus a warning naming the
/// corrupt entry that was just discarded to make room for this fresh read.
fn build_recovered_string_envelope(
    conn: &Connection,
    row: &ConnectionRow,
    scope: CacheScope,
    scope_key: &str,
    list: Vec<String>,
    parse_error: &str,
) -> Result<ResultEnvelope<Vec<String>>, String> {
    let mut envelope = cache_and_build_string_envelope(conn, row, scope, scope_key, list)?;
    envelope.warnings.push(format!(
        "The cached {} list entry was unreadable ({parse_error}) and was discarded; showing a fresh read from the broker.",
        scope.scope_name()
    ));
    Ok(envelope)
}

/// Maps a `Vec<String>` envelope's data through `f`, keeping every other
/// field intact. Used only by `list_tenants_through_cache` — namespaces
/// needs its own mapping because `split_namespace` also appends warnings.
fn map_string_list<U>(envelope: ResultEnvelope<Vec<String>>, f: impl Fn(String) -> U) -> ResultEnvelope<Vec<U>> {
    ResultEnvelope {
        data: envelope.data.map(|list| list.into_iter().map(&f).collect()),
        source: envelope.source,
        observed_at: envelope.observed_at,
        freshness_ms: envelope.freshness_ms,
        warnings: envelope.warnings,
        error: envelope.error,
    }
}
