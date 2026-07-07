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
            let candidate = ancestor.join("packages/mcp/dist/index.js");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err("Bundled MCP server (packages/mcp/dist/index.js) not found".to_string())
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

fn ensure_stable_mcp_server<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let bundled = bundled_mcp_server_path(app)?;
    let dir = stable_mcp_dir().ok_or("No home directory")?;
    sync_stable_mcp_files(&bundled, &dir)
}

fn claude_desktop_configured_at(cfg_path: &Path) -> bool {
    std::fs::read_to_string(cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("mcpServers")?.get("penguin").cloned())
        .is_some()
}

fn write_claude_desktop_mcp_config_at(
    cfg_path: &Path,
    node: &Path,
    server: &Path,
) -> Result<(), String> {
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut root: serde_json::Value = if cfg_path.exists() {
        let raw = std::fs::read_to_string(cfg_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("Existing config is not valid JSON: {e}"))?
    } else {
        serde_json::json!({})
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

    servers.as_object_mut().unwrap().insert(
        "penguin".to_string(),
        serde_json::json!({
            "command": node.to_string_lossy(),
            "args": [server.to_string_lossy()],
        }),
    );

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(cfg_path, pretty).map_err(|e| e.to_string())
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

fn write_codex_mcp_config_at(cfg_path: &Path, node: &Path, server: &Path) -> Result<(), String> {
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut doc = if cfg_path.exists() {
        let raw = std::fs::read_to_string(cfg_path).map_err(|e| e.to_string())?;
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

    let mut args = Array::new();
    args.push(server.to_string_lossy().to_string());

    let mut penguin = Table::new();
    penguin["command"] = value(node.to_string_lossy().to_string());
    penguin["args"] = value(args);

    servers.insert("penguin", Item::Table(penguin));
    std::fs::write(cfg_path, doc.to_string()).map_err(|e| e.to_string())
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
    let bundled = ensure_stable_mcp_server(&app)
        .ok()
        .or_else(|| bundled_mcp_server_path(&app).ok());
    let node = detect_node_path();
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

#[tauri::command]
pub(crate) fn mcp_install_to_local_clients<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let server = ensure_stable_mcp_server(&app)?;
    let node = detect_node_path().ok_or("Could not locate a node binary in common paths")?;
    let claude_cfg_path = claude_desktop_config_path().ok_or("No home directory")?;
    let claude_code_cfg_path = claude_code_config_path().ok_or("No home directory")?;
    let codex_cfg_path = codex_config_path().ok_or("No home directory")?;

    write_claude_desktop_mcp_config_at(&claude_cfg_path, &node, &server)?;
    // ~/.claude.json uses the same mcpServers shape, and the merge preserves
    // all of Claude Code's other state in that file.
    write_claude_desktop_mcp_config_at(&claude_code_cfg_path, &node, &server)?;
    write_codex_mcp_config_at(&codex_cfg_path, &node, &server)?;

    Ok(format!(
        "Configured penguin MCP server for Claude Desktop ({}), Claude Code ({}) and Codex CLI ({}). Restart the clients to pick it up.",
        claude_cfg_path.display(),
        claude_code_cfg_path.display(),
        codex_cfg_path.display()
    ))
}

#[cfg(test)]
mod mcp_config_tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

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
