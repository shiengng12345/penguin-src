use fred::prelude::*;
use fred::types::{ClusterHash, CustomCommand, InfoKind, Scanner, ZRange, ZSort};
use futures::StreamExt;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::connection::{
    db_delete_connection, db_get_connection_config, db_list_connections, db_save_connection,
    SavedConnection,
};
use super::stats::{parse_info, RedisStats};
use super::value::*;

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct RedisState {
    pub client: Arc<Mutex<Option<RedisClient>>>,
    pub stats_cancel: Arc<Mutex<Option<CancellationToken>>>,
}

impl Default for RedisState {
    fn default() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            stats_cancel: Arc::new(Mutex::new(None)),
        }
    }
}

// ---------------------------------------------------------------------------
// Helper — borrow the client inside a closure
// ---------------------------------------------------------------------------

async fn with_client<F, Fut, T>(state: &State<'_, RedisState>, f: F) -> Result<T, String>
where
    F: FnOnce(RedisClient) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let guard = state.client.lock().await;
    match guard.as_ref() {
        Some(c) => f(c.clone()).await,
        None => Err("Not connected to Redis — please connect first.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct ConnectResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn redis_connect(
    host: String,
    port: u16,
    password: String,
    db: u8,
    state: State<'_, RedisState>,
) -> Result<ConnectResult, String> {
    connect_to_redis(host, port, password, db, state).await
}

async fn connect_to_redis(
    host: String,
    port: u16,
    password: String,
    db: u8,
    state: State<'_, RedisState>,
) -> Result<ConnectResult, String> {
    // Tear down any existing connection first.
    {
        let mut guard = state.client.lock().await;
        if let Some(old) = guard.take() {
            let _ = old.quit().await;
        }
    }

    let config = RedisConfig {
        server: ServerConfig::new_centralized(&host, port),
        password: if password.is_empty() {
            None
        } else {
            Some(password)
        },
        database: Some(db),
        ..Default::default()
    };

    let client = Builder::from_config(config)
        .build()
        .map_err(|e| e.to_string())?;

    let t0 = Instant::now();
    client.init().await.map_err(|e| e.to_string())?;

    match client.ping::<()>().await {
        Ok(_) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            *state.client.lock().await = Some(client);
            Ok(ConnectResult {
                ok: true,
                latency_ms,
                error: None,
            })
        }
        Err(e) => {
            let _ = client.quit().await;
            Ok(ConnectResult {
                ok: false,
                latency_ms: 0,
                error: Some(e.to_string()),
            })
        }
    }
}

#[tauri::command]
pub async fn redis_connect_saved(
    id: String,
    state: State<'_, RedisState>,
) -> Result<ConnectResult, String> {
    let config = db_get_connection_config(&id)?;
    connect_to_redis(config.host, config.port, config.password, config.db, state).await
}

#[tauri::command]
pub async fn redis_disconnect(state: State<'_, RedisState>) -> Result<(), String> {
    if let Some(c) = state.client.lock().await.take() {
        let _ = c.quit().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn redis_ping(state: State<'_, RedisState>) -> Result<u64, String> {
    with_client(&state, |c| async move {
        let t0 = Instant::now();
        c.ping::<()>().await.map_err(|e| e.to_string())?;
        Ok(t0.elapsed().as_millis() as u64)
    })
    .await
}

// ---------------------------------------------------------------------------
// Saved connections (SQLite)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn redis_save_connection(
    label: String,
    host: String,
    port: u16,
    db: u8,
    password: String,
) -> Result<String, String> {
    db_save_connection(&label, &host, port, db, &password)
}

#[tauri::command]
pub fn redis_list_connections() -> Result<Vec<SavedConnection>, String> {
    db_list_connections()
}

#[tauri::command]
pub fn redis_delete_connection(id: String) -> Result<(), String> {
    db_delete_connection(&id)
}

// ---------------------------------------------------------------------------
// Key browser
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_scan(
    pattern: String,
    count: Option<u32>,
    state: State<'_, RedisState>,
) -> Result<ScanPage, String> {
    let count = count.unwrap_or(200);
    with_client(&state, |c| async move {
        let mut stream = c.scan(pattern, Some(count), None);
        let mut all_keys: Vec<String> = Vec::new();
        let mut next_cursor: u64 = 0;
        let mut done = true;

        if let Some(page) = stream.next().await {
            let page = page.map_err(|e| e.to_string())?;
            done = !page.has_more();
            if let Some(cursor_str) = page.cursor() {
                next_cursor = cursor_str.parse().unwrap_or(0);
            }
            if let Some(keys) = page.results() {
                for k in keys {
                    if let Some(s) = k.as_str() {
                        all_keys.push(s.to_string());
                    }
                }
            }
        }
        Ok(ScanPage {
            keys: all_keys,
            next_cursor,
            done,
        })
    })
    .await
}

// Redis Insight-style enriched SCAN. Uses a RAW `SCAN <cursor> MATCH ..
// COUNT .. [TYPE ..]` (via custom command) so we get true cursor-based
// paging + server-side type filtering, then pipelines TYPE + TTL +
// MEMORY USAGE for every key in the page so the FE can render the
// Type / Key / TTL / Size columns without N extra round trips.
#[tauri::command]
pub async fn redis_scan_enriched(
    pattern: String,
    cursor: u64,
    count: Option<u32>,
    type_filter: Option<String>,
    state: State<'_, RedisState>,
) -> Result<EnrichedScanPage, String> {
    let count = count.unwrap_or(100);
    with_client(&state, |c| async move {
        // 1. Raw SCAN with explicit cursor (+ optional TYPE filter).
        let mut args: Vec<String> = vec![
            cursor.to_string(),
            "MATCH".to_string(),
            pattern,
            "COUNT".to_string(),
            count.to_string(),
        ];
        if let Some(t) = type_filter
            .as_ref()
            .filter(|s| !s.is_empty() && *s != "all")
        {
            args.push("TYPE".to_string());
            args.push(t.clone());
        }
        let cmd = CustomCommand::new_static("SCAN", ClusterHash::FirstKey, false);
        let raw: RedisValue = c.custom(cmd, args).await.map_err(|e| e.to_string())?;

        // SCAN reply shape: [ cursor_string, [ key, key, ... ] ]
        let mut next_cursor: u64 = 0;
        let mut keys: Vec<String> = Vec::new();
        if let RedisValue::Array(parts) = raw {
            if let Some(cur) = parts.first().and_then(|v| v.as_str()) {
                next_cursor = cur.parse().unwrap_or(0);
            }
            if let Some(RedisValue::Array(arr)) = parts.get(1) {
                for k in arr {
                    if let Some(s) = k.as_str() {
                        keys.push(s.to_string());
                    }
                }
            }
        }
        let scanned = keys.len();
        let done = next_cursor == 0;

        // 2. Pipeline TYPE + TTL + MEMORY USAGE for every key (one round trip).
        let enriched: Vec<EnrichedKey> = if keys.is_empty() {
            Vec::new()
        } else {
            let pipe = c.pipeline();
            for k in &keys {
                // Each await QUEUES the command on the pipeline (returns the
                // "queued" marker, not the value). try_all() below executes
                // the batch in a single round trip.
                let _: Result<(), _> = pipe.r#type(k).await;
                let _: Result<(), _> = pipe.ttl(k).await;
                let _: Result<(), _> = pipe.memory_usage(k, None).await;
            }
            // try_all isolates per-command errors (a key expiring between SCAN
            // and MEMORY USAGE just yields Null → size -1, not a whole-page abort).
            let results: Vec<RedisValue> = pipe
                .try_all::<RedisValue>()
                .await
                .into_iter()
                .map(|r| r.unwrap_or(RedisValue::Null))
                .collect();
            // results is flat: [type0, ttl0, mem0, type1, ttl1, mem1, ...]
            keys.iter()
                .enumerate()
                .map(|(i, key)| {
                    let base = i * 3;
                    let key_type = results
                        .get(base)
                        .and_then(|v| v.as_str())
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "none".to_string());
                    let ttl = results.get(base + 1).and_then(|v| v.as_i64()).unwrap_or(-1);
                    let size_bytes = results.get(base + 2).and_then(|v| v.as_i64()).unwrap_or(-1);
                    EnrichedKey {
                        key: key.clone(),
                        key_type,
                        ttl,
                        size_bytes,
                    }
                })
                .collect()
        };

        Ok(EnrichedScanPage {
            keys: enriched,
            next_cursor,
            done,
            scanned,
        })
    })
    .await
}

#[tauri::command]
pub async fn redis_dbsize(state: State<'_, RedisState>) -> Result<u64, String> {
    with_client(&state, |c| async move {
        let n: u64 = c.dbsize().await.map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await
}

#[tauri::command]
pub async fn redis_key_type(key: String, state: State<'_, RedisState>) -> Result<String, String> {
    with_client(&state, |c| async move {
        let t: String = c.r#type(&key).await.map_err(|e| e.to_string())?;
        Ok(t)
    })
    .await
}

#[tauri::command]
pub async fn redis_key_ttl(key: String, state: State<'_, RedisState>) -> Result<i64, String> {
    with_client(&state, |c| async move {
        let ttl: i64 = c.ttl(&key).await.map_err(|e| e.to_string())?;
        Ok(ttl)
    })
    .await
}

#[tauri::command]
pub async fn redis_del_keys(
    keys: Vec<String>,
    state: State<'_, RedisState>,
) -> Result<u64, String> {
    with_client(&state, |c| async move {
        let n: u64 = c.del(keys).await.map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await
}

#[tauri::command]
pub async fn redis_rename_key(
    old_key: String,
    new_key: String,
    state: State<'_, RedisState>,
) -> Result<(), String> {
    with_client(&state, |c| async move {
        c.rename(&old_key, &new_key)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn redis_expire_key(
    key: String,
    ttl_secs: i64,
    state: State<'_, RedisState>,
) -> Result<(), String> {
    with_client(&state, |c| async move {
        let result: Result<(), String> = if ttl_secs <= 0 {
            c.persist::<(), _>(&key).await.map_err(|e| e.to_string())
        } else {
            c.expire::<(), _>(&key, ttl_secs)
                .await
                .map_err(|e| e.to_string())
        };
        result
    })
    .await
}

// ---------------------------------------------------------------------------
// Value — String
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_string_get(
    key: String,
    state: State<'_, RedisState>,
) -> Result<StringValue, String> {
    with_client(&state, |c| async move {
        let strlen_cmd = CustomCommand::new_static("STRLEN", ClusterHash::FirstKey, false);
        let total_raw: RedisValue = c
            .custom(strlen_cmd, vec![key.clone()])
            .await
            .map_err(|e| e.to_string())?;
        let total_bytes = total_raw.as_usize().unwrap_or(0);

        let getrange_cmd = CustomCommand::new_static("GETRANGE", ClusterHash::FirstKey, false);
        let preview_raw: RedisValue = c
            .custom(
                getrange_cmd,
                vec![
                    key.clone(),
                    "0".to_string(),
                    VALUE_PREVIEW_BYTES.saturating_sub(1).to_string(),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        let preview = preview_raw
            .as_str_lossy()
            .map(|s| s.into_owned())
            .unwrap_or_default();
        let (value, _, _) = truncate_utf8_preview(&preview);
        let truncated = total_bytes > value.len();
        Ok(StringValue {
            value,
            truncated,
            total_bytes,
        })
    })
    .await
}

#[tauri::command]
pub async fn redis_string_set(
    key: String,
    value: String,
    ttl_secs: Option<i64>,
    state: State<'_, RedisState>,
) -> Result<(), String> {
    with_client(&state, |c| async move {
        // WHY: None = value-only edit → KEEPTTL preserves the existing expiry
        // (a bare SET silently wipes it); non-positive TTL = explicit clear.
        let exp = match ttl_secs {
            Some(t) if t > 0 => Some(Expiration::EX(t)),
            Some(_) => None,
            None => Some(Expiration::KEEPTTL),
        };
        c.set::<(), _, _>(&key, value, exp, None, false)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------------------
// Value — Hash
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_hash_getall(
    key: String,
    state: State<'_, RedisState>,
) -> Result<Vec<HashField>, String> {
    let page = redis_hash_scan(key, 0, Some(200), state).await?;
    Ok(page.fields)
}

#[tauri::command]
pub async fn redis_hash_scan(
    key: String,
    cursor: u64,
    count: Option<u32>,
    state: State<'_, RedisState>,
) -> Result<HashPage, String> {
    let count = count.unwrap_or(100);
    with_client(&state, |c| async move {
        let args: Vec<String> = vec![
            key.clone(),
            cursor.to_string(),
            "MATCH".to_string(),
            "*".to_string(),
            "COUNT".to_string(),
            count.to_string(),
        ];
        let cmd = CustomCommand::new_static("HSCAN", ClusterHash::FirstKey, false);
        let raw: RedisValue = c.custom(cmd, args).await.map_err(|e| e.to_string())?;
        let mut fields: Vec<HashField> = Vec::new();
        let mut next_cursor: u64 = 0;

        if let RedisValue::Array(parts) = raw {
            if let Some(cursor_str) = parts.first().and_then(|v| v.as_str()) {
                next_cursor = cursor_str.parse().unwrap_or(0);
            }
            if let Some(RedisValue::Array(items)) = parts.get(1) {
                let mut iter = items.iter();
                while let (Some(field), Some(value)) = (iter.next(), iter.next()) {
                    let field = field
                        .as_str_lossy()
                        .map(|s| s.into_owned())
                        .unwrap_or_default();
                    let value = value
                        .as_str_lossy()
                        .map(|s| s.into_owned())
                        .unwrap_or_default();
                    fields.push(HashField { field, value });
                }
            }
        }

        let total: i64 = c.hlen(&key).await.map_err(|e| e.to_string())?;
        Ok(HashPage {
            fields,
            total,
            next_cursor,
        })
    })
    .await
}

#[tauri::command]
pub async fn redis_hash_set(
    key: String,
    field: String,
    value: String,
    state: State<'_, RedisState>,
) -> Result<(), String> {
    with_client(&state, |c| async move {
        c.hset::<(), _, _>(&key, vec![(field.as_str(), value.as_str())])
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn redis_hash_del(
    key: String,
    field: String,
    state: State<'_, RedisState>,
) -> Result<(), String> {
    with_client(&state, |c| async move {
        c.hdel::<(), _, _>(&key, field.as_str())
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------------------
// Value — List (read-only this sprint)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_list_range(
    key: String,
    start: i64,
    stop: i64,
    state: State<'_, RedisState>,
) -> Result<ListPage, String> {
    with_client(&state, |c| async move {
        let items: Vec<String> = c
            .lrange(&key, start, stop)
            .await
            .map_err(|e| e.to_string())?;
        let total: i64 = c.llen(&key).await.map_err(|e| e.to_string())?;
        Ok(ListPage { items, total })
    })
    .await
}

// ---------------------------------------------------------------------------
// Value — Set (read-only this sprint)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_set_members(
    key: String,
    cursor: u64,
    count: Option<u32>,
    state: State<'_, RedisState>,
) -> Result<SetPage, String> {
    let count = count.unwrap_or(100);
    with_client(&state, |c| async move {
        let args: Vec<String> = vec![
            key.clone(),
            cursor.to_string(),
            "MATCH".to_string(),
            "*".to_string(),
            "COUNT".to_string(),
            count.to_string(),
        ];
        let cmd = CustomCommand::new_static("SSCAN", ClusterHash::FirstKey, false);
        let raw: RedisValue = c.custom(cmd, args).await.map_err(|e| e.to_string())?;
        let mut all_members: Vec<String> = Vec::new();
        let mut next_cursor: u64 = 0;

        if let RedisValue::Array(parts) = raw {
            if let Some(cursor_str) = parts.first().and_then(|v| v.as_str()) {
                next_cursor = cursor_str.parse().unwrap_or(0);
            }
            if let Some(RedisValue::Array(members)) = parts.get(1) {
                for m in members {
                    if let Some(s) = m.as_str() {
                        all_members.push(s.to_string());
                    }
                }
            }
        }
        Ok(SetPage {
            members: all_members,
            next_cursor,
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Value — ZSet (read-only this sprint)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_zset_range(
    key: String,
    start: i64,
    stop: i64,
    state: State<'_, RedisState>,
) -> Result<ZSetPage, String> {
    with_client(&state, |c| async move {
        let raw: Vec<(String, f64)> = c
            .zrange(
                &key,
                ZRange::from(start),
                ZRange::from(stop),
                None::<ZSort>,
                false,
                None,
                true,
            )
            .await
            .map_err(|e| e.to_string())?;
        let total: i64 = c.zcard(&key).await.map_err(|e| e.to_string())?;
        let entries = raw
            .into_iter()
            .map(|(member, score)| ZSetEntry { member, score })
            .collect();
        Ok(ZSetPage { entries, total })
    })
    .await
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_info(state: State<'_, RedisState>) -> Result<RedisStats, String> {
    with_client(&state, |c| async move {
        let raw: String = c
            .info(Some(InfoKind::All))
            .await
            .map_err(|e| e.to_string())?;
        Ok(parse_info(&raw))
    })
    .await
}

#[tauri::command]
pub async fn redis_stats_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RedisState>,
) -> Result<(), String> {
    // Cancel any running stats task first.
    {
        let mut guard = state.stats_cancel.lock().await;
        if let Some(token) = guard.take() {
            token.cancel();
        }
    }

    let token = CancellationToken::new();
    let child = token.child_token();
    *state.stats_cancel.lock().await = Some(token);

    let client_arc = state.client.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tokio::select! {
                _ = child.cancelled() => break,
                _ = interval.tick() => {
                    let guard = client_arc.lock().await;
                    if let Some(c) = guard.as_ref() {
                        if let Ok(raw) = c.info::<String>(Some(InfoKind::All)).await {
                            let stats = parse_info(&raw);
                            let _ = app.emit("redis-stats-update", &stats);
                        }
                    }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn redis_stats_stop(state: State<'_, RedisState>) -> Result<(), String> {
    if let Some(token) = state.stats_cancel.lock().await.take() {
        token.cancel();
    }
    Ok(())
}
