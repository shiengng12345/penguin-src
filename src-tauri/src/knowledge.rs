// Penguin Knowledge — Tauri bridge (Plan 2f / 4).
// The webview can't run Node, so these commands shell out to the bundled
// `penguin` CLI (the SAME tested query/index implementation the MCP tools use —
// §8.3 "CLI == MCP == UI same semantics"), plus a lightweight direct rusqlite
// read for a cheap status pill. The live chokidar watcher runs inside the
// indexer sidecar process the CLI/app launches; here we expose one-shot index +
// query + status commands the Wiki UI (Plan 5) calls via `invoke`.
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::Manager;

use crate::mcp::detect_node_path;

// Resolve the Node used to run the knowledge CLI. Unlike the MCP server (pure
// bundled JS, ABI-agnostic), the CLI loads a NATIVE module (better-sqlite3), so
// it MUST run under a Node whose ABI matches the installed build. In dev that's
// the developer's own shell node — the one `pnpm install` built the native
// module against — so prefer it over homebrew/usr-local (which may be a
// different major with a mismatched ABI). Override with PENGUIN_NODE; packaged
// releases ship their own node + rebuilt natives. Cached (login-shell spawn is
// slow).
// Disk cache for the resolved dev node path. The login-shell probe below
// (`zsh -ilc`) can take seconds on a heavy .zshrc and ran on EVERY app launch —
// the biggest slice of "first Wiki entry is slow" in dev builds. Persisting the
// path lets every launch after the first skip the shell entirely. Busted
// (`clear_node_cache`) if a CLI call later fails like a stale/ABI-wrong node.
fn node_cache_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".penguin").join("node-path"))
}

pub(crate) fn clear_node_cache() {
    if let Some(f) = node_cache_file() {
        let _ = std::fs::remove_file(f);
    }
}

fn probe_node() -> Option<PathBuf> {
    // The dev's login-shell node (matches the native build's ABI).
    if let Ok(out) = std::process::Command::new("zsh")
        .args(["-ilc", "command -v node"])
        .output()
    {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let pb = PathBuf::from(&p);
            if !p.is_empty() && pb.exists() {
                return Some(pb);
            }
        }
    }
    detect_node_path()
}

fn resolve_node() -> Option<PathBuf> {
    static NODE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    NODE.get_or_init(|| {
        if let Ok(p) = std::env::var("PENGUIN_NODE") {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Some(pb);
            }
        }
        // Prior launch's resolution — validated, so an upgraded/removed node
        // falls through to a fresh probe.
        if let Some(cache) = node_cache_file() {
            if let Ok(raw) = std::fs::read_to_string(&cache) {
                let pb = PathBuf::from(raw.trim());
                if pb.exists() {
                    return Some(pb);
                }
            }
        }
        let resolved = probe_node();
        if let Some(ref pb) = resolved {
            if let Some(cache) = node_cache_file() {
                if let Some(dir) = cache.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&cache, pb.to_string_lossy().as_bytes());
            }
        }
        resolved
    })
    .clone()
}

fn knowledge_db_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".penguin/knowledge/knowledge.db"))
}

// A fully self-contained CLI invocation: the Node to run, the CLI entry, and
// (packaged only) the wasm resource dir tree-sitter loads from.
struct CliInvocation {
    node: PathBuf,
    cli: PathBuf,
    wasm_dir: Option<PathBuf>,
}

// The packaged self-contained runtime dir (esbuild bundle + vendored node +
// node_modules + wasm), shipped as a Tauri resource. Tauri rewrites `../foo`
// resources to `_up_/foo` under Resources; probe both layouts.
fn bundled_runtime_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("_up_/packages/knowledge-cli/bundle"),
        resource_dir.join("packages/knowledge-cli/bundle"),
        resource_dir.join("bundle"),
    ];
    candidates
        .into_iter()
        .find(|c| c.join("penguin.mjs").exists())
}

