// ---------------------------------------------------------------------------
// Multi-connection registry + MONITOR spike (Foundation vertical slice)
//
// This module is the prototype for the Tiny-RDM-parity rebuild. It proves three
// foundation decisions WITHOUT disturbing the existing single-connection module:
//   F1  multiple live connections held in a registry keyed by ConnectionId,
//       each cloned out under a SHORT read lock (the fred client is Clone +
//       internally Arc) so a long SCAN on one tab never blocks another.
//   F3  MONITOR runs on a DEDICATED raw-TCP bypass connection while the fred
//       command pool keeps serving normal commands concurrently.
//       SPIKE FINDING: fred 9's native `monitor` feature does NOT compile with
//       `enable-rustls-ring` (fred's monitor/utils.rs has a non-exhaustive match
//       missing ConnectionKind::Rustls). So we keep rustls for the main client
//       and isolate MONITOR on a hand-rolled RESP reader over tokio TcpStream —
//       exactly the "side connection, main architecture untouched" fallback.
//       (Limitation: this bypass is plaintext TCP; TLS MONITOR would need a
//       rustls stream — deferred, not needed for the prototype.)
//   db-per-request routing: every routed command takes (connectionId, db) and
//       SELECTs explicitly — the backend keeps NO "current db" state of its own.
// ---------------------------------------------------------------------------

use super::connection::{
    db_create_group, db_delete_connection, db_delete_group, db_get_connection_full,
    db_list_connections_full, db_list_groups, db_load_connection_password,
    db_save_connection_full, SaveConnectionInput, SavedConnectionFull,
};
use super::stats::{parse_info, RedisStats};
use fred::prelude::*;
use fred::types::{ClusterHash, CustomCommand, Server, TlsConnector};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

/// One live connection. Holds the fred client (cheap to clone out) plus the
/// centralized config so MONITOR can spin its own dedicated connection.
pub struct ConnectionInstance {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    /// Effective dial address for the bypass connections (MONITOR / Pub-Sub).
    /// Differs from `host`/`port` when an SSH tunnel rewrites the target —
    /// dialing the raw address would bypass the tunnel and hang.
    pub bypass_host: String,
    pub bypass_port: u16,
    pub client: RedisClient,
    pub config: RedisConfig,
    /// Per-connection MONITOR cancellation. `None` = not monitoring. Arc so
    /// the stream task can identity-check (`Arc::ptr_eq`) before clearing —
    /// a stop+start pair may already have installed a fresh token.
    pub monitor_cancel: RwLock<Option<Arc<CancellationToken>>>,
    /// Per-connection Pub/Sub subscription cancellation. `None` = not subscribed.
    pub pubsub_cancel: RwLock<Option<Arc<CancellationToken>>>,
    /// Serializes SELECT+command sequences on the shared fred connection so
    /// two tabs on different dbs can't interleave and land on the wrong db.
    /// Held per command batch (SELECT + the command), not per long scan.
    pub op_lock: Arc<Mutex<()>>,
    /// Live SSH tunnel backing this connection (`None` = direct). Must be
    /// shut down wherever the instance is removed, or the ssh process leaks.
    pub ssh_tunnel: Mutex<Option<super::ssh_tunnel::SshTunnel>>,
}

/// Multi-connection registry — replaces the single-connection global model.
/// The map lock only guards instance add/remove + lookup; the fred client is
/// cloned out under a short read lock so a long SCAN never blocks other tabs.
#[derive(Default)]
pub struct RedisRegistry {
    instances: RwLock<HashMap<String, Arc<ConnectionInstance>>>,
}

impl RedisRegistry {
    /// Clone the fred client for a connection (used by the keys module).
    pub async fn client_for(&self, id: &str) -> Result<RedisClient, String> {
        self.get(id).await.map(|instance| instance.client.clone())
    }

    /// Arc out the full instance — for db-routed commands that must hold the
    /// per-connection `op_lock` across SELECT + command.
    pub async fn instance_for(&self, id: &str) -> Result<Arc<ConnectionInstance>, String> {
        self.get(id).await
    }

