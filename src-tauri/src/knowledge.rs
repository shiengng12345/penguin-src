// Penguin Knowledge — Tauri bridge (Plan 2f / 4).
// The webview can't run Node, so these commands shell out to the bundled
// `penguin` CLI (the SAME tested query/index implementation the MCP tools use —
// §8.3 "CLI == MCP == UI same semantics"), plus a lightweight direct rusqlite
// read for a cheap status pill. Live auto-indexing (chokidar) runs inside a
// `penguin watch <path>` child process spawned per repo via WatchRegistry
// below; everything else here is one-shot index + query + status commands
// the Wiki UI (Plan 5) calls via `invoke`.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
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

// Install a `penguin` launcher onto the user's PATH (~/.local/bin) so the CLI is
// usable from a terminal with zero manual setup (no chicken-and-egg `penguin
// install`). We write a tiny wrapper that execs the SAME node + bundled CLI the
// app itself uses — robust even when the user has no node / an ABI-mismatched
// node. Idempotent: refreshed on every launch, so it self-heals if the app is
// moved or updated. Runs off the main thread (resolve_invocation may probe node).
pub fn install_cli_command<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        let _ = install_launcher(&app);
    });
}

// Synchronous core of the launcher install — also invoked by the one-click
// CLI setup command so onboarding can install on demand and report errors.
fn install_launcher<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let inv = resolve_invocation(app)?;
    let home = std::env::var_os("HOME").ok_or("no HOME")?;
    let bin_dir = PathBuf::from(home).join(".local/bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let target = bin_dir.join("penguin");
    let wasm_line = inv
        .wasm_dir
        .as_ref()
        .map(|w| format!("export PENGUIN_WASM_DIR=\"{}\"\n", w.display()))
        .unwrap_or_default();
    let script = format!(
        "#!/bin/sh\n# Auto-generated by Penguin.app — runs the bundled knowledge CLI.\n{}exec \"{}\" \"{}\" \"$@\"\n",
        wasm_line,
        inv.node.display(),
        inv.cli.display(),
    );
    write_launcher_script(&target, &script).map_err(|e| e.to_string())?;
    ensure_executable(&target);
    Ok(target)
}

fn local_bin_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/bin"))
}

fn bin_dir_on_path(bin_dir: &std::path::Path) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|e| e == bin_dir))
        .unwrap_or(false)
}

// Idempotently ensure an rc file puts ~/.local/bin on PATH. Returns true when
// a line was appended, false when the rc file already covers it. Detection is
// content-based (any mention of `.local/bin`), so a user's own PATH line —
// however they wrote it — counts and we never append a duplicate.
fn ensure_zshrc_path(rc: &std::path::Path, appended_line: &str) -> std::io::Result<bool> {
    let current = std::fs::read_to_string(rc).unwrap_or_default();
    if current.contains(".local/bin") {
        return Ok(false);
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(appended_line);
    std::fs::write(rc, next)?;
    Ok(true)
}

// Which rc files to touch — and with what syntax — for the user's login shell.
// Different machines run different shells: zsh (macOS default), bash (most
// Linux), fish (own non-POSIX syntax). Unknown shells get an empty list and
// the caller surfaces a manual hint instead of guessing.
fn rc_targets_for_shell(home: &std::path::Path, shell: &str) -> Vec<(PathBuf, String)> {
    const POSIX_LINE: &str = "\n# Added by Penguin.app — penguin CLI lives in ~/.local/bin\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";
    const FISH_LINE: &str = "\n# Added by Penguin.app — penguin CLI lives in ~/.local/bin\nfish_add_path -g $HOME/.local/bin\n";
    match shell {
        "zsh" => vec![(home.join(".zshrc"), POSIX_LINE.to_string())],
        "bash" => {
            let mut t = vec![(home.join(".bashrc"), POSIX_LINE.to_string())];
            // macOS login shells read ~/.bash_profile, not ~/.bashrc — cover an
            // existing one too (never create it: absence means bashrc rules).
            let profile = home.join(".bash_profile");
            if profile.exists() {
                t.push((profile, POSIX_LINE.to_string()));
            }
            t
        }
        "fish" => vec![(home.join(".config/fish/config.fish"), FISH_LINE.to_string())],
        _ => vec![],
    }
}

fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .and_then(|s| s.rsplit('/').next().map(String::from))
        .unwrap_or_default()
}

// Guidance files for AI clients that are actually present on THIS machine —
// never scaffold config dirs for tools the user hasn't installed.
fn guidance_targets(home: &std::path::Path) -> Vec<PathBuf> {
    let mut targets = Vec::new();
    if home.join(".claude").is_dir() || home.join(".claude.json").exists() {
        targets.push(home.join(".claude/CLAUDE.md"));
    }
    if home.join(".codex").is_dir() {
        targets.push(home.join(".codex/AGENTS.md"));
    }
    targets
}

const GUIDANCE_BEGIN: &str = "<!-- BEGIN PENGUIN KNOWLEDGE (auto-managed) -->";
const GUIDANCE_END: &str = "<!-- END PENGUIN KNOWLEDGE (auto-managed) -->";