// Resources may be copied without the executable bit; restore it so the
// vendored node can be spawned.
#[cfg(unix)]
fn ensure_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        if perms.mode() & 0o111 == 0 {
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}
#[cfg(not(unix))]
fn ensure_executable(_path: &std::path::Path) {}

// Resolve how to run the CLI: prefer the packaged self-contained bundle (its
// own node + vendored native + wasm), else dev mode (system node + the
// tsc-built dist/bin.js walked up from cwd).
fn resolve_invocation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<CliInvocation, String> {
    // Debug builds prefer the LIVE tsc dist (its schema stays in lockstep with
    // the dev CLI — a stale packaged bundle would otherwise trip the schema
    // downgrade guard on a dev-upgraded DB). Release builds prefer the
    // self-contained bundle. Either way, fall back to the other.
    if cfg!(debug_assertions) {
        if let Some(inv) = dev_invocation(app) {
            return Ok(inv);
        }
        if let Some(inv) = bundled_invocation(app) {
            return Ok(inv);
        }
    } else {
        if let Some(inv) = bundled_invocation(app) {
            return Ok(inv);
        }
        if let Some(inv) = dev_invocation(app) {
            return Ok(inv);
        }
    }
    Err("penguin CLI not found (no dev dist/bin.js, no packaged bundle)".to_string())
}

// The packaged self-contained runtime (own node + vendored native + wasm).
fn bundled_invocation<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<CliInvocation> {
    let dir = bundled_runtime_dir(app)?;
    let node = dir.join("node");
    let cli = dir.join("penguin.mjs");
    if node.exists() && cli.exists() {
        ensure_executable(&node);
        Some(CliInvocation { node, cli, wasm_dir: Some(dir.join("wasm")) })
    } else {
        None
    }
}

// Dev: the tsc-built entry (from packaged Resources or a cwd walk-up) run under
// the developer's own ABI-matched Node.
fn dev_invocation<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<CliInvocation> {
    let mut cli: Option<PathBuf> = None;
    if let Ok(resource_dir) = app.path().resource_dir() {
        for c in [
            resource_dir.join("_up_/packages/knowledge-cli/dist/bin.js"),
            resource_dir.join("packages/knowledge-cli/dist/bin.js"),
            resource_dir.join("bin.js"),
        ] {
            if c.exists() {
                cli = Some(c);
                break;
            }
        }
    }
    if cli.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            for ancestor in cwd.ancestors() {
                let candidate = ancestor.join("packages/knowledge-cli/dist/bin.js");
                if candidate.exists() {
                    cli = Some(candidate);
                    break;
                }
            }
        }
    }
    Some(CliInvocation { node: resolve_node()?, cli: cli?, wasm_dir: None })
}

// Run the bundled CLI with args and return stdout. Single source of query/index
// logic — no duplication of the query layer in Rust.
fn run_cli<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String]) -> Result<String, String> {
    let inv = resolve_invocation(app)?;
    let mut cmd = Command::new(&inv.node);
    cmd.arg(&inv.cli);
    if let Some(wasm) = &inv.wasm_dir {
        cmd.env("PENGUIN_WASM_DIR", wasm);
    }
    for a in args {
        cmd.arg(a);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("penguin CLI failed to launch: {e}"))?;
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&out.stderr);
        // A wrong/stale cached node surfaces as command-not-found (127) or a
        // better-sqlite3 ABI mismatch — drop the cache so the next launch
        // re-probes instead of failing forever.
        if code == 127 || stderr.contains("NODE_MODULE_VERSION") {
            clear_node_cache();
        }
        return Err(format!("penguin CLI exit {}: {}", code, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// Warm the knowledge CLI path off the UI thread at startup. The first query
// otherwise pays, on the Wiki-open critical path: login-shell node resolution
// (`zsh -ilc`, seconds on a heavy .zshrc), node cold-start, better-sqlite3
// native load, and paging in a large knowledge.db — which made first entry into
// the Wiki feel very slow. A cheap `status` call at launch pre-pays all of it
// (populating the resolve_node cache + OS file cache) so the first real query is
// warm. Best-effort: failures (no DB yet, etc.) are ignored.
pub(crate) fn prewarm<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        let _ = run_cli(&app, &["status".to_string(), "--json".to_string()]);
    });
}

