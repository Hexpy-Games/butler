use rusqlite::{OptionalExtension, params};

use super::super::codec::{
    bump_public_revision, enqueue, normalize_limit, origin_text, read_message, source_hash,
    stringify,
};
use super::super::types::*;
use super::super::{AgentConversationStore, ConversationError, ConversationResult};

type CandidateRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
);
type TurnIdentity = (String, Option<String>);
type OutcomeIdentity = (String, f64, Option<String>, Option<String>);

impl AgentConversationStore {
    pub(crate) async fn read_origin_candidates_page(
        &self,
        after_id: Option<String>,
        limit: Option<f64>,
    ) -> ConversationResult<Vec<HistoricalOriginCandidate>> {
        self.execute(move |connection| {
            let limit = normalize_limit(limit, 100, 500);
            let mut statement = connection.prepare(
                "SELECT m.id,m.session_id,m.turn_id,t.request_id,m.source_gateway,\
                 (SELECT b.external_session_id FROM conversation_bindings b WHERE \
                 b.conversation_session_id=m.session_id AND b.gateway=m.source_gateway \
                 ORDER BY b.created_at LIMIT 1),m.source_ref,m.provenance,m.role,m.origin_kind,\
                 m.origin_ref,m.origin_reason,m.origin_version,m.origin_evidence_json,o.id,\
                 o.generation,o.request_message_id,o.public_assistant_message_id \
                 FROM conversation_messages m LEFT JOIN conversation_turns t ON t.id=m.turn_id \
                 AND t.session_id=m.session_id LEFT JOIN conversation_turn_outcomes o ON o.turn_id=t.id \
                 WHERE m.id>COALESCE(?1,'') AND m.visibility='model' AND \
                 ((m.turn_id IS NULL AND m.provenance IN ('recovered','imported') AND \
                 m.status IN ('complete','failed','compacted')) OR \
                 (t.id IS NOT NULL AND m.status IN ('complete','compacted'))) AND \
                 m.role IN ('user','assistant') ORDER BY m.id LIMIT ?2",
            ).map_err(ConversationError::sqlite)?;
            let rows = statement
                .query_map(params![after_id, limit], candidate_row)
                .map_err(ConversationError::sqlite)?;
            let mut output = Vec::new();
            for row in rows {
                let row = row.map_err(ConversationError::sqlite)?;
                let message = read_message(connection, &row.0)?.ok_or_else(|| {
                    ConversationError::new(
                        "conversation_source_changed",
                        "origin candidate disappeared",
                    )
                })?;
                output.push(HistoricalOriginCandidate {
                    message_id: row.0,
                    session_id: row.1,
                    turn_id: row.2,
                    request_id: row.3,
                    source_gateway: row.4,
                    external_session_id: row.5,
                    source_ref: row.6,
                    provenance: parse_provenance(&row.7)?,
                    role: parse_role(&row.8)?,
                    origin_kind: parse_origin(&row.9)?,
                    origin_ref: row.10,
                    origin_reason: row.11,
                    origin_version: row.12,
                    origin_evidence_json: row.13,
                    source_hash: source_hash(&[message])?,
                    outcome_id: row.14,
                    outcome_generation: row.15,
                    outcome_request_message_id: row.16,
                    outcome_public_assistant_message_id: row.17,
                });
            }
            Ok(output)
        })
        .await
    }

    pub(crate) async fn record_origin_classification(
        &self,
        input: RecordOriginClassificationInput,
    ) -> ConversationResult<RecordOriginClassificationResult> {
        let clock = self.identity_clock().clone();
        self.execute(move |connection| {
            let tx = connection
                .transaction()
                .map_err(ConversationError::sqlite)?;
            let Some(message) = read_message(&tx, &input.candidate.message_id)? else {
                return Ok(RecordOriginClassificationResult::SourceChanged);
            };
            if !matches!(
                message.message.role,
                ConversationRole::User | ConversationRole::Assistant
            ) {
                return Ok(RecordOriginClassificationResult::SourceChanged);
            }
            let turn = read_turn_identity(
                &tx,
                message.message.turn_id.as_deref(),
                &message.message.session_id,
            )?;
            if message.message.turn_id.is_some() && turn.is_none() {
                return Ok(RecordOriginClassificationResult::SourceChanged);
            }
            let outcome = read_outcome_identity(&tx, turn.as_ref().map(|value| value.0.as_str()))?;
            let binding = read_external_binding(
                &tx,
                &message.message.session_id,
                message.message.source_gateway.as_deref().unwrap_or(""),
            )?;
            let current = HistoricalOriginCandidate {
                message_id: message.message.id.clone(),
                session_id: message.message.session_id.clone(),
                turn_id: turn.as_ref().map(|value| value.0.clone()),
                request_id: turn.as_ref().and_then(|value| value.1.clone()),
                source_gateway: message.message.source_gateway.clone(),
                external_session_id: binding,
                source_ref: message.message.source_ref.clone(),
                provenance: message.message.provenance,
                role: message.message.role,
                origin_kind: message.message.origin_kind,
                origin_ref: message.message.origin_ref.clone(),
                origin_reason: message.message.origin_reason.clone(),
                origin_version: message.message.origin_version.clone(),
                origin_evidence_json: message.message.origin_evidence_json.clone(),
                source_hash: source_hash(std::slice::from_ref(&message))?,
                outcome_id: outcome.as_ref().map(|value| value.0.clone()),
                outcome_generation: outcome.as_ref().map(|value| value.1),
                outcome_request_message_id: outcome.as_ref().and_then(|value| value.2.clone()),
                outcome_public_assistant_message_id: outcome
                    .as_ref()
                    .and_then(|value| value.3.clone()),
            };
            if current != input.candidate {
                return Ok(RecordOriginClassificationResult::SourceChanged);
            }
            let evidence = stringify(
                &serde_json::to_value(&input.decision.evidence).map_err(ConversationError::json)?,
            )?;
            if current.origin_version.is_some() {
                if classification_matches(&current, &input.decision, &evidence) {
                    return Ok(RecordOriginClassificationResult::Unchanged);
                }
                if !allowed_internal_correction(&input) {
                    return Ok(RecordOriginClassificationResult::ClassificationConflict);
                }
            }
            tx.execute(
                "UPDATE conversation_messages SET origin_kind=?1,origin_ref=?2,origin_reason=?3,\
                 origin_version=?4,origin_evidence_json=?5 WHERE id=?6",
                params![
                    origin_text(input.decision.kind),
                    input.decision.reference,
                    input.decision.reason,
                    input.decision.version,
                    evidence,
                    input.candidate.message_id
                ],
            )
            .map_err(ConversationError::sqlite)?;
            bump_public_revision(&tx)?;
            enqueue(
                &tx,
                clock.as_ref(),
                &current.session_id,
                message.message.seq as f64,
                "conversation.message_committed",
                &current.message_id,
                &clock.now_iso(),
            )?;
            tx.commit().map_err(ConversationError::sqlite)?;
            Ok(RecordOriginClassificationResult::Applied)
        })
        .await
    }
}