// User-global agent guidance (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md): same
// marker block the repo-level `penguin init` writes (agent-guidance.ts), so a
// re-run replaces exactly this region and never touches the user's own prose.
fn global_guidance_block() -> String {
    [
        GUIDANCE_BEGIN,
        "## Penguin Knowledge",
        "",
        "Code repos on this machine are indexed by **Penguin Knowledge** (a local code",
        "knowledge graph). Before reading files to understand or change code, query it —",
        "faster and more precise than grep/manual reading:",
        "",
        "- Start MCP code-understanding work with `knowledge_explore` (source, flow, tests, trust)",
        "- Use `knowledge_search` for exact symbol discovery and `get_node` for one source",
        "- Use `explore_graph` for narrow traversal; inspect `queryDiagnostics` before trusting empty results",
        "- `penguin context <symbol|route>` — callers, callees, types, routes, tests, notes",
        "- `penguin flow <endpoint|symbol>` — linear execution chain (endpoint→service→db→…)",
        "- `penguin affected <file>…` — blast radius of a change; `penguin search <query>` — find symbols",
        "- `penguin architecture` — repo overview; `penguin services` — cross-service map",
        "",
        "The same data is exposed as `penguin` MCP tools when the MCP server is configured.",
        "Re-index after edits with `penguin index`.",
        GUIDANCE_END,
    ]
    .join("\n")
}

// Insert/replace the managed block in a file's content. None = already current.
fn reconcile_guidance_block(existing: Option<&str>, fresh: &str) -> Option<String> {
    let existing = match existing {
        None => return Some(format!("{fresh}\n")),
        Some(e) => e,
    };
    if let (Some(start), Some(end)) = (existing.find(GUIDANCE_BEGIN), existing.find(GUIDANCE_END)) {
        if end > start {
            let next = format!("{}{}{}", &existing[..start], fresh, &existing[end + GUIDANCE_END.len()..]);
            return if next == existing { None } else { Some(next) };
        }
    }
    let sep = if existing.ends_with('\n') { "\n" } else { "\n\n" };
    Some(format!("{existing}{sep}{fresh}\n"))
}

const PENGUIN_HOOK_MARKER: &str = "--managed-by=penguin";

fn is_penguin_managed_hook(value: &serde_json::Value) -> bool {
    value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|command| command.contains(PENGUIN_HOOK_MARKER))
}

