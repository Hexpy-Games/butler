use super::*;

impl AppMemoryManagement {
    pub(super) async fn list_instructions(&self) -> Result<Value, GatewayApplicationError> {
        let revision = self.owner.inventory().revision;
        let rows = self.instructions.list().await.map_err(instruction_error)?;
        if self.owner.inventory().revision == revision {
            *self
                .instruction_count
                .lock()
                .map_err(|_| GatewayApplicationError::internal())? =
                Some((revision, rows.len() as u64));
        }
        encode(json!({"instructions":rows}))
    }

    pub(super) async fn inventory(
        &self,
        mut inventory: butler_memory::management::MemoryInventory,
        measure: bool,
    ) -> Result<Value, GatewayApplicationError> {
        // A failed instruction owner must not hide the other three cards.
        if let Some(card) = inventory
            .kinds
            .iter_mut()
            .find(|card| card.kind == "pinned")
        {
            if measure {
                let revision = inventory.revision;
                let rows = self.instructions.list().await;
                let count = rows.ok().map(|rows| rows.len() as u64);
                *self
                    .instruction_count
                    .lock()
                    .map_err(|_| GatewayApplicationError::internal())? =
                    count.map(|count| (revision, count));
            }
            card.item_count = self
                .instruction_count
                .lock()
                .map_err(|_| GatewayApplicationError::internal())?
                .as_ref()
                .filter(|(revision, _)| *revision == inventory.revision)
                .map(|(_, count)| *count);
            card.health =
                json!({"state": if card.item_count.is_some() {"available"} else {"not_measured"}});
        }
        let mut view = encode(inventory)?;
        let id = self
            .jobs
            .lock()
            .map_err(|_| GatewayApplicationError::internal())?
            .keys()
            .next()
            .cloned();
        if let Some(id) = id {
            view["operation"] =
                if let Some(reset) = self.owner.reset_status(id.clone()).await.map_err(error)? {
                    encode(reset)?
                } else {
                    encode(self.owner.cleanup_status(id).await.map_err(error)?)?
                };
        }
        Ok(view)
    }

    /// Settings-side instruction changes: an imported addition or a deletion.
    pub(super) async fn change_instruction(
        &self,
        command: AppMemoryCommand,
        sink: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            AppMemoryCommand::RememberInstruction { text, operation_id } => {
                self.remember_instruction(text, operation_id, sink, cancellation)
                    .await
            }
            AppMemoryCommand::DeleteInstruction {
                handle,
                expected_revision,
                project_id,
                operation_id,
            } => {
                let target = RememberedRuleTarget {
                    handle,
                    expected_revision,
                    project_id,
                };
                self.delete_instruction(target, operation_id, sink, cancellation)
                    .await
            }
            _ => Err(GatewayApplicationError::internal()),
        }
    }

    async fn remember_instruction(
        &self,
        text: String,
        operation_id: String,
        sink: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let input = butler_memory::cognition::ExplicitMemoryUpdateInput {
            duration: Some("always".into()),
            text,
            operation_id: Some(operation_id),
            ..Default::default()
        };
        let receipt = self
            .instructions
            .remember(input, cancellation)
            .await
            .map_err(instruction_error)?;
        sink(json!({"kind":"instructions"})).await?;
        encode(receipt)
    }

    async fn delete_instruction(
        &self,
        target: RememberedRuleTarget,
        operation_id: String,
        sink: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let receipt = self
            .instructions
            .forget(target, operation_id, None, None, cancellation)
            .await
            .map_err(instruction_error)?;
        sink(json!({"kind":"instructions"})).await?;
        encode(receipt)
    }
}

pub(super) fn instruction_error(
    source: butler_memory::cognition::CognitionError,
) -> GatewayApplicationError {
    public_error(409, "instruction_unavailable", "Instruction unavailable.").with_source(source)
}
