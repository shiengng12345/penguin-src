//! Tauri commands. Every one takes `connectionId` explicitly — the "active"
//! connection is a UI concept and never an implicit backend default.
//!
//! Secrets follow DEC #195: the plaintext arrives once on upsert, goes
//! straight to the keychain, and is never returned. The frontend only ever
//! sees `secretHandleId` — `ConnectionDto` has no plaintext field at all, so
//! there is no field to accidentally serialize across IPC.
//!
//! Divergence from the Task 14 brief: commands here don't take a
//! `tauri::AppHandle` parameter — nothing in this module needs one (the
//! connections DB opens by home-dir path, same as every other `db::`
//! command; see `crate::db::open_product_db_shared`), so it would be an
//! unused parameter. `broker_list_connections` / `broker_upsert_connection` /
//! `broker_delete_connection` also return `Result<_, String>` rather than a
//! bare value — every one of them touches SQLite or the keychain and can
//! fail, and `Result<T, String>` is this codebase's existing convention for
//! fallible commands (see `db.rs`).

use crate::broker::capability::{self, CapabilitySnapshot};
use crate::broker::envelope::{BrokerError, BrokerErrorCode, ResultEnvelope};
use crate::broker::ports::BrokerAdmin;
use crate::broker::store::{self, ConnectionRow};
use crate::broker::topic_folding::{self, PageDto, PageQueryDto, TopicSummaryDto};
use serde::{Deserialize, Serialize};

/// Separate keychain namespace from the REST module's `"penguin-rest"` —
/// same adapter, distinct account space, so a broker connection id can never
/// collide with a REST secret handle.
const KEYCHAIN_SERVICE: &str = "penguin-broker";

/// What the frontend sees. Deliberately has no secret/token/credential field
/// of any kind — only `secret_handle_id`, a keychain reference. Mirrors
/// `BrokerConnection` in `packages/broker-contracts/src/connection.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDto {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub color: String,
    pub admin_url: String,
    pub broker_url: String,
    pub auth_type: String,
    pub secret_handle_id: Option<String>,
    pub default_tenant: String,
    pub default_namespace: String,
    pub read_only: bool,
    pub tls_verify: bool,
    pub timeout_ms: i64,
    pub last_status: String,
    pub last_checked_at: Option<i64>,
    pub broker_version: Option<String>,
    pub capabilities: Option<CapabilitySnapshot>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_dto(row: &ConnectionRow) -> ConnectionDto {
    let capabilities = row
        .capabilities_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<CapabilitySnapshot>(json).ok());
    ConnectionDto {
        id: row.id.clone(),
        kind: row.kind.clone(),
        name: row.name.clone(),
        color: row.color.clone(),
        admin_url: row.admin_url.clone(),
        broker_url: row.broker_url.clone(),
        auth_type: row.auth_type.clone(),
        secret_handle_id: row.secret_handle_id.clone(),
        default_tenant: row.default_tenant.clone(),
        default_namespace: row.default_namespace.clone(),
        read_only: row.read_only,
        tls_verify: row.tls_verify,
        timeout_ms: row.timeout_ms,
        last_status: row.last_status.clone(),
        last_checked_at: row.last_checked_at,
        broker_version: row.broker_version.clone(),
        capabilities,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_row(connection_id: &str) -> Result<ConnectionRow, String> {
    let conn = crate::db::open_product_db_shared()?;
    store::get_connection(&conn, connection_id)
        .map_err(|e| e.message)?
        .ok_or_else(|| format!("no broker connection found for id {connection_id:?}"))
}

/// Resolves a keychain handle to plaintext, for use inside this process
/// only. The caller must never place the returned value in anything that
/// crosses IPC, a log line, or an error message.
fn resolve_secret(secret_handle_id: Option<&str>) -> Result<Option<String>, String> {
    let Some(handle) = secret_handle_id else { return Ok(None) };
    crate::rest::keychain::active_adapter()
        .get(KEYCHAIN_SERVICE, handle)
        .map_err(|e| format!("keychain read failed: {e}"))?
        .map(Some)
        .ok_or_else(|| format!("keychain entry missing for handle {handle:?}"))
}

/// Maps a probe failure to the connection's persisted status column so the
/// connection list can show *why* a connection is unhealthy without
/// re-running discovery.
fn status_for_error(code: BrokerErrorCode) -> &'static str {
    match code {
        BrokerErrorCode::AuthenticationFailed => "unauthorized",
        BrokerErrorCode::Forbidden => "forbidden",
        BrokerErrorCode::TlsError => "tls_error",
        _ => "unreachable",
    }
}