// Reconcile only Penguin-owned command hooks inside Claude Code settings.
// Unknown top-level fields, event groups, matchers, and third-party commands
// are preserved. Invalid JSON is an error so callers never overwrite it.
fn reconcile_claude_hooks(
    existing: &str,
    session_start: bool,
    user_prompt_submit: bool,
) -> Result<Option<String>, String> {
    let mut root: serde_json::Value =
        serde_json::from_str(existing).map_err(|e| format!("invalid Claude settings JSON: {e}"))?;
    if !root.is_object() {
        return Err("invalid Claude settings JSON: root must be an object".to_string());
    }
    let before = root.clone();
    let needs_hooks = session_start || user_prompt_submit || root.get("hooks").is_some();
    if !needs_hooks {
        return Ok(None);
    }
    let hooks = root
        .as_object_mut()
        .expect("object checked above")
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("invalid Claude settings JSON: hooks must be an object")?;

    for event in ["SessionStart", "UserPromptSubmit"] {
        if let Some(groups) = hooks.get_mut(event) {
            let groups = groups
                .as_array_mut()
                .ok_or_else(|| format!("invalid Claude settings JSON: hooks.{event} must be an array"))?;
            groups.retain_mut(|group| {
                let Some(commands) = group.get_mut("hooks") else {
                    return true;
                };
                let Some(commands) = commands.as_array_mut() else {
                    return true;
                };
                commands.retain(|command| !is_penguin_managed_hook(command));
                !commands.is_empty()
            });
        }
    }

    let mut install = |event: &str, enabled: bool, command: &str, matcher: bool| {
        if !enabled {
            return;
        }
        let mut group = serde_json::json!({
            "hooks": [{"type": "command", "command": command}]
        });
        if matcher {
            group
                .as_object_mut()
                .expect("literal object")
                .insert("matcher".to_string(), serde_json::json!(""));
        }
        hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("event validated or newly created")
            .push(group);
    };
    install(
        "SessionStart",
        session_start,
        "penguin hook session-start --managed-by=penguin",
        true,
    );
    install(
        "UserPromptSubmit",
        user_prompt_submit,
        "penguin hook user-prompt-submit --managed-by=penguin",
        false,
    );

    if root == before {
        Ok(None)
    } else {
        serde_json::to_string_pretty(&root)
            .map(|next| Some(format!("{next}\n")))
            .map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
pub struct HookSetupResult {
    pub supported: bool,
    pub written: bool,
    pub settings_path: String,
    pub enabled: Vec<&'static str>,
}

fn atomic_write_preserving_permissions(
    path: &std::path::Path,
    content: &str,
) -> Result<(), String> {
    use std::io::Write as _;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let temp = path.with_extension(
        path.extension()
            .and_then(std::ffi::OsStr::to_str)
            .map(|ext| format!("{ext}.penguin.tmp"))
            .unwrap_or_else(|| "penguin.tmp".to_string()),
    );
    // A previous interrupted write may have left only Penguin's temporary
    // file. Remove that path first; remove_file does not follow symlinks.
    if temp.exists() {
        std::fs::remove_file(&temp).map_err(|e| format!("{}: {e}", temp.display()))?;
    }

    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("{}: {e}", temp.display()))?;
        if let Ok(metadata) = std::fs::metadata(path) {
            file.set_permissions(metadata.permissions())
                .map_err(|e| format!("{}: {e}", temp.display()))?;
        }
        file.write_all(content.as_bytes())
            .map_err(|e| format!("{}: {e}", temp.display()))?;
        file.sync_all()
            .map_err(|e| format!("{}: {e}", temp.display()))?;
        drop(file);
        std::fs::rename(&temp, path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn setup_claude_hooks_at(
    settings_path: &std::path::Path,
    session_start: bool,
    user_prompt_submit: bool,
) -> Result<HookSetupResult, String> {
    let existing = if settings_path.exists() {
        std::fs::read_to_string(settings_path)
            .map_err(|e| format!("{}: {e}", settings_path.display()))?
    } else {
        "{}".to_string()
    };
    let next = reconcile_claude_hooks(&existing, session_start, user_prompt_submit)?;
    let written = next.is_some();
    if let Some(next) = next {
        atomic_write_preserving_permissions(settings_path, &next)?;
    }
    let mut enabled = Vec::new();
    if session_start {
        enabled.push("SessionStart");
    }
    if user_prompt_submit {
        enabled.push("UserPromptSubmit");
    }
    Ok(HookSetupResult {
        supported: true,
        written,
        settings_path: settings_path.display().to_string(),
        enabled,
    })
}

// Claude Code exposes native lifecycle hooks. Codex receives the same Penguin
// context through the canonical MCP plus its managed AGENTS.md instructions;
// it does not currently expose an equivalent settings hook contract here.
#[tauri::command]
pub(crate) fn knowledge_agent_hook_setup(
    session_start: bool,
    user_prompt_submit: bool,
) -> Result<HookSetupResult, String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("no HOME")?);
    let settings = home.join(".claude/settings.json");
    if !home.join(".claude").is_dir() && !home.join(".claude.json").exists() {
        return Ok(HookSetupResult {
            supported: false,
            written: false,
            settings_path: settings.display().to_string(),
            enabled: Vec::new(),
        });
    }
    setup_claude_hooks_at(&settings, session_start, user_prompt_submit)
}

#[derive(Serialize)]
pub struct GuidanceSetupResult {
    // Files written or refreshed (client detected on this machine).
    pub written: Vec<String>,
    // Clients not found here — nothing scaffolded for them.
    pub skipped: Vec<String>,
}

// Write/refresh the global Penguin guidance in the user-level instruction
// files of AI clients that exist on THIS machine (Claude Code / Codex).
#[tauri::command]
pub(crate) fn knowledge_agent_guidance_setup() -> Result<GuidanceSetupResult, String> {
    let home = std::env::var_os("HOME").ok_or("no HOME")?;
    let home = PathBuf::from(home);
    let fresh = global_guidance_block();
    let targets = guidance_targets(&home);
    let mut skipped = Vec::new();
    if !home.join(".claude").is_dir() && !home.join(".claude.json").exists() {
        skipped.push("Claude Code".to_string());
    }
    if !home.join(".codex").is_dir() {
        skipped.push("Codex".to_string());
    }
    let mut written = Vec::new();
    for target in targets {
        let existing = std::fs::read_to_string(&target).ok();
        if let Some(next) = reconcile_guidance_block(existing.as_deref(), &fresh) {
            std::fs::write(&target, next).map_err(|e| format!("{}: {e}", target.display()))?;
            written.push(target.display().to_string());
        }
    }
    Ok(GuidanceSetupResult { written, skipped })
}

#[derive(Serialize)]
pub struct CliSetupStatus {
    // The ~/.local/bin/penguin launcher exists.
    pub installed: bool,
    // ~/.local/bin is on the app-captured user PATH (terminal can resolve it).
    pub on_path: bool,
    // Setup appended a PATH line to the shell's rc — new terminals only.
    pub rc_updated: bool,
    pub bin_dir: String,
    // The user's login shell (basename of $SHELL); empty when undetectable.
    pub shell: String,
    // Set when we could NOT wire PATH automatically (unknown shell) — the UI
    // shows this as a manual instruction instead of claiming success.
    pub manual_hint: Option<String>,
}

#[tauri::command]
pub(crate) fn knowledge_cli_status() -> CliSetupStatus {
    let bin_dir = local_bin_dir();
    let installed = bin_dir.as_ref().map(|d| d.join("penguin").exists()).unwrap_or(false);
    let on_path = bin_dir.as_ref().map(|d| bin_dir_on_path(d)).unwrap_or(false);
    CliSetupStatus {
        installed,
        on_path,
        rc_updated: false,
        bin_dir: bin_dir.map(|d| d.display().to_string()).unwrap_or_default(),
        shell: login_shell(),
        manual_hint: None,
    }
}

// One-click CLI setup from onboarding: write the launcher now (not just at app
// start) and make sure ~/.local/bin reaches the user's zsh PATH. Off the main
// thread — install_launcher may probe node via a login shell.
#[tauri::command]
pub(crate) async fn knowledge_cli_setup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<CliSetupStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_launcher(&app)?;
        let bin_dir = local_bin_dir().ok_or("no HOME")?;
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("no HOME")?);
        let shell = login_shell();
        let mut rc_updated = false;
        let mut manual_hint = None;
        if !bin_dir_on_path(&bin_dir) {
            let targets = rc_targets_for_shell(&home, &shell);
            if targets.is_empty() {
                // Unknown shell — don't guess at rc syntax; tell the user.
                manual_hint = Some(format!(
                    "无法识别你的 shell({}),请手动把 {} 加入 PATH",
                    if shell.is_empty() { "未知" } else { &shell },
                    bin_dir.display(),
                ));
            }
            for (rc, line) in targets {
                if let Some(dir) = rc.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                rc_updated |= ensure_zshrc_path(&rc, &line)
                    .map_err(|e| format!("could not update {}: {e}", rc.display()))?;
            }
        }
        Ok(CliSetupStatus {
            installed: true,
            on_path: bin_dir_on_path(&bin_dir) || rc_updated,
            rc_updated,
            bin_dir: bin_dir.display().to_string(),
            shell,
            manual_hint,
        })
    })
    .await
    .map_err(|e| format!("cli setup task failed: {e}"))?
}

