//! Public New Chat Briefing over App state; the host projects Cognition artifacts.

use serde_json::Value;

use super::AppApplication;
use crate::gateway::{AppBriefingProject, AppNewChatBriefingRequest, GatewayApplicationError};

impl AppApplication {
    pub(super) async fn new_chat_briefing_view(
        &self,
        date: Option<String>,
        project_id: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let locale = self.briefing_language().await?;
        let project = if let Some(id) = project_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            Some(
                self.list_projects(false)
                    .await?
                    .projects
                    .into_iter()
                    .find(|project| project.id == id)
                    .ok_or_else(|| GatewayApplicationError::Public {
                        status: 404,
                        code: "project_not_found".into(),
                        message: "Project not found.".into(),
                        source: None,
                    })?,
            )
        } else {
            None
        };
        let data_root = self.butler_data.clone();
        let now = self.dependencies.identity_clock.now_iso();
        self.dependencies
            .new_chat_briefing
            .view(AppNewChatBriefingRequest {
                data_root,
                date,
                project: project.map(|project| AppBriefingProject {
                    id: project.id,
                    display_name: project.display_name,
                }),
                locale,
                now,
            })
            .await
    }
}
