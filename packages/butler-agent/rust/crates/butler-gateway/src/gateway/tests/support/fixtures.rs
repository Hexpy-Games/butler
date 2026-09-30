use super::*;
use serde_json::Map;

pub(super) fn event(id: u64) -> AppEventEnvelope {
    AppEventEnvelope {
        protocol_version: "butler.app.v1".into(),
        id,
        event_type: "message.created".into(),
        created_at: "2026-09-14T00:00:00.000Z".into(),
        payload: Map::new(),
    }
}

pub(super) fn message_result() -> MessageSendResult {
    MessageSendResult {
        accepted: Some(MessageRecord {
            content_parts: None,
            id: "message-1".into(),
            chat_id: "general".into(),
            turn_id: Some("turn-1".into()),
            conversation_session_id: None,
            conversation_turn_id: None,
            conversation_message_id: None,
            role: MessageRole::User,
            text: "hello".into(),
            status: MessageStatus::Sent,
            created_at: "2026-09-14T00:00:00.000Z".into(),
            updated_at: "2026-09-14T00:00:00.000Z".into(),
            safe_error_code: None,
            delivery_state: None,
            limitation_codes: None,
            limitations: None,
            retryable: false,
            cursor: 1,
            attachments: None,
            artifacts: None,
            changed_files: None,
            plan_document: None,
            work_blocks: None,
            turn_activity_rows: None,
        }),
        queued: None,
        reply: None,
        replies: vec![],
        turn: Some(TurnRecord {
            id: "turn-1".into(),
            chat_id: "general".into(),
            user_message_id: Some("message-1".into()),
            state: TurnState::Thinking,
            safe_status_label: "Thinking".into(),
            safe_error_code: None,
            retryable: false,
            cancellable: true,
            attempt: 1,
            created_at: "2026-09-14T00:00:00.000Z".into(),
            updated_at: "2026-09-14T00:00:00.000Z".into(),
            cursor: 1,
            execution_controls: None,
            execution_model: None,
        }),
        next_cursor: 1,
    }
}
