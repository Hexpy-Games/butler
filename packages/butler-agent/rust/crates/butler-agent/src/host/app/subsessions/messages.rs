//! Child message display projection keeps the stored model input intact.
use butler_turn::conversation::{
    ConversationMessageWithParts, ConversationPartKind, ConversationRole, ConversationStatus,
};

pub(super) fn project_message(
    message: &ConversationMessageWithParts,
    public_session_id: &str,
    delegated: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    if !matches!(
        message.message.role,
        ConversationRole::User | ConversationRole::Assistant
    ) {
        return None;
    }
    let text = message
        .parts
        .iter()
        .flat_map(|part| match part.kind {
            ConversationPartKind::Text => part
                .content_json
                .get("text")
                .and_then(|value| value.as_str())
                .into_iter()
                .collect::<Vec<_>>(),
            ConversationPartKind::MessageContent => part
                .content_json
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| {
                    matches!(
                        item.get("type").and_then(|value| value.as_str()),
                        Some("input_text" | "output_text" | "text")
                    )
                })
                .filter_map(|item| item.get("text").and_then(|value| value.as_str()))
                .collect(),
            _ => Vec::new(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let status = match message.message.status {
        ConversationStatus::Failed => "failed",
        ConversationStatus::Pending => "thinking",
        ConversationStatus::Complete | ConversationStatus::Compacted => "delivered",
    };
    let mut projected = serde_json::json!({
        "id": message.message.id,
        "chat_id": public_session_id,
        "turn_id": message.message.turn_id,
        "role": message.message.role,
        "text": text,
        "status": status,
        "retryable": false,
        "cursor": message.message.seq,
        "created_at": message.message.created_at,
        "updated_at": message.message.created_at,
    });
    if message.message.role == ConversationRole::User
        && let Some(delivered) = delegated.and_then(|delegated| {
            delivered_text(delegated, message.message.turn_id.as_deref(), &text)
        })
    {
        projected["delivered_text"] = serde_json::json!(delivered);
    }
    Some(projected)
}

/// A Steward session's user messages carry model-only framing; the App shows
/// what was delivered: the delegated request on the packet turn, the
/// instruction of a steer.
fn delivered_text(
    delegated: &serde_json::Value,
    turn_id: Option<&str>,
    text: &str,
) -> Option<String> {
    if turn_id.is_some() && turn_id == delegated["turn_id"].as_str() {
        return delegated["text"]
            .as_str()
            .filter(|request| !request.trim().is_empty())
            .map(str::to_owned);
    }
    butler_turn::btcc::delivered_direction(text).map(str::to_owned)
}
