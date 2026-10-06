//! Lifecycle seams; no dispatcher means no serialization, I/O or timers.
use super::{
    contracts::{ModelRoundToolCall, ToolResult},
    guided_ports::GuidedInvocation,
    ports::GuidedPolicyPort,
};
use butler_core::hooks::{HookEnvelope, HookEvent, HookPayload, HookToolError};
async fn emit(
    policy: &dyn GuidedPolicyPort,
    input: GuidedInvocation<'_>,
    event: HookEvent,
    key: &str,
    payload: HookPayload,
) -> Option<String> {
    let binding = policy.hooks()?;
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
        .flatten()
}
fn tool_payload(
    policy: &dyn GuidedPolicyPort,
    input: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> HookPayload {
    HookPayload {
        tool_name: Some(policy.hook_tool_name(call).into_owned()),
        tool_use_id: Some(call.id.clone()),
        tool_input: Some(policy.hook_tool_input(call).clone()),
        resumed: Some(input.turn.authority_continuation.is_some()),
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
        policy,
        input,
        HookEvent::PreToolUse,
        &call.id,
        tool_payload(policy, input, call),
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
    let mut payload = tool_payload(policy, input, call);
    payload.ok = Some(result.ok);
    payload.tool_response = result.output.clone();
    payload.error = result.error.as_ref().map(|e| HookToolError {
        code: e.code.clone(),
        message: e.message.clone(),
    });
    emit(policy, input, HookEvent::PostToolUse, &call.id, payload).await;
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
        policy,
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
