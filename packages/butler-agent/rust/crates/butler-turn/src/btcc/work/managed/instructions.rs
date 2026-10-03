//! Authenticated instruction ingress. Transport identifiers are durable aliases.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstructionMode {
    Queue,
    Steer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionInput {
    pub idempotency_key: String,
    pub mode: InstructionMode,
    pub instruction: InstructionBody,
    pub expected_control_epoch: Option<u64>,
    pub relation_id: Option<String>,
    pub relation_epoch: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InstructionBody {
    Text(InstructionText),
    Operations(InstructionOperations),
    Transfer(ParentTransferInstruction),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParentTransferInstruction {
    pub transfer_parent: ParentTransfer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParentTransfer {
    pub relation_id: String,
    pub expected_relation_epoch: u64,
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionText {
    pub text: String,
    #[serde(default)]
    pub attachment_refs: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionOperations {
    pub operations: Vec<WorkModelCommand>,
    pub expected_graph_revision: u64,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstructionSender {
    User { principal_id: String },
    Parent { session_id: String, turn_id: String },
}

impl WorkModelService {
    pub async fn pending_session_instructions(
        &self,
        session: String,
        after: u64,
    ) -> Result<Vec<Value>, BtccError> {
        self.repository
            .pending_session_instructions(session, after)
            .await
    }
    pub async fn instruction_authority(&self, session: String) -> Result<Value, BtccError> {
        self.repository.instruction_authority(session).await
    }
    pub async fn instruction_body(
        &self,
        session: String,
        key: String,
    ) -> Result<InstructionBody, BtccError> {
        self.repository.instruction_body(session, key).await
    }
    pub async fn pending_instruction_dispatches(
        &self,
        after: u64,
    ) -> Result<Vec<Value>, BtccError> {
        self.repository.pending_instruction_dispatches(after).await
    }
    pub async fn instruction_receipt(
        &self,
        session: String,
        key: String,
    ) -> Result<Value, BtccError> {
        self.repository.instruction_receipt(session, key).await
    }
    pub async fn interrupted_boundary(
        &self,
        session: String,
        turn: String,
    ) -> Result<Value, BtccError> {
        let result = self.repository.interrupted_boundary(session, turn).await?;
        self.changed.notify_one();
        Ok(result)
    }
    pub async fn instruction_dispatch(
        &self,
        session: String,
        key: String,
    ) -> Result<Value, BtccError> {
        self.repository.instruction_dispatch(session, key).await
    }
    pub async fn instruct(
        &self,
        target: String,
        sender: InstructionSender,
        input: InstructionInput,
    ) -> Result<Value, BtccError> {
        let result = self
            .repository
            .instruct(target.clone(), sender, input, None)
            .await?;
        let result = self.apply_idle_control(target, result).await?;
        self.changed.notify_one();
        Ok(result)
    }

    pub async fn instruct_app(
        &self,
        target: String,
        sender: InstructionSender,
        input: InstructionInput,
        anchor: Option<String>,
    ) -> Result<Value, BtccError> {
        let result = self
            .repository
            .instruct(target.clone(), sender, input, anchor)
            .await?;
        let result = self.apply_idle_control(target, result).await?;
        self.changed.notify_one();
        Ok(result)
    }

    pub(crate) async fn apply_idle_control(
        &self,
        target: String,
        receipt: Value,
    ) -> Result<Value, BtccError> {
        if receipt.get("status").unwrap_or(&Value::Null) != "pending_safe_point" {
            return Ok(receipt);
        }
        let key = receipt
            .get("idempotency_key")
            .unwrap_or(&Value::Null)
            .as_str()
            .ok_or_else(|| error("instruction_identity_required"))?
            .to_owned();
        if self
            .repository
            .instruction_dispatch(target.clone(), key.clone())
            .await?
            .get("idle_control")
            .unwrap_or(&Value::Null)
            == true
        {
            self.instruction_safe_point(
                target.clone(),
                format!(
                    "control:{}",
                    receipt
                        .get("instruction_id")
                        .unwrap_or(&Value::Null)
                        .as_str()
                        .ok_or_else(|| error("instruction_integrity_error"))?
                ),
                0,
            )
            .await?;
            return self.repository.instruction_receipt(target, key).await;
        }
        Ok(receipt)
    }

    pub async fn instructions(&self, session: String, after: u64) -> Result<Value, BtccError> {
        self.repository.instructions(session, after).await
    }

    pub async fn instruction_safe_point(
        &self,
        session: String,
        turn: String,
        after: u64,
    ) -> Result<Value, BtccError> {
        let mut verified = std::collections::HashMap::new();
        for (id, batch) in self
            .repository
            .pending_instruction_operations(session.clone())
            .await?
        {
            if batch.operations.iter().any(|op| {
                matches!(
                    op,
                    WorkModelCommand::SessionStop
                        | WorkModelCommand::SessionPause
                        | WorkModelCommand::SessionResume
                )
            }) {
                verified.insert(id, Some("work_model_controls_unavailable".into()));
                continue;
            }
            let result = self
                .repository
                .operation_specs(
                    session.clone(),
                    WorkModelCommand::Batch {
                        operations: batch.operations,
                        expected_control_epoch: 0,
                        reason: batch.reason,
                    },
                )
                .await;
            let checked = match result {
                Ok(refs) => self.verify(&session, &refs).await.map(|_| ()),
                Err(failure) => Err(failure),
            };
            verified.insert(id, checked.err().map(|e| e.code().to_owned()));
        }
        let result = self
            .repository
            .instruction_safe_point(session, turn, after, verified)
            .await?;
        if result.get("changed").unwrap_or(&Value::Null) == true {
            self.changed.notify_one();
        }
        Ok(result)
    }

    pub async fn seal_instructions(
        &self,
        session: String,
        turn: String,
        after: u64,
        final_answer: bool,
    ) -> Result<bool, BtccError> {
        let sealed = self
            .repository
            .seal_instructions(session, turn, after, final_answer)
            .await?;
        if sealed {
            self.changed.notify_one();
        }
        Ok(sealed)
    }
}
