//! The typed memory sources of a rebuild inventory: task reports, explicit rules and quality operations.

use super::*;

/// Typed records and their lifecycle bindings, in collation order.
pub(super) fn typed_registry(
    data_root: &Path,
    cancellation: &CancellationToken,
    collation: &LocaleCollation,
) -> CognitionResult<(Vec<TypedEntry>, Vec<TypedLifecycle>)> {
    let mut typed = Vec::new();
    let mut lifecycle = Vec::new();
    task_reports(data_root, cancellation, &mut typed, &mut lifecycle)?;
    explicit_rules(data_root, cancellation, &mut typed, &mut lifecycle)?;
    lifecycle.push(TypedLifecycle::FeedbackQualityOperations {
        operations: quality_operations(data_root, collation)?,
    });
    typed.sort_by(|a, b| {
        collation.compare(
            &format!("{}\0{}", a.source_kind, a.record_id),
            &format!("{}\0{}", b.source_kind, b.record_id),
        )
    });
    let mut keyed = lifecycle
        .into_iter()
        .map(|entry| {
            serde_json::to_string(&entry)
                .map(|key| (key, entry))
                .map_err(|source| {
                    error(CognitionCode::MemoryInventoryIncomplete).with_source(source)
                })
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    keyed.sort_by(|a, b| collation.compare(&a.0, &b.0));
    Ok((typed, keyed.into_iter().map(|(_, entry)| entry).collect()))
}

/// Each task's memory report and its binding with the report text.
pub(super) fn task_reports(
    data_root: &Path,
    cancellation: &CancellationToken,
    typed: &mut Vec<TypedEntry>,
    lifecycle: &mut Vec<TypedLifecycle>,
) -> CognitionResult<()> {
    let unavailable = |source| error(CognitionCode::MemorySourceUnavailable).with_source(source);
    let tasks = WorkRecordReader::new(data_root);
    let mut task_ids = tasks.task_ids().map_err(unavailable)?;
    task_ids.sort();
    for task_id in task_ids {
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let Some(report) = tasks
            .read_memory_report(&task_id, ReadAvailability::Strict)
            .map_err(unavailable)?
        else {
            continue;
        };
        let record = read_task_report(data_root, &task_memory_record_id(&task_id))?
            .ok_or_else(|| error(CognitionCode::MemorySourceUnavailable))?;
        typed.push(entry(record)?);
        let binding_path = data_root
            .join("tasks")
            .join(&task_id)
            .join("memory-report-binding.json");
        let mut binding: serde_json::Map<String, Value> =
            serde_json::from_slice(&fs::read(binding_path).map_err(|source| {
                error(CognitionCode::MemorySourceUnavailable).with_source(source)
            })?)
            .map_err(|source| error(CognitionCode::MemorySourceUnavailable).with_source(source))?;
        binding.insert("text".into(), Value::String(report.text));
        lifecycle.push(TypedLifecycle::TaskReport {
            task_id,
            report: Value::Object(binding),
        });
    }
    Ok(())
}

/// Explicit rules bound by a `<record>.source.json` file.
pub(super) fn explicit_rules(
    data_root: &Path,
    cancellation: &CancellationToken,
    typed: &mut Vec<TypedEntry>,
    lifecycle: &mut Vec<TypedLifecycle>,
) -> CognitionResult<()> {
    #[derive(Deserialize)]
    struct RuleBinding {
        #[serde(default, deserialize_with = "crate::lenient::option")]
        schema: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        record_id: Option<String>,
    }
    let unavailable = |source| error(CognitionCode::MemorySourceUnavailable).with_source(source);
    let rules = data_root.join("cognition/memory/rules");
    if !rules.is_dir() {
        return Ok(());
    }
    let mut names = fs::read_dir(&rules)
        .map_err(unavailable)?
        .map(|item| item.map(|value| value.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(unavailable)?;
    names.sort();
    for name in names
        .into_iter()
        .filter(|name| name.ends_with(".source.json"))
    {
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let record_id = name.trim_end_matches(".source.json");
        let bytes = fs::read(rules.join(&name)).map_err(unavailable)?;
        let binding: Value = serde_json::from_slice(&bytes)
            .map_err(|source| error(CognitionCode::MemorySourceUnavailable).with_source(source))?;
        let header = RuleBinding::deserialize(&binding).unwrap_or(RuleBinding {
            schema: None,
            record_id: None,
        });
        if header.schema.as_deref() != Some("butler.explicit-rule-binding.v1")
            || header.record_id.as_deref() != Some(record_id)
        {
            continue;
        }
        if let Some(record) = read_explicit_record(&data_root.join("cognition/memory"), record_id)?
        {
            typed.push(entry(record)?);
        }
        lifecycle.push(TypedLifecycle::ExplicitRecord {
            record_id: record_id.to_owned(),
            binding,
        });
    }
    Ok(())
}

/// Feedback quality operations in `operation_id` collation order.
pub(super) fn quality_operations(
    data_root: &Path,
    collation: &LocaleCollation,
) -> CognitionResult<Vec<Value>> {
    #[derive(Deserialize)]
    struct OperationHeader {
        #[serde(default, deserialize_with = "crate::lenient::option")]
        schema: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        operation_id: Option<String>,
    }
    let quality = data_root.join("cognition/feedback/quality-operations.jsonl");
    if !quality.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(quality)
        .map_err(|source| error(CognitionCode::MemorySourceUnavailable).with_source(source))?;
    let mut operations = content
        .trim()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let header = OperationHeader::deserialize(&value).ok()?;
            (header.schema.as_deref() == Some("butler.memory-source-quality-operation.v1"))
                .then(|| (header.operation_id.unwrap_or_default(), value))
        })
        .collect::<Vec<_>>();
    operations.sort_by(|a, b| collation.compare(&a.0, &b.0));
    Ok(operations.into_iter().map(|(_, value)| value).collect())
}
