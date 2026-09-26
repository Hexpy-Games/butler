//! App-owned topic branch reservation, summary seed, and readiness transition.

mod contracts;
mod operation;
mod owner;
mod reservation;
mod resolution;
mod store;

pub(crate) use contracts::{
    AppSessionBranchDestination, AppSessionBranchRequest, AppSessionBranchResult,
    AppSessionBranchSeed, AppStartTopicConversationRequest,
};
pub(super) use owner::SessionBranchOwner;

use super::AppApplication;
use crate::gateway::GatewayApplicationError;
use tokio_util::sync::CancellationToken;

impl AppApplication {
    pub(crate) async fn start_topic_conversation_owned(
        &self,
        request: AppStartTopicConversationRequest,
        shutdown: CancellationToken,
    ) -> Result<AppSessionBranchResult, GatewayApplicationError> {
        self.session_branches
            .start(self.clone_handle(), request, shutdown)
            .await
    }
}
