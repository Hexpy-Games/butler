use super::*;

impl crate::gateway::GatewaySessionControls for AppApplication {
    fn browser_download_context(&self, session_id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.browser_download_context_owned(session_id).await })
    }

    fn browser_download_published(
        &self,
        output: butler_runtime::outputs::Output,
    ) -> ApplicationFuture<()> {
        let this = self.clone_handle();
        Box::pin(async move { this.browser_download_published_owned(output).await })
    }
    fn get_session_controls_view(
        &self,
        session_id: String,
    ) -> ApplicationFuture<AppSessionControlsView> {
        let this = self.clone_handle();
        Box::pin(async move { this.get_session_controls_view_owned(session_id).await })
    }
    fn update_session_controls_view(
        &self,
        session_id: String,
        update: AppSessionControlUpdate,
    ) -> ApplicationFuture<AppSessionControlsView> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.update_session_controls_view_owned(session_id, update)
                .await
        })
    }
    fn decide_session_plan(
        &self,
        session_id: String,
        plan_id: String,
        request: AppPlanDecisionRequest,
    ) -> ApplicationFuture<AppPlanDecisionResult> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.decide_session_plan_owned(session_id, plan_id, request)
                .await
        })
    }
}
