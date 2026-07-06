// ---------------------------------------------------------------------------
// Registry key / value commands (Phase 3) — routed by (connectionId, db).
// All commands go through fred `custom` for predictable API behaviour and SELECT
// the requested db first so the backend holds no "current db" state (F1).
// ---------------------------------------------------------------------------

use fred::prelude::*;
use fred::types::{ClusterHash, CustomCommand};
use futures::StreamExt;
use serde::Serialize;
use tauri::State;

use super::registry::RedisRegistry;
use super::value::{
    truncate_utf8_preview, EnrichedKey, EnrichedScanPage, HashField, ListPage, StringValue,
    ZSetEntry, ZSetPage,
};

#[derive(Serialize)]
pub struct StreamEntry {
    pub id: String,
    pub fields: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct CliResult {
    pub ok: bool,
    pub output: String,
    /// True when the command is destructive and the UI must confirm before re-running.
    pub needs_confirm: bool,
}

// --- helpers --------------------------------------------------------------

async fn run(
    client: &RedisClient,
    name: &'static str,
    args: Vec<String>,
) -> Result<RedisValue, String> {
    let command = CustomCommand::new_static(name, ClusterHash::FirstKey, false);
    client.custom(command, args).await.map_err(|e| e.to_string())
}

/// SELECT the requested db. WHY: the connection may have been opened on a
/// different default db; the db always comes from the caller (tab), never state.
async fn prep(client: &RedisClient, db: u8) -> Result<(), String> {
    let command = CustomCommand::new_static("SELECT", ClusterHash::FirstKey, false);
    // WHY: ignore the error — cluster mode rejects SELECT for db != 0, which is expected.
    let _: Result<RedisValue, _> = client.custom(command, vec![db.to_string()]).await;
    Ok(())
}

fn rv_string(value: &RedisValue) -> String {
    match value {
        RedisValue::String(s) => s.to_string(),
        RedisValue::Bytes(b) => String::from_utf8_lossy(b).to_string(),
        RedisValue::Integer(i) => i.to_string(),
        RedisValue::Double(d) => d.to_string(),
        RedisValue::Boolean(b) => b.to_string(),
        _ => String::new(),
    }
}

fn rv_array(value: &RedisValue) -> Vec<RedisValue> {
    match value {
        RedisValue::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

/// redis-cli-style pretty print of a reply.
fn format_rv(value: &RedisValue) -> String {
    match value {
        RedisValue::Null => "(nil)".to_string(),
        RedisValue::Array(items) => {
            if items.is_empty() {
                return "(empty array)".to_string();
            }
            items
                .iter()
                .enumerate()
                .map(|(index, item)| format!("{}) {}", index + 1, format_rv(item)))
                .collect::<Vec<_>>()
                .join("\n")
        }
        RedisValue::String(_)
        | RedisValue::Bytes(_)
        | RedisValue::Integer(_)
        | RedisValue::Double(_)
        | RedisValue::Boolean(_) => rv_string(value),
        other => format!("{other:?}"),
    }
}

/// Split a command line into tokens, honouring double-quoted segments.
fn split_args(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    for ch in line.chars() {
        if ch == '"' {
            in_quote = !in_quote;
        } else if ch.is_whitespace() && !in_quote {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Destructive commands that need explicit confirmation (CLI guardrail — NFR).
fn is_danger(cmd_upper: &str, args: &[String]) -> bool {
    match cmd_upper {
        "FLUSHALL" | "FLUSHDB" | "SHUTDOWN" | "SWAPDB" | "MIGRATE" | "DEBUG" | "KEYS" => true,
        // WHY: CONFIG SET can break a live server; CONFIG GET is harmless.
        "CONFIG" => args
            .first()
            .map(|arg| arg.eq_ignore_ascii_case("set"))
            .unwrap_or(false),
        _ => false,
    }
}

#[tauri::command]
pub async fn reg_cli_exec(
    id: String,
    db: u8,
    line: String,
    confirmed: bool,
    registry: State<'_, RedisRegistry>,
) -> Result<CliResult, String> {
    let tokens = split_args(&line);
    if tokens.is_empty() {
        return Ok(CliResult {
            ok: false,
            output: String::new(),
            needs_confirm: false,
        });
    }
    let cmd_upper = tokens[0].to_uppercase();
    let args = tokens[1..].to_vec();

    // WHY: guard destructive commands behind an explicit confirmation round-trip.
    if is_danger(&cmd_upper, &args) && !confirmed {
        return Ok(CliResult {
            ok: false,
            output: format!("⚠️ {cmd_upper} 是危险命令，可能造成数据丢失或阻塞实例。确认后再执行。"),
            needs_confirm: true,
        });
    }

    let client = client_db(&registry, &id, db).await?;
    let command = CustomCommand::new(cmd_upper, ClusterHash::FirstKey, false);
    match client.custom::<RedisValue, _>(command, args).await {
        Ok(value) => Ok(CliResult {
            ok: true,
            output: format_rv(&value),
            needs_confirm: false,
        }),
        Err(err) => Ok(CliResult {
            ok: false,
            output: err.to_string(),
            needs_confirm: false,
        }),
    }
}

/// Client + held per-connection op lock. The lock spans SELECT and every
/// command the handler runs, so concurrent requests for different dbs can't
/// interleave on the shared connection and land on the wrong db. Derefs to
/// RedisClient so existing `run(&client, ...)` call sites are unchanged.
struct DbClient {
    client: RedisClient,
    _op_guard: tokio::sync::OwnedMutexGuard<()>,
}

impl std::ops::Deref for DbClient {
    type Target = RedisClient;
    fn deref(&self) -> &RedisClient {
        &self.client
    }
}

async fn client_db(
    registry: &State<'_, RedisRegistry>,
    id: &str,
    db: u8,
) -> Result<DbClient, String> {
    let instance = registry.instance_for(id).await?;
    let guard = instance.op_lock.clone().lock_owned().await;
    let client = instance.client.clone();
    prep(&client, db).await?;
    Ok(DbClient {
        client,
        _op_guard: guard,
    })
}

// --- key listing / metadata ----------------------------------------------

// WHY: cluster scan has no caller cursor (fred walks all nodes) — cap the page
// so a huge keyspace can't buffer unbounded in memory or block the UI. Kept low
// because each key is then enriched (TYPE+TTL) — a smaller cap returns faster.
const CLUSTER_SCAN_CAP: usize = 300;

#[tauri::command]
pub async fn reg_scan(
    id: String,
    db: u8,
    pattern: String,
    cursor: u64,
    count: u32,
    registry: State<'_, RedisRegistry>,
) -> Result<EnrichedScanPage, String> {
    let plain = registry.client_for(&id).await?;
    let pat = if pattern.trim().is_empty() {
        "*".to_string()
    } else {
        pattern
    };
    let count_u = count.max(1);

    let (names, next_cursor): (Vec<String>, u64) = if plain.is_clustered() {
        // WHY: on a cluster a raw SCAN only hits one node and cross-slot commands
        // return MOVED. fred's scan_cluster_buffered walks ALL master nodes.
        let mut collected: Vec<String> = Vec::new();
        let mut stream = Box::pin(plain.scan_cluster_buffered(pat.clone(), Some(count_u), None));
        while let Some(item) = stream.next().await {
            match item {
                Ok(key) => {
                    collected.push(key.as_str_lossy().to_string());
                    if collected.len() >= CLUSTER_SCAN_CAP {
                        break;
                    }
                }
                Err(err) => return Err(err.to_string()),
            }
        }
        (collected, 0)
    } else {
        // WHY: standalone — SELECT the db then cursor-paginate as the caller
        // drives. client_db holds the op lock across SELECT + this SCAN page.
        let client = client_db(&registry, &id, db).await?;
        let raw = run(
            &client,
            "SCAN",
            vec![
                cursor.to_string(),
                "MATCH".to_string(),
                pat,
                "COUNT".to_string(),
                count_u.to_string(),
            ],
        )
        .await?;
        let parts = rv_array(&raw);
        let mut next = 0u64;
        let mut names = Vec::new();
        if parts.len() == 2 {
            next = rv_string(&parts[0]).parse().unwrap_or(0);
            for key_value in rv_array(&parts[1]) {
                names.push(rv_string(&key_value));
            }
        }
        (names, next)
    };

    // WHY: lazy enrichment — return key NAMES immediately (instant list, even on a
    // slow remote cluster). TYPE/TTL are fetched per key on selection (reg_key_type
    // + reg_ttl), a single routed command that fred redirects correctly on cluster.
    // This fixes both the slow load AND the "type=none" that blanked value viewing.
    let keys: Vec<EnrichedKey> = names
        .into_iter()
        .map(|key| EnrichedKey {
            key,
            key_type: String::new(),
            ttl: -1,
            size_bytes: -1,
        })
        .collect();
    let scanned = keys.len();
    Ok(EnrichedScanPage {
        keys,
        next_cursor,
        done: next_cursor == 0,
        scanned,
    })
}

#[tauri::command]
pub async fn reg_key_type(
    id: String,
    db: u8,
    key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<String, String> {
    let client = client_db(&registry, &id, db).await?;
    Ok(rv_string(&run(&client, "TYPE", vec![key]).await?))
}

#[tauri::command]
pub async fn reg_ttl(
    id: String,
    db: u8,
    key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<i64, String> {
    let client = client_db(&registry, &id, db).await?;
    Ok(match run(&client, "TTL", vec![key]).await? {
        RedisValue::Integer(i) => i,
        _ => -1,
    })
}

#[tauri::command]
pub async fn reg_expire(
    id: String,
    db: u8,
    key: String,
    ttl_secs: i64,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    if ttl_secs <= 0 {
        // WHY: 0 / negative means "remove expiry" — PERSIST, not a 0-second expire.
        run(&client, "PERSIST", vec![key]).await?;
    } else {
        run(&client, "EXPIRE", vec![key, ttl_secs.to_string()]).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reg_del(
    id: String,
    db: u8,
    key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "DEL", vec![key]).await?;
    Ok(())
}

#[tauri::command]
pub async fn reg_rename(
    id: String,
    db: u8,
    key: String,
    new_key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "RENAME", vec![key, new_key]).await?;
    Ok(())
}

// --- String ---------------------------------------------------------------

#[tauri::command]
pub async fn reg_string_get(
    id: String,
    db: u8,
    key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<StringValue, String> {
    let client = client_db(&registry, &id, db).await?;
    let raw = rv_string(&run(&client, "GET", vec![key]).await?);
    let (value, truncated, total_bytes) = truncate_utf8_preview(&raw);
    Ok(StringValue {
        value,
        truncated,
        total_bytes,
    })
}

#[tauri::command]
pub async fn reg_string_set(
    id: String,
    db: u8,
    key: String,
    value: String,
    ttl_secs: Option<i64>,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    match ttl_secs {
        // WHY: no TTL passed = plain value edit — KEEPTTL preserves the key's
        // existing expiry (a bare SET silently wipes it).
        None => {
            run(&client, "SET", vec![key, value, "KEEPTTL".to_string()]).await?;
        }
        Some(ttl) if ttl > 0 => {
            run(&client, "SET", vec![key.clone(), value]).await?;
            run(&client, "EXPIRE", vec![key, ttl.to_string()]).await?;
        }
        // Explicit non-positive TTL = clear the expiry.
        Some(_) => {
            run(&client, "SET", vec![key, value]).await?;
        }
    }
    Ok(())
}

// --- Hash ------------------------------------------------------------------

#[tauri::command]
pub async fn reg_hash_getall(
    id: String,
    db: u8,
    key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<Vec<HashField>, String> {
    let client = client_db(&registry, &id, db).await?;
    let raw = rv_array(&run(&client, "HGETALL", vec![key]).await?);
    let mut fields = Vec::with_capacity(raw.len() / 2);
    let mut index = 0;
    while index + 1 < raw.len() {
        fields.push(HashField {
            field: rv_string(&raw[index]),
            value: rv_string(&raw[index + 1]),
        });
        index += 2;
    }
    Ok(fields)
}

#[tauri::command]
pub async fn reg_hash_set(
    id: String,
    db: u8,
    key: String,
    field: String,
    value: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "HSET", vec![key, field, value]).await?;
    Ok(())
}

#[tauri::command]
pub async fn reg_hash_del(
    id: String,
    db: u8,
    key: String,
    field: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "HDEL", vec![key, field]).await?;
    Ok(())
}

// --- List ------------------------------------------------------------------

#[tauri::command]
pub async fn reg_list_range(
    id: String,
    db: u8,
    key: String,
    start: i64,
    stop: i64,
    registry: State<'_, RedisRegistry>,
) -> Result<ListPage, String> {
    let client = client_db(&registry, &id, db).await?;
    let total = match run(&client, "LLEN", vec![key.clone()]).await? {
        RedisValue::Integer(i) => i,
        _ => 0,
    };
    let raw = rv_array(
        &run(
            &client,
            "LRANGE",
            vec![key, start.to_string(), stop.to_string()],
        )
        .await?,
    );
    let items = raw.iter().map(rv_string).collect();
    Ok(ListPage { items, total })
}

#[tauri::command]
pub async fn reg_list_push(
    id: String,
    db: u8,
    key: String,
    value: String,
    left: bool,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    let command = if left { "LPUSH" } else { "RPUSH" };
    run(&client, command, vec![key, value]).await?;
    Ok(())
}

#[tauri::command]
pub async fn reg_list_set(
    id: String,
    db: u8,
    key: String,
    index: i64,
    value: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "LSET", vec![key, index.to_string(), value]).await?;
    Ok(())
}

// --- Set -------------------------------------------------------------------

#[tauri::command]
pub async fn reg_set_members(
    id: String,
    db: u8,
    key: String,
    registry: State<'_, RedisRegistry>,
) -> Result<Vec<String>, String> {
    let client = client_db(&registry, &id, db).await?;
    let raw = rv_array(&run(&client, "SMEMBERS", vec![key]).await?);
    Ok(raw.iter().map(rv_string).collect())
}

#[tauri::command]
pub async fn reg_set_add(
    id: String,
    db: u8,
    key: String,
    member: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "SADD", vec![key, member]).await?;
    Ok(())
}

#[tauri::command]
pub async fn reg_set_rem(
    id: String,
    db: u8,
    key: String,
    member: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "SREM", vec![key, member]).await?;
    Ok(())
}

// --- Sorted Set ------------------------------------------------------------

#[tauri::command]
pub async fn reg_zset_range(
    id: String,
    db: u8,
    key: String,
    start: i64,
    stop: i64,
    registry: State<'_, RedisRegistry>,
) -> Result<ZSetPage, String> {
    let client = client_db(&registry, &id, db).await?;
    let total = match run(&client, "ZCARD", vec![key.clone()]).await? {
        RedisValue::Integer(i) => i,
        _ => 0,
    };
    let raw = rv_array(
        &run(
            &client,
            "ZRANGE",
            vec![
                key,
                start.to_string(),
                stop.to_string(),
                "WITHSCORES".to_string(),
            ],
        )
        .await?,
    );
    let mut entries = Vec::with_capacity(raw.len() / 2);
    let mut index = 0;
    while index + 1 < raw.len() {
        entries.push(ZSetEntry {
            member: rv_string(&raw[index]),
            score: rv_string(&raw[index + 1]).parse().unwrap_or(0.0),
        });
        index += 2;
    }
    Ok(ZSetPage { entries, total })
}

#[tauri::command]
pub async fn reg_zset_add(
    id: String,
    db: u8,
    key: String,
    member: String,
    score: f64,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "ZADD", vec![key, score.to_string(), member]).await?;
    Ok(())
}

#[tauri::command]
pub async fn reg_zset_rem(
    id: String,
    db: u8,
    key: String,
    member: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let client = client_db(&registry, &id, db).await?;
    run(&client, "ZREM", vec![key, member]).await?;
    Ok(())
}

// --- Stream ----------------------------------------------------------------

#[tauri::command]
pub async fn reg_stream_range(
    id: String,
    db: u8,
    key: String,
    count: u32,
    registry: State<'_, RedisRegistry>,
) -> Result<Vec<StreamEntry>, String> {
    let client = client_db(&registry, &id, db).await?;
    let raw = rv_array(
        &run(
            &client,
            "XRANGE",
            vec![
                key,
                "-".to_string(),
                "+".to_string(),
                "COUNT".to_string(),
                count.max(1).to_string(),
            ],
        )
        .await?,
    );
    let mut entries = Vec::with_capacity(raw.len());
    for entry in raw {
        let parts = rv_array(&entry);
        if parts.len() < 2 {
            continue;
        }
        let entry_id = rv_string(&parts[0]);
        let field_values = rv_array(&parts[1]);
        let mut fields = Vec::with_capacity(field_values.len() / 2);
        let mut index = 0;
        while index + 1 < field_values.len() {
            fields.push((
                rv_string(&field_values[index]),
                rv_string(&field_values[index + 1]),
            ));
            index += 2;
        }
        entries.push(StreamEntry {
            id: entry_id,
            fields,
        });
    }
    Ok(entries)
}

// --- Slow Log + Publish (Phase 4) -----------------------------------------

#[derive(Serialize)]
pub struct SlowLogEntry {
    pub id: i64,
    pub timestamp: i64,
    pub duration_us: i64,
    pub command: String,
    pub client: String,
}

#[tauri::command]
pub async fn reg_slowlog(
    id: String,
    count: u32,
    registry: State<'_, RedisRegistry>,
) -> Result<Vec<SlowLogEntry>, String> {
    let client = registry.client_for(&id).await?;
    let raw = rv_array(
        &run(
            &client,
            "SLOWLOG",
            vec!["GET".to_string(), count.max(1).to_string()],
        )
        .await?,
    );
    let mut out = Vec::with_capacity(raw.len());
    for entry in raw {
        // SLOWLOG GET row: [id, timestamp, exec_time_us, [args...], addr, name]
        let parts = rv_array(&entry);
        if parts.len() < 4 {
            continue;
        }
        let entry_id = match &parts[0] {
            RedisValue::Integer(i) => *i,
            _ => 0,
        };
        let timestamp = match &parts[1] {
            RedisValue::Integer(i) => *i,
            _ => 0,
        };
        let duration_us = match &parts[2] {
            RedisValue::Integer(i) => *i,
            _ => 0,
        };
        let command = rv_array(&parts[3])
            .iter()
            .map(rv_string)
            .collect::<Vec<_>>()
            .join(" ");
        // parts[4] = client addr "ip:port" (present on Redis >= 4); may be absent.
        let client = parts.get(4).map(rv_string).unwrap_or_default();
        out.push(SlowLogEntry {
            id: entry_id,
            timestamp,
            duration_us,
            command,
            client,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn reg_publish(
    id: String,
    channel: String,
    message: String,
    registry: State<'_, RedisRegistry>,
) -> Result<i64, String> {
    let client = registry.client_for(&id).await?;
    let value = run(&client, "PUBLISH", vec![channel, message]).await?;
    Ok(match value {
        RedisValue::Integer(i) => i,
        _ => 0,
    })
}
