//! Transactional mutations for the App-owned navigation space.

mod commands;
mod contracts;
mod owner;
mod reader;
mod relocation;
mod tree;

pub(crate) use contracts::{
    AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin, AppSpacePosition, AppSpaceView,
};
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
        self.space_mutations.read(&self.storage).await
    }
}
