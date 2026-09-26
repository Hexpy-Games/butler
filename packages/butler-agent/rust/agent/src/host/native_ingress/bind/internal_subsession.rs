//! Existing durable child binding to one internal subsession Turn.

use super::*;

pub(super) async fn bind(
    envelope: &Envelope,
    bindings: &SessionBindingStore,
    context: &Value,
    session_id: &str,
    turn_id: &str,
) -> Result<TurnRequest, NativeIngressError> {
    let object = context
        .as_object()
        .ok_or_else(|| invalid("Invalid native subsession context"))?;
    let required = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid("Invalid native subsession context"))
    };
    let role = required("role")?;
    let model = required("modelRef")?;
    let workspace = required("workspacePath")?;
    let binding = bindings
        .get_by_session_id(session_id)
        .await
        .map_err(|_| {
            NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
        })?
        .ok_or_else(|| invalid("Missing native subsession binding"))?;
    let expected_role = match role {
        "steward" => SessionRole::Steward,
        "worker" => SessionRole::Worker,
        _ => return Err(invalid("Invalid native subsession role")),
    };
    if binding.role != expected_role
        || envelope.peer.id != session_id
        || binding.model_ref != model
        || binding.workspace_path != workspace
        || binding
            .metadata
            .as_ref()
            .and_then(|value| value.get("subsession"))
            .is_none()
    {
        return Err(invalid("Native subsession binding mismatch"));
    }
    let content = envelope
        .message
        .text
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid("Missing user message"))?
        .to_owned();
    let turn_role = if expected_role == SessionRole::Steward {
        TurnRole::Steward
    } else {
        TurnRole::Worker
    };
    Ok(TurnRequest {
        turn_id: turn_id.into(),
        recovery_attempt: None,
        session_id: binding.session_id,
        event_id: envelope.event_id.clone(),
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
            role: turn_role,
            workspace_path: binding.workspace_path,
            project_id: binding.project_id,
            reason: Some("native-subsession".into()),
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: Some("safe_fallback".into()),
        app_turn_context: Some(
            json!({"session":{"id":session_id},"contentParts":[{"type":"text","text":content}]}),
        ),
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: None,
        preparation_cancellation: CancellationToken::new(),
    })
}
