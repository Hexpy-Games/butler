//! Resolve App session references through the existing canonical Conversation owner.

use indexmap::IndexMap;
use serde_json::{Value, json};

use super::{
    AppReferencedChatSnapshot, GatewayApplicationError, MessageContent, MessageContentPart,
    application::app_session_hint,
};
use crate::conversation::{
    AgentConversationStore, ConversationMessageWithParts, ConversationPartKind,
    ConversationReadOrder, ConversationRole, ReadCognitionMessagesInput,
};
use crate::json::Utf16Prefix;
use crate::public_text::trim_js_whitespace;

pub(crate) async fn resolve_session_references(
    content: Option<&MessageContent>,
    chats: &[AppReferencedChatSnapshot],
    conversations: &AgentConversationStore,
) -> Result<Value, GatewayApplicationError> {
    let mut unique = IndexMap::new();
    for part in content.into_iter().flat_map(|content| &content.parts) {
        if let MessageContentPart::SessionRef {
            session_id,
            title_snapshot,
            ..
        } = part
        {
            // Map::set replaces the value without moving the first insertion position.
            unique.insert(session_id.as_str(), title_snapshot.as_str());
        }
    }

    let mut resolved = Vec::with_capacity(unique.len());
    let mut preview_budget = 4096;
    for (session_id, title_snapshot) in unique {
        let Some(chat) = chats.iter().find(|chat| chat.id == session_id) else {
            resolved.push(json!({
                "sessionId": session_id,
                "title": title_snapshot,
                "canonicalSessionId": null,
                "status": "unavailable",
                "preview": "",
            }));
            continue;
        };
        let canonical = conversations
            .get_session_by_gateway_binding("app", &app_session_hint(&chat.id))
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
        let preview = if let Some(canonical) = canonical.as_ref().filter(|_| preview_budget > 0) {
            let mut messages = conversations
                .read_cognition_messages(ReadCognitionMessagesInput {
                    session_id: Some(canonical.id.clone()),
                    roles: vec![ConversationRole::User, ConversationRole::Assistant],
                    limit: Some(2.0),
                    order: Some(ConversationReadOrder::Desc),
                    ..Default::default()
                })
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            messages.reverse();
            let text = messages
                .iter()
                .map(|message| {
                    let role = match message.message.role {
                        ConversationRole::User => "user",
                        ConversationRole::Assistant => "assistant",
                        // The canonical read returns only user and assistant roles.
                        _ => "other",
                    };
                    format!("{role}: {}", conversation_message_text(message))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let prefix = Utf16Prefix::new(text, preview_budget.min(1024));
            preview_budget -= prefix.len_utf16();
            // Value cannot represent an unpaired surrogate produced by JS slice.
            prefix.utf8_for_hash().into_owned()
        } else {
            String::new()
        };
        resolved.push(json!({
            "sessionId": chat.id,
            "title": chat.title,
            "canonicalSessionId": canonical.as_ref().map(|session| &session.id),
            "status": if canonical.is_some() { "available" } else { "empty" },
            "preview": preview,
        }));
    }
    Ok(Value::Array(resolved))
}

fn conversation_message_text(message: &ConversationMessageWithParts) -> String {
    let mut text = String::new();
    for part in &message.parts {
        if part.kind != ConversationPartKind::Text {
            continue;
        }
        let Some(value) = part.content_json.get("text").and_then(Value::as_str) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(value);
    }
    trim_js_whitespace(&text).to_owned()
}
