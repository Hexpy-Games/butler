//! Public memory-write adapters using the current Turn's canonical provenance.

use serde_json::{Map, Value, json};

use crate::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use crate::cognition::{
    ExplicitMemoryUpdateInput, TaskMemoryIngestionResult, ingest_task_outcome_memory,
    update_explicit_memory,
};
use crate::conversation::{
    CanonicalMemoryReadBinding, PublicMemorySnapshot, conversation_store_path,
};
use crate::json::JsonDocument;

use super::NativeGuidedTools;

pub(super) fn supports(name: &str) -> bool {
    matches!(name, "ingest_task_memory" | "update_explicit_memory")
}

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode != AccessMode::FullAccess {
        return encoded(&json!({
            "ok":false,
            "error":{"code":"memory_write_requires_full_access",
                "message":"This Turn does not have full access; no memory change was applied."}
        }));
    }
    let result = match call.name.as_str() {
        "ingest_task_memory" => ingest(owner, &call.arguments),
        "update_explicit_memory" => update(owner, invocation, &call.arguments, call_id),
        // Dispatch routes only supported names here.
        _ => json!({"ok":false,"error":{"code":"unknown_tool",
            "message":"This tool is not a memory write tool."}}),
    };
    encoded(&result)
}

fn ingest(owner: &NativeGuidedTools, args: &Map<String, Value>) -> Value {
    let task_id = args
        .get("task_id")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let Some(task_id) = task_id else {
        return failure(
            "ingest_task_memory_requires_task_id",
            "ingest_task_memory requires task_id",
        );
    };
    match ingest_task_outcome_memory(
        &owner.binding.butler_data,
        &owner.memory_paths,
        &owner.memory_publisher,
        task_id,
    ) {
        Ok(result) => task_result(result),
        Err(error) => cognition_failure(error.code, &error.message),
    }
}

fn update(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    args: &Map<String, Value>,
    call_id: &str,
) -> Value {
    // Source binds canonical authorship before validating the model-facing
    // update fields, and never uses caller-provided scope values.
    let (conversation_session_id, conversation_message_id) =
        match canonical_authored_source(owner, invocation) {
            Ok(binding) => binding,
            Err(code) => return binding_failure(code),
        };
    if args.get("kind").and_then(Value::as_str).map(str::trim) != Some("rule") {
        return failure(
            "update_explicit_memory_requires_kind_rule",
            "update_explicit_memory requires kind rule",
        );
    }
    let Some(text) = args.get("text").and_then(Value::as_str) else {
        return failure(
            "update_explicit_memory_requires_text",
            "update_explicit_memory requires text",
        );
    };
    if crate::public_text::trim_js_whitespace(text).is_empty() {
        return failure(
            "update_explicit_memory_requires_text",
            "update_explicit_memory requires text",
        );
    }
    let source = args
        .get("source")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty());
    if source.is_none() {
        return failure(
            "update_explicit_memory_requires_source",
            "update_explicit_memory requires source",
        );
    }

    match update_explicit_memory(
        &owner.binding.butler_data,
        &owner.memory_paths,
        &owner.memory_publisher,
        &ExplicitMemoryUpdateInput {
            text: text.to_owned(),
            operation_id: Some(call_id.to_owned()),
            project_id: owner.binding.memory.project_id.clone(),
            conversation_session_id,
            conversation_message_id,
            ..ExplicitMemoryUpdateInput::default()
        },
    ) {
        Ok(result) => explicit_result(&result),
        Err(error) => cognition_failure(error.code, &error.message),
    }
}

fn canonical_authored_source(
    owner: &NativeGuidedTools,
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
    let snapshot = PublicMemorySnapshot::open(
        &conversation_store_path(&owner.binding.butler_data),
        &binding,
    )
    .map_err(|error| {
        if error.code == "invalid_scope" {
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

fn explicit_result(result: &crate::cognition::ExplicitMemoryUpdateResult) -> Value {
    json!({
        "ok":true,
        "record_id":result.record_id,
        "revision":result.revision,
        "operation_id":result.operation_id,
        "replayed":result.replayed,
    })
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
        ToolExecutionError::Integrity(crate::btcc::BtccError::new(
            "guided_memory_write_result_json",
            error.to_string(),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_write_results_never_expose_private_paths_or_internal_job_ids() {
        {
            let result = crate::cognition::ExplicitMemoryUpdateResult {
                path: "/private/data/rules/rule.md".into(),
                record_id: "record".into(),
                revision: "revision".into(),
                operation_id: "occurrence".into(),
                replayed: true,
                job_id: "internal-job".into(),
            };
            let value = explicit_result(&result);
            assert_eq!(value.as_object().unwrap().len(), 5);
            assert!(value.get("path").is_none());
            assert!(value.get("job_id").is_none());
        }
        {
            assert_eq!(
                binding_failure("invalid_scope"),
                json!({"ok":false,"code":"invalid_scope","diagnostics":[]})
            );
        }
        {
            let value = task_result(TaskMemoryIngestionResult {
                task_id: "task".into(),
                memory_path: "/data/cognition/memory/tasks/task.md".into(),
                origin_session_id: None,
                origin_event_id: None,
                job_id: "internal-job".into(),
            });
            assert_eq!(
                value["provenance"],
                json!({"task_id":"task","source":"task-result"})
            );
            assert!(value.get("job_id").is_none());
        }
    }
}
