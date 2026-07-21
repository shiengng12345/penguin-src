# Runtime Manager — Prevent Sleep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Penguin automatically prevent macOS from sleeping while dev work is active, exposed as a developer-friendly "Prevent Sleep" runtime capability in a status-bar popover panel.

**Architecture:** A reference-counted, thread-safe Rust `RuntimeManager` owns logical state and 0↔1 lifecycle transitions; a platform `SleepController` trait owns the actual process (macOS spawns `caffeinate -di -w <pid>`). Tauri commands bridge to a React status-bar icon + popover + Settings section. Windows/Linux get an explicit `Unsupported` controller (abstraction only).

**Tech Stack:** Rust (Tauri 2, tokio, async-trait), React 19 + Zustand + Tailwind/CVA, SQLite `app_kv` for settings.

## Global Constraints

- The word `caffeinate` and any command line MUST NEVER appear in any UI string.
- Only ONE caffeinate instance may ever be managed; never spawn duplicates.
- Never crash on controller failure — surface a toast and continue.
- Automatic cleanup on app exit (`RunEvent::Exit`) and on Penguin crash (`caffeinate -w <pid>` self-terminates).
- Thread-safe, single `RuntimeManager` instance registered via `.manage(...)`.
- Rust async locks use `tokio::sync::Mutex` (never hold `std::sync::Mutex` across `.await`).
- Reference counting: per-source `u32`, `saturating_add`/`checked_sub`, underflow-safe; unregister-without-register is a no-op + warn.
- Follow existing module conventions: `src-tauri/src/runtime/` mirrors `redis/`; frontend mirrors existing `src/components/ui` + per-feature `src/lib/*-client.ts` + `src/hooks/*`.
- macOS is the only implemented platform in v1.

---

### Task 1: Runtime module skeleton — deps, error type, enums

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `async-trait`)
- Create: `src-tauri/src/runtime/mod.rs`
- Create: `src-tauri/src/runtime/error.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod runtime;` near the other top-level `mod` decls, ~lines 5-15)

**Interfaces:**
- Produces: `runtime::RuntimeSource` (`Flow|Backend|Ai|Docker|Manual`, `Copy+Hash+Eq`), `runtime::RuntimeTransition` (`Noop|Engaged|Released|Failed`), `runtime::RuntimeError`.

- [ ] **Step 1: Add async-trait dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]` (after the `futures = "0.3"` line), add:

```toml
# Runtime Manager — async trait objects for the SleepController abstraction.
async-trait = "0.1"
```

- [ ] **Step 2: Create the error type** — `src-tauri/src/runtime/error.rs`

```rust
use std::fmt;

/// Errors from runtime sleep control. Recoverable — callers must never panic.
#[derive(Debug, Clone)]
pub enum RuntimeError {
    /// Prevent-sleep is not implemented on this platform.
    Unsupported,
    /// Failed to start the OS sleep-inhibitor (e.g. spawn failed).
    EngageFailed(String),
    /// Failed to stop the OS sleep-inhibitor.
    ReleaseFailed(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::Unsupported => write!(f, "prevent sleep is not supported on this platform"),
            RuntimeError::EngageFailed(m) => write!(f, "unable to prevent sleep: {m}"),
            RuntimeError::ReleaseFailed(m) => write!(f, "unable to release sleep hold: {m}"),
        }
    }
}

impl std::error::Error for RuntimeError {}
```

- [ ] **Step 3: Create the module root with the shared enums** — `src-tauri/src/runtime/mod.rs`

```rust
pub mod error;

pub use error::RuntimeError;

/// Logical reasons the OS is being kept awake. Reference-counted per source.
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSource {
    Flow,
    Backend,
    Ai,
    Docker,
    Manual,
}

/// The outcome of a reference-count change, so callers know when the real
/// 0<->1 boundary was crossed (that is when the UI toast should fire).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RuntimeTransition {
    /// Count changed but prevent-sleep state did not.
    Noop,
    /// Prevent-sleep just turned ON (0 -> 1).
    Engaged,
    /// Prevent-sleep just turned OFF (1 -> 0).
    Released,
    /// A transition was attempted but the controller failed.
    Failed,
}
```

- [ ] **Step 4: Declare the module** in `src-tauri/src/lib.rs`

Find the block of top-level `mod` declarations (around lines 5-15, e.g. `mod redis;`) and add:

```rust
mod runtime;
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds successfully (warnings about unused code are fine).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/runtime/ src-tauri/src/lib.rs
git commit -m "feat(runtime): scaffold runtime module (deps, error, enums)"
```

---

### Task 2: SleepController trait + test double

**Files:**
- Create: `src-tauri/src/runtime/controller.rs`
- Modify: `src-tauri/src/runtime/mod.rs` (add `pub mod controller;`)

**Interfaces:**
- Consumes: `RuntimeError` (Task 1).
- Produces: `runtime::controller::SleepController` trait (`engage`/`release`/`is_active`/`shutdown`), `runtime::controller::FakeSleepController` test double exposing `engage_calls()`/`release_calls()`.

- [ ] **Step 1: Write the failing test** — append to `src-tauri/src/runtime/controller.rs`

```rust
use crate::runtime::error::RuntimeError;

