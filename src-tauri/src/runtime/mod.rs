pub mod error;
pub mod controller;

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
