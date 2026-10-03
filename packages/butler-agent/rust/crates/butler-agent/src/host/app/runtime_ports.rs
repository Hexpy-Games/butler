//! Required production App ports over existing native owners.

mod admission;
mod assets;
mod context_read;
mod ingress;
mod liveness;
mod memory_management;
mod model_catalog;
mod personalization;
pub(crate) use memory_management::AppMemoryManagement;
mod readiness;
mod runtime_info;
mod session_progress;
mod session_workspaces;
mod settings;
mod settings_mutation;
mod setup;
mod topic_branch;

use std::sync::Arc;

use butler_gateway::gateway::{AppApprovalClaims, ApplicationFuture, GatewayApplicationError};
use butler_turn::btcc::PrincipalAuthority;

pub(crate) use admission::AppAdmission;
pub(crate) use assets::AppAssets;
pub(crate) use context_read::AppContextRead;
pub(crate) use ingress::AppIngress;
pub(crate) use liveness::AppQueueOwnerLivenessAdapter;
pub(crate) use model_catalog::AppModelCatalog;
pub(crate) use personalization::AppPersonalization;
pub(crate) use readiness::AppReadiness;
pub(crate) use runtime_info::AppRuntimeInfo;
pub(crate) use session_progress::AppSessionProgress;
pub(crate) use session_workspaces::AppSessionWorkspaces;
pub(crate) use settings::AppSettingsFactsAdapter;
pub(crate) use settings_mutation::AppSettingsMutation;
pub(crate) use setup::{AppSetup, AppSetupParts};
pub(crate) use topic_branch::{AppBranchConversations, AppBranchSummarizerAdapter};

pub(crate) struct AppApprovalClaimsAdapter {
    authority: Arc<PrincipalAuthority>,
}

impl AppApprovalClaimsAdapter {
    pub(crate) fn new(authority: Arc<PrincipalAuthority>) -> Self {
        Self { authority }
    }
}

impl AppApprovalClaims for AppApprovalClaimsAdapter {
    fn retains_claim(&self, turn_id: String) -> ApplicationFuture<bool> {
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .retains_approval_claim(turn_id)
                .await
                .map_err(GatewayApplicationError::internal_from)
        })
    }
}
