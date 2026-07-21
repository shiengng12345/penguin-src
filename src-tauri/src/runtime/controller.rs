use crate::runtime::error::RuntimeError;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

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
