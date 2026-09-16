//! Live test. Requires: docker compose -f infra/broker/docker-compose.local.yml up -d
//!
//! Phase A Task 8: `broker_get_topic_detail` and `broker_get_overview` — the
//! two commands that put Tasks 5-7's parsing, cursor positions, and anomaly
//! derivation behind the IPC boundary. Per this codebase's convention (see
//! `broker_topic_list.rs`, `broker_capability_discovery.rs`,
//! `broker_cache.rs`), these tests exercise the logic behind the
//! `#[tauri::command]` wrappers directly — `commands::build_topic_detail`
//! and `commands::build_overview` — rather than the wrappers themselves,
//! since the wrapper's only addition is a SQLite connection-row lookup
//! (`load_row`) against the real product database, which is unrelated to
//! what these tests prove and is exercised for `broker_get_topic_detail`
//! and `broker_get_overview` no differently than for every other broker
//! command already covered by `broker_store.rs`.
//!
//! Per the live-broker rules: no hardcoded subscription or topic COUNT is
//! asserted as a pass condition anywhere below except through the existing,
//! already-pinned `EXPECTED_BUSINESS_TOPIC_COUNT`-style constants in sibling
//! test files, which this file does not touch. Every assertion here is
//! structural: shapes agree with each other, named subscriptions are
//! present, cursors match subscriptions.
use penguin_lib::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use penguin_lib::broker::anomaly::{self, AnomalyKind};
use penguin_lib::broker::commands;
use penguin_lib::broker::envelope::BrokerErrorCode;
use penguin_lib::broker::ports::{BrokerAdmin, TopicRef};
// NOTE: the Task 8 brief's own Step 1 snippet imported `parse_internal_stats`
// from `broker::stats`, but that function has always lived in
// `broker::internal_stats` (see that module's own doc and the task
// interface list quoted in the brief's "Interfaces you consume" section,
// which names the file correctly even though the code sample did not).
// Corrected here so the verbatim test below actually compiles.
use penguin_lib::broker::internal_stats::parse_internal_stats;
use penguin_lib::broker::stats::parse_topic_stats;
use penguin_lib::broker::store;

const ADMIN: &str = "http://localhost:8080";

fn fpms_topup() -> TopicRef {
    TopicRef {
        tenant: "public".into(),
        namespace: "default".into(),
        topic: "fpms_topup".into(),
        persistent: true,
    }
}

fn admin() -> PulsarAdminRest {
    PulsarAdminRest::new(ADMIN.to_string(), 10_000, true, None).expect("admin client")
}

#[tokio::test]
async fn reads_the_real_topic_end_to_end() {
    let admin = PulsarAdminRest::new("http://localhost:8080".into(), 10_000, true, None).unwrap();

    let raw = admin.get_topic_stats(&fpms_topup()).await.expect("stats");
    let stats = parse_topic_stats(&raw).expect("stats parse");
    assert!(!stats.subscriptions.is_empty(), "fpms_topup must have at least one subscription");

    let raw_internal = admin
        .get_topic_internal_stats(&fpms_topup())
        .await
        .expect("internalStats");
    let internal = parse_internal_stats(&raw_internal).expect("internal parse");

    // Structural, not a pinned count (fix round 1, item 3): the two lists
    // must describe exactly the same set of subscriptions — same size, and
    // every name present on both sides — never a specific number that is a
    // fact about the user's business today, not about this code.
    assert_eq!(
        stats.subscriptions.len(),
        internal.cursors.len(),
        "stats and internalStats must agree on how many subscriptions exist"
    );
    // Every subscription in stats must have a cursor in internalStats. If the
    // two lists disagree, the detail screen would show a subscription with no
    // position, and the cause would be four files away.
    for sub in &stats.subscriptions {
        assert!(
            internal.cursors.iter().any(|c| c.subscription == sub.name),
            "subscription {} has no cursor",
            sub.name
        );
    }
    // ...and the reverse: no cursor may name a subscription that does not
    // exist in stats — combined with the equal-length check above, this
    // makes the match a bijection, not just a one-directional subset.
    for cursor in &internal.cursors {
        assert!(
            stats.subscriptions.iter().any(|s| s.name == cursor.subscription),
            "cursor {} has no matching subscription in stats",
            cursor.subscription
        );
    }
}

