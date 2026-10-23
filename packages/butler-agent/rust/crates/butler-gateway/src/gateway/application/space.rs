//! Transactional mutations for the App-owned navigation space.

mod commands;
mod contracts;
mod owner;
mod reader;
mod relocation;
mod tree;

pub use contracts::{AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin};
pub(crate) use contracts::{AppSpacePosition, AppSpaceView};
pub(super) use owner::SpaceMutationOwner;
pub(super) use reader::read as read_view;
pub(super) use relocation::{AppRelocationDestination, destination as relocation_destination};
pub(super) use tree::require_node;

use crate::gateway::GatewayApplicationError;
use serde_json::Value;

use super::AppApplication;

impl AppApplication {
    pub(crate) async fn mutate_space_owned(
        &self,
        command: AppSpaceCommand,
        origin: AppSpaceOrigin,
        title: Option<String>,
    ) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        self.space_mutations
            .execute(
                &self.storage,
                &self.subscribers,
                self.dependencies.identity_clock.clone(),
                command,
                origin,
                title,
            )
            .await
    }

    pub(crate) async fn read_space_owned(&self) -> Result<Value, GatewayApplicationError> {
        let mut space = self.space_mutations.read(&self.storage).await?;
        if self.dependencies.work_model.changes().is_some()
            && let Some(nodes) = space["nodes"].as_array_mut()
        {
            for node in nodes {
                if node["kind"] != "session" {
                    continue;
                }
                let Some(chat) = node["entityId"].as_str() else {
                    continue;
                };
                node["task_sessions"] = self.task_sessions_owned(chat).await?;
            }
        }
        Ok(space)
    }

    pub(super) async fn task_sessions_owned(
        &self,
        chat: &str,
    ) -> Result<Value, GatewayApplicationError> {
        if self.dependencies.work_model.changes().is_none() {
            return Ok(serde_json::json!([]));
        }
        let request = super::AppWorkModelRequest {
            resource: super::AppWorkModelResource::SessionWorks,
            id: self.runtime_hint(chat).await?,
            input: None,
        };
        let works = self.dependencies.work_model.execute(request).await?;
        nested_sessions(&self.storage, works).await
    }
}

async fn nested_sessions(
    storage: &super::storage::AppStorage,
    works: Value,
) -> Result<Value, GatewayApplicationError> {
    storage.read(move |db| {
        let mut nested = Vec::new();
        for work in works["works"].as_array().into_iter().flatten() {
            for chain in work["tasks"]["chains"].as_array().into_iter().flatten() {
                for step in chain["steps"].as_array().into_iter().flatten() {
                    for task in step["tasks"].as_array().into_iter().flatten() {
                        let owner = task["assignee_session_id"].as_str().or(task["reserved_session_id"].as_str());
                        let Some(owner) = owner else {continue;};
                        use rusqlite::OptionalExtension;
                        let chat: Option<String> = db.query_row(super::work_model::LOOKUP_SESSION,[owner],|r|r.get(0)).optional().map_err(super::AppStorageError::sqlite)?;
                        if let Some(chat) = chat { nested.push(serde_json::json!({"session_id":chat,"task_id":task["id"],"work_id":work["id"],"title":task["title"],"status":task["status"]})); }
                    }
                }
            }
        }
        Ok(serde_json::json!(nested))
    }).await.map_err(super::app_error)
}
