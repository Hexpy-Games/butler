use crate::conversation::{
    ConversationOriginKind, ConversationPartKind, ConversationRole, ConversationSourceReader,
    ConversationStatus,
};
use crate::segmentation::grapheme_segments;

use super::types::{CognitionSourceError, CognitionSourceRow, PriorPublicContext};

const CONTEXT_BYTES: usize = 4 * 1_024;

pub(crate) fn read_prior_public_context(
    reader: &ConversationSourceReader,
    session_id: &str,
    source_rows: &[CognitionSourceRow],
) -> Result<Vec<PriorPublicContext>, CognitionSourceError> {
    if session_id.is_empty() {
        return Ok(Vec::new());
    }
    let first_observed_at = source_rows
        .iter()
        .map(|row| row.observed_at.as_str())
        .min_by(|left, right| utf16_cmp(left, right))
        .unwrap_or("");
    let messages = reader.read_projection_messages(session_id)?;
    let mut eligible = messages
        .into_iter()
        .filter(|message| utf16_cmp(message.message.created_at.as_str(), first_observed_at).is_lt())
        .filter(|message| {
            matches!(
                message.message.status,
                ConversationStatus::Complete | ConversationStatus::Compacted
            )
        })
        .filter(|message| {
            matches!(
                message.message.origin_kind,
                ConversationOriginKind::UserInput | ConversationOriginKind::AssistantPublic
            )
        })
        .filter(|message| {
            matches!(
                message.message.role,
                ConversationRole::User | ConversationRole::Assistant
            )
        })
        .collect::<Vec<_>>();
    let keep_from = eligible.len().saturating_sub(2);
    let mut units = Vec::new();
    for message in eligible.drain(keep_from..) {
        let text = tail_within_bytes(&message, CONTEXT_BYTES);
        if !text.is_empty() {
            units.push(PriorPublicContext {
                ref_id: format!("conversation-message:{}", message.message.id),
                text,
                observed_at: message.message.created_at,
                basis: if message.message.role == ConversationRole::User {
                    "user_statement"
                } else {
                    "assistant_statement"
                }
                .into(),
            });
        }
    }
    let mut kept = Vec::new();
    for unit in units.into_iter().rev() {
        let mut candidate = Vec::with_capacity(kept.len() + 1);
        candidate.push(unit.clone());
        candidate.extend(kept.iter().cloned());
        let json = serde_json::to_string(&candidate).map_err(|error| {
            CognitionSourceError::new("cognition_source_json_error", error.to_string())
        })?;
        if json.len() <= CONTEXT_BYTES {
            kept = candidate;
        }
    }
    Ok(kept)
}

fn tail_within_bytes(
    message: &crate::conversation::ConversationMessageWithParts,
    max_bytes: usize,
) -> String {
    let text = conversation_text(message);
    let mut bytes = 0;
    let mut start = text.len();
    for segment in grapheme_segments(&text).rev() {
        if bytes + segment.text.len() > max_bytes {
            break;
        }
        bytes += segment.text.len();
        start = segment.start;
    }
    text[start..].to_owned()
}

fn conversation_text(message: &crate::conversation::ConversationMessageWithParts) -> String {
    let mut output = String::new();
    for text in message.parts.iter().filter_map(|part| {
        if part.kind != ConversationPartKind::Text {
            return None;
        }
        part.content_json
            .as_object()?
            .get("text")?
            .as_str()
            .filter(|text| !text.is_empty())
    }) {
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(text);
    }
    crate::public_text::trim_js_whitespace(&output).to_owned()
}

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
