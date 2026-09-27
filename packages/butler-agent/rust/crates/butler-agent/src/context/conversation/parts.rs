use crate::conversation::*;

use super::types::*;

pub(crate) fn to_context_message(
    message: &ConversationMessageWithParts,
    include_tools: bool,
) -> ConversationContextMessage {
    let parts = message
        .parts
        .iter()
        .filter(|v| {
            include_tools
                || !matches!(
                    v.kind,
                    ConversationPartKind::ToolCall | ConversationPartKind::ToolResult
                )
        })
        .map(to_context_part)
        .collect::<Vec<_>>();
    ConversationContextMessage {
        conversation_message_id: message.message.id.clone(),
        turn_id: message.message.turn_id.clone(),
        seq: message.message.seq,
        created_at: message.message.created_at.clone(),
        speaker: match message.message.role {
            ConversationRole::Assistant => "butler",
            ConversationRole::Developer => "developer",
            ConversationRole::System => "system",
            ConversationRole::Tool => "tool",
            ConversationRole::User => "user",
        },
        role: message.message.role,
        text: crate::conversation::text_for_message(message, include_tools),
        parts,
    }
}
pub(crate) fn to_context_summary(summary: &ConversationSummary) -> ConversationContextSummary {
    ConversationContextSummary {
        summary_id: summary.id.clone(),
        covers_from_seq: summary.covers_from_seq,
        covers_to_seq: summary.covers_to_seq,
        source_hash: summary.source_hash.clone(),
        text: summary.summary_text.clone(),
    }
}
fn to_context_part(part: &ConversationPart) -> ConversationContextPart {
    ConversationContextPart {
        kind: part.kind,
        text: crate::conversation::text_for_part(part),
        tool_call_id: part.tool_call_id.clone(),
        parent_tool_call_id: part.parent_tool_call_id.clone(),
        provider_shape: part.provider_shape,
        status: part.status,
    }
}
