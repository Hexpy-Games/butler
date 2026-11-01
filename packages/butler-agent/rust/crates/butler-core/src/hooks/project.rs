//! Hooks from a project folder run only in a folder the user said they trust.
use super::{HookEvent, HookPort};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The authority capability of the folder trust card.
pub const PROJECT_HOOKS_CAPABILITY: &str = "project_hooks";
/// Where a project folder keeps its hooks, relative to its root.
pub const PROJECT_HOOK_FILE: &str = ".butler/hooks.json";
/// Marks a project hook in run records; a file's own ids cannot contain `:`.
pub const PROJECT_HOOK_ID_PREFIX: &str = "project:";

/// One hook as the card shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectHookLine {
    /// Lifecycle event.
    pub event: HookEvent,
    /// Tool matchers; empty matches every tool.
    pub tools: Vec<String>,
    /// The exact action.
    pub command: String,
}

/// The folder a card asks about, which its answer applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectHookRequest {
    /// The folder's resolved path.
    pub project_path: String,
    /// The folder's filesystem identity, so a replaced folder asks again.
    pub project_identity: String,
    /// This session's access mode runs hooks outside any sandbox.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unsandboxed: bool,
    /// Every enabled hook, in file order.
    pub hooks: Vec<ProjectHookLine>,
}

impl ProjectHookRequest {
    /// Whether any hook that would run listens to `event`.
    pub fn listens(&self, event: HookEvent) -> bool {
        self.hooks.iter().any(|hook| hook.event == event)
    }
}

/// What a project folder's hooks mean right now.
pub enum ProjectHookReview {
    /// This folder has no hook that could run.
    None,
    /// The user does not trust this folder; nothing runs and nobody is asked.
    Denied,
    /// The user trusts this folder: a port holding what was just read.
    Trusted(Arc<dyn HookPort>),
    /// Nobody answered for this folder yet; nothing runs.
    Undecided(Box<ProjectHookRequest>),
}
