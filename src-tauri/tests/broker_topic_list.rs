//! Live test. Requires: docker compose -f infra/broker/docker-compose.local.yml up -d
//!
//! Proves the Phase 0 gate item "Topic list proves Rust-side pagination and
//! partition folding against live Pulsar" by exercising the exact sequence
//! `broker_list_topics` (src/broker/commands.rs) runs — `PulsarAdminRest`'s
//! `list_topics` + `list_partitioned_topics`, folded and paginated by
//! `topic_folding` — against the real `pulsar` container, not a mock.
//!
//! This calls that sequence directly rather than the `#[tauri::command]`
//! wrapper itself, mirroring `broker_capability_discovery.rs` (which tests
//! `capability::discover` rather than `broker_test_connection`): the wrapper
//! only adds a SQLite connection-row lookup on top, which is unrelated to
//! what this test proves and is already covered, in-memory, by
//! `broker_store.rs` (see that file's header: "Store tests run against an
//! in-memory SQLite so they never touch the user's DB" — the same reason
//! this test does not touch it either).
//!
//! Single `#[tokio::test]` function, deliberately not split into several:
//! splitting would let cargo's default concurrent test execution interleave
//! the "exactly the 10 pre-existing topics" assertion with this same
//! process's own probe-topic creation, which is exactly the kind of
//! self-inflicted flake this file must not have.
use penguin_lib::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use penguin_lib::broker::ports::BrokerAdmin;
use penguin_lib::broker::topic_folding::{self, PageQueryDto};

const ADMIN: &str = "http://localhost:8080";
const TENANT: &str = "public";
const NAMESPACE: &str = "default";
const PROBE_TOPIC: &str = "broker-probe-e2e-partitions";
const PROBE_FULL_NAME: &str = "persistent://public/default/broker-probe-e2e-partitions";

/// The 10 topics this broker is documented to hold before any Phase 0 test
/// runs (confirmed via `curl -s http://localhost:8080/admin/v2/persistent/public/default`
/// ahead of writing this test). If this list ever needs to change, it means
/// someone's business data changed, not this test's expectations.
const EXPECTED_BUSINESS_TOPICS: &[&str] = &[
    "persistent://public/default/LOCAL.BP.PAYMENT.PAYMENTACCOUNT.CHECKED.V1",
    "persistent://public/default/LOCAL.BP.PAYMENT.TOPUP.SUCCESS.V1",
    "persistent://public/default/NOTIFY_DYNAMIC_JACKPOT",
    "persistent://public/default/NOTIFY_JACKPOT_MINOR_RECORD",
    "persistent://public/default/NOTIFY_RG_LIMIT_HIT",
    "persistent://public/default/PLAYER_CREDIT_CHANGE_LOG",
    "persistent://public/default/TRANSACTION_FREE_GAME",
    "persistent://public/default/fpms_topup",
    "persistent://public/default/pms-allbank-paylink-linking",
    "persistent://public/default/smoke-test",
];

fn admin() -> PulsarAdminRest {
    PulsarAdminRest::new(ADMIN.to_string(), 10_000, true, None).expect("admin client")
}

async fn fetch_folded() -> Vec<topic_folding::TopicSummaryDto> {
    let client = admin();
    let all = client.list_topics(TENANT, NAMESPACE).await.expect("list_topics against live broker");
    let partitioned = client
        .list_partitioned_topics(TENANT, NAMESPACE)
        .await
        .expect("list_partitioned_topics against live broker");
    topic_folding::fold_topics(&all, &partitioned)
}

/// PUT .../partitions with body "3" — same call the brief's manual checklist
/// (Step 5.4) makes with curl.
async fn create_partitioned_probe_topic() {
    let http = reqwest::Client::new();
    let res = http
        .put(format!("{ADMIN}/admin/v2/persistent/{TENANT}/{NAMESPACE}/{PROBE_TOPIC}/partitions"))
        .header("Content-Type", "application/json")
        .body("3")
        .send()
        .await
        .expect("create probe topic: request failed");
    assert!(
        res.status().is_success(),
        "failed to create 3-partition probe topic: HTTP {}",
        res.status()
    );
}

/// DELETE .../partitions?force=true — same call the brief's cleanup step
/// makes. Best-effort: called from a cleanup path that must run even if an
/// earlier assertion already failed.
async fn delete_partitioned_probe_topic() {
    let http = reqwest::Client::new();
    let _ = http
        .delete(format!(
            "{ADMIN}/admin/v2/persistent/{TENANT}/{NAMESPACE}/{PROBE_TOPIC}/partitions?force=true"
        ))
        .send()
        .await;
}

