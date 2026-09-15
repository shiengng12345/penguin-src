// Secrets adapter — SQLite-backed by default.
//
// History:
//   * Phase 10A: in-memory MockKeychain (lost on restart).
//   * Phase 10B: switched to OS keychain via the `keyring` crate (Apple
//     Security framework / Windows Credential Manager).
//   * Now: rolled back to SQLite. macOS issued a login-password prompt
//     on every secret read by a freshly-built dev binary (signature
//     changes each `cargo build` invalidate the keychain ACL), making
//     `pnpm tauri dev` unworkable. User feedback: "普通代码都不需要，
//     postman 都不需要" — Postman / Insomnia / Bruno all store secrets
//     in a local file too. Match that model.
//
// Trade-off: secrets are now plaintext in ~/.penguin/penguin.sqlite3
// (same place as the dev-mode token). For a local API client where the
// user typed the value themselves and is the only user of the machine,
// this is fine. The Authorization tab also displays plaintext for
// inline editing (per user request), so the at-rest threat model is
// already "anyone with file access to your home folder can read them".

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::OnceLock;

/// Adapter trait — every secret operation goes through this so tests can
/// inject a deterministic backend.
pub trait KeychainAdapter: Send + Sync {
    fn save(&self, service: &str, account: &str, plaintext: &str) -> Result<(), String>;
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    /// Removes the entry entirely — a later `get` must report absence
    /// (`Ok(None)`), not `Ok(Some(""))`. Deleting an entry that was never
    /// saved (or was already deleted) is not an error.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

/// In-memory mock for unit tests. Production never sees this.
#[cfg(test)]
pub struct MockKeychain {
    items: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl MockKeychain {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(HashMap::new()),
        }
    }

    fn key(service: &str, account: &str) -> String {
        format!("{}::{}", service, account)
    }
}

#[cfg(test)]
impl Default for MockKeychain {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl KeychainAdapter for MockKeychain {
    fn save(&self, service: &str, account: &str, plaintext: &str) -> Result<(), String> {
        let mut items = self.items.lock().map_err(|e| e.to_string())?;
        items.insert(Self::key(service, account), plaintext.to_string());
        Ok(())
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let items = self.items.lock().map_err(|e| e.to_string())?;
        Ok(items.get(&Self::key(service, account)).cloned())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let mut items = self.items.lock().map_err(|e| e.to_string())?;
        items.remove(&Self::key(service, account));
        Ok(())
    }
}

/// SQLite-backed secrets. Values land in the existing `app_kv` table
/// under `rest:secret:<service>::<account>` so the existing hydrate /
/// backup paths cover them with no extra schema.
pub struct SqliteKeychain;

impl SqliteKeychain {
    pub fn new() -> Self {
        Self
    }

    fn kv_key(service: &str, account: &str) -> String {
        format!("rest:secret:{}::{}", service, account)
    }
}

impl Default for SqliteKeychain {
    fn default() -> Self {
        Self::new()
    }
}

impl KeychainAdapter for SqliteKeychain {
    fn save(&self, service: &str, account: &str, plaintext: &str) -> Result<(), String> {
        crate::db::app_value_set_internal(Self::kv_key(service, account), plaintext.to_string())
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        crate::db::app_value_get_internal(Self::kv_key(service, account))
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        // `DELETE ... WHERE key = ?` affects 0 rows and still returns `Ok`
        // when the key never existed — no separate "not found" branch needed.
        crate::db::app_value_delete_internal(Self::kv_key(service, account))
    }
}

// Process-wide active adapter. SqliteKeychain by default — no OS-level
// prompts, no per-binary-signature trust loss. Tests can override via
// `set_adapter_for_tests` to inject MockKeychain.
static ADAPTER: OnceLock<Box<dyn KeychainAdapter>> = OnceLock::new();

pub fn active_adapter() -> &'static dyn KeychainAdapter {
    ADAPTER
        .get_or_init(|| Box::new(SqliteKeychain::new()) as Box<dyn KeychainAdapter>)
        .as_ref()
}

#[cfg(test)]
#[allow(dead_code)]
pub fn set_adapter_for_tests(adapter: Box<dyn KeychainAdapter>) {
    let _ = ADAPTER.set(adapter);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_keychain_round_trips() {
        let kc = MockKeychain::new();
        kc.save("penguin-rest", "test-key", "s3cr3t").unwrap();
        assert_eq!(
            kc.get("penguin-rest", "test-key").unwrap(),
            Some("s3cr3t".to_string())
        );
        kc.delete("penguin-rest", "test-key").unwrap();
        assert_eq!(kc.get("penguin-rest", "test-key").unwrap(), None);
    }

    #[test]
    fn mock_keychain_isolates_by_service_account() {
        let kc = MockKeychain::new();
        kc.save("svc-a", "user", "value-a").unwrap();
        kc.save("svc-b", "user", "value-b").unwrap();
        assert_eq!(
            kc.get("svc-a", "user").unwrap(),
            Some("value-a".to_string())
        );
        assert_eq!(
            kc.get("svc-b", "user").unwrap(),
            Some("value-b".to_string())
        );
    }
}
