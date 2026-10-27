//! Provider termination semantics, independent of the wire carrier.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelStop {
    Complete,
    Truncated,
    ContextLimit,
    Paused,
    Refused,
    Blocked,
    Unrecognized(String),
}

impl Default for ModelStop {
    fn default() -> Self {
        Self::Unrecognized("missing".into())
    }
}
