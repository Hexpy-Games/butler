use serde_json::{Number, Value};

use crate::conversation::{
    ConversationMessageWithParts, ConversationOriginKind, ConversationProvenance, ConversationRole,
    ConversationSourceReader, ConversationStatus, decode_message_scalars,
};

use super::identity::{projection_hash, recovered_parts_hash};
use super::types::{
    CognitionSourceError, CognitionSourcePlan, CognitionSourceRow, ConversationSourceNotice,
    PreparedConversationSource,
};
use crate::cognition::{MEMORY_SOURCE_WINDOW_BYTES, split_historical_source_spans};

pub(crate) fn prepare_conversation_source(
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
        Ok(_) => Err(error("memory_source_changed")),
        Err(error)
            if matches!(
                error.code,
                "memory_source_not_terminal"
                    | "memory_source_ineligible"
                    | "memory_source_text_missing"
            ) =>
        {
            Err(super::types::CognitionSourceError::new(
                "memory_source_changed",
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
        return Err(error("memory_source_not_terminal"));
    };
    if turn.session_id != session_id
        || outcome.generation != outcome_generation
        || !matches!(turn.status.as_str(), "complete" | "failed" | "aborted")
    {
        return Err(error("memory_source_not_terminal"));
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
    let episode_id = projection_hash(vec!["canonical-conversation-turn".into(), turn_id.into()])?;
    plan(PlanInput {
        messages,
        source_key: format!("conversation_turn:{turn_id}"),
        episode_id,
        revision_tail: number(outcome.generation),
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
        return Err(error("memory_source_not_terminal"));
    };
    if message.message.session_id != session_id
        || message.message.turn_id.is_some()
        || !eligible_standalone(&message)
    {
        return Err(error("memory_source_not_terminal"));
    }
    let actual_hash = recovered_parts_hash(&message)?;
    if actual_hash != source_hash {
        return Err(error("memory_source_changed"));
    }
    let episode_id = projection_hash(vec![
        "canonical-conversation-message".into(),
        message_id.into(),
    ])?;
    plan(PlanInput {
        messages: vec![message],
        source_key: format!("conversation_message:{message_id}"),
        episode_id,
        revision_tail: Value::String(source_hash.to_owned()),
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
        return Err(error("memory_source_ineligible"));
    };
    if request.message.role != ConversationRole::User
        || !matches!(
            request.message.status,
            ConversationStatus::Complete | ConversationStatus::Compacted
        )
        || request.message.origin_kind != ConversationOriginKind::UserInput
    {
        return Err(error("memory_source_ineligible"));
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
        return Err(error("memory_source_ineligible"));
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
    revision_tail: Value,
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
    let mut revision_parts = vec![Value::String("episode-revision".into())];
    for scalar in &scalars {
        revision_parts.extend([
            scalar.message.message.id.clone().into(),
            scalar.part.id.clone().into(),
            scalar.pointer.clone().into(),
            scalar.hash.clone().into(),
        ]);
    }
    revision_parts.push(revision_tail);
    let revision = projection_hash(revision_parts)?;
    let job_id = projection_hash(vec![
        "memory-projection".into(),
        episode_id.clone().into(),
        revision.clone().into(),
        extraction_version.into(),
    ])?;
    let mut rows = Vec::new();
    for scalar in scalars {
        for span in split_historical_source_spans(scalar.text, MEMORY_SOURCE_WINDOW_BYTES) {
            let source_id = projection_hash(vec![
                "memory-source".into(),
                episode_id.clone().into(),
                revision.clone().into(),
                "conversation".into(),
                scalar.message.message.id.clone().into(),
                scalar.part.id.clone().into(),
                scalar.pointer.clone().into(),
                span.start.into(),
                span.end.into(),
                scalar.hash.clone().into(),
            ])?;
            rows.push(CognitionSourceRow {
                source_id,
                episode_id: episode_id.clone(),
                revision: revision.clone(),
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
    if rows.is_empty() {
        return Err(error("memory_source_text_missing"));
    }
    let windows = rows.iter().map(|row| vec![row.source_id.clone()]).collect();
    let source_hash = revision.clone();
    Ok(CognitionSourcePlan {
        source_key,
        episode_id,
        revision,
        job_id,
        extraction_version: extraction_version.into(),
        session_id: messages[0].message.session_id.clone(),
        turn_id,
        conversation_start,
        conversation_end,
        source_hash,
        origin_kind: combined_origin(&messages).into(),
        rows,
        windows,
    })
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

fn number(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn error(code: &'static str) -> CognitionSourceError {
    CognitionSourceError::new(code, code)
}
