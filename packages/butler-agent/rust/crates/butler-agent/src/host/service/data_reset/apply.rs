//! Only called under DATA ownership, before writers open or after every writer closes.
use super::{
    journal::{self, Journal, Phase},
    plan,
};
use butler_platform::secure_fs;
use std::{io, path::Path, time::Instant};

pub(crate) fn apply(root: &Path, journal: &mut Journal) -> io::Result<bool> {
    if matches!(journal.phase, Phase::RollingBack) {
        rollback(root, journal).map_err(rollback_error)?;
        return Ok(false);
    }
    let started = Instant::now();
    // Writers may have committed new top-level files since preflight. Merge
    // this bounded listing with the durable plan so moved sources remain known.
    let result = (|| {
        // Record the one automatic retry before even a plan read can fail or
        // be interrupted. Publication failures still take the rollback path.
        if journal.retried {
            journal.save(root)?;
        }
        secure_fs::fault_checkpoint("data_reset.plan")?;
        for path in plan::collect(root, &journal.kept_logs)? {
            if !journal.moves.contains(&path) {
                journal.moves.push(path);
            }
        }
        journal.save(root)?;
        super::moves::move_all(root, journal)?;
        journal::write_generation(root, &journal.new_generation)?;
        journal.phase = Phase::Applied;
        journal.save(root)
    })();
    if result.is_err() {
        journal.phase = Phase::RollingBack;
        // Even a failed phase save must not prevent restoration. The original
        // requested journal still records the complete durable move plan.
        if journal.save(root).is_err() {
            butler_core::diagnostic!("[full-reset] rollback phase publication failed");
        }
        rollback(root, journal).map_err(rollback_error)?;
        return Ok(false);
    }
    butler_core::diagnostic!(
        "[full-reset] applied renames={} elapsed_ms={}",
        journal.moves.len(),
        started.elapsed().as_millis()
    );
    Ok(true)
}
#[derive(Debug, thiserror::Error)]
#[error("Reset rollback failed: {0}")]
pub(super) struct RollbackError(io::Error);
fn rollback_error(error: io::Error) -> io::Error {
    io::Error::other(RollbackError(error))
}
fn rollback(root: &Path, journal: &mut Journal) -> io::Result<()> {
    super::moves::rollback(root, journal)?;
    journal::write_generation(root, &journal.old_generation)?;
    secure_fs::remove_tree(&journal.trash(root))?;
    journal::sync(root)?;
    journal.phase = Phase::Failed;
    journal.save(root)
}
