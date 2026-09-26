//! Bind a claimed App envelope before entering BTCC, matching source ownership.

mod image_admission;
mod internal_subsession;
mod policy;

use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::NativeIngressError;
use crate::{
    btcc::{
        AttachmentRef, ExecutionControls, Peer, Sender, SessionRole as TurnRole, TurnMessage,
        TurnRequest, TurnRoute, TurnTrigger,
    },
    gateway::QueuedInboundEvent,
    workspace::{SessionBindingStore, SessionLifecycleState, SessionRole, StoredSessionBinding},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Envelope {
    pub event_id: String,
    pub transport: String,
    pub account_id: String,
    pub peer: Peer,
    pub sender: Sender,
    pub message: Message,
    pub routing_hints: Option<Hints>,
    pub execution_controls: Option<ExecutionControls>,
    pub app_turn_context: Option<Value>,
    pub native_steward_context: Option<Value>,
    pub control: Option<Value>,
}

#[derive(Deserialize)]
pub(super) struct Message {
    pub id: String,
    pub text: Option<String>,
    pub timestamp: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    #[serde(rename = "imageAdmission")]
    pub image_admission: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hints {
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub turn_attempt: Option<u32>,
    pub app_queue_claim_id: Option<String>,
    pub canonical_event_id: Option<String>,
    pub authority_request_ref: Option<String>,
    pub authority_client_message_id: Option<String>,
}

impl Envelope {
    pub(super) fn from_record(record: &QueuedInboundEvent) -> Result<Self, NativeIngressError> {
        record.envelope.read().map_err(|_| {
            NativeIngressError::new(
                "inbound_envelope_invalid",
                "Inbound envelope could not be decoded",
            )
        })
    }
}

pub(super) fn routed_turn_id(envelope: &Envelope) -> &str {
    envelope
        .routing_hints
        .as_ref()
        .and_then(|hints| hints.turn_id.as_deref())
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or(&envelope.event_id)
}

pub(super) async fn bind_and_request(
    envelope: &Envelope,
    bindings: &SessionBindingStore,
    data_root: &Path,
    default_workspace: &Path,
) -> Result<TurnRequest, NativeIngressError> {
    if envelope.transport == "automation" {
        let binding = automation_binding(envelope, bindings).await?;
        return automation_request(envelope, &binding);
    }
    if envelope.transport != "app" {
        return Err(NativeIngressError::new(
            "inbound_transport_unsupported",
            "Native ingress transport unavailable",
        ));
    }
    let hints = envelope
        .routing_hints
        .as_ref()
        .ok_or_else(|| invalid("Missing routing identity"))?;
    let session_id = hints
        .session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing session identity"))?;
    let turn_id = hints
        .turn_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing turn identity"))?;
    if let Some(context) = envelope.native_steward_context.as_ref() {
        return internal_subsession::bind(envelope, bindings, context, session_id, turn_id).await;
    }
    let controls = envelope
        .execution_controls
        .as_ref()
        .ok_or_else(|| invalid("Missing turn controls"))?;
    let verified = controls
        .verify()
        .map_err(|_| invalid("Invalid turn controls"))?;
    if verified.turn_id != turn_id || verified.session_id != envelope.peer.id {
        return Err(invalid("Turn control identity mismatch"));
    }
    let context = envelope
        .app_turn_context
        .as_ref()
        .ok_or_else(|| invalid("Missing App turn context"))?;
    verify_context(context, envelope, &verified.model_ref, turn_id)?;
    let existing = bindings.get_by_session_id(session_id).await.map_err(|_| {
        NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
    })?;
    let binding = policy::upsert_app_binding(
        bindings,
        existing,
        envelope,
        context,
        session_id,
        &verified.model_ref,
        policy::BindingRoots {
            data_root,
            default_workspace,
        },
    )
    .await?;
    let role = match binding.role {
        SessionRole::Butler => TurnRole::Butler,
        SessionRole::Steward => TurnRole::Steward,
        SessionRole::Worker => TurnRole::Worker,
        SessionRole::Unknown(_) => return Err(invalid("Unsupported session role")),
    };
    let content = envelope
        .message
        .text
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing user message"))?
        .to_owned();
    Ok(TurnRequest {
        turn_id: turn_id.to_owned(),
        recovery_attempt: hints.turn_attempt,
        session_id: binding.session_id,
        event_id: hints
            .canonical_event_id
            .as_deref()
            .unwrap_or(&envelope.event_id)
            .to_owned(),
        transport: envelope.transport.clone(),
        account_id: envelope.account_id.clone(),
        peer: envelope.peer.clone(),
        sender: envelope.sender.clone(),
        message: TurnMessage {
            id: envelope.message.id.clone(),
            content: content.clone(),
            timestamp: envelope.message.timestamp.clone(),
            attachments: envelope.message.attachments.clone(),
            image_admission: envelope.message.image_admission.clone(),
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role,
            workspace_path: binding.workspace_path,
            project_id: binding.project_id,
            reason: Some("session-hint".into()),
        },
        progress_destination: None,
        execution_controls: Some(controls.clone()),
        empty_response_policy: Some(
            if hints
                .app_queue_claim_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                "typed_terminal"
            } else {
                "safe_fallback"
            }
            .into(),
        ),
        app_turn_context: Some(context.clone()),
        authority_request_ref: hints
            .authority_request_ref
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned(),
        authority_client_message_id: hints
            .authority_client_message_id
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned(),
        app_queue_claim_id: hints
            .app_queue_claim_id
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned(),
        preparation_cancellation: CancellationToken::new(),
    })
}

async fn automation_binding(
    envelope: &Envelope,
    bindings: &SessionBindingStore,
) -> Result<StoredSessionBinding, NativeIngressError> {
    let session_id = envelope
        .routing_hints
        .as_ref()
        .and_then(|hints| hints.session_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing session identity"))?;
    let binding = bindings
        .get_by_session_id(session_id)
        .await
        .map_err(|_| {
            NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
        })?
        .ok_or_else(|| {
            NativeIngressError::new("session_binding_missing", "Session binding unavailable")
        })?;
    if binding.lifecycle_state == SessionLifecycleState::Active {
        return Ok(binding);
    }
    bindings
        .update_lifecycle_state(session_id, SessionLifecycleState::Active, None)
        .await
        .map_err(|_| {
            NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
        })?
        .ok_or_else(|| {
            NativeIngressError::new("session_binding_missing", "Session binding unavailable")
        })
}

fn automation_request(
    envelope: &Envelope,
    binding: &StoredSessionBinding,
) -> Result<TurnRequest, NativeIngressError> {
    let role = match binding.role {
        SessionRole::Butler => TurnRole::Butler,
        SessionRole::Steward => TurnRole::Steward,
        SessionRole::Worker => TurnRole::Worker,
        SessionRole::Unknown(_) => return Err(invalid("Unsupported session role")),
    };
    let content = envelope
        .message
        .text
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing user message"))?
        .to_owned();
    let turn_id = routed_turn_id(envelope).to_owned();
    Ok(TurnRequest {
        turn_id,
        recovery_attempt: None,
        session_id: binding.session_id.clone(),
        event_id: envelope.event_id.clone(),
        transport: envelope.transport.clone(),
        account_id: envelope.account_id.clone(),
        peer: envelope.peer.clone(),
        sender: envelope.sender.clone(),
        message: TurnMessage {
            id: envelope.message.id.clone(),
            content: content.clone(),
            timestamp: envelope.message.timestamp.clone(),
            attachments: Vec::new(),
            image_admission: None,
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role,
            workspace_path: binding.workspace_path.clone(),
            project_id: binding.project_id.clone(),
            reason: Some("session-hint".into()),
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: Some("safe_fallback".into()),
        app_turn_context: Some(json!({
            "session":{"id":binding.session_id},
            "contentParts":[{"type":"text","text":content}],
        })),
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: None,
        preparation_cancellation: CancellationToken::new(),
    })
}

pub(super) async fn existing_control_binding(
    envelope: &Envelope,
    bindings: &SessionBindingStore,
) -> Result<StoredSessionBinding, NativeIngressError> {
    let session_id = envelope
        .routing_hints
        .as_ref()
        .and_then(|hints| hints.session_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing session identity"))?;
    let binding = bindings
        .get_by_session_id(session_id)
        .await
        .map_err(|_| {
            NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
        })?
        .ok_or_else(|| {
            NativeIngressError::new("session_binding_missing", "Session binding unavailable")
        })?;
    if matches!(
        binding.lifecycle_state,
        SessionLifecycleState::Active | SessionLifecycleState::Closing
    ) {
        return Ok(binding);
    }
    bindings
        .update_lifecycle_state(session_id, SessionLifecycleState::Active, None)
        .await
        .map_err(|_| {
            NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
        })?
        .ok_or_else(|| {
            NativeIngressError::new("session_binding_missing", "Session binding unavailable")
        })
}

pub(super) fn control_request(
    envelope: &Envelope,
    binding: &StoredSessionBinding,
) -> Result<TurnRequest, NativeIngressError> {
    let hints = envelope
        .routing_hints
        .as_ref()
        .ok_or_else(|| invalid("Missing routing identity"))?;
    let turn_id = hints
        .turn_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing turn identity"))?;
    let role = match binding.role {
        SessionRole::Butler => TurnRole::Butler,
        SessionRole::Steward => TurnRole::Steward,
        SessionRole::Worker => TurnRole::Worker,
        SessionRole::Unknown(_) => return Err(invalid("Unsupported session role")),
    };
    let content = envelope
        .message
        .text
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing user message"))?
        .to_owned();
    Ok(TurnRequest {
        turn_id: turn_id.into(),
        recovery_attempt: hints.turn_attempt,
        session_id: binding.session_id.clone(),
        event_id: hints
            .canonical_event_id
            .as_deref()
            .unwrap_or(&envelope.event_id)
            .into(),
        transport: envelope.transport.clone(),
        account_id: envelope.account_id.clone(),
        peer: envelope.peer.clone(),
        sender: envelope.sender.clone(),
        message: TurnMessage {
            id: envelope.message.id.clone(),
            content: content.clone(),
            timestamp: envelope.message.timestamp.clone(),
            attachments: envelope.message.attachments.clone(),
            image_admission: envelope.message.image_admission.clone(),
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role,
            workspace_path: binding.workspace_path.clone(),
            project_id: binding.project_id.clone(),
            reason: Some("session-hint".into()),
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: Some(
            if hints
                .app_queue_claim_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                "typed_terminal"
            } else {
                "safe_fallback"
            }
            .into(),
        ),
        app_turn_context: Some(json!({
            "session":{"id":binding.session_id},
            "contentParts":[{"type":"text","text":content}],
        })),
        authority_request_ref: hints
            .authority_request_ref
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned(),
        authority_client_message_id: hints
            .authority_client_message_id
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned(),
        app_queue_claim_id: hints
            .app_queue_claim_id
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned(),
        preparation_cancellation: CancellationToken::new(),
    })
}

fn verify_context(
    context: &Value,
    envelope: &Envelope,
    model_ref: &str,
    turn_id: &str,
) -> Result<(), NativeIngressError> {
    if context.get("version").and_then(Value::as_u64) != Some(1)
        || context.pointer("/session/id").and_then(Value::as_str) != Some(envelope.peer.id.as_str())
        || context
            .pointer("/conversation/chatId")
            .and_then(Value::as_str)
            != Some(envelope.peer.id.as_str())
        || context
            .pointer("/conversation/userMessageId")
            .and_then(Value::as_str)
            != Some(envelope.message.id.as_str())
        || context
            .pointer("/conversation/turnId")
            .and_then(Value::as_str)
            != Some(turn_id)
        || context
            .pointer("/model/requestedModelRef")
            .and_then(Value::as_str)
            != Some(model_ref)
        || context.pointer("/model/reasoningEffort")
            != envelope
                .execution_controls
                .as_ref()
                .and_then(|controls| controls.as_json().get("reasoning_effort"))
        || context
            .pointer("/conversation/turnAttempt")
            .and_then(Value::as_u64)
            .is_none_or(|attempt| attempt == 0)
    {
        return Err(invalid("App turn context identity mismatch"));
    }
    Ok(())
}

fn invalid(message: &'static str) -> NativeIngressError {
    NativeIngressError::new("inbound_app_turn_invalid", message)
}
