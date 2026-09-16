# Penguin Broker Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "a topic is backing up" into a few clicks — navigate tenants and namespaces, open a topic, see its subscriptions' lag and its consumers' real state — all read-only, on the foundation Phase 0 validated.

**Architecture:** Phase 0 built and proved the transport, error map, security gate, pagination, folding and connection management. Phase A adds queries and screens on top, plus the one piece Phase 0 left dead: the topology snapshot cache. Rust owns every broker call and every cache decision; React renders what the commands return.

**Tech Stack:** Rust (tokio, reqwest, rusqlite, `serde_json`), Tauri 2, React 19, TypeScript 5.7, Tailwind 4, `@tanstack/react-virtual`, node:test (core logic), Vitest + Testing Library (UI), Apache Pulsar 4.2.4.

**Spec:** `docs/superpowers/specs/2026-09-16-penguin-broker-phaseA-design.md`

## Global Constraints

- **This phase is entirely read-only.** Every command goes through `BrokerAdmin`'s read methods. No `WritePermit` is needed; if you reach for one, stop and report — it means something is doing what this phase must not.
- Module name is **`broker`**, never `pulsar`, in every path, type and identifier. Pulsar appears only inside `adapters/pulsar/` and as the vendor's product name.
- `msgRateOut` proves delivery to a consumer, **never business completion**. No screen may imply business success — that evidence does not exist until Phase C.
- Nothing is presented as measured unless it was measured. The five hardcoded `CapabilitySnapshot` constants must read as "not measured for this connection", never as a result.
- **Never cache stats, subscriptions or consumers** (ruling D-A2). Only tenants, namespaces and topic lists are cached.
- New source files stay at or under 400 lines. Split by responsibility, following the `data-table-*.tsx` sibling pattern.
- Every Tauri command takes `connectionId` explicitly. "Active connection" is a UI concept, never an implicit backend default.
- The `pulsar` container on `localhost:8080` holds the user's **real business topics**. Only ever create, touch or delete topics prefixed `broker-probe-`, and verify the baseline is restored.
- `pnpm test`'s failing set must remain exactly the six known pre-existing files: log-evidence-correlator, log-investigation, log-investigation-contract, log-investigation-preflight, log-query-planner, sls-target-registry. `knowledge-query-runtime-e2e` is a known timing flake — re-run it alone if it appears and say so.
- Run every verification command in the FOREGROUND. Three tasks in Phase 0 stalled by backgrounding a long run and waiting on it.
- Stop `broker-pulsar-secure` before a long cargo build; restart it **before** running `pnpm test`, which needs it.

---

## File Structure

**Contracts (shared types)**
- `packages/broker-contracts/src/topology.ts` — `TenantSummary`, `NamespaceSummary`
- `packages/broker-contracts/src/topic-detail.ts` — `TopicDetail`, `TopicStats`, `SubscriptionStats`, `ConsumerStats`, `InternalStats`, `CursorPosition`

> **Naming:** the spec's §5 sketch called these `SubscriptionSummary` / `ConsumerSummary`.
> This plan uses `SubscriptionStats` / `ConsumerStats` in BOTH layers, because that is what
> they are — the parsed subset of Pulsar's `stats` payload, not a summary we compose.
> One name per concept across Rust and TypeScript; Phase 0's `observed_at` divergence
> started as exactly this kind of drift.
- `packages/broker-contracts/src/anomaly.ts` — `Anomaly`, `AnomalyKind`, `OverviewReport`
- `packages/broker-contracts/src/envelope.ts` (modify) — `BrokerSource` becomes the source of truth for the Rust enum

**Rust — cache**
- `src-tauri/src/broker/cache.rs` — TTL policy, `CacheScope`, freshness decision, the read-through helper
- `src-tauri/src/broker/store.rs` (modify) — snapshot delete for explicit refresh

**Rust — domain**
- `src-tauri/src/broker/stats.rs` — parse the subset of `stats`/`internalStats` we use, tolerating unknown fields
- `src-tauri/src/broker/anomaly.rs` — derive anomalies from topics + subscriptions
- `src-tauri/src/broker/envelope.rs` (modify) — `source: String` becomes an enum (spec §4.1)
- `src-tauri/src/broker/ports.rs` (modify) — add `get_topic_internal_stats`
- `src-tauri/src/broker/adapters/pulsar/admin_rest.rs` (modify) — implement it
- `src-tauri/src/broker/commands.rs` (modify) — five new commands

**Frontend**
- `src/components/broker/TopologyTree.tsx` — tenant → namespace navigation
- `src/components/broker/TopicDetailPanel.tsx` — stats + cursor state
- `src/components/broker/SubscriptionTable.tsx` — lag per subscription
- `src/components/broker/ConsumerTable.tsx` — consumer detail, expandable from a subscription row
- `src/components/broker/AnomalyPanel.tsx` — the Overview surface
- `src/components/broker/DeliveryNotice.tsx` — the reusable "delivery ≠ completion" disclosure
- `src/lib/broker-client.ts` (modify) — the five new command wrappers
- `src/hooks/useBrokerTopology.ts` — tree state, selected tenant/namespace
- `src/components/broker/BrokerPage.tsx` (modify) — wire the new tabs and panes

---

## Part 1 — Cache and contracts

The snapshot cache is the one piece of Phase 0 that was built, tested, and never wired. Doing it first makes `stale` reachable for every screen that follows.

---

### Task 1: `BrokerSource` becomes an enum

Phase 0's final review identified this as the reason a dead code path went unnoticed: `ResultEnvelope.source` is a `String` in Rust against a closed union in TypeScript, so `"cache"` being unreachable was invisible to the compiler.

**Files:**
- Modify: `src-tauri/src/broker/envelope.rs`
- Modify: `packages/broker-contracts/src/envelope.ts`
- Modify: `src-tauri/src/broker/commands.rs` (call sites)
- Modify: `src-tauri/src/broker/capability.rs` (call site)

**Interfaces:**
- Produces: `BrokerSource` enum with variants `AdminRest`, `Binary`, `Cache`, serialising to `"pulsar-admin-rest"`, `"pulsar-binary"`, `"cache"`. `ResultEnvelope::ok(data, source: BrokerSource)` and `::failed(error, source: BrokerSource)`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

```rust
// in src-tauri/src/broker/envelope.rs's test module
#[test]
fn broker_source_serialises_to_the_typescript_union_values() {
    // packages/broker-contracts/src/envelope.ts declares:
    //   type BrokerSource = "pulsar-admin-rest" | "pulsar-binary" | "cache"
    // These three strings are the contract; a rename on either side breaks the
    // other silently, so pin them here.
    assert_eq!(
        serde_json::to_string(&BrokerSource::AdminRest).unwrap(),
        "\"pulsar-admin-rest\""
    );
    assert_eq!(
        serde_json::to_string(&BrokerSource::Binary).unwrap(),
        "\"pulsar-binary\""
    );
    assert_eq!(serde_json::to_string(&BrokerSource::Cache).unwrap(), "\"cache\"");
}

#[test]
fn envelope_carries_the_source_it_was_built_with() {
    let env = ResultEnvelope::ok(42u32, BrokerSource::Cache);
    let json = serde_json::to_value(&env).unwrap();
    assert_eq!(json["source"], "cache");
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test broker::envelope
```

Expected: FAIL to compile — `BrokerSource` is not defined and `ResultEnvelope::ok` takes `&str`.

- [ ] **Step 3: Implement**

