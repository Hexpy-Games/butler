//! A computer's finished canonical turn and its source change watermark.
use super::{messages, turns, *};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Serialize, Deserialize)]
pub struct TransferMark {
    pub identity: Option<String>,
    pub seq: u64,
    pub key: String,
}

#[derive(Serialize, Deserialize)]
pub struct TransferTurn {
    pub session_id: String,
    pub external_session_id: String,
    pub turn: TransferTurnRow,
    pub messages: Vec<TransferMessage>,
    pub outcome: TransferOutcome,
}

#[derive(Serialize, Deserialize)]
pub struct TransferTurnRow {
    pub id: String,
    pub actor: String,
    pub status: String,
    pub request_id: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TransferMessage {
    pub id: String,
    pub role: ConversationRole,
    pub status: ConversationStatus,
    pub visibility: ConversationVisibility,
    pub provenance: ConversationProvenance,
    pub source_gateway: Option<String>,
    pub source_ref: Option<String>,
    pub origin_kind: ConversationOriginKind,
    pub origin_ref: Option<String>,
    pub origin_reason: Option<String>,
    pub origin_version: Option<String>,
    pub origin_evidence: Option<Vec<ConversationOriginEvidence>>,
    pub created_at: String,
    pub parts: Vec<TransferPart>,
}

#[derive(Serialize, Deserialize)]
pub struct TransferPart {
    pub kind: ConversationPartKind,
    pub content_json: Value,
    pub tool_call_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: Option<ConversationStatus>,
}

#[derive(Serialize, Deserialize)]
pub struct TransferOutcome {
    pub id: String,
    pub generation: f64,
    pub outcome: TurnOutcomeKind,
    pub request_message_id: Option<String>,
    pub public_assistant_message_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub unresolved_obligations: Vec<String>,
    pub continuation: Option<Map<String, Value>>,
    pub safe_code: Option<String>,
    pub created_at: String,
}

impl TransferTurn {
    fn validate(&self) -> ConversationResult<()> {
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_:.-".contains(&b))
        };
        let references = [
            &self.outcome.request_message_id,
            &self.outcome.public_assistant_message_id,
        ];
        if valid_id(&self.session_id)
            && valid_id(&self.turn.id)
            && valid_id(&self.outcome.id)
            && !self.external_session_id.is_empty()
            && self.external_session_id.len() <= 256
            && matches!(self.turn.status.as_str(), "complete" | "aborted" | "failed")
            && self
                .messages
                .iter()
                .all(|m| valid_id(&m.id) && !m.parts.is_empty())
            && references
                .into_iter()
                .flatten()
                .all(|id| self.messages.iter().any(|m| &m.id == id))
        {
            Ok(())
        } else {
            Err(ConversationError::new(
                ConversationCode::ConversationRecoveryInputUnavailable,
                "transfer_invalid",
            ))
        }
    }
}

impl AgentConversationStore {
    /// Commit a computer turn once, preserving its binding and canonical identities.
    pub async fn import_transfer_turn(
        &self,
        computer_id: String,
        turn: TransferTurn,
    ) -> ConversationResult<bool> {
        let clock = self.identity_clock().clone();
        self.execute(move |db| {
            turn.validate()?;
            let gateway = format!("computer:{computer_id}");
            let tx = db.transaction().map_err(ConversationError::sqlite)?;
            let origin: Option<String> = tx
                .query_row(
                    "SELECT gateway_origin FROM conversation_sessions WHERE id=?1",
                    [&turn.session_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(ConversationError::sqlite)?;
            let foreign = || {
                ConversationError::new(
                    ConversationCode::ConversationRecoveryInputUnavailable,
                    "transfer_session_foreign",
                )
            };
            if origin.is_some_and(|origin| origin != gateway) {
                return Err(foreign());
            }
            if let Some(existing) = turns::get_turn(&tx, &turn.turn.id)? {
                return if existing.session_id == turn.session_id {
                    Ok(false)
                } else {
                    Err(foreign())
                };
            }
            let row = turn.turn;
            turns::begin_in_transaction(
                &tx,
                clock.as_ref(),
                BeginTurnInput {
                    gateway,
                    external_session_id: turn.external_session_id,
                    session_id: Some(turn.session_id.clone()),
                    workspace_id: None,
                    project_id: None,
                    actor: row.actor,
                    request_id: row.request_id,
                    turn_id: Some(row.id.clone()),
                    now: None,
                },
                &turn.session_id,
                row.id.clone(),
                &row.started_at,
            )?;
            for message in turn.messages {
                let created_at = message.created_at.clone();
                messages::append_in_transaction(
                    &tx,
                    clock.as_ref(),
                    message.into_input(&turn.session_id, &row.id),
                    &created_at,
                )?;
            }
            let outcome = turn.outcome.into_input(turn.session_id, row.id.clone());
            let completed = row.completed_at.as_ref().unwrap_or(&row.started_at);
            turns::finalize_in_transaction(
                &tx,
                clock.as_ref(),
                FinalizeTurnInput {
                    turn_id: row.id,
                    status: Some(row.status),
                    completed_at: row.completed_at.clone(),
                    outcome_capsule: Some(outcome),
                },
                completed,
            )?;
            tx.commit().map_err(ConversationError::sqlite)?;
            Ok(true)
        })
        .await
    }
}

impl TransferMessage {
    fn into_input(self, session_id: &str, turn_id: &str) -> AppendMessageInput {
        AppendMessageInput {
            session_id: session_id.to_owned(),
            turn_id: Some(turn_id.to_owned()),
            message_id: Some(self.id),
            text: String::new(),
            role: self.role,
            status: Some(self.status),
            visibility: Some(self.visibility),
            provenance: Some(self.provenance),
            source_gateway: self.source_gateway,
            source_ref: self.source_ref,
            origin_kind: Some(self.origin_kind),
            origin_ref: self.origin_ref,
            origin_reason: self.origin_reason,
            origin_version: self.origin_version,
            origin_evidence: self.origin_evidence,
            now: None,
            parts: Some(
                self.parts
                    .into_iter()
                    .map(|p| MessagePartInput {
                        kind: p.kind,
                        content_json: p.content_json,
                        tool_call_id: p.tool_call_id,
                        parent_tool_call_id: p.parent_tool_call_id,
                        provider_shape: p.provider_shape,
                        status: p.status,
                    })
                    .collect(),
            ),
        }
    }
}

impl TransferOutcome {
    fn into_input(self, session_id: String, turn_id: String) -> TurnOutcomeCapsuleInput {
        TurnOutcomeCapsuleInput {
            id: Some(self.id),
            session_id,
            turn_id,
            generation: self.generation,
            outcome: self.outcome,
            request_message_id: self.request_message_id,
            public_assistant_message_id: self.public_assistant_message_id,
            provider_id: self.provider_id,
            model_ref: self.model_ref,
            evidence_refs: self.evidence_refs,
            unresolved_obligations: self.unresolved_obligations,
            continuation: self.continuation,
            safe_code: self.safe_code,
            created_at: Some(self.created_at),
        }
    }
}
