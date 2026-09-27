use butler_turn::conversation::{
    ConversationMessageWithParts, ConversationOriginKind, ConversationProvenance, ConversationRole,
    ConversationSourceReader, ConversationStatus, decode_message_scalars,
};

use super::identity::{RevisionTail, episode_revision, projection_hash, recovered_parts_hash};
use super::types::{
    CognitionSourceError, CognitionSourcePlan, CognitionSourceRow, ConversationSourceNotice,
    PreparedConversationSource,
};
use crate::cognition::CognitionCode;
use crate::cognition::{MEMORY_SOURCE_WINDOW_BYTES, split_historical_source_spans};

/// Prepares the registration plan of a conversation source.
pub fn prepare_conversation_source(
    reader: &ConversationSourceReader,
    notice: ConversationSourceNotice<'_>,
    now: &str,
) -> Result<PreparedConversationSource, CognitionSourceError> {
    match notice {
        ConversationSourceNotice::Turn {
            session_id,
            turn_id,
            outcome_generation,
            extraction_version,
        } => turn(
            reader,
            session_id,
            turn_id,
            outcome_generation,
            extraction_version,
            now,
        ),
        ConversationSourceNotice::Standalone {
            session_id,
            message_id,
            source_hash,
            extraction_version,
        } => standalone(
            reader,
            session_id,
            message_id,
            source_hash,
            extraction_version,
            now,
        ),
    }
}

pub(in crate::cognition) fn assert_conversation_source_current(
    reader: &ConversationSourceReader,
    notice: ConversationSourceNotice<'_>,
    expected_revision: &str,
    now: &str,
) -> Result<(), CognitionSourceError> {
    match prepare_conversation_source(reader, notice, now) {
        Ok(PreparedConversationSource::Plan(plan)) if plan.revision == expected_revision => Ok(()),
        Ok(_) => Err(error(CognitionCode::MemorySourceChanged)),
        Err(error)
            if matches!(
                error.code(),
                "memory_source_not_terminal"
                    | "memory_source_ineligible"
                    | "memory_source_text_missing"
            ) =>
        {
            Err(crate::cognition::CognitionError::new(
                CognitionCode::MemorySourceChanged,
                "memory_source_changed",
            ))
        }
        Err(error) => Err(error),
    }
}

fn turn(
    reader: &ConversationSourceReader,
    session_id: &str,
    turn_id: &str,
    outcome_generation: f64,
    extraction_version: &str,
    now: &str,
) -> Result<PreparedConversationSource, CognitionSourceError> {
    let turn = reader.read_turn(turn_id)?;
    let outcome = reader.read_turn_outcome(turn_id)?;
    let (Some(turn), Some(outcome)) = (turn, outcome) else {
        return Err(error(CognitionCode::MemorySourceNotTerminal));
    };
    if turn.session_id != session_id
        || outcome.generation != outcome_generation
        || !matches!(turn.status.as_str(), "complete" | "failed" | "aborted")
    {
        return Err(error(CognitionCode::MemorySourceNotTerminal));
    }
    let request = outcome
        .request_message_id
        .as_deref()
        .map(|id| reader.read_message(id))
        .transpose()?
        .flatten();
    if request.as_ref().is_some_and(|message| {
        message.message.origin_kind == ConversationOriginKind::InternalControl
    }) {
        return Ok(PreparedConversationSource::SupersedeInternalControl {
            turn_id: turn_id.to_owned(),
        });
    }
    let messages = eligible_turn_messages(
        reader,
        request,
        outcome.public_assistant_message_id.as_ref(),
    )?;
    let episode_id = projection_hash(&("canonical-conversation-turn", turn_id))?;
    plan(PlanInput {
        messages,
        source_key: format!("conversation_turn:{turn_id}"),
        episode_id,
        revision_tail: RevisionTail::Generation(outcome.generation),
        extraction_version,
        turn_id: Some(turn_id.to_owned()),
        turn_started_at: Some(turn.started_at),
        turn_completed_at: turn.completed_at,
        now,
    })
    .map(Box::new)
    .map(PreparedConversationSource::Plan)
}

