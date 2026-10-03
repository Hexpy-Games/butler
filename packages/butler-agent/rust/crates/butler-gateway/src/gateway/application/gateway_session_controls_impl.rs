use super::*;

impl crate::gateway::GatewaySessionControls for AppApplication {
    fn work_model(&self, session: String, view: String, input: Value) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            let runtime = if view == "plan_graph"
                || session.starts_with("subsession:")
                || session.starts_with("steward-")
                || session.starts_with("worker-")
            {
                session
            } else {
                let id = session.clone();
                let exists = this
                    .storage
                    .execute(move |db| {
                        db.query_row(
                            "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1)",
                            [id],
                            |r| r.get::<_, bool>(0),
                        )
                        .map_err(super::storage::AppStorageError::sqlite)
                    })
                    .await
                    .map_err(super::app_error)?;
                if !exists {
                    return Err(super::public(404, "not_found", "Session not found."));
                }
                crate::gateway::app_session_hint(&session)
            };
            this.dependencies
                .session_work_progress
                .work_model(runtime, view, input)
                .await
        })
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
