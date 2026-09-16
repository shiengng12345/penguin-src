//! Live test against the unauthenticated broker on localhost:8080.
use penguin_lib::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use penguin_lib::broker::ports::BrokerAdmin;

const ADMIN: &str = "http://localhost:8080";

fn adapter() -> PulsarAdminRest {
    PulsarAdminRest::new(ADMIN.to_string(), 10_000, true, None).expect("adapter builds")
}

#[tokio::test]
async fn lists_the_brokers_real_tenants() {
    let tenants = adapter().list_tenants().await.expect("tenants");
    assert!(tenants.contains(&"public".to_string()), "got {tenants:?}");
    assert!(tenants.contains(&"pulsar".to_string()), "got {tenants:?}");
}

#[tokio::test]
async fn namespaces_come_back_fully_qualified() {
    // Pulsar returns "public/default", not "default" — a caller that assumes
    // the bare name will build a wrong topic path.
    let namespaces = adapter().list_namespaces("public").await.expect("namespaces");
    assert!(
        namespaces.iter().any(|n| n == "public/default"),
        "expected a fully-qualified name, got {namespaces:?}"
    );
    assert!(
        !namespaces.iter().any(|n| n == "default"),
        "bare names would mean the split logic is wrong"
    );
}

#[tokio::test]
async fn an_unknown_tenant_is_not_found_rather_than_an_empty_list() {
    // A typo must be distinguishable from a tenant that genuinely has no
    // namespaces — an empty list would hide the mistake.
    let err = adapter()
        .list_namespaces("no-such-tenant-broker-probe")
        .await
        .expect_err("unknown tenant must error");
    assert_eq!(err.code, penguin_lib::broker::envelope::BrokerErrorCode::NotFound);
}

// --- Command-layer tests: broker_list_tenants / broker_list_namespaces ---
//
// Exercise `commands::list_tenants_through_cache` /
// `commands::list_namespaces_through_cache` directly, the same way
// `tests/broker_cache.rs` exercises `list_topics_through_cache` — against a
// scratch on-disk SQLite file (not `:memory:`, since these functions take
// their `Connection` by value and this file reopens it between calls while
// needing the same underlying state; see that file's `scratch_db_path` doc
// comment for why `:memory:` would not work here) instead of the real
// product DB, with real network calls against the live `pulsar` container.
use penguin_lib::broker::commands;
use penguin_lib::broker::envelope::BrokerSource;
use penguin_lib::broker::store;