// Like run_cli but streams stderr: lines `PENGUIN_PROGRESS {json}` (emitted by
// the CLI under --progress-events) become `knowledge-index-progress` Tauri
// events so the Wiki can show a live bar; stdout is collected as the final
// report. Same event pattern as the package watcher (packages.rs).
fn run_cli_streaming<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String]) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use tauri::Emitter;

    let inv = resolve_invocation(app)?;
    let mut cmd = Command::new(&inv.node);
    cmd.arg(&inv.cli);
    if let Some(wasm) = &inv.wasm_dir {
        cmd.env("PENGUIN_WASM_DIR", wasm);
    }
    let mut child = cmd
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("penguin CLI failed to launch: {e}"))?;

    let stderr = child.stderr.take();
    let app_evt = app.clone();
    let err_handle = std::thread::spawn(move || {
        let mut tail = String::new();
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("PENGUIN_PROGRESS ") {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(rest) {
                        let _ = app_evt.emit("knowledge-index-progress", payload);
                    }
                } else {
                    tail.push_str(&line);
                    tail.push('\n');
                }
            }
        }
        tail
    });

    let mut stdout_buf = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut stdout_buf);
    }
    let status = child.wait().map_err(|e| format!("penguin CLI wait failed: {e}"))?;
    let stderr_tail = err_handle.join().unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "penguin CLI exit {}: {}",
            status.code().unwrap_or(-1),
            stderr_tail.trim()
        ));
    }
    Ok(stdout_buf)
}

// Generic query passthrough for the Wiki UI: e.g. args = ["search","gameurl"]
// or ["callers","GetLoginURL"]. Always JSON. Returns the CLI's raw JSON string
// (the webview parses it) so the UI shares the CLI/MCP query semantics exactly.
#[tauri::command]
pub(crate) fn knowledge_query<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<String, String> {
    let mut full = args;
    if !full.iter().any(|a| a == "--json") {
        full.push("--json".to_string());
    }
    run_cli(&app, &full)
}

// One-shot incremental index of a repo (headless), returns the JSON report.
#[tauri::command]
pub(crate) fn knowledge_reindex<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["index".to_string()];
    if let Some(p) = path {
        args.push(p);
    }
    args.push("--json".to_string());
    args.push("--progress-events".to_string());
    // Streams knowledge-index-progress events while running; returns the report.
    run_cli_streaming(&app, &args)
}

#[derive(Serialize)]
pub(crate) struct KnowledgeDbStatus {
    db_path: String,
    exists: bool,
    repos: i64,
    symbols: i64,
    notes: i64,
}

// Cheap status pill: a direct rusqlite read (no Node spawn) so the UI can show
// "initialized?" + counts instantly.
#[tauri::command]
pub(crate) fn knowledge_db_status() -> KnowledgeDbStatus {
    let path = knowledge_db_path();
    let db_path = path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let exists = path.as_ref().map(|p| p.exists()).unwrap_or(false);
    if !exists {
        return KnowledgeDbStatus { db_path, exists: false, repos: 0, symbols: 0, notes: 0 };
    }
    let count = |conn: &rusqlite::Connection, sql: &str| -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
    };
    match rusqlite::Connection::open(path.expect("path checked above")) {
        Ok(c) => KnowledgeDbStatus {
            db_path,
            exists: true,
            repos: count(&c, "SELECT COUNT(*) FROM repos"),
            symbols: count(&c, "SELECT COUNT(*) FROM nodes WHERE node_type='symbol'"),
            notes: count(&c, "SELECT COUNT(*) FROM nodes WHERE node_type='note'"),
        },
        Err(_) => KnowledgeDbStatus { db_path, exists: true, repos: 0, symbols: 0, notes: 0 },
    }
}
