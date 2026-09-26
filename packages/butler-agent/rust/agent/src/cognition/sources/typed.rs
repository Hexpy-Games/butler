//! Read-only explicit-rule source owner; task reports come from Work Records.

use std::{fs, path::Path};

mod write;

pub(crate) use write::{
    ExplicitMemoryUpdateInput, ExplicitMemoryUpdateResult, TaskMemoryIngestionResult,
    ingest_task_outcome_memory, update_explicit_memory,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cognition::{CognitionError, CognitionResult, CognitionSourceRow};
use crate::work_records::{ReadAvailability, WorkRecordReader, task_id_from_memory_record_id};

#[derive(Clone, Debug)]
pub(in crate::cognition) struct TypedMemoryRecord {
    pub source_kind: &'static str,
    pub record_kind: &'static str,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub text: String,
    pub content_hash: String,
    pub project_id: Option<String>,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub observed_at: String,
    pub role: &'static str,
    pub basis: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ExplicitRuleBinding {
    schema: String,
    state: String,
    record_id: String,
    revision: String,
    operation_id: String,
    content_hash: String,
    project_id: Option<String>,
    conversation_session_id: Option<String>,
    conversation_message_id: Option<String>,
    observed_at: String,
    operations: Vec<RuleOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RuleOperation {
    operation_id: String,
    revision: String,
    state: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::cognition) enum ExplicitRuleLifecycle {
    Current,
    Superseded,
    Forgotten,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::cognition) enum TaskReportLifecycle {
    Current,
    Superseded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TypedMemoryLifecycle {
    Current,
    Superseded,
    Forgotten,
}

pub(in crate::cognition) fn read_typed_memory_lifecycle(
    data_root: &Path,
    memory_root: &Path,
    kind: &str,
    record_id: &str,
    operation_id: &str,
    revision: &str,
) -> CognitionResult<Option<TypedMemoryLifecycle>> {
    match kind {
        "explicit_record" => {
            explicit_rule_lifecycle(memory_root, record_id, operation_id, revision).map(
                |lifecycle| {
                    lifecycle.map(|lifecycle| match lifecycle {
                        ExplicitRuleLifecycle::Current => TypedMemoryLifecycle::Current,
                        ExplicitRuleLifecycle::Superseded => TypedMemoryLifecycle::Superseded,
                        ExplicitRuleLifecycle::Forgotten => TypedMemoryLifecycle::Forgotten,
                    })
                },
            )
        }
        "task_report" => {
            task_report_lifecycle(data_root, record_id, operation_id, revision).map(|lifecycle| {
                lifecycle.map(|lifecycle| match lifecycle {
                    TaskReportLifecycle::Current => TypedMemoryLifecycle::Current,
                    TaskReportLifecycle::Superseded => TypedMemoryLifecycle::Superseded,
                })
            })
        }
        _ => Ok(None),
    }
}

pub(in crate::cognition) fn read_typed_record(
    data_root: &Path,
    memory_root: &Path,
    kind: &str,
    record_id: &str,
) -> CognitionResult<Option<TypedMemoryRecord>> {
    match kind {
        "explicit_record" => read_explicit_record(memory_root, record_id),
        "task_report" => read_task_report(data_root, record_id),
        _ => Ok(None),
    }
}

/// Hydrate only the exact span pinned by a typed graph source row. The
/// snapshot root is supplied by the resolved generation, never live DATA.
pub(in crate::cognition) fn hydrate_typed_source(
    source_root: &Path,
    row: &CognitionSourceRow,
) -> CognitionResult<String> {
    if !matches!(row.source_kind.as_str(), "task_report" | "explicit_record")
        || row.scalar_pointer != "/text"
    {
        return Err(changed());
    }
    let owner = read_typed_record(
        source_root,
        &source_root.join("cognition/memory"),
        &row.source_kind,
        &row.part_id,
    )?
    .ok_or_else(changed)?;
    if owner.revision != row.revision
        || owner.content_hash != row.content_hash
        || owner.source_kind != row.source_kind
        || owner.role != row.role
        || owner.observed_at != row.observed_at
    {
        return Err(changed());
    }
    let offset = |value: f64| -> CognitionResult<usize> {
        if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > usize::MAX as f64 {
            return Err(changed());
        }
        Ok(value as usize)
    };
    let start = offset(row.byte_start)?;
    let end = offset(row.byte_end)?;
    owner
        .text
        .get(start..end)
        .map(str::to_owned)
        .ok_or_else(changed)
}

fn changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}

pub(in crate::cognition) fn read_task_report(
    data_root: &Path,
    record_id: &str,
) -> CognitionResult<Option<TypedMemoryRecord>> {
    let Some(task_id) = task_id_from_memory_record_id(record_id) else {
        return Ok(None);
    };
    let reader = WorkRecordReader::new(data_root);
    let Some(report) = reader
        .read_memory_report(&task_id, ReadAvailability::Strict)
        .map_err(unavailable)?
    else {
        return Ok(None);
    };
    if report.record_id != record_id {
        return Ok(None);
    }
    let operation_id = task_operation_id(&report)?;
    Ok(Some(TypedMemoryRecord {
        source_kind: "task_report",
        record_kind: "task_report",
        record_id: report.record_id,
        revision: report.source_revision,
        operation_id,
        text: report.text,
        content_hash: report.report_hash,
        project_id: Some(report.project_id),
        conversation_session_id: None,
        conversation_message_id: None,
        observed_at: report.observed_at,
        role: "task",
        basis: "reviewed_task",
    }))
}

pub(in crate::cognition) fn task_report_lifecycle(
    data_root: &Path,
    record_id: &str,
    operation_id: &str,
    revision: &str,
) -> CognitionResult<Option<TaskReportLifecycle>> {
    let Some(task_id) = task_id_from_memory_record_id(record_id) else {
        return Ok(None);
    };
    let reader = WorkRecordReader::new(data_root);
    if !reader.has_planned_task(&task_id).map_err(unavailable)? {
        return Ok(None);
    }
    let current = reader
        .read_memory_report(&task_id, ReadAvailability::Strict)
        .map_err(unavailable)?;
    if current.as_ref().is_some_and(|report| {
        report.source_revision == revision
            && task_operation_id(report).is_ok_and(|current_id| current_id == operation_id)
    }) {
        Ok(Some(TaskReportLifecycle::Current))
    } else {
        Ok(Some(TaskReportLifecycle::Superseded))
    }
}

fn task_operation_id(
    report: &crate::work_records::PlannedTaskMemoryReport,
) -> CognitionResult<String> {
    let value = serde_json::json!([
        "task-report",
        report.task_id,
        report.attempt,
        report.result_hash,
        report.review_hash,
        report.source_revision,
    ]);
    let encoded = crate::json::stringify(&value).map_err(unavailable)?;
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

pub(in crate::cognition) fn read_explicit_record(
    memory_root: &Path,
    record_id: &str,
) -> CognitionResult<Option<TypedMemoryRecord>> {
    let Some(binding) = read_binding(memory_root, record_id)? else {
        return Ok(None);
    };
    if binding.state != "active" {
        return Ok(None);
    }
    let text = match fs::read_to_string(rule_root(memory_root).join(format!("{record_id}.md"))) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unavailable(error)),
    };
    if format!("{:x}", Sha256::digest(text.as_bytes())) != binding.content_hash {
        return Ok(None);
    }
    Ok(Some(TypedMemoryRecord {
        source_kind: "explicit_record",
        record_kind: "rule",
        record_id: binding.record_id,
        revision: binding.revision,
        operation_id: binding.operation_id,
        text,
        content_hash: binding.content_hash,
        project_id: binding.project_id,
        conversation_session_id: binding.conversation_session_id,
        conversation_message_id: binding.conversation_message_id,
        observed_at: binding.observed_at,
        role: "explicit",
        basis: "user_statement",
    }))
}

pub(in crate::cognition) fn explicit_rule_lifecycle(
    memory_root: &Path,
    record_id: &str,
    operation_id: &str,
    revision: &str,
) -> CognitionResult<Option<ExplicitRuleLifecycle>> {
    let Some(binding) = read_binding(memory_root, record_id)? else {
        return Ok(None);
    };
    let Some(operation) = binding
        .operations
        .iter()
        .find(|item| item.operation_id == operation_id && item.revision == revision)
    else {
        return Ok(None);
    };
    if operation.state == "forgotten" && binding.revision == revision {
        return Ok(Some(ExplicitRuleLifecycle::Forgotten));
    }
    if binding.state == "active" && binding.revision == revision {
        Ok(Some(ExplicitRuleLifecycle::Current))
    } else {
        Ok(Some(ExplicitRuleLifecycle::Superseded))
    }
}

fn read_binding(
    memory_root: &Path,
    record_id: &str,
) -> CognitionResult<Option<ExplicitRuleBinding>> {
    let path = rule_root(memory_root).join(format!("{record_id}.source.json"));
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unavailable(error)),
    };
    let binding: ExplicitRuleBinding = serde_json::from_str(&content).map_err(unavailable)?;
    if binding.schema != "butler.explicit-rule-binding.v1" || binding.record_id != record_id {
        return Ok(None);
    }
    Ok(Some(binding))
}

fn rule_root(memory_root: &Path) -> std::path::PathBuf {
    memory_root.join("rules")
}

fn unavailable(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_source_unavailable", error.to_string())
}