// Write the launcher script at `target`, skipping the write when the content
// is already current (avoids needless disk churn on every launch). A
// pre-existing `penguin` may be a SYMLINK (npm link / manual ln -s) pointing at
// dist/bin.js itself — fs::write follows symlinks, so writing through it would
// clobber the real CLI entry with shell text. Remove the link and write a
// regular file instead.
fn write_launcher_script(target: &std::path::Path, script: &str) -> std::io::Result<()> {
    match std::fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(target)?,
        Ok(meta) if meta.is_file()
            && std::fs::read_to_string(target).ok().as_deref() == Some(script) =>
        {
            return Ok(());
        }
        _ => {}
    }
    std::fs::write(target, script)
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_zshrc_path, reconcile_claude_hooks, reconcile_guidance_block,
        write_launcher_script,
    };
    use std::path::PathBuf;

    #[test]
    fn guidance_block_appends_replaces_and_noops() {
        let fresh = super::global_guidance_block();
        assert!(
            fresh.find("knowledge_explore").unwrap()
                < fresh.find("knowledge_search").unwrap()
        );
        assert!(fresh.contains("queryDiagnostics"));
        // Missing file → block plus trailing newline.
        let created = reconcile_guidance_block(None, &fresh).unwrap();
        assert!(created.starts_with(super::GUIDANCE_BEGIN) && created.ends_with("-->\n"));
        // Already current → no write.
        assert!(reconcile_guidance_block(Some(&created), &fresh).is_none());
        // User prose around a stale block survives; block content refreshed.
        let stale = format!(
            "# my notes\n{}\nold penguin text\n{}\ntail prose\n",
            super::GUIDANCE_BEGIN,
            super::GUIDANCE_END
        );
        let next = reconcile_guidance_block(Some(&stale), &fresh).unwrap();
        assert!(next.starts_with("# my notes\n"), "prose before block kept");
        assert!(next.ends_with("\ntail prose\n"), "prose after block kept");
        assert!(!next.contains("old penguin text"), "stale block replaced");
        // File without a block → appended after user content.
        let plain = reconcile_guidance_block(Some("# mine\n"), &fresh).unwrap();
        assert!(plain.starts_with("# mine\n") && plain.contains(super::GUIDANCE_BEGIN));
    }

    const RC_LINE: &str = "\n# Added by Penguin.app\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";

    #[test]
    fn rc_targets_follow_the_users_shell() {
        let d = tmp_dir("shells");
        // zsh → ~/.zshrc with POSIX export syntax.
        let zsh = super::rc_targets_for_shell(&d, "zsh");
        assert_eq!(zsh.len(), 1);
        assert!(zsh[0].0.ends_with(".zshrc") && zsh[0].1.contains("export PATH="));
        // bash without a .bash_profile → just ~/.bashrc.
        let bash = super::rc_targets_for_shell(&d, "bash");
        assert_eq!(bash.len(), 1);
        assert!(bash[0].0.ends_with(".bashrc"));
        // macOS bash logins read .bash_profile — cover it too when it exists.
        std::fs::write(d.join(".bash_profile"), "# existing\n").unwrap();
        let bash2 = super::rc_targets_for_shell(&d, "bash");
        assert_eq!(bash2.len(), 2, ".bashrc + existing .bash_profile");
        // fish uses its own builtin, NOT export PATH=.
        let fish = super::rc_targets_for_shell(&d, "fish");
        assert_eq!(fish.len(), 1);
        assert!(fish[0].0.ends_with("config.fish") && fish[0].1.contains("fish_add_path"));
        assert!(!fish[0].1.contains("export PATH="), "fish syntax differs");
        // unknown shell → nothing to write; caller must surface a manual hint.
        assert!(super::rc_targets_for_shell(&d, "nushell").is_empty());
    }

    #[test]
    fn guidance_targets_only_include_installed_clients() {
        let d = tmp_dir("clients");
        // Nothing installed → nothing written, no junk dirs created.
        assert!(super::guidance_targets(&d).is_empty());
        // Claude Code present (either ~/.claude dir or ~/.claude.json).
        std::fs::create_dir_all(d.join(".claude")).unwrap();
        let t1 = super::guidance_targets(&d);
        assert_eq!(t1.len(), 1);
        assert!(t1[0].ends_with(".claude/CLAUDE.md"));
        // Codex present too.
        std::fs::create_dir_all(d.join(".codex")).unwrap();
        let t2 = super::guidance_targets(&d);
        assert_eq!(t2.len(), 2);
        assert!(t2[1].ends_with(".codex/AGENTS.md"));
    }

    #[test]
    fn claude_hooks_are_opt_in_preserve_existing_and_are_idempotent() {
        let existing = r#"{
          "theme": "dark",
          "hooks": {
            "PreToolUse": [{
              "matcher": "Bash",
              "hooks": [{"type":"command","command":"rtk hook claude"}]
            }],
            "UserPromptSubmit": [{
              "hooks": [{"type":"command","command":"codegraph prompt-hook"}]
            }]
          }
        }"#;
        let installed = reconcile_claude_hooks(existing, true, true)
            .unwrap()
            .expect("first setup writes");
        let json: serde_json::Value = serde_json::from_str(&installed).unwrap();
        assert_eq!(json["theme"], "dark");
        let rendered = serde_json::to_string(&json).unwrap();
        assert!(rendered.contains("rtk hook claude"));
        assert!(rendered.contains("codegraph prompt-hook"));
        assert!(rendered.contains("penguin hook session-start --managed-by=penguin"));
        assert!(rendered.contains("penguin hook user-prompt-submit --managed-by=penguin"));
        assert!(reconcile_claude_hooks(&installed, true, true).unwrap().is_none());
    }

    #[test]
    fn disabling_claude_hooks_removes_only_penguin_managed_entries() {
        let existing = r#"{
          "hooks": {
            "SessionStart": [{"matcher":"","hooks":[
              {"type":"command","command":"penguin hook session-start --managed-by=penguin"},
              {"type":"command","command":"other session hook"}
            ]}],
            "UserPromptSubmit": [
              {"hooks":[{"type":"command","command":"penguin hook user-prompt-submit --managed-by=penguin"}]},
              {"hooks":[{"type":"command","command":"other prompt hook"}]}
            ]
          }
        }"#;
        let disabled = reconcile_claude_hooks(existing, false, false)
            .unwrap()
            .expect("managed hooks removed");
        assert!(!disabled.contains("--managed-by=penguin"));
        assert!(disabled.contains("other session hook"));
        assert!(disabled.contains("other prompt hook"));
    }

    #[test]
    fn invalid_claude_settings_are_never_rewritten() {
        assert!(reconcile_claude_hooks("{broken", true, true).is_err());
    }

    #[test]
    fn hook_setup_writes_once_and_reports_enabled_events() {
        let d = tmp_dir("claude-hook-setup");
        let settings = d.join("settings.json");
        std::fs::write(&settings, "{\"custom\":true}\n").unwrap();
        let first = super::setup_claude_hooks_at(&settings, true, false).unwrap();
        assert!(first.written);
        assert_eq!(first.enabled, vec!["SessionStart"]);
        assert!(std::fs::read_to_string(&settings)
            .unwrap()
            .contains("penguin hook session-start"));
        let second = super::setup_claude_hooks_at(&settings, true, false).unwrap();
        assert!(!second.written, "same setup is a no-op");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_settings_write_preserves_permissions_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;

        let d = tmp_dir("atomic-settings");
        let settings = d.join("settings.json");
        std::fs::write(&settings, "{\"before\":true}\n").unwrap();
        std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o600)).unwrap();

        super::atomic_write_preserving_permissions(&settings, "{\"after\":true}\n").unwrap();

        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{\"after\":true}\n");
        assert_eq!(std::fs::metadata(&settings).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!settings.with_extension("json.penguin.tmp").exists());
    }

    #[test]
    fn zshrc_append_is_idempotent_and_respects_user_lines() {
        let d = tmp_dir("zshrc");
        let rc = d.join(".zshrc");
        // Fresh file: appended once, second call is a no-op.
        assert!(ensure_zshrc_path(&rc, RC_LINE).unwrap());
        assert!(!ensure_zshrc_path(&rc, RC_LINE).unwrap());
        assert_eq!(
            std::fs::read_to_string(&rc).unwrap().matches(".local/bin").count(),
            1,
            "no duplicate PATH lines"
        );
        // A user-authored line mentioning .local/bin counts — never append.
        let user_rc = d.join(".zshrc-user");
        std::fs::write(&user_rc, "path+=(\"$HOME/.local/bin\")\n").unwrap();
        assert!(!ensure_zshrc_path(&user_rc, RC_LINE).unwrap());
        assert_eq!(std::fs::read_to_string(&user_rc).unwrap(), "path+=(\"$HOME/.local/bin\")\n");
        // Existing content without trailing newline stays intact.
        let ragged = d.join(".zshrc-ragged");
        std::fs::write(&ragged, "alias ll='ls -la'").unwrap();
        assert!(ensure_zshrc_path(&ragged, RC_LINE).unwrap());
        let body = std::fs::read_to_string(&ragged).unwrap();
        assert!(body.starts_with("alias ll='ls -la'\n"), "newline inserted before append");
        assert!(body.contains(".local/bin"));
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pengvi-launcher-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[test]
    fn replaces_preexisting_symlink_without_clobbering_its_target() {
        let d = tmp_dir("symlink");
        // A stale `penguin` symlink (npm link / manual ln -s) pointing at the
        // CLI entry itself — writing through it must not clobber bin.js.
        let cli = d.join("bin.js");
        std::fs::write(&cli, "console.log('cli')\n").unwrap();
        let target = d.join("penguin");
        std::os::unix::fs::symlink(&cli, &target).unwrap();

        let wrapper = "#!/bin/sh\nexec node bin.js\n";
        write_launcher_script(&target, wrapper).unwrap();

        assert_eq!(
            std::fs::read_to_string(&cli).unwrap(),
            "console.log('cli')\n",
            "symlink target (the real CLI) must stay intact"
        );
        let meta = std::fs::symlink_metadata(&target).unwrap();
        assert!(!meta.file_type().is_symlink(), "launcher must become a regular file");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), wrapper);
    }

    #[test]
    fn writes_fresh_launcher_and_is_idempotent() {
        let d = tmp_dir("fresh");
        let target = d.join("penguin");
        let wrapper = "#!/bin/sh\nexec node bin.js\n";
        write_launcher_script(&target, wrapper).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), wrapper);
        // Second write with same content is a no-op and must not error.
        write_launcher_script(&target, wrapper).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), wrapper);
    }

    #[test]
    fn watch_status_serializes_repo_id_as_camel_case() {
        // Real bug: the frontend's `WatchStatus` TS interface
        // (src/lib/knowledge-client.ts) expects `repoId`, but this struct had
        // no #[serde(rename_all = "camelCase")], so it serialized as
        // `repo_id`. Every call to knowledge_watch_status (on mount, and on
        // every auto-refresh tick) silently produced `repoId: undefined` on
        // every row, so the frontend's `watching` Set could never contain a
        // real repo id — the "自动同步" toggle highlight reverted to
        // off-looking on every refresh even though the watcher was still
        // genuinely running.
        let status = super::WatchStatus { repo_id: "repo_abc".into(), watching: true };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["repoId"], "repo_abc", "must serialize as camelCase repoId, not repo_id");
        assert_eq!(json["watching"], true);
    }

    #[test]
    fn watch_lease_key_uses_the_canonical_repository_path() {
        let d = tmp_dir("watch-canonical");
        let repo = d.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let plain = super::watch_lease_path(&d, &repo).unwrap();
        let dotted = super::watch_lease_path(&d, &repo.join(".")).unwrap();
        assert_eq!(plain, dotted);
    }

    #[test]
    fn watch_lease_rejects_a_second_live_owner() {
        let d = tmp_dir("watch-live-owner");
        let repo = d.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let first = super::try_acquire_watch_lease(
            &d,
            "repo-a",
            &repo,
            std::process::id(),
        )
        .unwrap();
        let second = super::try_acquire_watch_lease(
            &d,
            "repo-b",
            &repo,
            std::process::id(),
        );
        assert!(second.is_err(), "a live canonical root must have one owner");
        std::fs::remove_file(first).unwrap();
    }

    #[test]
    fn watch_lease_replaces_a_stale_owner() {
        let d = tmp_dir("watch-stale-owner");
        let repo = d.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let path = super::watch_lease_path(&d, &repo).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "repo_id": "old",
                "root_path": repo,
                "child_pid": 999_999_999_u32,
                "owner_pid": 999_999_999_u32
            })
            .to_string(),
        )
        .unwrap();
        let acquired = super::try_acquire_watch_lease(
            &d,
            "new",
            &repo,
            std::process::id(),
        )
        .unwrap();
        let lease: super::WatchLease =
            serde_json::from_str(&std::fs::read_to_string(acquired).unwrap()).unwrap();
        assert_eq!(lease.repo_id, "new");
        assert_eq!(lease.owner_pid, std::process::id());
    }

    #[test]
    fn watch_command_parser_accepts_only_penguin_watch_processes() {
        assert_eq!(
            super::parse_watch_command(
                "node /opt/penguin/bin.js watch /Users/me/repo --progress-events",
            ),
            Some(PathBuf::from("/Users/me/repo")),
        );
        assert_eq!(super::parse_watch_command("node app.js index /Users/me/repo"), None);
        assert_eq!(super::parse_watch_command("npm run watch /Users/me/repo"), None);
    }
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
pub(crate) async fn knowledge_query<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<String, String> {
    let mut full = args;
    if !full.iter().any(|a| a == "--json") {
        full.push("--json".to_string());
    }
    // run_cli spawns a Node process and blocks until it exits. A *sync*
    // #[tauri::command] runs on the main thread, so that block froze the whole
    // webview for the query's duration (the "服务图 freezes the app" bug). Async
    // + spawn_blocking moves it to a worker thread; the UI stays responsive.
    tauri::async_runtime::spawn_blocking(move || run_cli(&app, &full))
        .await
        .map_err(|e| format!("knowledge query task failed: {e}"))?
}

