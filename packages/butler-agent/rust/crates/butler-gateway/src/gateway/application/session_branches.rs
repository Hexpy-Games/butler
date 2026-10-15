//! App-owned topic branch reservation, summary seed, and readiness transition.

mod contracts;
mod operation;
mod owner;
mod reservation;
mod resolution;
mod store;

pub use contracts::{
    AppBranchSourceLocation, AppSessionBranchResult, AppStartTopicConversationRequest,
};
pub(crate) use contracts::{
    AppSessionBranchDestination, AppSessionBranchRequest, AppSessionBranchSeed,
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

    /// The source answer of a ready branch conversation, at its current owner.
    pub(crate) async fn branch_source_owned(
        &self,
        session_id: String,
    ) -> Result<AppBranchSourceLocation, GatewayApplicationError> {
        self.storage
            .read(move |db| store::source_location(db, &session_id))
            .await
            .map_err(super::app_error)?
            .ok_or_else(|| GatewayApplicationError::Public {
                status: 404,
                code: "branch_origin_unavailable".to_owned(),
                message: "원본 답변을 찾을 수 없습니다.".to_owned(),
                source: None,
            })
    }
}
