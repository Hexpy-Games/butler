//! Filesystem state transitions for one source-format inbound queue.

mod claim;
mod deferred;
pub(super) use deferred::next_delay;
mod identity;
mod io;
mod settlement;

pub(super) use claim::{claim, recover_stale};
pub(super) use identity::{enqueue_idempotent, find_idempotent};
pub(super) use settlement::{defer, park, recover_runtime_interruptions, settle};

use std::path::{Path, PathBuf};

fn record_path(root: &Path, state: &str, queue_id: &str) -> PathBuf {
    root.join(state).join(format!("{queue_id}.json"))
}

const STATES: [&str; 4] = ["pending", "processing", "processed", "failed"];

/// Terminalize pending work only after its producers and dispatcher have joined.
pub(super) fn cancel_pending(root: &Path) -> super::QueueResult<()> {
    let pending = root.join("pending");
    let failed = root.join("failed");
    let names = io::file_names(&pending)?;
    if names.is_empty() {
        return Ok(());
    }
    io::ensure_dir(&failed)?;
    for name in names {
        let from = pending.join(&name);
        let Some(mut record) = io::read(&from)? else {
            continue;
        };
        record.processing = None;
        record
            .extra
            .insert("error".into(), "service_resetting".into());
        record.metadata.insert("cancelled".into(), true.into());
        io::atomic_write(&failed.join(name), &record)?;
        std::fs::remove_file(from).map_err(io::io_error)?;
    }
    butler_platform::secure_fs::sync_directory(&pending)
        .unwrap_or(Ok(()))
        .map_err(io::io_error)
}
