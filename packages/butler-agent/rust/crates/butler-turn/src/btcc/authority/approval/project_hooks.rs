//! The approval card of a project folder's hooks.
use super::{
    ApprovalActionKind, ApprovalFacts, ApprovalRisk, ApprovalTargetKind, AuthorityApproval,
    FALLBACK_LABEL, single,
};
use butler_core::hooks::{ProjectHookLine, ProjectHookRequest, ProjectHooksOff};
use serde::{Deserialize, Serialize};

/// The exact hooks a project hook card asks about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalProjectHooks {
    /// The hook file's full path.
    pub file: String,
    /// Whether the user allowed another version of this file before.
    pub changed: bool,
    /// This session's access mode runs hooks outside any sandbox.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unsandboxed: bool,
    /// Set when allowed hooks can no longer run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off: Option<ProjectHooksOff>,
    pub hooks: Vec<ProjectHookLine>,
}

/// Lists every hook without a cap: what is not listed would still run.
pub(super) fn summarize(facts: ApprovalFacts<'_>) -> AuthorityApproval {
    let request = ProjectHookRequest::deserialize(facts.input).ok();
    let mut approval = single(
        ApprovalActionKind::ProjectHooks,
        ApprovalTargetKind::Folder,
        request
            .as_ref()
            .map_or(FALLBACK_LABEL, |r| r.folder.as_str()),
        ApprovalRisk::High,
    );
    approval.examples.clear();
    approval.examples_truncated.clear();
    approval.count = request
        .as_ref()
        .map_or(0, |r| u32::try_from(r.hooks.len()).unwrap_or(u32::MAX));
    approval.project_hooks = request.map(|request| ApprovalProjectHooks {
        file: request.location,
        changed: request.changed,
        unsandboxed: request.unsandboxed,
        off: request.off,
        hooks: request.hooks,
    });
    approval
}
