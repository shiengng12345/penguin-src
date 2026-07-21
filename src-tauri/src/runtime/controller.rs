use crate::runtime::error::RuntimeError;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

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

/// In-memory controller for unit tests. Counts only the REAL engage/release
/// transitions (idempotent repeats do not increment).
pub struct FakeSleepController {
    active: AtomicBool,
    engage_calls: AtomicU32,
    release_calls: AtomicU32,
    /// Counts every INVOCATION of `engage()`, before the idempotent swap.
    /// Unlike `engage_calls` (which absorbs duplicate invocations that find
    /// the controller already active), this proves how many times the
    /// manager actually called into the controller — the right signal for
    /// asserting manager-side serialization.
    engage_invocations: AtomicU32,
}

impl FakeSleepController {
    pub fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            engage_calls: AtomicU32::new(0),
            release_calls: AtomicU32::new(0),
            engage_invocations: AtomicU32::new(0),
        }
    }
    pub fn engage_calls(&self) -> u32 { self.engage_calls.load(Ordering::SeqCst) }
    pub fn release_calls(&self) -> u32 { self.release_calls.load(Ordering::SeqCst) }
    pub fn engage_invocations(&self) -> u32 { self.engage_invocations.load(Ordering::SeqCst) }
}

#[async_trait::async_trait]
impl SleepController for FakeSleepController {
    async fn engage(&self) -> Result<(), RuntimeError> {
        self.engage_invocations.fetch_add(1, Ordering::SeqCst);
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
