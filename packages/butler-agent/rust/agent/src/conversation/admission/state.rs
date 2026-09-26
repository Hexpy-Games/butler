use serde_json::{Value, json};

use super::classifier::{AdmissionOperation, ConversationAdmissionInput, classify};
use super::{AdmissionMetric, ConversationAdmissionTurn, collect_evidence, stringify_optional};
use crate::conversation::types::*;
use crate::conversation::{ConversationError, ConversationResult};

struct AppendToolInput<'a> {
    kind: ConversationPartKind,
    tool_call_id: String,
    parent_tool_call_id: Option<String>,
    provider_shape: ConversationProviderShape,
    content_json: Value,
    status: ConversationStatus,
    event_kind: &'a str,
}

impl ConversationAdmissionTurn {
    pub(super) async fn apply(&self, event: ConversationAdmissionInput) -> ConversationResult<()> {
        let decision = classify(&event);
        let _ignored_metric = self
            .input
            .observer
            .admission_metric(AdmissionMetric {
                session_id: self.input.binding.session_id.clone(),
                session_role: self.input.binding.role.clone(),
                source: event.source,
                event_kind: event.kind.clone(),
                admitted: decision.admitted,
                class_name: decision.class_name,
                reason: decision.reason,
            })
            .await;
        let Some(operation) = decision.operation else {
            return Ok(());
        };
        match operation {
            AdmissionOperation::AppendMessage {
                role,
                text,
                visibility,
                source_gateway,
                source_ref,
            } => {
                self.append_message(
                    role,
                    text,
                    visibility,
                    source_gateway,
                    source_ref,
                    &event.kind,
                )
                .await
            }
            AdmissionOperation::AppendTool {
                kind,
                tool_call_id,
                parent_tool_call_id,
                provider_shape,
                content_json,
                status,
            } => {
                self.append_tool(AppendToolInput {
                    kind,
                    tool_call_id,
                    parent_tool_call_id,
                    provider_shape,
                    content_json,
                    status,
                    event_kind: &decision.event_kind,
                })
                .await
            }
        }
    }

    async fn append_message(
        &self,
        role: ConversationRole,
        text: String,
        visibility: ConversationVisibility,
        source_gateway: Option<String>,
        source_ref: Option<String>,
        event_kind: &str,
    ) -> ConversationResult<()> {
        if let Some(reference) = source_ref.as_deref()
            && let Some(existing) = self
                .input
                .store
                .read_message_by_source_ref(&self.turn.session_id, reference)
                .await?
        {
            return self.accept_existing(existing, role, &text).await;
        }
        let origin_kind = if role == ConversationRole::Assistant
            && self.input.origin.kind != ConversationOriginKind::InternalControl
        {
            ConversationOriginKind::AssistantPublic
        } else {
            self.input.origin.kind
        };
        let origin_reason = if role == ConversationRole::Assistant {
            if origin_kind == ConversationOriginKind::InternalControl {
                "verified_internal_control"
            } else {
                "verified_public_ingress"
            }
        } else {
            &self.input.origin.reason
        };
        let parts = (role == ConversationRole::User)
            .then(|| self.input.envelope.content_parts.clone())
            .flatten()
            .map(|content| {
                vec![
                    MessagePartInput {
                        kind: ConversationPartKind::Text,
                        content_json: json!({"text":text}),
                        tool_call_id: None,
                        parent_tool_call_id: None,
                        provider_shape: None,
                        status: None,
                    },
                    MessagePartInput {
                        kind: ConversationPartKind::MessageContent,
                        content_json: content,
                        tool_call_id: None,
                        parent_tool_call_id: None,
                        provider_shape: None,
                        status: None,
                    },
                ]
            });
        let input = AppendMessageInput {
            session_id: self.turn.session_id.clone(),
            turn_id: Some(self.turn.id.clone()),
            text,
            message_id: None,
            role,
            status: None,
            visibility: Some(visibility),
            provenance: None,
            source_gateway,
            source_ref,
            origin_kind: Some(origin_kind),
            origin_ref: self.input.origin.reference.clone(),
            origin_reason: Some(origin_reason.into()),
            origin_version: Some(self.input.origin.version.clone()),
            origin_evidence: Some(self.input.origin.evidence.clone()),
            now: None,
            parts,
        };
        let message = if role == ConversationRole::User {
            self.input.store.append_user_message(input).await?
        } else {
            self.input.store.append_assistant_message(input).await?
        };
        let mut state = self.state.lock().await;
        if role == ConversationRole::User && state.request_message_id.is_none() {
            state.request_message_id = Some(message.message.id);
        } else if role == ConversationRole::Assistant
            && (visibility == ConversationVisibility::User || event_kind == "outbound.final")
        {
            state.public_assistant_message_id = Some(message.message.id);
        }
        Ok(())
    }

