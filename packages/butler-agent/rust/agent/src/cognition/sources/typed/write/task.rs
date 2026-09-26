//! Reviewed task-report projection into the local task-memory owner.

use std::path::Path;

use super::{TaskMemoryIngestionResult, error, io_error, write_atomic};
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, CompletionPublisher, TypedMemorySourceNotice,
        ensure_data_authority, sources::read_typed_record,
    },
    work_records::WorkRecordReader,
};

pub(crate) fn ingest_task_outcome_memory(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    publisher: &CompletionPublisher,
    task_id: &str,
) -> CognitionResult<TaskMemoryIngestionResult> {
    let reader = WorkRecordReader::new(data_root);
    let projection = reader
        .task_memory_projection(task_id)
        .map_err(|_| error("memory_source_unavailable"))?
        .ok_or_else(|| error("task_memory_report_unavailable"))?;
    let memory_root = environment.memory_root(data_root);
    let task_memory_root = memory_root.join("tasks");
    let memory_path = task_memory_root.join(format!("{}.md", slug(task_id)));
    let queue_path = memory_root.join("queue/sync.jsonl");
    let queue_coordination_path = queue_path.with_extension("jsonl.coord.sqlite");
    ensure_data_authority(
        data_root,
        &[
            &task_memory_root,
            &memory_path,
            &queue_path,
            &queue_coordination_path,
        ],
    )?;

    let task_summary = projection
        .origin_task_summary
        .as_deref()
        .or(projection.request.as_deref())
        .unwrap_or("(unknown)");
    let origin_session_id = projection
        .origin_session_id
        .clone()
        .or(projection.plan_origin_session_id.clone());
    let origin_event_id = projection
        .origin_event_id
        .clone()
        .or(projection.plan_origin_event_id.clone());
    let mut lines = vec![
        format!("# Task Memory: {task_id}"),
        String::new(),
        "## Provenance".into(),
        format!("- task_id: {task_id}"),
        "- source: task-result".into(),
    ];
    if let Some(value) = origin_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("- origin_session_id: {value}"));
    }
    if let Some(value) = origin_event_id.as_deref().filter(|value| !value.is_empty()) {
        lines.push(format!("- origin_event_id: {value}"));
    }
    lines.extend([
        String::new(),
        "## Request".into(),
        task_summary.into(),
        String::new(),
        "## Outcome".into(),
        projection.report.text.clone(),
    ]);
    // The source writer applies filter(Boolean) to the section entries.
    lines.retain(|line| !line.is_empty());
    let body = lines.join("\n");
    let body = format!("{}\n", crate::public_text::trim_js_whitespace(&body));
    std::fs::create_dir_all(&task_memory_root).map_err(io_error)?;
    write_atomic(&memory_path, body.as_bytes())?;

    let owner = read_typed_record(
        data_root,
        &memory_root,
        "task_report",
        &projection.report.record_id,
    )?
    .ok_or_else(|| error("memory_source_unavailable"))?;
    if owner.revision != projection.report.source_revision
        || owner.record_id != projection.report.record_id
    {
        return Err(error("memory_source_changed"));
    }
    let notice = TypedMemorySourceNotice::TaskReport {
        record_id: owner.record_id,
        revision: owner.revision,
        operation_id: owner.operation_id,
    };
    let job_id = publisher.publish_typed_source(&notice)?;
    Ok(TaskMemoryIngestionResult {
        task_id: task_id.to_owned(),
        memory_path,
        origin_session_id,
        origin_event_id,
        job_id,
    })
}

fn slug(value: &str) -> String {
    let mut normalized = String::new();
    let mut separator = false;
    for character in value.to_lowercase().chars() {
        let allowed = character.is_ascii_alphanumeric()
            || ('\u{ac00}'..='\u{d7a3}').contains(&character)
            || matches!(character, '.' | '_' | '-');
        if allowed {
            if separator && !normalized.is_empty() {
                normalized.push('-');
            }
            normalized.push(character);
            separator = false;
        } else {
            separator = true;
        }
    }
    let normalized = normalized.trim_matches('-');
    let prefix = crate::json::Utf16Slice::new(normalized, 0, 80).utf8_lossy();
    if prefix.is_empty() {
        "memory".into()
    } else {
        prefix.into_owned()
    }
}