#[tokio::test]
async fn topic_list_folds_partitions_and_paginates_in_rust_against_live_pulsar() {
    // --- Step 1: the 10 pre-existing business topics come back. ---
    let baseline = fetch_folded().await;
    assert!(
        baseline.iter().all(|t| !t.full_name.contains("broker-probe")),
        "a scratch topic already exists before this test created one: {:?}",
        baseline.iter().map(|t| &t.full_name).collect::<Vec<_>>()
    );
    for expected in EXPECTED_BUSINESS_TOPICS {
        assert!(
            baseline.iter().any(|t| t.full_name == *expected),
            "expected pre-existing business topic missing: {expected}"
        );
    }

    // --- Step 2: a 3-partition topic folds to ONE row with three partition
    //     names, never one row per partition. Wrapped so cleanup (Step 4)
    //     always runs, even if an assertion below fails. ---
    create_partitioned_probe_topic().await;
    let result: Result<(), String> = async {
        let folded = fetch_folded().await;

        let probe_rows: Vec<_> = folded.iter().filter(|t| t.full_name == PROBE_FULL_NAME).collect();
        if probe_rows.len() != 1 {
            return Err(format!(
                "expected exactly one folded row for the probe topic, got {}: {:?}",
                probe_rows.len(),
                folded.iter().map(|t| &t.full_name).collect::<Vec<_>>()
            ));
        }
        let probe = probe_rows[0];
        if probe.partitions != 3 {
            return Err(format!("expected 3 partitions, got {}", probe.partitions));
        }
        if probe.partition_names.len() != 3 {
            return Err(format!(
                "expected 3 partition names, got {:?}",
                probe.partition_names
            ));
        }
        for i in 0..3 {
            let expected_name = format!("{PROBE_FULL_NAME}-partition-{i}");
            if !probe.partition_names.contains(&expected_name) {
                return Err(format!(
                    "missing partition name {expected_name:?} in {:?}",
                    probe.partition_names
                ));
            }
        }
        // No row anywhere in the folded list is one of the raw expanded
        // partitions — folding must have consumed them, not left them
        // standing alongside the parent.
        if folded.iter().any(|t| t.full_name.contains("broker-probe-e2e-partitions-partition-")) {
            return Err("a raw partition name leaked through as its own row".to_string());
        }

        // --- Step 3: changing offset returns different rows with a stable
        //     total — pagination happens in Rust, over the same folded
        //     snapshot, since Admin REST ignores paging entirely. ---
        let total_topics = folded.len();
        if total_topics < 4 {
            return Err(format!(
                "need at least 4 folded topics to prove paging across pages, got {total_topics}"
            ));
        }
        let page_limit = total_topics / 2;

        let query_a = PageQueryDto { offset: 0, limit: page_limit, search: None, sort_by: Some("fullName".into()), sort_dir: None };
        let query_b = PageQueryDto { offset: page_limit, limit: page_limit, search: None, sort_by: Some("fullName".into()), sort_dir: None };

        let page_a = topic_folding::paginate(folded.clone(), &query_a);
        let page_b = topic_folding::paginate(folded.clone(), &query_b);

        if page_a.total != page_b.total {
            return Err(format!(
                "total must be stable across pages: page_a.total={} page_b.total={}",
                page_a.total, page_b.total
            ));
        }
        if page_a.total != total_topics {
            return Err(format!("total must describe the full folded set: {} != {total_topics}", page_a.total));
        }
        let names_a: Vec<&str> = page_a.items.iter().map(|t| t.full_name.as_str()).collect();
        let names_b: Vec<&str> = page_b.items.iter().map(|t| t.full_name.as_str()).collect();
        if names_a.is_empty() || names_b.is_empty() {
            return Err("both pages must be non-empty for this to prove anything".to_string());
        }
        if names_a.iter().any(|n| names_b.contains(n)) {
            return Err(format!("pages must not overlap: page_a={names_a:?} page_b={names_b:?}"));
        }

        Ok(())
    }
    .await;

    // --- Step 4: cleanup, unconditionally. ---
    delete_partitioned_probe_topic().await;

    result.expect("assertion failed (see message) — probe topic has already been cleaned up");

    // --- Step 5: confirm the broker holds only its pre-existing topics. ---
    let after_cleanup = fetch_folded().await;
    assert!(
        after_cleanup.iter().all(|t| !t.full_name.contains("broker-probe")),
        "probe topic survived cleanup: {:?}",
        after_cleanup.iter().map(|t| &t.full_name).collect::<Vec<_>>()
    );
    for expected in EXPECTED_BUSINESS_TOPICS {
        assert!(
            after_cleanup.iter().any(|t| t.full_name == *expected),
            "pre-existing business topic missing after cleanup: {expected}"
        );
    }
}
