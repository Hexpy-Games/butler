//! Public memory-write adapters using the current Turn's canonical provenance.
mod services;
pub(crate) use services::MemoryWriteServices;

use butler_core::tool_protocol::ToolName;
use serde_json::{Map, Value, json};

use butler_core::json::JsonDocument;
use butler_memory::cognition::{
    ExplicitMemoryUpdateInput, RememberedRuleReceipt, RememberedRuleTarget,
    TaskMemoryIngestionResult, ingest_task_outcome_memory,
};
use butler_turn::btcc::{
    ApprovalExemptAction, GuidedInvocation, ModelRoundToolCall, ToolExecutionError,
};
use butler_turn::conversation::{
    CanonicalMemoryReadBinding, PublicMemorySnapshot, conversation_store_path,
};

use super::GuidedTools;

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(ToolName::IngestTaskMemory | ToolName::UpdateExplicitMemory)
    )
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if !owner
        .binding
        .access_mode
        .allows_without_approval(ApprovalExemptAction::MemorySave)
    {
        return encoded(&json!({
            "ok":false,
            "error":{"code":"memory_write_requires_full_access",
                "message":"This Turn is read-only; no memory change was applied."}
        }));
    }
    let result = match call.name.as_str() {
        "ingest_task_memory" => ingest(owner, &call.arguments),
        "update_explicit_memory" => update(owner, invocation, &call.arguments, call_id).await,
        // Dispatch routes only supported names here.
        _ => json!({"ok":false,"error":{"code":"unknown_tool",
            "message":"This tool is not a memory write tool."}}),
    };
    encoded(&result)
}

fn ingest(owner: &GuidedTools, args: &Map<String, Value>) -> Value {
    let task_id = args
        .get("task_id")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let Some(task_id) = task_id else {
        return failure(
            "ingest_task_memory_requires_task_id",
            "ingest_task_memory requires task_id",
        );
    };
    match ingest_task_outcome_memory(
        &owner.binding.butler_data,
        &owner.memory_writes.paths,
        &owner.memory_writes.publisher,
        task_id,
    ) {
        Ok(result) => task_result(result),
        Err(error) => cognition_failure(error.code(), &error.message()),
    }
}

async fn update(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    args: &Map<String, Value>,
    call_id: &str,
) -> Value {
    let (conversation_session_id, conversation_message_id) =
        match canonical_authored_source(owner, invocation).await {
            Ok(binding) => binding,
            Err(code) => return binding_failure(code),
        };
    let text = match remember_text(args) {
        Ok(text) => text,
        Err(error) => return error,
    };
    let input = ExplicitMemoryUpdateInput {
        text: text.to_owned(),
        operation_id: Some(call_id.to_owned()),
        project_id: owner.binding.memory.project_id.clone(),
        conversation_session_id,
        conversation_message_id,
    };
    let result = if let Some(handle) = args.get("replaces") {
        let target = match selected_target(owner, invocation, handle) {
            Ok(target) => target,
            Err(error) => return error,
        };
        owner
            .memory_writes
            .rules
            .correct(target, input, invocation.cancellation.clone())
            .await
    } else {
        owner
            .memory_writes
            .rules
            .remember(input, invocation.cancellation.clone())
            .await
    };
    match result {
        Ok(result) => explicit_result(&result),
        Err(error) => cognition_failure(error.code(), &error.message()),
    }
}

fn remember_text(args: &Map<String, Value>) -> Result<&str, Value> {
    if args.get("kind").and_then(Value::as_str).map(str::trim) != Some("rule") {
        return Err(failure(
            "update_explicit_memory_requires_kind_rule",
            "Use kind rule.",
        ));
    }
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !butler_core::public_text::trim_js_whitespace(text).is_empty())
        .ok_or_else(|| {
            failure(
                "update_explicit_memory_requires_text",
                "Rule text is required.",
            )
        })?;
    require_source(args)?;
    Ok(text)
}

fn require_source(args: &Map<String, Value>) -> Result<(), Value> {
    args.get("source")
        .and_then(Value::as_str)
        .filter(|text| !butler_core::public_text::trim_js_whitespace(text).is_empty())
        .map(|_| ())
        .ok_or_else(|| failure("memory_write_requires_source", "Source is required."))
}