```rust
/// Which transport produced a result. A closed set, mirroring
/// `BrokerSource` in packages/broker-contracts/src/envelope.ts — the two
/// must agree, and the test above pins the wire strings.
///
/// This is an enum rather than a String deliberately: Phase 0 shipped a
/// `"cache"` value that nothing could ever produce, and a String made that
/// invisible. What the enum buys is narrower than "the compiler warns about
/// an unused variant" — it does not: `derive(Deserialize)` names every
/// variant, which satisfies dead-code analysis on its own. What it does buy
/// is that every `match` on a source is exhaustiveness-checked, a typo is a
/// compile error instead of a value nothing matches, and the set is small
/// enough to audit against the TypeScript union in one glance — which the
/// test below does mechanically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrokerSource {
    #[serde(rename = "pulsar-admin-rest")]
    AdminRest,
    #[serde(rename = "pulsar-binary")]
    Binary,
    #[serde(rename = "cache")]
    Cache,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEnvelope<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    pub source: BrokerSource,
    pub observed_at: String,
    pub freshness_ms: u64,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrokerError>,
}

impl<T> ResultEnvelope<T> {
    pub fn ok(data: T, source: BrokerSource) -> Self {
        Self {
            data: Some(data),
            source,
            observed_at: now_rfc3339(),
            freshness_ms: 0,
            warnings: Vec::new(),
            error: None,
        }
    }

    pub fn failed(error: BrokerError, source: BrokerSource) -> Self {
        Self {
            data: None,
            source,
            observed_at: now_rfc3339(),
            freshness_ms: 0,
            warnings: Vec::new(),
            error: Some(error),
        }
    }
}
```

Update every call site: `commands.rs` and `capability.rs` currently pass `"pulsar-admin-rest"` as a string literal. Replace with `BrokerSource::AdminRest`.

- [ ] **Step 4: Run until green**

```bash
cd src-tauri && cargo test
```

Expected: 211 plus the 2 new, no regressions. Any call site you missed is a compile error, which is the point.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/broker/envelope.rs src-tauri/src/broker/commands.rs \
        src-tauri/src/broker/capability.rs packages/broker-contracts/src/envelope.ts
git commit -m "refactor(broker): BrokerSource becomes an enum so unreachable variants are visible"
```

---

### Task 2: Cache policy and freshness

Pure logic, no I/O. This is what decides whether a screen shows `ready` or `stale`.

**Files:**
- Create: `src-tauri/src/broker/cache.rs`
- Modify: `src-tauri/src/broker/mod.rs`

**Interfaces:**
- Consumes: `BrokerError` (Phase 0), `BrokerSource` (Task 1).
- Produces:
  - `enum CacheScope { Tenants, Namespaces, Topics }` with `fn ttl(&self) -> Duration` and `fn scope_name(&self) -> &'static str`
  - `enum Freshness { Fresh { age_ms: u64 }, Stale { age_ms: u64 }, Absent }`
  - `fn assess(scope: CacheScope, observed_at_ms: Option<i64>, now_ms: i64) -> Freshness`

- [ ] **Step 1: Write the failing tests**

```rust
// bottom of src-tauri/src/broker/cache.rs
#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn absent_when_nothing_was_cached() {
        assert_eq!(assess(CacheScope::Topics, None, NOW), Freshness::Absent);
    }

    #[test]
    fn fresh_inside_the_ttl() {
        // Topics TTL is 60s; 30s old is fresh.
        let observed = NOW - 30_000;
        assert_eq!(
            assess(CacheScope::Topics, Some(observed), NOW),
            Freshness::Fresh { age_ms: 30_000 }
        );
    }

    #[test]
    fn stale_past_the_ttl_but_still_reports_its_age() {
        // Past the TTL the data is still returned and rendered — the age is
        // what the UI shows next to the stale badge, so it must be accurate.
        let observed = NOW - 90_000;
        assert_eq!(
            assess(CacheScope::Topics, Some(observed), NOW),
            Freshness::Stale { age_ms: 90_000 }
        );
    }

    #[test]
    fn tenants_tolerate_a_much_longer_ttl_than_topics() {
        // Tenants change almost never; topics change often enough that a
        // minute-old list can already mislead.
        let four_minutes = NOW - 240_000;
        assert!(matches!(
            assess(CacheScope::Tenants, Some(four_minutes), NOW),
            Freshness::Fresh { .. }
        ));
        assert!(matches!(
            assess(CacheScope::Topics, Some(four_minutes), NOW),
            Freshness::Stale { .. }
        ));
    }

    #[test]
    fn a_timestamp_in_the_future_is_treated_as_fresh_with_zero_age() {
        // Clock skew between the app and whatever wrote the row must not
        // produce a negative age or an underflow.
        let observed = NOW + 5_000;
        assert_eq!(
            assess(CacheScope::Topics, Some(observed), NOW),
            Freshness::Fresh { age_ms: 0 }
        );
    }

    #[test]
    fn scope_names_are_stable_because_they_are_database_keys() {
        // These strings are the `scope` column in broker_topology_snapshots.
        // Renaming one orphans every cached row for that scope.
        assert_eq!(CacheScope::Tenants.scope_name(), "tenants");
        assert_eq!(CacheScope::Namespaces.scope_name(), "namespaces");
        assert_eq!(CacheScope::Topics.scope_name(), "topics");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test broker::cache
```

Expected: FAIL to compile — nothing in this module exists yet.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/broker/cache.rs
//! Topology cache policy.
//!
//! Pulsar's Admin REST ignores pagination and always returns full lists, so
//! the module caches those lists and pages over the cache in Rust. What is
//! NOT cached is as important as what is: stats, subscriptions and consumers
//! are the live numbers an operator reads during triage, and a cached backlog
//! figure is not slightly-old information — it is actively misleading
//! (spec ruling D-A2).

use std::time::Duration;

/// The kinds of topology data that are cached. The string form is the
/// `scope` column in `broker_topology_snapshots`, so it is part of the
/// on-disk format — see the test that pins it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheScope {
    Tenants,
    Namespaces,
    Topics,
}

impl CacheScope {
    pub fn ttl(&self) -> Duration {
        match self {
            // Tenants and namespaces are structural; they change when someone
            // provisions something, not during an incident.
            CacheScope::Tenants => Duration::from_secs(300),
            CacheScope::Namespaces => Duration::from_secs(300),
            // A topic list can change under you while you are looking at it.
            CacheScope::Topics => Duration::from_secs(60),
        }
    }

    pub fn scope_name(&self) -> &'static str {
        match self {
            CacheScope::Tenants => "tenants",
            CacheScope::Namespaces => "namespaces",
            CacheScope::Topics => "topics",
        }
    }
}

/// How old a cached entry is relative to its scope's TTL.
///
/// `Stale` still carries its data to the caller: the UI renders stale rows
/// AND a notice, because hiding data an operator can still reason about is
/// worse than marking it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    Fresh { age_ms: u64 },
    Stale { age_ms: u64 },
    Absent,
}

pub fn assess(scope: CacheScope, observed_at_ms: Option<i64>, now_ms: i64) -> Freshness {
    let Some(observed) = observed_at_ms else {
        return Freshness::Absent;
    };
    // Clamp at zero: a row written by a clock ahead of ours must not
    // underflow into an enormous age.
    let age_ms = now_ms.saturating_sub(observed).max(0) as u64;
    if age_ms <= scope.ttl().as_millis() as u64 {
        Freshness::Fresh { age_ms }
    } else {
        Freshness::Stale { age_ms }
    }
}
```

Add `pub mod cache;` to `src-tauri/src/broker/mod.rs`.

- [ ] **Step 4: Run until green**

```bash
cd src-tauri && cargo test broker::cache
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/broker/cache.rs src-tauri/src/broker/mod.rs
git commit -m "feat(broker): cache scopes, TTLs and freshness assessment"
```

---

### Task 3: Wire the cache into topic listing

This is where `source: "cache"` becomes producible and `stale` becomes reachable — the two things Phase 0's final review found were dead.

**Files:**
- Modify: `src-tauri/src/broker/store.rs` — add `delete_snapshot`
- Modify: `src-tauri/src/broker/commands.rs` — `broker_list_topics` reads through the cache
- Create: `src-tauri/tests/broker_cache.rs`

**Interfaces:**
- Consumes: `CacheScope`, `Freshness`, `assess` (Task 2); `BrokerSource` (Task 1); `store::put_snapshot`/`get_snapshot` (Phase 0).
- Produces:
  - `store::delete_snapshot(conn, connection_id, scope, scope_key) -> Result<(), BrokerError>`
  - `broker_list_topics(connection_id, tenant, namespace, query, refresh: bool)` — the added `refresh` flag bypasses the cache.

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/tests/broker_cache.rs
//! Cache behaviour against an in-memory SQLite. No broker needed.
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test --test broker_cache
```

