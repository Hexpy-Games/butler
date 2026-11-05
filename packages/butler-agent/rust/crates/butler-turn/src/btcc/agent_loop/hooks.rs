//! Lifecycle seams; no dispatcher means no serialization, I/O or timers.
use super::{
    contracts::{ModelRoundToolCall, ToolResult},
    guided_ports::{GuidedHookBinding, GuidedInvocation},
    ports::GuidedPolicyPort,
};
use butler_core::hooks::{HookEnvelope, HookEvent, HookPayload, HookToolError};
async fn emit(
    binding: &GuidedHookBinding,
    input: GuidedInvocation<'_>,
    event: HookEvent,
    key: &str,
    payload: HookPayload,
) -> Option<String> {
    let envelope = HookEnvelope {
        schema: "butler.hook.v1".into(),
        hook_event_name: event,
        event_id: format!("evt_{}_{}_{key}", input.turn.turn_id, event as u8),
        occurred_at: chrono::Utc::now().to_rfc3339(),
        session_id: Some(input.turn.session_id.clone()),
        turn_id: Some(input.turn.turn_id.clone()),
        parent_session_id: binding.parent_session_id.clone(),
        project_dir: binding.project_dir.clone(),
        cwd: binding.cwd.clone(),
        access_mode: Some(binding.access_mode.clone()),
        payload,
    };
    binding
        .port
        .dispatch(envelope, input.cancellation.child_token())
        .await
        .ok()
        .and_then(|dispatched| dispatched.deny)
}
fn tool_payload(
    name: &str,
    tool_input: &serde_json::Map<String, serde_json::Value>,
    input: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> HookPayload {
    HookPayload {
        tool_name: Some(name.to_owned()),
        tool_use_id: Some(call.id.clone()),
        tool_input: Some(tool_input.clone()),
        resumed: Some(input.turn.authority_continuation.as_ref().is_some_and(|c| {
            c.batch
                .calls
                .get(c.batch.next_call_index)
                .is_some_and(|pending| pending.id == call.id)
        })),
        ..HookPayload::default()
    }
}
pub(super) async fn pre_tool(
    policy: &dyn GuidedPolicyPort,
    input: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Option<String> {
    if !policy
        .hooks()
        .is_some_and(|h| h.port.event_enabled(HookEvent::PreToolUse))
    {
        return None;
    }
    let name = policy.hook_tool_name(call);
    if !policy
        .hooks()?
        .port
        .enabled(HookEvent::PreToolUse, Some(&name))
    {
        return None;
    }
    emit(
        policy.hooks()?,
        input,
        HookEvent::PreToolUse,
        &call.id,
        tool_payload(&name, policy.hook_tool_input(call), input, call),
    )
    .await
}
pub(super) async fn post_tool(
    policy: &dyn GuidedPolicyPort,
    input: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    result: &ToolResult,
) {
    if !policy
        .hooks()
        .is_some_and(|h| h.port.event_enabled(HookEvent::PostToolUse))
    {
        return;
    }
    if result
        .output
        .as_ref()
        .is_some_and(|output| output.field("authority_pending").ok().flatten() == Some("true"))
    {
        return; // Awaiting approval is not a final tool result.
    }
    let name = policy.hook_tool_name(call);
    if !policy
        .hooks()
        .is_some_and(|h| h.port.enabled(HookEvent::PostToolUse, Some(&name)))
    {
        return;
    }
    let mut payload = tool_payload(&name, policy.hook_tool_input(call), input, call);
    payload.ok = Some(result.ok);
    payload.tool_response = result.output.clone();
    payload.error = result.error.as_ref().map(|e| HookToolError {
        code: e.code.clone(),
        message: e.message.clone(),
    });
    if let Some(binding) = policy.hooks() {
        emit(binding, input, HookEvent::PostToolUse, &call.id, payload).await;
    }
}

/// PreToolUse for a call a tool makes on the model's behalf, under its own name.
/// Returns the denial reason, if a hook denied it.
pub async fn nested_pre_tool(
    binding: &GuidedHookBinding,
    input: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Option<String> {
    if !binding.port.event_enabled(HookEvent::PreToolUse)
        || !binding
            .port
            .enabled(HookEvent::PreToolUse, Some(&call.name))
    {
        return None;
    }
    let payload = tool_payload(&call.name, &call.arguments, input, call);
    emit(binding, input, HookEvent::PreToolUse, &call.id, payload).await
}

/// PostToolUse for a call a tool made on the model's behalf, under its own name.
pub async fn nested_post_tool(
    binding: &GuidedHookBinding,
    input: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    ok: bool,
    response: Option<butler_core::json::JsonDocument>,
) {
    if !binding.port.event_enabled(HookEvent::PostToolUse)
        || !binding
            .port
            .enabled(HookEvent::PostToolUse, Some(&call.name))
    {
        return;
    }
    let mut payload = tool_payload(&call.name, &call.arguments, input, call);
    payload.ok = Some(ok);
    payload.tool_response = response;
    emit(binding, input, HookEvent::PostToolUse, &call.id, payload).await;
}
pub(super) async fn stop(
    policy: &dyn GuidedPolicyPort,
    input: GuidedInvocation<'_>,
    text: &str,
    active: bool,
    iteration: u32,
) -> Option<String> {
    let binding = policy.hooks()?;
    let event = if binding.parent_session_id.is_some() {
        HookEvent::SubagentStop
    } else {
        HookEvent::Stop
    };
    if !binding.port.enabled(event, None) {
        return None;
    }
    emit(
        binding,
        input,
        event,
        &iteration.to_string(),
        HookPayload {
            last_assistant_message: Some(text.into()),
            stop_hook_active: Some(active),
            ..HookPayload::default()
        },
    )
    .await
}
