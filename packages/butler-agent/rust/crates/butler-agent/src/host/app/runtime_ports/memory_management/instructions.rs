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
            AppMemoryCommand::PendingInstructions { items } => {
                self.pending_instructions(items).await
            }
            AppMemoryCommand::ApplyPendingInstruction {
                item,
                expected_revision,
            } => {
                self.apply_pending_instruction(item, expected_revision, sink, cancellation)
                    .await
            }
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

    async fn pending_instructions(
        &self,
        mut items: Vec<Value>,
    ) -> Result<Value, GatewayApplicationError> {
        let rules = self.instructions.list().await.map_err(instruction_error)?;
        for item in &mut items {
            let target = &item["target"];
            let current = rules.iter().find(|r| {
                r.project_id.is_none()
                    && r.scope_session_id.is_none()
                    && target["handle"] == r.handle
            });
            let conflict =
                !target.is_null() && current.is_none_or(|r| target["revision"] != r.revision);
            item["current"] = json!(
                current.map(|r| json!({"handle":r.handle,"revision":r.revision,"text":r.text}))
            );
            item["conflict"] = json!(conflict);
        }
        Ok(json!({"pending":items}))
    }

    async fn apply_pending_instruction(
        &self,
        item: Value,
        expected_revision: Option<String>,
        sink: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let changed = || {
            public_error(
                409,
                "instruction_changed",
                "This instruction changed on this device.",
            )
        };
        let id = item["id"]
            .as_str()
            .ok_or_else(GatewayApplicationError::internal)?
            .to_owned();
        let input = butler_memory::cognition::ExplicitMemoryUpdateInput {
            text: item["text"].as_str().unwrap_or_default().to_owned(),
            duration: item["duration"].as_str().map(str::to_owned),
            expires_at: item["expires_at"].as_str().map(str::to_owned),
            operation_id: Some(id.clone()),
            ..Default::default()
        };
        let target = if item["target"].is_null() {
            None
        } else {
            let handle = item["target"]["handle"].as_str().ok_or_else(changed)?;
            let rules = self.instructions.list().await.map_err(instruction_error)?;
            if !rules.iter().any(|r| {
                r.project_id.is_none() && r.scope_session_id.is_none() && r.handle == handle
            }) {
                return Err(changed());
            }
            Some(RememberedRuleTarget {
                handle: handle.to_owned(),
                project_id: None,
                expected_revision: expected_revision
                    .or_else(|| item["target"]["revision"].as_str().map(str::to_owned))
                    .ok_or_else(changed)?,
            })
        };
        let receipt = match item["action"].as_str() {
            Some("remember") => self.instructions.remember(input, cancellation).await,
            Some("replace") => {
                self.instructions
                    .correct(target.ok_or_else(changed)?, input, cancellation)
                    .await
            }
            Some("forget") => {
                self.instructions
                    .forget(target.ok_or_else(changed)?, id, None, None, cancellation)
                    .await
            }
            _ => return Err(GatewayApplicationError::internal()),
        }
        .map_err(|error| {
            if error.code() == "memory_source_changed" {
                changed()
            } else {
                instruction_error(error)
            }
        })?;
        sink(json!({"kind":"instructions"})).await?;
        encode(receipt)
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
