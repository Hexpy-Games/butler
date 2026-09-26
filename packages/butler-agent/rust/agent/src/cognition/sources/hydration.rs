use std::borrow::Cow;

use sha2::{Digest, Sha256};

use crate::conversation::{
    ConversationMessageWithParts, ConversationOriginKind, ConversationRole, ConversationStatus,
    scalar_for_part,
};
use crate::segmentation::grapheme_segments;

use super::types::{CognitionSourceError, CognitionSourceRow, HydratedConversationSource};

pub(crate) fn hydrate_conversation_source<'a>(
    message: &'a ConversationMessageWithParts,
    row: &'a CognitionSourceRow,
    max_graphemes: f64,
) -> Result<HydratedConversationSource<'a>, CognitionSourceError> {
    let part = message.parts.iter().find(|part| part.id == row.part_id);
    let scalar = part.and_then(|part| scalar_for_part(part, &row.scalar_pointer));
    let Some(scalar) = scalar.filter(|value| !value.is_empty()) else {
        return Err(changed());
    };
    if Some(message.message.session_id.as_str()) != row.conversation_session_id.as_deref()
        || Some(message.message.id.as_str()) != row.conversation_message_id.as_deref()
        || role(message.message.role) != row.role
        || origin(message.message.origin_kind) != row.origin_kind
        || !matches!(
            message.message.status,
            ConversationStatus::Complete
                | ConversationStatus::Failed
                | ConversationStatus::Compacted
        )
        || format!("{:x}", Sha256::digest(scalar.as_bytes())) != row.content_hash
    {
        return Err(changed());
    }
    if row.byte_start < 0.0 || row.byte_end <= row.byte_start || row.byte_end > scalar.len() as f64
    {
        return Err(changed());
    }
    let start = js_buffer_index(row.byte_start, scalar.len());
    let end = js_buffer_index(row.byte_end, scalar.len());
    let text = scalar.get(start..end).ok_or_else(changed)?;
    Ok(HydratedConversationSource {
        source_ref: &row.source_id,
        text,
        excerpt: truncate_graphemes(text, max_graphemes),
        byte_start: row.byte_start,
        byte_end: row.byte_end,
        source_hash: &row.content_hash,
        conversation_session_id: row.conversation_session_id.as_deref(),
        conversation_message_id: row.conversation_message_id.as_deref(),
        basis: &row.basis,
        origin_kind: &row.origin_kind,
        scalar_text: scalar,
    })
}

fn truncate_graphemes(value: &str, limit: f64) -> Cow<'_, str> {
    if !limit.is_finite() {
        return Cow::Borrowed(value);
    }
    let count = limit.trunc().max(0.0);
    let end = if count >= usize::MAX as f64 {
        value.len()
    } else {
        grapheme_segments(value)
            .nth(count as usize)
            .map_or(value.len(), |segment| segment.start)
    };
    if end == value.len() {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(value[..end].to_owned())
    }
}

fn js_buffer_index(value: f64, length: usize) -> usize {
    if value.is_nan() || value <= 0.0 {
        0
    } else if !value.is_finite() || value >= length as f64 {
        length
    } else {
        value.trunc() as usize
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

fn changed() -> CognitionSourceError {
    CognitionSourceError::new("memory_source_changed", "memory_source_changed")
}
