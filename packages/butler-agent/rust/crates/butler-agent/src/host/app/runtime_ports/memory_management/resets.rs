//! Authenticated reset jobs return a durable operation identity immediately.
use super::*;
impl AppMemoryManagement {
    pub(super) async fn reset_command(
        self,
        command: AppMemoryCommand,
        sink: MemoryEventSink,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            AppMemoryCommand::ResetChat {
                operation_id,
                inventory_revision,
            } => {
                self.start_reset(operation_id, inventory_revision, false, None, sink)
                    .await
            }
            AppMemoryCommand::ResetProfile {
                operation_id,
                inventory_revision,
            } => {
                self.start_reset(operation_id, inventory_revision, true, None, sink)
                    .await
            }
            AppMemoryCommand::ResetProject {
                operation_id,
                inventory_revision,
                project_id,
            } => {
                self.start_reset(
                    operation_id,
                    inventory_revision,
                    false,
                    Some(project_id),
                    sink,
                )
                .await
            }
            AppMemoryCommand::ResetStatus { operation_id } => {
                self.read_reset_status(operation_id).await
            }
            _ => Err(GatewayApplicationError::internal()),
        }
    }

    pub(super) async fn read_reset_status(
        &self,
        id: String,
    ) -> Result<Value, GatewayApplicationError> {
        encode(
            self.owner
                .reset_status(id)
                .await
                .map_err(error)?
                .ok_or_else(|| {
                    public_error(404, "memory_operation_not_found", "Operation not found.")
                })?,
        )
    }

    pub(super) async fn start_reset(
        self,
        operation_id: String,
        inventory_revision: u64,
        profile_reset: bool,
        project_id: Option<String>,
        sink: MemoryEventSink,
    ) -> Result<Value, GatewayApplicationError> {
        let receipt = if profile_reset {
            self.owner
                .begin_profile_reset(operation_id.clone(), inventory_revision)
                .await
        } else {
            self.owner
                .begin_conversation_reset(
                    operation_id.clone(),
                    inventory_revision,
                    project_id.clone(),
                )
                .await
        }
        .map_err(error)?;
        if ["complete", "cancelled"].contains(&receipt.phase.as_str()) {
            return encode(receipt);
        }
        let token = self.shutdown.child_token();
        {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| GatewayApplicationError::internal())?;
            if jobs.contains_key(&operation_id) {
                return encode(receipt);
            }
            jobs.insert(operation_id.clone(), token.clone());
        }
        let response = encode(receipt.clone())?;
        tokio::spawn(async move {
            if let Ok(value) = encode(receipt) {
                let _ = sink(value).await;
            }
            let result = if profile_reset {
                crate::host::memory_jobs::reset_profile(
                    &self.owner,
                    &self.profile,
                    operation_id.clone(),
                    token,
                )
                .await
            } else if project_id.is_some() {
                self.owner
                    .reset_project(operation_id.clone(), self.instructions.clone(), token)
                    .await
            } else {
                self.owner
                    .reset_conversations(operation_id.clone(), token)
                    .await
            };
            let result = match result {
                Ok(result) => Some(result),
                Err(_) => self
                    .owner
                    .reset_status(operation_id.clone())
                    .await
                    .ok()
                    .flatten(),
            };
            if let Some(result) = result
                && let Ok(value) = encode(result)
            {
                let _ = sink(value).await;
            }
            if let Ok(mut jobs) = self.jobs.lock() {
                jobs.remove(&operation_id);
            }
        });
        Ok(response)
    }
}