#[async_trait::async_trait]
pub trait SleepController: Send + Sync {
    /// Start inhibiting sleep. MUST be idempotent (no-op if already active).
    async fn engage(&self) -> Result<(), RuntimeError>;
    /// Stop inhibiting sleep. MUST be idempotent (no-op if already released).
    async fn release(&self) -> Result<(), RuntimeError>;
    /// Whether the inhibitor is currently active.
    async fn is_active(&self) -> bool;
    /// Final teardown (defaults to release).
    async fn shutdown(&self) -> Result<(), RuntimeError> {
        self.release().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn fake_controller_counts_engage_and_release() {
        let c = FakeSleepController::new();
        assert!(!c.is_active().await);
        c.engage().await.unwrap();
        c.engage().await.unwrap(); // idempotent: still one real engage
        assert!(c.is_active().await);
        assert_eq!(c.engage_calls(), 1);
        c.release().await.unwrap();
        assert!(!c.is_active().await);
        assert_eq!(c.release_calls(), 1);
    }

    // Referenced so the AtomicU32 import is used even before impl is written.
    #[allow(dead_code)]
    fn _touch() { let _ = AtomicU32::new(0).load(Ordering::SeqCst); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test runtime::controller`
Expected: FAIL — `FakeSleepController` not found.

- [ ] **Step 3: Implement `FakeSleepController`** — add above the `#[cfg(test)]` block in `controller.rs`

```rust
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// In-memory controller for unit tests. Counts only the REAL engage/release
/// transitions (idempotent repeats do not increment).
pub struct FakeSleepController {
    active: AtomicBool,
    engage_calls: AtomicU32,
    release_calls: AtomicU32,
}

impl FakeSleepController {
    pub fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            engage_calls: AtomicU32::new(0),
            release_calls: AtomicU32::new(0),
        }
    }
    pub fn engage_calls(&self) -> u32 { self.engage_calls.load(Ordering::SeqCst) }
    pub fn release_calls(&self) -> u32 { self.release_calls.load(Ordering::SeqCst) }
}

#[async_trait::async_trait]
impl SleepController for FakeSleepController {
    async fn engage(&self) -> Result<(), RuntimeError> {
        if !self.active.swap(true, Ordering::SeqCst) {
            self.engage_calls.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn release(&self) -> Result<(), RuntimeError> {
        if self.active.swap(false, Ordering::SeqCst) {
            self.release_calls.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn is_active(&self) -> bool { self.active.load(Ordering::SeqCst) }
}
```

- [ ] **Step 4: Register the submodule** — in `src-tauri/src/runtime/mod.rs` add after `pub mod error;`:

```rust
pub mod controller;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src-tauri && cargo test runtime::controller`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/runtime/controller.rs src-tauri/src/runtime/mod.rs
git commit -m "feat(runtime): SleepController trait + fake test double"
```

---

### Task 3: RuntimeManager reference counting (core — TDD)

**Files:**
- Create: `src-tauri/src/runtime/manager.rs`
- Modify: `src-tauri/src/runtime/mod.rs` (add `pub mod manager;`)

**Interfaces:**
- Consumes: `SleepController` (Task 2), `RuntimeSource`, `RuntimeTransition`, `RuntimeError` (Task 1).
- Produces: `runtime::manager::RuntimeManager` with:
  - `new(controller: Arc<dyn SleepController>) -> Self`
  - `async register_source(&self, RuntimeSource) -> Result<RuntimeTransition, RuntimeError>`
  - `async unregister_source(&self, RuntimeSource) -> Result<RuntimeTransition, RuntimeError>`
  - `async set_manual(&self, enabled: bool) -> Result<RuntimeTransition, RuntimeError>`
  - `async is_prevent_sleep_enabled(&self) -> bool`
  - `async active_sources(&self) -> Vec<(RuntimeSource, u32)>`
  - `async shutdown(&self) -> Result<(), RuntimeError>`

- [ ] **Step 1: Write the failing tests** — `src-tauri/src/runtime/manager.rs`

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::runtime::controller::SleepController;
use crate::runtime::error::RuntimeError;
use crate::runtime::{RuntimeSource, RuntimeTransition};

#[derive(Default)]
struct RuntimeManagerState {
    per_source: HashMap<RuntimeSource, u32>,
    total: u32,
    active: bool,
}

pub struct RuntimeManager {
    controller: Arc<dyn SleepController>,
    state: Mutex<RuntimeManagerState>,
    transition: Mutex<()>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::controller::FakeSleepController;

    fn manager() -> (Arc<RuntimeManager>, Arc<FakeSleepController>) {
        let fake = Arc::new(FakeSleepController::new());
        let mgr = Arc::new(RuntimeManager::new(fake.clone()));
        (mgr, fake)
    }

    #[tokio::test]
    async fn zero_to_one_engages_once() {
        let (mgr, fake) = manager();
        assert_eq!(mgr.register_source(RuntimeSource::Flow).await.unwrap(), RuntimeTransition::Engaged);
        assert_eq!(mgr.register_source(RuntimeSource::Ai).await.unwrap(), RuntimeTransition::Noop);
        assert!(mgr.is_prevent_sleep_enabled().await);
        assert_eq!(fake.engage_calls(), 1);
    }

    #[tokio::test]
    async fn one_to_zero_releases_once() {
        let (mgr, fake) = manager();
        mgr.register_source(RuntimeSource::Flow).await.unwrap();
        mgr.register_source(RuntimeSource::Ai).await.unwrap();
        assert_eq!(mgr.unregister_source(RuntimeSource::Flow).await.unwrap(), RuntimeTransition::Noop);
        assert_eq!(mgr.unregister_source(RuntimeSource::Ai).await.unwrap(), RuntimeTransition::Released);
        assert!(!mgr.is_prevent_sleep_enabled().await);
        assert_eq!(fake.release_calls(), 1);
    }

    #[tokio::test]
    async fn unregister_without_register_is_noop_and_underflow_safe() {
        let (mgr, fake) = manager();
        assert_eq!(mgr.unregister_source(RuntimeSource::Docker).await.unwrap(), RuntimeTransition::Noop);
        assert!(!mgr.is_prevent_sleep_enabled().await);
        assert_eq!(fake.release_calls(), 0);
    }

    #[tokio::test]
    async fn manual_toggle_engages_and_releases() {
        let (mgr, fake) = manager();
        assert_eq!(mgr.set_manual(true).await.unwrap(), RuntimeTransition::Engaged);
        assert_eq!(mgr.set_manual(true).await.unwrap(), RuntimeTransition::Noop);
        assert_eq!(mgr.set_manual(false).await.unwrap(), RuntimeTransition::Released);
        assert_eq!(fake.engage_calls(), 1);
        assert_eq!(fake.release_calls(), 1);
    }

    #[tokio::test]
    async fn concurrent_registers_engage_exactly_once() {
        let (mgr, fake) = manager();
        let mut handles = Vec::new();
        for src in [RuntimeSource::Flow, RuntimeSource::Ai, RuntimeSource::Backend, RuntimeSource::Docker] {
            let m = mgr.clone();
            handles.push(tokio::spawn(async move { m.register_source(src).await.unwrap() }));
        }
        for h in handles { h.await.unwrap(); }
        assert!(mgr.is_prevent_sleep_enabled().await);
        assert_eq!(fake.engage_calls(), 1);
    }

    #[tokio::test]
    async fn shutdown_releases() {
        let (mgr, fake) = manager();
        mgr.register_source(RuntimeSource::Flow).await.unwrap();
        mgr.shutdown().await.unwrap();
        assert_eq!(fake.release_calls(), 1);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test runtime::manager`
Expected: FAIL — `RuntimeManager::new` / methods not found.

- [ ] **Step 3: Implement `RuntimeManager`** — add above the `#[cfg(test)]` block in `manager.rs`

```rust
impl RuntimeManager {
    pub fn new(controller: Arc<dyn SleepController>) -> Self {
        Self {
            controller,
            state: Mutex::new(RuntimeManagerState::default()),
            transition: Mutex::new(()),
        }
    }

    /// Apply a signed delta to one source's count and, if the total crosses the
    /// 0<->1 boundary, drive the controller. The `transition` mutex serializes
    /// the whole check-then-act so concurrent callers can never double-drive.
    async fn apply_delta(
        &self,
        source: RuntimeSource,
        delta: i32,
    ) -> Result<RuntimeTransition, RuntimeError> {
        // Serialize the entire transition decision + controller call.
        let _guard = self.transition.lock().await;

        // Short critical section: mutate counts, decide desired state.
        let (was_active, want_active) = {
            let mut st = self.state.lock().await;
            let entry = st.per_source.entry(source).or_insert(0);
            if delta > 0 {
                *entry = entry.saturating_add(delta as u32);
            } else if delta < 0 {
                let dec = (-delta) as u32;
                if *entry < dec {
                    // unregister without matching register — ignore + warn.
                    eprintln!("[runtime] warn: unregister {:?} below zero ignored", source);
                } else {
                    *entry -= dec;
                }
            }
            if *entry == 0 {
                st.per_source.remove(&source);
            }
            st.total = st.per_source.values().sum();
            let was = st.active;
            let want = st.total > 0;
            (was, want)
        };

        if was_active == want_active {
            return Ok(RuntimeTransition::Noop);
        }

        // Controller call happens OUTSIDE the state lock but INSIDE the
        // transition lock, so no other transition can interleave.
        let result = if want_active {
            self.controller.engage().await
        } else {
            self.controller.release().await
        };

        match result {
            Ok(()) => {
                self.state.lock().await.active = want_active;
                eprintln!(
                    "[runtime] prevent-sleep {} (source={:?})",
                    if want_active { "ENGAGED" } else { "RELEASED" },
                    source
                );
                Ok(if want_active { RuntimeTransition::Engaged } else { RuntimeTransition::Released })
            }
            Err(e) => {
                eprintln!("[runtime] error: controller transition failed: {e}");
                Ok(RuntimeTransition::Failed)
            }
        }
    }

    pub async fn register_source(&self, source: RuntimeSource) -> Result<RuntimeTransition, RuntimeError> {
        self.apply_delta(source, 1).await
    }

    pub async fn unregister_source(&self, source: RuntimeSource) -> Result<RuntimeTransition, RuntimeError> {
        self.apply_delta(source, -1).await
    }

    /// Manual toggle: sets the Manual source to exactly present/absent
    /// (boolean semantics — repeated `true` does not stack).
    pub async fn set_manual(&self, enabled: bool) -> Result<RuntimeTransition, RuntimeError> {
        let currently = {
            let st = self.state.lock().await;
            st.per_source.get(&RuntimeSource::Manual).copied().unwrap_or(0) > 0
        };
        if enabled && !currently {
            self.apply_delta(RuntimeSource::Manual, 1).await
        } else if !enabled && currently {
            self.apply_delta(RuntimeSource::Manual, -1).await
        } else {
            Ok(RuntimeTransition::Noop)
        }
    }

    pub async fn is_prevent_sleep_enabled(&self) -> bool {
        self.state.lock().await.active
    }

    pub async fn active_sources(&self) -> Vec<(RuntimeSource, u32)> {
        self.state.lock().await.per_source.iter().map(|(k, v)| (*k, *v)).collect()
    }

    pub async fn shutdown(&self) -> Result<(), RuntimeError> {
        let _guard = self.transition.lock().await;
        let mut st = self.state.lock().await;
        st.per_source.clear();
        st.total = 0;
        if st.active {
            st.active = false;
            drop(st);
            return self.controller.shutdown().await;
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Register the submodule** — in `src-tauri/src/runtime/mod.rs` add:

```rust
pub mod manager;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test runtime::manager`
Expected: all 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/runtime/manager.rs src-tauri/src/runtime/mod.rs
git commit -m "feat(runtime): reference-counted RuntimeManager with transition guard + tests"
```

---

### Task 4: Platform controllers (macOS caffeinate + Unsupported)

**Files:**
- Modify: `src-tauri/src/runtime/controller.rs` (add real controllers + `controller()` selector)

**Interfaces:**
- Consumes: `SleepController` trait (Task 2).
- Produces: `runtime::controller::controller() -> Arc<dyn SleepController>`, `runtime::controller::platform_supported() -> bool`.

- [ ] **Step 1: Implement the macOS controller** — add to `controller.rs`

```rust
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

/// macOS: keeps the machine awake by holding a `caffeinate` child process.
/// `-d` prevents display sleep, `-i` prevents idle system sleep. `-w <pid>`
/// binds caffeinate's lifetime to Penguin's PID so a Penguin crash auto-kills
/// it (no orphaned process). The command line is never surfaced to the UI.
#[cfg(target_os = "macos")]
pub struct MacosCaffeinateController {
    child: AsyncMutex<Option<Child>>,
}

#[cfg(target_os = "macos")]
impl MacosCaffeinateController {
    pub fn new() -> Self {
        Self { child: AsyncMutex::new(None) }
    }
}

#[cfg(target_os = "macos")]
#[async_trait::async_trait]
impl SleepController for MacosCaffeinateController {
    async fn engage(&self) -> Result<(), RuntimeError> {
        let mut slot = self.child.lock().await;
        if slot.is_some() {
            return Ok(()); // idempotent — one instance only
        }
        let pid = std::process::id();
        let child = Command::new("caffeinate")
            .args(["-d", "-i", "-w", &pid.to_string()])
            .spawn()
            .map_err(|e| RuntimeError::EngageFailed(e.to_string()))?;
        *slot = Some(child);
        Ok(())
    }

    async fn release(&self) -> Result<(), RuntimeError> {
        let mut slot = self.child.lock().await;
        if let Some(mut child) = slot.take() {
            // caffeinate has no cleanup work; kill + reap is sufficient.
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Ok(())
    }

    async fn is_active(&self) -> bool {
        self.child.lock().await.is_some()
    }
}
```

- [ ] **Step 2: Implement the Unsupported controller** — add to `controller.rs`

```rust
/// Non-macOS placeholder. Reports failure explicitly rather than pretending
/// success, so the UI can show "not supported on this platform". Refcount
/// bookkeeping in RuntimeManager still runs deterministically.
pub struct UnsupportedSleepController;

#[async_trait::async_trait]
impl SleepController for UnsupportedSleepController {
    async fn engage(&self) -> Result<(), RuntimeError> { Err(RuntimeError::Unsupported) }
    async fn release(&self) -> Result<(), RuntimeError> { Ok(()) }
    async fn is_active(&self) -> bool { false }
}
```

- [ ] **Step 3: Add the platform selector** — add to `controller.rs`

```rust
/// Whether prevent-sleep is implemented on the current platform.
pub fn platform_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Build the controller for the current platform.
pub fn controller() -> Arc<dyn SleepController> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(MacosCaffeinateController::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(UnsupportedSleepController)
    }
}
```

- [ ] **Step 4: Verify it compiles and existing tests still pass**

Run: `cd src-tauri && cargo test runtime`
Expected: builds; all runtime tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/runtime/controller.rs
git commit -m "feat(runtime): macOS caffeinate controller + unsupported fallback + selector"
```

---

### Task 5: Policy cache (auto-mode settings in memory)

**Files:**
- Create: `src-tauri/src/runtime/policy.rs`
- Modify: `src-tauri/src/runtime/mod.rs` (add `pub mod policy;`)
- Modify: `src-tauri/src/runtime/manager.rs` (store + expose policy)

**Interfaces:**
- Consumes: `RuntimeSource`.
- Produces: `runtime::policy::PreventSleepPolicy { mode: PreventSleepMode, auto_conditions: Vec<RuntimeSource> }`, `PreventSleepMode` enum; `RuntimeManager::set_policy(&self, PreventSleepPolicy)`, `RuntimeManager::policy(&self) -> PreventSleepPolicy`, `RuntimeManager::auto_wants(&self, RuntimeSource) -> bool`.

- [ ] **Step 1: Create the policy types** — `src-tauri/src/runtime/policy.rs`

```rust
use crate::runtime::RuntimeSource;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreventSleepMode {
    Never,
    AskEveryTime,
    OnStartup,
    Auto, // driven by `auto_conditions`
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PreventSleepPolicy {
    pub mode: PreventSleepMode,
    /// Sources that auto-acquire prevent-sleep while active (combinable).
    #[serde(default)]
    pub auto_conditions: Vec<RuntimeSource>,
}

impl Default for PreventSleepPolicy {
    fn default() -> Self {
        // Spec default: automatically when Penguin starts.
        Self { mode: PreventSleepMode::OnStartup, auto_conditions: Vec::new() }
    }
}
```

- [ ] **Step 2: Register the submodule** — in `src-tauri/src/runtime/mod.rs`:

```rust
pub mod policy;
```

- [ ] **Step 3: Write the failing test** — add to the `tests` module in `manager.rs`

```rust
    #[tokio::test]
    async fn auto_wants_reflects_policy_conditions() {
        use crate::runtime::policy::{PreventSleepMode, PreventSleepPolicy};
        let (mgr, _fake) = manager();
        mgr.set_policy(PreventSleepPolicy {
            mode: PreventSleepMode::Auto,
            auto_conditions: vec![RuntimeSource::Flow, RuntimeSource::Ai],
        }).await;
        assert!(mgr.auto_wants(RuntimeSource::Flow).await);
        assert!(mgr.auto_wants(RuntimeSource::Ai).await);
        assert!(!mgr.auto_wants(RuntimeSource::Backend).await);
    }
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd src-tauri && cargo test runtime::manager::tests::auto_wants`
Expected: FAIL — `set_policy` / `auto_wants` not found.

- [ ] **Step 5: Add policy storage to the manager** — in `manager.rs`

Add `use crate::runtime::policy::{PreventSleepMode, PreventSleepPolicy};` at the top, add a field to `RuntimeManagerState`:

```rust
    policy: PreventSleepPolicy,
```

(Add `use` for `Default` is automatic via `#[derive(Default)]` on the struct — but `PreventSleepPolicy` has a manual `Default`, and `RuntimeManagerState` derives `Default`, which will call it. Confirm `#[derive(Default)]` remains on `RuntimeManagerState`.)

Then add these methods inside `impl RuntimeManager`:

```rust
    pub async fn set_policy(&self, policy: PreventSleepPolicy) {
        self.state.lock().await.policy = policy;
    }

    pub async fn policy(&self) -> PreventSleepPolicy {
        self.state.lock().await.policy.clone()
    }

    /// Does the current policy want prevent-sleep held while `source` is active?
    pub async fn auto_wants(&self, source: RuntimeSource) -> bool {
        let st = self.state.lock().await;
        matches!(st.policy.mode, PreventSleepMode::Auto)
            && st.policy.auto_conditions.contains(&source)
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test runtime`
Expected: all runtime tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/runtime/policy.rs src-tauri/src/runtime/mod.rs src-tauri/src/runtime/manager.rs
git commit -m "feat(runtime): in-memory prevent-sleep policy cache"
```

---

### Task 6: Tauri commands + managed state wrapper

**Files:**
- Create: `src-tauri/src/runtime/commands.rs`
- Modify: `src-tauri/src/runtime/mod.rs` (add `pub mod commands;` + `pub use`)

**Interfaces:**
- Consumes: `RuntimeManager` (Task 3), `PreventSleepPolicy` (Task 5), `controller::platform_supported` (Task 4).
- Produces: `runtime::RuntimeState` (managed type = `Arc<RuntimeManager>`), commands `runtime_get_status`, `runtime_set_prevent_sleep`, `runtime_set_mode`, `runtime_register_source`, `runtime_unregister_source`; DTO `RuntimeStatus`.

- [ ] **Step 1: Implement the commands** — `src-tauri/src/runtime/commands.rs`

```rust
use std::sync::Arc;
use tauri::State;

use crate::runtime::controller::{controller, platform_supported};
use crate::runtime::manager::RuntimeManager;
use crate::runtime::policy::PreventSleepPolicy;
use crate::runtime::{RuntimeSource, RuntimeTransition};

/// Managed state alias registered via `.manage(...)`.
pub type RuntimeState = Arc<RuntimeManager>;

pub fn new_state() -> RuntimeState {
    Arc::new(RuntimeManager::new(controller()))
}

#[derive(serde::Serialize)]
pub struct SourceCount {
    pub source: RuntimeSource,
    pub count: u32,
}

#[derive(serde::Serialize)]
pub struct RuntimeStatus {
    pub prevent_sleep: bool,
    pub platform_supported: bool,
    pub sources: Vec<SourceCount>,
    pub policy: PreventSleepPolicy,
}

#[tauri::command]
pub async fn runtime_get_status(state: State<'_, RuntimeState>) -> Result<RuntimeStatus, String> {
    let sources = state
        .active_sources()
        .await
        .into_iter()
        .map(|(source, count)| SourceCount { source, count })
        .collect();
    Ok(RuntimeStatus {
        prevent_sleep: state.is_prevent_sleep_enabled().await,
        platform_supported: platform_supported(),
        sources,
        policy: state.policy().await,
    })
}

/// Manual toggle from the UI. Returns whether prevent-sleep is now enabled.
#[tauri::command]
pub async fn runtime_set_prevent_sleep(
    enabled: bool,
    state: State<'_, RuntimeState>,
) -> Result<bool, String> {
    let transition = state.set_manual(enabled).await.map_err(|e| e.to_string())?;
    if transition == RuntimeTransition::Failed {
        return Err("Unable to prevent computer sleep. Penguin will continue running normally.".into());
    }
    Ok(state.is_prevent_sleep_enabled().await)
}

#[tauri::command]
pub async fn runtime_set_mode(
    policy: PreventSleepPolicy,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    state.set_policy(policy).await;
    Ok(())
}

#[tauri::command]
pub async fn runtime_register_source(
    source: RuntimeSource,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    state.register_source(source).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn runtime_unregister_source(
    source: RuntimeSource,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    state.unregister_source(source).await.map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: Export from the module root** — in `src-tauri/src/runtime/mod.rs` add:

```rust
pub mod commands;

pub use commands::{new_state, RuntimeState};
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds (commands not yet registered — that's Task 7).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/runtime/commands.rs src-tauri/src/runtime/mod.rs
git commit -m "feat(runtime): tauri commands + managed state"
```

---

### Task 7: Wire into app lifecycle (manage, handler, startup, exit, event)

**Files:**
- Modify: `src-tauri/src/lib.rs` (`.manage`, `generate_handler!`, `.setup`, `RunEvent::Exit`)

**Interfaces:**
- Consumes: `runtime::new_state`, `runtime::RuntimeState`, all `runtime::commands::runtime_*`.
- Produces: a `runtime://transition` Tauri event emitted on 0↔1 boundaries (payload `{ enabled: bool }`).

- [ ] **Step 1: Register managed state** — in `lib.rs`, alongside the other `.manage(...)` calls (~lines 143-146):

```rust
        .manage(runtime::new_state())
```

- [ ] **Step 2: Register commands** — inside the `tauri::generate_handler![ ... ]` block (~lines 158-298), add:

```rust
            runtime::commands::runtime_get_status,
            runtime::commands::runtime_set_prevent_sleep,
            runtime::commands::runtime_set_mode,
            runtime::commands::runtime_register_source,
            runtime::commands::runtime_unregister_source,
```

- [ ] **Step 3: Handle startup "OnStartup" mode** — in the `.setup(|app| { ... })` closure (~lines 147-157), add:

```rust
            // Runtime Manager: if the persisted policy is "on startup", the
            // frontend calls runtime_set_prevent_sleep after hydrating settings.
            // No blocking DB read here — startup stays fast. (Frontend drives.)
            let _ = app; // keep closure signature; nothing to spawn yet.
```

(Note: the frontend, after hydrating settings, calls `runtime_set_mode` then — if mode is `OnStartup` — `runtime_set_prevent_sleep(true)`. This keeps DB reads off the Rust hot path per spec §4.3. If a future revision wants pure-Rust startup, read the persisted key here.)

- [ ] **Step 4: Clean up on exit** — in the `.run(|app_handle, event| { ... })` closure's `RunEvent::Exit` arm (~lines 301-309), alongside the existing `WatchRegistry` cleanup, add:

```rust
                let runtime_state = app_handle.state::<runtime::RuntimeState>();
                let rt = runtime_state.inner().clone();
                // Block briefly to ensure caffeinate is killed before exit.
                tauri::async_runtime::block_on(async move {
                    let _ = rt.shutdown().await;
                });
```

- [ ] **Step 5: Verify the whole backend builds + tests pass**

Run: `cd src-tauri && cargo build && cargo test runtime`
Expected: builds; runtime tests PASS.

- [ ] **Step 6: Manual smoke test (macOS)**

Run: `pnpm tauri dev` (in repo root). Once the app is up, in a second terminal run `pgrep -x caffeinate` — expect NO caffeinate yet. (Toggle wiring comes with the UI in later tasks; this step only confirms the app still launches.)
Then quit the app and re-run `pgrep -x caffeinate` — expect nothing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(runtime): wire manager into app lifecycle (manage/handler/exit)"
```

---

### Task 8: Auto-mode call sites (Flow + Backend)

**Files:**
- Modify: the Flow execution start/finish path (locate via `grep -rn "flow_execute\|FlowRuntime" src-tauri/src`)
- Modify: the Backend start/stop path (locate via `grep -rn "backend_start\|backend_stop\|active_backends" src-tauri/src`)

**Interfaces:**
- Consumes: `RuntimeState` (via `app_handle.state::<runtime::RuntimeState>()` or injected `State`), `RuntimeManager::auto_wants`, `register_source`, `unregister_source`.
- Produces: automatic register/unregister of `RuntimeSource::Flow` and `RuntimeSource::Backend`.

- [ ] **Step 1: Locate the Flow start/finish points**

Run: `grep -rn "flow_execute\|fn.*flow.*execut\|FlowRuntime" src-tauri/src`
Identify the function that begins a flow run and where it completes (success or error).

- [ ] **Step 2: Acquire prevent-sleep when a Flow starts (if policy wants it)**

At the start of the flow-execution command, after obtaining `state: State<'_, runtime::RuntimeState>` (add this param if the command doesn't already take app state; otherwise fetch via `app_handle.state`), add:

```rust
    if runtime_state.auto_wants(crate::runtime::RuntimeSource::Flow).await {
        let _ = runtime_state.register_source(crate::runtime::RuntimeSource::Flow).await;
    }
```

- [ ] **Step 3: Release when the Flow finishes**

At every exit path of the flow run (use a guard or a `defer`-style block so early returns are covered), add:

```rust
    let _ = runtime_state.unregister_source(crate::runtime::RuntimeSource::Flow).await;
```

Prefer wrapping the run body so the unregister runs on both success and error. If the existing code returns early, introduce a small scope guard struct that calls unregister on `Drop` via a captured `AppHandle` + `tauri::async_runtime::block_on`, OR restructure to a single exit point. Keep the register/unregister balanced.

- [ ] **Step 4: Repeat for Backend**

Run: `grep -rn "backend_start\|backend_stop\|active_backends" src-tauri/src`
In `backend_start`: after the backend process is confirmed started, add the `auto_wants(Backend)` + `register_source(Backend)` guard.
In `backend_stop` (and any crash/cleanup path that removes from `active_backends`): add `unregister_source(Backend)`.

- [ ] **Step 5: Verify build + existing tests**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds; tests PASS.

- [ ] **Step 6: Manual smoke test (macOS)**

Temporarily set policy to Auto+Flow (once the Settings UI exists, or via a quick `runtime_set_mode` invoke from devtools). Start a flow, run `pgrep -x caffeinate` → expect exactly ONE. Finish the flow → `pgrep -x caffeinate` → expect none.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src
git commit -m "feat(runtime): auto-acquire prevent-sleep for Flow and Backend"
```

---

### Task 9: Frontend UI primitives (Switch, Checkbox, RadioGroup)

**Files:**
- Create: `src/components/ui/switch.tsx`
- Create: `src/components/ui/checkbox.tsx`
- Create: `src/components/ui/radio-group.tsx`

**Interfaces:**
- Consumes: `cn` from `src/lib/utils.ts` (existing).
- Produces: `Switch`, `Checkbox`, `RadioGroup` + `RadioGroupItem` React components (controlled).

- [ ] **Step 1: Create `Switch`** — `src/components/ui/switch.tsx`

```tsx
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Switch({ checked, onCheckedChange, disabled, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-emerald-500" : "bg-neutral-600",
      )}
      {...rest}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
```

- [ ] **Step 2: Create `Checkbox`** — `src/components/ui/checkbox.tsx`

```tsx
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled, id }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex h-4 w-4 items-center justify-center rounded border transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "border-emerald-500 bg-emerald-500 text-white" : "border-neutral-500 bg-transparent",
      )}
    >
      {checked && <Check className="h-3 w-3" />}
    </button>
  );
}
```

- [ ] **Step 3: Create `RadioGroup`** — `src/components/ui/radio-group.tsx`

```tsx
import { cn } from "@/lib/utils";