fn standalone(
    reader: &ConversationSourceReader,
    session_id: &str,
    message_id: &str,
    source_hash: &str,
    extraction_version: &str,
    now: &str,
) -> Result<PreparedConversationSource, CognitionSourceError> {
    let Some(message) = reader.read_message(message_id)? else {
        return Err(error(CognitionCode::MemorySourceNotTerminal));
    };
    if message.message.session_id != session_id
        || message.message.turn_id.is_some()
        || !eligible_standalone(&message)
    {
        return Err(error(CognitionCode::MemorySourceNotTerminal));
    }
    let actual_hash = recovered_parts_hash(&message)?;
    if actual_hash != source_hash {
        return Err(error(CognitionCode::MemorySourceChanged));
    }
    let episode_id = projection_hash(&("canonical-conversation-message", message_id))?;
    plan(PlanInput {
        messages: vec![message],
        source_key: format!("conversation_message:{message_id}"),
        episode_id,
        revision_tail: RevisionTail::SourceHash(source_hash.to_owned()),
        extraction_version,
        turn_id: None,
        turn_started_at: None,
        turn_completed_at: None,
        now,
    })
    .map(Box::new)
    .map(PreparedConversationSource::Plan)
}

fn eligible_turn_messages(
    reader: &ConversationSourceReader,
    request: Option<ConversationMessageWithParts>,
    assistant_id: Option<&String>,
) -> Result<Vec<ConversationMessageWithParts>, CognitionSourceError> {
    let Some(request) = request else {
        return Err(error(CognitionCode::MemorySourceIneligible));
    };
    if request.message.role != ConversationRole::User
        || !matches!(
            request.message.status,
            ConversationStatus::Complete | ConversationStatus::Compacted
        )
        || request.message.origin_kind != ConversationOriginKind::UserInput
    {
        return Err(error(CognitionCode::MemorySourceIneligible));
    }
    let assistant = assistant_id
        .map(|id| reader.read_message(id))
        .transpose()?
        .flatten();
    if assistant_id.is_some()
        && !assistant.as_ref().is_some_and(|message| {
            message.message.role == ConversationRole::Assistant
                && message.message.status == ConversationStatus::Complete
                && message.message.origin_kind == ConversationOriginKind::AssistantPublic
        })
    {
        return Err(error(CognitionCode::MemorySourceIneligible));
    }
    Ok(match assistant {
        Some(value) => vec![request, value],
        None => vec![request],
    })
}

fn eligible_standalone(message: &ConversationMessageWithParts) -> bool {
    match message.message.role {
        ConversationRole::Assistant => {
            message.message.provenance == ConversationProvenance::Recovered
                && message.message.origin_kind == ConversationOriginKind::AssistantPublic
                && message.message.status == ConversationStatus::Complete
        }
        ConversationRole::User => {
            message.message.origin_kind == ConversationOriginKind::UserInput
                && matches!(
                    message.message.provenance,
                    ConversationProvenance::Recovered | ConversationProvenance::Imported
                )
                && matches!(
                    message.message.status,
                    ConversationStatus::Complete
                        | ConversationStatus::Failed
                        | ConversationStatus::Compacted
                )
        }
        _ => false,
    }
}

struct PlanInput<'a> {
    messages: Vec<ConversationMessageWithParts>,
    source_key: String,
    episode_id: String,
    revision_tail: RevisionTail,
    extraction_version: &'a str,
    turn_id: Option<String>,
    turn_started_at: Option<String>,
    turn_completed_at: Option<String>,
    now: &'a str,
}