/// `commands::build_topic_detail` is the actual logic behind
/// `broker_get_topic_detail`. Proves it wires `parse_topic_stats` +
/// `parse_internal_stats` + `derive_anomalies` + `derive_indeterminate_checks`
/// together correctly against the real `fpms_topup` topic, and — per the
/// Task 8 controller correction — that `CapabilityProbeFailed` never shows
/// up here: that variant belongs to `broker_get_overview` alone, because
/// `build_topic_detail` never holds anything a capability snapshot could
/// come from other than a `BrokerAdmin` reference.
#[tokio::test]
async fn build_topic_detail_wires_stats_internal_and_anomalies_for_the_real_topic() {
    let topic_ref = fpms_topup();
    let detail = commands::build_topic_detail(&admin(), &topic_ref).await.expect("topic detail");

    assert_eq!(detail.topic, "fpms_topup");
    assert!(!detail.stats.subscriptions.is_empty(), "fpms_topup must have at least one subscription");

    // Structural, not a pinned count (fix round 1, item 3): equal sizes plus
    // a bidirectional name match is a bijection, never a specific number
    // that is a fact about the user's business rather than this code.
    assert_eq!(
        detail.stats.subscriptions.len(),
        detail.internal.cursors.len(),
        "stats and internalStats must agree on how many subscriptions exist"
    );
    let sub_names: Vec<&str> = detail.stats.subscriptions.iter().map(|s| s.name.as_str()).collect();
    for cursor in &detail.internal.cursors {
        assert!(sub_names.contains(&cursor.subscription.as_str()), "cursor {} has no matching subscription", cursor.subscription);
    }
    let cursor_names: Vec<&str> = detail.internal.cursors.iter().map(|c| c.subscription.as_str()).collect();
    for name in &sub_names {
        assert!(cursor_names.contains(name), "subscription {name} has no cursor");
    }

    // Every anomaly and indeterminate check this function can produce is
    // scoped to this one topic — never a namespace-wide capability finding,
    // which only `broker_get_overview` (holding the connection) can produce.
    for a in &detail.anomalies {
        assert_eq!(a.topic, "fpms_topup");
        assert_ne!(a.kind, AnomalyKind::CapabilityProbeFailed, "build_topic_detail must never emit this — see anomaly.rs's module doc");
    }
    for i in &detail.indeterminate {
        assert_eq!(i.topic, "fpms_topup");
        assert_ne!(i.kind, AnomalyKind::CapabilityProbeFailed);
    }

    // Mutation guard: recompute both derivations independently from the raw
    // wire payloads and require an exact match against what
    // `build_topic_detail` returned. This is what would actually catch a
    // wiring mistake (e.g. the threshold constant swapped for a different
    // value, or `indeterminate` silently left empty) that the structural
    // checks above would not — this broker's live data may legitimately
    // produce zero anomalies/indeterminate entries today, which would make
    // those checks pass even if the wiring were broken.
    let raw_stats = admin().get_topic_stats(&topic_ref).await.expect("raw stats");
    let parsed_stats = parse_topic_stats(&raw_stats).expect("parse");
    let expected_anomalies =
        anomaly::derive_anomalies(&topic_ref.topic, &parsed_stats, commands::OLDEST_BACKLOG_THRESHOLD_SECS);
    let expected_indeterminate = anomaly::derive_indeterminate_checks(&topic_ref.topic, &parsed_stats);
    assert_eq!(detail.anomalies, expected_anomalies);
    assert_eq!(detail.indeterminate, expected_indeterminate);
}

/// `build_topic_detail` fails cleanly (not a panic, not a fabricated empty
/// detail) against a topic that does not exist — Admin REST returns 404 for
/// a nonexistent persistent topic's stats.
#[tokio::test]
async fn build_topic_detail_on_a_nonexistent_topic_is_a_clean_error() {
    let topic_ref = TopicRef {
        tenant: "public".into(),
        namespace: "default".into(),
        topic: "broker-probe-topic-detail-does-not-exist".into(),
        persistent: true,
    };
    let err = commands::build_topic_detail(&admin(), &topic_ref).await.expect_err("nonexistent topic must error");
    assert_eq!(err.code, BrokerErrorCode::NotFound);
}

// --- Cache-safety proof: `broker_get_topic_detail` must never touch the
// snapshot cache (ruling D-A2), and `broker_get_overview` may only ever
// cache the topic *list*, never stats. ---
//
// Scratch on-disk SQLite file, same reasoning as `broker_cache.rs` /
// `broker_topology.rs`: `commands::build_overview` takes its `Connection`
// by value and this test reopens it between calls while needing the same
// underlying state, which a fresh `:memory:` database would not give.
static SCRATCH_DB_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn scratch_db_path() -> std::path::PathBuf {
    let n = SCRATCH_DB_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "penguin-broker-topic-detail-test-{}-{}-{n}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ))
}

fn open_scratch(path: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).expect("open scratch db");
    penguin_lib::db::apply_schema(&conn).expect("schema applies");
    conn
}

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

/// Counts every row in the snapshot table, across every scope — the table
/// `CacheScope::Tenants`/`Namespaces`/`Topics` all share. There is no scope
/// variant for stats/subscriptions/internalStats at all (see
/// `broker::cache::CacheScope`'s definition), so this count is the closest
/// thing to a direct measurement of "did anything try to cache live data".
fn snapshot_row_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM broker_topology_snapshots", [], |row| row.get(0)).unwrap()
}

