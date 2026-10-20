//! The existing fixture hold seam at the native inference boundary.
use butler_memory::cognition::WorkerOperation;

pub(super) fn hold_request(operation: WorkerOperation) {
    if matches!(operation, WorkerOperation::Embed) {
        let _ = butler_platform::secure_fs::hold_point("memory_embedding", || false);
    }
}