Expected: FAIL to compile — `store::delete_snapshot` does not exist.

- [ ] **Step 3: Add `delete_snapshot`**

```rust
// in src-tauri/src/broker/store.rs, beside put_snapshot/get_snapshot
/// Drops one cached snapshot. Used by an explicit refresh, which must go to
/// the broker rather than re-reading what it is trying to replace.
/// Deleting a row that is not there is success, not an error — refreshing a
/// view that was never cached is an ordinary thing to do.
pub fn delete_snapshot(
    conn: &Connection,
    connection_id: &str,
    scope: &str,
    scope_key: &str,
) -> Result<(), BrokerError> {
    conn.execute(
        "DELETE FROM broker_topology_snapshots
         WHERE connection_id = ?1 AND scope = ?2 AND scope_key = ?3",
        params![connection_id, scope, scope_key],
    )
    .map(|_| ())
    .map_err(db_err)
}
```

- [ ] **Step 4: Run the store tests until green**

```bash
cd src-tauri && cargo test --test broker_cache
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Read through the cache in `broker_list_topics`**

Rewrite the command so it:

1. computes `scope_key` as `format!("{tenant}/{namespace}")`
2. when `refresh` is true, calls `store::delete_snapshot` for both the `topics` scope before doing anything else
3. reads the snapshot and calls `assess(CacheScope::Topics, observed_at, now)`
4. on `Fresh` — deserialises the cached `(all_topics, partitioned_topics)` pair, folds, paginates, and returns an envelope with `BrokerSource::Cache` and `freshness_ms` set to the measured age
5. on `Stale` — returns the cached data exactly as in (4), but ALSO pushes a warning naming the age, so the UI can render rows plus a stale notice
6. on `Absent` — fetches both lists from the broker, writes the snapshot, and returns `BrokerSource::AdminRest` with `freshness_ms: 0`
7. on a broker error when the cache held something — returns the cached data with `BrokerSource::Cache`, the age, AND the error's message as a warning. Losing the screen entirely because a refresh failed is worse than showing what we last knew, clearly marked.

Cache the two lists together as one JSON object so they cannot drift apart:

```rust
#[derive(Serialize, Deserialize)]
struct TopicListSnapshot {
    all: Vec<String>,
    partitioned: Vec<String>,
}
```

Add the `refresh: bool` parameter to the command signature. Update `src/lib/broker-client.ts`'s `listTopics` to pass it, defaulting to `false`.

- [ ] **Step 6: Add the live integration assertions**

Append to `src-tauri/tests/broker_cache.rs` a `#[tokio::test]` that runs against the live broker on `localhost:8080`:

- first call with `refresh: false` returns `BrokerSource::AdminRest` (nothing cached yet)
- an immediate second call returns `BrokerSource::Cache` with `freshness_ms` greater than zero
- a call with `refresh: true` returns `BrokerSource::AdminRest` again
- all three return the same 10 business topics

Guard it so it skips with a clear message if the broker is unreachable, rather than failing for an environmental reason.

- [ ] **Step 7: Run everything**

```bash
cd src-tauri && cargo test
```

Expected: no regressions, plus the new cache tests.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/broker/store.rs src-tauri/src/broker/commands.rs \
        src-tauri/tests/broker_cache.rs src/lib/broker-client.ts
git commit -m "feat(broker): read topic lists through the snapshot cache

Makes BrokerSource::Cache producible and DataTable's stale state reachable —
both were dead code after Phase 0. A failed refresh now degrades to the last
known list with a warning rather than blanking the screen."
```

---

### Task 4: Topology contracts and the tenant/namespace commands

**Files:**
- Create: `packages/broker-contracts/src/topology.ts`
- Modify: `packages/broker-contracts/src/index.ts`
- Modify: `src-tauri/src/broker/commands.rs`
- Modify: `src/lib/broker-client.ts`
- Create: `src-tauri/tests/broker_topology.rs`

**Interfaces:**
- Consumes: `CacheScope`, `assess` (Task 2); `BrokerSource` (Task 1); `BrokerAdmin::list_tenants`/`list_namespaces` (Phase 0).
- Produces:
  - TS: `TenantSummary { name: string }`, `NamespaceSummary { tenant: string; name: string; full: string }`
  - Rust mirrors `TenantSummaryDto`, `NamespaceSummaryDto` with the same camelCase wire shape
  - `broker_list_tenants(connectionId, refresh) -> ResultEnvelope<Vec<TenantSummaryDto>>`
  - `broker_list_namespaces(connectionId, tenant, refresh) -> ResultEnvelope<Vec<NamespaceSummaryDto>>`

- [ ] **Step 1: Write the contracts**

```ts
// packages/broker-contracts/src/topology.ts

/** A tenant as the broker reports it. Pulsar returns bare strings; we wrap
 *  them so later phases can attach policy or permission data without
 *  reshaping every caller. */
export interface TenantSummary {
  name: string;
}

/** A namespace. Pulsar's list endpoint returns "tenant/namespace" strings;
 *  we split them once here rather than at every call site, and keep `full`
 *  because that is the form the topic endpoints take. */
export interface NamespaceSummary {
  tenant: string;
  name: string;
  full: string;
}
```

Re-export both from `packages/broker-contracts/src/index.ts`.

- [ ] **Step 2: Write the failing live test**

```rust
// src-tauri/tests/broker_topology.rs
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
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd src-tauri && cargo test --test broker_topology
```

Expected: FAIL to compile if the test file's imports do not resolve; otherwise it should already pass, since `list_tenants` and `list_namespaces` exist from Phase 0. If they pass immediately, say so in your report — the value of this step is the third assertion, which nothing previously covered.

- [ ] **Step 4: Add the commands**

Both follow `broker_list_topics`'s shape from Task 3: read through the cache with the matching `CacheScope`, `scope_key` being `"*"` for tenants and the tenant name for namespaces, same `refresh` flag, same degrade-to-cache-on-error behaviour.

`NamespaceSummaryDto` splits `"public/default"` into `tenant: "public"`, `name: "default"`, `full: "public/default"`. If a name arrives without a `/`, treat the whole string as `name` with an empty `tenant` and push a warning — do not panic, and do not silently drop it.

Register both in `src-tauri/src/lib.rs`'s `generate_handler!`.

- [ ] **Step 5: Add the client wrappers**

```ts
// in src/lib/broker-client.ts
export function listTenants(
  connectionId: string,
  refresh = false,
): Promise<ResultEnvelope<TenantSummary[]>> {
  return invoke("broker_list_tenants", { connectionId, refresh });
}

export function listNamespaces(
  connectionId: string,
  tenant: string,
  refresh = false,
): Promise<ResultEnvelope<NamespaceSummary[]>> {
  return invoke("broker_list_namespaces", { connectionId, tenant, refresh });
}
```

- [ ] **Step 6: Verify**

```bash
pnpm -F @penguin/broker-contracts build
cd src-tauri && cargo test && cd ..
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/broker-contracts/src/topology.ts packages/broker-contracts/src/index.ts \
        src-tauri/src/broker/commands.rs src-tauri/src/lib.rs \
        src/lib/broker-client.ts src-tauri/tests/broker_topology.rs
