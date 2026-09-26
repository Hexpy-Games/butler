//! Delivery of task-report and explicit-rule queue notices to the active graph.

use serde_json::Value;

use super::{Input, dead_letter, error};
use crate::cognition::{
    ConsumeTypedLifecycleInput, MemoryGenerationTarget, RegisterTypedSourceInput,
    resolve_active_generation,
    sources::{TypedMemoryLifecycle, read_typed_memory_lifecycle, read_typed_record},
};

pub(super) async fn process(
    input: &Input,
    root: &std::path::Path,
    entry: &Value,
    job_id: &str,
) -> crate::cognition::CognitionResult<bool> {
    match process_current(input, root, entry, job_id).await {
        Ok(processed) => Ok(processed),
        Err(_failure) if input.shutdown.is_cancelled() => Ok(false),
        Err(failure) => {
            dead_letter(root, entry, failure.code, &(input.clock)())?;
            Ok(false)
        }
    }
}

async fn process_current(
    input: &Input,
    root: &std::path::Path,
    entry: &Value,
    job_id: &str,
) -> crate::cognition::CognitionResult<bool> {
    let source = &entry["source"];
    let kind = match source["kind"].as_str() {
        Some("task_report") => "task_report",
        Some("explicit_record") if source["record_kind"] == "rule" => "explicit_record",
        _ => return Err(error("memory_sync_source_unavailable")),
    };
    let record_id = required(source, "record_id")?;
    let revision = required(source, "revision")?;
    let operation_id = required(source, "operation_id")?;
    let active = resolve_active_generation(&input.data_root, &input.environment)?;
    let memory_root = input.environment.memory_root(&input.data_root);
    let owner = read_typed_record(&input.data_root, &memory_root, kind, record_id)?;
    if owner
        .as_ref()
        .is_none_or(|owner| owner.revision != revision || owner.operation_id != operation_id)
    {
        let disposition = match read_typed_memory_lifecycle(
            &input.data_root,
            &memory_root,
            kind,
            record_id,
            operation_id,
            revision,
        )? {
            Some(TypedMemoryLifecycle::Forgotten) => TypedMemoryLifecycle::Forgotten,
            Some(TypedMemoryLifecycle::Superseded) => TypedMemoryLifecycle::Superseded,
            Some(TypedMemoryLifecycle::Current) | None => {
                return Err(error("memory_source_changed"));
            }
        };
        input
            .registration
            .consume_typed_lifecycle(ConsumeTypedLifecycleInput {
                data_root: input.data_root.clone(),
                expected_generation: active.generation_id,
                source_kind: kind.into(),
                record_id: record_id.into(),
                revision: revision.into(),
                operation_id: operation_id.into(),
                disposition,
                cancellation: input.shutdown.child_token(),
            })
            .await?;
        return super::super::super::queue::ack(root, job_id);
    }
    let owner = owner.ok_or_else(|| error("memory_source_changed"))?;
    let progress = input
        .registration
        .register_typed_source(RegisterTypedSourceInput {
            data_root: input.data_root.clone(),
            target: MemoryGenerationTarget::Active {
                expected_generation: active.generation_id,
            },
            source_kind: kind.into(),
            record_id: record_id.into(),
            revision: revision.into(),
            operation_id: operation_id.into(),
            content_hash: owner.content_hash,
            completion_id: job_id.into(),
            cancellation: input.shutdown.child_token(),
        })
        .await?;
    if progress.source["state"] != "complete" {
        return Ok(false);
    }
    super::super::super::queue::ack(root, job_id)
}

fn required<'a>(source: &'a Value, key: &str) -> crate::cognition::CognitionResult<&'a str> {
    source[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error("memory_sync_entry_invalid"))
}
