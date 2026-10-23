//! Transactional mutations for the App-owned navigation space.

mod commands;
mod contracts;
mod owner;
mod reader;
mod relocation;
mod task_sessions;
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
        let chats = space["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n["kind"] == "session")
            .filter_map(|n| n["entityId"].as_str().map(str::to_owned))
            .collect();
        let mut nested = self.task_sessions_owned(chats).await?;
        for node in space["nodes"].as_array_mut().into_iter().flatten() {
            if let Some(chat) = node["entityId"].as_str() {
                node["task_sessions"] =
                    nested.remove(chat).unwrap_or_else(|| serde_json::json!([]));
            }
        }
        Ok(space)
    }
}