    async fn get(&self, id: &str) -> Result<Arc<ConnectionInstance>, String> {
        // WHY: clone the Arc out under a short read lock, then release — the
        // caller runs its (possibly long) command without holding the map lock.
        let guard = self.instances.read().await;
        match guard.get(id) {
            Some(inst) => Ok(inst.clone()),
            None => Err(format!("connection not found: {id}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Advanced connection config — deployment (standalone/sentinel/cluster) + TLS
// Parsed from the connection's opaque `config_json`. (Phase 2a)
// ---------------------------------------------------------------------------

#[derive(Default, serde::Deserialize)]
struct NodeOpt {
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: u16,
}

#[derive(Default, serde::Deserialize)]
struct TlsOpt {
    #[serde(default)]
    enabled: bool,
}

#[derive(Default, serde::Deserialize)]
struct SentinelOpt {
    #[serde(default)]
    master: String,
    #[serde(default)]
    nodes: Vec<NodeOpt>,
    // Retained for the connection config contract — the UI sends a sentinel
    // password, but fred 9.4 only exposes Sentinel-node auth behind the
    // `sentinel-auth` cargo feature (not enabled here; see RISKS #15 — fred
    // feature flags have conflicted with `enable-rustls-ring`). Wiring is
    // deferred until that feature is enabled, so this field is intentionally
    // unread for now (data-node auth still uses the top-level `password`).
    #[serde(default)]
    #[allow(dead_code)]
    password: String,
}

#[derive(Default, serde::Deserialize)]
struct ClusterOpt {
    #[serde(default)]
    nodes: Vec<NodeOpt>,
}

#[derive(Default, serde::Deserialize)]
struct SshOpt {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    username: String,
    /// "password" | "key"
    #[serde(default)]
    auth_type: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    key_path: String,
}

#[derive(Default, serde::Deserialize)]
struct AdvancedConfig {
    #[serde(default)]
    deployment: String,
    #[serde(default)]
    tls: TlsOpt,
    #[serde(default)]
    sentinel: SentinelOpt,
    #[serde(default)]
    cluster: ClusterOpt,
    #[serde(default)]
    ssh: SshOpt,
}

/// Build a fred RedisConfig from the stored fields + advanced `config_json`.
/// Shared by open + test so both honour deployment mode and TLS identically.
fn build_redis_config(
    host: &str,
    port: u16,
    db: u8,
    username: &str,
    password: &str,
    config_json: &str,
) -> Result<RedisConfig, String> {
    let raw = if config_json.trim().is_empty() {
        "{}"
    } else {
        config_json
    };
    let adv: AdvancedConfig = serde_json::from_str(raw).map_err(|e| e.to_string())?;

    let server = match adv.deployment.as_str() {
        "sentinel" => {
            let mut hosts: Vec<Server> = adv
                .sentinel
                .nodes
                .iter()
                .filter(|node| !node.host.is_empty())
                .map(|node| Server::new(node.host.clone(), node.port))
                .collect();
            // WHY: fall back to the primary host as the single sentinel seed.
            if hosts.is_empty() {
                hosts.push(Server::new(host.to_string(), port));
            }
            // NOTE: fred 9.4 Sentinel variant only carries hosts + service_name.
            // Sentinel-specific auth (separate from data-node password) is a later
            // refinement; the connection password still applies to the data nodes.
            ServerConfig::Sentinel {
                hosts,
                service_name: if adv.sentinel.master.is_empty() {
                    "mymaster".to_string()
                } else {
                    adv.sentinel.master.clone()
                },
            }
        }
        "cluster" => {
            let mut nodes: Vec<(String, u16)> = adv
                .cluster
                .nodes
                .iter()
                .filter(|node| !node.host.is_empty())
                .map(|node| (node.host.clone(), node.port))
                .collect();
            // WHY: one reachable seed is enough — fred discovers the rest via CLUSTER NODES.
            if nodes.is_empty() {
                nodes.push((host.to_string(), port));
            }
            ServerConfig::new_clustered(nodes)
        }
        _ => ServerConfig::new_centralized(host, port),
    };

    // WHY: default rustls TLS (system roots) when enabled. Custom CA / mTLS /
    // skip-verify need a hand-built rustls connector — deferred to a later pass.
    let tls = if adv.tls.enabled {
        Some(TlsConnector::default_rustls().map_err(|e| e.to_string())?.into())
    } else {
        None
    };

    Ok(RedisConfig {
        server,
        username: if username.is_empty() {
            None
        } else {
            Some(username.to_string())
        },
        password: if password.is_empty() {
            None
        } else {
            Some(password.to_string())
        },
        database: Some(db),
        tls,
        ..Default::default()
    })
}

// ---------------------------------------------------------------------------
// Connect / list / disconnect
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct RegistryConnectResult {
    pub ok: bool,
    pub id: String,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LiveConnection {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
}

#[tauri::command]
pub async fn redis_reg_connect(
    id: String,
    label: String,
    host: String,
    port: u16,
    password: String,
    db: u8,
    registry: State<'_, RedisRegistry>,
) -> Result<RegistryConnectResult, String> {
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

    let client = Builder::from_config(config.clone())
        .build()
        .map_err(|e| e.to_string())?;

    let t0 = Instant::now();
    client.init().await.map_err(|e| e.to_string())?;

    match client.ping::<()>().await {
        Ok(_) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            let instance = Arc::new(ConnectionInstance {
                id: id.clone(),
                label,
                // Legacy ad-hoc connect has no SSH config — bypass = raw address.
                bypass_host: host.clone(),
                bypass_port: port,
                host,
                port,
                client,
                config,
                monitor_cancel: RwLock::new(None),
                pubsub_cancel: RwLock::new(None),
                op_lock: Arc::new(Mutex::new(())),
                ssh_tunnel: Mutex::new(None),
            });
            registry
                .instances
                .write()
                .await
                .insert(id.clone(), instance);
            Ok(RegistryConnectResult {
                ok: true,
                id,
                latency_ms,
                error: None,
            })
        }
        Err(e) => {
            // WHY: ping failed — tear the half-open client down, do not register it.
            let _ = client.quit().await;
            Ok(RegistryConnectResult {
                ok: false,
                id,
                latency_ms: 0,
                error: Some(e.to_string()),
            })
        }
    }
}

#[tauri::command]
pub async fn redis_reg_list(
    registry: State<'_, RedisRegistry>,
) -> Result<Vec<LiveConnection>, String> {
    let guard = registry.instances.read().await;
    let list = guard
        .values()
        .map(|inst| LiveConnection {
            id: inst.id.clone(),
            label: inst.label.clone(),
            host: inst.host.clone(),
            port: inst.port,
        })
        .collect();
    Ok(list)
}

#[tauri::command]
pub async fn redis_reg_disconnect(
    id: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    // WHY: explicit disconnect (no auto-GC) — remove from map, stop MONITOR, quit.
    let removed = registry.instances.write().await.remove(&id);
    match removed {
        Some(inst) => {
            if let Some(token) = inst.monitor_cancel.write().await.take() {
                token.cancel();
            }
            if let Some(token) = inst.pubsub_cancel.write().await.take() {
                token.cancel();
            }
            let _ = inst.client.quit().await;
            shutdown_tunnel(inst.ssh_tunnel.lock().await.take()).await;
            Ok(())
        }
        None => {
            // WHY: not found is non-fatal — the connection is already gone.
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Import / Export connection config (Phase 7) — metadata only, no secrets.
// WHY: passwords live in the OS keychain and are never exported; importing a
// bundle re-creates connections/groups and the user re-enters passwords.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ExportedConnection {
    pub label: String,
    pub group_name: String,
    pub conn_type: String,
    pub host: String,
    pub port: u16,
    pub db: u8,
    pub username: String,
    pub config_json: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ExportBundle {
    pub groups: Vec<String>,
    pub connections: Vec<ExportedConnection>,
}

#[tauri::command]
pub async fn redis_conn_export() -> Result<String, String> {
    let connections = db_list_connections_full()?
        .into_iter()
        .map(|c| ExportedConnection {
            label: c.label,
            group_name: c.group_name,
            conn_type: c.conn_type,
            host: c.host,
            port: c.port,
            db: c.db,
            username: c.username,
            config_json: c.config_json,
        })
        .collect();
    let bundle = ExportBundle {
        groups: db_list_groups()?,
        connections,
    };
    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn redis_conn_import(payload: String) -> Result<usize, String> {
    let bundle: ExportBundle = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    for group in &bundle.groups {
        // WHY: pre-create groups so connections can reference them; ignore dup errors.
        let _ = db_create_group(group);
    }
    let mut imported = 0usize;
    for connection in bundle.connections {
        db_save_connection_full(SaveConnectionInput {
            id: None,
            label: connection.label,
            group_name: connection.group_name,
            conn_type: connection.conn_type,
            host: connection.host,
            port: connection.port,
            db: connection.db,
            username: connection.username,
            password: None,
            config_json: connection.config_json,
        })?;
        imported += 1;
    }
    Ok(imported)
}

// ---------------------------------------------------------------------------
// Connection Manager — persisted address book (groups + saved connections)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_conn_list_full() -> Result<Vec<SavedConnectionFull>, String> {
    db_list_connections_full()
}

#[tauri::command]
pub async fn redis_group_list() -> Result<Vec<String>, String> {
    db_list_groups()
}

#[tauri::command]
pub async fn redis_group_create(name: String) -> Result<(), String> {
    db_create_group(&name)
}

#[tauri::command]
pub async fn redis_group_delete(name: String) -> Result<(), String> {
    db_delete_group(&name)
}

#[tauri::command]
pub async fn redis_conn_save(input: SaveConnectionInput) -> Result<String, String> {
    db_save_connection_full(input)
}

#[tauri::command]
pub async fn redis_conn_delete(
    id: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    // WHY: if the saved connection is currently open, tear the live instance down too.
    let removed = registry.instances.write().await.remove(&id);
    if let Some(instance) = removed {
        if let Some(token) = instance.monitor_cancel.write().await.take() {
            token.cancel();
        }
        if let Some(token) = instance.pubsub_cancel.write().await.take() {
            token.cancel();
        }
        let _ = instance.client.quit().await;
        shutdown_tunnel(instance.ssh_tunnel.lock().await.take()).await;
    }
    db_delete_connection(&id)
}

#[tauri::command]
pub async fn redis_conn_open(
    id: String,
    registry: State<'_, RedisRegistry>,
) -> Result<RegistryConnectResult, String> {
    let full = db_get_connection_full(&id)?;
    let password = db_load_connection_password(&id)?.unwrap_or_default();

    let (host, port, tunnel) =
        resolve_ssh_tunnel(&full.host, full.port, &full.config_json).await?;
    let config = match build_redis_config(
        &host,
        port,
        full.db,
        &full.username,
        &password,
        &full.config_json,
    ) {
        Ok(config) => config,
        Err(err) => {
            shutdown_tunnel(tunnel).await;
            return Err(err);
        }
    };
    connect_and_register(
        &registry,
        full.id.clone(),
        full.label,
        full.host.clone(),
        full.port,
        host,
        port,
        config,
        tunnel,
    )
    .await
}

/// If the connection's advanced config enables SSH, start a tunnel and return
/// the rewritten (host, port) plus the live tunnel handle. The caller owns the
/// tunnel and must shut it down when the connection closes or fails to open.
async fn resolve_ssh_tunnel(
    host: &str,
    port: u16,
    config_json: &str,
) -> Result<(String, u16, Option<super::ssh_tunnel::SshTunnel>), String> {
    let adv = serde_json::from_str::<AdvancedConfig>(config_json).unwrap_or_default();
    if !adv.ssh.enabled || adv.ssh.host.is_empty() {
        return Ok((host.to_string(), port, None));
    }
    let ssh_cfg = super::ssh_tunnel::SshConfig {
        host: adv.ssh.host,
        port: adv.ssh.port,
        username: adv.ssh.username,
        auth_type: adv.ssh.auth_type,
        password: adv.ssh.password,
        key_path: adv.ssh.key_path,
    };
    let tunnel = super::ssh_tunnel::start_tunnel(&ssh_cfg, host, port).await?;
    let local_port = tunnel.local_port;
    Ok(("127.0.0.1".to_string(), local_port, Some(tunnel)))
}

async fn shutdown_tunnel(tunnel: Option<super::ssh_tunnel::SshTunnel>) {
    if let Some(t) = tunnel {
        t.shutdown().await;
    }
}

#[derive(serde::Deserialize)]
pub struct TestConnectionInput {
    pub host: String,
    pub port: u16,
    pub db: u8,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub config_json: String,
}

#[tauri::command]
pub async fn redis_conn_test(
    input: TestConnectionInput,
) -> Result<RegistryConnectResult, String> {
    // WHY: test must exercise the same SSH path as open — a tunnel-only Redis
    // would otherwise fail "Test" yet succeed "Open". The throwaway tunnel is
    // torn down after the ping regardless of outcome.
    let (host, port, tunnel) =
        resolve_ssh_tunnel(&input.host, input.port, &input.config_json).await?;
    let outcome = async {
        let config = build_redis_config(
            &host,
            port,
            input.db,
            &input.username,
            &input.password,
            &input.config_json,
        )?;
        let client = Builder::from_config(config)
            .build()
            .map_err(|e| e.to_string())?;
        let t0 = Instant::now();
        if let Err(err) = client.init().await {
            return Ok(RegistryConnectResult {
                ok: false,
                id: String::new(),
                latency_ms: 0,
                error: Some(err.to_string()),
            });
        }
        let result = match client.ping::<()>().await {
            Ok(_) => RegistryConnectResult {
                ok: true,
                id: String::new(),
                latency_ms: t0.elapsed().as_millis() as u64,
                error: None,
            },
            Err(err) => RegistryConnectResult {
                ok: false,
                id: String::new(),
                latency_ms: 0,
                error: Some(err.to_string()),
            },
        };
        let _ = client.quit().await;
        Ok(result)
    }
    .await;
    shutdown_tunnel(tunnel).await;
    outcome
}

/// Shared connect-and-insert path used by `redis_conn_open`.
async fn connect_and_register(
    registry: &State<'_, RedisRegistry>,
    id: String,
    label: String,
    host: String,
    port: u16,
    // Effective dial address (tunnel-rewritten when SSH is on) — what the
    // MONITOR / Pub-Sub bypass connections must use instead of host/port.
    bypass_host: String,
    bypass_port: u16,
    config: RedisConfig,
    tunnel: Option<super::ssh_tunnel::SshTunnel>,
) -> Result<RegistryConnectResult, String> {
    let client = match Builder::from_config(config.clone()).build() {
        Ok(client) => client,
        Err(err) => {
            shutdown_tunnel(tunnel).await;
            return Err(err.to_string());
        }
    };
    let t0 = Instant::now();
    if let Err(err) = client.init().await {
        shutdown_tunnel(tunnel).await;
        return Err(err.to_string());
    }
    match client.ping::<()>().await {
        Ok(_) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            let instance = Arc::new(ConnectionInstance {
                id: id.clone(),
                label,
                host,
                port,
                bypass_host,
                bypass_port,
                client,
                config,
                monitor_cancel: RwLock::new(None),
                pubsub_cancel: RwLock::new(None),
                op_lock: Arc::new(Mutex::new(())),
                ssh_tunnel: Mutex::new(tunnel),
            });
            let previous = registry
                .instances
                .write()
                .await
                .insert(id.clone(), instance);
            // WHY: re-opening an already-open id replaces the instance — quit
            // the old client and kill its tunnel or the ssh process leaks.
            if let Some(old) = previous {
                if let Some(token) = old.monitor_cancel.write().await.take() {
                    token.cancel();
                }
                if let Some(token) = old.pubsub_cancel.write().await.take() {
                    token.cancel();
                }
                let _ = old.client.quit().await;
                shutdown_tunnel(old.ssh_tunnel.lock().await.take()).await;
            }
            Ok(RegistryConnectResult {
                ok: true,
                id,
                latency_ms,
                error: None,
            })
        }
        Err(err) => {
            let _ = client.quit().await;
            shutdown_tunnel(tunnel).await;
            Ok(RegistryConnectResult {
                ok: false,
                id,
                latency_ms: 0,
                error: Some(err.to_string()),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Routed command proof — DBSIZE on (connectionId, db)
// Proves: command routes by connectionId AND db; backend holds no "current db".
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct RoutedDbSize {
    pub id: String,
    pub db: u8,
    pub dbsize: u64,
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn redis_reg_dbsize(
    id: String,
    db: u8,
    registry: State<'_, RedisRegistry>,
) -> Result<RoutedDbSize, String> {
    let instance = registry.get(&id).await?;
    let client = instance.client.clone();

    let t0 = Instant::now();
    // WHY: SELECT the requested db first — the db comes from the caller (tab),
    // never from backend state. Hold the per-connection op lock across
    // SELECT + DBSIZE so a concurrent request for another db can't interleave.
    let _op_guard = instance.op_lock.lock().await;
    let select = CustomCommand::new_static("SELECT", ClusterHash::FirstKey, false);
    let _: RedisValue = client
        .custom(select, vec![db.to_string()])
        .await
        .map_err(|e| e.to_string())?;

    let dbsize: u64 = client.dbsize().await.map_err(|e| e.to_string())?;

    Ok(RoutedDbSize {
        id,
        db,
        dbsize,
        latency_ms: t0.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// Status — INFO on a registry connection (reuses the existing parse_info asset)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn redis_reg_info(
    id: String,
    registry: State<'_, RedisRegistry>,
) -> Result<RedisStats, String> {
    let instance = registry.get(&id).await?;
    let client = instance.client.clone();
    let info_cmd = CustomCommand::new_static("INFO", ClusterHash::FirstKey, false);
    let raw: String = client
        .custom(info_cmd, Vec::<String>::new())
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_info(&raw))
}

// ---------------------------------------------------------------------------
// MONITOR spike — dedicated connection, streams to the frontend via events
// Event name: `redis://monitor/{connectionId}` — payload is each command line.
// ---------------------------------------------------------------------------

/// Encode a command as a RESP array — inline commands break on passwords with
/// spaces/quotes and can't carry binary-safe args.
fn resp_command(parts: &[&str]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", parts.len()).into_bytes();
    for part in parts {
        out.extend_from_slice(format!("${}\r\n", part.len()).as_bytes());
        out.extend_from_slice(part.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// AUTH command for the bypass connections — includes the ACL username when
/// the connection has one (plain `AUTH <pw>` gets WRONGPASS for ACL users).
fn bypass_auth_command(config: &RedisConfig) -> Option<Vec<u8>> {
    let password = config.password.as_deref()?;
    Some(match config.username.as_deref() {
        Some(user) if !user.is_empty() => resp_command(&["AUTH", user, password]),
        _ => resp_command(&["AUTH", password]),
    })
}

/// Clear a cancel slot IF it still holds `token` — a stop+start pair may have
/// installed a fresh token that must not be wiped by the old stream's exit.
async fn clear_own_token(
    slot: &RwLock<Option<Arc<CancellationToken>>>,
    token: &Arc<CancellationToken>,
) {
    let mut guard = slot.write().await;
    if guard.as_ref().is_some_and(|t| Arc::ptr_eq(t, token)) {
        *guard = None;
    }
}

#[tauri::command]
pub async fn redis_reg_monitor_start<R: Runtime>(
    id: String,
    app: AppHandle<R>,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let instance = registry.get(&id).await?;

    // WHY: refuse a second MONITOR on the same connection — one stream per
    // conn. Check + install under ONE write lock so two concurrent starts
    // can't both pass the check.
    let token = Arc::new(CancellationToken::new());
    {
        let mut guard = instance.monitor_cancel.write().await;
        if guard.is_some() {
            return Err("MONITOR already running on this connection".to_string());
        }
        *guard = Some(token.clone());
    }

    // WHY: MONITOR locks its connection into a one-way stream, so it gets its OWN
    // raw-TCP bypass connection — the fred command pool stays free for CRUD.
    // Dial the bypass address: with SSH it is the local tunnel end, not the raw host.
    let host = instance.bypass_host.clone();
    let port = instance.bypass_port;
    let auth = bypass_auth_command(&instance.config);
    let event = format!("redis://monitor/{id}");

    tokio::spawn(async move {
        let stream = match TcpStream::connect((host.as_str(), port)).await {
            Ok(stream) => stream,
            Err(err) => {
                let _ = app.emit(&event, format!("MONITOR connect error: {err}"));
                clear_own_token(&instance.monitor_cancel, &token).await;
                return;
            }
        };
        let (read_half, mut write_half) = stream.into_split();

        // WHY: authenticate first when the server needs a password, else MONITOR
        // is rejected with NOAUTH.
        if let Some(auth_cmd) = auth {
            if let Err(err) = write_half.write_all(&auth_cmd).await {
                let _ = app.emit(&event, format!("MONITOR auth error: {err}"));
                clear_own_token(&instance.monitor_cancel, &token).await;
                return;
            }
        }
        if let Err(err) = write_half.write_all(&resp_command(&["MONITOR"])).await {
            let _ = app.emit(&event, format!("MONITOR start error: {err}"));
            clear_own_token(&instance.monitor_cancel, &token).await;
            return;
        }

        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                _ = token.cancelled() => break,
                read = reader.read_line(&mut line) => match read {
                    Ok(0) => break,
                    Ok(_) => {
                        // WHY: MONITOR replies are RESP simple strings ("+...") —
                        // strip the marker + CRLF; skip the initial "+OK" ack.
                        let trimmed = line.trim_end();
                        let cleaned = trimmed.strip_prefix('+').unwrap_or(trimmed);
                        if cleaned == "OK" {
                            continue;
                        }
                        let _ = app.emit(&event, cleaned.to_string());
                    }
                    Err(err) => {
                        let _ = app.emit(&event, format!("MONITOR read error: {err}"));
                        break;
                    }
                }
            }
        }
        // WHY: on natural exit (EOF / error) the slot must clear, or every
        // future start is refused with "already running".
        clear_own_token(&instance.monitor_cancel, &token).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn redis_reg_monitor_stop(
    id: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let instance = registry.get(&id).await?;
    if let Some(token) = instance.monitor_cancel.write().await.take() {
        token.cancel();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pub/Sub — dedicated raw-TCP subscriber connection; emits redis://pubsub/{id}
// (Same bypass-connection pattern as MONITOR.)
// ---------------------------------------------------------------------------

/// Minimal RESP2 value — just enough shape for the pub/sub push frames.
enum RespValue {
    Simple(String),
    Error(String),
    Integer(i64),
    Bulk(Option<String>),
    Array(Vec<RespValue>),
}

impl RespValue {
    fn as_text(&self) -> String {
        match self {
            RespValue::Simple(s) | RespValue::Error(s) => s.clone(),
            RespValue::Integer(i) => i.to_string(),
            RespValue::Bulk(Some(s)) => s.clone(),
            _ => String::new(),
        }
    }
}

/// Read one full RESP value. Length-prefixed bulk strings are read with
/// `read_exact`, so payloads that start with `*`/`$`/`:` or contain embedded
/// newlines parse correctly (a line-based skip would misalign every frame after).
async fn read_resp_value<R>(reader: &mut R) -> std::io::Result<RespValue>
where
    R: AsyncBufRead + Unpin + Send,
{
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "connection closed",
        ));
    }
    let line = line.trim_end_matches(['\r', '\n']);
    let (kind, rest) = line.split_at(1.min(line.len()));
    match kind {
        "+" => Ok(RespValue::Simple(rest.to_string())),
        "-" => Ok(RespValue::Error(rest.to_string())),
        ":" => Ok(RespValue::Integer(rest.parse().unwrap_or(0))),
        "$" => {
            let len: i64 = rest.parse().unwrap_or(-1);
            if len < 0 {
                return Ok(RespValue::Bulk(None));
            }
            // payload + trailing CRLF
            let mut buf = vec![0u8; len as usize + 2];
            reader.read_exact(&mut buf).await?;
            buf.truncate(len as usize);
            Ok(RespValue::Bulk(Some(
                String::from_utf8_lossy(&buf).to_string(),
            )))
        }
        "*" => {
            let count: i64 = rest.parse().unwrap_or(-1);
            let mut items = Vec::new();
            for _ in 0..count.max(0) {
                items.push(Box::pin(read_resp_value(reader)).await?);
            }
            Ok(RespValue::Array(items))
        }
        _ => Ok(RespValue::Simple(line.to_string())),
    }
}

#[tauri::command]
pub async fn reg_pubsub_start<R: Runtime>(
    id: String,
    channel: String,
    app: AppHandle<R>,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let instance = registry.get(&id).await?;
    // WHY: check + install under one write lock (same race as MONITOR start).
    let token = Arc::new(CancellationToken::new());
    {
        let mut guard = instance.pubsub_cancel.write().await;
        if guard.is_some() {
            return Err("已有订阅在运行".to_string());
        }
        *guard = Some(token.clone());
    }

    // Dial the bypass address: with SSH it is the local tunnel end.
    let host = instance.bypass_host.clone();
    let port = instance.bypass_port;
    let auth = bypass_auth_command(&instance.config);
    let event = format!("redis://pubsub/{id}");
    let is_pattern = channel.contains('*');

    tokio::spawn(async move {
        let cleanup = |i: Arc<ConnectionInstance>, t: Arc<CancellationToken>| async move {
            clear_own_token(&i.pubsub_cancel, &t).await;
        };
        let stream = match TcpStream::connect((host.as_str(), port)).await {
            Ok(stream) => stream,
            Err(err) => {
                let _ = app.emit(&event, format!("订阅连接失败: {err}"));
                cleanup(instance, token).await;
                return;
            }
        };
        let (read_half, mut write_half) = stream.into_split();
        if let Some(auth_cmd) = auth {
            if let Err(err) = write_half.write_all(&auth_cmd).await {
                let _ = app.emit(&event, format!("订阅认证失败: {err}"));
                cleanup(instance, token).await;
                return;
            }
        }
        let sub_cmd = if is_pattern { "PSUBSCRIBE" } else { "SUBSCRIBE" };
        if let Err(err) = write_half
            .write_all(&resp_command(&[sub_cmd, &channel]))
            .await
        {
            let _ = app.emit(&event, format!("订阅失败: {err}"));
            cleanup(instance, token).await;
            return;
        }

        let mut reader = BufReader::new(read_half);
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                value = read_resp_value(&mut reader) => match value {
                    Ok(RespValue::Error(err)) => {
                        // AUTH / SUBSCRIBE rejection — surface it, then stop.
                        let _ = app.emit(&event, format!("订阅错误: {err}"));
                        break;
                    }
                    Ok(RespValue::Array(items)) => {
                        let text = |i: usize| items.get(i).map(RespValue::as_text).unwrap_or_default();
                        match text(0).as_str() {
                            "message" if items.len() >= 3 => {
                                let _ = app.emit(&event, format!("[{}] {}", text(1), text(2)));
                            }
                            "pmessage" if items.len() >= 4 => {
                                let _ = app.emit(&event, format!("[{}] {}", text(2), text(3)));
                            }
                            "subscribe" | "psubscribe" => {
                                let _ = app.emit(&event, format!("✅ 已订阅 {channel}"));
                            }
                            _ => {}
                        }
                    }
                    // +OK from AUTH, integers, stray frames — ignore.
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        cleanup(instance, token).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn reg_pubsub_stop(
    id: String,
    registry: State<'_, RedisRegistry>,
) -> Result<(), String> {
    let instance = registry.get(&id).await?;
    if let Some(token) = instance.pubsub_cancel.write().await.take() {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_absent_or_invalid_defaults_to_disabled() {
        for json in ["{}", "", "not json", r#"{"deployment":"standalone"}"#] {
            let adv = serde_json::from_str::<AdvancedConfig>(json).unwrap_or_default();
            assert!(!adv.ssh.enabled, "json {json:?} should not enable ssh");
        }
    }

    #[test]
    fn ssh_config_round_trips_fields() {
        let json = r#"{"ssh":{"enabled":true,"host":"jump.internal","port":2222,
            "username":"deploy","auth_type":"key","key_path":"~/.ssh/id_ed25519"}}"#;
        let adv = serde_json::from_str::<AdvancedConfig>(json).unwrap();
        assert!(adv.ssh.enabled);
        assert_eq!(adv.ssh.host, "jump.internal");
        assert_eq!(adv.ssh.port, 2222);
        assert_eq!(adv.ssh.username, "deploy");
        assert_eq!(adv.ssh.auth_type, "key");
        assert_eq!(adv.ssh.key_path, "~/.ssh/id_ed25519");
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn resp_command_encodes_args_with_spaces_safely() {
        let encoded = resp_command(&["AUTH", "user", "p w\"d"]);
        assert_eq!(
            String::from_utf8(encoded).unwrap(),
            "*3\r\n$4\r\nAUTH\r\n$4\r\nuser\r\n$5\r\np w\"d\r\n"
        );
    }

    #[test]
    fn resp_parser_handles_payloads_that_look_like_protocol_markers() {
        // A pubsub push whose payload starts with ':' and contains a newline —
        // the old line-based skip misaligned every frame after this.
        let frame = b"*3\r\n$7\r\nmessage\r\n$4\r\nnews\r\n$9\r\n:123\nline\r\n";
        let value = block_on(async {
            let mut reader = BufReader::new(&frame[..]);
            read_resp_value(&mut reader).await.unwrap()
        });
        match value {
            RespValue::Array(items) => {
                assert_eq!(items.len(), 3);
                assert_eq!(items[0].as_text(), "message");
                assert_eq!(items[1].as_text(), "news");
                assert_eq!(items[2].as_text(), ":123\nline");
            }
            _ => panic!("expected array frame"),
        }
    }

    #[test]
    fn resp_parser_reads_consecutive_frames_without_desync() {
        let frames = b"+OK\r\n*3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$5\r\n*mark\r\n-ERR boom\r\n";
        block_on(async {
            let mut reader = BufReader::new(&frames[..]);
            assert!(matches!(
                read_resp_value(&mut reader).await.unwrap(),
                RespValue::Simple(s) if s == "OK"
            ));
            match read_resp_value(&mut reader).await.unwrap() {
                RespValue::Array(items) => assert_eq!(items[2].as_text(), "*mark"),
                _ => panic!("expected array"),
            }
            assert!(matches!(
                read_resp_value(&mut reader).await.unwrap(),
                RespValue::Error(e) if e == "ERR boom"
            ));
        });
    }

    #[test]
    fn ssh_config_tolerates_legacy_passphrase_field() {
        // Old saved connections may still carry key_passphrase — serde must
        // ignore it rather than fail the whole connection open.
        let json = r#"{"ssh":{"enabled":true,"host":"j","key_passphrase":"x"}}"#;
        let adv = serde_json::from_str::<AdvancedConfig>(json).unwrap();
        assert!(adv.ssh.enabled);
    }
}
