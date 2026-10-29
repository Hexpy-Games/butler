use super::*;
use crate::gateway::GatewayMutationCommands;

impl GatewayMutationCommands for AppApplication {
    fn send_subsession_result(&self, command: SendMessageCommand) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.subsession_result_owned(command).await })
    }
    fn composing(&self, id: String) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.composing_owned(id).await })
    }
    fn report_pause(&self, id: String, decision: String) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.report_pause_owned(id, decision).await })
    }

    fn upload_canon_file(
        &self,
        project: String,
        input: AppFileUpload,
    ) -> ApplicationFuture<crate::gateway::MessageFileRef> {
        let this = self.clone_handle();
        Box::pin(async move { super::canon::files::upload(&this, project, input).await })
    }

    fn canon_sidebar(&self, project: String) -> ApplicationFuture<Value> {
        let app = self.clone_handle();
        Box::pin(async move { canon_sidebar::sidebar(&app, project).await })
    }
    fn canon_sidebar_order(&self, project: String, input: Value) -> ApplicationFuture<Value> {
        let app = self.clone_handle();
        Box::pin(async move { canon_sidebar::reorder(&app, project, input).await })
    }
    fn canon_conversation(
        &self,
        id: String,
        session_id: Option<String>,
    ) -> ApplicationFuture<Value> {
        let app = self.clone_handle();
        Box::pin(async move { canon_sidebar::conversation(&app, id, session_id).await })
    }
    fn automation_run_attention(
        &self,
        id: String,
        run_id: String,
        code: String,
        tainted: bool,
        action: Option<serde_json::Value>,
    ) -> ApplicationFuture<crate::gateway::AutomationRunSummary> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.automation_run_attention_owned(id, run_id, code, tainted, action)
                .await
        })
    }
    fn preview_session_open(&self, id: String) -> ApplicationFuture<bool> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.storage
                .read(move |db| {
                    db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1 AND archived=0)",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(storage::AppStorageError::sqlite)
                })
                .await
                .map_err(app_error)
        })
    }
    fn update_project(
        &self,
        id: String,
        input: AppProjectUpdate,
    ) -> ApplicationFuture<AppProjectActionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.update_project_owned(id, input).await })
    }
    fn archive_project(&self, id: String) -> ApplicationFuture<AppProjectActionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.archive_project_owned(id).await })
    }
    fn pin_project(
        &self,
        id: String,
        pinned: Option<bool>,
    ) -> ApplicationFuture<AppProjectActionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.pin_project_owned(id, pinned).await })
    }
    fn delete_project(
        &self,
        id: String,
        permanent: bool,
    ) -> ApplicationFuture<AppProjectActionResult> {
        let this = self.clone_handle();
        Box::pin(async move {
            let result = this.delete_project_owned(id, permanent).await?;
            this.assets_owned(AppAssetCommand::Sweep).await?;
            Ok(result)
        })
    }
    fn update_session(
        &self,
        id: String,
        input: AppSessionUpdate,
    ) -> ApplicationFuture<AppSessionActionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.update_session_owned(id, input).await })
    }
    fn archive_session(
        &self,
        id: String,
        title: Option<String>,
    ) -> ApplicationFuture<AppSessionActionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.archive_session_owned(id, title).await })
    }
    fn clear_general(&self, title: String) -> ApplicationFuture<serde_json::Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.clear_general_owned(title).await })
    }
    fn mark_session_read(&self, id: String) -> ApplicationFuture<AppSessionReadResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.mark_session_read_owned(id).await })
    }
    fn delete_session(
        &self,
        id: String,
        permanent: bool,
    ) -> ApplicationFuture<AppSessionActionResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.delete_session_owned(id, permanent).await })
    }
    fn mutate_space(
        &self,
        command: AppSpaceCommand,
        origin: AppSpaceOrigin,
        title: Option<String>,
    ) -> ApplicationFuture<AppSpaceMutationResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.mutate_space_owned(command, origin, title).await })
    }
    fn relocate_session(
        &self,
        request: AppRelocateSessionRequest,
    ) -> ApplicationFuture<AppSpaceMutationResult> {
        let this = self.clone_handle();
        Box::pin(async move { this.relocate_session_owned(request).await })
    }
}