fn seed_connection(conn: &rusqlite::Connection, id: &str) {
    let row = store::ConnectionRow {
        id: id.into(),
        kind: "pulsar".into(),
        name: "Local".into(),
        color: "green".into(),
        admin_url: ADMIN.to_string(),
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

static SCRATCH_DB_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn scratch_db_path() -> std::path::PathBuf {
    let n = SCRATCH_DB_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "penguin-broker-topology-test-{}-{}-{n}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ))
}

fn open_scratch(path: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).expect("open scratch db");
    penguin_lib::db::apply_schema(&conn).expect("schema applies");
    conn
}

#[tokio::test]
async fn tenants_second_read_is_a_real_cache_hit() {
    if reqwest::get(format!("{ADMIN}/admin/v2/tenants")).await.is_err() {
        eprintln!("SKIPPING tenants_second_read_is_a_real_cache_hit: broker at {ADMIN} is unreachable");
        return;
    }

    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-tenants");
    let row = store::get_connection(&seed, "c-tenants").unwrap().expect("seeded row");
    drop(seed);

    // Call 1: nothing cached -> must read from the broker.
    let first = commands::list_tenants_through_cache(open_scratch(&path), &row, false, None)
        .await
        .expect("first call should succeed");
    assert_eq!(first.source, BrokerSource::AdminRest, "nothing was cached; must read from the broker");
    let names: Vec<String> = first.data.expect("data").into_iter().map(|t| t.name).collect();
    assert!(names.contains(&"public".to_string()), "got {names:?}");

    // Call 2: no refresh -> must be a genuine cache hit. `source ==
    // BrokerSource::Cache` is something only the cache path can produce —
    // the broker adapter itself never constructs that variant — so this is
    // real proof of a cache hit, not just "the same data came back".
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let second = commands::list_tenants_through_cache(open_scratch(&path), &row, false, None)
        .await
        .expect("second call should succeed");
    assert_eq!(second.source, BrokerSource::Cache, "an immediate second read must be served from the cache");
    assert!(second.freshness_ms > 0, "a real cache hit has a non-zero measured age; got {}", second.freshness_ms);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn namespaces_second_read_is_a_real_cache_hit_and_splits_tenant_and_name() {
    if reqwest::get(format!("{ADMIN}/admin/v2/namespaces/public")).await.is_err() {
        eprintln!(
            "SKIPPING namespaces_second_read_is_a_real_cache_hit_and_splits_tenant_and_name: \
             broker at {ADMIN} is unreachable"
        );
        return;
    }

    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-namespaces");
    let row = store::get_connection(&seed, "c-namespaces").unwrap().expect("seeded row");
    drop(seed);

    let first = commands::list_namespaces_through_cache(open_scratch(&path), &row, "public", false, None)
        .await
        .expect("first call should succeed");
    assert_eq!(first.source, BrokerSource::AdminRest);
    let data = first.data.expect("data");
    let default_ns = data.iter().find(|n| n.full == "public/default").expect("public/default present");
    assert_eq!(default_ns.tenant, "public");
    assert_eq!(default_ns.name, "default");

    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let second = commands::list_namespaces_through_cache(open_scratch(&path), &row, "public", false, None)
        .await
        .expect("second call should succeed");
    assert_eq!(second.source, BrokerSource::Cache, "an immediate second read must be served from the cache");
    assert!(second.freshness_ms > 0, "a real cache hit has a non-zero measured age; got {}", second.freshness_ms);

    let _ = std::fs::remove_file(&path);
}

/// The four `Freshness` arms must reduce through one shared recovery body,
/// same ruling as `list_topics_through_cache`. `Skewed` gets its own named
/// arm — never folded into a catch-all with `Fresh` — and is served WITH a
/// warning naming the skew rather than a fabricated age.
#[tokio::test]
async fn a_skewed_tenant_snapshot_is_served_with_a_warning_naming_the_skew_not_a_misleading_age() {
    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-skewed-tenants");
    let row = store::get_connection(&seed, "c-skewed-tenants").unwrap().expect("seeded row");
    store::put_snapshot(&seed, &row.id, "tenants", "*", r#"["public","pulsar"]"#).unwrap();
    let observed_at = epoch_ms() + 5_000; // stamped 5s ahead of "now"
    seed.execute(
        "UPDATE broker_topology_snapshots SET observed_at = ?1 WHERE connection_id = ?2 AND scope = ?3 AND scope_key = ?4",
        rusqlite::params![observed_at, row.id, "tenants", "*"],
    )
    .unwrap();
    drop(seed);

    let result = commands::list_tenants_through_cache(open_scratch(&path), &row, false, None)
        .await
        .expect("a skewed cache read must still succeed");

    assert_eq!(result.source, BrokerSource::Cache, "skewed data is still served from the cache");
    assert_eq!(
        result.freshness_ms, 0,
        "age is genuinely unknowable when the row is stamped ahead of the clock — must not report a fabricated age"
    );
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.to_lowercase().contains("ahead") || w.to_lowercase().contains("clock")),
        "must name the skew, not report a misleading age: {:?}",
        result.warnings
    );
    let names: Vec<String> = result.data.expect("skewed data must still be served").into_iter().map(|t| t.name).collect();
    assert!(names.contains(&"public".to_string()));

    let _ = std::fs::remove_file(&path);
}

/// The one thing about `Stale` that is genuinely scope-specific after the
/// cache-read policy was unified into a single generic: the TTL. Tenants get
/// 300s, topics get 60s. Re-asserting the shared `Stale` arm per scope would
/// re-test the same lines `broker_cache.rs` already covers — but nothing
/// proves the tenants command is wired to the *tenants* TTL, and a
/// copy-pasted `CacheScope::Topics` there would be invisible: a 2-minute-old
/// tenant list would silently start reporting itself as stale, and a screen
/// an operator trusts would carry a warning it did not earn.
#[tokio::test]
async fn a_two_minute_old_tenant_snapshot_is_still_fresh_because_tenants_use_the_longer_ttl() {
    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-tenant-ttl");
    let row = store::get_connection(&seed, "c-tenant-ttl").unwrap().expect("seeded row");
    store::put_snapshot(&seed, &row.id, "tenants", "*", r#"["public","pulsar"]"#).unwrap();
    // 120s old: past the 60s Topics TTL, well inside the 300s Tenants TTL.
    let observed_at = epoch_ms() - 120_000;
    seed.execute(
        "UPDATE broker_topology_snapshots SET observed_at = ?1 WHERE connection_id = ?2 AND scope = ?3 AND scope_key = ?4",
        rusqlite::params![observed_at, row.id, "tenants", "*"],
    )
    .unwrap();
    drop(seed);

    let result = commands::list_tenants_through_cache(open_scratch(&path), &row, false, None)
        .await
        .expect("a cached tenant read must succeed");

    assert_eq!(result.source, BrokerSource::Cache, "must be served from the cache, not refetched");
    assert!(
        result.warnings.is_empty(),
        "120s is inside the 300s tenants TTL, so this is Fresh — a staleness warning here would be unearned: {:?}",
        result.warnings
    );
    assert!(
        result.freshness_ms >= 120_000 && result.freshness_ms < 125_000,
        "must report the real measured age, not a fabricated one: {}",
        result.freshness_ms
    );

    let _ = std::fs::remove_file(&path);
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

/// A namespace string arriving without a "/" must not panic and must not be
/// silently dropped — it becomes `name` with an empty `tenant`, plus a
/// warning.
#[tokio::test]
async fn a_namespace_without_a_slash_becomes_a_bare_name_with_a_warning_not_a_panic() {
    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-bare-ns");
    let row = store::get_connection(&seed, "c-bare-ns").unwrap().expect("seeded row");
    store::put_snapshot(&seed, &row.id, "namespaces", "weird-tenant", r#"["no-slash-here"]"#).unwrap();
    drop(seed);

    let result = commands::list_namespaces_through_cache(open_scratch(&path), &row, "weird-tenant", false, None)
        .await
        .expect("must not panic or hard-error on a malformed cached entry");
    assert_eq!(result.source, BrokerSource::Cache);
    let data = result.data.expect("data");
    let entry = data.iter().find(|n| n.full == "no-slash-here").expect("entry present");
    assert_eq!(entry.tenant, "");
    assert_eq!(entry.name, "no-slash-here");
    assert!(
        result.warnings.iter().any(|w| w.contains("no-slash-here")),
        "must warn about the malformed entry: {:?}",
        result.warnings
    );

    let _ = std::fs::remove_file(&path);
}
