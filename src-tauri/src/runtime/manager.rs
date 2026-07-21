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
