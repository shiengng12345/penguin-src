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
/// Cargo's test harness runs these `#[tokio::test]`s concurrently on separate
/// threads, and macOS's clock resolution is coarser than true nanoseconds —
/// two threads starting within the same tick can read an identical
/// `SystemTime::now()` value. A monotonic counter, not the clock, is what
/// actually guarantees a distinct path per call.
static SCRATCH_DB_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn scratch_db_path() -> std::path::PathBuf {
    let n = SCRATCH_DB_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "penguin-broker-cache-test-{}-{}-{n}.sqlite3",
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

// --- Fix round 1 ---
//
// `refresh` must bypass the cache read, not destroy the cached row: deleting
// it first converts a recoverable broker failure into permanent data loss,
// for no benefit (`put_snapshot` is a genuine upsert, so a successful
// refetch already overwrites the row on its own). This test proves the row
// survives repeated failed refreshes so an operator sees the last known list
// through an entire flapping-broker episode, not just once.
#[tokio::test]
async fn two_consecutive_failed_refreshes_both_serve_the_cached_list() {
    let path = scratch_db_path();
    let seed = open_scratch(&path);
    // Points at a dead admin endpoint so every broker call fails fast and
    // deterministically, with no dependency on the live `pulsar` container.
    let row = store::ConnectionRow {
        id: "c-dead".into(),
        kind: "pulsar".into(),
        name: "Dead".into(),
        color: "red".into(),
        admin_url: "http://localhost:1".into(),
        broker_url: "pulsar://localhost:1".into(),
        auth_type: "none".into(),
        secret_handle_id: None,
        default_tenant: "public".into(),
        default_namespace: "default".into(),
        read_only: true,
        tls_verify: true,
        timeout_ms: 500,
        last_status: "unknown".into(),
        last_checked_at: None,
        broker_version: None,
        capabilities_json: None,
        created_at: 1,
        updated_at: 1,
    };
    store::upsert_connection(&seed, &row).unwrap();
    store::put_snapshot(
        &seed,
        &row.id,
        "topics",
        "public/default",
        r#"{"all":["persistent://public/default/t1"],"partitioned":[]}"#,
    )
    .unwrap();
    drop(seed);

    let query = all_topics_query();

    let first = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, true, None)
        .await
        .expect("a failed refresh must still return a result, not a hard error");
    assert_eq!(
        first.source,
        BrokerSource::Cache,
        "broker is unreachable; the first refresh must fall back to the cached list"
    );
    let first_names = names_of(&first.data.expect("first refresh should carry cached data").items);
    assert!(first_names.contains("persistent://public/default/t1"));
    assert!(!first.warnings.is_empty(), "a failed refresh must say why it fell back to the cache");

    let second = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, true, None)
        .await
        .expect("a second failed refresh must ALSO still return a result");
    assert_eq!(
        second.source,
        BrokerSource::Cache,
        "a second consecutive failed refresh must serve the cache again, not fail outright — \
         this is exactly what an operator needs while a broker is flapping"
    );
    let second_names = names_of(&second.data.expect("second refresh should carry cached data").items);
    assert_eq!(first_names, second_names, "the cached row must survive the first failed refresh unchanged");

    let _ = std::fs::remove_file(&path);
}

/// A cached entry that fails to deserialize is a poisoned row with no
/// antidote short of deleting it. This proves it self-heals: the corrupt
/// entry is discarded, a fresh broker read replaces it (with a warning
/// naming the discarded entry), and the very next call is served from that
/// newly-written, valid cache row.
#[tokio::test]
async fn a_corrupt_cache_entry_self_heals_from_the_broker() {
    if reqwest::get(format!("{ADMIN_URL}/admin/v2/persistent/public/default")).await.is_err() {
        eprintln!(
            "SKIPPING a_corrupt_cache_entry_self_heals_from_the_broker: broker at {ADMIN_URL} is unreachable"
        );
        return;
    }

    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-corrupt");
    let row = store::get_connection(&seed, "c-corrupt").unwrap().expect("seeded row");
    store::put_snapshot(&seed, &row.id, "topics", "public/default", "this is not json").unwrap();
    drop(seed);

    let query = all_topics_query();

    let first = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, false, None)
        .await
        .expect("a corrupt cache entry must self-heal, not hard-error forever");
    assert_eq!(
        first.source,
        BrokerSource::AdminRest,
        "the corrupt entry must be discarded and replaced with a fresh broker read"
    );
    let first_data = first.data.expect("the recovered call should carry data");
    assert_eq!(first_data.items.len(), EXPECTED_BUSINESS_TOPIC_COUNT);
    assert!(
        first
            .warnings
            .iter()
            .any(|w| w.to_lowercase().contains("unreadable") || w.to_lowercase().contains("discard")),
        "must name the discarded cache entry: {:?}",
        first.warnings
    );

    // Same reasoning as the earlier live test: guarantees the next call's
    // measured age is a real nonzero number, not a same-millisecond coincidence.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    let second = commands::list_topics_through_cache(open_scratch(&path), &row, "public", "default", &query, false, None)
        .await
        .expect("second call should succeed");
    assert_eq!(
        second.source,
        BrokerSource::Cache,
        "the self-healed entry must now be a valid, readable cache row"
    );
    assert!(second.freshness_ms > 0, "a real cache hit has a non-zero measured age");

    let _ = std::fs::remove_file(&path);
}
