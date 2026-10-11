//! App mutation operations kept separate from the read and Turn gateway contract.

use super::*;

pub trait GatewayMutationCommands: Send + Sync + 'static {
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