fn persist_probe_result(row: &ConnectionRow, snapshot: &CapabilitySnapshot) -> Result<(), String> {
    let conn = crate::db::open_product_db_shared()?;
    let capabilities_json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    let mut updated = row.clone();
    updated.last_status = "ok".to_string();
    updated.last_checked_at = Some(snapshot.probed_at);
    updated.broker_version = snapshot.broker_version.clone();
    updated.capabilities_json = Some(capabilities_json);
    updated.updated_at = snapshot.probed_at;
    store::upsert_connection(&conn, &updated).map_err(|e| e.message)
}

fn persist_probe_failure(row: &ConnectionRow, err: &BrokerError) -> Result<(), String> {
    let conn = crate::db::open_product_db_shared()?;
    let now = now_ms();
    let mut updated = row.clone();
    updated.last_status = status_for_error(err.code).to_string();
    updated.last_checked_at = Some(now);
    // Deliberately NOT clearing `broker_version` / `capabilities_json` — the
    // last known-good measurement stays visible rather than being wiped by
    // one failed probe.
    updated.updated_at = now;
    store::upsert_connection(&conn, &updated).map_err(|e| e.message)
}

#[tauri::command]
pub async fn broker_list_connections() -> Result<Vec<ConnectionDto>, String> {
    let conn = crate::db::open_product_db_shared()?;
    let rows = store::list_connections(&conn).map_err(|e| e.message)?;
    Ok(rows.iter().map(row_to_dto).collect())
}

/// Writes any supplied `secret` to the keychain and stores only the
/// resulting handle. `draft.id` is required (like every other upsert
/// command in this codebase, e.g. `db_upsert_saved_request`) — the frontend
/// generates ids, the backend never invents one silently.
///
/// A `None`/empty `secret` on an update keeps whatever handle the row
/// already had; editing a connection's name must not silently drop its
/// saved credential.
#[tauri::command]
pub async fn broker_upsert_connection(draft: ConnectionDto, secret: Option<String>) -> Result<ConnectionDto, String> {
    if draft.id.trim().is_empty() {
        return Err("connection id is required".to_string());
    }
    let conn = crate::db::open_product_db_shared()?;
    let existing = store::get_connection(&conn, &draft.id).map_err(|e| e.message)?;

    let secret_handle_id = match secret.filter(|s| !s.is_empty()) {
        Some(plaintext) => {
            let handle_id = format!("conn:{}", draft.id);
            crate::rest::keychain::active_adapter()
                .save(KEYCHAIN_SERVICE, &handle_id, &plaintext)
                .map_err(|e| format!("keychain write failed: {e}"))?;
            Some(handle_id)
        }
        None => existing.as_ref().and_then(|r| r.secret_handle_id.clone()),
    };

    let now = now_ms();
    let row = ConnectionRow {
        id: draft.id.clone(),
        kind: draft.kind.clone(),
        name: draft.name.clone(),
        color: draft.color.clone(),
        admin_url: draft.admin_url.clone(),
        broker_url: draft.broker_url.clone(),
        auth_type: draft.auth_type.clone(),
        secret_handle_id,
        default_tenant: draft.default_tenant.clone(),
        default_namespace: draft.default_namespace.clone(),
        read_only: draft.read_only,
        tls_verify: draft.tls_verify,
        timeout_ms: draft.timeout_ms,
        last_status: existing.as_ref().map(|r| r.last_status.clone()).unwrap_or_else(|| "unknown".to_string()),
        last_checked_at: existing.as_ref().and_then(|r| r.last_checked_at),
        broker_version: existing.as_ref().and_then(|r| r.broker_version.clone()),
        capabilities_json: existing.as_ref().and_then(|r| r.capabilities_json.clone()),
        created_at: existing.as_ref().map(|r| r.created_at).unwrap_or(now),
        updated_at: now,
    };
    store::upsert_connection(&conn, &row).map_err(|e| e.message)?;
    Ok(row_to_dto(&row))
}

#[tauri::command]
pub async fn broker_delete_connection(connection_id: String) -> Result<(), String> {
    let conn = crate::db::open_product_db_shared()?;
    // Remove the keychain entry entirely — not an empty-string overwrite —
    // so deleting a connection never leaves a named `conn:{id}` entry
    // behind in the user's keychain forever. Best-effort: a keychain
    // failure here must not block the connection row itself from being
    // removed.
    if let Ok(Some(row)) = store::get_connection(&conn, &connection_id) {
        purge_secret(row.secret_handle_id.as_deref());
    }
    store::delete_connection(&conn, &connection_id).map_err(|e| e.message)
}

