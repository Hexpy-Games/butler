//! The card that asks whether to trust a project folder.
use super::{
    ApprovalActionKind, ApprovalFacts, ApprovalRisk, ApprovalTargetKind, AuthorityApproval,
    FALLBACK_LABEL, single,
};
use butler_core::hooks::{ProjectHookLine, ProjectHookRequest};
use serde::{Deserialize, Serialize};

/// The folder a card asks about and the hooks it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalProjectHooks {
    /// The folder's full path.
    pub folder: String,
    /// This session's access mode runs hooks outside any sandbox.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unsandboxed: bool,
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
            .map_or(FALLBACK_LABEL, |r| r.project_path.as_str()),
        ApprovalRisk::High,
    );
    approval.examples.clear();
    approval.examples_truncated.clear();
    approval.count = request
        .as_ref()
        .map_or(0, |r| u32::try_from(r.hooks.len()).unwrap_or(u32::MAX));
    approval.project_hooks = request.map(|request| ApprovalProjectHooks {
        folder: request.project_path,
        unsandboxed: request.unsandboxed,
        hooks: request.hooks,
    });
    approval
}
