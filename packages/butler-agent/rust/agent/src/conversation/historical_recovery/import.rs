use rusqlite::{Connection, OptionalExtension, params};

use super::super::{
    AppendMessageInput, BeginTurnInput, ConversationError, ConversationIdentityClock,
    ConversationMessageWithParts, ConversationOriginKind, ConversationProvenance,
    ConversationResult, ConversationSourceReader, ConversationStatus, ConversationVisibility,
    FinalizeTurnInput,
};
use super::classifier::{Decision, Provenance, SourceKind};
use super::identity::{recovered_id, recovery_source_ref, target_message_id, target_session};

#[derive(Clone)]
pub(super) struct Mapping {
    pub(super) kind: SourceKind,
    pub(super) source_id: String,
    pub(super) session_id: String,
    pub(super) message_id: String,
    pub(super) status: &'static str,
}

#[derive(Default)]
pub(super) struct Outcome {
    pub(super) mapping: Option<Mapping>,
    pub(super) imported: bool,
    pub(super) skipped_existing: bool,
}

pub(super) fn planned_outcome(
    reader: Option<&ConversationSourceReader>,
    decision: &Decision,
) -> ConversationResult<Outcome> {
    let Some(reader) = reader else {
        return Ok(planned_mapping(decision, None, None));
    };
    let source_ref = recovery_source_ref(decision);
    let target_session = target_session(decision);
    let by_source = match reader.read_message_by_source_ref(&target_session, &source_ref)? {
        Some(message) => Some(message),
        None => reader.read_message_by_source_ref_any_session(&source_ref)?,
    };
    let by_id = decision
        .conversation_message_id
        .as_deref()
        .map(|id| reader.read_message(id))
        .transpose()?
        .flatten();
    Ok(planned_mapping(
        decision,
        by_source.as_ref(),
        by_id.as_ref(),
    ))
}

pub(super) fn planned_outcome_connection(
    connection: &Connection,
    decision: &Decision,
) -> ConversationResult<Outcome> {
    let source_ref = recovery_source_ref(decision);
    let by_source = match read_by_source_ref(connection, &target_session(decision), &source_ref)? {
        Some(message) => Some(message),
        None => read_by_source_ref_any_session(connection, &source_ref)?,
    };
    let by_id = decision
        .conversation_message_id
        .as_deref()
        .map(|id| super::super::codec::read_message(connection, id))
        .transpose()?
        .flatten();
    Ok(planned_mapping(
        decision,
        by_source.as_ref(),
        by_id.as_ref(),
    ))
}

fn planned_mapping(
    decision: &Decision,
    by_source: Option<&ConversationMessageWithParts>,
    by_id: Option<&ConversationMessageWithParts>,
) -> Outcome {
    if !decision.admit {
        return Outcome::default();
    }
    let existing = by_source.as_ref().or(by_id.as_ref());
    Outcome {
        mapping: Some(Mapping {
            kind: decision.kind,
            source_id: decision.source_id.clone(),
            session_id: existing.map_or_else(
                || target_session(decision),
                |row| row.message.session_id.clone(),
            ),
            message_id: existing
                .map_or_else(|| target_message_id(decision), |row| row.message.id.clone()),
            status: if existing.is_some() {
                "existing"
            } else {
                "planned"
            },
        }),
        imported: false,
        skipped_existing: existing.is_some(),
    }
}

