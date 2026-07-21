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