interface RadioGroupProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  children: React.ReactNode;
  className?: string;
}

export function RadioGroup<T extends string>({ children, className }: RadioGroupProps<T>) {
  return <div role="radiogroup" className={cn("flex flex-col gap-2", className)}>{children}</div>;
}

interface RadioGroupItemProps {
  selected: boolean;
  onSelect: () => void;
  label: string;
  disabled?: boolean;
}

export function RadioGroupItem({ selected, onSelect, label, disabled }: RadioGroupItemProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 text-left text-sm",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border",
          selected ? "border-emerald-500" : "border-neutral-500",
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-emerald-500" />}
      </span>
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 4: Type-check**

Run (repo root): `pnpm typecheck`
Expected: no type errors from the new files. (If `@/` alias is not configured, use the relative import style already used in `src/components/ui/button.tsx` — check that file and match it.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/switch.tsx src/components/ui/checkbox.tsx src/components/ui/radio-group.tsx
git commit -m "feat(ui): add Switch, Checkbox, RadioGroup primitives"
```

---

### Task 10: Global toast

**Files:**
- Create: `src/components/ui/toast.tsx` (Toaster component + `useToastStore` zustand slice + `toast()` helper)
- Modify: `src/App.tsx` (mount `<Toaster />`)

**Interfaces:**
- Consumes: zustand (existing), `cn`.
- Produces: `toast(message: string)` function, `<Toaster />` component.

- [ ] **Step 1: Create the toast store + components** — `src/components/ui/toast.tsx`

```tsx
import { create } from "zustand";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

interface ToastItem { id: number; message: string; }
interface ToastState {
  toasts: ToastItem[];
  push: (message: string) => void;
  remove: (id: number) => void;
}

let nextId = 1;
const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2400);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Fire a toast from anywhere (components or event listeners). */
export function toast(message: string) {
  useToastStore.getState().push(message);
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  useEffect(() => () => {}, []);
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[9999] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            "pointer-events-auto rounded-md bg-neutral-800 px-3 py-2 text-sm text-neutral-100 shadow-lg",
            "border border-neutral-700",
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount `<Toaster />`** — in `src/App.tsx`, import and render it near the root return (alongside `UpdateNotification`, ~line 737):

```tsx
import { Toaster } from "@/components/ui/toast";
// ... in JSX, near the other top-level overlays:
<Toaster />
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/toast.tsx src/App.tsx
git commit -m "feat(ui): global toast system"
```

---

### Task 11: Runtime client + hook

**Files:**
- Create: `src/lib/runtime-client.ts`
- Create: `src/hooks/useRuntime.ts`

**Interfaces:**
- Consumes: `invoke` from `@tauri-apps/api/core`, `listen` from `@tauri-apps/api/event`, `toast` (Task 10).
- Produces: `RuntimeStatus`, `PreventSleepMode`, `RuntimeSource` types; `getRuntimeStatus()`, `setPreventSleep()`, `setRuntimeMode()`; `useRuntime()` hook returning `{ status, loading, togglePreventSleep, setMode, refresh }`.

- [ ] **Step 1: Create the client** — `src/lib/runtime-client.ts`

```ts
import { invoke } from "@tauri-apps/api/core";

export type RuntimeSource = "flow" | "backend" | "ai" | "docker" | "manual";
export type PreventSleepMode = "never" | "ask_every_time" | "on_startup" | "auto";

export interface PreventSleepPolicy {
  mode: PreventSleepMode;
  auto_conditions: RuntimeSource[];
}

export interface RuntimeStatus {
  prevent_sleep: boolean;
  platform_supported: boolean;
  sources: { source: RuntimeSource; count: number }[];
  policy: PreventSleepPolicy;
}

export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_get_status");
}

export function setPreventSleep(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("runtime_set_prevent_sleep", { enabled });
}

export function setRuntimeMode(policy: PreventSleepPolicy): Promise<void> {
  return invoke("runtime_set_mode", { policy });
}
```

- [ ] **Step 2: Create the hook** — `src/hooks/useRuntime.ts`

```ts
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "@/components/ui/toast";
import {
  getRuntimeStatus,
  setPreventSleep,
  setRuntimeMode,
  type PreventSleepPolicy,
  type RuntimeStatus,
} from "@/lib/runtime-client";

export function useRuntime() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getRuntimeStatus());
    } catch (e) {
      console.error("runtime status failed", e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const un = listen<{ enabled: boolean }>("runtime://transition", (evt) => {
      refresh();
      toast(evt.payload.enabled ? "☕ Prevent Sleep Enabled" : "☕ Prevent Sleep Disabled");
    });
    return () => { un.then((f) => f()); };
  }, [refresh]);

  const togglePreventSleep = useCallback(async (enabled: boolean) => {
    setLoading(true);
    try {
      await setPreventSleep(enabled);
      await refresh();
      toast(enabled ? "☕ Prevent Sleep Enabled" : "☕ Prevent Sleep Disabled");
    } catch (e) {
      toast(String(e)); // backend returns the friendly "Unable to prevent…" string
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const setMode = useCallback(async (policy: PreventSleepPolicy) => {
    await setRuntimeMode(policy);
    await refresh();
  }, [refresh]);

  return { status, loading, togglePreventSleep, setMode, refresh };
}
```

- [ ] **Step 3: Emit the event from Rust** — revisit `src-tauri/src/runtime/commands.rs` `runtime_set_prevent_sleep` and the auto-mode call sites so the frontend gets live updates. Simplest: after a successful manual toggle in `runtime_set_prevent_sleep`, emit the event. Modify the command to take `app: tauri::AppHandle`:

```rust
#[tauri::command]
pub async fn runtime_set_prevent_sleep(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<bool, String> {
    let transition = state.set_manual(enabled).await.map_err(|e| e.to_string())?;
    if transition == RuntimeTransition::Failed {
        return Err("Unable to prevent computer sleep. Penguin will continue running normally.".into());
    }
    let now = state.is_prevent_sleep_enabled().await;
    use tauri::Emitter;
    let _ = app.emit("runtime://transition", serde_json::json!({ "enabled": now }));
    Ok(now)
}
```

(For auto-mode Flow/Backend transitions to also notify the UI, have those call sites emit the same event when `register/unregister` returns `Engaged`/`Released`. The hook's `listen` already handles it. This is optional polish; the `refresh()` on mount + toggle covers the manual path.)

- [ ] **Step 4: Type-check + build**

Run: `pnpm typecheck && cd src-tauri && cargo build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/runtime-client.ts src/hooks/useRuntime.ts src-tauri/src/runtime/commands.rs
git commit -m "feat(runtime): frontend client, hook, and transition event"
```

---

### Task 12: Status-bar Runtime icon + popover panel

**Files:**
- Create: `src/components/runtime/RuntimePanel.tsx`
- Create: `src/components/runtime/RuntimeStatusButton.tsx`
- Modify: the status bar (locate via `grep -rn "v1.13.10\|Shortcuts\|Online" src/components` — the bottom bar rendering the version + icons)

**Interfaces:**
- Consumes: `useRuntime` (Task 11), `Switch` (Task 9).
- Produces: `RuntimeStatusButton` mounted in the status bar.

- [ ] **Step 1: Create the popover panel** — `src/components/runtime/RuntimePanel.tsx`

```tsx
import { Coffee } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useRuntime } from "@/hooks/useRuntime";

const STATUS_ROWS = [
  { key: "backend", icon: "🟢", label: "Backend", value: "Running" },
  { key: "docker", icon: "🐳", label: "Docker", value: "Running" },
  { key: "ai", icon: "🧠", label: "AI Worker", value: "Idle" },
  { key: "vpn", icon: "🔐", label: "VPN", value: "Connected" },
];

export function RuntimePanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { status, loading, togglePreventSleep } = useRuntime();
  const enabled = status?.prevent_sleep ?? false;
  const supported = status?.platform_supported ?? true;

  return (
    <div className="w-72 rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-xl">
      <div className="mb-2 text-sm font-semibold text-neutral-200">Runtime</div>

      <div className="flex items-center justify-between py-1.5">
        <span className="flex items-center gap-2 text-sm text-neutral-200">
          <Coffee className="h-4 w-4" /> Prevent Sleep
        </span>
        <Switch
          checked={enabled}
          disabled={loading || !supported}
          onCheckedChange={togglePreventSleep}
          aria-label="Prevent Sleep"
        />
      </div>
      <p className="mb-2 text-xs text-neutral-400">
        Prevent this computer from sleeping while Penguin is running.
      </p>
      {!supported && (
        <p className="mb-2 text-xs text-amber-400">Not supported on this platform.</p>
      )}

      {STATUS_ROWS.map((r) => (
        <div key={r.key} className="flex items-center justify-between py-1 text-sm text-neutral-300">
          <span>{r.icon} {r.label}</span>
          <span className="text-neutral-500">{r.value}</span>
        </div>
      ))}

      <button
        type="button"
        onClick={onOpenSettings}
        className="mt-2 w-full text-left text-xs text-emerald-400 hover:underline"
      >
        ⚙ Runtime Settings →
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create the status-bar button** — `src/components/runtime/RuntimeStatusButton.tsx`

```tsx
import { useEffect, useRef, useState } from "react";
import { Coffee } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRuntime } from "@/hooks/useRuntime";
import { RuntimePanel } from "./RuntimePanel";

export function RuntimeStatusButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { status } = useRuntime();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const enabled = status?.prevent_sleep ?? false;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={enabled ? "Prevent Sleep · Enabled" : "Prevent Sleep · Disabled"}
        onClick={() => setOpen((v) => !v)}
        className={cn("flex items-center px-1", enabled ? "text-emerald-400" : "text-neutral-500")}
      >
        <Coffee className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute bottom-6 right-0 z-50">
          <RuntimePanel onOpenSettings={() => { setOpen(false); onOpenSettings(); }} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Mount in the status bar**

Run: `grep -rn "v1.13.10\|Shortcuts" src/components src/App.tsx`
Find the bottom status-bar JSX (the row with the version string + existing gear/sync icons). Add, next to the existing icons:

```tsx
<RuntimeStatusButton onOpenSettings={() => {/* open Settings dialog to Runtime section — wire in Task 13 */}} />
```

Import it at the top of that file:

```tsx
import { RuntimeStatusButton } from "@/components/runtime/RuntimeStatusButton";
```

- [ ] **Step 4: Type-check + manual verify**

Run: `pnpm typecheck` then `pnpm tauri dev`.
Expected: a ☕ icon appears in the bottom-right status bar; clicking opens the popover; toggling ON runs `pgrep -x caffeinate` → exactly one; toggling OFF → none; toasts appear.

- [ ] **Step 5: Commit**

```bash
git add src/components/runtime/
git commit -m "feat(runtime): status-bar icon + prevent-sleep popover panel"
```

---

### Task 13: Settings → Runtime section

**Files:**
- Modify: `src/components/settings/SettingsDialog.tsx` (add a Runtime section)
- Modify: the status-bar mount from Task 12 to open Settings at the Runtime section

**Interfaces:**
- Consumes: `RadioGroup`/`RadioGroupItem`, `Checkbox` (Task 9), `useRuntime` (Task 11), `app-persistence` (`getPersistedValue`/`setPersistedValue`).
- Produces: a Runtime settings section that reads/writes the policy and calls `setRuntimeMode`.

- [ ] **Step 1: Add a persistence key** — in `src/lib/persistence-keys.ts`, add:

```ts
export const RUNTIME_PREVENT_SLEEP_KEY = "runtime.preventSleep";
```

- [ ] **Step 2: Build the Runtime settings section** — inside `SettingsDialog.tsx`, add a new section component (follow the existing section-switcher pattern in that file). Section body:

```tsx
// mode: "never" | "ask_every_time" | "on_startup" | "auto"
// When mode === "auto", the checkboxes below choose auto_conditions.
const MODES: { value: PreventSleepMode; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "ask_every_time", label: "Ask Every Time" },
  { value: "on_startup", label: "Automatically when Penguin starts" },
  { value: "auto", label: "Automatically based on conditions below" },
];
const CONDITIONS: { source: RuntimeSource; label: string }[] = [
  { source: "flow", label: "During Flow execution" },
  { source: "backend", label: "During Backend running" },
  { source: "ai", label: "During AI Tasks" },
];
```

Render `RadioGroup` over `MODES` and, when `mode === "auto"`, render a `Checkbox` per `CONDITIONS` item. On any change: update local state, persist via `setPersistedValue(RUNTIME_PREVENT_SLEEP_KEY, JSON.stringify(policy))`, and call `setMode(policy)` (from `useRuntime`).

- [ ] **Step 3: Hydrate policy on app start** — where settings are hydrated (search `grep -rn "hydratePersistedValues\|getPersistedValue" src`), after hydration read `RUNTIME_PREVENT_SLEEP_KEY`, parse it, call `setRuntimeMode(policy)`, and if `policy.mode === "on_startup"` call `setPreventSleep(true)`.

- [ ] **Step 4: Wire the status-bar "Runtime Settings →" link** — update the Task 12 mount so `onOpenSettings` opens the Settings dialog at the Runtime section (set whatever state SettingsDialog uses to select a section).

- [ ] **Step 5: Type-check + manual verify**

Run: `pnpm typecheck` then `pnpm tauri dev`.
Expected: Settings shows a Runtime section; selecting "Auto" reveals the condition checkboxes; choosing Flow + AI and starting a flow engages prevent-sleep (`pgrep -x caffeinate` → one), finishing releases it. "When Penguin starts" engages on next launch.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/SettingsDialog.tsx src/lib/persistence-keys.ts src/components/runtime/ src/App.tsx
git commit -m "feat(runtime): Settings → Runtime section (mode + auto conditions)"
```

---

## Self-Review

**Spec coverage:**
- Runtime panel + status rows → Task 12. Prevent Sleep toggle + subtitle → Task 12. ✅
- Settings mode radio + combinable auto conditions → Task 13. ✅
- macOS `caffeinate -di` (with `-w` for crash safety) → Task 4. ✅
- Store PID / single instance / no duplicates → Task 4 (controller owns `Option<Child>`, idempotent) + Task 3 (transition guard). ✅
- Reference counter with example semantics → Task 3 tests. ✅
- RuntimeManager methods (enable/disable/isEnabled/register/unregister) → Tasks 3 & 6. ✅
- Sources Flow/Backend/AI/Docker/Manual → Task 1 enum. ✅
- Platform trait, Windows/Linux abstraction only → Tasks 2 & 4. ✅
- Auto mode flow (Flow/Backend) → Task 8; AI/Docker reserved (spec allows future). ✅
- Error handling: friendly message, never crash → Tasks 6 & 11. ✅
- Toasts on enable/disable, no command-line/`caffeinate` in UI → Tasks 10, 11, 12. ✅
- Automatic cleanup on exit + crash recovery → Task 7 (`RunEvent::Exit`) + `-w <pid>` (Task 4). ✅
- Thread-safe single instance, `.manage` → Task 7. ✅
- Unit tests for reference counting → Task 3. ✅
- Logging for state changes → Task 3 (`eprintln!`, matching the codebase's existing logging convention). ✅

**Placeholder scan:** No "TBD/TODO/handle appropriately" left as work items. Task 8 and Task 13 steps that say "locate via grep" are discovery steps with concrete grep commands and exact edits described — acceptable because the target line numbers are volatile and must be found at execution time.

**Type consistency:** `RuntimeSource` serializes lowercase (Rust `#[serde(rename_all="lowercase")]`) matching TS `"flow"|"backend"|...`. `PreventSleepMode` serializes snake_case matching TS `"ask_every_time"|"on_startup"`. `RuntimeTransition` used consistently. `RuntimeState = Arc<RuntimeManager>` used in all commands and lifecycle wiring. Event name `runtime://transition` consistent between Task 11 (listen) and Task 11/Task 7 (emit).

**Note on logging:** the plan uses `eprintln!` to match the codebase convention (96 existing usages; no `log`/`tracing` crate is in use), so no new logging dependency is introduced — `async-trait` is the only crate added (Task 1).
