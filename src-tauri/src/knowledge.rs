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
fn resolve_node() -> Option<PathBuf> {
    static NODE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    NODE.get_or_init(|| {
        if let Ok(p) = std::env::var("PENGUIN_NODE") {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Some(pb);
            }
        }
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
    })
    .clone()
}

fn knowledge_db_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".penguin/knowledge/knowledge.db"))
}

// Resolve the bundled penguin CLI entry (mirrors bundled_mcp_server_path):
// packaged Resources first, then a dev-workspace walk-up.
fn bundled_cli_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("_up_/packages/knowledge-cli/dist/bin.js"),
            resource_dir.join("packages/knowledge-cli/dist/bin.js"),
            resource_dir.join("bin.js"),
        ];
        for c in candidates {
            if c.exists() {
                return Ok(c);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            let candidate = ancestor.join("packages/knowledge-cli/dist/bin.js");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err("Bundled penguin CLI (packages/knowledge-cli/dist/bin.js) not found".to_string())
}

// Run the bundled CLI with args and return stdout. Single source of query/index
// logic — no duplication of the query layer in Rust.
fn run_cli<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String]) -> Result<String, String> {
    let node = resolve_node().ok_or("Node.js not detected in common paths")?;
    let cli = bundled_cli_path(app)?;
    let mut cmd = Command::new(node);
    cmd.arg(&cli);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("penguin CLI failed to launch: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "penguin CLI exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
    run_cli(&app, &args)
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