git commit -m "feat(broker): tenant and namespace listing through the cache"
```

---

### Task 5: Stats parsing that survives an unknown field

Pulsar's `stats` payload differs between versions. Mapping every field means a new version breaks the screen; mapping none means no screen at all.

**Files:**
- Create: `src-tauri/src/broker/stats.rs`
- Create: `src-tauri/tests/fixtures/broker/topic-stats.json`
- Modify: `src-tauri/src/broker/mod.rs`

**Interfaces:**
- Consumes: `BrokerError` (Phase 0).
- Produces:
  - `struct TopicStats { msg_rate_in, msg_rate_out, msg_throughput_in, msg_throughput_out, storage_size, backlog_size, msg_in_counter, oldest_backlog_message_age_seconds, subscriptions: Vec<SubscriptionStats> }`
  - `struct SubscriptionStats { name, msg_backlog, unacked_messages, msg_rate_out, sub_type, consumers: Vec<ConsumerStats> }`
  - `struct ConsumerStats { consumer_name, address, client_version, available_permits, unacked_messages, last_acked_timestamp, last_consumed_timestamp, msg_rate_out, blocked_on_unacked_msgs }`
  - `fn parse_topic_stats(raw: &serde_json::Value) -> Result<TopicStats, BrokerError>`

- [ ] **Step 1: Capture a real fixture**

```bash
curl -s -o src-tauri/tests/fixtures/broker/topic-stats.json \
  http://localhost:8080/admin/v2/persistent/public/default/fpms_topup/stats
python3 -c "
import json; d=json.load(open('src-tauri/tests/fixtures/broker/topic-stats.json'))
print('top-level keys:', sorted(d.keys())[:8])
print('subscriptions:', list(d.get('subscriptions',{}).keys()))
"
```

This is the user's real topic with its two real subscriptions. Commit the fixture.

- [ ] **Step 2: Write the failing tests**

```rust
// bottom of src-tauri/src/broker/stats.rs
#[cfg(test)]
mod tests {
    use super::*;

    fn real_fixture() -> serde_json::Value {
        let raw = include_str!("../../tests/fixtures/broker/topic-stats.json");
        serde_json::from_str(raw).expect("fixture is valid JSON")
    }

    #[test]
    fn parses_the_real_captured_stats() {
        let stats = parse_topic_stats(&real_fixture()).expect("parses");
        // fpms_topup carries exactly these two subscriptions on the user's broker.
        let names: Vec<_> = stats.subscriptions.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"rg_deposit_accumulate_LOCAL"), "got {names:?}");
        assert!(names.contains(&"anti_addiction_deposit_limit_fpmsnt"), "got {names:?}");
    }

    #[test]
    fn an_unknown_field_does_not_break_the_parse() {
        // A future Pulsar version will add fields. Mapping only what we use
        // means that is a non-event; strict mapping would blank the screen.
        let mut raw = real_fixture();
        raw["someFieldFromAFutureVersion"] = serde_json::json!({"nested": [1, 2, 3]});
        assert!(parse_topic_stats(&raw).is_ok());
    }

    #[test]
    fn a_missing_optional_field_yields_a_default_not_an_error() {
        // oldestBacklogMessageAgeSeconds is absent on topics that never had a
        // backlog. That is normal, not a failure.
        let mut raw = real_fixture();
        raw.as_object_mut().unwrap().remove("oldestBacklogMessageAgeSeconds");
        let stats = parse_topic_stats(&raw).expect("still parses");
        assert_eq!(stats.oldest_backlog_message_age_seconds, None);
    }

    #[test]
    fn a_wrong_type_is_an_error_not_a_silent_zero() {
        // If msgBacklog arrives as a string, reporting 0 would tell an
        // operator the queue is drained when we simply could not read it.
        let mut raw = real_fixture();
        raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["msgBacklog"] =
            serde_json::json!("not a number");
        let err = parse_topic_stats(&raw).expect_err("must not coerce to zero");
        assert_eq!(err.code, crate::broker::envelope::BrokerErrorCode::MalformedResponse);
    }

    #[test]
    fn a_subscription_with_no_consumers_parses_with_an_empty_list() {
        // This is the shape that matters most for the anomaly panel: backlog
        // present, nobody consuming.
        let mut raw = real_fixture();
        raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] =
            serde_json::json!([]);
        let stats = parse_topic_stats(&raw).expect("parses");
        let sub = stats
            .subscriptions
            .iter()
            .find(|s| s.name == "rg_deposit_accumulate_LOCAL")
            .expect("subscription present");
        assert!(sub.consumers.is_empty());
    }

    #[test]
    fn blocked_on_unacked_is_carried_through_verbatim() {
        // The single most diagnostic consumer field — it says the broker
        // itself stopped delivering. It must never be inferred or defaulted.
        let mut raw = real_fixture();
        raw["subscriptions"]["rg_deposit_accumulate_LOCAL"]["consumers"] =
            serde_json::json!([{
                "consumerName": "probe",
                "blockedConsumerOnUnackedMsgs": true
            }]);
        let stats = parse_topic_stats(&raw).expect("parses");
        let sub = stats.subscriptions.iter()
            .find(|s| s.name == "rg_deposit_accumulate_LOCAL").unwrap();
        assert_eq!(sub.consumers[0].blocked_on_unacked_msgs, Some(true));
    }
}
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd src-tauri && cargo test broker::stats
```

Expected: FAIL to compile.

- [ ] **Step 4: Implement**

Write `stats.rs` with `#[serde(default)]` on optional scalars and `Option<T>` for anything genuinely absent-able, so a missing field is a default and a wrong-typed field is an error. Do NOT use `#[serde(deny_unknown_fields)]` — unknown fields must pass through.

`subscriptions` arrives as a JSON object keyed by name; flatten it into a `Vec<SubscriptionStats>` carrying the key as `name`, sorted by name so the order is stable across calls.

Add `pub mod stats;` to `mod.rs`.

- [ ] **Step 5: Run until green**

```bash
cd src-tauri && cargo test broker::stats
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/broker/stats.rs src-tauri/src/broker/mod.rs \
        src-tauri/tests/fixtures/broker/topic-stats.json
git commit -m "feat(broker): parse the stats subset we use, tolerating unknown fields"
```

---

### Task 6: `internalStats` and the cursor position

`stats` gives throughput and backlog. `internalStats` gives where each subscription's cursor actually sits, which is what distinguishes "consuming slowly" from "not consuming at all".

**Files:**
- Modify: `src-tauri/src/broker/ports.rs` — add to the trait
- Modify: `src-tauri/src/broker/adapters/pulsar/admin_rest.rs` — implement
- Modify: `src-tauri/src/broker/stats.rs` — parse it
- Create: `src-tauri/tests/fixtures/broker/topic-internal-stats.json`

**Interfaces:**
- Consumes: `BrokerAdmin`, `TopicRef` (Phase 0).
- Produces:
  - `async fn get_topic_internal_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError>` on the trait
  - `struct InternalStats { entries_added_counter, number_of_entries, last_confirmed_entry, cursors: Vec<CursorPosition> }`
  - `struct CursorPosition { subscription, mark_delete_position, read_position, messages_consumed_counter }`
  - `fn parse_internal_stats(raw: &serde_json::Value) -> Result<InternalStats, BrokerError>`

- [ ] **Step 1: Capture the fixture**