fn plan(input: PlanInput<'_>) -> Result<CognitionSourcePlan, CognitionSourceError> {
    let PlanInput {
        messages,
        source_key,
        episode_id,
        revision_tail,
        extraction_version,
        turn_id,
        turn_started_at,
        turn_completed_at,
        now,
    } = input;
    let conversation_start = messages
        .first()
        .map(|message| message.message.created_at.clone())
        .or(turn_started_at)
        .unwrap_or_else(|| now.to_owned());
    let conversation_end = messages
        .last()
        .map(|message| message.message.created_at.clone())
        .or(turn_completed_at)
        .unwrap_or_else(|| conversation_start.clone());
    let scalars = messages
        .iter()
        .flat_map(decode_message_scalars)
        .collect::<Vec<_>>();
    let revision = episode_revision(&scalars, &revision_tail)?;
    let job_id = projection_hash(&(
        "memory-projection",
        &episode_id,
        &revision,
        extraction_version,
    ))?;
    let rows = source_rows(scalars, &episode_id, &revision)?;
    if rows.is_empty() {
        return Err(error(CognitionCode::MemorySourceTextMissing));
    }
    let windows = rows.iter().map(|row| vec![row.source_id.clone()]).collect();
    let source_hash = revision.clone();
    Ok(CognitionSourcePlan {
        source_key,
        episode_id,
        revision,
        job_id,
        extraction_version: extraction_version.into(),
        session_id: messages
            .first()
            .map(|message| message.message.session_id.clone())
            .unwrap_or_default(),
        turn_id,
        conversation_start,
        conversation_end,
        source_hash,
        origin_kind: combined_origin(&messages).into(),
        rows,
        windows,
    })
}

/// One source row per scalar span of at most the source window size.
fn source_rows(
    scalars: Vec<butler_turn::conversation::ConversationScalar<'_>>,
    episode_id: &str,
    revision: &str,
) -> Result<Vec<CognitionSourceRow>, CognitionSourceError> {
    let mut rows = Vec::new();
    for scalar in scalars {
        for span in split_historical_source_spans(scalar.text, MEMORY_SOURCE_WINDOW_BYTES) {
            let source_id = projection_hash(&(
                "memory-source",
                episode_id,
                revision,
                "conversation",
                &scalar.message.message.id,
                &scalar.part.id,
                &scalar.pointer,
                span.start,
                span.end,
                &scalar.hash,
            ))?;
            rows.push(CognitionSourceRow {
                source_id,
                episode_id: episode_id.to_owned(),
                revision: revision.to_owned(),
                source_kind: "conversation".into(),
                conversation_session_id: Some(scalar.message.message.session_id.clone()),
                conversation_message_id: Some(scalar.message.message.id.clone()),
                part_id: scalar.part.id.clone(),
                scalar_pointer: scalar.pointer.clone(),
                byte_start: span.start as f64,
                byte_end: span.end as f64,
                content_hash: scalar.hash.clone(),
                role: role(scalar.message.message.role).into(),
                origin_kind: origin(scalar.message.message.origin_kind).into(),
                observed_at: scalar.message.message.created_at.clone(),
                basis: if scalar.message.message.role == ConversationRole::User {
                    "user_statement"
                } else {
                    "assistant_statement"
                }
                .into(),
            });
        }
    }
    Ok(rows)
}

fn combined_origin(messages: &[ConversationMessageWithParts]) -> &'static str {
    if messages
        .iter()
        .any(|value| value.message.origin_kind == ConversationOriginKind::InternalControl)
    {
        "internal_control"
    } else if messages
        .iter()
        .any(|value| value.message.origin_kind == ConversationOriginKind::Unknown)
    {
        "unknown"
    } else {
        "user_input"
    }
}

fn role(value: ConversationRole) -> &'static str {
    match value {
        ConversationRole::System => "system",
        ConversationRole::Developer => "developer",
        ConversationRole::User => "user",
        ConversationRole::Assistant => "assistant",
        ConversationRole::Tool => "tool",
    }
}

fn origin(value: ConversationOriginKind) -> &'static str {
    match value {
        ConversationOriginKind::UserInput => "user_input",
        ConversationOriginKind::AssistantPublic => "assistant_public",
        ConversationOriginKind::InternalControl => "internal_control",
        ConversationOriginKind::Unknown => "unknown",
    }
}

fn error(code: crate::cognition::CognitionCode) -> CognitionSourceError {
    crate::cognition::CognitionError::new(code, code.as_str())
}
