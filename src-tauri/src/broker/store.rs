//! SQLite persistence for broker connections and topology snapshots.
//! Snapshots exist because Admin REST ignores pagination (spec V-A5): we fetch
//! the full list once, cache it, and page over the cache in Rust.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use rusqlite::{params, Connection, Row};

#[derive(Debug, Clone)]
pub struct ConnectionRow {
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
    pub capabilities_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn db_err(e: rusqlite::Error) -> BrokerError {
    BrokerError { code: BrokerErrorCode::SourceUnavailable, message: e.to_string(), retryable: false }
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<ConnectionRow> {
    Ok(ConnectionRow {
        id: r.get("id")?,
        kind: r.get("kind")?,
        name: r.get("name")?,
        color: r.get("color")?,
        admin_url: r.get("admin_url")?,
        broker_url: r.get("broker_url")?,
        auth_type: r.get("auth_type")?,
        secret_handle_id: r.get("secret_handle_id")?,
        default_tenant: r.get("default_tenant")?,
        default_namespace: r.get("default_namespace")?,
        read_only: r.get::<_, i64>("read_only")? != 0,
        tls_verify: r.get::<_, i64>("tls_verify")? != 0,
        timeout_ms: r.get("timeout_ms")?,
        last_status: r.get("last_status")?,
        last_checked_at: r.get("last_checked_at")?,
        broker_version: r.get("broker_version")?,
        capabilities_json: r.get("capabilities_json")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn upsert_connection(conn: &Connection, row: &ConnectionRow) -> Result<(), BrokerError> {
    conn.execute(
        "INSERT INTO broker_connections (
            id, kind, name, color, admin_url, broker_url, auth_type, secret_handle_id,
            default_tenant, default_namespace, read_only, tls_verify, timeout_ms,
            last_status, last_checked_at, broker_version, capabilities_json,
            created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, color=excluded.color, admin_url=excluded.admin_url,
            broker_url=excluded.broker_url, auth_type=excluded.auth_type,
            secret_handle_id=excluded.secret_handle_id,
            default_tenant=excluded.default_tenant, default_namespace=excluded.default_namespace,
            read_only=excluded.read_only, tls_verify=excluded.tls_verify,
            timeout_ms=excluded.timeout_ms, last_status=excluded.last_status,
            last_checked_at=excluded.last_checked_at, broker_version=excluded.broker_version,
            capabilities_json=excluded.capabilities_json, updated_at=excluded.updated_at",
        params![
            row.id, row.kind, row.name, row.color, row.admin_url, row.broker_url,
            row.auth_type, row.secret_handle_id, row.default_tenant, row.default_namespace,
            row.read_only as i64, row.tls_verify as i64, row.timeout_ms,
            row.last_status, row.last_checked_at, row.broker_version, row.capabilities_json,
            row.created_at, row.updated_at,
        ],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn list_connections(conn: &Connection) -> Result<Vec<ConnectionRow>, BrokerError> {
    let mut stmt = conn
        .prepare("SELECT * FROM broker_connections ORDER BY updated_at DESC")
        .map_err(db_err)?;
    let rows = stmt.query_map([], from_row).map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

pub fn get_connection(conn: &Connection, id: &str) -> Result<Option<ConnectionRow>, BrokerError> {
    let mut stmt = conn
        .prepare("SELECT * FROM broker_connections WHERE id = ?1")
        .map_err(db_err)?;
    let mut rows = stmt.query_map(params![id], from_row).map_err(db_err)?;
    match rows.next() {
        Some(r) => Ok(Some(r.map_err(db_err)?)),
        None => Ok(None),
    }
}

pub fn delete_connection(conn: &Connection, id: &str) -> Result<(), BrokerError> {
    conn.execute("DELETE FROM broker_topology_snapshots WHERE connection_id = ?1", params![id])
        .map_err(db_err)?;
    conn.execute("DELETE FROM broker_connections WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(db_err)
}

pub fn put_snapshot(
    conn: &Connection,
    connection_id: &str,
    scope: &str,
    scope_key: &str,
    payload_json: &str,
) -> Result<(), BrokerError> {
    let id = format!("{connection_id}:{scope}:{scope_key}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO broker_topology_snapshots (id, connection_id, scope, scope_key, payload_json, observed_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(connection_id, scope, scope_key) DO UPDATE SET
            payload_json = excluded.payload_json, observed_at = excluded.observed_at",
        params![id, connection_id, scope, scope_key, payload_json, now],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn get_snapshot(
    conn: &Connection,
    connection_id: &str,
    scope: &str,
    scope_key: &str,
) -> Result<Option<(String, i64)>, BrokerError> {
    let mut stmt = conn
        .prepare(
            "SELECT payload_json, observed_at FROM broker_topology_snapshots
             WHERE connection_id = ?1 AND scope = ?2 AND scope_key = ?3",
        )
        .map_err(db_err)?;
    let mut rows = stmt
        .query_map(params![connection_id, scope, scope_key], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db_err)?;
    match rows.next() {
        Some(r) => Ok(Some(r.map_err(db_err)?)),
        None => Ok(None),
    }
}
