use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;
use toml_edit::{value, Array, DocumentMut, Item, Table};

// ---- MCP integration with local AI clients --------------------------------
// The MCP server JS (~/packages/mcp/dist/index.js) is bundled with the app as
// a Tauri resource. The Settings UI surfaces a one-click flow that writes a
// penguin entry into local MCP client configs pointing at that bundled file,
// merging without disturbing other servers.

fn claude_desktop_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json")
    })
}

fn codex_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("config.toml"))
}

// Claude Code (the CLI) keeps user-scope MCP servers in ~/.claude.json under
// the same `mcpServers` shape as Claude Desktop, so the desktop merge/check
// helpers are reused for it.
fn claude_code_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

// Resolve the bundled MCP server path from the Tauri resource dir. Bundled at
// release time via tauri.conf.json `resources`; falls back to the workspace
// build output during `tauri dev`.
fn bundled_mcp_server_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    // Tauri rewrites resources declared with `../foo` to `_up_/foo` inside the
    // bundled .app's Resources directory (matches how .penguin.config.json is
    // shipped). Probe both the rewritten and the literal layout so this works
    // whether the resource is declared with a relative path or not.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("_up_/packages/mcp/bundle/dist/index.js"),
            resource_dir.join("packages/mcp/bundle/dist/index.js"),
            resource_dir.join("_up_/packages/mcp/dist/index.js"),
            resource_dir.join("packages/mcp/dist/index.js"),
            resource_dir.join("index.js"),
        ];
        for c in candidates {
            if c.exists() {
                return Ok(c);
            }
        }
    }
    // Dev mode fallback: walk up from the dev cwd until we find the workspace.
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            for candidate in [
                ancestor.join("packages/mcp/bundle/dist/index.js"),
                ancestor.join("packages/mcp/dist/index.js"),
            ] {
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("Bundled MCP server (packages/mcp/dist/index.js) not found".to_string())
}

// The vendored native runtime shipped alongside the MCP server — a
// self-contained `node` binary + `node_modules/better-sqlite3` closure built
// by scripts/vendor-knowledge-runtime.mjs for a KNOWN Node ABI, so opening the
// knowledge DB never depends on guessing which system Node (if any) happens
// to have a compatible prebuilt native addon. None in `tauri dev` (the
// workspace's own pnpm node_modules resolve better-sqlite3 directly there).
fn bundled_mcp_runtime_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("_up_/packages/mcp/bundle"),
            resource_dir.join("packages/mcp/bundle"),
        ] {
            if candidate.join("node").exists() {
                return Some(candidate);
            }
        }
    }
    None
}

// Parse "v18.20.8"-style directory names into a sortable tuple. Returns None
// for non-version entries (e.g. ".DS_Store").
fn parse_node_version(name: &str) -> Option<(u64, u64, u64)> {
    let trimmed = name.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

// Pick the numerically-highest installed nvm version. A lexical sort would
// rank v9.x above v22.x, pinning clients to an ancient node.
fn nvm_latest_node(home: &Path) -> Option<PathBuf> {
    let nvm_dir = home.join(".nvm/versions/node");
    let mut best: Option<((u64, u64, u64), PathBuf)> = None;
    for entry in std::fs::read_dir(&nvm_dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(ver) = parse_node_version(&name) {
            if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
                best = Some((ver, entry.path()));
            }
        }
    }
    best.map(|(_, p)| p.join("bin/node")).filter(|p| p.exists())
}

