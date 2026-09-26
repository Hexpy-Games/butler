//! Host adapter from App session projection/control to the BTCC owner.

use std::sync::Arc;

use crate::{
    btcc::{
        NativeSubsessionService, StorageProgressPublication, SubsessionCancelRequest,
        SubsessionResumeRequest,
    },
    conversation::{
        AgentConversationStore, ConversationMessageWithParts, ConversationPartKind,
        ConversationRole, ConversationStatus, conversation_session_id_for_durable_session,
    },
    gateway::{
        AppSessionViewPage, AppSubsessionPort, ApplicationFuture, GatewayApplicationError,
        OperationOutputChunk,
    },
    workspace::SessionRole,
};

pub(crate) struct NativeAppSubsessions {
    service: Arc<NativeSubsessionService>,
    conversations: Arc<AgentConversationStore>,
    progress: StorageProgressPublication,
}

impl NativeAppSubsessions {
    pub(crate) fn new(
        service: Arc<NativeSubsessionService>,
        conversations: Arc<AgentConversationStore>,
        progress: StorageProgressPublication,
    ) -> Self {
        Self {
            service,
            conversations,
            progress,
        }
    }
}

impl AppSubsessionPort for NativeAppSubsessions {
    fn projection(
        &self,
        session_id: String,
        page: Option<AppSessionViewPage>,
    ) -> ApplicationFuture<serde_json::Value> {
        let service = self.service.clone();
        let conversations = self.conversations.clone();
        Box::pin(async move {
            let mut projection = service
                .app_projection(&session_id)
                .await
                .map_err(map_error)?;
            if projection
                .get("relation")
                .is_none_or(serde_json::Value::is_null)
            {
                return Ok(projection);
            }
            let canonical_session_id = conversation_session_id_for_durable_session(&session_id);
            let page = page.unwrap_or(AppSessionViewPage {
                after_cursor: None,
                before_cursor: None,
                limit: 200,
            });
            let page = conversations
                .read_projection_message_page(
                    &canonical_session_id,
                    page.after_cursor,
                    page.before_cursor,
                    page.limit,
                )
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            let messages = page
                .messages
                .iter()
                .filter_map(|message| project_message(message, &session_id))
                .collect::<Vec<_>>();
            let turn_id = projection
                .pointer("/latest_turn/id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let turn = match turn_id {
                Some(turn_id) => conversations
                    .read_turn(&turn_id)
                    .await
                    .map_err(|_| GatewayApplicationError::Internal)?,
                None => None,
            };
            let object = projection
                .as_object_mut()
                .ok_or(GatewayApplicationError::Internal)?;
            object.insert("messages".into(), serde_json::json!(messages));
            object.insert("messages_has_more".into(), serde_json::json!(page.has_more));
            if let Some(turn) = turn {
                let state = turn_state(&turn.status);
                let projected = serde_json::json!({
                    "id": turn.id,
                    "state": state,
                    "created_at": turn.started_at,
                    "updated_at": turn.completed_at.as_deref().unwrap_or(&turn.started_at),
                    "cancellable": state == "thinking",
                });
                object.insert("latest_turn".into(), projected.clone());
                object.insert(
                    "active_turn".into(),
                    if state == "thinking" {
                        projected
                    } else {
                        serde_json::Value::Null
                    },
                );
            }
            Ok(projection)
        })
    }

    fn cancel(
        &self,
        parent_session_id: String,
        relation_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        let service = self.service.clone();
        Box::pin(async move {
            service
                .cancel(SubsessionCancelRequest {
                    parent_session_id,
                    parent_turn_id: "app-steward-control".into(),
                    source_message_id: format!("app-steward-cancel:{relation_id}"),
                    relation_id: Some(relation_id),
                    safe_title: None,
                    child_role: SessionRole::Steward,
                })
                .await
                .map_err(map_error)
        })
    }

    fn resume(
        &self,
        parent_session_id: String,
        relation_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        let service = self.service.clone();
        Box::pin(async move {
            service
                .resume(SubsessionResumeRequest {
                    parent_session_id,
                    relation_id,
                })
                .await
                .map_err(map_error)
        })
    }

    fn read_operation_output_chunks(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
    ) -> ApplicationFuture<Vec<OperationOutputChunk>> {
        let progress = self.progress.clone();
        Box::pin(async move {
            let events = progress
                .read_child_operation_output_events(turn_id, request_id.clone(), result_id.clone())
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            Ok(events
                .iter()
                .filter_map(|event| {
                    OperationOutputChunk::from_public_event(event, &request_id, &result_id)
                })
                .collect())
        })
    }
}

fn project_message(
    message: &ConversationMessageWithParts,
    public_session_id: &str,
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
    Some(serde_json::json!({
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
    }))
}

fn turn_state(status: &str) -> &'static str {
    match status {
        "running" => "thinking",
        "cancelled" => "cancelled",
        "failed" | "runtime_fault" => "failed",
        _ => "delivered",
    }
}

fn map_error(error: crate::btcc::BtccError) -> GatewayApplicationError {
    let status = match error.code.as_str() {
        "active_steward_relation_not_found" | "steward_relation_not_found" => 404,
        "active_steward_relation_ambiguous"
        | "steward_relation_not_active"
        | "steward_relation_not_recoverable" => 409,
        _ => 500,
    };
    if status == 500 {
        GatewayApplicationError::Internal
    } else {
        let message = match error.code.as_str() {
            "steward_relation_not_active" => "Steward relation is not active.",
            "steward_relation_not_recoverable" => "Steward relation is not recoverable.",
            _ => "Active Steward relation was not found.",
        };
        GatewayApplicationError::Public {
            status,
            code: error.code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::{
        ConversationMessage, ConversationOriginKind, ConversationPart, ConversationProvenance,
        ConversationVisibility,
    };

    #[test]
    fn child_message_projection_keeps_every_text_content_block() {
        let message = ConversationMessageWithParts {
            message: ConversationMessage {
                id: "message".into(),
                session_id: "canonical".into(),
                turn_id: Some("turn".into()),
                seq: 7,
                role: ConversationRole::Assistant,
                status: ConversationStatus::Complete,
                visibility: ConversationVisibility::User,
                provenance: ConversationProvenance::Trusted,
                created_at: "2026-09-21T00:00:00.000Z".into(),
                compacted_by_summary_id: None,
                source_gateway: None,
                source_ref: None,
                origin_kind: ConversationOriginKind::AssistantPublic,
                origin_ref: None,
                origin_reason: None,
                origin_version: None,
                origin_evidence_json: None,
            },
            parts: vec![ConversationPart {
                id: "part".into(),
                message_id: "message".into(),
                part_index: 0,
                kind: ConversationPartKind::MessageContent,
                content_json: serde_json::json!([
                    {"type":"output_text","text":"first"},
                    {"type":"input_image","image_url":"ignored"},
                    {"type":"output_text","text":"second"}
                ]),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: ConversationStatus::Complete,
            }],
        };
        let projected = project_message(&message, "steward-public").unwrap();
        assert_eq!(projected["text"], "first\nsecond");
        assert_eq!(projected["cursor"], 7);
        assert_eq!(projected["chat_id"], "steward-public");
    }
}
