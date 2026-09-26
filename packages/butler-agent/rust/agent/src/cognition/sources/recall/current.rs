//! Current canonical episode/revision checks before serving graph evidence.

use serde_json::{Number, Value};

use crate::cognition::{CognitionSourceRow, recall::RecallSourceEpisode};
use crate::conversation::{
    ConversationMessageWithParts, ConversationOriginKind, ConversationProvenance, ConversationRole,
    ConversationSourceReader, ConversationStatus, decode_message_scalars,
};

use super::super::identity::{projection_hash, recovered_parts_hash};

pub(super) fn episode(
    reader: &ConversationSourceReader,
    identity: &RecallSourceEpisode,
    standalone_row: Option<&CognitionSourceRow>,
) -> bool {
    if let Some(turn_id) = &identity.turn_id {
        return turn_current(reader, identity, turn_id);
    }
    standalone_row.is_some_and(|row| standalone_current(reader, identity, row))
}

fn turn_current(
    reader: &ConversationSourceReader,
    identity: &RecallSourceEpisode,
    turn_id: &str,
) -> bool {
    let Ok(Some(turn)) = reader.read_turn(turn_id) else {
        return false;
    };
    let Ok(Some(outcome)) = reader.read_turn_outcome(turn_id) else {
        return false;
    };
    if turn.session_id != identity.session_id
        || outcome.session_id != identity.session_id
        || !matches!(turn.status.as_str(), "complete" | "failed" | "aborted")
    {
        return false;
    }
    if hash(vec!["canonical-conversation-turn".into(), turn_id.into()]).as_deref()
        != Some(&identity.episode_id)
    {
        return false;
    }
    let request = outcome
        .request_message_id
        .as_deref()
        .and_then(|id| reader.read_message(id).ok().flatten());
    let assistant = outcome
        .public_assistant_message_id
        .as_deref()
        .and_then(|id| reader.read_message(id).ok().flatten());
    if request.as_ref().is_none_or(|message| {
        message.message.role != ConversationRole::User
            || !matches!(
                message.message.status,
                ConversationStatus::Complete | ConversationStatus::Compacted
            )
            || message.message.origin_kind != ConversationOriginKind::UserInput
    }) {
        return false;
    }
    if outcome.public_assistant_message_id.is_some()
        && assistant.as_ref().is_none_or(|message| {
            message.message.role != ConversationRole::Assistant
                || message.message.status != ConversationStatus::Complete
                || message.message.origin_kind != ConversationOriginKind::AssistantPublic
        })
    {
        return false;
    }
    let Some(request) = request else {
        return false;
    };
    let mut messages = vec![request];
    if let Some(assistant) = assistant {
        messages.push(assistant);
    }
    let Some(generation) = Number::from_f64(outcome.generation) else {
        return false;
    };
    revision(&messages, Value::Number(generation)).as_deref() == Some(&identity.revision)
}

fn standalone_current(
    reader: &ConversationSourceReader,
    identity: &RecallSourceEpisode,
    row: &CognitionSourceRow,
) -> bool {
    let Some(message_id) = row.conversation_message_id.as_deref() else {
        return false;
    };
    let Ok(Some(message)) = reader.read_message(message_id) else {
        return false;
    };
    if message.message.turn_id.is_some() || message.message.session_id != identity.session_id {
        return false;
    }
    let eligible = match message.message.role {
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
    };
    if !eligible
        || hash(vec![
            "canonical-conversation-message".into(),
            message.message.id.clone().into(),
        ])
        .as_deref()
            != Some(&identity.episode_id)
    {
        return false;
    }
    let Ok(source_hash) = recovered_parts_hash(&message) else {
        return false;
    };
    revision(&[message], Value::String(source_hash)).as_deref() == Some(&identity.revision)
}

fn revision(messages: &[ConversationMessageWithParts], tail: Value) -> Option<String> {
    let mut values = vec![Value::String("episode-revision".into())];
    for message in messages {
        for scalar in decode_message_scalars(message) {
            values.extend([
                scalar.message.message.id.clone().into(),
                scalar.part.id.clone().into(),
                scalar.pointer.into(),
                scalar.hash.into(),
            ]);
        }
    }
    values.push(tail);
    hash(values)
}
fn hash(values: Vec<Value>) -> Option<String> {
    projection_hash(values).ok()
}
