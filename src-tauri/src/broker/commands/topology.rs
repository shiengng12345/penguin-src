//! Tenant and namespace listing through the snapshot cache —
//! `broker_list_tenants` and `broker_list_namespaces`. Added in Phase A Task
//! 4, on top of the `commands/` split Task 4 also did (see `mod.rs`).
//!
//! The cache-read-through policy itself lives in
//! `cache_read::read_through_cache` (Task 4 fix round 1): this file used to
//! carry its own copy of that ~70-line policy — identical to
//! `topic::list_topics_through_cache`'s except for the payload shape — until
//! that duplication was recognised as the same defect fix round 3 already
//! removed inside one function, one level up. What remains here is the
//! topology-specific part: the fetch (admin REST list-tenants /
//! list-namespaces calls) and the tenant/namespace DTO mapping, which is
//! done AFTER `read_through_cache` returns rather than inside its generic
//! `render`, because `render` has no side channel to add the extra warning
//! a malformed `"tenant/namespace"` split needs (see
//! `list_namespaces_through_cache` below).

use crate::broker::cache::CacheScope;
use crate::broker::envelope::{BrokerError, ResultEnvelope};
use crate::broker::ports::BrokerAdmin;
use crate::broker::store::ConnectionRow;
use rusqlite::Connection;
use serde::Serialize;

use super::cache_read::read_through_cache;
use super::{load_row, resolve_secret};

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
/// `"*"` — there is only ever one tenant list per connection. `render` is
/// just a clone: the `Vec<String>` -> `Vec<TenantSummaryDto>` mapping needs
/// no side channel, so it happens after `read_through_cache` returns instead
/// (`map_string_list`, below).
pub async fn list_tenants_through_cache(
    conn: Connection,
    row: &ConnectionRow,
    refresh: bool,
    token: Option<String>,
) -> Result<ResultEnvelope<Vec<TenantSummaryDto>>, String> {
    let fetch = fetch_tenants(row, token);
    let envelope = read_through_cache(conn, row, CacheScope::Tenants, "*", refresh, fetch, Vec::clone).await?;
    Ok(map_string_list(envelope, |name| TenantSummaryDto { name }))
}

/// The cache-read-through logic behind `broker_list_namespaces`. Scope key
/// is the tenant name — one cached list per tenant. The `Vec<String>` ->
/// `Vec<NamespaceSummaryDto>` split happens after `read_through_cache`
/// returns (not inside its generic `render`) because `split_namespace` can
/// append a warning for a malformed entry, and `render: Fn(&Snapshot) -> Out`
/// has no way to feed anything back into the envelope's `warnings`.
pub async fn list_namespaces_through_cache(
    conn: Connection,
    row: &ConnectionRow,
    tenant: &str,
    refresh: bool,
    token: Option<String>,
) -> Result<ResultEnvelope<Vec<NamespaceSummaryDto>>, String> {
    let fetch = fetch_namespaces(row, tenant, token);
    let envelope = read_through_cache(conn, row, CacheScope::Namespaces, tenant, refresh, fetch, Vec::clone).await?;

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

async fn fetch_tenants(row: &ConnectionRow, token: Option<String>) -> Result<Vec<String>, BrokerError> {
    let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(
        row.admin_url.clone(),
        row.timeout_ms as u64,
        row.tls_verify,
        token,
    )?;
    admin.list_tenants().await
}

async fn fetch_namespaces(row: &ConnectionRow, tenant: &str, token: Option<String>) -> Result<Vec<String>, BrokerError> {
    let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(
        row.admin_url.clone(),
        row.timeout_ms as u64,
        row.tls_verify,
        token,
    )?;
    admin.list_namespaces(tenant).await
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
