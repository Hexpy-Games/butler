//! Session execution controls and plan decisions.
use super::*;

pub trait GatewaySessionControls: Send + Sync {
    /// The registered computer a conversation runs on (`chats.computer_id`).
    fn session_computer(&self, _session_id: String) -> ApplicationFuture<Option<String>> {
        Box::pin(async { Ok(None) })
    }

    fn project_transferred(
        &self,
        _chat_id: String,
        _turns: Vec<crate::gateway::RemovedComputerTurn>,
    ) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    /// Main-only canonical download workspace.
    fn browser_download_context(
        &self,
        _session_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn get_session_controls_view(
        &self,
        session_id: String,
    ) -> ApplicationFuture<AppSessionControlsView>;
    fn update_session_controls_view(
        &self,
        session_id: String,
        update: AppSessionControlUpdate,
    ) -> ApplicationFuture<AppSessionControlsView>;
    fn decide_session_plan(
        &self,
        session_id: String,
        plan_id: String,
        request: AppPlanDecisionRequest,
    ) -> ApplicationFuture<AppPlanDecisionResult>;
}
