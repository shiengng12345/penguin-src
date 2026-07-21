use std::fs;
use std::path::PathBuf;
use tauri::Manager;

mod auth_popover;
mod db;
mod inline_webview;
mod knowledge;
mod mcp;
mod packages;
mod proxy;
mod redis;
mod registry;
mod registry_search;
mod rest;
mod runtime;

pub use packages::{InstalledPackage, ProtoFile};
pub use proxy::{HttpProxyRequest, HttpProxyResponse};

#[tauri::command]
fn read_config<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> String {
    let mut paths_to_try: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        paths_to_try.push(home.join(".penguin").join("config.json"));
        paths_to_try.push(home.join(".penguin.config.json"));
        // Legacy: users who still have the pre-rename file in their home.
        paths_to_try.push(home.join(".pengvi.config.json"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri rewrites `../foo` resource paths to `_up_/foo` inside the
        // bundled .app's Resources dir, so users installing the shipped DMG
        // need this path probed first. Without it the env dropdown comes up
        // empty for everyone except the developer who has the file in $HOME.
        paths_to_try.push(resource_dir.join("_up_").join(".penguin.config.json"));
        paths_to_try.push(resource_dir.join("_up_").join(".pengvi.config.json"));
        paths_to_try.push(resource_dir.join(".penguin.config.json"));
        paths_to_try.push(resource_dir.join(".pengvi.config.json"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        paths_to_try.push(cwd.join(".penguin.config.json"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            paths_to_try.push(parent.join(".penguin.config.json"));
            if let Some(grandparent) = parent.parent() {
                paths_to_try.push(grandparent.join(".penguin.config.json"));
                paths_to_try.push(
                    grandparent
                        .join("Resources")
                        .join("_up_")
                        .join(".penguin.config.json"),
                );
                paths_to_try.push(grandparent.join("Resources").join(".penguin.config.json"));
            }
        }
    }

    for path in &paths_to_try {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                return content;
            }
        }
    }

    String::new()
}

#[tauri::command]
fn copy_png_to_clipboard(base64_data: String) -> Result<(), String> {
    use base64::Engine;
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| e.to_string())?;

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp_path = format!("/tmp/penguin-doc-{}.png", millis);

    std::fs::write(&tmp_path, &png_bytes).map_err(|e| e.to_string())?;

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "set the clipboard to (read (POSIX file \"{}\") as \u{00AB}class PNGf\u{00BB})",
            tmp_path
        ))
        .output()
        .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&tmp_path);

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// Tauri-spawned processes inherit launchd's bare PATH, missing tools like
// lark-cli / pnpm global / nvm-installed npm. Login shells (`zsh -l`) source
// .zprofile but not .zshrc, where most users put PATH/nvm/fnm init — so we
// run an interactive+login shell once at startup and pin the result.
fn capture_user_path() -> Option<String> {
    let output = std::process::Command::new("zsh")
        .args(["-ilc", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8(output.stdout).ok()?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn run() {
    packages::migrate_legacy_pengvi_dir();
    match capture_user_path() {
        Some(user_path) => std::env::set_var("PATH", user_path),
        None => eprintln!(
            "[pengvi] warning: could not capture user PATH from zsh -ilc; \
             subprocess will use bundled NODE_PATH_SETUP fallback only"
        ),
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(auth_popover::AuthPopoverState::default())
        .manage(redis::RedisState::default())
        .manage(redis::RedisRegistry::default())
        .manage(knowledge::WatchRegistry::default())
        .manage(runtime::new_state())
        .setup(|app| {
            packages::start_package_watcher(app.handle().clone());
            // Warm the knowledge CLI (node resolution + cold-start + DB) in the
            // background so first entry into the Wiki isn't slow (perf).
            knowledge::prewarm(app.handle().clone());
            // Auto-install the `penguin` CLI onto ~/.local/bin so a fresh user can
            // use it in a terminal without any manual step (no chicken-and-egg
            // `penguin install`). Idempotent, off-main-thread, self-healing.
            knowledge::install_cli_command(app.handle().clone());
            // Runtime Manager: if the persisted policy is "on startup", the
            // frontend calls runtime_set_prevent_sleep after hydrating settings.
            // No blocking DB read here — startup stays fast. (Frontend drives.)
            let _ = app; // keep closure signature; nothing to spawn yet.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            knowledge::knowledge_query,
            knowledge::knowledge_reindex,
            knowledge::knowledge_db_status,
            knowledge::knowledge_cli_status,
            knowledge::knowledge_cli_setup,
            knowledge::knowledge_agent_guidance_setup,
            knowledge::knowledge_agent_hook_setup,
            knowledge::knowledge_watch_toggle,
            knowledge::knowledge_watch_status,
            packages::ensure_packages_dir,
            packages::get_packages_dir,
            packages::list_installed_packages,
            read_config,
            proxy::http_proxy,
            proxy::http_proxy_abort,
            packages::read_package_bundle,
            packages::clear_all_packages,
            copy_png_to_clipboard,
            db::db_set_app_value,
            db::db_get_app_value,
            db::db_list_app_values,
            db::db_delete_app_value,
            db::db_upsert_saved_request,
            db::db_list_saved_requests,
            db::db_delete_saved_request,
            db::db_rename_saved_request,
            db::db_put_history_entry,
            db::db_list_history,
            db::db_count_history,
            db::db_clear_history,
            db::db_record_error_log,
            db::db_list_error_log,
            db::db_count_error_log_since,
            db::db_clear_error_log,
            mcp::mcp_status,
            mcp::mcp_install_to_local_clients,
            registry::write_registry_npmrc,
            registry::read_registry_npmrc_status,
            registry_search::registry_search_packages,
            registry_search::registry_package_versions,
            rest::commands::rest_send_request,
            rest::commands::rest_save_secret,
            rest::commands::rest_resolve_secret_masked,
            rest::commands::rest_resolve_secret_plain,
            rest::commands::rest_get_cookies,
            rest::commands::rest_clear_cookies,
            rest::commands::rest_save_cookie,
            rest::commands::rest_delete_cookie,
            inline_webview::inline_webview_open,
            inline_webview::inline_webview_set_bounds,
            inline_webview::inline_webview_set_visible,
            inline_webview::inline_webview_set_zoom,
            inline_webview::inline_webview_reload,
            inline_webview::inline_webview_navigate,
            inline_webview::inline_webview_back,
            inline_webview::inline_webview_forward,
            inline_webview::inline_webview_close,
            inline_webview::inline_webview_eval,
            inline_webview::inline_webview_list,
            inline_webview::inline_webview_close_all,
            inline_webview::inline_webview_hide_all,
            inline_webview::inline_webview_purge_all_data,
            inline_webview::inline_webview_delete_data_dir,
            redis::commands::redis_connect,
            redis::commands::redis_connect_saved,
            redis::commands::redis_disconnect,
            redis::commands::redis_ping,
            redis::commands::redis_save_connection,
            redis::commands::redis_list_connections,
            redis::commands::redis_delete_connection,
            redis::commands::redis_scan,
            redis::commands::redis_scan_enriched,
            redis::commands::redis_dbsize,
            redis::commands::redis_key_type,
            redis::commands::redis_key_ttl,
            redis::commands::redis_del_keys,
            redis::commands::redis_rename_key,
            redis::commands::redis_expire_key,
            redis::commands::redis_string_get,
            redis::commands::redis_string_set,
            redis::commands::redis_hash_getall,
            redis::commands::redis_hash_scan,
            redis::commands::redis_hash_set,
            redis::commands::redis_hash_del,
            redis::commands::redis_list_range,
            redis::commands::redis_set_members,
            redis::commands::redis_zset_range,
            redis::commands::redis_stats_start,
            redis::commands::redis_stats_stop,
            redis::commands::redis_info,
            redis::registry::redis_reg_connect,
            redis::registry::redis_reg_list,
            redis::registry::redis_reg_disconnect,
            redis::registry::redis_reg_dbsize,
            redis::registry::redis_reg_info,
            redis::registry::redis_reg_monitor_start,
            redis::registry::redis_reg_monitor_stop,
            redis::registry::reg_pubsub_start,
            redis::registry::reg_pubsub_stop,
            redis::registry::redis_conn_list_full,
            redis::registry::redis_group_list,
            redis::registry::redis_group_create,
            redis::registry::redis_group_delete,
            redis::registry::redis_conn_save,
            redis::registry::redis_conn_delete,
            redis::registry::redis_conn_open,
            redis::registry::redis_conn_test,
            redis::registry::redis_conn_export,
            redis::registry::redis_conn_import,
            redis::keys::reg_scan,
            redis::keys::reg_key_type,
            redis::keys::reg_ttl,
            redis::keys::reg_expire,
            redis::keys::reg_del,
            redis::keys::reg_rename,
            redis::keys::reg_string_get,
            redis::keys::reg_string_set,
            redis::keys::reg_hash_getall,
            redis::keys::reg_hash_set,
            redis::keys::reg_hash_del,
            redis::keys::reg_list_range,
            redis::keys::reg_list_push,
            redis::keys::reg_list_set,
            redis::keys::reg_set_members,
            redis::keys::reg_set_add,
            redis::keys::reg_set_rem,
            redis::keys::reg_zset_range,
            redis::keys::reg_zset_add,
            redis::keys::reg_zset_rem,
            redis::keys::reg_stream_range,
            redis::keys::reg_cli_exec,
            redis::keys::reg_slowlog,
            redis::keys::reg_publish,
            auth_popover::auth_popover_open,
            auth_popover::auth_popover_get_snapshot,
            auth_popover::auth_popover_close,
            auth_popover::auth_load_standalone,
            auth_popover::auth_save_standalone,
            auth_popover::auth_capture_qr,
            runtime::commands::runtime_get_status,
            runtime::commands::runtime_set_prevent_sleep,
            runtime::commands::runtime_set_mode,
            runtime::commands::runtime_register_source,
            runtime::commands::runtime_unregister_source,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // An orphaned `penguin watch` child would otherwise keep running
            // (and writing to the DB) after the app that started it quits.
            if let tauri::RunEvent::Exit = event {
                app_handle
                    .state::<knowledge::WatchRegistry>()
                    .stop_all();

                let runtime_state = app_handle.state::<runtime::RuntimeState>();
                let rt = runtime_state.inner().clone();
                // Block briefly to ensure caffeinate is killed before exit.
                tauri::async_runtime::block_on(async move {
                    let _ = rt.shutdown().await;
                });
            }
        });
}