pub(super) fn import_one(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    decision: &Decision,
) -> ConversationResult<Outcome> {
    if !decision.admit {
        return Ok(Outcome::default());
    }
    let source_ref = recovery_source_ref(decision);
    let session_id = target_session(decision);
    let transaction = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    let by_source = match read_by_source_ref(&transaction, &session_id, &source_ref)? {
        Some(message) => Some(message),
        None => read_by_source_ref_any_session(&transaction, &source_ref)?,
    };
    let by_id = decision
        .conversation_message_id
        .as_deref()
        .map(|id| super::super::codec::read_message(&transaction, id))
        .transpose()?
        .flatten();
    if by_source.is_some() || by_id.is_some() {
        let outcome = planned_mapping(decision, by_source.as_ref(), by_id.as_ref());
        transaction.commit().map_err(ConversationError::sqlite)?;
        return Ok(outcome);
    }
    // Only admissible decisions reach import; they carry role, time and text.
    let (Some(role), Some(now), Some(text)) = (
        decision.role,
        decision.created_at.clone(),
        decision.text.clone(),
    ) else {
        return Err(ConversationError::new(
            "conversation_recovery_input_unavailable",
            "Recovery decision is not admissible",
        ));
    };
    let message_id = target_message_id(decision);
    let turn_id = decision
        .conversation_turn_id
        .clone()
        .unwrap_or_else(|| recovered_id("ct", &source_ref));
    let gateway = "historical-recovery".to_owned();
    super::super::turns::begin_in_transaction(
        &transaction,
        clock,
        BeginTurnInput {
            gateway: gateway.clone(),
            external_session_id: decision.session_id.clone(),
            session_id: Some(session_id.clone()),
            workspace_id: None,
            project_id: None,
            actor: role.text().into(),
            request_id: Some(source_ref.clone()),
            turn_id: Some(turn_id.clone()),
            now: Some(now.clone()),
        },
        &session_id.clone(),
        turn_id.clone(),
        &now.clone(),
    )?;
    super::super::messages::append_in_transaction(
        &transaction,
        clock,
        AppendMessageInput {
            session_id: session_id.clone(),
            turn_id: Some(turn_id.clone()),
            text,
            message_id: Some(message_id.clone()),
            role: role.conversation(),
            status: Some(ConversationStatus::Complete),
            visibility: Some(ConversationVisibility::Model),
            provenance: Some(match decision.provenance {
                Provenance::Trusted => ConversationProvenance::Trusted,
                _ => ConversationProvenance::Recovered,
            }),
            source_gateway: Some(
                match decision.kind {
                    SourceKind::Transcript => "transcript-recovery",
                    SourceKind::AppProjection => "app-projection-recovery",
                }
                .into(),
            ),
            source_ref: Some(source_ref),
            origin_kind: Some(ConversationOriginKind::Unknown),
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence: None,
            now: Some(now.clone()),
            parts: None,
        },
        &now.clone(),
    )?;
    super::super::turns::finalize_in_transaction(
        &transaction,
        clock,
        FinalizeTurnInput {
            turn_id,
            status: Some("complete".into()),
            completed_at: Some(now.clone()),
            outcome_capsule: None,
        },
        &now,
    )?;
    transaction.commit().map_err(ConversationError::sqlite)?;
    Ok(Outcome {
        mapping: Some(Mapping {
            kind: decision.kind,
            source_id: decision.source_id.clone(),
            session_id,
            message_id,
            status: "imported",
        }),
        imported: true,
        skipped_existing: false,
    })
}

fn read_by_source_ref(
    connection: &Connection,
    session_id: &str,
    source_ref: &str,
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let id = connection
        .query_row("SELECT id FROM conversation_messages WHERE session_id=?1 AND source_ref=?2 ORDER BY seq ASC LIMIT 1", params![session_id,source_ref], |row| row.get::<_,String>(0))
        .optional().map_err(ConversationError::sqlite)?;
    id.map(|id| super::super::codec::read_message(connection, &id))
        .transpose()
        .map(Option::flatten)
}

fn read_by_source_ref_any_session(
    connection: &Connection,
    source_ref: &str,
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let id = connection
        .query_row("SELECT id FROM conversation_messages WHERE source_ref=?1 ORDER BY created_at ASC,session_id ASC,seq ASC LIMIT 1", [source_ref], |row| row.get::<_,String>(0))
        .optional().map_err(ConversationError::sqlite)?;
    id.map(|id| super::super::codec::read_message(connection, &id))
        .transpose()
        .map(Option::flatten)
}
