//! All managed parent ingress uses the same instruction owner, at every depth.
use super::*;
use crate::btcc::StoredSubsessionDelegation;
use crate::btcc::work_model::{InstructionInput, InstructionSender};

impl SubsessionService {
    pub async fn wake_session_instructions(&self, target: &str) -> Result<(), BtccError> {
        let Some(model) = self.work.work_model() else {
            return Ok(());
        };
        let mut after = 0;
        loop {
            let page = model
                .pending_session_instructions(target.into(), after)
                .await?;
            if page.is_empty() {
                return Ok(());
            }
            for receipt in page {
                after = receipt
                    .get("received_seq")
                    .unwrap_or(&Value::Null)
                    .as_u64()
                    .ok_or_else(|| crate::btcc::work_model::error("instruction_integrity_error"))?;
                self.wake_instruction(target, &receipt).await?;
            }
        }
    }
    pub(super) async fn managed_direction(
        &self,
        request: &SubsessionDirectionRequest,
        relation: &StoredSubsessionDelegation,
        instruction: &str,
    ) -> Result<Value, BtccError> {
        let authority = self
            .work
            .work_model()
            .ok_or_else(|| crate::btcc::work_model::error("work_model_disabled"))?
            .instruction_authority(relation.child_session_id.clone())
            .await?;
        self.session_control(
            request.parent_session_id.clone(),
            request.parent_turn_id.clone(),
            relation.child_session_id.clone(),
            crate::btcc::work_model::InstructionInput {
                idempotency_key: request.source_message_id.clone(),
                mode: crate::btcc::work_model::InstructionMode::Steer,
                instruction: crate::btcc::work_model::InstructionBody::Text(
                    crate::btcc::work_model::InstructionText {
                        text: instruction.into(),
                        attachment_refs: vec![],
                    },
                ),
                expected_control_epoch: authority
                    .get("control_epoch")
                    .unwrap_or(&Value::Null)
                    .as_u64(),
                relation_id: Some(relation.relation_id.clone()),
                relation_epoch: authority
                    .get("relation_epoch")
                    .unwrap_or(&Value::Null)
                    .as_u64(),
            },
        )
        .await
    }

    pub(super) async fn managed_lifecycle(
        &self,
        relation: &StoredSubsessionDelegation,
        parent: &str,
        turn: &str,
        key: &str,
        operation: crate::btcc::work_model::WorkModelCommand,
    ) -> Result<Value, BtccError> {
        let model = self
            .work
            .work_model()
            .ok_or_else(|| crate::btcc::work_model::error("work_model_disabled"))?;
        let authority = model
            .instruction_authority(relation.child_session_id.clone())
            .await?;
        let summary = model
            .summary(relation.child_session_id.clone(), None)
            .await?;
        self.session_control(
            parent.into(),
            turn.into(),
            relation.child_session_id.clone(),
            InstructionInput {
                idempotency_key: key.into(),
                mode: crate::btcc::work_model::InstructionMode::Steer,
                expected_control_epoch: authority
                    .get("control_epoch")
                    .unwrap_or(&Value::Null)
                    .as_u64(),
                relation_id: Some(relation.relation_id.clone()),
                relation_epoch: authority
                    .get("relation_epoch")
                    .unwrap_or(&Value::Null)
                    .as_u64(),
                instruction: crate::btcc::work_model::InstructionBody::Operations(
                    crate::btcc::work_model::InstructionOperations {
                        operations: vec![operation],
                        expected_graph_revision: summary
                            .get("graph_revision")
                            .unwrap_or(&Value::Null)
                            .as_u64()
                            .unwrap_or_default(),
                        reason: "Explicit parent session control".into(),
                    },
                ),
            },
        )
        .await
    }

