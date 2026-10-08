use serde_json::{Map, Value};

use super::{js_truthy, object};
use crate::btcc::BtccCode;
use crate::btcc::identity::digest;
use crate::btcc::{
    BtccError, CommandMessage, CommandModelSelection, CommandTrigger, ProgressDestination,
    ResumeCommand, RunCommand, SessionRole as BtccRole, TurnCommand, TurnRecord, TurnRequest,
    TurnTrigger, WakeCommand,
};
use crate::conversation::{ConversationEnvelope, DurableSessionBinding};
use crate::workspace::{SessionLifecycleState, SessionRole as WorkspaceRole, StoredSessionBinding};
use butler_core::json::stringify;

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
        && turn.turn_id == request.turn_id;
    if turn.original_message != request.message.content || (!request.resume && admitted != replay) {
        butler_core::diagnostic!("warning: replay content mismatch for turn {}", turn.turn_id);
    }
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
        Err(BtccError::detected(
            BtccCode::TurnReplayConflict,
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
        Err(BtccError::detected(
            BtccCode::SessionBindingRoleMismatch,
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
    let selection = &turn.model_selection;
    let provider = selection.provider.clone();
    let model = &selection.model;
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
        serde_json::to_value(&selection.reasoning_effort).map_err(json_error)?,
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

pub(super) fn resume_command(request: &TurnRequest) -> TurnCommand {
    TurnCommand::Resume(ResumeCommand {
        turn_id: request.turn_id.clone(),
        recovery_attempt: recovery_attempt(request),
    })
}

fn recovery_attempt(request: &TurnRequest) -> Option<u32> {
    request.recovery_attempt.filter(|value| *value != 0)
}

// Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
pub(super) fn fresh_command(
    request: &TurnRequest,
    model_selection: CommandModelSelection,
    mut context: Value,
) -> Result<TurnCommand, BtccError> {
    apply_request_context(request, &mut context)?;
    let turn_id = request.turn_id.clone();
    let session_id = request.session_id.clone();
    let trigger_key = request.event_id.clone();
    Ok(match &request.trigger {
        TurnTrigger::UserMessage => TurnCommand::Run(RunCommand {
            turn_id,
            recovery_attempt: recovery_attempt(request),
            session_id,
            trigger_key,
            message: CommandMessage {
                message_id: request.message.id.clone(),
                content: request.message.content.clone(),
            },
            model_selection,
            progress_destination: Some(destination(request)),
            context,
        }),
        TurnTrigger::AuthorizedWake {
            trigger_id,
            source_turn_id,
            authorization_ref,
            result_scope_ref,
        } => {
            let result_scope_ref = result_scope_ref
                .as_ref()
                .filter(|value| !value.is_empty())
                .cloned();
            if let Some(reference) = &result_scope_ref {
                append_unique(&mut context, "baselineObservationScopeRefs", reference)?;
            }
            TurnCommand::Wake(WakeCommand {
                turn_id,
                recovery_attempt: recovery_attempt(request),
                session_id,
                trigger_key,
                trigger: CommandTrigger {
                    trigger_id: trigger_id.clone(),
                    source_turn_id: source_turn_id.clone(),
                    authorization_ref: authorization_ref.clone(),
                    result_scope_ref,
                    content: request.message.content.clone(),
                },
                model_selection,
                progress_destination: Some(destination(request)),
                context,
            })
        }
    })
}

/// The fields of a fresh command its admission identity is hashed over.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AdmissionIdentity<'a> {
    turn_id: &'a str,
    session_id: &'a str,
    trigger_key: &'a str,
    source: AdmissionSource<'a>,
    model_selection: &'a CommandModelSelection,
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    context: &'a Value,
}

#[derive(serde::Serialize)]
#[serde(untagged)]
enum AdmissionSource<'a> {
    Message(&'a CommandMessage),
    Trigger(&'a CommandTrigger),
}

pub(super) fn admission_hash(command: &TurnCommand) -> Result<String, BtccError> {
    let identity = match command {
        TurnCommand::Resume(_) => return Ok(String::new()),
        TurnCommand::Run(run) => AdmissionIdentity {
            turn_id: &run.turn_id,
            session_id: &run.session_id,
            trigger_key: &run.trigger_key,
            source: AdmissionSource::Message(&run.message),
            model_selection: &run.model_selection,
            context: &run.context,
        },
        TurnCommand::Wake(wake) => AdmissionIdentity {
            turn_id: &wake.turn_id,
            session_id: &wake.session_id,
            trigger_key: &wake.trigger_key,
            source: AdmissionSource::Trigger(&wake.trigger),
            model_selection: &wake.model_selection,
            context: &wake.context,
        },
    };
    let identity = serde_json::to_value(identity).map_err(json_error)?;
    Ok(digest(&stringify(&identity).map_err(json_error)?))
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
        resume: request.resume,
    }
}

// Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
fn apply_request_context(request: &TurnRequest, context: &mut Value) -> Result<(), BtccError> {
    let fields = context
        .as_object_mut()
        .ok_or_else(|| BtccError::detected(BtccCode::ContextInvalid, "BTCC context is invalid"))?;
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
            ("defaultProjectFolder", "defaultProjectFolder"),
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

fn destination(request: &TurnRequest) -> ProgressDestination {
    let mut destination =
        request
            .progress_destination
            .clone()
            .unwrap_or_else(|| ProgressDestination {
                transport: request.transport.clone(),
                account_id: request.account_id.clone(),
                peer: request.peer.clone(),
                reply_to_message_id: request.message.id.clone(),
                app_queue_claim_id: None,
            });
    if let Some(claim) = request
        .app_queue_claim_id
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        destination.app_queue_claim_id = Some(claim.clone());
    }
    destination
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
// Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
fn append_unique(context: &mut Value, field: &str, value: &str) -> Result<(), BtccError> {
    let object = context
        .as_object_mut()
        .ok_or_else(|| BtccError::detected(BtccCode::ContextInvalid, "BTCC context is invalid"))?;
    let values = object
        .entry(field)
        .or_insert_with(|| Value::Array(Vec::new()));
    let values = values.as_array_mut().ok_or_else(|| {
        BtccError::detected(
            BtccCode::ContextInvalid,
            "BTCC observation scope is invalid",
        )
    })?;
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
fn role_text(role: &WorkspaceRole) -> &str {
    match role {
        WorkspaceRole::Butler => "butler",
        WorkspaceRole::Steward => "steward",
        WorkspaceRole::Worker => "worker",
        WorkspaceRole::Unknown(value) => value,
    }
}
fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> BtccError {
    BtccError::detected(BtccCode::BtccJsonError, error.to_string()).with_source(error)
}