// One-shot incremental index of a repo (headless), returns the JSON report.
#[tauri::command]
pub(crate) async fn knowledge_reindex<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["index".to_string()];
    if let Some(p) = path {
        args.push(p);
    }
    args.push("--json".to_string());
    args.push("--progress-events".to_string());
    // Indexing can run for minutes — never on the main thread, or the whole UI
    // freezes for the entire index. Streams knowledge-index-progress events.
    tauri::async_runtime::spawn_blocking(move || run_cli_streaming(&app, &args))
        .await
        .map_err(|e| format!("knowledge reindex task failed: {e}"))?
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
// "initialized?" + counts. The COUNTs still touch a large table (~0.3s on a big
// DB), so run off the main thread — a sync command would freeze the UI on every
// Wiki mount.
#[tauri::command]
pub(crate) async fn knowledge_db_status() -> KnowledgeDbStatus {
    tauri::async_runtime::spawn_blocking(db_status_blocking)
        .await
        .unwrap_or(KnowledgeDbStatus {
            db_path: String::new(),
            exists: false,
            repos: 0,
            symbols: 0,
            notes: 0,
        })
}

fn db_status_blocking() -> KnowledgeDbStatus {
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

// --- Live auto-index watcher (Wiki's "自动同步" toggle) ---------------------
// `startWatcher()` (packages/knowledge-indexer) has always been fully built
// and tested but never actually launched anywhere — this is that missing
// wire-up. One `penguin watch <path> --progress-events` child process per
// repo, spawned on toggle-on, kept in this registry, and stopped on
// toggle-off or app exit. Killed via SIGTERM (graceful — lets the CLI's watch
// verb close its DB cleanly) rather than a hard kill, wherever possible.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct WatchLease {
    repo_id: String,
    root_path: PathBuf,
    child_pid: u32,
    owner_pid: u32,
}