    async fn accept_existing(
        &self,
        message: ConversationMessageWithParts,
        role: ConversationRole,
        text: &str,
    ) -> ConversationResult<()> {
        let content = message
            .parts
            .iter()
            .filter(|v| v.kind == ConversationPartKind::Text)
            .filter_map(|v| v.content_json.get("text").and_then(Value::as_str))
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let content = crate::public_text::trim_js_whitespace(&content).to_owned();
        let content_parts = message
            .parts
            .iter()
            .find(|v| v.kind == ConversationPartKind::MessageContent)
            .map(|v| &v.content_json);
        let expected = self.input.envelope.content_parts.as_ref();
        if message.message.turn_id.as_deref() != Some(&self.turn.id)
            || message.message.role != role
            || content != text
            || (role == ConversationRole::User
                && stringify_optional(content_parts)? != stringify_optional(expected)?)
        {
            return Err(ConversationError::new(
                "conversation_source_ref_conflict",
                "conversation_source_ref_conflict",
            ));
        }
        let mut state = self.state.lock().await;
        match role {
            ConversationRole::User if state.request_message_id.is_none() => {
                state.request_message_id = Some(message.message.id);
            }
            ConversationRole::Assistant if state.public_assistant_message_id.is_none() => {
                state.public_assistant_message_id = Some(message.message.id);
            }
            ConversationRole::User | ConversationRole::Assistant => {}
            _ => {
                return Err(ConversationError::new(
                    "conversation_source_ref_role_unsupported",
                    "conversation_source_ref_role_unsupported",
                ));
            }
        }
        Ok(())
    }

    async fn append_tool(&self, input: AppendToolInput<'_>) -> ConversationResult<()> {
        let AppendToolInput {
            kind,
            tool_call_id,
            parent_tool_call_id: parent,
            provider_shape: provider,
            content_json: content,
            status,
            event_kind,
        } = input;
        let mut state = self.state.lock().await;
        if kind == ConversationPartKind::ToolCall {
            let existing = state.tool_message_id.clone();
            drop(state);
            let message_id = if let Some(message) = existing {
                self.input
                    .store
                    .append_tool_call(AppendToolPartInput {
                        message_id: message.clone(),
                        content_json: content,
                        tool_call_id: tool_call_id.clone(),
                        parent_tool_call_id: parent,
                        provider_shape: Some(provider),
                        status: Some(status),
                    })
                    .await?;
                message
            } else {
                let message = self
                    .input
                    .store
                    .append_assistant_message(AppendMessageInput {
                        session_id: self.turn.session_id.clone(),
                        turn_id: Some(self.turn.id.clone()),
                        text: String::new(),
                        message_id: None,
                        role: ConversationRole::Assistant,
                        status: None,
                        visibility: None,
                        provenance: None,
                        source_gateway: Some(self.input.envelope.transport.clone()),
                        source_ref: Some(format!(
                            "{}:{event_kind}:{tool_call_id}",
                            self.input.turn_id
                        )),
                        origin_kind: None,
                        origin_ref: None,
                        origin_reason: None,
                        origin_version: None,
                        origin_evidence: None,
                        now: None,
                        parts: Some(vec![MessagePartInput {
                            kind,
                            content_json: content,
                            tool_call_id: Some(tool_call_id.clone()),
                            parent_tool_call_id: parent,
                            provider_shape: Some(provider),
                            status: Some(status),
                        }]),
                    })
                    .await?;
                message.message.id
            };
            state = self.state.lock().await;
            state.tool_message_id.get_or_insert(message_id);
            state.known_tool_call_ids.insert(tool_call_id);
            return Ok(());
        }
        let Some(message) = state.tool_message_id.clone() else {
            return Ok(());
        };
        collect_evidence(&content, &mut state.evidence_refs);
        drop(state);
        self.input
            .store
            .append_tool_result(AppendToolPartInput {
                message_id: message,
                content_json: content,
                tool_call_id,
                parent_tool_call_id: parent,
                provider_shape: Some(provider),
                status: Some(status),
            })
            .await?;
        Ok(())
    }
}
