use base64::Engine;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::btcc::{AgentLoopProgress, RuntimeTurnEventInput};

const OUTPUT_CHUNK_BYTES: usize = 32 * 1024;

pub(super) async fn model_waiting(
    progress: &dyn AgentLoopProgress,
    request_id: &str,
    status: Status,
    model_ref: Option<&str>,
) {
    if matches!(status, Status::Started)
        && let Some(model_ref) = model_ref
    {
        let mut iteration = RuntimeTurnEventInput::new("turn.iteration.started");
        iteration.payload = json!({
            "model": model_ref, "modelRef": model_ref, "requestId": request_id,
        })
        .as_object()
        .cloned();
        let _ = progress.emit(iteration).await;
    }
    let mut event = RuntimeTurnEventInput::new(status.event_kind());
    let mut payload = Map::from_iter([
        ("safeLabel".into(), Value::String("Generating".into())),
        (
            "interfaceLabelKey".into(),
            Value::String("generating".into()),
        ),
        ("toolName".into(), Value::String("model_round".into())),
        ("toolCallId".into(), Value::String(request_id.into())),
        ("activityKind".into(), Value::String("message".into())),
        (
            "bridgePhase".into(),
            Value::String("model_round_waiting".into()),
        ),
    ]);
    if let Some(model_ref) = model_ref {
        payload.insert("model".into(), Value::String(model_ref.into()));
        payload.insert("modelRef".into(), Value::String(model_ref.into()));
    }
    event.payload = Some(payload);
    let _ = progress.emit(event).await;
}

pub(super) async fn operation(
    progress: &dyn AgentLoopProgress,
    call: &super::contracts::ModelRoundToolCall,
    status: Status,
    output: Option<&butler_core::json::JsonDocument>,
    operation_call_id: Option<&str>,
) {
    let call_id = &call.id;
    let tool_name = operation_tool_name(call);
    let mut event = RuntimeTurnEventInput::new(status.event_kind());
    let mut payload = butler_core::json::json_object!({
        "safeLabel": tool_name,
        "toolName": tool_name,
        "toolCallId": call_id,
        "activityKind": "used_tool",
        "bridgePhase": "btcc_operation",
        "semanticBlockId": format!("tool-{call_id}"),
        "operationStatus": status.as_str(),
    });
    if let Some(target) = operation_target(call) {
        payload.insert("inputLabel".into(), Value::String(target));
    }
    let encoded = output.map(butler_core::json::JsonDocument::as_str);
    let result_ref = encoded.map(|body| {
        let sha256 = super::super::identity::digest(body);
        let pending = output
            .is_some_and(|output| output.field("authority_pending").ok().flatten() == Some("true"));
        let phase = if pending {
            "authority_pending"
        } else {
            "terminal"
        };
        let request_ref = output
            .filter(|_| pending)
            .and_then(|output| output.field("request_ref").ok().flatten())
            .unwrap_or_default();
        let result_call_id = operation_call_id.unwrap_or(call_id);
        let id = super::super::identity::digest(&format!(
            "btcc-guided-tool-result.v2\0{result_call_id}\0{phase}\0{request_ref}"
        ));
        payload.insert("resultId".into(), Value::String(id.clone()));
        payload.insert("resultByteLength".into(), Value::from(body.len()));
        (id, sha256)
    });
    event.payload = Some(payload);
    let _ = progress.emit(event).await;
    if matches!(status, Status::Completed)
        && let (Some(body), Some((result_id, result_sha256))) = (encoded, result_ref)
    {
        emit_output_chunks(progress, call_id, &result_id, &result_sha256, body).await;
    }
}

async fn emit_output_chunks(
    progress: &dyn AgentLoopProgress,
    request_id: &str,
    result_id: &str,
    result_sha256: &str,
    body: &str,
) {
    let bytes = body.as_bytes();
    let chunk_count = bytes.len().div_ceil(OUTPUT_CHUNK_BYTES).max(1);
    for chunk_index in 0..chunk_count {
        let byte_start = chunk_index * OUTPUT_CHUNK_BYTES;
        let byte_end = bytes.len().min(byte_start + OUTPUT_CHUNK_BYTES);
        let content = bytes.get(byte_start..byte_end).unwrap_or_default();
        let mut event = RuntimeTurnEventInput::new("operation.output.chunk");
        event.payload = json!({
            "requestId": request_id,
            "resultId": result_id,
            "resultSha256": result_sha256,
            "chunkIndex": chunk_index,
            "chunkCount": chunk_count,
            "byteStart": byte_start,
            "byteEnd": byte_end,
            "byteLength": bytes.len(),
            "contentBase64": base64::engine::general_purpose::STANDARD.encode(content),
            "contentSha256": format!("{:x}", Sha256::digest(content)),
        })
        .as_object()
        .cloned();
        let _ = progress.emit(event).await;
    }
}

#[derive(Clone, Copy)]
pub(super) enum Status {
    Started,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    fn event_kind(self) -> &'static str {
        match self {
            Self::Started => "tool.started",
            Self::Completed => "tool.completed",
            Self::Failed => "tool.failed",
            Self::Cancelled => "tool.cancelled",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

fn operation_target(call: &super::contracts::ModelRoundToolCall) -> Option<String> {
    let keys: &[&str] = match call.name.as_str() {
        "run_command" => &["command"],
        "write_file" | "edit_file" | "read_file" => &["path"],
        "list_files" | "grep_files" => &["path", "directory", "root"],
        _ => return None,
    };
    keys.iter()
        .find_map(|key| call.arguments.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| {
            call.arguments
                .get("requests")
                .or_else(|| call.arguments.get("edits"))
                .and_then(Value::as_array)
                .map(|requests| {
                    requests
                        .iter()
                        .filter_map(|request| request.get("path").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|value| !value.is_empty())
        })
        .or_else(|| (call.name == "list_files").then(|| ".".into()))
}

fn operation_tool_name(call: &super::contracts::ModelRoundToolCall) -> &str {
    if call.name == "tool_call"
        && let Some(name) = call
            .arguments
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| id.strip_prefix("native:"))
        && matches!(
            name,
            "browser_open"
                | "browser_observe"
                | "browser_act"
                | "browser_tabs"
                | "browser_close"
                | "browser_wait_for_user"
        )
    {
        name
    } else {
        &call.name
    }
}