```bash
curl -s -o src-tauri/tests/fixtures/broker/topic-internal-stats.json \
  http://localhost:8080/admin/v2/persistent/public/default/fpms_topup/internalStats
python3 -c "
import json; d=json.load(open('src-tauri/tests/fixtures/broker/topic-internal-stats.json'))
print('cursors:', list(d.get('cursors',{}).keys()))
print('lastConfirmedEntry:', d.get('lastConfirmedEntry'))
"
```

- [ ] **Step 2: Write the failing tests**

```rust
// in src-tauri/src/broker/stats.rs's test module
#[test]
fn parses_real_internal_stats_with_both_cursors() {
    let raw: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/broker/topic-internal-stats.json"
    ))
    .unwrap();
    let internal = parse_internal_stats(&raw).expect("parses");
    let subs: Vec<_> = internal.cursors.iter().map(|c| c.subscription.as_str()).collect();
    assert!(subs.contains(&"rg_deposit_accumulate_LOCAL"), "got {subs:?}");
    assert!(subs.contains(&"anti_addiction_deposit_limit_fpmsnt"), "got {subs:?}");
}

#[test]
fn cursor_positions_are_kept_as_written_not_parsed_into_numbers() {
    // Positions look like "53:-1" — ledger:entry. Splitting them into ints
    // loses the -1 sentinel that means "nothing read yet", and the format is
    // Pulsar's to change, not ours to interpret.
    let raw: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/broker/topic-internal-stats.json"
    ))
    .unwrap();
    let internal = parse_internal_stats(&raw).expect("parses");
    let cursor = &internal.cursors[0];
    assert!(
        cursor.mark_delete_position.contains(':'),
        "expected a ledger:entry string, got {}",
        cursor.mark_delete_position
    );
}

#[test]
fn internal_stats_tolerate_an_unknown_field() {
    let mut raw: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/broker/topic-internal-stats.json"
    ))
    .unwrap();
    raw["futureField"] = serde_json::json!(true);
    assert!(parse_internal_stats(&raw).is_ok());
}
```

- [ ] **Step 3: Run to verify it fails, then implement**

```bash
cd src-tauri && cargo test broker::stats
```

Add `get_topic_internal_stats` to the `BrokerAdmin` trait and implement it in `admin_rest.rs` as
`self.get_json(&format!("/admin/v2/{}/internalStats", topic.rest_path())).await` — the same
`get_raw` path every other method uses, so the guard, redirect policy, size cap and UTF-8
validation all apply without new code.

Parse `cursors` from its JSON-object form into a sorted `Vec<CursorPosition>`, keeping positions as strings.

- [ ] **Step 4: Run until green and commit**

```bash
cd src-tauri && cargo test
git add src-tauri/src/broker/ports.rs src-tauri/src/broker/adapters/pulsar/admin_rest.rs \
        src-tauri/src/broker/stats.rs src-tauri/tests/fixtures/broker/topic-internal-stats.json
git commit -m "feat(broker): internalStats and cursor positions"
```

---

### Task 7: Anomaly derivation

The Overview surface answers "what is wrong", not "how many topics exist" (ruling D-A3). The logic that decides what counts as wrong is pure and belongs in its own module.

**Files:**
- Create: `src-tauri/src/broker/anomaly.rs`
- Create: `packages/broker-contracts/src/anomaly.ts`
- Modify: `src-tauri/src/broker/mod.rs`, `packages/broker-contracts/src/index.ts`

**Interfaces:**
- Consumes: `TopicStats`, `SubscriptionStats`, `ConsumerStats` (Task 5).
- Produces:
  - `enum AnomalyKind { BacklogWithNoConsumer, ConsumerBlockedOnUnacked, BacklogOlderThanThreshold, CapabilityProbeFailed }`
  - `struct Anomaly { kind, topic, subscription: Option<String>, detail: String, observed_value: String }`
  - `fn derive_anomalies(topic: &str, stats: &TopicStats, oldest_backlog_threshold_secs: i64) -> Vec<Anomaly>`
  - TS mirrors with the same camelCase shape

- [ ] **Step 1: Write the failing tests**

```rust
// bottom of src-tauri/src/broker/anomaly.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::stats::{ConsumerStats, SubscriptionStats, TopicStats};

    fn sub(name: &str, backlog: i64, consumers: Vec<ConsumerStats>) -> SubscriptionStats {
        SubscriptionStats {
            name: name.into(),
            msg_backlog: backlog,
            unacked_messages: 0,
            msg_rate_out: 0.0,
            sub_type: Some("Shared".into()),
            consumers,
        }
    }

    fn topic_with(subs: Vec<SubscriptionStats>, oldest_backlog_secs: Option<i64>) -> TopicStats {
        TopicStats {
            msg_rate_in: 0.0,
            msg_rate_out: 0.0,
            msg_throughput_in: 0.0,
            msg_throughput_out: 0.0,
            storage_size: 0,
            backlog_size: 0,
            msg_in_counter: 0,
            oldest_backlog_message_age_seconds: oldest_backlog_secs,
            subscriptions: subs,
        }
    }

    #[test]
    fn backlog_with_no_consumer_is_an_anomaly() {
        // The most common real incident: the consumer died and nobody noticed.
        let stats = topic_with(vec![sub("orders-sub", 3400, vec![])], None);
        let found = derive_anomalies("orders", &stats, 3600);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, AnomalyKind::BacklogWithNoConsumer);
        assert_eq!(found[0].subscription.as_deref(), Some("orders-sub"));
        assert!(found[0].observed_value.contains("3400"));
    }

    #[test]
    fn backlog_with_a_live_consumer_is_not_an_anomaly() {
        // A queue draining normally has backlog. Backlog alone is not a fault.
        let consumer = ConsumerStats {
            consumer_name: Some("c1".into()),
            blocked_on_unacked_msgs: Some(false),
            ..Default::default()
        };
        let stats = topic_with(vec![sub("orders-sub", 3400, vec![consumer])], None);
        assert!(derive_anomalies("orders", &stats, 3600).is_empty());
    }

    #[test]
    fn no_backlog_and_no_consumer_is_not_an_anomaly() {
        // An idle subscription with nothing waiting is fine. Flagging it
        // would bury the real incidents in noise.
        let stats = topic_with(vec![sub("orders-sub", 0, vec![])], None);
        assert!(derive_anomalies("orders", &stats, 3600).is_empty());
    }

    #[test]
    fn a_blocked_consumer_is_an_anomaly_even_with_no_backlog() {
        // blockedConsumerOnUnackedMsgs means the broker stopped delivering.
        // Backlog may still read zero at the instant we sample.
        let consumer = ConsumerStats {
            consumer_name: Some("c1".into()),
            blocked_on_unacked_msgs: Some(true),
            ..Default::default()
        };
        let stats = topic_with(vec![sub("orders-sub", 0, vec![consumer])], None);
        let found = derive_anomalies("orders", &stats, 3600);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, AnomalyKind::ConsumerBlockedOnUnacked);
    }

    #[test]
    fn an_old_backlog_is_an_anomaly_at_the_threshold_boundary() {
        let stats = topic_with(vec![sub("orders-sub", 1, vec![])], Some(3600));
        let found = derive_anomalies("orders", &stats, 3600);
        // Exactly at the threshold counts — "older than an hour" should fire
        // at an hour, and a boundary that silently excludes is a bug.
        assert!(found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
    }

    #[test]
    fn a_missing_backlog_age_is_not_treated_as_zero() {
        // Absent means "we do not know", not "brand new". Reporting no
        // anomaly for an unknown age is correct; reporting one is not.
        let stats = topic_with(vec![sub("orders-sub", 1, vec![])], None);
        let found = derive_anomalies("orders", &stats, 3600);
        assert!(!found.iter().any(|a| a.kind == AnomalyKind::BacklogOlderThanThreshold));
    }

    #[test]
    fn one_subscription_can_raise_two_distinct_anomalies() {
        let consumer = ConsumerStats {
            consumer_name: Some("c1".into()),
            blocked_on_unacked_msgs: Some(true),
            ..Default::default()
        };
        let stats = topic_with(vec![sub("orders-sub", 99, vec![consumer])], Some(7200));
        let kinds: Vec<_> = derive_anomalies("orders", &stats, 3600)
            .into_iter()
            .map(|a| a.kind)
            .collect();
        assert!(kinds.contains(&AnomalyKind::ConsumerBlockedOnUnacked));
        assert!(kinds.contains(&AnomalyKind::BacklogOlderThanThreshold));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test broker::anomaly
```

