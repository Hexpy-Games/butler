//! Required production App ports over existing native owners.

mod admission;
mod assets;
mod context_read;
mod ingress;
mod liveness;
mod model_catalog;
mod personalization;
mod readiness;
mod runtime_info;
mod session_progress;
mod session_workspaces;
mod settings;
mod settings_mutation;
mod topic_branch;

use std::sync::Arc;

use crate::{
    btcc::NativePrincipalAuthority,
    gateway::{AppApprovalClaims, ApplicationFuture, GatewayApplicationError},
};

pub(crate) use admission::NativeAppAdmission;
pub(crate) use assets::NativeAppAssets;
pub(crate) use context_read::NativeAppContextRead;
pub(crate) use ingress::NativeAppIngress;
pub(crate) use liveness::NativeAppQueueOwnerLiveness;
pub(crate) use model_catalog::NativeAppModelCatalog;
pub(crate) use personalization::NativeAppPersonalization;
pub(crate) use readiness::NativeAppReadiness;
pub(crate) use runtime_info::NativeAppRuntimeInfo;
pub(crate) use session_progress::NativeAppSessionProgress;
pub(crate) use session_workspaces::NativeAppSessionWorkspaces;
pub(crate) use settings::NativeAppSettingsFacts;
pub(crate) use settings_mutation::NativeAppSettingsMutation;
pub(crate) use topic_branch::{NativeAppBranchConversations, NativeAppBranchSummarizer};

pub(crate) struct NativeAppApprovalClaims {
    authority: Arc<NativePrincipalAuthority>,
}

impl NativeAppApprovalClaims {
    pub(crate) fn new(authority: Arc<NativePrincipalAuthority>) -> Self {
        Self { authority }
    }
}

impl AppApprovalClaims for NativeAppApprovalClaims {
    fn retains_claim(&self, turn_id: String) -> ApplicationFuture<bool> {
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .retains_approval_claim(turn_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)
        })
    }
}