    pub async fn session_control(
        &self,
        parent: String,
        turn: String,
        target: String,
        input: InstructionInput,
    ) -> Result<Value, BtccError> {
        let model = self
            .work
            .work_model()
            .ok_or_else(|| BtccError::relayed("work_model_disabled", "work_model_disabled"))?;
        let receipt = model
            .instruct(
                target.clone(),
                InstructionSender::Parent {
                    session_id: parent,
                    turn_id: turn,
                },
                input,
            )
            .await?;
        self.wake_instruction(&target, &receipt).await?;
        Ok(receipt)
    }

    pub async fn wake_instruction(&self, target: &str, receipt: &Value) -> Result<(), BtccError> {
        if receipt.get("status").unwrap_or(&Value::Null) != "pending_safe_point" {
            return Ok(());
        }
        let model = self
            .work
            .work_model()
            .ok_or_else(|| BtccError::relayed("work_model_disabled", "work_model_disabled"))?;
        let gate = model
            .instruction_dispatch(
                target.into(),
                receipt
                    .get("idempotency_key")
                    .unwrap_or(&Value::Null)
                    .as_str()
                    .unwrap_or_default()
                    .into(),
            )
            .await?;
        if gate.get("dispatch").unwrap_or(&Value::Null) != true {
            return Ok(());
        }
        if gate.get("idle_control").unwrap_or(&Value::Null) == true {
            model
                .apply_idle_control(target.into(), receipt.clone())
                .await?;
            return Ok(());
        }
        let child = self
            .bindings
            .get_by_session_id(target)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionDirectionChildBindingMissing))?;
        if !matches!(child.role, SessionRole::Steward | SessionRole::Worker) {
            return Ok(());
        }
        let id = receipt
            .get("instruction_id")
            .unwrap_or(&Value::Null)
            .as_str()
            .ok_or_else(|| {
                BtccError::relayed("instruction_integrity_error", "instruction_integrity_error")
            })?;
        let key = receipt
            .get("idempotency_key")
            .unwrap_or(&Value::Null)
            .as_str()
            .ok_or_else(|| crate::btcc::work_model::error("instruction_identity_required"))?;
        let body = model.instruction_body(target.into(), key.into()).await?;
        let text = match body {
            crate::btcc::work_model::InstructionBody::Text(body) => body.text,
            _ => "Apply the durable typed instruction to the retained canonical state.".into(),
        };
        self.queue.enqueue(super::SubsessionEnqueue {
            envelope:json!({"eventId":format!("instruction:{id}"),"transport":"app","accountId":"local",
                "peer":{"kind":"dm","id":target},"sender":{"id":"subsession-parent-instruction","displayName":"Parent"},
                "message":{"id":format!("instruction-message:{id}"),"text":text,"timestamp":(self.now)()},
                "routingHints":{"sessionId":target,"turnId":format!("instruction-turn:{id}")},
                "nativeStewardContext":{"version":1,"role":if child.role==SessionRole::Worker{"worker"}else{"steward"},"projectName":child.project_id.unwrap_or_default(),"workspacePath":child.workspace_path,"modelRef":child.model_ref,"reasoningEffort":child.metadata.as_ref().and_then(|v|v.get("reasoning_effort")).and_then(Value::as_str).unwrap_or("")},
                "raw":{"source":"btcc-session-instruction","instruction_id":id}}),
            metadata: Map::new(),
        })
    }

    pub async fn recover_instruction_dispatches(&self) -> Result<(), BtccError> {
        let Some(model) = self.work.work_model() else {
            return Ok(());
        };
        let mut after = 0;
        loop {
            let page = model.pending_instruction_dispatches(after).await?;
            if page.is_empty() {
                return Ok(());
            }
            for receipt in page {
                after = receipt
                    .get("received_seq")
                    .unwrap_or(&Value::Null)
                    .as_u64()
                    .ok_or_else(|| crate::btcc::work_model::error("instruction_integrity_error"))?;
                self.wake_instruction(
                    receipt
                        .get("target_session_id")
                        .unwrap_or(&Value::Null)
                        .as_str()
                        .unwrap_or_default(),
                    &receipt,
                )
                .await?;
            }
        }
    }
}
