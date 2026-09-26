use serde_json::{Map, Value};

use super::{js_truthy, object};
use crate::btcc::identity::digest;
use crate::btcc::{
    BtccError, ProgressDestination, SessionRole as BtccRole, TurnRecord, TurnRequest, TurnTrigger,
};
use crate::conversation::{ConversationEnvelope, DurableSessionBinding};
use crate::json::stringify;
use crate::workspace::{SessionLifecycleState, SessionRole as WorkspaceRole, StoredSessionBinding};

pub(super) fn assert_replay_identity(
    turn: &TurnRecord,
    request: &TurnRequest,
) -> Result<(), BtccError> {
    let (message_id, wake) = match &request.trigger {
        TurnTrigger::UserMessage => (&request.message.id, None),
        TurnTrigger::AuthorizedWake {
            trigger_id,
            source_turn_id,
            authorization_ref,
            result_scope_ref,
        } => (
            trigger_id,
            Some((
                trigger_id,
                source_turn_id,
                authorization_ref,
                result_scope_ref,
            )),
        ),
    };
    let admitted = turn.context.get("messageContent");
    let replay = match &request.trigger {
        TurnTrigger::UserMessage => message_content(request),
        TurnTrigger::AuthorizedWake { .. } => None,
    };
    let basic = turn.session_id == request.session_id
        && turn.trigger_key == request.event_id
        && turn.original_message_id == *message_id
        && turn.original_message == request.message.content
        && admitted == replay;
    let wake_matches = match (wake, turn.wake_identity.as_ref()) {
        (None, None) => true,
        (Some((trigger, source, authority, result)), Some(stored)) => {
            stored.trigger_id == *trigger
                && stored.source_turn_id == *source
                && stored.authorization_ref == *authority
                && stored.result_scope_ref.as_deref()
                    == result.as_deref().filter(|value| !value.is_empty())
        }
        _ => false,
    };
    if basic && wake_matches {
        Ok(())
    } else {
        Err(BtccError::new(
            "turn_replay_conflict",
            format!(
                "BTCC run replay does not match admitted Turn: {}",
                turn.turn_id
            ),
        ))
    }
}

pub(super) fn assert_binding_role(
    binding: &StoredSessionBinding,
    request: &TurnRequest,
) -> Result<(), BtccError> {
    let matches = matches!(
        (&binding.role, &request.route.role),
        (WorkspaceRole::Butler, BtccRole::Butler)
            | (WorkspaceRole::Steward, BtccRole::Steward)
            | (WorkspaceRole::Worker, BtccRole::Worker)
    );
    if matches {
        Ok(())
    } else {
        Err(BtccError::new(
            "session_binding_role_mismatch",
            format!("Stored session {} has a different role", request.session_id),
        ))
    }
}

pub(super) fn replay_binding(
    turn: &TurnRecord,
    request: &TurnRequest,
) -> Result<StoredSessionBinding, BtccError> {
    let policy = object(turn.context.get("executionPolicy"));
    let role = match policy.get("role").and_then(Value::as_str) {
        Some("steward") => WorkspaceRole::Steward,
        Some("worker") => WorkspaceRole::Worker,
        _ => WorkspaceRole::Butler,
    };
    let selection = turn.model_selection.as_object().ok_or_else(|| {
        BtccError::new(
            "turn_replay_model_invalid",
            "BTCC replay model selection is invalid",
        )
    })?;
    let provider = required_string(selection, "provider")?;
    let model = required_string(selection, "model")?;
    let mut metadata = Map::new();
    metadata.insert(
        "accessMode".into(),
        policy
            .get("accessMode")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| "read_only".into()),
    );
    metadata.insert(
        "reasoning_effort".into(),
        selection
            .get("reasoningEffort")
            .cloned()
            .unwrap_or(Value::Null),
    );
    Ok(StoredSessionBinding {
        session_id: turn.session_id.clone(),
        role,
        lifecycle_state: SessionLifecycleState::Active,
        project_id: turn
            .context
            .get("projectRef")
            .and_then(Value::as_str)
            .map(str::to_owned),
        app_project_id: None,
        ledger_project_id: None,
        workspace_path: policy
            .get("workspacePath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        runtime_adapter_id: "btcc-turn-runtime".into(),
        model_provider_id: provider.clone(),
        model_ref: format!("{provider}/{model}"),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: Vec::new(),
        created_at: request.message.timestamp.clone(),
        updated_at: request.message.timestamp.clone(),
        last_active_at: None,
        metadata: Some(metadata),
    })
}

