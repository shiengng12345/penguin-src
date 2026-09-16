//! Topic listing through the snapshot cache — `broker_list_topics`. The
//! cache-read-through policy itself lives in `cache_read::read_through_cache`
//! (Task 4 fix round 1): this function used to carry its own ~70-line copy
//! of that policy, until `topology.rs` needed the identical thing for
//! tenants and namespaces and the duplication became the same defect fix
//! round 3 already removed inside one function, one level up. What remains
//! here is the topic-specific part: the fetch (both admin REST list calls)
//! and the render (fold partitions + paginate).

use crate::broker::cache::CacheScope;
use crate::broker::envelope::{BrokerError, ResultEnvelope};
use crate::broker::ports::BrokerAdmin;
use crate::broker::store::ConnectionRow;
use crate::broker::topic_folding::{self, PageDto, PageQueryDto, TopicSummaryDto};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::cache_read::read_through_cache;
use super::{load_row, resolve_secret};

/// The two lists cached together as one JSON object, so `all` and
/// `partitioned` can never drift apart on disk (a stale `all` next to a
/// fresh `partitioned`, or vice versa, would silently corrupt folding).
#[derive(Serialize, Deserialize)]
struct TopicListSnapshot {
    all: Vec<String>,
    partitioned: Vec<String>,
}

#[tauri::command]
pub async fn broker_list_topics(
    connection_id: String,
    tenant: String,
    namespace: String,
    query: PageQueryDto,
    refresh: bool,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let row = load_row(&connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let conn = crate::db::open_product_db_shared()?;
    list_topics_through_cache(conn, &row, &tenant, &namespace, &query, refresh, token).await
}

/// A thin caller over `cache_read::read_through_cache`: supplies the fetch
/// future (both admin REST topic-list calls, folded into one
/// `TopicListSnapshot`) and the render closure (fold partitions + paginate)
/// that policy needs. Kept `pub` — not just called from
/// `broker_list_topics` — because `tests/broker_cache.rs` calls it directly
/// against a scratch SQLite file instead of exercising the
/// `#[tauri::command]` wrapper against the real product DB.
pub async fn list_topics_through_cache(
    conn: Connection,
    row: &ConnectionRow,
    tenant: &str,
    namespace: &str,
    query: &PageQueryDto,
    refresh: bool,
    token: Option<String>,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let scope_key = format!("{tenant}/{namespace}");
    let fetch = async {
        let (all, partitioned) = fetch_topic_lists(row, tenant, namespace, token).await?;
        Ok(TopicListSnapshot { all, partitioned })
    };
    let render = |snapshot: &TopicListSnapshot| {
        let folded = topic_folding::fold_topics(&snapshot.all, &snapshot.partitioned);
        topic_folding::paginate(folded, query)
    };
    read_through_cache(conn, row, CacheScope::Topics, &scope_key, refresh, fetch, render).await
}

/// Fetches both topic lists from the broker — a pure network call, with no
/// `Connection` parameter at all. Kept free of any cache access specifically
/// so it can be `.await`ed safely from the `fetch` future above without
/// risking the `!Send` trap described on `read_through_cache`'s doc comment.
async fn fetch_topic_lists(
    row: &ConnectionRow,
    tenant: &str,
    namespace: &str,
    token: Option<String>,
) -> Result<(Vec<String>, Vec<String>), BrokerError> {
    // Admin REST ignores paging, so fetch the full lists here; folding
    // partitions and paging happens in Rust afterward (spec V-A5 / V-A6).
    let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(
        row.admin_url.clone(),
        row.timeout_ms as u64,
        row.tls_verify,
        token,
    )?;
    match (
        admin.list_topics(tenant, namespace).await,
        admin.list_partitioned_topics(tenant, namespace).await,
    ) {
        (Ok(all), Ok(partitioned)) => Ok((all, partitioned)),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}