/// Deletes a connection's keychain entry outright. A handle that was never
/// saved (`None`) is a no-op; `KeychainAdapter::delete` itself treats a
/// missing/already-deleted entry as success, not an error (see
/// `rest/keychain.rs`).
fn purge_secret(secret_handle_id: Option<&str>) {
    if let Some(handle) = secret_handle_id {
        let _ = crate::rest::keychain::active_adapter().delete(KEYCHAIN_SERVICE, handle);
    }
}

#[tauri::command]
pub async fn broker_test_connection(connection_id: String) -> Result<ResultEnvelope<CapabilitySnapshot>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;

    match capability::discover(&row.admin_url, &row.broker_url, row.timeout_ms as u64, row.tls_verify, token, row.read_only)
        .await
    {
        Ok(snapshot) => {
            persist_probe_result(&row, &snapshot)?;
            Ok(ResultEnvelope::ok(snapshot, "pulsar-admin-rest"))
        }
        Err(err) => {
            persist_probe_failure(&row, &err)?;
            Ok(ResultEnvelope::failed(err, "pulsar-admin-rest"))
        }
    }
}

#[tauri::command]
pub async fn broker_list_topics(
    connection_id: String,
    tenant: String,
    namespace: String,
    query: PageQueryDto,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let admin = match crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(
        row.admin_url.clone(),
        row.timeout_ms as u64,
        row.tls_verify,
        token,
    ) {
        Ok(a) => a,
        Err(e) => return Ok(ResultEnvelope::failed(e, "pulsar-admin-rest")),
    };

    // Admin REST ignores paging, so fetch the full lists, fold partitions,
    // and page in Rust (spec V-A5 / V-A6).
    let (all, partitioned) = match (
        admin.list_topics(&tenant, &namespace).await,
        admin.list_partitioned_topics(&tenant, &namespace).await,
    ) {
        (Ok(a), Ok(p)) => (a, p),
        (Err(e), _) | (_, Err(e)) => return Ok(ResultEnvelope::failed(e, "pulsar-admin-rest")),
    };

    let folded = topic_folding::fold_topics(&all, &partitioned);
    let page = topic_folding::paginate(folded, &query);
    Ok(ResultEnvelope::ok(page, "pulsar-admin-rest"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_for_error_maps_the_four_operator_relevant_codes() {
        assert_eq!(status_for_error(BrokerErrorCode::AuthenticationFailed), "unauthorized");
        assert_eq!(status_for_error(BrokerErrorCode::Forbidden), "forbidden");
        assert_eq!(status_for_error(BrokerErrorCode::TlsError), "tls_error");
        assert_eq!(status_for_error(BrokerErrorCode::Timeout), "unreachable");
        assert_eq!(status_for_error(BrokerErrorCode::SourceUnavailable), "unreachable");
    }

    /// Proves `broker_delete_connection`'s keychain cleanup removes the
    /// entry entirely rather than merely emptying it — reading it back must
    /// report absence (`None`), not `Some("")`. Exercises `purge_secret`
    /// directly (the same call `broker_delete_connection` makes) against an
    /// injected `MockKeychain`, since the full command also touches the
    /// real product SQLite connections table with no test seam to redirect
    /// it — the row-deletion half of `broker_delete_connection` is already
    /// covered in-memory by `broker_store.rs`'s `deleting_a_connection_reports_gone`.
    ///
    /// NOTE: `active_adapter()`'s backing `OnceLock` is process-wide and can
    /// only be set once; this test is written assuming it is the sole
    /// caller of `set_adapter_for_tests` in this binary (true today — grep
    /// confirms no other test calls it). If a future test starts calling
    /// `active_adapter()`/`set_adapter_for_tests` first, this test would
    /// silently start running the SqliteKeychain adapter against the real
    /// product database instead of the mock.
    #[test]
    fn deleting_a_connection_removes_the_keychain_entry_not_just_empties_it() {
        crate::rest::keychain::set_adapter_for_tests(Box::new(crate::rest::keychain::MockKeychain::default()));
        let adapter = crate::rest::keychain::active_adapter();

        let handle = "conn:test-purge-secret";
        adapter.save(KEYCHAIN_SERVICE, handle, "s3cr3t").unwrap();
        assert_eq!(adapter.get(KEYCHAIN_SERVICE, handle).unwrap(), Some("s3cr3t".to_string()));

        purge_secret(Some(handle));

        assert_eq!(
            adapter.get(KEYCHAIN_SERVICE, handle).unwrap(),
            None,
            "the entry must be gone (None), not present-but-empty (Some(\"\"))"
        );
    }

    #[test]
    fn purging_a_connection_that_never_had_a_secret_is_a_no_op() {
        // No handle at all — must not panic or error.
        purge_secret(None);
    }
}
