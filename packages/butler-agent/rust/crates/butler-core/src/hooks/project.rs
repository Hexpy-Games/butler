//! Hooks from a project folder run only after the user approved their exact content.
use super::{HookEvent, HookPort};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The authority capability of a project hook approval card.
pub const PROJECT_HOOKS_CAPABILITY: &str = "project_hooks";
/// Where a project folder keeps its hooks, relative to its root.
pub const PROJECT_HOOK_FILE: &str = ".butler/hooks.json";
/// Marks a project hook in run records; a file's own ids cannot contain `:`.
pub const PROJECT_HOOK_ID_PREFIX: &str = "project:";

/// How a hook differs from the content the user last allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectHookChange {
    /// Same id, different content.
    Changed,
    /// New id.
    Added,
    /// No longer in the file; it would not run.
    Removed,
}

/// One hook as the card shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectHookLine {
    /// The hook's id in the file.
    pub id: String,
    /// Lifecycle event.
    pub event: HookEvent,
    /// Tool matchers; empty matches every tool.
    pub tools: Vec<String>,
    /// The exact action, with unprintable characters spelled out.
    pub command: String,
    /// Digest of the whole definition, including what the line does not show.
    pub digest: String,
    /// Difference from the content last allowed, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<ProjectHookChange>,
}

/// The exact content a card asks about, which its answer applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectHookRequest {
    /// The project's resolved root.
    pub project_path: String,
    /// The root directory's filesystem identity, so a replaced folder asks again.
    pub project_identity: String,
    /// Digest of the path, the identity and the parsed hooks.
    pub content_hash: String,
    /// The folder name.
    pub folder: String,
    /// The hook file, relative to the root.
    pub file: String,
    /// Whether the user allowed another version of this file before.
    pub changed: bool,
    /// Every hook, in file order, then those removed since the last allow.
    pub hooks: Vec<ProjectHookLine>,
}

impl ProjectHookRequest {
    /// Whether any hook that would run listens to `event`.
    pub fn listens(&self, event: HookEvent) -> bool {
        self.hooks
            .iter()
            .any(|hook| hook.event == event && hook.change != Some(ProjectHookChange::Removed))
    }
}

/// What a project's hook file means right now.
pub enum ProjectHookReview {
    /// No hook here can run: no file, none enabled, or a file that was refused.
    None,
    /// The user denied this content; nothing runs and nobody is asked again.
    Denied,
    /// This content was allowed: a port holding what was read for this answer.
    Trusted(Arc<dyn HookPort>),
    /// Nobody answered for this content yet; nothing runs.
    Undecided(Box<ProjectHookRequest>),
}