fn canonical_watch_root(root_path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(root_path)
        .map_err(|e| format!("cannot canonicalize watcher root {}: {e}", root_path.display()))
}

fn stable_watch_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn watch_lease_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".penguin").join("watch-locks"))
        .ok_or_else(|| "home directory unavailable for watcher lease".to_string())
}

fn watch_lease_path(lease_dir: &Path, root_path: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(lease_dir)
        .map_err(|e| format!("cannot create watcher lease directory: {e}"))?;
    let canonical = canonical_watch_root(root_path)?;
    let key = stable_watch_hash(&canonical.to_string_lossy());
    Ok(lease_dir.join(format!("{key:016x}.json")))
}

fn process_is_alive(pid: u32) -> bool {
    pid > 0
        && Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
}

fn lease_is_live(lease: &WatchLease) -> bool {
    if lease.child_pid > 0 {
        process_is_alive(lease.child_pid)
    } else {
        process_is_alive(lease.owner_pid)
    }
}

fn read_watch_lease(path: &Path) -> Option<WatchLease> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_watch_lease(path: &Path, lease: &WatchLease) -> Result<(), String> {
    use std::io::Write;

    let body = serde_json::to_vec(lease).map_err(|e| format!("cannot encode watcher lease: {e}"))?;
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| format!("cannot create watcher lease update: {e}"))?;
        file.write_all(&body)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("cannot write watcher lease update: {e}"))?;
        std::fs::rename(&temp, path).map_err(|e| format!("cannot publish watcher lease: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

fn try_acquire_watch_lease(
    lease_dir: &Path,
    repo_id: &str,
    root_path: &Path,
    owner_pid: u32,
) -> Result<PathBuf, String> {
    use std::io::Write;

    let canonical = canonical_watch_root(root_path)?;
    let path = watch_lease_path(lease_dir, &canonical)?;
    let lease = WatchLease {
        repo_id: repo_id.to_string(),
        root_path: canonical,
        child_pid: 0,
        owner_pid,
    };
    let body = serde_json::to_vec(&lease).map_err(|e| format!("cannot encode watcher lease: {e}"))?;

    for _ in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&body).and_then(|_| file.sync_all()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("cannot write watcher lease: {e}"));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if read_watch_lease(&path).as_ref().is_some_and(lease_is_live) {
                    return Err(format!("watcher already running for {}", root_path.display()));
                }
                std::fs::remove_file(&path)
                    .map_err(|remove| format!("cannot replace stale watcher lease: {remove}"))?;
            }
            Err(e) => return Err(format!("cannot acquire watcher lease: {e}")),
        }
    }
    Err(format!("could not acquire watcher lease for {}", root_path.display()))
}

