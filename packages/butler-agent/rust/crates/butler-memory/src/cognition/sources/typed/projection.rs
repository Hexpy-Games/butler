//! Only pending rule transactions can make an unavailable source temporary.
use super::*;

pub(in crate::cognition) fn read_projection_record(
    data_root: &Path,
    memory_root: &Path,
    kind: &str,
    record_id: &str,
) -> CognitionResult<TypedMemoryRecord> {
    // A capture can be discarded or its transaction recovered. Do not use its
    // optimistic revision as evidence that the committed record is superseded.
    if kind == "explicit_record" && rules::rule_pending(memory_root, record_id)? {
        return Err(busy());
    }
    if let Some(owner) = read_typed_record(data_root, memory_root, kind, record_id)? {
        return Ok(owner);
    }
    // Captures are written outside the lease and can arrive during a read.
    if kind == "explicit_record" && rules::rule_pending(memory_root, record_id)? {
        return Err(busy());
    }
    // Rule transactions hold the claim lease. Without a pending change,
    // missing or hash-mismatched text is durable source damage, even when its
    // binding is active. Settle it until the owner publishes a valid change.
    Err(changed())
}

fn busy() -> CognitionError {
    CognitionError::new(CognitionCode::MemoryWriteBusy, "memory_write_busy")
}