Expected: FAIL to compile. `ConsumerStats` will need `#[derive(Default)]` for the test helpers — add it in Task 5's file if absent.

- [ ] **Step 3: Implement, run until green, commit**

Each `Anomaly` carries `observed_value` as a string holding the number that triggered it, so the UI shows the measurement rather than restating the rule.

```bash
cd src-tauri && cargo test broker::anomaly
git add src-tauri/src/broker/anomaly.rs packages/broker-contracts/src/anomaly.ts \
        src-tauri/src/broker/mod.rs packages/broker-contracts/src/index.ts
git commit -m "feat(broker): derive anomalies from topic stats"
```

---

### Task 8: Topic detail and subscription commands

**Files:**
- Create: `packages/broker-contracts/src/topic-detail.ts`
- Modify: `src-tauri/src/broker/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/broker-client.ts`
- Create: `src-tauri/tests/broker_topic_detail.rs`

**Interfaces:**
- Consumes: `parse_topic_stats`, `parse_internal_stats` (Tasks 5-6); `derive_anomalies` (Task 7).
- Produces:
  - `broker_get_topic_detail(connectionId, tenant, namespace, topic, persistent) -> ResultEnvelope<TopicDetailDto>`
  - `broker_get_overview(connectionId) -> ResultEnvelope<OverviewReportDto>`
  - `TopicDetailDto { topic, stats, internal, anomalies }`

> **Deviation from the spec's §5, recorded deliberately:** the spec sketched a fifth
> command, `broker_list_subscriptions`. It is not built. Pulsar's `stats` payload already
> carries the full subscription list with its consumers, so a separate command would issue
> a second identical HTTP request and hand back a subset of what the caller just received.
> Subscriptions reach the UI inside `TopicDetailDto.stats.subscriptions`.
> If a later phase needs subscriptions without the rest of the stats, add it then, with
> a reason.

- [ ] **Step 1: Write the failing live test**

```rust
// src-tauri/tests/broker_topic_detail.rs
use penguin_lib::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use penguin_lib::broker::ports::{BrokerAdmin, TopicRef};
use penguin_lib::broker::stats::{parse_internal_stats, parse_topic_stats};

fn fpms_topup() -> TopicRef {
    TopicRef {
        tenant: "public".into(),
        namespace: "default".into(),
        topic: "fpms_topup".into(),
        persistent: true,
    }
}

#[tokio::test]
async fn reads_the_real_topic_end_to_end() {
    let admin = PulsarAdminRest::new("http://localhost:8080".into(), 10_000, true, None).unwrap();

    let raw = admin.get_topic_stats(&fpms_topup()).await.expect("stats");
    let stats = parse_topic_stats(&raw).expect("stats parse");
    assert_eq!(stats.subscriptions.len(), 2, "fpms_topup has two subscriptions");

    let raw_internal = admin
        .get_topic_internal_stats(&fpms_topup())
        .await
        .expect("internalStats");
    let internal = parse_internal_stats(&raw_internal).expect("internal parse");
    assert_eq!(internal.cursors.len(), 2, "one cursor per subscription");

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
}
```

- [ ] **Step 2: Run to verify it fails, implement the commands, run until green**

`broker_get_topic_detail` issues both calls, parses both, derives anomalies, and returns one envelope. Per ruling D-A2 it does **not** touch the cache.

`broker_get_overview` lists topics for the connection's default namespace, fetches stats for each, and returns the union of their anomalies. Cap the number of topics it will sample in one pass at a named constant and say so in a warning when it truncates — a namespace with 10k topics must not issue 10k requests.

- [ ] **Step 3: Commit**

```bash
git add packages/broker-contracts/src/topic-detail.ts src-tauri/src/broker/commands.rs \
        src-tauri/src/lib.rs src/lib/broker-client.ts src-tauri/tests/broker_topic_detail.rs
git commit -m "feat(broker): topic detail and overview commands"
```

## Part 1–2 Gate

- [ ] `cargo test` passes with every new test, no regressions against 211
- [ ] `pnpm typecheck` passes
- [ ] The live tests confirm `fpms_topup`'s two real subscriptions and their cursors
- [ ] `BrokerSource::Cache` is genuinely produced by a cache hit, verified against the live broker
- [ ] No stats, subscription or consumer data is cached anywhere

---

## Part 3 — Frontend

---

### Task 9: The delivery-versus-completion notice

Phase A is the first phase that puts throughput numbers on a screen. A panel reading "out 500/s" is read as "business is fine", and it does not mean that — it means messages reached a consumer process. What the consumer did with them is unknown until Phase C.

This is one small component so the wording exists in exactly one place and every surface that shows a rate uses it.

**Files:**
- Create: `src/components/broker/DeliveryNotice.tsx`
- Create: `src/components/broker/__tests__/DeliveryNotice.test.tsx`

**Interfaces:**
- Produces: `<DeliveryNotice variant="inline" | "block" />`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/broker/__tests__/DeliveryNotice.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeliveryNotice } from "../DeliveryNotice";

