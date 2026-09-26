//! Thin tool argument bridge; Context owns artifact authority and exact wire.

#[cfg(test)]
mod tests;

use std::path::PathBuf;

use serde_json::Value;

use crate::{
    context::{
        ArtifactStream, ContextResult, NativeToolOutput, ReadToolEvidenceInput, ReadToolOutputInput,
    },
    json::JsonDocument,
};

#[derive(Clone)]
pub(crate) struct NativeToolArtifactReader {
    output: NativeToolOutput,
}

impl NativeToolArtifactReader {
    pub(crate) fn new(output: NativeToolOutput) -> Self {
        Self { output }
    }

    pub(crate) async fn read_output(&self, args: Value) -> ContextResult<JsonDocument> {
        self.output
            .read_output_document(ReadToolOutputInput {
                artifact_id: string(&args, "artifact_id"),
                path: string(&args, "path").map(PathBuf::from),
                stream: match args.get("stream").and_then(Value::as_str) {
                    Some("stdout") => ArtifactStream::Stdout,
                    Some("stderr") => ArtifactStream::Stderr,
                    _ => ArtifactStream::Both,
                },
                offset_lines: number(&args, "offset_lines"),
                offset_chars: number(&args, "offset_chars"),
                search: args
                    .get("search")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                limit_lines: number(&args, "limit_lines"),
                max_tokens: number(&args, "max_tokens"),
                max_artifact_scan_files: None,
            })
            .await
    }

    pub(crate) async fn read_evidence(&self, args: Value) -> ContextResult<JsonDocument> {
        self.output
            .read_evidence_document(ReadToolEvidenceInput {
                artifact_id: string(&args, "artifact_id"),
                path: string(&args, "path").map(PathBuf::from),
                offset_lines: number(&args, "offset_lines"),
                offset_chars: number(&args, "offset_chars"),
                limit_lines: number(&args, "limit_lines"),
                max_tokens: number(&args, "max_tokens"),
                max_artifact_scan_files: None,
            })
            .await
    }
}

fn string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn number(args: &Value, key: &str) -> Option<f64> {
    args.get(key)
        .filter(|value| value.is_number())
        .and_then(Value::as_f64)
}
