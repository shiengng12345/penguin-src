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