// Best-effort search for a usable `node` binary. Tauri-spawned processes don't
// inherit the user's interactive PATH, so we have to look in the common
// homebrew / nvm / volta / fnm / asdf / system locations explicitly, then fall
// back to asking a login shell.
//
// FALLBACK ONLY for the MCP server: this has no idea whether whatever `node`
// it finds has a Node ABI compatible with the shipped better-sqlite3 prebuild
// (a system Node found here first has no version priority over nvm's, and
// neither carries any ABI guarantee) — a mismatch fails to load the native
// module at runtime. Release builds should always have a vendored runtime
// (see bundled_mcp_runtime_dir) with a KNOWN-matching Node; this function is
// only reached when that's unavailable (`tauri dev`, or a corrupted install).
// The CLI launcher script's own use of this function doesn't have this
// concern — it runs the workspace's unbundled dist output against that same
// workspace's real, already ABI-matched node_modules/better-sqlite3.
pub(crate) fn detect_node_path() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(home) = dirs::home_dir() {
        if let Some(node) = nvm_latest_node(&home) {
            return Some(node);
        }
        let manager_paths = [
            home.join(".volta/bin/node"),
            home.join("Library/Application Support/fnm/aliases/default/bin/node"),
            home.join(".fnm/aliases/default/bin/node"),
            home.join(".asdf/shims/node"),
        ];
        for p in manager_paths {
            if p.exists() {
                return Some(p);
            }
        }
    }
    // Last resort: a login+interactive shell sees whatever PATH setup the
    // user has, no matter which node manager they use.
    let output = std::process::Command::new("zsh")
        .args(["-ilc", "command -v node"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8(output.stdout).ok()?;
    let trimmed = path.trim();
    if trimmed.starts_with('/') {
        Some(PathBuf::from(trimmed))
    } else {
        None
    }
}

// Client configs must NOT point into the .app bundle: apps launched from a
// still-mounted DMG, App-Translocated (quarantined) apps, and moved/renamed
// apps all make that path vanish after the session that configured it — the
// health check passes, then Claude/Codex can never start the server again.
// Instead we sync the bundled server to a stable per-user location and point
// every client config there.
fn stable_mcp_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".penguin").join("mcp"))
}