fn candidate_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CandidateRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
        row.get(16)?,
        row.get(17)?,
    ))
}

fn read_turn_identity(
    connection: &rusqlite::Connection,
    turn_id: Option<&str>,
    session_id: &str,
) -> ConversationResult<Option<TurnIdentity>> {
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT id,request_id FROM conversation_turns WHERE id=?1 AND session_id=?2",
            params![turn_id, session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(ConversationError::sqlite)
}

fn read_outcome_identity(
    connection: &rusqlite::Connection,
    turn_id: Option<&str>,
) -> ConversationResult<Option<OutcomeIdentity>> {
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT id,generation,request_message_id,public_assistant_message_id \
             FROM conversation_turn_outcomes WHERE turn_id=?1",
            [turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(ConversationError::sqlite)
}

fn read_external_binding(
    connection: &rusqlite::Connection,
    session_id: &str,
    gateway: &str,
) -> ConversationResult<Option<String>> {
    connection
        .query_row(
            "SELECT external_session_id FROM conversation_bindings \
             WHERE conversation_session_id=?1 AND gateway=?2 ORDER BY created_at LIMIT 1",
            params![session_id, gateway],
            |row| row.get(0),
        )
        .optional()
        .map_err(ConversationError::sqlite)
}

fn classification_matches(
    current: &HistoricalOriginCandidate,
    decision: &ConversationOriginDecision,
    evidence: &str,
) -> bool {
    current.origin_kind == decision.kind
        && current.origin_ref == decision.reference
        && current.origin_reason.as_deref() == Some(&decision.reason)
        && current.origin_version.as_deref() == Some(&decision.version)
        && current.origin_evidence_json.as_deref() == Some(evidence)
}

fn allowed_internal_correction(input: &RecordOriginClassificationInput) -> bool {
    input.correct_internal_origin
        && input.decision.complete
        && input.decision.kind == ConversationOriginKind::InternalControl
        && input
            .decision
            .evidence
            .iter()
            .any(|item| item.kind == "subsession" && item.sha256.is_some())
}

fn parse_role(value: &str) -> ConversationResult<ConversationRole> {
    match value {
        "user" => Ok(ConversationRole::User),
        "assistant" => Ok(ConversationRole::Assistant),
        _ => Err(ConversationError::new(
            "conversation_role_invalid",
            format!("invalid role {value}"),
        )),
    }
}

fn parse_provenance(value: &str) -> ConversationResult<ConversationProvenance> {
    match value {
        "trusted" => Ok(ConversationProvenance::Trusted),
        "recovered" => Ok(ConversationProvenance::Recovered),
        "imported" => Ok(ConversationProvenance::Imported),
        "synthetic_summary" => Ok(ConversationProvenance::SyntheticSummary),
        _ => Err(ConversationError::new(
            "conversation_provenance_invalid",
            format!("invalid provenance {value}"),
        )),
    }
}

fn parse_origin(value: &str) -> ConversationResult<ConversationOriginKind> {
    match value {
        "user_input" => Ok(ConversationOriginKind::UserInput),
        "assistant_public" => Ok(ConversationOriginKind::AssistantPublic),
        "internal_control" => Ok(ConversationOriginKind::InternalControl),
        "unknown" => Ok(ConversationOriginKind::Unknown),
        _ => Err(ConversationError::new(
            "conversation_origin_invalid",
            format!("invalid origin {value}"),
        )),
    }
}
