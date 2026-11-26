use crate::btcc::RuntimeTurnEventInput;
use crate::conversation::{AgentConversationStore, ToolStepWrite};
use serde_json::Value;

pub(super) async fn record(
    store: &AgentConversationStore,
    turn_id: &str,
    event: &RuntimeTurnEventInput,
) {
    let Some(payload) = &event.payload else {
        return;
    };
    if payload.get("bridgePhase").and_then(Value::as_str) != Some("btcc_operation") {
        return;
    }
    let Some(tool_call_id) = payload.get("toolCallId").and_then(Value::as_str) else {
        return;
    };
    let status = match event.kind.as_str() {
        "tool.started" => None,
        "tool.completed"
            if payload.get("authorityPending").and_then(Value::as_bool) != Some(true) =>
        {
            Some("completed")
        }
        "tool.failed" => Some("failed"),
        "tool.cancelled" => Some("cancelled"),
        _ => return,
    };
    let step = ToolStepWrite {
        turn_id,
        tool_call_id,
        tool_name: payload.get("toolName"),
        label: payload.get("safeLabel"),
        input_label: payload.get("inputLabel").and_then(Value::as_str),
        status,
        created_at: event.created_at.as_deref(),
    };
    if let Err(error) = store.record_tool_step(step).await {
        butler_core::diagnostic!("{}", error.code());
    }
}
