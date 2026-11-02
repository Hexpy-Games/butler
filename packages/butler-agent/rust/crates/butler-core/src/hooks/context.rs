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

/// A hook failed. Rejected admissions carry the refusal in their response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookBlock {
    /// Whether this failure blocked the event.
    pub blocked: bool,
    /// The failing hook's display name.
    pub hook: String,
    /// The event that ran the hook.
    pub event: HookEvent,
    /// The tool, for tool events.
    pub tool: Option<String>,
    /// The turn's session.
    pub session_id: Option<String>,
    /// The refusal the model got, or empty when the event proceeded.
    pub reason: String,
}

/// Told each `HookBlock`; it must return quickly.
pub type HookBlockListener = std::sync::Arc<dyn Fn(HookBlock) + Send + Sync>;

/// What matching handlers decided for one event.
#[derive(Clone, Debug, Default)]
pub struct HookDispatched {
    /// Joined deny reasons in config order.
    pub deny: Option<String>,
    /// Added context in config order.
    pub context: Vec<HookContext>,
}
