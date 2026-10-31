//! Text a hook added to a turn's context, and how the model is told about it.
use super::HookEvent;
use serde::{Deserialize, Serialize};

/// One hook's addition to the context of the turn it belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookContext {
    /// The hook's display name.
    pub hook: String,
    /// Who configured it: user or plugin.
    pub scope: String,
    /// The event it ran for.
    pub event: HookEvent,
    /// Exact text for the model.
    pub text: String,
}

/// What matching handlers decided for one event.
#[derive(Clone, Debug, Default)]
pub struct HookDispatched {
    /// Joined deny reasons in config order.
    pub deny: Option<String>,
    /// Added context in config order.
    pub context: Vec<HookContext>,
}