pub(super) fn resume_command(request: &TurnRequest) -> Value {
    let mut command = Map::new();
    command.insert("kind".into(), "resume".into());
    command.insert("turnId".into(), request.turn_id.clone().into());
    if let Some(attempt) = request.recovery_attempt.filter(|value| *value != 0) {
        command.insert("recoveryAttempt".into(), attempt.into());
    }
    Value::Object(command)
}

pub(super) fn fresh_command(
    request: &TurnRequest,
    model_selection: Value,
    mut context: Value,
) -> Result<Value, BtccError> {
    apply_request_context(request, &mut context)?;
    let mut command = Map::new();
    match &request.trigger {
        TurnTrigger::UserMessage => {
            command.insert("kind".into(), "run".into());
        }
        TurnTrigger::AuthorizedWake { .. } => {
            command.insert("kind".into(), "wake".into());
        }
    }
    command.insert("turnId".into(), request.turn_id.clone().into());
    if let Some(attempt) = request.recovery_attempt.filter(|value| *value != 0) {
        command.insert("recoveryAttempt".into(), attempt.into());
    }
    command.insert("sessionId".into(), request.session_id.clone().into());
    command.insert("triggerKey".into(), request.event_id.clone().into());
    match &request.trigger {
        TurnTrigger::UserMessage => {
            command.insert(
                "message".into(),
                Value::Object(Map::from_iter([
                    ("messageId".into(), request.message.id.clone().into()),
                    ("content".into(), request.message.content.clone().into()),
                ])),
            );
        }
        TurnTrigger::AuthorizedWake {
            trigger_id,
            source_turn_id,
            authorization_ref,
            result_scope_ref,
        } => {
            let mut trigger = Map::new();
            trigger.insert("triggerId".into(), trigger_id.clone().into());
            trigger.insert("sourceTurnId".into(), source_turn_id.clone().into());
            trigger.insert("authorizationRef".into(), authorization_ref.clone().into());
            if let Some(reference) = result_scope_ref.as_ref().filter(|value| !value.is_empty()) {
                trigger.insert("resultScopeRef".into(), reference.clone().into());
                append_unique(&mut context, "baselineObservationScopeRefs", reference)?;
            }
            trigger.insert("content".into(), request.message.content.clone().into());
            command.insert("trigger".into(), Value::Object(trigger));
        }
    }
    command.insert("modelSelection".into(), model_selection);
    command.insert("progressDestination".into(), destination(request)?);
    command.insert("context".into(), context);
    Ok(Value::Object(command))
}

pub(super) fn admission_hash(command: &Value) -> Result<String, BtccError> {
    let command = command
        .as_object()
        .ok_or_else(|| BtccError::new("command_invalid", "BTCC command is invalid"))?;
    if command.get("kind").and_then(Value::as_str) == Some("resume") {
        return Ok(String::new());
    }
    let mut identity = Map::new();
    for key in ["turnId", "sessionId", "triggerKey"] {
        identity.insert(key.into(), command.get(key).cloned().unwrap_or(Value::Null));
    }
    let source = if command.get("kind").and_then(Value::as_str) == Some("run") {
        "message"
    } else {
        "trigger"
    };
    identity.insert(
        "source".into(),
        command.get(source).cloned().unwrap_or(Value::Null),
    );
    identity.insert(
        "modelSelection".into(),
        command
            .get("modelSelection")
            .cloned()
            .unwrap_or(Value::Null),
    );
    identity.insert(
        "context".into(),
        command.get("context").cloned().unwrap_or(Value::Null),
    );
    Ok(digest(
        &stringify(&Value::Object(identity)).map_err(json_error)?,
    ))
}

pub(super) fn conversation_binding(binding: &StoredSessionBinding) -> DurableSessionBinding {
    DurableSessionBinding {
        session_id: binding.session_id.clone(),
        project_id: binding.project_id.clone(),
        role: role_text(&binding.role).into(),
        model_ref: binding.model_ref.clone(),
    }
}

