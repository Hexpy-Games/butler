//! App mutation operations kept separate from the read and Turn gateway contract.

use super::*;

pub trait GatewayMutationCommands: Send + Sync + 'static {
    fn send_subsession_result(
        &self,
        _command: SendMessageCommand,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn composing(&self, _id: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn report_pause(&self, _id: String, _decision: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn upload_canon_file(
        &self,
        _project: String,
        _input: AppFileUpload,
    ) -> ApplicationFuture<MessageFileRef> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn canon_sidebar(&self, _project: String) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn canon_sidebar_order(
        &self,
        _project: String,
        _input: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn canon_conversation(
        &self,
        _id: String,
        _session_id: Option<String>,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// An unattended schedule run skipped a step that needs permission (D8).
    fn automation_run_attention(
        &self,
        _id: String,
        _run_id: String,
        _code: String,
        _tainted: bool,
        _action: Option<serde_json::Value>,
    ) -> ApplicationFuture<AutomationRunSummary> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Admission for a preview effect, including sessions closed before its
    /// change-driven lifetime observer was installed.
    fn preview_session_open(&self, _id: String) -> ApplicationFuture<bool> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn update_project(
        &self,
        id: String,
        input: AppProjectUpdate,
    ) -> ApplicationFuture<AppProjectActionResult>;
    fn archive_project(&self, id: String) -> ApplicationFuture<AppProjectActionResult>;
    fn pin_project(
        &self,
        id: String,
        pinned: Option<bool>,
    ) -> ApplicationFuture<AppProjectActionResult>;
    fn delete_project(
        &self,
        id: String,
        permanent: bool,
    ) -> ApplicationFuture<AppProjectActionResult>;
    fn update_session(
        &self,
        id: String,
        input: AppSessionUpdate,
    ) -> ApplicationFuture<AppSessionActionResult>;
    fn archive_session(
        &self,
        id: String,
        title: Option<String>,
    ) -> ApplicationFuture<AppSessionActionResult>;
    fn clear_general(&self, title: String) -> ApplicationFuture<serde_json::Value>;
    /// Moves the chat's read marker to its latest finished reply.
    fn mark_session_read(&self, _id: String) -> ApplicationFuture<AppSessionReadResult> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn delete_session(
        &self,
        id: String,
        permanent: bool,
    ) -> ApplicationFuture<AppSessionActionResult>;
    fn mutate_space(
        &self,
        command: AppSpaceCommand,
        origin: AppSpaceOrigin,
        title: Option<String>,
    ) -> ApplicationFuture<AppSpaceMutationResult>;
    fn relocate_session(
        &self,
        request: AppRelocateSessionRequest,
    ) -> ApplicationFuture<AppSpaceMutationResult>;
}