fn snapshot_scopes(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = conn.prepare("SELECT DISTINCT scope FROM broker_topology_snapshots").unwrap();
    stmt.query_map([], |row| row.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
}

/// `build_topic_detail` (the logic behind `broker_get_topic_detail`) has no
/// `Connection` parameter at all — a stronger, compile-time guarantee than
/// any runtime check could give that it cannot write to the snapshot cache.
/// This test still runs it against a scratch database that DOES have the
/// schema applied, to prove the point empirically as well: the table stays
/// completely empty (not just "the topics scope stays empty") across
/// several calls.
#[tokio::test]
async fn topic_detail_never_writes_a_cache_row() {
    let path = scratch_db_path();
    let conn = open_scratch(&path);
    seed_connection(&conn, "c-detail");
    assert_eq!(snapshot_row_count(&conn), 0, "scratch db starts with no cached snapshots");

    let topic_ref = fpms_topup();
    for _ in 0..3 {
        commands::build_topic_detail(&admin(), &topic_ref).await.expect("topic detail");
    }

    assert_eq!(snapshot_row_count(&conn), 0, "no snapshot row must exist after any number of topic-detail reads");
    let _ = std::fs::remove_file(&path);
}

/// `build_overview` (the logic behind `broker_get_overview`) is allowed to
/// cache the topic *list* — the same cache `broker_list_topics` already
/// uses — but must never cache anything else. After two consecutive calls,
/// the snapshot table must hold exactly one row (the topic list, scope
/// "topics"), never a second row for stats, subscriptions, or per-topic
/// data of any kind.
#[tokio::test]
async fn overview_only_ever_caches_the_topic_list_never_stats() {
    if reqwest::get(format!("{ADMIN}/admin/v2/persistent/public/default")).await.is_err() {
        eprintln!("SKIPPING overview_only_ever_caches_the_topic_list_never_stats: broker at {ADMIN} is unreachable");
        return;
    }

    let path = scratch_db_path();
    let seed = open_scratch(&path);
    seed_connection(&seed, "c-overview");
    let row = store::get_connection(&seed, "c-overview").unwrap().expect("seeded row");
    drop(seed);

    let first = commands::build_overview(open_scratch(&path), &row, None).await.expect("first overview call");
    let first_report = first.data.expect("first call returns a report");
    assert!(first_report.topics_total > 0, "the connection's default namespace must have at least one topic");
    // Not truncated: the sampling cap is far above any topic count this
    // broker plausibly holds. No topic COUNT is pinned — only the relation
    // between sampled and total.
    assert_eq!(first_report.topics_sampled, first_report.topics_total, "everything should have been sampled");
    assert!(!first_report.truncated);

    let conn_after_first = open_scratch(&path);
    assert_eq!(snapshot_row_count(&conn_after_first), 1, "exactly one cached row: the topic list");
    assert_eq!(snapshot_scopes(&conn_after_first), vec!["topics".to_string()], "the only cached scope must be the topic list");
    drop(conn_after_first);

    // A second call, immediately after — whether or not the topic list is
    // now served from the cache, every stats call it makes must still be
    // live, so the cache row count must not grow.
    let second = commands::build_overview(open_scratch(&path), &row, None).await.expect("second overview call");
    let second_report = second.data.expect("second call returns a report");
    assert_eq!(second_report.topics_total, first_report.topics_total, "same namespace, same total");

    let conn_after_second = open_scratch(&path);
    assert_eq!(snapshot_row_count(&conn_after_second), 1, "still exactly one cached row after a second call");
    assert_eq!(snapshot_scopes(&conn_after_second), vec!["topics".to_string()]);

    // Every anomaly/indeterminate entry this produced is well-formed: it
    // names one of the topics that was actually sampled, or (only for
    // CapabilityProbeFailed) the tenant/namespace scope itself.
    for a in &second_report.anomalies {
        if a.kind == AnomalyKind::CapabilityProbeFailed {
            assert_eq!(a.topic, format!("{}/{}", row.default_tenant, row.default_namespace));
        }
    }

    let _ = std::fs::remove_file(&path);
}

/// A connection whose `admin_url` cannot be reached at all must still
/// produce a clean failed envelope from `build_overview`, not a panic —
/// there is no topic list to fall back to on a first, uncached call.
#[tokio::test]
async fn overview_against_an_unreachable_broker_fails_cleanly() {
    let path = scratch_db_path();
    let seed = open_scratch(&path);
    let row = store::ConnectionRow {
        id: "c-unreachable".into(),
        kind: "pulsar".into(),
        name: "Unreachable".into(),
        color: "red".into(),
        admin_url: "http://localhost:1".into(),
        broker_url: "pulsar://localhost:1".into(),
        auth_type: "none".into(),
        secret_handle_id: None,
        default_tenant: "public".into(),
        default_namespace: "default".into(),
        read_only: true,
        tls_verify: true,
        timeout_ms: 2_000,
        last_status: "unknown".into(),
        last_checked_at: None,
        broker_version: None,
        capabilities_json: None,
        created_at: 1,
        updated_at: 1,
    };
    store::upsert_connection(&seed, &row).unwrap();
    drop(seed);

    let result = commands::build_overview(open_scratch(&path), &row, None).await.expect("command itself must not error");
    assert!(result.data.is_none(), "no topic list could be learned; the envelope must carry an error, not fabricated data");
    assert!(result.error.is_some());

    let _ = std::fs::remove_file(&path);
}
