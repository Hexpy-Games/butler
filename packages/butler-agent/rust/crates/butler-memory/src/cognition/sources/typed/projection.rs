//! Projection distinguishes temporary rule writes from retired owner records.
use super::*;

pub(in crate::cognition) fn read_projection_record(
    data_root: &Path,
    memory_root: &Path,
    kind: &str,
    record_id: &str,
    revision: &str,
) -> CognitionResult<TypedMemoryRecord> {
    // A capture can be discarded or its transaction recovered. Do not use its
    // optimistic revision as evidence that the committed record is superseded.
    if kind == "explicit_record" && rules::rule_pending(memory_root, record_id)? {
        return Err(busy());
    }
    if let Some(owner) = read_typed_record(data_root, memory_root, kind, record_id)? {
        return Ok(owner);
    }
    if kind == "explicit_record" {
        // Captures are written outside the lease and can arrive during a read.
        if rules::rule_pending(memory_root, record_id)? {
            return Err(busy());
        }
        if let Some(binding) = read_binding(memory_root, record_id)?
            && explicit_rule_lifecycle(memory_root, record_id, &binding.operation_id, revision)?
                == Some(ExplicitRuleLifecycle::Current)
        {
            // An active binding with its original revision still owns the
            // record when the text is temporarily missing or mismatched.
            return Err(busy());
        }
    } else if kind == "task_report" {
        // Strict reads propagate unavailable storage errors; absent or
        // superseded task reports have no current owner to wait for.
        if task_report_lifecycle(data_root, record_id, "", revision)?
            == Some(TaskReportLifecycle::Current)
        {
            return Err(busy());
        }
    }
    Err(changed())
}

fn busy() -> CognitionError {
    CognitionError::new(CognitionCode::MemoryWriteBusy, "memory_write_busy")
}
