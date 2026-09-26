use super::*;

impl GatewaySessionControls for TestApplication {
    fn get_session_controls_view(&self, _: String) -> ApplicationFuture<AppSessionControlsView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_session_controls_view(
        &self,
        _: String,
        _: AppSessionControlUpdate,
    ) -> ApplicationFuture<AppSessionControlsView> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn decide_session_plan(
        &self,
        _: String,
        _: String,
        _: AppPlanDecisionRequest,
    ) -> ApplicationFuture<AppPlanDecisionResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}