pub(super) fn conversation_envelope(request: &TurnRequest) -> ConversationEnvelope {
    ConversationEnvelope {
        transport: request.transport.clone(),
        event_id: request.event_id.clone(),
        message_text: request.message.content.clone(),
        content_parts: message_content(request).cloned(),
    }
}

fn apply_request_context(request: &TurnRequest, context: &mut Value) -> Result<(), BtccError> {
    let fields = context
        .as_object_mut()
        .ok_or_else(|| BtccError::new("context_invalid", "BTCC context is invalid"))?;
    let app = request.app_turn_context.as_ref().and_then(Value::as_object);
    if let Some(app) = app {
        if let Some(id) = app
            .get("session")
            .and_then(Value::as_object)
            .and_then(|v| v.get("id"))
        {
            fields.insert("appSessionId".into(), id.clone());
        }
        for (source, target) in [
            ("branchSeed", "branchSeed"),
            ("contentParts", "messageContent"),
        ] {
            if let Some(value) = app.get(source).filter(|value| js_truthy(value)) {
                fields.insert(target.into(), value.clone());
            }
        }
        for (source, target, tool) in [
            ("projectSources", "projectSources", "read_project_source"),
            (
                "sessionReferences",
                "sessionReferences",
                "read_conversation_session",
            ),
        ] {
            if let Some(Value::Array(values)) = app
                .get(source)
                .filter(|value| value.as_array().is_some_and(|v| !v.is_empty()))
            {
                fields.insert(target.into(), Value::Array(values.clone()));
                append_required_tool(fields, tool);
            }
        }
    }
    if let Some(policy) = request
        .empty_response_policy
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        fields.insert("emptyResponsePolicy".into(), policy.clone().into());
    }
    Ok(())
}

fn destination(request: &TurnRequest) -> Result<Value, BtccError> {
    let value = request
        .progress_destination
        .clone()
        .unwrap_or_else(|| ProgressDestination {
            transport: request.transport.clone(),
            account_id: request.account_id.clone(),
            peer: request.peer.clone(),
            reply_to_message_id: request.message.id.clone(),
            app_queue_claim_id: None,
        });
    let mut value = serde_json::to_value(value).map_err(json_error)?;
    if let Some(claim) = request
        .app_queue_claim_id
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        value
            .as_object_mut()
            .expect("serialized destination")
            .insert("appQueueClaimId".into(), claim.clone().into());
    }
    Ok(value)
}

fn append_required_tool(fields: &mut Map<String, Value>, tool: &str) {
    let Some(policy) = fields
        .get_mut("executionPolicy")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let values = policy
        .entry("requiredNativeTools")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(values) = values.as_array_mut() else {
        return;
    };
    if !values.iter().any(|value| value.as_str() == Some(tool)) {
        values.push(tool.into());
    }
}
fn append_unique(context: &mut Value, field: &str, value: &str) -> Result<(), BtccError> {
    let object = context
        .as_object_mut()
        .ok_or_else(|| BtccError::new("context_invalid", "BTCC context is invalid"))?;
    let values = object
        .entry(field)
        .or_insert_with(|| Value::Array(Vec::new()));
    let values = values
        .as_array_mut()
        .ok_or_else(|| BtccError::new("context_invalid", "BTCC observation scope is invalid"))?;
    if !values.iter().any(|item| item.as_str() == Some(value)) {
        values.push(value.into());
    }
    Ok(())
}
fn message_content(request: &TurnRequest) -> Option<&Value> {
    request
        .app_turn_context
        .as_ref()?
        .as_object()?
        .get("contentParts")
}
fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, BtccError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            BtccError::new(
                "turn_replay_model_invalid",
                "BTCC replay model selection is invalid",
            )
        })
}
fn role_text(role: &WorkspaceRole) -> &str {
    match role {
        WorkspaceRole::Butler => "butler",
        WorkspaceRole::Steward => "steward",
        WorkspaceRole::Worker => "worker",
        WorkspaceRole::Unknown(value) => value,
    }
}
fn json_error(error: impl std::fmt::Display) -> BtccError {
    BtccError::new("btcc_json_error", error.to_string())
}