fn selected_target(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    handle: &Value,
) -> Result<RememberedRuleTarget, Value> {
    let handle = handle
        .as_str()
        .ok_or_else(|| failure("rule_handle_invalid", "Use an Active Rules handle."))?;
    let snapshot = invocation
        .turn
        .context
        .get("rememberedRuleSnapshot")
        .and_then(Value::as_array);
    let target = snapshot
        .into_iter()
        .flatten()
        .find(|row| row.get("handle").and_then(Value::as_str) == Some(handle))
        .ok_or_else(|| {
            failure(
                "rule_not_in_snapshot",
                "Rule is outside this turn's Active Rules.",
            )
        })?;
    let target: RememberedRuleTarget = serde_json::from_value(target.clone())
        .map_err(|_| failure("rule_snapshot_invalid", "Rule snapshot is unavailable."))?;
    if target.project_id != owner.binding.memory.project_id {
        return Err(failure(
            "rule_binding_mismatch",
            "Use a chat in the rule's binding.",
        ));
    }
    Ok(target)
}

async fn canonical_authored_source(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
) -> Result<(Option<String>, Option<String>), &'static str> {
    let runtime_session_id = owner.binding.memory.runtime_session_id.trim();
    let turn_id = owner.binding.memory.turn_id.trim();
    match (runtime_session_id.is_empty(), turn_id.is_empty()) {
        (true, true) => return Ok((None, None)),
        (true, false) | (false, true) => return Err("invalid_scope"),
        (false, false) => {}
    }
    if turn_id != invocation.turn.turn_id {
        return Err("invalid_scope");
    }
    let binding = CanonicalMemoryReadBinding {
        runtime_session_id: runtime_session_id.to_owned(),
        turn_id: turn_id.to_owned(),
        project_id: owner.binding.memory.project_id.clone(),
    };
    let path = conversation_store_path(&owner.binding.butler_data);
    tokio::task::spawn_blocking(move || authored_source(&path, &binding))
        .await
        .map_err(|_| "backend_unavailable")?
}

fn authored_source(
    path: &std::path::Path,
    binding: &CanonicalMemoryReadBinding,
) -> Result<(Option<String>, Option<String>), &'static str> {
    let snapshot = PublicMemorySnapshot::open(path, binding).map_err(|error| {
        if error.code() == "invalid_scope" {
            "invalid_scope"
        } else {
            "backend_unavailable"
        }
    })?;
    let selected = snapshot.authored_user_message_id();
    let session_id = snapshot.current_session_id.clone();
    let closed = snapshot.close();
    let message_id = selected.map_err(|_| "backend_unavailable")?;
    closed.map_err(|_| "backend_unavailable")?;
    let Some(message_id) = message_id else {
        return Err("invalid_scope");
    };
    Ok((Some(session_id), Some(message_id)))
}

fn task_result(result: TaskMemoryIngestionResult) -> Value {
    let mut provenance = Map::new();
    provenance.insert("task_id".into(), Value::String(result.task_id.clone()));
    provenance.insert("source".into(), Value::String("task-result".into()));
    if let Some(session_id) = result.origin_session_id {
        provenance.insert("origin_session_id".into(), Value::String(session_id));
    }
    if let Some(event_id) = result.origin_event_id {
        provenance.insert("origin_event_id".into(), Value::String(event_id));
    }
    json!({
        "ok":true,
        "task_id":result.task_id,
        "memory_path":result.memory_path.to_string_lossy(),
        "provenance":provenance,
    })
}

fn explicit_result(result: &RememberedRuleReceipt) -> Value {
    let mut value = json!({ "ok":true, "rule":result.rule, "operation_id":result.operation_id,
        "state":result.state, "replayed":result.replayed });
    if let Some(state) = &result.recall_state {
        value["recall_state"] = json!(state);
    }
    value
}

fn binding_failure(code: &'static str) -> Value {
    json!({"ok":false,"code":code,"diagnostics":[]})
}

fn failure(code: &'static str, message: &'static str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}

fn cognition_failure(code: &'static str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}

fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(butler_turn::btcc::BtccError::relayed(
            "guided_memory_write_result_json",
            error.to_string(),
        ))
    })
}