// Atomic overwrite, skipped when content is already identical. Returns
// whether the destination changed.
fn copy_if_different(src: &Path, dest: &Path) -> Result<bool, String> {
    let src_bytes = std::fs::read(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    if let Ok(existing) = std::fs::read(dest) {
        if existing == src_bytes {
            return Ok(false);
        }
    }
    let tmp = dest.with_extension("tmp");
    std::fs::write(&tmp, &src_bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dest).map_err(|e| format!("rename {}: {e}", dest.display()))?;
    Ok(true)
}

// Recursive copy that dereferences symlinks (so the stable per-user copy is
// fully self-contained, never pointing back into a possibly-transient
// resource/DMG mount) and skips files whose content hasn't changed.
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        // metadata() follows symlinks (unlike file_type(), which reports the
        // link itself) — exactly the dereferencing behavior we want here.
        let meta = std::fs::metadata(&src_path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            copy_if_different(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

// Sync the bundled server JS (plus the package.json that carries
// "type": "module" — without it node would run the ESM bundle as CJS) into
// stable_dir. Refreshes stale copies after app updates. Returns the stable
// server path to put in client configs.
fn sync_stable_mcp_files(bundled_server: &Path, stable_dir: &Path) -> Result<PathBuf, String> {
    let dist = stable_dir.join("dist");
    std::fs::create_dir_all(&dist).map_err(|e| e.to_string())?;

    let server_dest = dist.join("index.js");
    copy_if_different(bundled_server, &server_dest)?;

    let pkg_dest = stable_dir.join("package.json");
    // Bundled layout: .../packages/mcp/dist/index.js with package.json two
    // levels up at .../packages/mcp/package.json.
    let pkg_src = bundled_server
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("package.json"))
        .filter(|p| p.exists());
    match pkg_src {
        Some(src) => {
            copy_if_different(&src, &pkg_dest)?;
        }
        None => {
            if !pkg_dest.exists() {
                std::fs::write(&pkg_dest, "{\n  \"type\": \"module\"\n}\n")
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(server_dest)
}

// Sync the vendored native runtime (node binary + node_modules/better-sqlite3
// closure) into stable_dir, when the app ships one (release builds only —
// `tauri dev` has none, and that's fine: the workspace's own node_modules
// resolve better-sqlite3 directly there). Returns the stable `node` path.
fn sync_stable_mcp_runtime(runtime_dir: &Path, stable_dir: &Path) -> Result<PathBuf, String> {
    copy_dir_recursive(
        &runtime_dir.join("node_modules"),
        &stable_dir.join("node_modules"),
    )?;
    let node_dest = stable_dir.join("node");
    copy_if_different(&runtime_dir.join("node"), &node_dest)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&node_dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&node_dest, perms).map_err(|e| e.to_string())?;
    }
    Ok(node_dest)
}

// Resolves BOTH the stable server path and the node binary to launch it with.
// Prefers the vendored runtime (known-good Node ABI, matches the shipped
// better-sqlite3 prebuild) over guessing at a system Node — see
// detect_node_path's doc comment for why that guess is unreliable.
fn ensure_stable_mcp_server<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let bundled = bundled_mcp_server_path(app)?;
    let dir = stable_mcp_dir().ok_or("No home directory")?;
    let server = sync_stable_mcp_files(&bundled, &dir)?;
    let node = match bundled_mcp_runtime_dir(app) {
        Some(runtime_dir) => Some(sync_stable_mcp_runtime(&runtime_dir, &dir)?),
        None => None,
    };
    Ok((server, node))
}

fn claude_desktop_configured_at(cfg_path: &Path) -> bool {
    std::fs::read_to_string(cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("mcpServers")?.get("penguin").cloned())
        .is_some()
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
struct LegacyAliasDiagnostic {
    name: String,
    classification: String,
    safe_to_migrate: bool,
    reason: String,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
struct CanonicalMigrationResult {
    canonical: &'static str,
    written: bool,
    removed_aliases: Vec<String>,
    ambiguous_aliases: Vec<LegacyAliasDiagnostic>,
    preserved_servers: usize,
}

fn is_owned_penguin_target(command: &str, server: &str) -> bool {
    let normalized = format!("{command}\n{server}").to_ascii_lowercase();
    normalized.contains("/.penguin/")
        || normalized.contains("/.pengvi/")
        || normalized.contains("/pengvi/packages/mcp/")
        || normalized.contains("/penguin/packages/mcp/")
}

fn write_claude_desktop_mcp_config_at(
    cfg_path: &Path,
    node: &Path,
    server: &Path,
) -> Result<CanonicalMigrationResult, String> {
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let existing_raw = if cfg_path.exists() {
        Some(std::fs::read_to_string(cfg_path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut root: serde_json::Value = match existing_raw.as_deref() {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|e| format!("Existing config is not valid JSON: {e}"))?,
        None => serde_json::json!({}),
    };

    if !root.is_object() {
        return Err("Existing config root is not a JSON object".to_string());
    }

    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));

    if !servers.is_object() {
        return Err("mcpServers field exists but is not an object".to_string());
    }

    let servers = servers.as_object_mut().unwrap();
    let mut removed_aliases = Vec::new();
    let mut ambiguous_aliases = Vec::new();
    if let Some(legacy) = servers.get("pengvi") {
        let command = legacy
            .get("command")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let legacy_server = legacy
            .get("args")
            .and_then(serde_json::Value::as_array)
            .and_then(|args| args.first())
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if is_owned_penguin_target(command, legacy_server) {
            servers.remove("pengvi");
            removed_aliases.push("pengvi".to_string());
        } else {
            ambiguous_aliases.push(LegacyAliasDiagnostic {
                name: "pengvi".to_string(),
                classification: "name_collision".to_string(),
                safe_to_migrate: false,
                reason: "legacy name exists but its command/args are not recognizably Penguin"
                    .to_string(),
            });
        }
    }

    servers.insert(
        "penguin".to_string(),
        serde_json::json!({
            "command": node.to_string_lossy(),
            "args": [server.to_string_lossy()],
        }),
    );
    let preserved_servers = servers.len().saturating_sub(1);

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let written = existing_raw.as_deref() != Some(pretty.as_str());
    if written {
        std::fs::write(cfg_path, pretty).map_err(|e| e.to_string())?;
    }
    Ok(CanonicalMigrationResult {
        canonical: "penguin",
        written,
        removed_aliases,
        ambiguous_aliases,
        preserved_servers,
    })
}

fn codex_mcp_configured_at(cfg_path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(cfg_path) else {
        return false;
    };
    let Ok(doc) = raw.parse::<DocumentMut>() else {
        return false;
    };

    doc.get("mcp_servers")
        .and_then(|servers| servers.as_table_like())
        .and_then(|servers| servers.get("penguin"))
        .and_then(|penguin| penguin.as_table_like())
        .and_then(|penguin| penguin.get("command"))
        .and_then(|command| command.as_str())
        .is_some()
}

#[derive(Debug)]
struct McpRuntimeHealth {
    healthy: bool,
    error: Option<String>,
}

fn parse_mcp_initialize_response(stdout: &str) -> Result<(), String> {
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let server_name = value
            .get("result")
            .and_then(|result| result.get("serverInfo"))
            .and_then(|info| info.get("name"))
            .and_then(|name| name.as_str());
        if server_name == Some("penguin-mcp") {
            return Ok(());
        }
    }
    Err("MCP server did not return a valid initialize response".to_string())
}

fn check_mcp_server_runtime(node: &Path, server: &Path) -> McpRuntimeHealth {
    if !node.exists() {
        return McpRuntimeHealth {
            healthy: false,
            error: Some(format!("Node.js binary not found: {}", node.display())),
        };
    }
    if !server.exists() {
        return McpRuntimeHealth {
            healthy: false,
            error: Some(format!(
                "Bundled MCP server not found: {}",
                server.display()
            )),
        };
    }

    let mut child = match Command::new(node)
        .arg(server)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return McpRuntimeHealth {
                healthy: false,
                error: Some(format!("Failed to start MCP server: {e}")),
            }
        }
    };

    const MCP_INITIALIZE_REQUEST: &str = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"penguin-settings-check","version":"0.0.0"}}}"#;
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(format!("{MCP_INITIALIZE_REQUEST}\n").as_bytes()) {
            let _ = child.kill();
            return McpRuntimeHealth {
                healthy: false,
                error: Some(format!("Failed to send MCP initialize request: {e}")),
            };
        }
    }

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) if started.elapsed() < Duration::from_millis(1500) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let output = child.wait_with_output().ok();
                let stderr = output
                    .as_ref()
                    .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
                    .filter(|s| !s.is_empty());
                return McpRuntimeHealth {
                    healthy: false,
                    error: Some(stderr.unwrap_or_else(|| {
                        "MCP server did not answer initialize within 1500ms".to_string()
                    })),
                };
            }
            Err(e) => {
                let _ = child.kill();
                return McpRuntimeHealth {
                    healthy: false,
                    error: Some(format!("Failed while waiting for MCP server: {e}")),
                };
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(e) => {
            return McpRuntimeHealth {
                healthy: false,
                error: Some(format!("Failed to read MCP server output: {e}")),
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return McpRuntimeHealth {
            healthy: false,
            error: Some(if stderr.is_empty() {
                format!("MCP server exited with status {}", output.status)
            } else {
                stderr
            }),
        };
    }

    match parse_mcp_initialize_response(&stdout) {
        Ok(()) => McpRuntimeHealth {
            healthy: true,
            error: None,
        },
        Err(e) => McpRuntimeHealth {
            healthy: false,
            error: Some(if stderr.is_empty() {
                e
            } else {
                format!("{e}. stderr: {stderr}")
            }),
        },
    }
}

fn write_codex_mcp_config_at(
    cfg_path: &Path,
    node: &Path,
    server: &Path,
) -> Result<CanonicalMigrationResult, String> {
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let existing_raw = if cfg_path.exists() {
        Some(std::fs::read_to_string(cfg_path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut doc = if let Some(raw) = existing_raw.as_deref() {
        if raw.trim().is_empty() {
            DocumentMut::new()
        } else {
            raw.parse::<DocumentMut>()
                .map_err(|e| format!("Existing Codex config is not valid TOML: {e}"))?
        }
    } else {
        DocumentMut::new()
    };

    let servers_item = doc
        .as_table_mut()
        .entry("mcp_servers")
        .or_insert_with(|| Item::Table(Table::new()));

    if !servers_item.is_table_like() {
        return Err("mcp_servers field exists but is not a TOML table".to_string());
    }

    let servers = servers_item
        .as_table_like_mut()
        .ok_or_else(|| "mcp_servers field exists but is not a TOML table".to_string())?;
    let legacy_target = servers
        .get("pengvi")
        .and_then(Item::as_table_like)
        .map(|legacy| {
            let command = legacy
                .get("command")
                .and_then(Item::as_str)
                .unwrap_or_default()
                .to_string();
            let legacy_server = legacy
                .get("args")
                .and_then(Item::as_array)
                .and_then(|args| args.get(0))
                .and_then(toml_edit::Value::as_str)
                .unwrap_or_default()
                .to_string();
            (command, legacy_server)
        });
    let mut removed_aliases = Vec::new();
    let mut ambiguous_aliases = Vec::new();
    if let Some((command, legacy_server)) = legacy_target {
        if is_owned_penguin_target(&command, &legacy_server) {
            servers.remove("pengvi");
            removed_aliases.push("pengvi".to_string());
        } else {
            ambiguous_aliases.push(LegacyAliasDiagnostic {
                name: "pengvi".to_string(),
                classification: "name_collision".to_string(),
                safe_to_migrate: false,
                reason: "legacy name exists but its command/args are not recognizably Penguin"
                    .to_string(),
            });
        }
    }

    let mut args = Array::new();
    args.push(server.to_string_lossy().to_string());

    let mut penguin = Table::new();
    penguin["command"] = value(node.to_string_lossy().to_string());
    penguin["args"] = value(args);

    servers.insert("penguin", Item::Table(penguin));
    let preserved_servers = servers.len().saturating_sub(1);
    let rendered = doc.to_string();
    let written = existing_raw.as_deref() != Some(rendered.as_str());
    if written {
        std::fs::write(cfg_path, rendered).map_err(|e| e.to_string())?;
    }
    Ok(CanonicalMigrationResult {
        canonical: "penguin",
        written,
        removed_aliases,
        ambiguous_aliases,
        preserved_servers,
    })
}

#[derive(serde::Serialize)]
pub(crate) struct McpStatus {
    server_name: String,
    bundled_server_path: Option<String>,
    node_path: Option<String>,
    server_healthy: bool,
    server_health_error: Option<String>,
    claude_desktop_config_path: Option<String>,
    claude_desktop_configured: bool,
    claude_code_config_path: Option<String>,
    claude_code_configured: bool,
    codex_config_path: Option<String>,
    codex_configured: bool,
}

#[tauri::command]
pub(crate) fn mcp_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> McpStatus {
    // Prefer the stable per-user copy (and refresh it while we're here so app
    // updates propagate); fall back to the in-bundle path for diagnostics.
    let (bundled, vendored_node) = match ensure_stable_mcp_server(&app) {
        Ok((server, node)) => (Some(server), node),
        Err(_) => (bundled_mcp_server_path(&app).ok(), None),
    };
    // The vendored runtime's node (known-matching ABI) wins when the app
    // shipped one; only guess at a system node as a last resort (dev builds).
    let node = vendored_node.or_else(detect_node_path);
    let cfg_path = claude_desktop_config_path();
    let claude_code_cfg_path = claude_code_config_path();
    let codex_cfg_path = codex_config_path();
    let server_health = match (&node, &bundled) {
        (Some(node), Some(server)) => check_mcp_server_runtime(node, server),
        (None, _) => McpRuntimeHealth {
            healthy: false,
            error: Some("Node.js not detected".to_string()),
        },
        (_, None) => McpRuntimeHealth {
            healthy: false,
            error: Some("Bundled MCP server missing".to_string()),
        },
    };

    let claude_configured = cfg_path
        .as_ref()
        .map(|p| claude_desktop_configured_at(p))
        .unwrap_or(false);
    // Same mcpServers JSON shape — the desktop checker works for ~/.claude.json.
    let claude_code_configured = claude_code_cfg_path
        .as_ref()
        .map(|p| claude_desktop_configured_at(p))
        .unwrap_or(false);
    let codex_configured = codex_cfg_path
        .as_ref()
        .map(|p| codex_mcp_configured_at(p))
        .unwrap_or(false);

    McpStatus {
        server_name: "penguin".to_string(),
        bundled_server_path: bundled.map(|p| p.to_string_lossy().to_string()),
        node_path: node.map(|p| p.to_string_lossy().to_string()),
        server_healthy: server_health.healthy,
        server_health_error: server_health.error,
        claude_desktop_config_path: cfg_path.map(|p| p.to_string_lossy().to_string()),
        claude_desktop_configured: claude_configured,
        claude_code_config_path: claude_code_cfg_path.map(|p| p.to_string_lossy().to_string()),
        claude_code_configured,
        codex_config_path: codex_cfg_path.map(|p| p.to_string_lossy().to_string()),
        codex_configured,
    }
}

// Which AI clients exist on THIS machine. Configure only those — machines
// differ, and writing config for an uninstalled client scaffolds junk dirs it
// may later misread. Detection = the client's own state dir/file exists.
fn detected_local_clients(home: &std::path::Path) -> Vec<(&'static str, PathBuf)> {
    let mut clients = Vec::new();
    let desktop_dir = home.join("Library/Application Support/Claude");
    if desktop_dir.is_dir() {
        clients.push(("Claude Desktop", desktop_dir.join("claude_desktop_config.json")));
    }
    if home.join(".claude.json").exists() || home.join(".claude").is_dir() {
        clients.push(("Claude Code", home.join(".claude.json")));
    }
    if home.join(".codex").is_dir() {
        clients.push(("Codex CLI", home.join(".codex/config.toml")));
    }
    clients
}

#[tauri::command]
pub(crate) fn mcp_install_to_local_clients<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let (server, vendored_node) = ensure_stable_mcp_server(&app)?;
    // Vendored node (known-matching ABI for the shipped better-sqlite3
    // prebuild) wins; only guess at a system node when the app shipped none
    // (dev builds — the workspace's own node_modules resolve it directly).
    let node = vendored_node
        .or_else(detect_node_path)
        .ok_or("Could not locate a node binary in common paths")?;
    let home = dirs::home_dir().ok_or("No home directory")?;

    let clients = detected_local_clients(&home);
    if clients.is_empty() {
        return Err(
            "未检测到 Claude Desktop / Claude Code / Codex — 先安装任意一个再配置 MCP".to_string(),
        );
    }
    let mut configured = Vec::new();
    for (name, cfg_path) in &clients {
        match *name {
            // ~/.claude.json uses the same mcpServers shape as Claude Desktop,
            // and the merge preserves all of the client's other state.
            "Claude Desktop" | "Claude Code" => {
                let _ = write_claude_desktop_mcp_config_at(cfg_path, &node, &server)?;
            }
            _ => {
                let _ = write_codex_mcp_config_at(cfg_path, &node, &server)?;
            }
        }
        configured.push(format!("{} ({})", name, cfg_path.display()));
    }
    let all = ["Claude Desktop", "Claude Code", "Codex CLI"];
    let skipped: Vec<&str> = all
        .iter()
        .filter(|n| !clients.iter().any(|(c, _)| c == *n))
        .copied()
        .collect();
    let mut msg = format!(
        "Configured penguin MCP server for {}. Restart the clients to pick it up.",
        configured.join(", ")
    );
    if !skipped.is_empty() {
        msg.push_str(&format!(" Skipped (not installed): {}.", skipped.join(", ")));
    }
    Ok(msg)
}

#[cfg(test)]
mod mcp_config_tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn detected_local_clients_matches_what_is_installed() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("pengvi-clients-{nonce}"));
        fs::create_dir_all(&home).unwrap();
        // Bare machine: nothing detected, nothing scaffolded.
        assert!(detected_local_clients(&home).is_empty());
        // Claude Code via ~/.claude.json only.
        fs::write(home.join(".claude.json"), "{}").unwrap();
        let c1 = detected_local_clients(&home);
        assert_eq!(c1.len(), 1);
        assert_eq!(c1[0].0, "Claude Code");
        // Add Codex + Claude Desktop.
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(home.join("Library/Application Support/Claude")).unwrap();
        let names: Vec<_> = detected_local_clients(&home).iter().map(|(n, _)| *n).collect();
        assert_eq!(names, vec!["Claude Desktop", "Claude Code", "Codex CLI"]);
        fs::remove_dir_all(&home).unwrap();
    }

    fn temp_config_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("penguin-mcp-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("config.toml")
    }

    #[test]
    fn parse_node_version_orders_numerically_not_lexically() {
        // Lexical sort would pick v9 over v22 — the bug that pinned client
        // configs to ancient node versions.
        assert!(parse_node_version("v22.1.0").unwrap() > parse_node_version("v9.11.2").unwrap());
        assert!(parse_node_version("v18.20.8").unwrap() < parse_node_version("v20.0.0").unwrap());
        assert_eq!(parse_node_version(".DS_Store"), None);
        assert_eq!(parse_node_version("v18"), Some((18, 0, 0)));
    }

    #[test]
    fn sync_stable_mcp_files_copies_server_and_module_package_json() {
        let cfg = temp_config_path("stable-sync");
        let root = cfg.parent().unwrap().to_path_buf();

        // Fake bundled layout: packages/mcp/dist/index.js + packages/mcp/package.json
        let bundle_dir = root.join("bundle/packages/mcp");
        fs::create_dir_all(bundle_dir.join("dist")).unwrap();
        fs::write(bundle_dir.join("dist/index.js"), "console.log('v1')").unwrap();
        fs::write(bundle_dir.join("package.json"), "{\"type\":\"module\"}").unwrap();

        let stable = root.join("stable");
        let server = sync_stable_mcp_files(&bundle_dir.join("dist/index.js"), &stable).unwrap();

        assert_eq!(server, stable.join("dist/index.js"));
        assert_eq!(fs::read_to_string(&server).unwrap(), "console.log('v1')");
        assert!(fs::read_to_string(stable.join("package.json"))
            .unwrap()
            .contains("\"type\":\"module\""));

        // App update: bundled content changed → stable copy refreshes.
        fs::write(bundle_dir.join("dist/index.js"), "console.log('v2')").unwrap();
        sync_stable_mcp_files(&bundle_dir.join("dist/index.js"), &stable).unwrap();
        assert_eq!(fs::read_to_string(&server).unwrap(), "console.log('v2')");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_stable_mcp_files_writes_minimal_package_json_when_bundle_lacks_one() {
        let cfg = temp_config_path("stable-nopkg");
        let root = cfg.parent().unwrap().to_path_buf();

        let bundle_dir = root.join("flat");
        fs::create_dir_all(&bundle_dir).unwrap();
        fs::write(bundle_dir.join("index.js"), "console.log('hi')").unwrap();

        let stable = root.join("stable");
        sync_stable_mcp_files(&bundle_dir.join("index.js"), &stable).unwrap();

        // Without "type": "module" node would execute the ESM bundle as CJS.
        assert!(fs::read_to_string(stable.join("package.json"))
            .unwrap()
            .contains("\"type\": \"module\""));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_stable_mcp_runtime_copies_node_binary_and_native_closure() {
        let cfg = temp_config_path("stable-runtime");
        let root = cfg.parent().unwrap().to_path_buf();

        // Fake vendored runtime: node binary + a nested native-module closure.
        let runtime_dir = root.join("bundle/packages/mcp/bundle");
        let bsq_dir = runtime_dir.join("node_modules/better-sqlite3/build/Release");
        fs::create_dir_all(&bsq_dir).unwrap();
        fs::write(bsq_dir.join("better_sqlite3.node"), b"fake-native-binary-v1").unwrap();
        fs::write(runtime_dir.join("node"), "fake-node-binary-v1").unwrap();

        let stable = root.join("stable");
        let node = sync_stable_mcp_runtime(&runtime_dir, &stable).unwrap();

        assert_eq!(node, stable.join("node"));
        assert_eq!(fs::read_to_string(&node).unwrap(), "fake-node-binary-v1");
        assert_eq!(
            fs::read(stable.join("node_modules/better-sqlite3/build/Release/better_sqlite3.node"))
                .unwrap(),
            b"fake-native-binary-v1",
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&node).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "vendored node must be executable");
        }

        // App update: vendored content changed → stable copy refreshes.
        fs::write(runtime_dir.join("node"), "fake-node-binary-v2").unwrap();
        sync_stable_mcp_runtime(&runtime_dir, &stable).unwrap();
        assert_eq!(fs::read_to_string(&node).unwrap(), "fake-node-binary-v2");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_claude_json_mcp_config_preserves_claude_code_state() {
        // ~/.claude.json holds far more than mcpServers — projects, settings,
        // OAuth state. The merge must touch only mcpServers.penguin.
        let cfg_path = temp_config_path("claude-code").with_extension("json");
        fs::write(
            &cfg_path,
            r#"{"numStartups": 42, "projects": {"/tmp/x": {"allowedTools": []}}, "mcpServers": {"other": {"command": "other-mcp"}}}"#,
        )
        .unwrap();

        write_claude_desktop_mcp_config_at(
            &cfg_path,
            &PathBuf::from("/usr/local/bin/node"),
            &PathBuf::from("/Users/u/.penguin/mcp/dist/index.js"),
        )
        .unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(saved["numStartups"], 42);
        assert!(saved["projects"]["/tmp/x"].is_object());
        assert_eq!(saved["mcpServers"]["other"]["command"], "other-mcp");
        assert_eq!(
            saved["mcpServers"]["penguin"]["command"],
            "/usr/local/bin/node"
        );
        assert_eq!(
            saved["mcpServers"]["penguin"]["args"][0],
            "/Users/u/.penguin/mcp/dist/index.js"
        );

        let _ = fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[test]
    fn claude_migration_removes_owned_pengvi_and_preserves_other_servers() {
        let cfg_path = temp_config_path("claude-legacy-owned").with_extension("json");
        fs::write(
            &cfg_path,
            r#"{
              "mcpServers": {
                "other": {"command": "other-mcp"},
                "pengvi": {
                  "command": "/Users/u/.nvm/node",
                  "args": ["/Users/u/Desktop/Pengvi/packages/mcp/dist/index.js"]
                }
              },
              "numStartups": 42
            }"#,
        )
        .unwrap();

        let result = write_claude_desktop_mcp_config_at(
            &cfg_path,
            &PathBuf::from("/Users/u/.penguin/mcp/node"),
            &PathBuf::from("/Users/u/.penguin/mcp/dist/index.js"),
        )
        .unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert!(saved["mcpServers"].get("pengvi").is_none());
        assert_eq!(saved["mcpServers"]["other"]["command"], "other-mcp");
        assert_eq!(saved["numStartups"], 42);
        assert_eq!(result.removed_aliases, vec!["pengvi"]);
        assert!(result.ambiguous_aliases.is_empty());

        let _ = fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[test]
    fn claude_migration_preserves_ambiguous_pengvi() {
        let cfg_path = temp_config_path("claude-legacy-ambiguous").with_extension("json");
        fs::write(
            &cfg_path,
            r#"{
              "mcpServers": {
                "pengvi": {
                  "command": "/opt/custom/bin/server",
                  "args": ["serve"]
                }
              }
            }"#,
        )
        .unwrap();

        let result = write_claude_desktop_mcp_config_at(
            &cfg_path,
            &PathBuf::from("/Users/u/.penguin/mcp/node"),
            &PathBuf::from("/Users/u/.penguin/mcp/dist/index.js"),
        )
        .unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(
            saved["mcpServers"]["pengvi"]["command"],
            "/opt/custom/bin/server"
        );
        assert!(result.removed_aliases.is_empty());
        assert_eq!(result.ambiguous_aliases.len(), 1);
        assert_eq!(result.ambiguous_aliases[0].name, "pengvi");
        assert!(!result.ambiguous_aliases[0].safe_to_migrate);

        let _ = fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[test]
    fn claude_migration_is_idempotent() {
        let cfg_path = temp_config_path("claude-idempotent").with_extension("json");
        fs::write(&cfg_path, r#"{"mcpServers":{}}"#).unwrap();
        let node = PathBuf::from("/Users/u/.penguin/mcp/node");
        let server = PathBuf::from("/Users/u/.penguin/mcp/dist/index.js");

        let first =
            write_claude_desktop_mcp_config_at(&cfg_path, &node, &server).unwrap();
        let after_first = fs::read(&cfg_path).unwrap();
        let second =
            write_claude_desktop_mcp_config_at(&cfg_path, &node, &server).unwrap();
        let after_second = fs::read(&cfg_path).unwrap();

        assert!(first.written);
        assert!(!second.written);
        assert_eq!(after_first, after_second);

        let _ = fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[test]
    fn codex_migration_removes_owned_pengvi_and_preserves_existing_servers() {
        let cfg_path = temp_config_path("codex-legacy");
        fs::write(
            &cfg_path,
            "[mcp_servers.github]\ncommand = \"github-mcp\"\nargs = [\"stdio\"]\n\n[mcp_servers.pengvi]\ncommand = \"/Users/u/.nvm/node\"\nargs = [\"/Users/u/Desktop/Pengvi/packages/mcp/dist/index.js\"]\n",
        )
        .unwrap();

        let result = write_codex_mcp_config_at(
            &cfg_path,
            &PathBuf::from("/Users/u/.penguin/mcp/node"),
            &PathBuf::from("/Users/u/.penguin/mcp/dist/index.js"),
        )
        .unwrap();
        let saved = fs::read_to_string(&cfg_path).unwrap();

        assert!(saved.contains("[mcp_servers.github]"));
        assert!(saved.contains("[mcp_servers.penguin]"));
        assert!(!saved.contains("[mcp_servers.pengvi]"));
        assert_eq!(result.removed_aliases, vec!["pengvi"]);

        let _ = fs::remove_dir_all(cfg_path.parent().unwrap());
    }

    #[test]
    fn write_codex_mcp_config_preserves_existing_servers() {
        let cfg_path = temp_config_path("preserve");
        fs::write(
            &cfg_path,
            "[mcp_servers.github]\ncommand = \"github-mcp\"\nargs = [\"stdio\"]\n",
        )
        .unwrap();

        write_codex_mcp_config_at(
            &cfg_path,
            &PathBuf::from("/usr/local/bin/node"),
            &PathBuf::from(
                "/Applications/Penguin.app/Contents/Resources/_up_/packages/mcp/dist/index.js",
            ),
        )
        .unwrap();

        let saved = fs::read_to_string(&cfg_path).unwrap();
        assert!(saved.contains("[mcp_servers.github]"));
        assert!(saved.contains("[mcp_servers.penguin]"));
        assert!(saved.contains("command = \"/usr/local/bin/node\""));
        assert!(saved.contains("args = [\"/Applications/Penguin.app/Contents/Resources/_up_/packages/mcp/dist/index.js\"]"));
        assert!(codex_mcp_configured_at(&cfg_path));

        let _ = fs::remove_dir_all(cfg_path.parent().unwrap());
    }
}
