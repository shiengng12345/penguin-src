//! Store tests run against an in-memory SQLite so they never touch the user's DB.
use penguin_lib::broker::store::{self, ConnectionRow};

fn memory_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    penguin_lib::db::apply_schema(&conn).expect("schema applies to a fresh database");
    conn
}

fn row(id: &str) -> ConnectionRow {
    ConnectionRow {
        id: id.into(),
        kind: "pulsar".into(),
        name: "Local".into(),
        color: "green".into(),
        admin_url: "http://localhost:8080".into(),
        broker_url: "pulsar://localhost:6650".into(),
        auth_type: "none".into(),
        secret_handle_id: None,
        default_tenant: "public".into(),
        default_namespace: "default".into(),
        read_only: true,
        tls_verify: true,
        timeout_ms: 10_000,
        last_status: "unknown".into(),
        last_checked_at: None,
        broker_version: None,
        capabilities_json: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn schema_is_idempotent() {
    let conn = memory_db();
    penguin_lib::db::apply_schema(&conn).expect("applying twice must not fail");
}

#[test]
fn upsert_then_read_back() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    let got = store::get_connection(&conn, "c1").unwrap().expect("row exists");
    assert_eq!(got.name, "Local");
    assert!(got.read_only, "read_only defaults to true and survives a round trip");
}

#[test]
fn upsert_replaces_rather_than_duplicating() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    let mut updated = row("c1");
    updated.name = "Renamed".into();
    store::upsert_connection(&conn, &updated).unwrap();

    let all = store::list_connections(&conn).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "Renamed");
}

#[test]
fn no_column_can_hold_a_plaintext_secret() {
    // Guarantee 1: the table has no place to put a token even by accident.
    let conn = memory_db();
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('broker_connections')").unwrap();
    let cols: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    for banned in ["token", "password", "secret", "credential"] {
        assert!(
            !cols.iter().any(|c| c == banned),
            "broker_connections must not have a `{banned}` column"
        );
    }
    assert!(cols.iter().any(|c| c == "secret_handle_id"), "only a keychain reference is stored");
}

#[test]
fn snapshots_are_unique_per_scope_and_overwrite() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a"]"#).unwrap();
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a","b"]"#).unwrap();

    let (payload, _observed) = store::get_snapshot(&conn, "c1", "topics", "public/default").unwrap().unwrap();
    assert_eq!(payload, r#"["a","b"]"#, "a second write replaces rather than duplicating");
}

#[test]
fn deleting_a_connection_reports_gone() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    store::delete_connection(&conn, "c1").unwrap();
    assert!(store::get_connection(&conn, "c1").unwrap().is_none());
}
