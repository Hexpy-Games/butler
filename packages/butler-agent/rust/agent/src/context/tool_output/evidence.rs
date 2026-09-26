//! Source raw-tool evidence rehydration through the existing output owner.

use std::path::Path;

use serde_json::Value;

use super::{
    ArtifactStream, ContextError, ContextResult, OwnedDefaultTokenEstimator, ReadToolEvidenceInput,
    ReadToolOutputInput, reader, wire,
};
use crate::{
    context::tool_artifact_slice::{SliceInput, slice_tool_artifact_text},
    json::JsonDocument,
};

const SCHEMA: &str = "butler.raw-tool-artifact.v1";

pub(super) fn read(
    root: &Path,
    estimator: &OwnedDefaultTokenEstimator,
    input: ReadToolEvidenceInput,
) -> ContextResult<JsonDocument> {
    let artifact_root = root.join("artifacts/tool-evidence");
    let reference = ReadToolOutputInput {
        artifact_id: input.artifact_id,
        path: input.path,
        stream: ArtifactStream::Both,
        offset_lines: None,
        offset_chars: None,
        search: None,
        limit_lines: None,
        max_tokens: None,
        max_artifact_scan_files: input.max_artifact_scan_files,
    };
    let path = match reader::reference(&artifact_root, &reference, Some(SCHEMA))? {
        Ok(path) => path,
        Err(error) => return failure(error),
    };
    if !path.exists() {
        return failure("artifact_not_found");
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return failure("artifact_unreadable"),
    };
    let artifact: Value = match serde_json::from_slice(&bytes) {
        Ok(artifact) => artifact,
        Err(_) => return failure("artifact_unreadable"),
    };
    let Some(text) = artifact
        .get("serialized_text")
        .and_then(Value::as_str)
        .filter(|_| artifact.get("schema").and_then(Value::as_str) == Some(SCHEMA))
    else {
        return failure("artifact_invalid");
    };
    let offset_lines = input.offset_lines.map(nonnegative_trunc).unwrap_or(0);
    let offset_chars = input
        .offset_chars
        .filter(|value| value.is_finite())
        .map(nonnegative_trunc);
    let limit_lines = input.limit_lines.unwrap_or(80.0).trunc().clamp(1.0, 500.0) as usize;
    let max_tokens = input
        .max_tokens
        .unwrap_or(1_200.0)
        .trunc()
        .clamp(50.0, 8_000.0) as usize;
    let slice = slice_tool_artifact_text(
        estimator,
        SliceInput {
            text,
            offset_lines,
            offset_chars,
            search: None,
            limit_lines,
            max_tokens,
        },
    )?;
    let mut document = String::from(
        "{\"schema_version\":\"butler.tool-evidence-rehydration.v1\",\"terminal_evidence_observation\":true,\"ok\":true,\"rawTextStored\":false,\"artifact\":{",
    );
    document.push_str("\"id\":");
    let id = artifact
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    wire::append_string(&mut document, &id)?;
    document.push_str(",\"path\":");
    wire::append_path(&mut document, &path)?;
    for (key, source) in [
        ("created_at", "created_at"),
        ("tool_name", "tool_name"),
        ("tool_call_id", "tool_call_id"),
        ("turn_id", "turn_id"),
        ("semantic_work_block_id", "semantic_work_block_id"),
        ("digest", "digest"),
    ] {
        document.push_str(",\"");
        document.push_str(key);
        document.push_str("\":");
        wire::append_optional_string(&mut document, artifact.get(source).and_then(Value::as_str))?;
    }
    document.push_str(",\"raw_tokens\":");
    wire::append_optional_number(
        &mut document,
        artifact.get("raw_estimated_tokens").and_then(Value::as_f64),
    )?;
    document.push_str("},\"text\":");
    wire::append_slice(&mut document, &slice)?;
    document.push('}');
    JsonDocument::from_encoded(document)
        .map_err(|error| ContextError::new("tool_evidence_json_error", error.to_string()))
}

fn failure(error: &str) -> ContextResult<JsonDocument> {
    let mut document = String::from("{\"ok\":false,\"error\":");
    wire::append_string(&mut document, error)?;
    document.push_str(",\"rawTextStored\":false}");
    JsonDocument::from_encoded(document)
        .map_err(|error| ContextError::new("tool_evidence_json_error", error.to_string()))
}
fn nonnegative_trunc(value: f64) -> usize {
    value.trunc().max(0.0) as usize
}
