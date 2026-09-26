//! Pure planning for typed records projected into the cognition graph.

use serde_json::Value;

use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow, MEMORY_SOURCE_WINDOW_BYTES,
    split_historical_source_spans,
};

use super::identity::projection_hash;
use super::typed::TypedMemoryRecord;

const MEMORY_EXTRACTION_VERSION: &str = "memory-extract-v3";

#[derive(Clone, Debug, PartialEq)]
pub(in crate::cognition) struct TypedPlan {
    pub source_key: String,
    pub episode_id: String,
    pub revision: String,
    pub job_id: String,
    pub content_hash: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub observed_at: String,
    pub source_kind: String,
    pub record_id: String,
    pub spans: Vec<TypedSpan>,
    pub windows: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(in crate::cognition) struct TypedSpan {
    pub row: CognitionSourceRow,
    pub text: String,
}

pub(in crate::cognition) fn prepare(record: &TypedMemoryRecord) -> CognitionResult<TypedPlan> {
    let episode_id = projection_hash(vec![
        Value::String("typed-memory-record".into()),
        Value::String(record.source_kind.into()),
        Value::String(record.record_id.clone()),
    ])?;
    let job_id = projection_hash(vec![
        Value::String("memory-projection".into()),
        Value::String(episode_id.clone()),
        Value::String(record.revision.clone()),
        Value::String(MEMORY_EXTRACTION_VERSION.into()),
    ])?;

    let mut spans = Vec::new();
    for span in split_historical_source_spans(&record.text, MEMORY_SOURCE_WINDOW_BYTES) {
        if span.end - span.start > crate::json::saturating_usize(MEMORY_SOURCE_WINDOW_BYTES) {
            return Err(CognitionError::new(
                "memory_source_unavailable",
                "A grapheme exceeds the memory source window limit",
            ));
        }
        let source_id = projection_hash(vec![
            Value::String("memory-source".into()),
            Value::String(episode_id.clone()),
            Value::String(record.revision.clone()),
            Value::String(record.source_kind.into()),
            Value::String(record.record_id.clone()),
            Value::Number((span.start as u64).into()),
            Value::Number((span.end as u64).into()),
            Value::String(record.content_hash.clone()),
        ])?;
        let text = record
            .text
            .get(span.start..span.end)
            .ok_or_else(|| unavailable("Typed source span is not on UTF-8 boundaries"))?
            .to_owned();
        spans.push(TypedSpan {
            row: CognitionSourceRow {
                source_id,
                episode_id: episode_id.clone(),
                revision: record.revision.clone(),
                source_kind: record.source_kind.into(),
                conversation_session_id: record.conversation_session_id.clone(),
                conversation_message_id: record.conversation_message_id.clone(),
                part_id: record.record_id.clone(),
                scalar_pointer: "/text".into(),
                byte_start: span.start as f64,
                byte_end: span.end as f64,
                content_hash: record.content_hash.clone(),
                role: record.role.into(),
                origin_kind: "unknown".into(),
                observed_at: record.observed_at.clone(),
                basis: record.basis.into(),
            },
            text,
        });
    }
    let windows = spans
        .iter()
        .map(|span| vec![span.row.source_id.clone()])
        .collect();

    Ok(TypedPlan {
        source_key: format!("{}:{}", record.source_kind, record.record_id),
        episode_id,
        revision: record.revision.clone(),
        job_id,
        content_hash: record.content_hash.clone(),
        project_id: record.project_id.clone(),
        session_id: record.conversation_session_id.clone(),
        message_id: record.conversation_message_id.clone(),
        observed_at: record.observed_at.clone(),
        source_kind: record.source_kind.into(),
        record_id: record.record_id.clone(),
        spans,
        windows,
    })
}

fn unavailable(message: impl Into<String>) -> CognitionError {
    CognitionError::new("memory_source_unavailable", message)
}
