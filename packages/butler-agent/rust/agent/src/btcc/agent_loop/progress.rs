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
    call_id: &str,
    tool_name: &str,
    status: Status,
    output: Option<&crate::json::JsonDocument>,
) {
    let mut event = RuntimeTurnEventInput::new(status.event_kind());
    let mut payload = json!({
        "safeLabel": tool_name,
        "toolName": tool_name,
        "toolCallId": call_id,
        "activityKind": "used_tool",
        "bridgePhase": "btcc_operation",
        "semanticBlockId": format!("tool-{call_id}"),
        "operationStatus": status.as_str(),
    })
    .as_object()
    .cloned()
    .expect("object literal");
    let encoded = output.map(crate::json::JsonDocument::as_str);
    let result_ref = encoded.map(|body| {
        let sha256 = super::super::identity::digest(body);
        let id = super::super::identity::digest(&format!("btcc-guided-tool-result.v1\0{sha256}"));
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
        let content = &bytes[byte_start..byte_end];
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
