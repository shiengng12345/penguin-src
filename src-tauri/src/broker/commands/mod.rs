//! Tauri commands. Every one takes `connectionId` explicitly — the "active"
//! connection is a UI concept and never an implicit backend default.
//!
//! Secrets follow DEC #195: the plaintext arrives once on upsert, goes
//! straight to the keychain adapter, and is never returned. (The adapter's
//! production implementation, `SqliteKeychain`, holds that plaintext in the
//! app's own SQLite `app_kv` table — see `crate::rest::keychain` — not an
//! OS-level keychain.) DEC #195's actual guarantee is narrower and holds
//! regardless: the frontend only ever sees `secretHandleId` —
//! `ConnectionDto` has no plaintext field at all, so there is no field to
//! accidentally serialize across IPC.
//!
//! Divergence from the Task 14 brief: commands here don't take a
//! `tauri::AppHandle` parameter — nothing in this module needs one (the
//! connections DB opens by home-dir path, same as every other `db::`
//! command; see `crate::db::open_product_db_shared`), so it would be an
//! unused parameter. `broker_list_connections` / `broker_upsert_connection` /
//! `broker_delete_connection` also return `Result<_, String>` rather than a
//! bare value — every one of them touches SQLite or the keychain and can
//! fail, and `Result<T, String>` is this codebase's existing convention for
//! fallible commands (see `db.rs`).
//!
//! Split into submodules (Phase A Task 4) to keep every file at or under 400
//! lines: `connection` (connection CRUD + health probe), `topic` (topic
//! listing through the snapshot cache), `topology` (tenant/namespace listing
//! through the snapshot cache). This file re-exports only — every
//! `#[tauri::command]` at the `broker::commands::broker_*` path `lib.rs`'s
//! `generate_handler!` depends on, plus `list_topics_through_cache` /
//! `list_tenants_through_cache` / `list_namespaces_through_cache`, which the
//! `tests/broker_cache.rs` / `tests/broker_topology.rs` integration tests
//! call directly as `commands::list_*_through_cache` — and the handful of
//! helpers genuinely shared across submodules (`now_ms`, `load_row`,
//! `resolve_secret`, `KEYCHAIN_SERVICE`).

mod cache_read;
mod connection;
mod topic;
mod topic_detail;
mod topology;

// Glob re-exports, deliberately: `#[tauri::command]` generates a hidden
// macro-companion item (`__cmd__broker_*`) alongside each command function,
// in the SAME module as the function. `generate_handler!` resolves commands
// by looking up that companion at the literal path given in `lib.rs`
// (`broker::commands::broker_*`), so naming only the function in a `pub use`
// re-exports the function but leaves its companion unreachable at this
// path — `cargo build` fails with "could not find `__cmd__broker_*` in
// `commands`". A glob brings every public item (functions and their hidden
// companions alike) across, which is what a plain top-level `commands.rs`
// gave lib.rs for free before this split.
pub use connection::*;
pub use topic::*;
pub use topic_detail::*;
pub use topology::*;

use crate::broker::store::{self, ConnectionRow};

/// Separate keychain namespace from the REST module's `"penguin-rest"` —
/// same adapter, distinct account space, so a broker connection id can never
/// collide with a REST secret handle.
const KEYCHAIN_SERVICE: &str = "penguin-broker";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_row(connection_id: &str) -> Result<ConnectionRow, String> {
    let conn = crate::db::open_product_db_shared()?;
    store::get_connection(&conn, connection_id)
        .map_err(|e| e.message)?
        .ok_or_else(|| format!("no broker connection found for id {connection_id:?}"))
}

/// Resolves a keychain handle to plaintext, for use inside this process
/// only. The caller must never place the returned value in anything that
/// crosses IPC, a log line, or an error message.
fn resolve_secret(secret_handle_id: Option<&str>) -> Result<Option<String>, String> {
    let Some(handle) = secret_handle_id else { return Ok(None) };
    crate::rest::keychain::active_adapter()
        .get(KEYCHAIN_SERVICE, handle)
        .map_err(|e| format!("keychain read failed: {e}"))?
        .map(Some)
        .ok_or_else(|| format!("keychain entry missing for handle {handle:?}"))
}
