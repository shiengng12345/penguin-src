use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn penguin_db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".penguin").join("penguin.sqlite3"))
}

fn open_product_db_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        -- Auto-truncate the WAL at checkpoint time. Without a limit it once
        -- grew to 4x the main DB (167MB vs 40MB) under checkpoint starvation.
        PRAGMA journal_size_limit = 67108864;
        CREATE TABLE IF NOT EXISTS app_kv (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS saved_requests (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            saved_at INTEGER NOT NULL,
            protocol TEXT NOT NULL,
            method_full_name TEXT NOT NULL,
            service_name TEXT NOT NULL,
            package_name TEXT NOT NULL,
            url TEXT NOT NULL,
            entry_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_saved_requests_saved_at
            ON saved_requests(saved_at DESC);
        CREATE TABLE IF NOT EXISTS request_history (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            protocol TEXT NOT NULL,
            method_full_name TEXT NOT NULL,
            service_name TEXT NOT NULL,
            package_name TEXT NOT NULL,
            url TEXT NOT NULL,
            entry_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_request_history_timestamp
            ON request_history(timestamp DESC);
        -- Sprint 10 Phase 10A — REST module 4 tables (DEC #196). parent_id
        -- on rest_collections is nullable to support future folder nesting
        -- without breaking the schema (UI doesn't expose folder add in MVP).
        CREATE TABLE IF NOT EXISTS rest_collections (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            env_id TEXT,
            parent_id TEXT,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rest_collections_project
            ON rest_collections(project_id);
        CREATE INDEX IF NOT EXISTS idx_rest_collections_parent
            ON rest_collections(parent_id);
        CREATE TABLE IF NOT EXISTS rest_requests (
            id TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL,
            name TEXT NOT NULL,
            method TEXT NOT NULL,
            url TEXT NOT NULL,
            headers_json TEXT NOT NULL,
            query_params_json TEXT NOT NULL,
            body_json TEXT,
            auth_json TEXT,
            timeout_ms INTEGER,
            follow_redirects INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rest_requests_collection
            ON rest_requests(collection_id);
        CREATE TABLE IF NOT EXISTS rest_env_vars (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT,
            is_secret INTEGER NOT NULL DEFAULT 0,
            secret_handle_id TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rest_env_vars_scope
            ON rest_env_vars(scope, scope_id);
        CREATE TABLE IF NOT EXISTS rest_cookies (
            id TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            name TEXT NOT NULL,
            value TEXT NOT NULL,
            path TEXT,
            expires_at INTEGER,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rest_cookies_collection
            ON rest_cookies(collection_id);
        -- Sprint 12 — unified FE+BE error log. Capped at ERROR_LOG_MAX_ROWS
        -- (see error_log.rs) with oldest-first trim on each insert. Columns:
        --   source:   'fe' | 'be'
        --   severity: 'error' | 'warn'
        --   scope:    'rest' | 'vault' | 'package-installer' | …  (nullable)
        --   details:  JSON string — stack trace, context object, etc.
        CREATE TABLE IF NOT EXISTS error_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            source TEXT NOT NULL,
            severity TEXT NOT NULL,
            scope TEXT,
            message TEXT NOT NULL,
            details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_error_log_timestamp
            ON error_log(timestamp DESC);
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn open_product_db() -> Result<Connection, String> {
    let path = penguin_db_path()?;
    open_product_db_at(&path)
}

// Re-exported for sibling modules (e.g. rest::cookie_store) that need a
// connection but don't want to re-implement the path / migration plumbing.
pub(crate) fn open_product_db_shared() -> Result<Connection, String> {
    open_product_db()
}

// One-shot WAL maintenance at app start: fold the WAL back into the main DB
// and truncate it. Best-effort — TRUNCATE needs no active readers, so a busy
// moment just means the next launch gets it.
pub(crate) fn checkpoint_product_db() {
    if let Ok(conn) = open_product_db() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

const SENSITIVE_APP_VALUE_PREFIXES: &[&str] = &["rest:secret:", "redis:secret:"];

fn is_sensitive_app_value_key(key: &str) -> bool {
    SENSITIVE_APP_VALUE_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

fn reject_sensitive_app_value_key(key: &str) -> Result<(), String> {
    if is_sensitive_app_value_key(key) {
        return Err("reserved app value key".to_string());
    }
    Ok(())
}

pub(crate) fn app_value_set_internal(key: String, value: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("app value key is required".to_string());
    }
    let conn = open_product_db()?;
    conn.execute(
        r#"
        INSERT INTO app_kv (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        "#,
        params![key, value, unix_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn app_value_get_internal(key: String) -> Result<Option<String>, String> {
    let conn = open_product_db()?;
    conn.query_row(
        "SELECT value FROM app_kv WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub(crate) fn app_value_delete_internal(key: String) -> Result<(), String> {
    let conn = open_product_db()?;
    conn.execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_set_app_value(key: String, value: String) -> Result<(), String> {
    reject_sensitive_app_value_key(&key)?;
    app_value_set_internal(key, value)
}

#[tauri::command]
pub(crate) fn db_get_app_value(key: String) -> Result<Option<String>, String> {
    reject_sensitive_app_value_key(&key)?;
    app_value_get_internal(key)
}

#[tauri::command]
pub(crate) fn db_list_app_values() -> Result<HashMap<String, String>, String> {
    let conn = open_product_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM app_kv \
             WHERE key NOT LIKE 'rest:secret:%' \
             AND key NOT LIKE 'redis:secret:%'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut values = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        values.insert(key, value);
    }
    Ok(values)
}

#[tauri::command]
pub(crate) fn db_delete_app_value(key: String) -> Result<(), String> {
    reject_sensitive_app_value_key(&key)?;
    app_value_delete_internal(key)
}

fn json_text(entry: &serde_json::Value, key: &str) -> String {
    entry
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

fn json_i64(entry: &serde_json::Value, key: &str) -> i64 {
    entry
        .get(key)
        .and_then(|value| value.as_i64())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn db_upsert_saved_request(entry: serde_json::Value) -> Result<(), String> {
    let id = json_text(&entry, "id");
    if id.trim().is_empty() {
        return Err("saved request id is required".to_string());
    }

    let conn = open_product_db()?;
    let entry_json = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    conn.execute(
        r#"
        INSERT INTO saved_requests (
            id, name, saved_at, protocol, method_full_name,
            service_name, package_name, url, entry_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            saved_at = excluded.saved_at,
            protocol = excluded.protocol,
            method_full_name = excluded.method_full_name,
            service_name = excluded.service_name,
            package_name = excluded.package_name,
            url = excluded.url,
            entry_json = excluded.entry_json
        "#,
        params![
            id,
            json_text(&entry, "name"),
            json_i64(&entry, "savedAt"),
            json_text(&entry, "protocol"),
            json_text(&entry, "methodFullName"),
            json_text(&entry, "serviceName"),
            json_text(&entry, "packageName"),
            json_text(&entry, "url"),
            entry_json,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_list_saved_requests() -> Result<Vec<serde_json::Value>, String> {
    let conn = open_product_db()?;
    let mut stmt = conn
        .prepare("SELECT entry_json FROM saved_requests ORDER BY saved_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let raw = row.map_err(|e| e.to_string())?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            entries.push(value);
        }
    }
    Ok(entries)
}

#[tauri::command]
pub(crate) fn db_delete_saved_request(id: String) -> Result<(), String> {
    let conn = open_product_db()?;
    conn.execute("DELETE FROM saved_requests WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_rename_saved_request(id: String, name: String) -> Result<(), String> {
    let conn = open_product_db()?;
    let raw: String = conn
        .query_row(
            "SELECT entry_json FROM saved_requests WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut entry: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("name".to_string(), serde_json::Value::String(name.clone()));
    }
    let entry_json = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE saved_requests SET name = ?1, entry_json = ?2 WHERE id = ?3",
        params![name, entry_json, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// History lives in its own table (one row per request, full response JSON in
// entry_json) instead of a single app_kv blob, so the frontend can page and
// search without hydrating the entire archive at boot.
fn put_history_entry_at(
    conn: &Connection,
    entry: &serde_json::Value,
    max_size: i64,
) -> Result<(), String> {
    let id = json_text(entry, "id");
    if id.trim().is_empty() {
        return Err("history entry id is required".to_string());
    }
    let entry_json = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    conn.execute(
        r#"
        INSERT INTO request_history (
            id, timestamp, protocol, method_full_name,
            service_name, package_name, url, entry_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            timestamp = excluded.timestamp,
            protocol = excluded.protocol,
            method_full_name = excluded.method_full_name,
            service_name = excluded.service_name,
            package_name = excluded.package_name,
            url = excluded.url,
            entry_json = excluded.entry_json
        "#,
        params![
            id,
            json_i64(entry, "timestamp"),
            json_text(entry, "protocol"),
            json_text(entry, "methodFullName"),
            json_text(entry, "serviceName"),
            json_text(entry, "packageName"),
            json_text(entry, "url"),
            entry_json,
        ],
    )
    .map_err(|e| e.to_string())?;

    if max_size > 0 {
        conn.execute(
            r#"
            DELETE FROM request_history WHERE id NOT IN (
                SELECT id FROM request_history ORDER BY timestamp DESC LIMIT ?1
            )
            "#,
            params![max_size],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn db_put_history_entry(entry: serde_json::Value, max_size: i64) -> Result<(), String> {
    let conn = open_product_db()?;
    put_history_entry_at(&conn, &entry, max_size)
}

fn history_like_pattern(query: &str) -> String {
    format!("%{}%", query.trim().to_lowercase())
}

#[tauri::command]
pub(crate) fn db_list_history(
    limit: i64,
    offset: i64,
    query: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_product_db()?;
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);

    let mut entries = Vec::new();
    let mut push_row = |raw: String| {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            entries.push(value);
        }
    };

    match query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let pattern = history_like_pattern(q);
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT entry_json FROM request_history
                    WHERE lower(method_full_name) LIKE ?1
                       OR lower(service_name) LIKE ?1
                       OR lower(package_name) LIKE ?1
                       OR lower(url) LIKE ?1
                    ORDER BY timestamp DESC LIMIT ?2 OFFSET ?3
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![pattern, limit, offset], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                push_row(row.map_err(|e| e.to_string())?);
            }
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT entry_json FROM request_history ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit, offset], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows {
                push_row(row.map_err(|e| e.to_string())?);
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub(crate) fn db_count_history() -> Result<i64, String> {
    let conn = open_product_db()?;
    conn.query_row("SELECT COUNT(*) FROM request_history", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_clear_history() -> Result<(), String> {
    let conn = open_product_db()?;
    conn.execute("DELETE FROM request_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// --- Error log ---
//
// Unified FE + BE error sink. Capped at ERROR_LOG_MAX_ROWS; oldest rows
// dropped on every insert. The frontend hits db_list_error_log on
// dialog open and slices in-memory (1k rows is ~1MB worst-case JSON).

const ERROR_LOG_MAX_ROWS: i64 = 1000;

fn insert_error_log_at(
    conn: &Connection,
    timestamp: i64,
    source: &str,
    severity: &str,
    scope: Option<&str>,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO error_log (timestamp, source, severity, scope, message, details)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![timestamp, source, severity, scope, message, details],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        r#"
        DELETE FROM error_log WHERE id NOT IN (
            SELECT id FROM error_log ORDER BY timestamp DESC LIMIT ?1
        )
        "#,
        params![ERROR_LOG_MAX_ROWS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Frontend-facing command. Source typically "fe" but we accept any
/// short string so Rust callers can route through the same SQL path.
#[tauri::command]
pub(crate) fn db_record_error_log(
    source: String,
    severity: String,
    scope: Option<String>,
    message: String,
    details: Option<String>,
) -> Result<(), String> {
    if source.trim().is_empty() || message.trim().is_empty() {
        return Err("source and message are required".to_string());
    }
    let conn = open_product_db()?;
    insert_error_log_at(
        &conn,
        unix_millis(),
        &source,
        &severity,
        scope.as_deref(),
        &message,
        details.as_deref(),
    )
}

/// Rust-side shortcut so internal failure points can record without
/// going through the IPC layer. Errors here are swallowed — logging
/// must never tank the caller.
pub(crate) fn record_be_error_log(
    severity: &str,
    scope: &str,
    message: &str,
    details: Option<&str>,
) {
    if let Ok(conn) = open_product_db() {
        let _ = insert_error_log_at(
            &conn,
            unix_millis(),
            "be",
            severity,
            Some(scope),
            message,
            details,
        );
    }
}

#[tauri::command]
pub(crate) fn db_list_error_log() -> Result<Vec<serde_json::Value>, String> {
    let conn = open_product_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, source, severity, scope, message, details \
             FROM error_log ORDER BY timestamp DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![ERROR_LOG_MAX_ROWS], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, i64>(1)?,
                "source": row.get::<_, String>(2)?,
                "severity": row.get::<_, String>(3)?,
                "scope": row.get::<_, Option<String>>(4)?,
                "message": row.get::<_, String>(5)?,
                "details": row.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

#[tauri::command]
pub(crate) fn db_count_error_log_since(since: i64) -> Result<i64, String> {
    let conn = open_product_db()?;
    conn.query_row(
        "SELECT COUNT(*) FROM error_log WHERE timestamp > ?1",
        params![since],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_clear_error_log() -> Result<(), String> {
    let conn = open_product_db()?;
    conn.execute("DELETE FROM error_log", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod product_db_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("penguin-db-{name}-{nonce}"))
            .join("penguin.sqlite3")
    }

    #[test]
    fn history_rows_round_trip_with_response_and_trim() {
        let path = temp_db_path("history");
        let conn = open_product_db_at(&path).unwrap();

        for i in 0..5 {
            let entry = serde_json::json!({
                "id": format!("hist_{i}"),
                "timestamp": i * 10,
                "protocol": "grpc",
                "methodFullName": format!("pkg.Svc.Method{i}"),
                "serviceName": "Svc",
                "packageName": "@snsoft/pkg",
                "url": "http://localhost:5006",
                "requestBody": "{}",
                "response": { "status": "OK", "statusCode": 200, "body": "{\"x\":1}" },
            });
            put_history_entry_at(&conn, &entry, 3).unwrap();
        }

        // Trimmed to max_size=3, newest first.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM request_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);

        let newest: String = conn
            .query_row(
                "SELECT entry_json FROM request_history ORDER BY timestamp DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&newest).unwrap();
        assert_eq!(parsed["id"], "hist_4");
        // Full response archived with the row.
        assert_eq!(parsed["response"]["statusCode"], 200);

        // Upsert by id replaces instead of duplicating.
        let updated = serde_json::json!({
            "id": "hist_4",
            "timestamp": 40,
            "protocol": "grpc",
            "methodFullName": "pkg.Svc.Method4",
            "serviceName": "Svc",
            "packageName": "@snsoft/pkg",
            "url": "http://localhost:5006",
            "response": { "status": "ERROR", "statusCode": 500 },
        });
        put_history_entry_at(&conn, &updated, 3).unwrap();
        let count_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM request_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after, 3);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn product_db_schema_can_store_app_values() {
        let path = temp_db_path("kv");
        let conn = open_product_db_at(&path).unwrap();
        conn.execute(
            r#"
            INSERT INTO app_kv (key, value, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
            params!["penguin-theme", "dark", 10_i64],
        )
        .unwrap();

        let value: String = conn
            .query_row(
                "SELECT value FROM app_kv WHERE key = ?1",
                params!["penguin-theme"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "dark");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn app_kv_sensitive_prefix_guard_covers_rest_and_redis_secrets() {
        assert!(is_sensitive_app_value_key("rest:secret:penguin-rest::req-1"));
        assert!(is_sensitive_app_value_key("redis:secret:redis-123"));
        assert!(!is_sensitive_app_value_key("penguin-theme"));
        assert!(reject_sensitive_app_value_key("rest:secret:x").is_err());
        assert!(reject_sensitive_app_value_key("redis:secret:x").is_err());
        assert!(reject_sensitive_app_value_key("penguin-history").is_ok());
    }

    #[test]
    fn product_db_schema_can_store_saved_requests() {
        let path = temp_db_path("saved");
        let conn = open_product_db_at(&path).unwrap();
        conn.execute(
            r#"
            INSERT INTO saved_requests (
                id, name, saved_at, protocol, method_full_name,
                service_name, package_name, url, entry_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                "saved_1",
                "Auth.login",
                10_i64,
                "grpc-web",
                "Auth.login",
                "Auth",
                "@snsoft/auth-grpc-web",
                "{{URL}}",
                r#"{"id":"saved_1","name":"Auth.login","savedAt":10}"#,
            ],
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM saved_requests", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