fn remove_matching_watch_lease(path: &Path, child_pid: u32) {
    if read_watch_lease(path).is_some_and(|lease| lease.child_pid == child_pid) {
        let _ = std::fs::remove_file(path);
    }
}

fn live_watch_lease_for_repo(repo_id: &str) -> Option<(PathBuf, WatchLease)> {
    let dir = watch_lease_dir().ok()?;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(lease) = read_watch_lease(&path) else { continue };
        if !lease_is_live(&lease) {
            let _ = std::fs::remove_file(path);
            continue;
        }
        if lease.repo_id == repo_id {
            return Some((path, lease));
        }
    }
    None
}

fn parse_watch_command(command: &str) -> Option<PathBuf> {
    let marker = " watch ";
    let index = command.find(marker)?;
    let executable = &command[..index];
    if !executable.contains("knowledge-cli") && !executable.contains("/penguin") {
        return None;
    }
    let args = &command[index + marker.len()..];
    let root = args.strip_suffix(" --progress-events")?.trim();
    (!root.is_empty()).then(|| PathBuf::from(root))
}

// One-time migration for old app versions that had no lease. Only exact,
// orphaned `knowledge-cli ... watch <root> --progress-events` processes are
// touched; watchers still owned by a live parent are never killed here.
fn cleanup_legacy_orphan_watchers() {
    let leased_pids: std::collections::HashSet<u32> = watch_lease_dir()
        .ok()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| read_watch_lease(&entry.path()))
        .filter(|lease| lease_is_live(lease))
        .map(|lease| lease.child_pid)
        .filter(|pid| *pid > 0)
        .collect();
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() else {
        return;
    };
    let body = String::from_utf8_lossy(&output.stdout);
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next(), parts.next()) else {
            continue;
        };
        let command = parts.collect::<Vec<_>>().join(" ");
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else { continue };
        if ppid == 1 && !leased_pids.contains(&pid) && parse_watch_command(&command).is_some() {
            let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
        }
    }
}

struct WatchChild {
    child: std::process::Child,
    lease_path: PathBuf,
}

pub struct WatchRegistry {
    children: std::sync::Mutex<HashMap<String, WatchChild>>,
}

impl Default for WatchRegistry {
    fn default() -> Self {
        cleanup_legacy_orphan_watchers();
        Self { children: std::sync::Mutex::new(HashMap::new()) }
    }
}

