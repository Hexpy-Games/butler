use super::*;
use crate::gateway::GatewayMutationCommands;

impl GatewayMutationCommands for AppApplication {
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
        Box::pin(async move { this.delete_project_owned(id, permanent).await })
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
