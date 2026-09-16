//! Cache behaviour against an in-memory SQLite. No broker needed for the
//! first four tests; the final test is a live integration test against the
//! `pulsar` container on localhost:8080 (guarded to skip if unreachable).
use penguin_lib::broker::cache::{assess, CacheScope, Freshness};
use penguin_lib::broker::store;

fn memory_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    penguin_lib::db::apply_schema(&conn).expect("schema applies");
    conn
}

fn seed_connection(conn: &rusqlite::Connection, id: &str) {
    let row = store::ConnectionRow {
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
    };
    store::upsert_connection(conn, &row).unwrap();
}

#[test]
fn a_stored_snapshot_reads_back_with_its_observed_time() {
    let conn = memory_db();
    seed_connection(&conn, "c1");
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a","b"]"#).unwrap();

    let (payload, observed_at) = store::get_snapshot(&conn, "c1", "topics", "public/default")
        .unwrap()
        .expect("snapshot present");
    assert_eq!(payload, r#"["a","b"]"#);
    assert!(observed_at > 0, "observed_at must be a real epoch-ms value");
}

#[test]
fn deleting_a_snapshot_makes_the_next_assessment_absent() {
    // This is what an explicit refresh does: drop the row so the next read
    // has to go to the broker.
    let conn = memory_db();
    seed_connection(&conn, "c1");
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a"]"#).unwrap();
    store::delete_snapshot(&conn, "c1", "topics", "public/default").unwrap();

    let got = store::get_snapshot(&conn, "c1", "topics", "public/default").unwrap();
    assert!(got.is_none());
    assert_eq!(assess(CacheScope::Topics, None, 0), Freshness::Absent);
}

#[test]
fn deleting_a_snapshot_that_does_not_exist_is_not_an_error() {
    // Refreshing a view that was never cached is normal, not a failure.
    let conn = memory_db();
    seed_connection(&conn, "c1");
    assert!(store::delete_snapshot(&conn, "c1", "topics", "public/default").is_ok());
}

#[test]
fn deleting_a_connection_removes_its_snapshots() {
    // Already true in Phase 0, pinned here because the cache now depends on it.
    let conn = memory_db();
    seed_connection(&conn, "c1");
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a"]"#).unwrap();
    store::delete_connection(&conn, "c1").unwrap();
    assert!(store::get_snapshot(&conn, "c1", "topics", "public/default").unwrap().is_none());
}

// --- Step 6: live integration against the `pulsar` container. ---
//
// Exercises `commands::list_topics_through_cache` (the logic behind the
// `broker_list_topics` Tauri command) directly, against a scratch SQLite
// file instead of the real product DB — same reason `broker_store.rs` and
// this file's tests above use an isolated database: the command's cache
// reads/writes are real SQLite operations, and there is no need to touch
// `~/.penguin/penguin.sqlite3` to prove they work. A file (not `:memory:`)
// is used here specifically because `list_topics_through_cache` takes its
// `Connection` by value (see that function's doc comment for why) and this
// test must open it three times while still sharing the same underlying
// database state across all three — a fresh `:memory:` database would be
// empty on every open. The broker calls inside it are real, against the
// live `pulsar` container.
use penguin_lib::broker::commands;
use penguin_lib::broker::envelope::BrokerSource;
use penguin_lib::broker::topic_folding::{PageQueryDto, TopicSummaryDto};
use std::collections::HashSet;

const ADMIN_URL: &str = "http://localhost:8080";

/// This broker is documented (see `tests/broker_topic_list.rs`) to hold
/// exactly 10 pre-existing business topics, confirmed via
/// `curl -s http://localhost:8080/admin/v2/persistent/public/default`
/// immediately before this test file was written. If this ever needs to
/// change, it means the business data changed, not this test's expectations.
const EXPECTED_BUSINESS_TOPIC_COUNT: usize = 10;

fn all_topics_query() -> PageQueryDto {
    PageQueryDto { offset: 0, limit: 100, search: None, sort_by: None, sort_dir: None }
}

/// A scratch on-disk SQLite file, unique to this test process, so repeated
/// `Connection::open` calls see the same state while still never touching
/// the real product database.
fn scratch_db_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "penguin-broker-cache-test-{}-{}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ))
}

fn open_scratch(path: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).expect("open scratch db");
    penguin_lib::db::apply_schema(&conn).expect("schema applies");
    conn
}

fn names_of(items: &[TopicSummaryDto]) -> HashSet<String> {
    items.iter().map(|t| t.full_name.clone()).collect()
}

#[tokio::test]
async fn topic_listing_reads_through_the_cache_against_the_live_broker() {
    if reqwest::get(format!("{ADMIN_URL}/admin/v2/persistent/public/default")).await.is_err() {
        eprintln!(
            "SKIPPING topic_listing_reads_through_the_cache_against_the_live_broker: \
             broker at {ADMIN_URL} is unreachable"
        );
        return;
    }

    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-live");
    let row = store::get_connection(&seed, "c-live").unwrap().expect("seeded row");
    drop(seed);
    let query = all_topics_query();

    // --- Call 1: nothing cached yet -> must read from the broker. ---
    let first = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, false, None)
        .await
        .expect("first call should succeed");
    assert_eq!(first.source, BrokerSource::AdminRest, "nothing was cached; must read from the broker");
    let first_data = first.data.expect("first call should return data");
    assert_eq!(
        first_data.items.len(),
        EXPECTED_BUSINESS_TOPIC_COUNT,
        "unexpected topic count on first call: {:?}",
        first_data.items.iter().map(|t| &t.full_name).collect::<Vec<_>>()
    );

    // --- Call 2: same view, no refresh -> must be served from the cache. ---
    // A short sleep guarantees `freshness_ms` (millisecond-resolution) is
    // measurably nonzero — without it, two localhost round trips can
    // occasionally land in the same millisecond tick and flake this
    // assertion for a reason that has nothing to do with cache correctness.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let second = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, false, None)
        .await
        .expect("second call should succeed");
    assert_eq!(
        second.source,
        BrokerSource::Cache,
        "an immediate second read must be served from the cache, not the broker"
    );
    assert!(
        second.freshness_ms > 0,
        "a real cache hit has a non-zero measured age; got {}",
        second.freshness_ms
    );
    let second_data = second.data.expect("second call should return data");
    assert_eq!(second_data.items.len(), EXPECTED_BUSINESS_TOPIC_COUNT);

    // --- Call 3: refresh:true bypasses the cache -> back to the broker. ---
    let third = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, true, None)
        .await
        .expect("refresh call should succeed");
    assert_eq!(
        third.source,
        BrokerSource::AdminRest,
        "refresh:true must bypass the cache and hit the broker again"
    );
    let third_data = third.data.expect("third call should return data");
    assert_eq!(third_data.items.len(), EXPECTED_BUSINESS_TOPIC_COUNT);

    // --- All three calls describe the same 10 business topics. ---
    let names1 = names_of(&first_data.items);
    let names2 = names_of(&second_data.items);
    let names3 = names_of(&third_data.items);
    assert_eq!(names1, names2, "cached call must return the same topics as the broker call");
    assert_eq!(names1, names3, "refreshed call must return the same topics as the original");

    let _ = std::fs::remove_file(&path);
}
