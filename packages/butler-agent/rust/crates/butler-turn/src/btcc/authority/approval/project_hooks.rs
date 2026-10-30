//! The approval card of a project folder's hooks.
use super::{
    ApprovalActionKind, ApprovalFacts, ApprovalRisk, ApprovalTargetKind, AuthorityApproval,
    FALLBACK_LABEL, single,
};
use butler_core::hooks::{ProjectHookLine, ProjectHookRequest};
use serde::{Deserialize, Serialize};

/// The exact hooks a project hook card asks about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalProjectHooks {
    /// The hook file, relative to the project root.
    pub file: String,
    /// Whether the user allowed another version of this file before.
    pub changed: bool,
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
        ApprovalRisk::Medium,
    );
    approval.examples.clear();
    approval.examples_truncated.clear();
    approval.count = request
        .as_ref()
        .map_or(0, |r| u32::try_from(r.hooks.len()).unwrap_or(u32::MAX));
    approval.project_hooks = request.map(|request| ApprovalProjectHooks {
        file: request.file,
        changed: request.changed,
        hooks: request.hooks,
    });
    approval
}
