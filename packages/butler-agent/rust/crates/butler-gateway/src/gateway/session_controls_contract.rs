//! Session execution controls and plan decisions.
use super::*;

pub trait GatewaySessionControls: Send + Sync {
    /// Main-only canonical workspace and current output attribution.
    fn browser_download_context(
        &self,
        _session_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn browser_download_published(
        &self,
        _output: butler_runtime::outputs::Output,
    ) -> ApplicationFuture<()> {
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