impl WatchRegistry {
    fn is_running(&self, repo_id: &str) -> bool {
        let mut guard = self.children.lock().unwrap();
        let Some(entry) = guard.get_mut(repo_id) else {
            return live_watch_lease_for_repo(repo_id).is_some();
        };
        match entry.child.try_wait() {
            Ok(None) => true,
            _ => {
                if let Some(entry) = guard.remove(repo_id) {
                    remove_matching_watch_lease(&entry.lease_path, entry.child.id());
                }
                false
            }
        }
    }

    fn insert(&self, repo_id: String, child: std::process::Child, lease_path: PathBuf) {
        self.children.lock().unwrap().insert(repo_id, WatchChild { child, lease_path });
    }

    fn stop(&self, repo_id: &str) {
        let entry = self.children.lock().unwrap().remove(repo_id);
        if let Some(entry) = entry {
            let pid = entry.child.id();
            terminate_gracefully(entry.child);
            remove_matching_watch_lease(&entry.lease_path, pid);
        } else if let Some((path, lease)) = live_watch_lease_for_repo(repo_id) {
            if lease.child_pid > 0 {
                terminate_pid_gracefully(lease.child_pid);
            }
            let _ = std::fs::remove_file(path);
        }
    }

    // App-exit cleanup — an orphaned watcher would otherwise keep running
    // (and keep writing to the DB) after the app that started it is gone.
    pub(crate) fn stop_all(&self) {
        let children: Vec<_> = self
            .children
            .lock()
            .unwrap()
            .drain()
            .map(|(_, entry)| entry)
            .collect();
        for entry in children {
            let pid = entry.child.id();
            terminate_gracefully(entry.child);
            remove_matching_watch_lease(&entry.lease_path, pid);
        }
    }
}

// SIGTERM first (the watch verb's own handler closes chokidar + the DB
// cleanly), falling back to SIGKILL only if it doesn't exit promptly — a
// stuck child must not block app shutdown indefinitely.
fn terminate_gracefully(mut child: std::process::Child) {
    let pid = child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", &pid]).output();
    for _ in 0..40 {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn terminate_pid_gracefully(pid: u32) {
    let pid_text = pid.to_string();
    let _ = Command::new("kill").args(["-TERM", &pid_text]).status();
    for _ in 0..40 {
        if !process_is_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = Command::new("kill").args(["-KILL", &pid_text]).status();
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchStatus {
    repo_id: String,
    watching: bool,
}

#[tauri::command]
pub(crate) fn knowledge_watch_status(
    registry: tauri::State<'_, WatchRegistry>,
    repo_ids: Vec<String>,
) -> Vec<WatchStatus> {
    repo_ids
        .into_iter()
        .map(|id| {
            let watching = registry.is_running(&id);
            WatchStatus { repo_id: id, watching }
        })
        .collect()
}

#[tauri::command]
pub(crate) fn knowledge_watch_toggle<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    registry: tauri::State<'_, WatchRegistry>,
    repo_id: String,
    root_path: String,
    enable: bool,
) -> Result<bool, String> {
    if !enable {
        registry.stop(&repo_id);
        return Ok(false);
    }
    if registry.is_running(&repo_id) {
        return Ok(true);
    }
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let lease_dir = watch_lease_dir()?;
    let lease_path = match try_acquire_watch_lease(
        &lease_dir,
        &repo_id,
        Path::new(&root_path),
        std::process::id(),
    ) {
        Ok(path) => path,
        Err(message) if message.starts_with("watcher already running") => return Ok(true),
        Err(message) => return Err(message),
    };

    let inv = match resolve_invocation(&app) {
        Ok(inv) => inv,
        Err(error) => {
            let _ = std::fs::remove_file(&lease_path);
            return Err(error);
        }
    };
    let mut cmd = Command::new(&inv.node);
    cmd.arg(&inv.cli).arg("watch").arg(&root_path).arg("--progress-events");
    if let Some(wasm) = &inv.wasm_dir {
        cmd.env("PENGUIN_WASM_DIR", wasm);
    }
    let mut child = match cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&lease_path);
            return Err(format!("penguin watch failed to launch: {error}"));
        }
    };
    let child_pid = child.id();
    let lease = WatchLease {
        repo_id: repo_id.clone(),
        root_path: canonical_watch_root(Path::new(&root_path))?,
        child_pid,
        owner_pid: std::process::id(),
    };
    if let Err(error) = write_watch_lease(&lease_path, &lease) {
        terminate_gracefully(child);
        let _ = std::fs::remove_file(&lease_path);
        return Err(error);
    }

    // This thread lives for the child's whole lifetime (until stopped), not
    // just one call — same PENGUIN_PROGRESS-line convention as
    // run_cli_streaming, forwarded as a distinct event name since these are
    // recurring per-file-change runs, not one index's progress.
    if let Some(stderr) = child.stderr.take() {
        let app_evt = app.clone();
        let repo_id_evt = repo_id.clone();
        let lease_path_evt = lease_path.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("PENGUIN_PROGRESS ") {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(rest) {
                        let _ = app_evt.emit(
                            "knowledge-watch-event",
                            serde_json::json!({ "repoId": repo_id_evt, "payload": payload }),
                        );
                    }
                } else {
                    // A real crash/error the child prints to stderr (anything
                    // that isn't a PENGUIN_PROGRESS line) used to be silently
                    // dropped here — surface it so a dying watcher is
                    // diagnosable from the app's own log instead of invisible.
                    eprintln!("penguin watch ({repo_id_evt}) stderr: {line}");
                }
            }
            remove_matching_watch_lease(&lease_path_evt, child_pid);
        });
    }
    registry.insert(repo_id, child, lease_path);
    Ok(true)
}