describe("DeliveryNotice", () => {
  it("says delivery, not completion", () => {
    render(<DeliveryNotice variant="block" />);
    const text = screen.getByRole("note").textContent ?? "";
    expect(text).toMatch(/deliver/i);
    // The words that would make this notice a lie.
    expect(text).not.toMatch(/\b(completed|succeeded|processed successfully)\b/i);
  });

  it("names what is actually unknown", () => {
    // A vague disclaimer teaches nothing. This one has to say that what the
    // consumer did with the message is not visible here.
    render(<DeliveryNotice variant="block" />);
    expect(screen.getByRole("note").textContent ?? "").toMatch(/consumer|business/i);
  });

  it("renders inline without a heading so it can sit beside a number", () => {
    render(<DeliveryNotice variant="inline" />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails, implement, run until green**

```bash
pnpm test:ui
```

The copy must be plain. Something in the shape of: *"These rates count messages delivered to a consumer. Whether the consumer processed them is not visible here."* Do not soften it into a generic disclaimer, and do not make it alarming — it is a fact about the measurement.

- [ ] **Step 3: Commit**

```bash
git add src/components/broker/DeliveryNotice.tsx src/components/broker/__tests__/DeliveryNotice.test.tsx
git commit -m "feat(broker): delivery-not-completion notice as a single reusable component"
```

---

### Task 10: Topology tree

**Files:**
- Create: `src/components/broker/TopologyTree.tsx`
- Create: `src/hooks/useBrokerTopology.ts`
- Create: `src/components/broker/__tests__/TopologyTree.test.tsx`

**Interfaces:**
- Consumes: `listTenants`, `listNamespaces` (Task 4).
- Produces: `useBrokerTopology(connectionId)` returning `{ tenants, namespaces, selectedTenant, selectedNamespace, selectTenant, selectNamespace, state, error, refresh }`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/broker/__tests__/TopologyTree.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopologyTree } from "../TopologyTree";

const tenants = [{ name: "public" }, { name: "pulsar" }];
const namespaces = [
  { tenant: "public", name: "default", full: "public/default" },
  { tenant: "public", name: "functions", full: "public/functions" },
];

function setup(overrides = {}) {
  const props = {
    tenants,
    namespaces,
    selectedTenant: "public",
    selectedNamespace: null as string | null,
    onSelectTenant: vi.fn(),
    onSelectNamespace: vi.fn(),
    state: "ready" as const,
    ...overrides,
  };
  render(<TopologyTree {...props} />);
  return props;
}

describe("TopologyTree", () => {
  it("renders tenants and the selected tenant's namespaces", () => {
    setup();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("pulsar")).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("marks the selected tenant with aria-selected, not colour alone", () => {
    setup();
    const selected = screen.getByRole("treeitem", { name: /public/ });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it("reports a tenant selection rather than navigating itself", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("treeitem", { name: /pulsar/ }));
    expect(props.onSelectTenant).toHaveBeenCalledWith("pulsar");
  });

  it("is keyboard reachable", async () => {
    // An operator mid-incident should not need the mouse.
    const user = userEvent.setup();
    const props = setup();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(props.onSelectTenant).toHaveBeenCalled();
  });

  it("shows a loading state instead of an empty tree", () => {
    setup({ state: "loading", tenants: [], namespaces: [] });
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("distinguishes an empty tenant list from a failure", () => {
    setup({ state: "empty", tenants: [], namespaces: [] });
    expect(screen.getByRole("status")).toHaveTextContent(/no tenants/i);
  });

  it("renders stale data with a notice rather than hiding it", () => {
    setup({ state: "stale" });
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/stale|cached/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails, implement, run until green**

The tree uses `role="tree"` / `role="treeitem"` with `aria-selected`. `useBrokerTopology` holds the selection and calls the two client functions; the component itself is presentational so these tests need no Tauri mock.

- [ ] **Step 3: Commit**

```bash
git add src/components/broker/TopologyTree.tsx src/hooks/useBrokerTopology.ts \
        src/components/broker/__tests__/TopologyTree.test.tsx
git commit -m "feat(broker): tenant and namespace navigation tree"
```

---

### Task 11: Subscription and consumer tables

**Files:**
- Create: `src/components/broker/SubscriptionTable.tsx`
- Create: `src/components/broker/ConsumerTable.tsx`
- Create: `src/components/broker/__tests__/SubscriptionTable.test.tsx`

**Interfaces:**
- Consumes: `DataTable` with `rowProps`/`expandLabel`/`grow` (Phase 0 Tasks 16-18); `SubscriptionSummary`, `ConsumerSummary` (Task 8).
- Produces: `<SubscriptionTable subscriptions state onRefresh />` with consumers rendered in the expanded row.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/broker/__tests__/SubscriptionTable.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionTable } from "../SubscriptionTable";

const withConsumer = {
  name: "rg_deposit_accumulate_LOCAL",
  msgBacklog: 0,
  unackedMessages: 0,
  msgRateOut: 12.5,
  subType: "Shared",
  consumers: [
    {
      consumerName: "Um8a4",
      address: "/127.0.0.1:45296",
      clientVersion: "Pulsar-Java-v4.2.4",
      availablePermits: 995,
      unackedMessages: 0,
      msgRateOut: 12.5,
      blockedOnUnackedMsgs: false,
    },
  ],
};

const stranded = {
  name: "anti_addiction_deposit_limit_fpmsnt",
  msgBacklog: 3400,
  unackedMessages: 0,
  msgRateOut: 0,
  subType: "Shared",
  consumers: [],
};

function setup(subscriptions = [withConsumer, stranded]) {
  const props = { subscriptions, state: "ready" as const, onRefresh: vi.fn() };
  render(<SubscriptionTable {...props} />);
  return props;
}

describe("SubscriptionTable", () => {
  it("lists each subscription with its backlog", () => {
    setup();
    expect(screen.getByText("rg_deposit_accumulate_LOCAL")).toBeInTheDocument();
    expect(screen.getByText("3400")).toBeInTheDocument();
  });

  it("says a subscription has no consumers rather than showing a blank", () => {
    // A blank cell is indistinguishable from a rendering bug. The whole point
    // of this screen is spotting the subscription nobody is draining.
    setup();
    expect(screen.getByText(/no consumers/i)).toBeInTheDocument();
  });

  it("expands a subscription to reveal its consumers", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByText("Um8a4")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /expand rg_deposit_accumulate_LOCAL/i }));
    expect(screen.getByText("Um8a4")).toBeInTheDocument();
    expect(screen.getByText("Pulsar-Java-v4.2.4")).toBeInTheDocument();
  });

  it("surfaces a blocked consumer in words, not a colour", async () => {
    const user = userEvent.setup();
    const blocked = {
      ...withConsumer,
      consumers: [{ ...withConsumer.consumers[0], blockedOnUnackedMsgs: true }],
    };
    setup([blocked]);
    await user.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
  });

  it("carries the delivery-not-completion notice wherever it shows a rate", () => {
    // msgRateOut is on this screen, so the disclosure has to be too.
    setup();
    expect(screen.getByRole("note").textContent ?? "").toMatch(/deliver/i);
  });

  it("shows an empty state when a topic has no subscriptions at all", () => {
    render(<SubscriptionTable subscriptions={[]} state="empty" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no subscriptions/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails, implement, run until green**

Build on `DataTable`. Use `expandLabel` so each expand button names its subscription — the test depends on it, and so does anyone using a screen reader with more than one row.

- [ ] **Step 3: Commit**

```bash
git add src/components/broker/SubscriptionTable.tsx src/components/broker/ConsumerTable.tsx \
        src/components/broker/__tests__/SubscriptionTable.test.tsx
git commit -m "feat(broker): subscription lag and consumer detail"
```

---

### Task 12: Topic detail panel

**Files:**
- Create: `src/components/broker/TopicDetailPanel.tsx`
- Create: `src/components/broker/__tests__/TopicDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `getTopicDetail` (Task 8); `SubscriptionTable` (Task 11); `DeliveryNotice` (Task 9).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/broker/__tests__/TopicDetailPanel.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopicDetailPanel } from "../TopicDetailPanel";

const detail = {
  topic: "persistent://public/default/fpms_topup",
  stats: {
    msgRateIn: 0,
    msgRateOut: 0,
    msgThroughputIn: 0,
    msgThroughputOut: 0,
    storageSize: 0,
    backlogSize: 0,
    msgInCounter: 0,
    oldestBacklogMessageAgeSeconds: null,
    subscriptions: [],
  },
  internal: {
    entriesAddedCounter: 0,
    numberOfEntries: 0,
    lastConfirmedEntry: "38:-1",
    cursors: [
      {
        subscription: "rg_deposit_accumulate_LOCAL",
        markDeletePosition: "38:-1",
        readPosition: "38:0",
        messagesConsumedCounter: 0,
      },
    ],
  },
  anomalies: [],
};

describe("TopicDetailPanel", () => {
  it("shows the cursor position verbatim", () => {
    // "38:-1" is ledger:entry, and -1 means nothing consumed yet. Rewriting
    // it as a number would destroy that meaning.
    render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText("38:-1")).toBeInTheDocument();
  });

  it("says unknown for an absent backlog age rather than showing zero", () => {
    // Absent means we do not know. Zero would read as "brand new".
    render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/unknown|not measured/i)).toBeInTheDocument();
  });

  it("carries the delivery-not-completion notice", () => {
    render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByRole("note").textContent ?? "").toMatch(/deliver/i);
  });

  it("shows an error state without pretending it has data", () => {
    render(
      <TopicDetailPanel
        detail={null}
        state="error"
        errorMessage="Namespace does not exist"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Namespace does not exist");
  });
});
```

- [ ] **Step 2: Implement, run until green, commit**

```bash
pnpm test:ui
git add src/components/broker/TopicDetailPanel.tsx src/components/broker/__tests__/TopicDetailPanel.test.tsx
git commit -m "feat(broker): topic detail panel with cursor state"
```

---

### Task 13: Anomaly panel

**Files:**
- Create: `src/components/broker/AnomalyPanel.tsx`
- Create: `src/components/broker/__tests__/AnomalyPanel.test.tsx`

**Interfaces:**
- Consumes: `getOverview` (Task 8), `Anomaly` (Task 7).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/broker/__tests__/AnomalyPanel.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnomalyPanel } from "../AnomalyPanel";

const anomalies = [
  {
    kind: "BacklogWithNoConsumer",
    topic: "persistent://public/default/fpms_topup",
    subscription: "anti_addiction_deposit_limit_fpmsnt",
    detail: "subscription has a backlog but no connected consumer",
    observedValue: "3400 messages",
  },
];

describe("AnomalyPanel", () => {
  it("shows the measured value, not just the rule that fired", () => {
    // "has a backlog" is a rule. "3400 messages" is what an operator acts on.
    render(<AnomalyPanel anomalies={anomalies} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/3400 messages/)).toBeInTheDocument();
  });

  it("names the subscription and topic involved", () => {
    render(<AnomalyPanel anomalies={anomalies} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/anti_addiction_deposit_limit_fpmsnt/)).toBeInTheDocument();
  });

  it("says no anomalies found rather than rendering nothing", () => {
    // A blank panel cannot be told apart from a failed query. The whole point
    // of this surface is that silence means something specific.
    render(<AnomalyPanel anomalies={[]} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no anomalies/i);
  });

  it("does not claim all-clear when the query failed", () => {
    render(
      <AnomalyPanel
        anomalies={[]}
        state="error"
        errorMessage="Connection refused"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
    expect(screen.queryByText(/no anomalies/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement, run until green, commit**

The fourth test is the one that matters: an empty list after a failure must not read as "everything is fine".

```bash
pnpm test:ui
git add src/components/broker/AnomalyPanel.tsx src/components/broker/__tests__/AnomalyPanel.test.tsx
git commit -m "feat(broker): anomaly panel that distinguishes all-clear from failure"
```

---

### Task 14: Wire it together and prove it live

**Files:**
- Modify: `src/components/broker/BrokerPage.tsx`
- Modify: `src/components/broker/TopicTable.tsx` — clicking a topic opens its detail
- Create: `src-tauri/tests/broker_phase_a_e2e.rs`

- [ ] **Step 1: Wire the page**

`BrokerPage` gains an Overview tab (the anomaly panel) and, on the Topics tab, a detail pane that opens when a topic row is selected. The topology tree drives which namespace the topic list shows. Keep `BrokerPage.tsx` at or under 400 lines; split the tab bodies into siblings if it grows.

- [ ] **Step 2: Write the live end-to-end test**

```rust
// src-tauri/tests/broker_phase_a_e2e.rs
//! Drives the same call sequence the UI does, against the live broker.
//! This is the regression-testable half of the manual walkthrough.
use penguin_lib::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use penguin_lib::broker::anomaly::{derive_anomalies, AnomalyKind};
use penguin_lib::broker::ports::{BrokerAdmin, TopicRef};
use penguin_lib::broker::stats::parse_topic_stats;

#[tokio::test]
async fn the_console_path_works_against_the_real_broker() {
    let admin = PulsarAdminRest::new("http://localhost:8080".into(), 10_000, true, None).unwrap();

    // 1. tenants -> namespaces -> topics, the tree's own path
    let tenants = admin.list_tenants().await.expect("tenants");
    assert!(tenants.contains(&"public".to_string()));

    let namespaces = admin.list_namespaces("public").await.expect("namespaces");
    assert!(namespaces.iter().any(|n| n == "public/default"));

    let topics = admin.list_topics("public", "default").await.expect("topics");
    assert!(topics.iter().any(|t| t.ends_with("/fpms_topup")));

    // 2. topic detail for the user's real topic
    let topic = TopicRef {
        tenant: "public".into(),
        namespace: "default".into(),
        topic: "fpms_topup".into(),
        persistent: true,
    };
    let stats = parse_topic_stats(&admin.get_topic_stats(&topic).await.expect("stats"))
        .expect("stats parse");
    assert_eq!(stats.subscriptions.len(), 2);

    // 3. anomaly derivation runs over real data without panicking, whatever
    //    the live state happens to be
    let found = derive_anomalies("fpms_topup", &stats, 3600);
    for a in &found {
        assert!(!a.observed_value.is_empty(), "every anomaly names its measurement");
        assert!(
            matches!(
                a.kind,
                AnomalyKind::BacklogWithNoConsumer
                    | AnomalyKind::ConsumerBlockedOnUnacked
                    | AnomalyKind::BacklogOlderThanThreshold
            ),
            "unexpected kind {:?}",
            a.kind
        );
    }
}
```

- [ ] **Step 3: Full verification**

```bash
docker stop broker-pulsar-secure
cd src-tauri && cargo test && cd ..
docker start broker-pulsar-secure
pnpm test:ui
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 4: Manual GUI walkthrough — ACTUALLY DO IT**

Phase 0 taught this the expensive way: `pnpm tauri dev` failed to start while 273 tests were green, because nothing in the suite ran `cargo run`. The live integration test above covers the data path and not the app.

Start the app and confirm, reporting what you could and could not check:

1. `pnpm tauri dev` starts and the window appears
2. the Broker rail opens with the connection already present
3. the topology tree lists `public` and `pulsar`, and selecting `public` lists its namespaces
4. the topic list shows the 10 business topics for `public/default`
5. opening `fpms_topup` shows both subscriptions with their backlogs and cursor positions
6. expanding a subscription shows its consumers, or says it has none
7. the Overview tab shows anomalies or an explicit all-clear
8. every screen showing a rate carries the delivery-not-completion notice

If you cannot drive the GUI, say so plainly and list exactly what a human must check — do not report the walkthrough as done.

- [ ] **Step 5: Commit**

```bash
git add src/components/broker/BrokerPage.tsx src/components/broker/TopicTable.tsx \
        src-tauri/tests/broker_phase_a_e2e.rs
git commit -m "feat(broker): wire the console together and prove the path live"
```

---

## Phase A Gate

**Cache**
- [ ] `BrokerSource::Cache` is produced by a real cache hit against the live broker
- [ ] `stale` renders rows AND a notice, verified
- [ ] an explicit refresh bypasses the cache
- [ ] a failed refresh degrades to cached data with a warning rather than blanking
- [ ] `freshnessMs` carries a real measured age
- [ ] no stats, subscription or consumer data is cached anywhere

**Data**
- [ ] `fpms_topup`'s two real subscriptions and their cursors are read end to end
- [ ] an unknown stats field does not break the parse; a wrong-typed one errors rather than reading as zero
- [ ] a missing backlog age reads as unknown, never as zero
- [ ] anomalies carry the measured value that triggered them

**Honesty**
- [ ] no screen implies business completion
- [ ] an empty anomaly list after a failure does not read as all-clear
- [ ] the hardcoded capability constants read as "not measured for this connection"
- [ ] a subscription with no consumers says so in words

**Global**
- [ ] `cargo test`, `pnpm test:ui`, `pnpm typecheck`, `pnpm build` all pass
- [ ] `pnpm test`'s failing set is exactly the six known pre-existing files
- [ ] `pnpm broker:gate` passes; the broker holds exactly its 10 business topics
- [ ] no `Not run` or `Blocked` rows in the test matrix
- [ ] **the GUI walkthrough was actually performed**, or its outstanding steps are named explicitly
