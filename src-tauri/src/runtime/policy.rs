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
